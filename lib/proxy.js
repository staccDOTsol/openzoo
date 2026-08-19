import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import {
  config, FUNDING_ASSETS, EVM_FUNDING_ASSETS, evmRpcFor, fundingLine, liveRails, railFundingHint, railFundingAddresses, unfundableRails, RAIL_FUNDING,
} from './config.js';
import { PayClient, QuoteTooHighError, UnderfundedError } from './pay.js';
import { tokenBalance } from './x402.js';
import { evmTokenBalance } from './evm.js';
import { bindCorpus, contextCacheDisabled, BIND_MIN_CHARS } from './hrr.js';
import { maybeRewriteModel, rewritablePath, augmentModelList, ALIAS_IDS } from './models.js';
import { forgetContext } from './contexts.js';
import { injectBrief } from './brief.js';
import { withNamespace } from './namespace.js';
import { anthropicToOpenAI, openAIToAnthropic, streamOpenAIToAnthropic, writeAnthropicSse } from './anthropic.js';
import { responsesToChat, chatToResponses, writeResponsesSse } from './responses.js';

const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'content-length',
  // `Expect: 100-continue` is sent by curl and most HTTP libraries once a body
  // passes ~1KB. undici REFUSES it outright ("expect header not supported"),
  // so forwarding it made every LARGE-body request fail while small ones
  // worked — i.e. it broke exactly the corpus calls this proxy exists for.
  'expect',
  // The harness's api key (sk-openzoo or anything) is accepted and dropped:
  // the zoo takes payment, not keys.
  'authorization',
]);

/**
 * Be forgiving about the path, the same way we are about model ids.
 * Harnesses are configured with a base_url that ALREADY ends in /v1, so an
 * agent building "{base}/v1/hrr/bind" sends /v1/v1/hrr/bind and gets a 404 it
 * cannot diagnose (observed: agent concluded the bind endpoint "is not
 * functioning as advertised" and fell back to stuffing the corpus inline).
 * Collapse repeated /v1 and add a missing one.
 */
function normalizePath(url) {
  const [path, query] = (url || '/').split(/(?=\?)/);
  let p = path.replace(/^(?:\/v1)+(?=\/v1\/)/, '');       // /v1/v1/x -> /v1/x
  if (!/^\/v1(\/|$)/.test(p) && /^\/(hrr|chat|models|completions|embeddings|usage|responses)/.test(p)) p = `/v1${p}`;
  return p === path ? url : `${p}${query || ''}`;
}

function upstreamHeaders(req) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  // EVERY forwarded request carries this wallet's context namespace, not just
  // the ones PayClient builds itself. Without it a bind sent THROUGH the proxy
  // (an agent posting to /v1/hrr/bind) landed in the shared tenant while the
  // chat that referenced it looked in the wallet's tenant — the context was
  // unreachable and every spill bind came back 400, silently forwarding the
  // whole body at full price.
  return withNamespace(out);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

/** Pipe an upstream fetch Response to the client, unbuffered (SSE-safe).
 *
 *  `onReceipt` is called with the gateway's x402 block when it arrives. On a
 *  STREAMED call there is no JSON body to carry that block, so the gateway
 *  emits it as an SSE COMMENT (`: x402 {...}`) after the last frame — comments
 *  are discarded by every compliant client, so nothing downstream sees it, but
 *  without reading it here every spend and savings figure on the status line
 *  would silently read zero the moment real streaming was switched on.
 *
 *  Sniffing NEVER delays a byte: each chunk is written to the client first and
 *  only then scanned. */
function relay(res, upstream, onReceipt) {
  const headers = {};
  upstream.headers.forEach((v, k) => {
    if (!['transfer-encoding', 'connection', 'content-encoding', 'content-length'].includes(k)) headers[k] = v;
  });
  res.writeHead(upstream.status, headers);
  if (!upstream.body) { res.end(); return Promise.resolve(); }
  const sse = (upstream.headers.get('content-type') || '').includes('text/event-stream');
  return new Promise((resolve) => {
    const body = Readable.fromWeb(upstream.body);
    body.on('error', () => res.destroy());
    res.on('close', () => body.destroy());
    body.on('end', resolve);
    if (!sse || typeof onReceipt !== 'function') { body.pipe(res); return; }
    let pending = '';
    body.on('data', (c) => {
      res.write(c);
      pending += c.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';   // a comment can straddle two chunks
      for (const line of lines) {
        if (!line.startsWith(': x402 ')) continue;
        try { onReceipt(JSON.parse(line.slice(7))); } catch { /* not our frame */ }
      }
    });
    body.on('end', () => res.end());
  });
}

function jsonErr(res, status, message, extraFields = {}) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message }, ...extraFields }));
}

const mb = (n) => (n / 1048576).toFixed(1);

// anchor -> { corpus, contextId, hash } for append-only transcript spills
const spillMemo = new Map();

/**
 * Every fundable balance across all three chains, for the startup line and
 * the live refresh. Each read is independent and advisory — one lagging RPC
 * drops its entry rather than blanking the whole line.
 */
async function snapshotBalances(client) {
  const out = [];
  try {
    const bals = await Promise.all(
      FUNDING_ASSETS.map((a) => tokenBalance(client.connection, client.keypair.publicKey, a.mint)),
    );
    FUNDING_ASSETS.forEach((a, i) => out.push({ symbol: a.symbol, ui: Number(bals[i].ui ?? 0), chain: 'solana' }));
  } catch { /* Solana RPC hiccup — EVM entries still report */ }
  const owner = client.evmAddress;
  if (owner) {
    await Promise.all(Object.entries(EVM_FUNDING_ASSETS).flatMap(([rail, assets]) => assets.map(async (a) => {
      try {
        const raw = await evmTokenBalance({ rpcUrl: evmRpcFor(rail), token: a.address, owner });
        out.push({ symbol: a.symbol, ui: Number(raw) / 10 ** a.decimals, chain: rail });
      } catch { /* advisory */ }
    })));
  }
  // Parallel reads land in racy order; sort so the printed line is stable
  // and diffs against the previous snapshot read cleanly.
  const rank = { solana: 0, base: 1, robinhood: 2 };
  return out.sort((a, b) => (rank[a.chain] ?? 9) - (rank[b.chain] ?? 9) || a.symbol.localeCompare(b.symbol));
}

/** Solana entries always show; EVM entries only once they hold something. */
function balanceLine(snap) {
  return snap
    .filter((b) => b.chain === 'solana' || b.ui > 0)
    .map((b) => `${b.ui} ${b.symbol}${b.chain !== 'solana' ? ` (${b.chain})` : ''}`)
    .join('  ·  ');
}

/**
 * The zoo answers chat completions as ONE JSON object (it settles payment
 * before serving — there is nothing to stream until generation is done).
 * Harnesses that sent `stream: true` expect SSE and treat a JSON body as a
 * dead connection: Cursor shows "Reconnecting…", RETRIES, and every retry is
 * a fresh payment. So the proxy honours the contract itself — the finished
 * completion is re-emitted as spec-shaped chat.completion.chunk events.
 */
function serveAsSse(res, data, upstream) {
  const headers = {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    // Tell any proxy in front of us (cloudflare quick tunnel, nginx) NOT to
    // buffer the stream. Without this the tunnel accumulates the whole SSE
    // body and releases it at once, which reorders/merges the tool_call frames
    // an agent parses incrementally — observed as "provider-side tool-call
    // protocol error" over the tunnel while localhost (no proxy) is fine.
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  };
  const settle = upstream?.headers?.get?.('x-payment-response');
  if (settle) headers['x-payment-response'] = settle;
  res.writeHead(200, headers);
  const base = {
    id: data.id, object: 'chat.completion.chunk', created: data.created, model: data.model,
  };
  const ev = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  for (const c of data.choices || []) {
    ev({ ...base, choices: [{ index: c.index ?? 0, delta: { role: 'assistant' }, finish_reason: null }] });
    if (c.message?.content) {
      ev({ ...base, choices: [{ index: c.index ?? 0, delta: { content: c.message.content }, finish_reason: null }] });
    }
    // Agent mode lives or dies here: a finish_reason of "tool_calls" with the
    // calls themselves dropped strands the harness mid-turn (observed: Cursor
    // agent hangs). Streaming spec: tool_calls ride the delta with an index,
    // arguments as a string chunk — one full chunk per call is valid SSE.
    if (Array.isArray(c.message?.tool_calls) && c.message.tool_calls.length) {
      ev({
        ...base,
        choices: [{
          index: c.index ?? 0,
          delta: {
            tool_calls: c.message.tool_calls.map((t, i) => ({
              index: i,
              id: t.id,
              type: t.type || 'function',
              function: { name: t.function?.name, arguments: t.function?.arguments ?? '' },
            })),
          },
          finish_reason: null,
        }],
      });
    }
    ev({ ...base, choices: [{ index: c.index ?? 0, delta: {}, finish_reason: c.finish_reason ?? 'stop' }], ...(data.usage ? { usage: data.usage } : {}) });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * Replay guard — a harness that cannot consume a response retries the SAME
 * body within seconds, and each retry used to be a fresh payment (observed:
 * six identical $0.06 settles for one Cursor message). An identical POST body
 * arriving within the window is served the cached completion, not re-paid.
 * Window is deliberately short: a genuinely new turn always differs (harnesses
 * resend the whole conversation), so only true retries can hit.
 */
const REPLAY_TTL_MS = 30_000;
const replayCache = new Map(); // sha256(body) -> { at, data, settle }
/**
 * The key MUST include the routing headers, not just the body.
 *
 * Keying on the body alone was a correctness bug, not merely a caching one:
 * N shards asking the SAME question of N DIFFERENT bound corpora send
 * byte-identical bodies and differ only in X-HRR-Context. They collided on one
 * key, so shards 2..N were served shard 1's answer — REPRODUCED in the field:
 * 10 shards, 7 byte-identical replies across corpora known to differ, and the
 * batch finished in 12s where a single uncached call took ~7s.
 *
 * Wrong answers attributed to the wrong corpus is a far worse failure than the
 * double-billing this cache exists to prevent, so every header that can change
 * the ANSWER joins the key.
 */
const REPLAY_KEY_HEADERS = ['x-hrr-context', 'x-hrr-top-k', 'x-hrr-gate', 'x-openzoo-namespace'];

function replayKey(bodyBuf, headers = {}) {
  const h = crypto.createHash('sha256').update(bodyBuf);
  for (const name of REPLAY_KEY_HEADERS) {
    const v = headers[name];
    if (v) h.update(`\n${name}:${v}`);
  }
  return h.digest('hex');
}
function replayGet(key) {
  const hit = replayCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > REPLAY_TTL_MS) { replayCache.delete(key); return null; }
  return hit;
}
function replayPut(key, data, settle) {
  replayCache.set(key, { at: Date.now(), data, settle });
  if (replayCache.size > 50) {
    const oldest = [...replayCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) replayCache.delete(oldest[0]);
  }
}

/**
 * "The body never ships twice" at the proxy. A chat body whose LAST message
 * carries a huge pasted corpus gets split at its last blank line — corpus vs
 * ask — so the corpus can be bound ONCE on the zoo and every later call ships
 * only the ask plus X-HRR-Context. The split point is deterministic, which is
 * what makes the sha256 manifest hit on run 2 even when the question changed.
 *
 * Conservative on purpose: only a single big STRING content on the final
 * message, only when a blank-line boundary exists, and any failure falls back
 * to sending the original body untouched — caching must never break a call.
 * Returns null (send as-is) or { body, contextId, hash, corpus, reused, savedBytes }.
 */
/** Flatten one Anthropic content block to text leCore can index. */
function blockText(b) {
  if (typeof b === 'string') return b;
  if (!b || typeof b !== 'object') return '';
  if (b.type === 'text') return b.text || '';
  if (b.type === 'tool_use') return `[tool_use ${b.name}] ${JSON.stringify(b.input ?? {})}`;
  if (b.type === 'tool_result') {
    const c = b.content;
    return `[tool_result] ${typeof c === 'string' ? c : (Array.isArray(c) ? c.map(blockText).join('\n') : JSON.stringify(c ?? ''))}`;
  }
  if (b.type === 'thinking') return '';        // never bind reasoning traces
  return '';
}

function msgText(m) {
  const c = m?.content;
  const body = typeof c === 'string' ? c : (Array.isArray(c) ? c.map(blockText).filter(Boolean).join('\n') : '');
  return body ? `${(m.role || '?').toUpperCase()}: ${body}` : '';
}

/**
 * Spill the OLD prefix of a long TRANSCRIPT into leCore.
 *
 * WHY THIS EXISTS. The only spill was the corpus+question shape below, which
 * requires the last message to be one big string ending in `\n\n<question>` —
 * true for zoo_ask, never true for an agent. `npx openzoo claude` therefore
 * spilled NOTHING, hit Claude Code's own context ceiling, and auto-compacted,
 * on a product whose pitch is that it does not have to. Compaction was honest
 * given nothing was offloaded; this is what makes the claim true.
 *
 * Runs on the OpenAI shape ON PURPOSE. /v1/messages is translated by
 * anthropicToOpenAI and rewritten to /v1/chat/completions BEFORE this is
 * reached, so operating here covers Claude Code, Cursor and the raw API with
 * one implementation instead of three that can drift.
 *
 * THE CUT POINT IS NOT NEGOTIABLE. An assistant `tool_calls` must be answered
 * by role:"tool" messages or the upstream 400s, so the transcript may only be
 * severed at a plain `user` message — everything before one is self-contained.
 * A system message is never spilled: it is the operating contract, not history.
 */
async function spillTranscript(body, log, req) {
  const msgs = Array.isArray(body?.messages) ? body.messages : null;
  if (!msgs || msgs.length < 6) return null;

  // Keep the recent tail, but never more than half the transcript: a fixed 8 on
  // a 10-message body left only index 2 to search, which is rarely a user turn,
  // so a SHORT-but-huge transcript (one giant tool_result) silently never
  // spilled — the exact case an agent hits first.
  const keepTail = Math.min(
    Number(process.env.OPENZOO_KEEP_TAIL_MSGS || 8),
    Math.max(2, Math.floor(msgs.length / 2)),
  );
  const firstSpillable = msgs.findIndex((m) => m?.role !== 'system');
  if (firstSpillable < 0) return null;

  // A SEVERABLE BOUNDARY IS NOT ONLY A `user` TURN.
  //
  // That was the whole bug: in a Claude Code agent loop the human speaks ONCE
  // and everything after is assistant->tool pairs, so a rule that only cuts at
  // role:"user" finds nothing and the spill returns null on EVERY turn.
  // MEASURED against the live proxy log: 104 real claude-cli requests, zero
  // spills, while every synthetic transcript I tested spilled fine because I
  // had written user turns into it.
  //
  // What actually matters is that no assistant `tool_calls` is left unanswered
  // across the cut. So any message is a legal boundary when the one BEFORE it
  // is not an unanswered tool call — i.e. the previous message is a plain
  // assistant/user/tool with every call already resolved.
  const severable = (i) => {
    if (i <= firstSpillable || i >= msgs.length) return false;
    const prev = msgs[i - 1];
    if (!prev) return false;
    // an assistant that issued tool_calls must be followed by its tool results
    if (prev.role === 'assistant' && Array.isArray(prev.tool_calls) && prev.tool_calls.length) return false;
    // never split a tool_call/tool_result run in the middle
    return msgs[i].role !== 'tool';
  };
  let cut = -1;
  for (let i = msgs.length - keepTail; i > firstSpillable; i--) {
    if (severable(i)) { cut = i; break; }
  }
  // FALL BACK TO THE LAST SEVERABLE TURN. The keepTail window is a preference,
  // not a requirement: a transcript can be enormous and still have very few
  // user turns (one huge document, then tool traffic), and on those the window
  // contained no `user` message at all — so nothing spilled and the whole body
  // went upstream while the counter honestly reported 0. Keep at least the
  // final turn; anything earlier that is severable is better than not spilling.
  if (cut <= firstSpillable) {
    for (let i = msgs.length - 2; i > firstSpillable; i--) {
      if (severable(i)) { cut = i; break; }
    }
  }
  if (cut <= firstSpillable) return null;         // nothing safely severable

  // TRIM THE TAIL BY BYTES, NOT MESSAGE COUNT.
  //
  // MEASURED on the live session: 9 kept turns of Claude Code tool output made
  // promptTokens swamp the counterfactual and the call scored 1.00x, while the
  // SAME bound context with a one-line ask scored 8.53x. Nine messages is a
  // trivial number and an enormous payload — a single Read or grep result is
  // tens of KB — so counting messages measures the wrong thing entirely.
  //
  // Walk backwards from the newest and stop at a byte budget. The newest turns
  // are the ones the model actually needs verbatim; everything older is already
  // in the bound corpus and comes back through recall.
  let tailStart = cut;
  {
    // 24000 was still too fat: MEASURED on 9 live spilled calls, direct came
    // back identical to billed to the cent, i.e. the gateway never computed a
    // counterfactual because promptTokens >= corpusTokens. The tail has to be
    // small enough that the BOUND corpus is the bigger number.
    const budget = Number(process.env.OPENZOO_TAIL_MAX_CHARS || 6000);
    let used = 0;
    for (let i = msgs.length - 1; i >= cut; i--) {
      used += msgText(msgs[i]).length;
      if (used > budget && severable(i)) { tailStart = i; break; }
    }
  }
  if (tailStart > cut) cut = tailStart;

  // COHERENCE IS COUNTED IN TURNS, NOT BYTES.
  //
  // The byte budget alone produced windows of 2, 5 and 34 turns out of ~600 —
  // and one fat tool result is enough to spend the whole 6,000 chars, so a busy
  // agent turn collapses the window to almost nothing. OBSERVED live: an agent
  // that had just run a command reported "I don't have the preceding turns of
  // this conversation in view" and re-derived its own state from files, every
  // turn. Retrieval brings back what is RELEVANT to the ask; it does not
  // reliably bring back "what I just did", because the model does not know to
  // query for it.
  //
  // So floor the window at a number of turns regardless of size. This costs
  // saving — a bigger tail is a bigger `sent` — and that is the correct trade:
  // measured 8.13x on the fleet leaves room to spend some of it on an agent
  // that remembers its own last few moves.
  const minTurns = Number(process.env.OPENZOO_TAIL_MIN_TURNS || 12);
  if (msgs.length - cut < minTurns) {
    for (let i = Math.max(firstSpillable + 1, msgs.length - minTurns); i > firstSpillable; i--) {
      if (severable(i)) { cut = i; break; }
    }
  }

  // NEVER SPILL THE CURRENT ASK.
  //
  // The tail budget walks BACKWARD accumulating bytes, and in an agent loop the
  // last few messages are tool results — file reads, greps, build output. Those
  // alone blow through 6,000 chars, so the cut lands AFTER the user's actual
  // instruction and the instruction goes into the bound corpus instead of the
  // forwarded window. It then only comes back if top-k recall happens to surface
  // it against its own text, which is exactly the query it is least likely to
  // match.
  //
  // OBSERVED: "sending 2/578 turns", and the model replying "I don't have a
  // specific request to act on — your message came through empty", then
  // re-reading the plan doc to work out where it was, every single turn. A loop
  // that looks like amnesia and is actually us deleting the question.
  //
  // Retrieval is for CONTEXT. The ask itself is never context, and must survive
  // any budget.
  let lastUser = -1;
  for (let i = msgs.length - 1; i > firstSpillable; i--) {
    if (msgs[i].role === 'user' && msgText(msgs[i]).trim()) { lastUser = i; break; }
  }
  if (lastUser > firstSpillable && cut > lastUser) cut = lastUser;

  const head = msgs.slice(0, firstSpillable);     // system block, always kept
  const corpus = msgs.slice(firstSpillable, cut).map(msgText).filter(Boolean).join('\n\n');
  if (corpus.length <= BIND_MIN_CHARS) return null;

  // CONTINUE THE CONTEXT, BIND ONLY THE DELTA.
  //
  // A transcript grows by one message per turn, so the whole-corpus hash misses
  // every time and the old code re-uploaded the ENTIRE prefix on every single
  // turn — OBSERVED live: 0.4MB bound three turns running, a fresh context id
  // each time, while only a few KB was actually new. Bind cost grew with
  // conversation length and was re-paid per message.
  //
  // The corpus is append-only: each turn's corpus starts with the previous
  // one. So when it does, send just the tail and keep the same context_id.
  // Anchored on the FIRST 2KB, which is stable for the life of a conversation
  // and distinguishes concurrent ones.
  // KEY ON THE SESSION, NOT ON THE CONTENT.
  //
  // The anchor was the first 2KB of corpus, which works only because a
  // transcript's opening never changes. It is fragile in exactly the cases that
  // matter: two sessions that open identically (same system block, same first
  // instruction — the norm for an agent) collide onto ONE bound context and
  // interleave their histories, and any edit near the top of a transcript
  // silently orphans the binding and re-uploads the whole thing.
  //
  // Claude Code identifies its session, so use that when it is offered and fall
  // back to the content anchor when it is not. Same memo, better key.
  const sessionId = req?.headers?.['x-session-id']
    || req?.headers?.['x-claude-session-id']
    || (typeof body?.metadata?.user_id === 'string' ? body.metadata.user_id : null);
  const anchor = sessionId ? `sid:${sessionId}` : corpus.slice(0, 2048);
  const prior = spillMemo.get(anchor);
  let bind;
  if (prior && corpus.startsWith(prior.corpus) && corpus.length > prior.corpus.length) {
    const delta = corpus.slice(prior.corpus.length);
    // FIRE AND FORGET. This delta is history for FUTURE turns — the answer
    // being generated right now is served from the tail plus what is already
    // bound, so waiting on the upload buys nothing and costs the user the
    // round trip on every single turn. The context id is already known, so
    // nothing is lost by not waiting for it.
    //
    // The FIRST bind is deliberately NOT async: the request must carry
    // x-hrr-context, and that id does not exist until the bind returns. Firing
    // that one off would send the opening turn with no context at all — a
    // silently worse answer traded for a shorter pause, which is the wrong way
    // round.
    void bindCorpus(delta, {
      appendTo: prior.contextId,
      onStage: (stage, info) => {
        if (stage === 'binding') log(`appending ${mb(info.bytes)}MB to ${prior.contextId} (delta, background)`);
      },
    }).catch((e) => log(`append failed (history may lag one turn): ${e.message}`));
    bind = { contextId: prior.contextId, hash: prior.hash, reused: true, bytes: delta.length };
  } else {
    bind = await bindCorpus(corpus, {
      onStage: (stage, info) => {
        if (stage === 'binding') log(`binding ${mb(info.bytes)}MB of transcript to holographic memory...`);
      },
    });
  }
  spillMemo.set(anchor, { corpus, contextId: bind.contextId, hash: bind.hash });
  if (spillMemo.size > 32) spillMemo.delete(spillMemo.keys().next().value);
  const sent = msgs.length - cut;
  log(bind.reused
    ? `transcript prefix already bound (${bind.contextId}) — sending ${sent}/${msgs.length} turns`
    : `transcript prefix bound (${mb(bind.bytes)}MB → ${bind.contextId}) — sending ${sent}/${msgs.length} turns`);

  // ADAPTIVE TOP-K. A fixed 32 chunks is what was actually eating the saving:
  // MEASURED on a 56,265-token corpus, top_k 32 handed 9,990 tokens back and
  // scored 2.45x, while 8 handed back 2,574 and scored 4.73x — same answer,
  // same corpus, nearly double the saving. Recall breadth, not markup, is the
  // lever, and spilling 34k tokens only to recall 22k of them back is not a
  // saving, it is a round trip.
  //
  // So budget the recall in TOKENS and derive k from it, rather than fixing the
  // chunk count and letting the token cost fall where it may. ~320 tokens per
  // chunk measured. The budget scales with the ask — a one-line question needs
  // far less context than a detailed one — and is clamped so a huge ask cannot
  // drag the whole corpus back in.
  const askChars = msgText(msgs[msgs.length - 1] || {}).length;
  const budget = Math.min(
    Number(process.env.OPENZOO_RECALL_MAX_TOKENS || 6000),
    Math.max(Number(process.env.OPENZOO_RECALL_MIN_TOKENS || 1500),
             Math.round(askChars / 2)),
  );
  const topK = Math.max(4, Math.min(32, Math.round(budget / 320)));

  return {
    body: Buffer.from(JSON.stringify({ ...body, messages: [...head, ...msgs.slice(cut)] })),
    topK,
    contextId: bind.contextId,
    hash: bind.hash,
    corpus,
    reused: bind.reused,
    savedBytes: bind.bytes,
  };
}

async function maybeCacheCorpus(req, bodyBuf, log) {
  if (contextCacheDisabled()) return null;
  if (req.method !== 'POST' || !(req.url || '').includes('/chat/completions')) return null;
  if (req.headers['x-hrr-context']) return null; // harness manages its own context
  if (bodyBuf.length <= BIND_MIN_CHARS) return null;
  let body;
  try { body = JSON.parse(bodyBuf.toString('utf8')); } catch { return null; }
  const msgs = Array.isArray(body?.messages) ? body.messages : null;
  if (!msgs?.length) return null;
  // CORPUS+QUESTION first — one huge final message ending in \n\n<ask>. That is
  // what zoo_ask and the chat surface send, and binding exactly that body keeps
  // the ask verbatim. Anything else (an agent transcript) falls through to the
  // transcript spill, which used to be a silent no-op.
  const last = msgs[msgs.length - 1];
  const oneShot = typeof last?.content === 'string'
    && last.content.length > BIND_MIN_CHARS
    && last.content.lastIndexOf('\n\n') >= BIND_MIN_CHARS;
  if (!oneShot) return spillTranscript(body, log, req);
  const cut = last.content.lastIndexOf('\n\n');
  const corpus = last.content.slice(0, cut);
  const ask = last.content.slice(cut + 2).trim();
  if (!ask || ask.length > 8000) return spillTranscript(body, log, req);

  const bind = await bindCorpus(corpus, {
    onStage: (stage, info) => {
      if (stage === 'binding') log(`binding ${mb(info.bytes)}MB corpus to holographic memory (one-time)...`);
    },
  });
  if (bind.reused) {
    log(`corpus already bound (${bind.hash.slice(0, 12)}… → ${bind.contextId}) — skipped ${mb(bind.bytes)}MB upload`);
  } else {
    log(`corpus bound once (${mb(bind.bytes)}MB → ${bind.contextId}) — repeats of this body are near-free`);
  }
  const rewritten = { ...body, messages: [...msgs.slice(0, -1), { ...last, content: ask }] };
  return {
    body: Buffer.from(JSON.stringify(rewritten)),
    contextId: bind.contextId,
    hash: bind.hash,
    corpus,
    reused: bind.reused,
    savedBytes: bind.bytes,
  };
}

/**
 * `requireToken` / `sessionMaxUsd` are TUNNEL MODE (see lib/tunnel.js): once the
 * proxy is reachable from the internet, the api key stops being decorative and
 * becomes the only thing between a stranger and your wallet. Both are off by
 * default, so localhost behaviour is unchanged.
 */
export async function startProxy({ silent = false, requireToken = null, sessionMaxUsd = null, autoTunnel = false } = {}) {
  const client = new PayClient();
  const log = silent ? () => {} : (...a) => console.log(...a);
  // ALWAYS-ON. `silent: true` is used by the editor path to keep startup tidy,
  // but it also swallowed the per-request lines and the payment receipts — so the
  // terminal sat blank and there was no way to tell a working setup from an editor
  // quietly answering from its own backend. Traffic and receipts are the whole
  // point of watching this window; they are never silenced.
  // ALWAYS-ON, BUT NEVER INTO A HARNESS'S TERMINAL. `silent` means another
  // process (openzoo claude, the editor launcher) owns stdio — printing request
  // lines / payment receipts there corrupts that program's output (observed: the
  // Solana receipt leaking into the Claude Code CLI). When silent, route this
  // channel to a log file instead; only print to the console when we own it.
  let paidCalls = 0;
  let sayFile = null;
  if (silent) {
    try {
      sayFile = path.join(os.homedir(), '.openzoo', 'proxy.log');
      mkdirSync(path.dirname(sayFile), { recursive: true });
    } catch { sayFile = null; }
  }
  const say = (...a) => {
    const line = a.join(' ');
    if (sayFile) { try { appendFileSync(sayFile, line + '\n'); return; } catch { /* fall through */ } }
    console.log(line);
  };
  let sessionSpent = 0;
  let sessionCogs = 0;
  let sessionDirect = 0;
  const MARKUP = 3; // confirmed constant, see .claude/wiki.md "Margin needs a like-for-like denominator"
  let tunnelSpent = 0;
  // Live balance refresh state — the real implementation is assigned in the
  // banner section below; the handler only ever calls scheduleRefresh().
  let lastSnap = null;
  let refreshBalances = async () => {};
  let refreshPending = false;
  const scheduleRefresh = (ms) => {
    if (silent || refreshPending) return;
    refreshPending = true;
    const t = setTimeout(async () => { refreshPending = false; await refreshBalances(); }, ms);
    t.unref?.();
  };
  // Set once cloudflared is up (see below). Gating keys off the REQUEST's
  // origin, not off whether the URL exists yet, so there is no startup window
  // where public traffic slips through ungated.
  let tunnelGate = null;
  // How many chat requests actually ARRIVED. The single number that answers
  // "is the editor really routing through us?" — an editor that silently keeps
  // using its own backend leaves this at 0 while looking perfectly healthy.
  let servedRequests = 0;
  // SPILL ACCOUNTING. The product's whole claim is that context is offloaded
  // instead of re-sent, and nothing measured it — the status line showed spend
  // and call count, which is the cost side with none of the benefit.
  let spillCalls = 0;
  let spilledChars = 0;
  let spillReuses = 0;
  // Spend/direct for ONLY the calls that spilled. The session-wide savingX
  // averages these with every small turn that had nothing to offload, so it
  // slides toward 1.0 as a conversation grows — which reads as the mechanism
  // degrading when it is just the mix changing. OBSERVED: 1.3166 -> 1.1823
  // while spilled calls and offloaded tokens both sat completely still.
  let spillSpend = 0;
  let spillDirect = 0;
  // ACTUAL UPSTREAM SPEND, FROM THE PROVIDER — not our estimate of it.
  //
  // Every other dollar figure here is derived from OpenRouter's CATALOG price
  // times a token count we guessed, and the guess is bad in a specific
  // direction: output is priced on `max_tokens`, which callers set as a ceiling.
  // MEASURED 2026-08-19: a call we quoted at $0.9858 (32,000 reserved output
  // tokens) actually cost $0.007962 — OpenRouter's own number, 124x smaller.
  //
  // OpenRouter returns `usage.cost` on every completion, so the real figure is
  // already in the response body and needs no extra request and no account-level
  // lookup. That last part matters: /api/v1/credits reports the WHOLE key's
  // lifetime usage, and this key also pays for ttfx direct runs and other work,
  // so the account total can never attribute a dollar to this proxy. Per-call
  // cost can.
  let sessionActual = 0;
  let actualCalls = 0;
  // CREDIT, CACHED. Users cannot tell prepaid credit from wallet balance and
  // have to guess whether a call was even paid for ("I don't think x402 made me
  // pay this at all"). The status line runs EVERY turn, so this is refreshed at
  // most every 20s and served stale in between — a status line must never add
  // latency to the thing it is describing.
  let creditUsd = null;
  let creditAt = 0;
  const refreshCredit = () => {
    if (Date.now() - creditAt < 20000) return;
    creditAt = Date.now();
    fetch(`${config.apiBase}/v1/credits`, { headers: withNamespace({}), signal: AbortSignal.timeout(4000) })
      .then((r) => r.json())
      .then((j) => { creditUsd = Number(j.balanceUsd) || 0; })
      .catch(() => { /* advisory only */ });
  };
  let tunnelError = null;

  const server = http.createServer(async (req, res) => {
    // MCP on the SAME port as the proxy. One `npx openzoo` gives a harness
    // both surfaces: point base_url at /v1 for transparent context spilling,
    // or add /mcp for tools (zoo_bind, zoo_ask...). Running two commands to
    // get both was friction nobody should pay.
    // This wallet's own running total for THIS proxy process — every paid
    // call through this port counts (GUI, MCP, CLI, any harness), not just
    // whichever surface happens to be asking. Local-only, no auth needed:
    // it's a number, not a capability.
    if (req.method === 'GET' && (req.url || '').split('?')[0] === '/v1/session') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ spentUsd: sessionSpent, cogsUsd: sessionCogs, directUsd: sessionDirect, paidCalls }));
      return;
    }

    // Public addresses only — never the private key. Exists so a caller (the
    // grokui error path, in particular) can print REAL funding instructions
    // inline instead of telling the user to go look somewhere else.
    if (req.method === 'GET' && (req.url || '').split('?')[0] === '/v1/wallet') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        solana: client.address,
        evm: client.evmAddress,
        funding: fundingLine(client.address),
        // from the same background poll the startup/refresh lines use, so a
        // caller can tell a genuinely empty wallet from a transient 402
        balances: balanceLine(lastSnap || []) || null,
        funded: (lastSnap || []).some((b) => b.ui > 0),
      }));
      return;
    }

    if ((req.url || '').split('?')[0] === '/mcp') {
      try {
        const { handleMcpRequest } = await import('./mcphttp.js');
        await handleMcpRequest(req, res);
      } catch (err) {
        jsonErr(res, 500, `openzoo mcp error: ${err.message}`);
      }
      return;
    }

    // THE CUTESY GUI. Local browsers hitting GET / get a little chat app —
    // model zoo, bind-a-corpus drawer, live spent/saved ticker off the x402
    // receipts. Tunnel traffic (cf headers) keeps the JSON discovery below:
    // the GUI is the operator's, not the public's.
    {
      const p0 = (req.url || '').split('?')[0];
      const local = !(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
      if (local && req.method === 'GET' && (p0 === '/' || p0 === '/gui')) {
        try {
          const html = readFileSync(new URL('./gui.html', import.meta.url), 'utf8');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        } catch { /* fall through to proxy behavior if the file is missing */ }
      }
    }

    const normalized = normalizePath(req.url);
    if (normalized !== req.url) {
      log(`path ${req.url} -> ${normalized} (base_url already ends in /v1)`);
      req.url = normalized;
    }
    let url = `${config.apiBase}${req.url}`;
    // Requests that arrived over the public quick-tunnel URL carry cloudflared's
    // headers; nothing dialing 127.0.0.1 directly does. That distinction is what
    // lets localhost stay keyless while the SAME port is safely public.
    const viaTunnel = !requireToken && tunnelGate
      && Boolean(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
    // Auth first: refuse before reading a body, forwarding, quoting or paying.
    if (requireToken) {
      const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      if (got !== requireToken) {
        log(`tunnel: 401 ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
        jsonErr(res, 401, 'unauthorized: this openzoo tunnel requires the api key printed at startup');
        return;
      }
      if (sessionMaxUsd != null && sessionSpent >= sessionMaxUsd) {
        jsonErr(res, 402, `openzoo tunnel session cap reached ($${sessionMaxUsd}) — restart the tunnel or raise OPENZOO_TUNNEL_MAX_USD`);
        return;
      }
    }
    // ROUTING TRUTH, SERVED FROM WHATEVER URL YOU REACHED US ON. A cloud agent
    // only ever touches the tunnel, so asking a local MCP process "what is my
    // routing" is the wrong question — the answer has to come from the tunnel
    // itself, and name the tunnel. Free and unauthenticated: discovery must
    // never be the thing that is gated.
    {
      const p0 = (req.url || '').split('?')[0];
      if (req.method === 'GET' && (p0 === '/v1/info' || p0 === '/info')) {
        refreshCredit();
        const self = viaTunnel && tunnelGate?.publicUrl
          ? `${tunnelGate.publicUrl}/v1`
          : `http://localhost:${config.port}/v1`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          youAreTalkingTo: 'openzoo proxy',
          yourEndpoint: self,
          reachedVia: viaTunnel ? 'public tunnel' : 'localhost',
          publicTunnel: tunnelGate?.publicUrl ? `${tunnelGate.publicUrl}/v1` : null,
          servedRequests,
          spilled: {
            calls: spillCalls,
            chars: spilledChars,
            // ~4 chars/token is the usual rough rule; this is the context that
            // did NOT ride upstream on those calls, which is the number the
            // saving is actually made of.
            tokensApprox: Math.round(spilledChars / 4),
            reusedBinds: spillReuses,
            spend: spillSpend,
            direct: spillDirect,
            savedUsd: Math.max(0, spillDirect - spillSpend),
            savingX: spillSpend > 0 ? Number((spillDirect / spillSpend).toFixed(4)) : null,
          },
          spendUsd: sessionSpent,
          creditUsd,
          // WHAT THE SAME CALLS WOULD HAVE COST DIRECT. Spend on its own is a
          // bill; spend beside the counterfactual is the product. The receipt
          // already carries directUsd per call — it simply never reached the
          // status line, so the one number that justifies the tool was the one
          // the user could not see.
          directUsd: sessionDirect,
          savedUsd: Math.max(0, sessionDirect - sessionSpent),
          savingX: sessionSpent > 0 ? Number((sessionDirect / sessionSpent).toFixed(4)) : null,
          paidCalls,
          // WHAT THE INFERENCE ACTUALLY COST, as reported by OpenRouter on each
          // completion (`usage.cost`). Every other figure above is a catalog
          // estimate built on `max_tokens`; this is metered. `margin` is the
          // honest gross on this session — the number that says whether the
          // pricing is sane, which no estimate can.
          actual: {
            calls: actualCalls,
            upstreamUsd: Number(sessionActual.toFixed(6)),
            billedUsd: Number(sessionSpent.toFixed(6)),
            marginUsd: Number((sessionSpent - sessionActual).toFixed(6)),
            markupX: sessionActual > 0 ? Number((sessionSpent / sessionActual).toFixed(2)) : null,
          },
          mcp: `${self.replace(/\/v1$/, '')}/mcp`,
          upstream: config.apiBase,
          payment: 'x402 per request from the operator\'s local burner wallet — no API key, no account',
          auth: viaTunnel
            ? 'this public URL requires the oz_… bearer for paid endpoints; /v1/models and /v1/hrr/bind are free'
            : 'localhost is keyless',
          context: {
            yourAttentionWindow: 'unchanged — openzoo does not enlarge it',
            boundCeiling: '~128M tokens client-usable via bind + retrieval',
            singleRequestLimit: '~8MB per request; larger corpora bind in parts',
            retrieval: 'lossy top-k retrieval, NOT lossless compression',
          },
          tools: ['zoo_bind', 'zoo_ask', 'zoo_status', 'zoo_models', 'zoo_wallet', 'zoo_contexts'],
          docs: 'https://openzoo.fun',
        }, null, 2));
        return;
      }
    }

    if (viaTunnel) {
      const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      // TRUST ON FIRST USE, so a stale key still works without weakening the
      // tunnel to "any key forever".
      //
      // Tunnel tokens are minted per session, so a client holding a key from an
      // earlier run silently failed — and the only fixes were re-pasting by
      // hand or writing into the editor's OS-encrypted credential store, which
      // would mean prompting for keychain access to install a value the user
      // never chose. Instead: the printed token always works, and the FIRST
      // other key to present itself claims the tunnel for the rest of the
      // session. Your editor (which reaches the URL first, from this machine)
      // adopts it; anyone who finds the URL afterwards is refused because the
      // slot is taken. The URL is unguessable and ephemeral, the spend ceiling
      // still applies, and OPENZOO_TUNNEL_STRICT=1 restores exact-match only.
      const strict = process.env.OPENZOO_TUNNEL_STRICT === '1';
      let authed = got === tunnelGate.token;
      if (!authed && !strict && got.length >= 8) {
        if (!tunnelGate.adopted) {
          tunnelGate.adopted = got;
          log(`public url: adopted the caller's key (first-use) — later keys must match it`);
          authed = true;
        } else {
          authed = got === tunnelGate.adopted;
        }
      }
      const p = (req.url || '').split('?')[0];
      // DISCOVERY IS FREE. An agent probing this URL cold should be able to
      // work out what it is and what to ask its operator for — a bare 401 on
      // every path just sends it spelunking through the operator's machine.
      // Reads that cost nothing and leak nothing (the catalog is public on
      // the zoo anyway) go through without the key; money paths stay gated.
      if (!authed) {
        if (req.method === 'GET' && (p === '/' || p === '/v1' || p === '/v1/info')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            name: 'openzoo proxy (public tunnel)',
            what: 'OpenAI-compatible pay-per-call proxy — the operator\'s wallet pays per request via x402; no account, no signup.',
            authentication: 'All POST endpoints require `Authorization: Bearer <api key>`. The key is printed in the operator\'s terminal at proxy startup — ask them for it. It is NOT guessable.',
            endpoints: {
              'GET /v1/models': 'model catalog with pricing + context_length — no key needed',
              'GET /v1/models/{id}': 'single-model probe — no key needed',
              'POST /v1/chat/completions': 'chat (streaming supported, any model id — unknown ids are matched to the nearest served model) — key required',
            },
            docs: 'https://openzoo.fun · https://www.npmjs.com/package/openzoo',
          }, null, 2));
          return;
        }
        // Binding COSTS NOTHING — no 402, no wallet, no settlement. Gating it
        // behind the key only stopped agents from using the one endpoint that
        // makes a big corpus workable: observed in the wild, an agent wrote a
        // correct multi-part bind script, got 401 on the final append, and
        // fell back to stuffing the corpus inline. The money paths below stay
        // gated; the worst a stranger can do here is spend our sidecar's disk.
        const freeRead = req.method === 'GET' && (p === '/v1/models' || p.startsWith('/v1/models/'));
        const freeBind = req.method === 'POST' && p === '/v1/hrr/bind';
        if (freeBind) log(`public url: unauthenticated bind allowed (free endpoint) from ${req.socket.remoteAddress}`);
        if (!freeRead && !freeBind) {
          log(`public url: 401 ${req.method} ${req.url}`);
          jsonErr(res, 401, 'unauthorized: this openzoo public URL requires the api key printed at the operator\'s proxy startup — GET / for discovery, GET /v1/models is open');
          return;
        }
      }
      if (authed && tunnelSpent >= tunnelGate.sessionMaxUsd) {
        jsonErr(res, 402, `openzoo public-URL session cap reached ($${tunnelGate.sessionMaxUsd}) — restart the proxy or raise OPENZOO_TUNNEL_MAX_USD`);
        return;
      }
    }
    let bodyBuf;
    try {
      bodyBuf = await readBody(req);
    } catch {
      jsonErr(res, 400, 'bad request body');
      return;
    }

    // ANTHROPIC MESSAGES SHAPE. A harness pointed here via ANTHROPIC_BASE_URL
    // (Claude Code, the Anthropic SDKs) speaks POST /v1/messages, not chat
    // completions — this is how such a harness routes its inference through
    // x402 without any DNS or TLS trickery. Translate the body to OpenAI shape
    // and rewrite the path so EVERYTHING downstream (model rewrite, brief,
    // corpus cache, payment, replay, streaming) runs unchanged; translate the
    // answer back on the way out. See lib/anthropic.js.
    let anthropicMode = false;
    let anthropicModel = null;
    // The CLIENT's streaming intent, kept separate from the body we send
    // upstream. The Anthropic lane asks the gateway for a complete message (we
    // can only translate a finished one) while still owing the caller SSE.
    let clientWantsStream = false;
    let responsesMode = false;
    let responsesModel = null;
    let responsesCustom = null;   // names of freeform tools needing custom_tool_call on the way back
    const rawPath = (req.url || '').split('?')[0];

    // RESPONSES API. Some harnesses speak only this wire format — OpenAI's
    // Codex Security CLI pins `wire_api: "responses"` in its provider table, so
    // a bare 404 here made it fall back to wss://api.openai.com and bypass the
    // proxy entirely while reporting the failure as an auth error. Translate
    // in, translate out; everything between stays on the chat path.
    if (req.method === 'POST' && (rawPath === '/v1/responses' || rawPath === '/responses')) {
      try {
        const inbound = JSON.parse(bodyBuf.toString('utf8'));
        // TEMP CAPTURE: dump the first few Responses requests so the agent's
        // actual wire usage (store / previous_response_id / tool shapes) can be
        // read rather than inferred. Guarded by an env var so it is off unless
        // asked for.
        if (process.env.OZ_CAPTURE_RESPONSES) {
          try {
            const fs = await import('node:fs');
            const dir = process.env.OZ_CAPTURE_RESPONSES;
            fs.mkdirSync(dir, { recursive: true });
            const n = fs.readdirSync(dir).length;
            // Capture the LATER turns too. Turn 1 is already understood; the
            // unknown is what codex sends back after running a tool, so bias
            // the capture toward requests that carry a tool result.
            const hasResult = Array.isArray(inbound.input)
              && inbound.input.some((i) => i && String(i.type || '').endsWith('_call_output'));
            const tag = hasResult ? 'result' : 'plain';
            if (n < 24) fs.writeFileSync(`${dir}/${tag}-${n}.json`, JSON.stringify(inbound, null, 2));
          } catch { /* capture must never break a paid call */ }
        }
        responsesModel = inbound.model;
        const meta = {};
        bodyBuf = Buffer.from(JSON.stringify(responsesToChat(inbound, meta)));
        responsesCustom = meta.custom;
        responsesMode = true;
        req.url = '/v1/chat/completions';
        url = `${config.apiBase}${req.url}`;
      } catch {
        jsonErr(res, 400, 'invalid responses body');
        return;
      }
    }

    if (req.method === 'POST' && (rawPath === '/v1/messages' || rawPath === '/messages')) {
      try {
        const inbound = JSON.parse(bodyBuf.toString('utf8'));
        anthropicModel = inbound.model;
        // ANTHROPIC CLIENTS CANNOT READ AN OPENAI STREAM.
        //
        // The gateway now streams for real, and `relay()` pipes those frames
        // through untouched — which is correct for an OpenAI client and
        // unreadable to Claude Code, which speaks the Anthropic SSE grammar
        // (message_start / content_block_delta / message_stop). It surfaced as
        // "API returned an empty or malformed response (HTTP 200)": a 200 whose
        // body the client cannot parse.
        //
        // The translation we have (openAIToAnthropic + writeAnthropicSse) works
        // on a COMPLETE message, so this lane asks the gateway not to stream and
        // keeps the buffered translation. That costs Claude Code the
        // time-to-first-byte win until an incremental OpenAI->Anthropic frame
        // translator exists; a readable answer late beats an unreadable one now.
        const converted = anthropicToOpenAI(inbound);
        clientWantsStream = converted.stream === true || inbound.stream === true;
        // STREAM AGAIN. This forced `stream:false` for a few hours because
        // relay() piped the gateway's OpenAI frames straight to a client that
        // speaks message_start / content_block_delta, producing a 200 nobody
        // could parse. Buffering fixed the parse and cost the whole point:
        // Claude Code sends max_tokens=32000 against a 600-turn transcript, so
        // every turn became minutes of zero bytes and read as a hang.
        // streamOpenAIToAnthropic() translates the grammar frame by frame, so
        // the lane can be fast AND readable.
        converted.stream = clientWantsStream;
        bodyBuf = Buffer.from(JSON.stringify(converted));
        anthropicMode = true;
        req.url = '/v1/chat/completions';
        url = `${config.apiBase}${req.url}`;
      } catch {
        jsonErr(res, 400, 'invalid anthropic messages body');
        return;
      }
    }

    // Harness model ids ("gpt-5.6-sol", "claude-…") are rewritten onto the
    // NEAREST zoo model BEFORE anything else sees the body — any POST that
    // carries a model field, not just chat/completions, so /completions,
    // /responses and future shapes all work. Never silent.
    let wantsStream = false;
      if ((req.url || '').includes('/chat/completions') && req.method === 'POST') {
        servedRequests += 1;
        say(`\n<- request #${servedRequests} from ${(req.headers['user-agent'] || 'unknown').slice(0, 40)}`);
      }
    if (rewritablePath(req.method, req.url)) {
      const rw = await maybeRewriteModel(bodyBuf);
      if (rw) {
        // SAY WHETHER THE OVERRIDE IS ACTUALLY SET, and name it.
        //
        // This used to print "(OPENZOO_DEFAULT_MODEL overrides)" on EVERY
        // rewrite whether or not the variable existed — a hint about a knob,
        // phrased as a statement about this request. It cost a real incident:
        // the proxy was restarted from a shell carrying
        // OPENZOO_DEFAULT_MODEL=deepseek/deepseek-v4-pro-0813, so every
        // claude-sonnet-5 ask was served by deepseek, and the log line looked
        // exactly the same as it always had. deepseek matches the reasoning
        // regex, so a 16-token safety classification became a 4,000-token
        // reasoning generation — 11.5s, past the caller's timeout, and Claude
        // Code reported "claude-sonnet-5 is temporarily unavailable".
        const forced = process.env.OPENZOO_DEFAULT_MODEL;
        log(forced
          ? `model "${rw.from}" -> FORCED to ${forced} by OPENZOO_DEFAULT_MODEL (nearest match would have been ${rw.to})`
          : `model "${rw.from}" is not on the zoo — nearest match ${rw.to}`);
        bodyBuf = rw.body;
      }
      try {
        const parsed = JSON.parse(bodyBuf.toString('utf8'));
        wantsStream = parsed?.stream === true || clientWantsStream;
        // REASONING MODELS SPEND max_tokens ON THINKING FIRST.
        //
        // The budget covers hidden reasoning AND the visible answer, so a
        // caller that asks for 40 tokens because it wants a short answer often
        // gets ZERO — the whole allowance went to reasoning and the completion
        // truncated to an empty string. Measured across three families in one
        // day: deepseek returned 0 chars at 8k and was fine at 24k; grok-4.6
        // pinned ct at exactly its 16,000 budget with no visible output;
        // sonnet-5 truncated a 600-token file mid-function because Anthropic's
        // max_tokens covers thinking too.
        //
        // An empty completion is not an error — it bills normally and renders
        // as a blank reply — so this fails silently and looks like the retrieval
        // broke. It cost real debugging time tonight for exactly that reason.
        // Multiply the allowance for known reasoning families and let callers
        // keep asking for what they actually want back.
        const REASONING = /(deepseek|grok|o[134](-|$)|reasoner|thinking|-pro\b|sol-pro|qwq)/i;
        const mult = Number(process.env.OPENZOO_REASONING_MAX_TOKENS_X || 4);
        const cap = Number(process.env.OPENZOO_REASONING_MAX_TOKENS_CAP || 32000);
        const mdl = String(parsed?.model || '');
        const mt = Number(parsed?.max_tokens);
        // A MULTIPLIER ALONE IS NOT ENOUGH. 4x on a caller's 40 is 160, which is
        // still nothing for a model that thinks first — measured, 2 of 3 runs
        // still returned empty at 160. Reasoning needs an absolute floor, not a
        // relative bump, so take whichever is larger.
        const floor = Number(process.env.OPENZOO_REASONING_MIN_TOKENS || 4000);
        if (mult > 1 && REASONING.test(mdl) && Number.isFinite(mt) && mt > 0 && mt < cap) {
          const raised = Math.min(cap, Math.max(floor, Math.round(mt * mult)));
          if (raised > mt) {
            parsed.max_tokens = raised;
            bodyBuf = Buffer.from(JSON.stringify(parsed));
            log(`reasoning model ${mdl}: max_tokens ${mt} -> ${raised} (thinking shares the budget; OPENZOO_REASONING_MAX_TOKENS_X=1 disables)`);
          }
        }
        // Tell the agent what it is actually connected to — in band, where it
        // will read it, instead of leaving it to guess (and to chunk corpora
        // it could bind whole). See lib/brief.js.
        if ((req.url || '').includes('/chat/completions')) {
          // Tell it the URL it actually reached us on — the public tunnel for
          // a remote harness, localhost for a local one. An agent that has to
          // guess its own endpoint guesses a website.
          const selfUrl = viaTunnel && tunnelGate?.publicUrl
            ? `${tunnelGate.publicUrl}/v1`
            : `http://localhost:${config.port}/v1`;
          const briefed = injectBrief(parsed, selfUrl);
          if (briefed) bodyBuf = Buffer.from(JSON.stringify(briefed));
        }
      } catch { /* not JSON */ }
    }

    // Retry of a body we answered seconds ago? Serve the cached completion —
    // never pay twice for a harness's reconnect loop.
    const isChat = req.method === 'POST' && (req.url || '').includes('/chat/completions');
    const rKey = isChat ? replayKey(bodyBuf, req.headers) : null;
    if (rKey) {
      const hit = replayGet(rKey);
      if (hit) {
        log('identical request within 30s — served the cached completion, NOT re-paid');
        // The cache stores the CHAT shape. A Responses caller must get its own
        // wire format back, or the replay path silently answers in a format the
        // client cannot parse — a bug that only appears on the SECOND identical
        // request, which is exactly when nobody is watching.
        if (responsesMode) {
          if (wantsStream) { writeResponsesSse(res, hit.data, responsesModel, null, responsesCustom); return; }
          const rh = { 'content-type': 'application/json' };
          if (hit.settle) rh['x-payment-response'] = hit.settle;
          res.writeHead(200, rh);
          res.end(JSON.stringify(chatToResponses(hit.data, responsesModel, responsesCustom)));
          return;
        }
        if (wantsStream) { serveAsSse(res, hit.data, null); return; }
        const h = { 'content-type': 'application/json' };
        if (hit.settle) h['x-payment-response'] = hit.settle;
        res.writeHead(200, h);
        res.end(JSON.stringify(hit.data));
        return;
      }
    }
    const init = { method: req.method, headers: upstreamHeaders(req) };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = bodyBuf;

    // Harnesses validate their configured model BEFORE ever POSTing — some
    // list /v1/models, some probe /v1/models/<id>. Both must succeed for the
    // ids we know how to rewrite, or the harness refuses upfront and the
    // rewrite never gets its chance.
    const path = (req.url || '').split('?')[0];
    if (req.method === 'GET' && path === '/v1/models') {
      try {
        const { response } = await client.fetch(url, init);
        const payload = await response.json();
        res.writeHead(response.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response.ok ? augmentModelList(payload) : payload));
        return;
      } catch { /* fall through to the plain relay below */ }
    }
    const probe = req.method === 'GET' && /^\/v1\/models\/(.+)$/.exec(path);
    if (probe && ALIAS_IDS.includes(decodeURIComponent(probe[1]))) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: decodeURIComponent(probe[1]), object: 'model', owned_by: 'openzoo-alias' }));
      return;
    }

    try {
      let cached = null;
      try {
        cached = await maybeCacheCorpus(req, bodyBuf, log);
      } catch (err) {
        log(`context cache skipped for this call: ${err.message}`);
      }
      const send = (buf, ctxId, topK) => client.fetch(url, {
        ...init,
        body: buf,
        headers: ctxId
          ? {
            ...init.headers,
            'x-hrr-context': ctxId,
            // Only on the spill path — a caller that set its own top-k keeps it.
            ...(topK ? { 'x-hrr-top-k': String(topK) } : {}),
          }
          : init.headers,
      });
      let didSpill = false;
      let result;
      if (cached) {
        spillCalls += 1;
        didSpill = true;
        spilledChars += cached.corpus?.length || 0;
        if (cached.reused) spillReuses += 1;
        result = await send(cached.body, cached.contextId, cached.topK);
        // Sidecar wiped between runs: the gateway 404s BEFORE the 402 (nothing
        // paid). Never fail on a stale manifest — re-bind once and retry.
        if (result.response.status === 404) {
          const text = await result.response.text();
          if (/context_not_found/.test(text)) {
            log('bound context is gone on the zoo — re-binding once...');
            forgetContext(config.apiBase, cached.hash);
            const rebound = await bindCorpus(cached.corpus, { force: true });
            result = await send(cached.body, rebound.contextId, cached.topK);
          } else {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(text);
            return;
          }
        }
      } else {
        result = await client.fetch(url, init);
      }
      const { response, paid, receipt } = result;
      if (paid && receipt) {
        if (receipt.ok && typeof receipt.billedUsd === 'number') {
          sessionSpent += receipt.billedUsd;
          // cogs: no per-call field for it, but MARKUP is a known constant
          // (3x — confirmed against the gateway's own margin math), and
          // billedUsd = cogs * markup on a straight-markup call. Close enough
          // on a counterfactual (leCore-discounted) call too since markup is
          // still the ceiling those get capped against.
          // Prefer the gateway's own cogsUsd. Deriving it as billedUsd/MARKUP
          // is only correct on a straight-markup call: under counterfactual
          // pricing billedUsd is min(direct×discount, markupUsd), so the
          // division understates cost and overstates margin.
          sessionCogs += typeof receipt.cogsUsd === 'number'
            ? receipt.cogsUsd
            : receipt.billedUsd / MARKUP;
          // direct = what answering this WITHOUT the zoo would have cost. On an
          // attach call that is the whole bound corpus, which is why it can be
          // orders of magnitude above what was billed. directUsd is exact and
          // always present; savesVsDirect is the same number as a ratio.
          if (didSpill) {
            spillSpend += receipt.billedUsd || 0;
            spillDirect += typeof receipt.directUsd === 'number' ? receipt.directUsd : (receipt.billedUsd || 0);
          }
          sessionDirect += typeof receipt.directUsd === 'number'
            ? receipt.directUsd
            : typeof receipt.savesVsDirect === 'number'
              ? receipt.savesVsDirect * receipt.billedUsd
              : receipt.billedUsd;
          // The public-URL ceiling meters only public-origin spend — your own
          // local calls never eat into it.
          if (viaTunnel) tunnelSpent += receipt.billedUsd;
        }
        const line = receipt.ok ? receipt.line : `paid retry -> HTTP ${receipt.status}`;
        // Wherever a running total is the thing to watch, it rides the receipt.
        if (requireToken) say(`${line}  ·  session $${sessionSpent.toFixed(6)}`);
        else if (viaTunnel) say(`${line}  ·  public-url session $${tunnelSpent.toFixed(6)}`);
        else say(line);
        // ALWAYS-ON SPEND, TUI-SAFE. When a harness owns the terminal (silent),
        // the receipt lines go to a file (they corrupt a TUI). But the running
        // total should still be visible — so write it to the terminal TITLE via
        // an OSC escape, which updates the window/tab title without touching the
        // TUI's content. `openzoo ● $0.0042 · 12 calls` in the title bar, live.
        if (receipt.ok && typeof receipt.billedUsd === 'number') { paidCalls += 1; }
        if (sayFile) {
          try { process.stderr.write(`]0;openzoo ● $${sessionSpent.toFixed(4)} · ${paidCalls} call${paidCalls === 1 ? '' : 's'}`); } catch { /* no tty */ }
        }
        scheduleRefresh(4000); // settlement lands on-chain in a few seconds
      }
      // Chat completions come back as one JSON object (settle-before-serve).
      // Cache it against retries, and if the harness asked to stream, honour
      // that contract ourselves. An upstream that someday truly streams (SSE
      // content-type) passes straight through the relay below, untouched.
      const upCt = response.headers.get('content-type') || '';
      if (isChat && response.ok && upCt.includes('application/json')) {
        let data = null;
        try { data = await response.clone().json(); } catch { /* not JSON after all */ }
        // WHAT IT REALLY COST, straight from the provider. This rides every
        // completion already — no extra call, and unlike the account-level
        // /api/v1/credits total it is attributable to THIS proxy even though the
        // same OpenRouter key also pays for ttfx and everything else.
        if (typeof data?.usage?.cost === 'number' && data.usage.cost >= 0) {
          sessionActual += data.usage.cost;
          actualCalls += 1;
        }
        // PREPAID CALLS STILL COST MONEY. The block above only meters calls
        // where THIS proxy answered a 402 and paid. When prepaid credit covers
        // the quote the gateway serves 200 on the FIRST request, so there is
        // no 402, no payment and no receipt — and the session read $0.05 / 2
        // calls while the credit balance had actually fallen $3.017 -> $1.395
        // over a 30-question run. The receipt still rides the response body,
        // so meter it from there.
        if (!paid && data?.x402 && typeof data.x402.billedUsd === 'number') {
          const x = data.x402;
          sessionSpent += x.billedUsd;
          sessionCogs += typeof x.cogsUsd === 'number' ? x.cogsUsd : x.billedUsd / MARKUP;
          sessionDirect += typeof x.directUsd === 'number' ? x.directUsd : x.billedUsd;
          if (didSpill) {
            // THE number that settles why a spilled call did or did not save:
            // the gateway only prices a counterfactual when corpusTokens >
            // promptTokens, so a tail that rivals the corpus silently falls
            // back to markup and direct collapses onto billed.
            const lc = x.lecore || {};
            // counterfactualTokensUsed is the basis the gateway ACTUALLY priced
            // on. lecore.corpusTokens is often absent and reading it printed
            // 'corpus ?' on calls that were pricing fine — which sent a whole
            // night's debugging after a number that was never the input.
            const basis = x.counterfactualTokensUsed ?? lc.corpusTokens;
            log(`spill priced: ${x.pricing} · basis ${basis ?? '?'} tok vs sent ${lc.tokensBefore ?? '?'} -> ${lc.tokensAfter ?? '?'} · billed ${(x.billedUsd ?? 0).toFixed(5)} direct ${(x.directUsd ?? 0).toFixed(5)}`);
            spillSpend += x.billedUsd;
            spillDirect += typeof x.directUsd === 'number' ? x.directUsd : x.billedUsd;
          }
          paidCalls += 1;
          if (viaTunnel) tunnelSpent += x.billedUsd;
          say(`credit -> $${x.billedUsd.toFixed(6)}  ·  session $${sessionSpent.toFixed(6)}`);
        }
        if (data?.object === 'chat.completion') {
          if (rKey) replayPut(rKey, data, response.headers.get('x-payment-response'));
          // Anthropic-shaped caller gets an Anthropic-shaped answer, streamed
          // or not, so Claude Code and the SDKs parse it natively.
          if (anthropicMode) {
            const msg = openAIToAnthropic(data, anthropicModel);
            if (wantsStream) { writeAnthropicSse(res, msg, response); return; }
            const h = { 'content-type': 'application/json' };
            const settleHdr = response.headers.get('x-payment-response');
            if (settleHdr) h['x-payment-response'] = settleHdr;
            res.writeHead(200, h);
            res.end(JSON.stringify(msg));
            return;
          }
          if (responsesMode) {
            // A Responses client that asked to stream is WAITING for
            // `response.completed`; handing it a JSON body closes the socket
            // mid-stream and it reports "stream disconnected before
            // completion". Honour the streaming contract when it asked for it.
            if (wantsStream) { writeResponsesSse(res, data, responsesModel, response, responsesCustom); return; }
            const out = chatToResponses(data, responsesModel, responsesCustom);
            const h = { 'content-type': 'application/json' };
            const settleHdr = response.headers.get('x-payment-response');
            if (settleHdr) h['x-payment-response'] = settleHdr;
            res.writeHead(200, h);
            res.end(JSON.stringify(out));
            return;
          }
          if (wantsStream) { serveAsSse(res, data, response); return; }
          const h = { 'content-type': 'application/json' };
          const settleHdr = response.headers.get('x-payment-response');
          if (settleHdr) h['x-payment-response'] = settleHdr;
          res.writeHead(200, h);
          res.end(JSON.stringify(data));
          return;
        }
      }
      // A STREAMED call is metered from the gateway's trailing SSE comment —
      // same figures the JSON path reads out of `data.x402`, same counters, so
      // the status line does not care which transport served the answer.
      const meterStreamed = (x) => {
        if (paid || typeof x?.billedUsd !== 'number') return;
        sessionSpent += x.billedUsd;
        sessionCogs += typeof x.cogsUsd === 'number' ? x.cogsUsd : x.billedUsd / MARKUP;
        sessionDirect += typeof x.directUsd === 'number' ? x.directUsd : x.billedUsd;
        if (typeof x.actualUsd === 'number' && x.actualUsd >= 0) { sessionActual += x.actualUsd; actualCalls += 1; }
        if (didSpill) {
          const lc = x.lecore || {};
          log(`spill priced (streamed): ${x.pricing} · basis ${x.counterfactualTokensUsed ?? '?'} tok vs sent ${lc.tokensBefore ?? '?'} -> ${lc.tokensAfter ?? '?'} · billed ${(x.billedUsd ?? 0).toFixed(5)} direct ${(x.directUsd ?? 0).toFixed(5)}`);
          spillSpend += x.billedUsd;
          spillDirect += typeof x.directUsd === 'number' ? x.directUsd : x.billedUsd;
        }
        paidCalls += 1;
        if (viaTunnel) tunnelSpent += x.billedUsd;
        say(`credit -> $${x.billedUsd.toFixed(6)}  ·  session $${sessionSpent.toFixed(6)}`);
      };

      // ANTHROPIC CLIENTS GET THE SAME STREAM, IN THEIR OWN GRAMMAR.
      // Translated frame by frame rather than buffered, so Claude Code sees
      // tokens as they are produced instead of nothing until the turn ends.
      if (anthropicMode && wantsStream
          && (response.headers.get('content-type') || '').includes('text/event-stream')
          && response.ok && response.body) {
        const tr = streamOpenAIToAnthropic(res, response, anthropicModel, meterStreamed);
        let pending = '';
        const body = Readable.fromWeb(response.body);
        res.on('close', () => body.destroy());
        try {
          for await (const c of body) {
            pending += c.toString('utf8');
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            for (const line of lines) {
              if (line.startsWith(': x402 ')) {
                try { meterStreamed(JSON.parse(line.slice(7))); } catch { /* not ours */ }
                continue;
              }
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              try { tr.onChunk(JSON.parse(payload)); } catch { /* frame split across chunks */ }
            }
          }
        } catch (e) {
          log(`anthropic stream aborted: ${e.message}`);
        }
        tr.finish();
        return;
      }

      await relay(res, response, meterStreamed);
    } catch (err) {
      if (err instanceof QuoteTooHighError) {
        log(err.message);
        jsonErr(res, 402, err.message, { quote: err.quote });
      } else if (err instanceof UnderfundedError) {
        log(err.message);
        jsonErr(res, 402, err.message);
      } else {
        // "fetch failed" alone is undiagnosable — undici hides the real
        // network error in `cause`. Surface it (and log the stack) or every
        // transport hiccup looks identical to a payment bug.
        const cause = err.cause?.message || err.cause?.code || err.cause;
        const detail = cause ? `${err.message} (${cause})` : err.message;
        log(`proxy error: ${detail}`);
        if (process.env.OPENZOO_DEBUG) console.error(err.stack);
        jsonErr(res, 502, `openzoo proxy error: ${detail}`);
      }
    }
  });

  // BIND HOST. Default 127.0.0.1 — the keyless localhost path must never be
  // world-reachable on an ordinary machine. A RunPod box is the exception: its
  // HTTP proxy reaches the container over the pod network, so a localhost bind
  // shows "Initializing…" forever (MEASURED: podagent's 0.0.0.0 ports went
  // Ready, the 127.0.0.1 proxy never did). The box sets OPENZOO_BIND=0.0.0.0
  // AND a tunnel token, so the RunPod-fronted port stays gated exactly like the
  // public tunnel path.
  const bindHost = process.env.OPENZOO_BIND || '127.0.0.1';
  // SELF-HEAL A TAKEN PORT. A killed-but-not-reaped run, a second terminal, or
  // anything else already on 8402 made listen() reject and took the whole start
  // down — and because `openzoo claude` starts us with silent:true, the user saw
  // only "starting the proxy in the background..." and no reason. Walk up to the
  // next free port instead of dying; the caller reads config.port back out, so
  // every URL printed afterwards is the one we actually bound.
  //
  // EXCEPTION: if the thing already on the port is a HEALTHY openzoo proxy,
  // reuse it rather than starting a rival that splits spend across two wallets.
  const wanted = config.port;
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const onErr = (e) => { server.removeListener('error', onErr); reject(e); };
        server.on('error', onErr);
        server.listen(config.port, bindHost, () => { server.removeListener('error', onErr); resolve(); });
      });
      break;
    } catch (e) {
      if (e?.code !== 'EADDRINUSE' || attempt >= 12) throw e;
      if (attempt === 0) {
        try {
          const probe = await fetch(`http://127.0.0.1:${config.port}/v1/models`, { signal: AbortSignal.timeout(2500) });
          if (probe.ok) {
            say(`openzoo: a healthy proxy is already on :${config.port} — reusing it`);
            return { server: null, client, reused: true, port: config.port, spent: () => 0, publicUrl: null, tunnelToken: null, tunnelError: null };
          }
        } catch { /* not ours, or wedged — take the next port */ }
      }
      config.port += 1;
      say(`openzoo: :${config.port - 1} busy — trying :${config.port}`);
    }
  }
  if (config.port !== wanted) say(`openzoo: listening on :${config.port} (:${wanted} was busy)`);

  // AUTO-PREPAY. Paying on-chain per call is where the latency lives: the
  // gateway answers its 402 challenge in ~0.12s while a full settled call
  // MEASURED 9-37s end to end. Credit is applied automatically server-side
  // whenever a balance covers the quote, so buying it once makes every later
  // call skip verify+settle entirely.
  //
  // Runs in the background — never block the listener on a payment — and only
  // when this wallet actually has funds, so a fresh/empty wallet is untouched.
  // Opt out with OPENZOO_NO_AUTOTOPUP=1; size it with OPENZOO_AUTOTOPUP_USD.
  if (!process.env.OPENZOO_NO_AUTOTOPUP) {
    // Keep credit topped up, forever, from whatever the wallet holds.
    //
    // The first version ran ONCE at startup and bought a fixed $5, so funding
    // the wallet later did nothing at all — the user sent TOKEN and kept
    // paying on-chain per call. This checks on an interval and spends what the
    // wallet can actually cover, priced by the gateway's own live quote (so
    // TOKEN is valued exactly as it settles).
    const FLOOR = Number(process.env.OPENZOO_AUTOTOPUP_FLOOR || 2);
    const EVERY = Number(process.env.OPENZOO_AUTOTOPUP_EVERY_MS || 60_000);
    let topping = false;
    const tick = async () => {
      if (topping) return;
      topping = true;
      try {
        const { creditBalance, topUp, affordableUsd } = await import('./info.js');
        const have = await creditBalance();
        if (have >= FLOOR) return;
        const can = await affordableUsd();
        if (can < 1) return;             // nothing to convert; stay quiet
        say(`credit $${have.toFixed(4)} below $${FLOOR} — wallet covers ~$${can.toFixed(2)}, topping up`);
        await topUp('all');
      } catch (e) {
        say(`auto top-up skipped: ${String(e.message || e).slice(0, 120)}`);
      } finally {
        topping = false;
      }
    };
    tick();
    const timer = setInterval(tick, EVERY);
    timer.unref?.();   // never hold the process open just for this
  }

  if (!silent) {
    // VERSION IN THE BANNER, deliberately. `npx openzoo` can serve a STALE
    // cached copy — npx reuses a cache entry that matches the bare spec, so a
    // user running the newest published version still gets old behaviour and
    // no clue why (observed: a missing tunnel and a missing token row, both
    // "fixed" releases ago). Printing the version makes that one glance.
    const { version } = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    console.log(`openzoo v${version}  ->  ${config.apiBase}`);
    console.log(`listening on   http://localhost:${config.port}/v1`);
    // LAND THEM IN THE APP. `npx openzoo` in a human terminal opens the chat
    // GUI — a stranger's first 8 seconds should be a working chat, not a URL
    // to notice. Never in CI/agents (no TTY), never twice, opt out with
    // OPENZOO_NO_OPEN=1.
    if (process.stdout.isTTY && !process.env.OPENZOO_NO_OPEN) {
      const opener = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'start' : 'xdg-open';
      import('node:child_process').then(({ exec }) =>
        exec(`${opener} http://localhost:${config.port}/`, () => {}));
    }
    console.log('');
    if (client.walletCreated) console.log(`new burner wallet created at ${client.walletPath} (chmod 600)`);
    console.log(`wallet (fund me) · solana: ${client.address}`);
    if (client.evmAddress) console.log(`wallet (fund me) · evm (base / robinhood): ${client.evmAddress}`);
    try {
      lastSnap = await snapshotBalances(client);
      console.log(`balance: ${balanceLine(lastSnap) || '(no RPC reachable — advisory only)'}`);
      if (!lastSnap.some((b) => b.ui > 0)) {
        console.log(`fund it: ${fundingLine('the address above')} — a few cents goes a long way.`);
      }
    } catch { /* RPC hiccup: balance is advisory */ }
    // LIVE REFRESH: the startup line goes stale the moment a call settles or
    // the user funds mid-session. Poll on an interval (and shortly after each
    // paid call), print ONLY on change, and call out arrivals explicitly so
    // "did my top-up land?" answers itself in the running log.
    refreshBalances = async () => {
      try {
        const snap = await snapshotBalances(client);
        if (!snap.length) return;
        const prev = new Map((lastSnap || []).map((b) => [`${b.chain}:${b.symbol}`, b.ui]));
        const changed = snap.some((b) => Math.abs((prev.get(`${b.chain}:${b.symbol}`) ?? 0) - b.ui) > 1e-9)
          || snap.length !== (lastSnap || []).length;
        if (!changed) return;
        if (lastSnap) {
          for (const b of snap) {
            const gain = b.ui - (prev.get(`${b.chain}:${b.symbol}`) ?? 0);
            if (gain > 1e-9) console.log(`funding arrived: +${gain.toFixed(6)} ${b.symbol}${b.chain !== 'solana' ? ` (${b.chain})` : ''}`);
          }
        }
        lastSnap = snap;
        console.log(`balance: ${balanceLine(snap)}`);
      } catch { /* advisory — never noisy on RPC trouble */ }
    };
    const pollSecs = Number(process.env.OPENZOO_BALANCE_POLL_SECS ?? 45);
    if (pollSecs > 0) {
      const timer = setInterval(refreshBalances, pollSecs * 1000);
      timer.unref?.();
    }
    // Which rails the zoo will actually settle right now, straight off a live
    // 402 — so nobody funds a lane the resource is not currently offering.
    try {
      const rails = await liveRails();
      if (rails) {
        console.log(`rails live now: ${rails.live.join(' · ')}`);
        // Funding advice is derived from those rails, never hardcoded — the
        // zoo can add a chain without this package shipping again.
        const hint = railFundingHint(rails.live);
        if (hint) console.log(`fund with:      ${hint}`);
        // The exact contracts those symbols mean — every chain has impersonator
        // mints, so a symbol without its CA is an invitation to fund the wrong one.
        for (const row of railFundingAddresses(rails.live)) {
          row.assets.forEach((a, i) => {
            const label = i === 0 ? row.label : '';
            console.log(`  ${label.padEnd(16)} ${a.symbol.padEnd(11)} ${a.address}${a.note ? `  (${a.note})` : ''}`);
          });
        }
        const unfundable = unfundableRails(rails.live);
        if (unfundable.length) {
          const fundable = rails.live.filter((r) => RAIL_FUNDING[r]?.assets.length).map((r) => RAIL_FUNDING[r].label);
          const instead = fundable.length ? `pay from ${fundable.join(' or ')} instead` : 'no fundable rail is offered right now';
          console.log(`note:           ${unfundable.join(' / ')} is offered by the zoo but not fundable from a plain balance here — ${instead}.`);
        }
        if (rails.dark.length) {
          const rh = rails.dark.includes('robinhood') ? ' — robinhood also needs OPENZOO_ENABLE_RH=1' : '';
          console.log(`rails implemented but not offered by the zoo right now: ${rails.dark.join(' · ')}${rh}`);
        }
      }
    } catch { /* quote probe is advisory */ }
    console.log('');
    console.log('point any OpenAI-compatible harness at:');
    console.log(`  base_url = http://localhost:${config.port}/v1`);
    console.log('  api_key  = sk-openzoo   (any value works; the zoo takes payment, not keys)');
  }

  // AUTO-TUNNEL: `npx openzoo` must be end-to-end for cloud IDEs too — their
  // servers cannot dial localhost, so the default command also publishes a
  // quick-tunnel URL. It comes up in the background (never delays localhost),
  // failure degrades to local-only, and public traffic is gated above by
  // token + its own spend ceiling. OPENZOO_NO_TUNNEL=1 opts out.
  if (autoTunnel && process.env.OPENZOO_NO_TUNNEL !== '1') {
    (async () => {
      try {
        const { ensureCloudflared, startCloudflared, mintToken } = await import('./tunnel.js');
        const token = mintToken();
        const cap = process.env.OPENZOO_TUNNEL_MAX_USD ? Number(process.env.OPENZOO_TUNNEL_MAX_USD) : Infinity;
        const bin = await ensureCloudflared((m) => log(m));
        const { url, proc } = await startCloudflared(bin, config.port, log);
        tunnelGate = { token, sessionMaxUsd: cap, publicUrl: url };
        const bye = () => { try { proc.kill('SIGTERM'); } catch { /* already gone */ } };
        process.once('SIGINT', () => { bye(); process.exit(0); });
        process.once('SIGTERM', () => { bye(); process.exit(0); });
        process.once('exit', bye);
        log('');
        log('cloud IDE / remote harness? use the public URL (they cannot reach localhost):');
        log(`  base_url = ${url}/v1`);
        log(`  api_key  = ${token}`);
        log(`  (key REQUIRED on the public URL — it spends this wallet; ${Number.isFinite(cap) ? `capped at $${cap.toFixed(2)}/session` : 'NO session cap — OPENZOO_TUNNEL_MAX_USD adds one'},`);
        log('   OPENZOO_NO_TUNNEL=1 for localhost-only)');
      } catch (err) {
        // Record it: a caller polling for publicUrl (openzoo cursor) would
        // otherwise spin the full timeout on a tunnel that already died, with
        // silent:true swallowing this very message.
        tunnelError = err.message;
        log(`public URL unavailable (${err.message}) — localhost still works; OPENZOO_NO_TUNNEL=1 hides this line`);
      }
    })();
  }
  // Expose live tunnel details so a caller that starts the proxy in-process
  // (openzoo cursor/vscode) can surface the public URL + key instead of the
  // user hunting for them. Getters, because the tunnel resolves ASYNC after
  // this returns — a snapshot would always be null.
  return {
    server,
    client,
    spent: () => sessionSpent,
    get publicUrl() { return tunnelGate?.publicUrl ?? null; },
    get tunnelToken() { return tunnelGate?.token ?? null; },
    get tunnelError() { return tunnelError; },
  };
}
