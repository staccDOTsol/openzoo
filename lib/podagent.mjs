// Pod agent — runs INSIDE our box. It IS the Grok Bot sandbox brain, on the
// ports the app expects (1337 agent, 6080 vnc, 1340 local-exec), but the brain
// is openzoo (x402-paid) and the sandbox is ours.
//
// PROTOCOL, REVERSE-ENGINEERED FROM local-exec-daemon/main.cjs (2026-08-16):
//   GET  /local-exec/requests   the daemon opens an SSE stream to RECEIVE frames
//   POST /local-exec/responses   the daemon SENDS frames: hello, ping, output,
//                                stdout, result, exit
//   frames the daemon RECEIVES (we push down the SSE):
//     {kind:"welcome", providerId}
//     {kind:"exec", requestId, approvalId, serverMessage:{shellArgs:{command,
//        workingDirectory, timeout}}}   (serverMessage = agent.v1.ExecServerMessage,
//        shellArgs = agent.v1.ShellArgs; the daemon assigns id itself)
//     {kind:"upload"|"download"|"cancel", ...}
//   exec is APPROVAL-GATED on the user's Mac (isLocalUseBlocked / supervised).
//
// So: the daemon runs commands on the USER's machine (variant "sand",
// localRoot=/Users/…), and WE — from the box — decide what to run, paying for
// the reasoning via openzoo. That is the whole product: a Grok-Bot-shaped agent
// whose brain is the zoo.

import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  formatPayStatus, startModelWait, readWithIdleTimeout, STREAM_IDLE_MS,
  createRaceFeed, pickRaceWinner, parseClassifyScore, RACE_MIN_SCORE,
  isRaceCountable, raceLastShip, shouldRetryRaceArrival, raceFailKind,
  summarizeRaceFailures,
} from './livestatus.js';
import { homedir } from 'node:os';

const PORTS = (process.env.OZ_AGENT_PORTS || '1337,6080,1340,6081')
  .split(',').map((s) => Number(s.trim())).filter(Boolean);
const LOG = process.env.OZ_AGENT_LOG || '/var/log/openzoo/agent.jsonl';
export const PROXY = process.env.OZ_PROXY || 'http://127.0.0.1:8402/v1';
export const MODEL = process.env.OZ_BRAIN_MODEL || 'deepseek/deepseek-v4-pro-0813';
const MAX_STEPS = Number(process.env.OZ_MAX_STEPS || 10);

// Matches the Grok Bot chat surface itself (dark canvas, right-aligned grey
// user pills, pink-avatar left-aligned replies, pill input bar with + / mic) —
// this renders INSIDE Grok Bot's own sandbox panel (its sidebar/titlebar are
// the app's own chrome, not ours), so only the message canvas needs to match.
export const VNC_CHAT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>openzoo box</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #000; }
  body { color: #ececec; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         display: flex; flex-direction: column; }
  #log { flex: 1; overflow-y: auto; padding: 28px 24px 12px; display: flex; flex-direction: column; gap: 6px; }
  .hdr { align-self: flex-start; display: flex; align-items: center; gap: 6px; margin: 12px 0 4px;
         color: #8e8e93; font-size: 13px; }
  .hdr .avatar { width: 18px; height: 18px; border-radius: 5px; }
  .hdr .avatar svg { width: 10px; height: 10px; }
  .row { display: flex; max-width: 78%; margin: 2px 0; }
  .row.user { align-self: flex-end; }
  .row.bot { align-self: flex-start; }
  .avatar { width: 30px; height: 30px; border-radius: 8px; flex: 0 0 30px; background: #e91e8c;
            display: flex; align-items: center; justify-content: center; }
  .avatar svg { width: 16px; height: 16px; }
  .bubble { padding: 11px 16px; border-radius: 20px; white-space: pre-wrap; word-break: break-word; }
  .row.user .bubble { background: #57575c; }
  .row.bot .bubble { background: #262626; color: #ececec; }
  .row.bot.pending .bubble { color: #8e8e93; }
  .dots span { display: inline-block; width: 5px; height: 5px; margin-right: 3px; border-radius: 50%;
               background: #8e8e93; animation: blink 1.2s infinite ease-in-out; }
  .dots span:nth-child(2) { animation-delay: .2s; } .dots span:nth-child(3) { animation-delay: .4s; }
  @keyframes blink { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }
  #bar { padding: 10px 16px 18px; }
  #row-input { display: flex; align-items: center; gap: 8px; }
  #pill { flex: 1; display: flex; align-items: center; gap: 6px; background: #2c2c2e; border-radius: 26px;
          padding: 8px 10px 8px 14px; }
  .icon-btn { width: 32px; height: 32px; border-radius: 50%; border: none; background: transparent;
              color: #ececec; display: flex; align-items: center; justify-content: center; cursor: pointer;
              flex: 0 0 32px; }
  .icon-btn:hover { background: #3a3a3c; }
  .icon-btn svg { width: 18px; height: 18px; }
  #inp { flex: 1; background: transparent; border: none; color: #ececec; font: inherit;
         padding: 6px 0; min-width: 0; }
  #inp::placeholder { color: #8e8e93; }
  #inp:focus { outline: none; }
  #send { width: 34px; height: 34px; border-radius: 50%; border: none; background: #fff; color: #000;
          display: none; align-items: center; justify-content: center; cursor: pointer; flex: 0 0 34px; }
  #send.show { display: flex; }
  #send svg { width: 16px; height: 16px; }
</style></head>
<body>
  <div id="log"></div>
  <div id="bar">
    <div id="row-input">
      <div id="pill">
        <button class="icon-btn" tabindex="-1">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <input id="inp" placeholder="Message openzoo" autofocus>
        <button class="icon-btn" tabindex="-1">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/></svg>
        </button>
      </div>
      <button id="send">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M6 11l6-6 6 6"/></svg>
      </button>
    </div>
  </div>
<script>
  const log = document.getElementById('log');
  const inp = document.getElementById('inp');
  const send = document.getElementById('send');
  const AVATAR = '<svg viewBox="0 0 24 24" fill="none"><path d="M6 10c0-1 1-2 2-1l2 2 2-2c1-1 2 0 2 1v2c0 2-2 3-4 3s-4-1-4-3v-2z" fill="#fff"/></svg>';
  let lastWho = null;
  function addRow(who, text) {
    if (who === 'bot' && lastWho !== 'bot') {
      const hdr = document.createElement('div');
      hdr.className = 'hdr';
      hdr.innerHTML = '<span class="avatar">' + AVATAR + '</span><span>openzoo</span>';
      log.appendChild(hdr);
    }
    lastWho = who;
    const row = document.createElement('div');
    row.className = 'row ' + who + (text === null ? ' pending' : '');
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = text === null ? '<span class="dots"><span></span><span></span><span></span></span>' : '';
    if (text !== null) bubble.textContent = text;
    row.appendChild(bubble);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return { row, bubble };
  }
  async function submit() {
    const task = inp.value.trim();
    if (!task) return;
    inp.value = '';
    send.classList.remove('show');
    inp.disabled = true;
    addRow('user', task);
    const pending = addRow('bot', null);
    try {
      const r = await fetch('/drive', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task }),
      });
      const j = await r.json();
      pending.row.classList.remove('pending');
      pending.bubble.textContent = j.text || '(no response)';
    } catch (e) {
      pending.row.classList.remove('pending');
      pending.bubble.textContent = 'error: ' + e.message;
    }
    inp.disabled = false; inp.focus();
  }
  inp.addEventListener('input', () => { send.classList.toggle('show', inp.value.trim().length > 0); });
  send.addEventListener('click', submit);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
</script>
</body></html>`;

function record(entry) {
  try { appendFileSync(LOG, JSON.stringify(entry) + '\n'); } catch { /* best effort */ }
  console.log(`[agent:${entry.port ?? '-'}] ${entry.method || entry.ev} ${entry.path || ''} ${entry.bodyBytes ?? ''}${entry.frames ? ' frames=' + entry.frames : ''}`);
}

// ------------------------------------------------------------------ frames --

/** Send frames to the daemon down its SSE. The daemon reads the stream with a
 *  TextDecoder and parses per-line JSON, so one frame per `data:` line. We wrap
 *  as {frames:[…]} to mirror the response side; a bare frame is the fallback. */
function sseSend(res, frame) {
  const line = `data: ${JSON.stringify({ frames: [frame] })}\n\n`;
  try { res.write(line); return true; } catch { return false; }
}

function execFrame(command, cwd = '/tmp') {
  return {
    kind: 'exec',
    requestId: randomUUID(),
    approvalId: randomUUID(),
    // agent.v1.ExecServerMessage as protobuf-es JSON (camelCase). The daemon
    // assigns `id`; we only supply the shell variant.
    serverMessage: { shellArgs: { command, workingDirectory: cwd, timeout: 120 } },
  };
}

// ------------------------------------------------------------------- brain --

// deepseek-v4-pro-0813 (the default MODEL) doesn't expose modality info via
// /v1/models, and it's not something we can verify blind — rather than gamble
// on a text-only model silently ignoring pasted images, any message with
// multimodal (image_url) content routes to a model KNOWN to support vision.
const VISION_MODEL = process.env.OZ_VISION_MODEL || 'anthropic/claude-sonnet-5';
// Output budget per turn. Reasoning models spend this on their chain of
// thought BEFORE emitting any content, so a budget that is merely "enough for
// the answer" produces no answer at all on a hard prompt.
const MAX_TOKENS = Number(process.env.OZ_MAX_TOKENS || 4096);
const msgHasImage = (m) => Array.isArray(m.content) && m.content.some((c) => c?.type === 'image_url');

// How far back an image still counts as "being discussed". Beyond this the
// thread drops back to the cheaper text model.
const VISION_WINDOW = Number(process.env.OZ_VISION_WINDOW || 8);

// This used to scan the WHOLE history, so a single pasted image pinned every
// later turn in that thread to the vision model forever — permanently, and
// invisibly, at 1.5x input and 2.5x output (claude-sonnet-5 $6/$30 per M vs
// deepseek-v4-pro $3.96/$11.88, priced live off /v1/models). A thread where
// someone shared one screenshot an hour ago was still paying vision rates for
// pure text chat.
function hasImages(messages) {
  return messages.slice(-VISION_WINDOW).some(msgHasImage);
}

// When we DO fall back to the text model, the old image_url blocks must not go
// with it — a non-vision model either errors on them or silently ignores them
// while still being billed for the payload. Replace them with a marker so the
// model knows an image was there rather than seeing a gap it might deny.
function stripImages(messages) {
  return messages.map((m) => {
    if (!msgHasImage(m)) return m;
    const text = m.content.filter((c) => c?.type === 'text').map((c) => c.text).join(' ').trim();
    return { ...m, content: `${text}${text ? ' ' : ''}[image sent earlier, no longer in context]` };
  });
}

// A non-ok response with no usable content used to silently become '', which
// grokui.mjs then renders as a generic "(no response)" — indistinguishable
// from a model that genuinely had nothing to say. Callers should know WHY.
async function httpErrorNote(status) {
  if (status === 402) {
    // print the ACTUAL address in the chat, not a link elsewhere to go find it.
    // fetch() does NOT reject on 4xx/5xx, so an older proxy without /wallet
    // returns an error body that parses fine and yields "undefined" fields —
    // check r.ok and the fields themselves before interpolating them.
    try {
      const r = await fetch(`${PROXY}/wallet`);
      const w = r.ok ? await r.json() : null;
      if (w?.funding && w?.evm) {
        // funded === false is the genuinely-empty case; funded === true after
        // the retries above means the rail/quote failed, not the balance
        if (w.funded === false) {
          return `(payment failed — HTTP 402, the wallet is empty. ${w.funding}. EVM (Base/Robinhood): ${w.evm}.)`;
        }
        return `(payment failed — HTTP 402 after ${PAYMENT_RETRIES} retries, though the wallet holds ${w.balances || 'a balance'}. Send it again; if it keeps failing the quoted asset may not be convertible right now. Fund with: ${w.funding})`;
      }
    } catch { /* proxy unreachable — fall through to the generic note */ }
    return `(payment failed — HTTP 402 after ${PAYMENT_RETRIES} retries. Run \`npx openzoo\` to check wallet balances.)`;
  }
  if (status === 429) return '(rate limited — HTTP 429, try again in a moment)';
  if (status >= 500) return `(upstream error — HTTP ${status}, try again)`;
  return status ? `(request failed — HTTP ${status})` : '';
}

// A 402 that reached this layer means the proxy's own x402 retry gave up on
// this attempt, but the NEXT attempt usually settles (measured: same wallet,
// same rail, second call pays fine). Surfacing that as a chat message makes
// the user do the retry by hand — so do it here instead.
const PAYMENT_RETRIES = 3;
/**
 * ADAPTIVE top_k. We have learned this one the expensive way already.
 *
 * On leCore the miss was never the ranker — BM25 ranked correctly. It was
 * top_k=16 against a 7,000-chunk corpus: we only ever ASKED for sixteen. Same
 * shape here, and worse: grokui never set the header at all, so every call fell
 * to the gateway default of EIGHT, while a whole project's bots write into one
 * shared context. Six bots working for an hour and the model sees eight chunks
 * of it.
 *
 * So scale with the corpus instead of picking a number. sqrt keeps it sane at
 * both ends — 100 chunks -> 20, 1k -> 63, 7k -> 167, and it saturates at the
 * gateway's 256 ceiling rather than growing without bound. Floor of 16 so a
 * brand-new thread is never worse off than the old default.
 *
 * Cost is real and proportional (measured on leCore: top_k 16 = $0.0070,
 * top_k 128 = $0.0489 on the same question) — which is the point. The extra
 * spend IS the extra corpus actually being read.
 */
export function adaptiveTopK(boundItems) {
  const n = Math.max(0, Number(boundItems) || 0);
  return Math.max(16, Math.min(256, Math.ceil(Math.sqrt(n) * 2)));
}

async function postChat(body, contextId, topK, onStatus, signal) {
  void contextId; // spill path: never send as x-hrr-context
  let r;
  for (let attempt = 0; attempt <= PAYMENT_RETRIES; attempt++) {
    if (signal?.aborted) {
      const err = new Error(signal.reason?.message || 'aborted');
      err.name = 'AbortError';
      throw err;
    }
    r = await fetch(`${PROXY}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', authorization: 'Bearer sk-openzoo',
        // Only sent when we actually know the corpus size; without it the
        // gateway keeps its own default rather than getting a made-up number.
        ...(topK ? { 'x-hrr-top-k': String(topK) } : {}),
        // Do NOT attach x-hrr-context. proxy.js maybeCacheCorpus bails
        // (`if (req.headers['x-hrr-context']) return null`) so Claude CLI's
        // bind-prefix / send-3/131-turns never ran for grokui. Tetris then
        // shipped ~850k chars × race of 4 and every model failed in ~22s.
        // Completions must hit the same sidecar spill path as `npx openzoo claude`.
        // bindThread stays for other things; contextId is kept on the signature
        // so brain / brainStream callers do not change.
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (r.status !== 402 || attempt === PAYMENT_RETRIES) return r;
    // A 402 retry used to be silent — grokui sat on mute "…" for the whole
    // settle. Tell the watcher this attempt is paying, not wedged.
    onStatus?.(formatPayStatus(attempt));
    await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
  }
  return r;
}

/** One openzoo chat turn. Paid per call by the box's own wallet via the local
 *  proxy — no key, no account. */
// Which model actually serves a turn is decided HERE, not by the caller: a
// thread carrying an image routes to VISION_MODEL. A system prompt written
// once at thread creation therefore cannot name it correctly, and a bot left
// to guess asserts whatever its training prior says — MEASURED: a Claude-served
// turn insisted it was Claude while the app's default is DeepSeek, and burned
// several paid turns arguing. So the prompt carries a placeholder and the real
// id is substituted at call time, per turn.
function withModelId(messages, model) {
  return messages.map((m) => (m.role === 'system' && typeof m.content === 'string' && m.content.includes('__OZ_MODEL__')
    ? { ...m, content: m.content.replaceAll('__OZ_MODEL__', model) }
    : m));
}

export async function brain(messages, contextId, modelOverride, topK, signal) {
  // explicit plugins, not relying on the gateway's "inject when caller said
  // nothing" default — an explicit array is always respected as-is, so every
  // bot on every model actually has web search. max_tokens 900 was cutting
  // real (especially web-search-backed) answers off mid-sentence.
  //
  // modelOverride is what "/model <id>" sets per thread. VISION still wins
  // when the conversation actually contains images: a text-only model handed
  // image parts just errors, so silently honouring the override there would
  // turn a working thread into a broken one.
  const vision = hasImages(messages);
  const model = vision ? VISION_MODEL : (modelOverride || MODEL);
  messages = vision ? messages : stripImages(messages);
  const r = await postChat(
    { model, max_tokens: 4096, messages: withModelId(messages, model), plugins: [{ id: 'web' }] },
    contextId, topK, undefined, signal,
  );
  const j = await r.json().catch(() => ({}));
  const content = j?.choices?.[0]?.message?.content;
  // Same truncation catch as the streaming path (see brainStream): a reply that
  // stops because the budget ran out is not a finished reply, and this path is
  // what non-streaming callers — including every SPAWNed subagent — go through.
  if (content && j?.choices?.[0]?.finish_reason === 'length') {
    const rest = await brainContinue(messages, content, contextId, modelOverride, 0);
    return content + rest;
  }
  return content || (r.ok ? '' : await httpErrorNote(r.status));
}

/** Resume a reply that hit the output cap, non-streaming. Bounded by
 *  CONTINUE_ROUNDS for the same runaway reason brainStream is. */
async function brainContinue(messages, sofar, contextId, modelOverride, round) {
  if (round >= CONTINUE_ROUNDS) return '';
  const vision = hasImages(messages);
  const model = vision ? VISION_MODEL : (modelOverride || MODEL);
  const next = [...messages,
    { role: 'assistant', content: sofar },
    { role: 'user', content: CONTINUE_NUDGE }];
  const r = await postChat(
    { model, max_tokens: Math.min(4096 * (2 ** (round + 1)), MAX_CONTINUE_TOKENS),
      messages: withModelId(vision ? next : stripImages(next), model), plugins: [{ id: 'web' }] },
    contextId, undefined, undefined,
  );
  const j = await r.json().catch(() => ({}));
  const more = j?.choices?.[0]?.message?.content || '';
  if (more && j?.choices?.[0]?.finish_reason === 'length') {
    return more + await brainContinue(messages, sofar + more, contextId, modelOverride, round + 1);
  }
  return more;
}

/** Same call, but streamed — invokes onDelta(text) as tokens arrive (for a
 *  live-typing UI) and resolves with the full accumulated text at the end, so
 *  callers that need to parse a directive out of the complete reply still can.
 *  onStatus(detail) is an optional second channel: paying / waiting on model /
 *  thinking, so a 20–40s settle is visibly alive instead of mute dots. */
export async function brainStream(messages, onDelta, contextId, modelOverride, maxTokens, round = 0, topK = 0, onStatus, signal) {
  const vision = hasImages(messages);
  const model = vision ? VISION_MODEL : (modelOverride || MODEL);
  messages = vision ? messages : stripImages(messages);
  const budget = maxTokens || MAX_TOKENS;
  const r = await postChat(
    { model, max_tokens: budget, messages: withModelId(messages, model), plugins: [{ id: 'web' }], stream: true },
    contextId, topK, onStatus, signal,
  );
  if (!r.ok || !r.body) {
    // fall back to the non-streaming path rather than fail outright
    const j = await r.json().catch(() => ({}));
    const content = j?.choices?.[0]?.message?.content;
    const proxied = j?.error?.message;
    const text = content || (r.ok ? '' : (proxied ? `(request failed — HTTP ${r.status}: ${proxied})` : await httpErrorNote(r.status)));
    if (text) onDelta(text);
    return text;
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', full = '', reasonedChars = 0, finish = '';
  let stopWait = startModelWait(onStatus);
  const noteThinking = () => {
    stopWait();
    onStatus?.('thinking…');
  };
  try {
    for (;;) {
      let chunk;
      try {
        chunk = await readWithIdleTimeout(reader, STREAM_IDLE_MS);
      } catch (e) {
        if (e?.code !== 'STREAM_IDLE') throw e;
        try { await reader.cancel(); } catch { /* already closed */ }
        stopWait();
        // A quiet SSE used to hang this loop forever and leave grokui on
        // thinking / "…". Prefer what we have; if we have nothing, one
        // non-stream retry rather than a mute bubble.
        if (full) {
          const note = '\n\n(stream stalled — showing what arrived before the timeout)';
          onDelta(note);
          return full + note;
        }
        onStatus?.('waiting on model…');
        const fallback = await brain(messages, contextId, modelOverride, topK, signal);
        if (fallback) onDelta(fallback);
        return fallback || '(stream timed out — no tokens arrived)';
      }
      const { value, done } = chunk;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // last line may be incomplete — keep it for next chunk
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const c = JSON.parse(payload)?.choices?.[0];
          const d = c?.delta;
          // The LAST chunk carries why generation stopped. "length" means the
          // budget ran out mid-answer — the only way to tell a finished reply
          // from a guillotined one.
          if (c?.finish_reason) finish = c.finish_reason;
          if (d?.content) {
            stopWait();
            full += d.content;
            onDelta(d.content);
          }
          // Reasoning models emit their chain of thought on a SEPARATE field and
          // only then start producing content. Count it — not to show it, but to
          // tell "the model said nothing" apart from "the model spent its whole
          // budget thinking and got cut off". Surface "thinking…" so the wait
          // is not mute dots.
          else if (d?.reasoning || d?.reasoning_content) {
            reasonedChars += (d.reasoning || d.reasoning_content).length;
            if (!full) noteThinking();
          }
        } catch { /* keep-alive line or partial JSON — ignore */ }
      }
    }
  } finally {
    stopWait();
  }

  // EMPTY CONTENT AFTER HEAVY REASONING is a truncation, not an answer. It
  // surfaced in the UI as a bare "(no response)" bubble that cost the user a
  // turn and explained nothing — on exactly the long, complex prompts where a
  // reasoning model thinks the most. Retry ONCE with a bigger budget.
  if (!full && reasonedChars > 0 && !maxTokens) {
    onStatus?.('retrying…');
    return brainStream(messages, onDelta, contextId, modelOverride, budget * 4, round, topK, onStatus, signal);
  }

  // CUT OFF MID-ANSWER. finish_reason "length" means the model had more to say
  // and the budget ended the sentence for it — seen live as a reply that stops
  // inside `for (`. Nothing above catches this, because `full` is non-empty:
  // by every other measure the turn succeeded.
  //
  // CONTINUE rather than retry. Re-running the turn with a bigger budget makes
  // the user pay twice for the half we already have (and on a reasoning model,
  // pay for the whole chain of thought again). Handing the model back its own
  // partial and asking for the rest costs only the rest.
  //
  // Bounded, because a model that ignores the nudge would otherwise continue
  // forever on the user's wallet.
  if (full && finish === 'length' && round < CONTINUE_ROUNDS) {
    const more = await brainStream(
      [...messages,
        { role: 'assistant', content: full },
        { role: 'user', content: CONTINUE_NUDGE }],
      onDelta, contextId, modelOverride,
      Math.min(budget * 2, MAX_CONTINUE_TOKENS), round + 1, topK, onStatus,
    );
    return full + (more || '');
  }
  return full;
}

// How many times a single answer may be resumed after hitting the cap. Three
// doublings off 4096 is ~57k tokens of answer, which is past any real reply and
// well short of a runaway.
const CONTINUE_ROUNDS = Number(process.env.OZ_CONTINUE_ROUNDS || 3);
const MAX_CONTINUE_TOKENS = Number(process.env.OZ_MAX_CONTINUE_TOKENS || 32768);
// Deliberately blunt about the seam: the partial usually ends mid-token, and a
// model that "helpfully" restarts the sentence produces a visible stutter in
// the middle of the user's code.
const CONTINUE_NUDGE = 'You were cut off — your previous message hit the output limit mid-way. '
  + 'Continue from EXACTLY where it stopped. Do not repeat any of it, do not summarise it, '
  + 'do not add a preamble or an apology, and do not re-open a code fence that is already open. '
  + 'Resume mid-word if that is where it ended.';

// ---------------------------------------------------------------------------
// MODEL TIERS  ·  cheap / medium / expensive
// ---------------------------------------------------------------------------
// Ranking the live catalog by price alone picks garbage at both ends: the most
// expensive served model is o1-pro at $1800/Mtok (a bad coding model that would
// drain the box wallet in a handful of turns), and the cheapest is a roleplay
// finetune. Price is a proxy for capability only within a band, never across
// the whole catalog. So each tier is a CURATED, ordered preference list, and
// the catalog is used to check what is actually served today — the zoo's model
// list changes under us, and a tier that resolves to a 404 is worse than no
// tier at all.
//
// Each list is ordered best-first (that is what a non-racing "auto" picks) but
// deliberately WIDE, because a race samples from it at random: a pool of three
// would race the same three models every time, which is neither a real hedge
// against a single provider having a bad minute nor a real sample of the tier.
// Prices in the comments are completion USD per Mtok as served, measured.
const TIERS = {
  // ≲ $3/Mtok. Fast, good enough for glue work, cheap enough to race widely.
  cheap: [
    'deepseek/deepseek-v4-flash',        // 0.45
    'meta-llama/llama-4-scout',          // 0.90
    'z-ai/glm-4.7-flash',                // 1.20
    'bytedance-seed/seed-2.0-mini',      // 1.20
    'meta-llama/llama-4-maverick',       // 2.40
    'z-ai/glm-4.5-air',                  // 2.55
    'minimax/minimax-m2.5',              // 2.70
    'z-ai/glm-4.6v',                     // 2.70
    'minimax/minimax-m2',                // 3.06
    'inclusionai/ling-3.0-flash',        // 0.19
  ],
  // ~$4.5–11/Mtok. The default band; deepseek-v4-pro is the app default.
  medium: [
    'deepseek/deepseek-v4-pro-0813',     // 5.94
    'z-ai/glm-4.7',                      // 5.25
    'google/gemini-3.7-flash',           // 5.63
    'x-ai/grok-4.3',                     // 7.50
    'moonshotai/kimi-k2.7-code',         // 10.50
    'z-ai/glm-5',                        // 5.76
    'moonshotai/kimi-k2.6',              // 7.08
    'mistralai/mistral-large-2512',      // 4.50
    'bytedance-seed/seed-2.0-code',      // 9.00
    'qwen/qwen3.8-27b',                  // 9.60
  ],
  // ≥ $18/Mtok. Frontier. NOTE the ceiling: o1-pro ($1800) and the *-pro tiers
  // ($240–540) are deliberately NOT here. A race of four across that band can
  // cost dollars per turn on a box funded with a few cents.
  expensive: [
    'anthropic/claude-opus-5',           // 75
    'openai/gpt-5.5',                    // 90
    'anthropic/claude-sonnet-5',         // 30
    'x-ai/grok-4.6',                     // 18
    'moonshotai/kimi-k3',                // 45
    'anthropic/claude-opus-4.8',         // 75
    'openai/gpt-5.4',                    // 45
    'qwen/qwen3.8-max',                  // 18
    'x-ai/grok-4.5',                     // 18
  ],
  // Dedicated grok 4.6 band (tweeted as its own dial next to cheap/medium/expensive).
  // One slug cannot fill a 4-wide race without replacement, so the pool is grok
  // chat models with 4.6 first. No imagine / stt / tts / video.
  'grok4.6': [
    'x-ai/grok-4.6',
    'x-ai/grok-4.5',
    'x-ai/grok-4.3',
    'x-ai/grok-4.20',
  ],
};
export const TIER_NAMES = Object.keys(TIERS);
export const TIER_ALIASES = {
  grok: 'grok4.6',
  'grok 4.6': 'grok4.6',
  'grok-4.6': 'grok4.6',
  'grok4.6': 'grok4.6',
};
export function normalizeTier(s) {
  const raw = String(s || '').trim().toLowerCase();
  if (TIER_NAMES.includes(raw)) return raw;
  if (TIER_ALIASES[raw]) return TIER_ALIASES[raw];
  const compact = raw.replace(/[\s_]/g, '');
  if (TIER_NAMES.includes(compact)) return compact;
  if (TIER_ALIASES[compact]) return TIER_ALIASES[compact];
  return null;
}

let catalogCache = { at: 0, ids: null };
async function servedIds() {
  // 5 minutes: long enough that a race does not re-fetch per model, short
  // enough that a model coming back after an outage is picked up the same
  // session.
  if (catalogCache.ids && Date.now() - catalogCache.at < 300_000) return catalogCache.ids;
  try {
    const r = await fetch(`${PROXY}/models`);
    const j = await r.json();
    const ids = new Set((j?.data || []).map((m) => m.id).filter(Boolean));
    if (ids.size) catalogCache = { at: Date.now(), ids };
  } catch { /* proxy down — fall through to whatever we had, or null */ }
  return catalogCache.ids;
}

/**
 * The models a tier resolves to right now, only ones actually served.
 *
 * `random` is what a race uses: pick n from the whole tier at random rather
 * than always the top n. Two reasons it must be random and not top-n — a fixed
 * trio is not a hedge (they can share an upstream having a bad minute, which is
 * precisely the failure racing is meant to survive), and it silently reduces a
 * ten-model tier to three models the user never chose.
 *
 * Falls back to the curated list unchecked if the catalog is unreachable — a
 * stale-but-plausible id beats refusing to answer.
 */
export async function tierModels(tier, n = 1, random = false) {
  const want = TIERS[tier] || TIERS.medium;
  const ids = await servedIds();
  const live = ids ? want.filter((m) => ids.has(m)) : want;
  const pool = live.length ? live : want;
  const take = Math.max(1, Math.min(n, pool.length));
  if (!random) return pool.slice(0, take);
  // Fisher-Yates on a copy: sampling without replacement, because racing a
  // model against itself buys nothing and still bills twice.
  const a = pool.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, take);
}

/**
 * Launch N models at once, judge the FIRST K that come back.
 *
 * "/race 2 3" — start three, and the moment two of them have returned a real
 * answer, judge those two and ship the winner. The third is abandoned mid-flight.
 *
 * This is the useful shape, and it is neither of the obvious two:
 *   - first-past-the-post (K=1) optimises latency only, and on a hard question
 *     it rewards whichever model thought LEAST.
 *   - wait-for-all-then-judge (K=N) buys quality with the slowest entrant's
 *     latency, and one wedged provider stalls the whole turn.
 * Taking the first K bounds the wait at the Kth-fastest while still giving the
 * judge something to compare. The straggler is exactly the entrant you were
 * least likely to want anyway.
 *
 * Reliability comes free with it: empty completions and provider 5xx are
 * per-model and uncorrelated, which is why "the model returned nothing 4 times"
 * was never fixable by a fourth try at the same model. An empty reply does NOT
 * count toward K — otherwise the fastest model to FAIL would decide the race,
 * the exact bug this exists to fix.
 *
 * Live tokens: the fastest still-alive entrant is forwarded into onDelta as
 * they arrive (not swallowed). When a winner is picked, if it is that live
 * stream the bubble keeps going; if it is someone else the bubble is replaced
 * once (`onDelta(text, { replace: true })`), not left on mute dots.
 *
 * After the first X land, a cheap classify call scores each of those X
 * (correctness, completeness, actually did the asked thing — a RUN:/DONE:
 * directive is success, not a flaw). Highest score that clears the bar wins;
 * a tie is pairwise-broken. If nobody clears, the last of the X is shipped
 * anyway. If X never fills (every entrant empty/5xx/fetch-failed), ship a
 * race-level error — never a single model's `(name failed: fetch failed)` as
 * if it won. Never blank, never hang.
 *
 * Every entrant is paid for, including the abandoned one — this trades money
 * for latency and quality, which is why it is opt-in and capped.
 *
 * `hooks` is for tests: `{ stream, classify, pairwise, minScore }`.
 */
export async function brainRace(messages, onDelta, contextId, models, need = 1, maxTokens, onStatus, hooks = {}) {
  const stream = hooks.stream || brainStream;
  const classify = hooks.classify || classifyRaceAnswer;
  const pairwise = hooks.pairwise || pairwiseTied;
  const minScore = hooks.minScore != null ? Number(hooks.minScore) : RACE_MIN_SCORE;
  const list = (models || []).filter(Boolean).slice(0, RACE_MAX);
  if (list.length < 2) return stream(messages, onDelta, contextId, list[0], maxTokens, 0, 0, onStatus);
  const want = Math.max(1, Math.min(Number(need) || 1, list.length));

  const feed = createRaceFeed(onDelta, onStatus, want);
  feed.start();

  const done = [];
  const arrivals = [];
  let finished = 0;
  let release;
  const enough = new Promise((r) => { release = r; });
  const raceAbort = new AbortController();
  if (hooks.signal) {
    if (hooks.signal.aborted) raceAbort.abort(hooks.signal.reason);
    else hooks.signal.addEventListener('abort', () => raceAbort.abort(), { once: true });
  }

  const noteRace = (arr) => {
    try {
      hooks.onArrivals?.(arr);
      const line = JSON.stringify({
        at: new Date().toISOString(),
        fail: summarizeRaceFailures(arr),
        n: arr.length,
        kinds: arr.map((a) => raceFailKind(a)),
      });
      appendFileSync(`${homedir()}/.openzoo/grokui-race.log`, line + '\n');
    } catch { /* diagnostic only */ }
  };

  const ship = (cand) => {
    const out = cand && String(cand.text || '').trim() ? cand : raceLastShip(arrivals);
    feed.settle(out);
    noteRace(arrivals);
    try { raceAbort.abort(); } catch { /* already */ }
    return out.text;
  };

  // Do not pass onStatus into each entrant — their "waiting on model…" would
  // clobber the race line. Race owns the status until a winner ships.
  // fetch-failed / empty / 5xx are retried ONCE on the same slot — tetris was
  // shipping every-model-failed after a single ~22s fetch failed per racer.
  const runOne = async (m) => {
    let last = { model: m, text: '', error: 'empty body' };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (raceAbort.signal.aborted && attempt > 0) break;
      try {
        const text = await stream(messages, (chunk) => feed.onToken(m, chunk), contextId, m, maxTokens, 0, 0, undefined, raceAbort.signal);
        last = { model: m, text: text == null ? '' : String(text) };
        if (isRaceCountable(last)) {
          arrivals.push(last);
          done.push(last);
          feed.onBack();
          return;
        }
      } catch (e) {
        last = { model: m, text: '', error: e?.message || 'error' };
      }
      if (!shouldRetryRaceArrival(last) || attempt === 1 || raceAbort.signal.aborted) break;
    }
    arrivals.push(last);
    feed.onFail(m);
  };

  const attempts = list.map((m) => runOne(m).finally(() => {
    finished += 1;
    // Either we have what we asked for, or everyone is done and no more is
    // coming — without the second condition a race where two of three fail
    // would hang forever waiting for a K that can never arrive.
    if (done.length >= want || finished === list.length) release();
  }));
  // Losers keep running until ship() aborts them; swallow rejections so one
  // cannot take the process down after the winner has already been returned.
  for (const p of attempts) p.catch(() => {});

  await enough;
  // Completion order, so this really is the first X back — not the first X
  // launched. A slow 3rd never enters this set. Empty/5xx/fetch-failed stay
  // in arrivals only so an all-fail race can ship one race-level error.
  const cands = done.slice(0, want);
  if (!cands.length) return ship(raceLastShip(arrivals));
  // One real answer — nothing to compare. Ship it; do not spend a classify
  // call to rubber-stamp the only candidate.
  if (cands.length === 1) return ship(cands[0]);

  onStatus?.('judging…');
  const scored = await Promise.all(cands.map(async (c) => {
    let score = 0;
    try { score = Number(await classify(messages, c)) || 0; } catch { score = 0; }
    return { ...c, score };
  }));

  let picked = pickRaceWinner(scored, minScore);
  if (picked.reason === 'tie' && picked.tied.length > 1) {
    let broken = null;
    try { broken = await pairwise(messages, picked.tied); } catch { /* last of the tie */ }
    const usable = broken && String(broken.text || '').trim();
    // Malformed verdict / all equally bad → last finished of the tie, not empty.
    picked = { winner: usable ? broken : picked.tied[picked.tied.length - 1], reason: 'tiebreak', tied: picked.tied };
  }
  return ship(picked.winner || scored[scored.length - 1] || raceLastShip(arrivals));
}

function raceQuestion(messages) {
  const asked = [...messages].reverse().find((m) => m.role === 'user')?.content;
  return typeof asked === 'string' ? asked : '(see candidates)';
}

/**
 * Cheap structured score of ONE finished answer vs the question.
 * This is grokui's own classify call — not OpenRouter's async log-tag
 * Classifiers beta, which does not pick winners.
 */
async function classifyRaceAnswer(messages, cand) {
  const prompt = 'Score this answer to one question from 0 to 10.\n\n'
    + 'QUESTION:\n' + String(raceQuestion(messages)).slice(0, 4000) + '\n\n'
    + 'ANSWER:\n' + String(cand?.text || '').slice(0, 6000) + '\n\n'
    + 'Judge on: correctness first, then completeness, then whether it actually did what was asked '
    + '(a directive like RUN: or DONE: on one line is the correct format here, not a flaw). '
    + 'Ignore length and confidence of tone.\n'
    + 'Reply with exactly: SCORE <n>';
  const verdict = await brainStream(
    [{ role: 'user', content: prompt }], () => {}, undefined, JUDGE_MODEL, 24,
  );
  return parseClassifyScore(verdict);
}

/**
 * Pairwise break among same-score passers. Blind A/B/C so the model names
 * cannot leak the answer. Last of the tied set if the call dies.
 */
async function pairwiseTied(messages, tied) {
  const letters = tied.map((_, i) => String.fromCharCode(65 + i));
  const prompt = 'You are judging answers to one question. Pick the single best one.\n\n'
    + 'QUESTION:\n' + String(raceQuestion(messages)).slice(0, 4000) + '\n\n'
    + tied.map((c, i) => 'ANSWER ' + letters[i] + ':\n' + String(c.text || '').slice(0, 6000)).join('\n\n')
    + '\n\nJudge on: correctness first, then completeness, then whether it actually did what was asked '
    + '(a directive like RUN: or DONE: on one line is the correct format here, not a flaw). '
    + 'Ignore length and confidence of tone.\n'
    + 'Reply with ONE letter and nothing else: ' + letters.join(' or ') + '.';
  try {
    const verdict = await brainStream([{ role: 'user', content: prompt }], () => {}, undefined, JUDGE_MODEL, 8);
    const hit = String(verdict).toUpperCase().split('').find((ch) => {
      const n = ch.charCodeAt(0) - 65;
      return n >= 0 && n < tied.length;
    });
    if (hit) return tied[hit.charCodeAt(0) - 65];
  } catch { /* fall through */ }
  return tied[tied.length - 1];
}

const RACE_MAX = Number(process.env.OZ_RACE_MAX || 4);

// brainBest is GONE — brainRace(models, need) subsumes it. "wait for all N
// then judge" is exactly need === N, and keeping a second judged-race entry
// point meant two call sites that could disagree about what a race is.

// Cheapest thing that can reliably output one letter. Overridable because the
// catalog moves; if it is delisted the try/catch above falls back cleanly.
const JUDGE_MODEL = process.env.OZ_JUDGE_MODEL || 'deepseek/deepseek-v4-flash';

const SYSTEM = `You are the brain of a Grok-Bot-style coding/ops agent. The polished chat UI
the user sees is Grok Bot (Anysphere's app); its "sandbox" has been pointed at THIS box, and
your reasoning is served by openzoo (pay-per-call access to ~435 models over x402 — no API key,
no account, each call paid from a burner wallet). You are the substitute agent server.

WHERE YOUR COMMANDS RUN: each shell command you emit is pushed to a local-exec daemon running on
the USER'S OWN Mac (a supervised "sand" sandbox rooted at their home dir). Every command is
APPROVAL-GATED — the user sees and approves it before it runs. So: act on the user's real machine,
be careful, never destructive, prefer read-before-write, and explain nothing to the shell.

PROTOCOL — reply with EXACTLY one line, no prose, no code fences:
  RUN: <a single shell command>          to execute a step
  DONE: <a short natural-language answer> when the task is complete (this text is shown in the UI)
  SPAWN: <name> | <task>                 to delegate an independent subtask to a fresh subagent
  SEND: <name> | <message>               to message a subagent you (or the user) already spawned
  PING: <name>                           to check whether a subagent is still working or has finished
You are given each command's output before your next line. SPAWN does not block you — the subagent
runs independently and you continue your own reasoning immediately; check on it later with PING or
wait for it to SEND you its result. All subagents share the ONE real exec channel (the user's Mac),
so their shell commands queue safely behind each other automatically — you never need to worry about
that part. If the task needs no shell (a question, an explanation), answer it directly with a single
DONE: line. Keep DONE summaries human and useful — they are the assistant's reply to the user, not a
log.`;

// ---------------------------------------------------------------- subagents --

// name -> { mailbox: string[], done: boolean, result: string|null }. In-process
// registry — every agent (root task + SPAWNed subagents) shares the ONE real
// exec channel (queueDrive), but reason (call the brain) independently and
// concurrently, so SPAWN genuinely doesn't block the spawning agent.
const agents = new Map();

function ensureAgent(name) {
  if (!agents.has(name)) agents.set(name, { mailbox: [], done: false, result: null });
  return agents.get(name);
}

/** The agent loop for one task, executed through the connected daemon. Each
 *  RUN is pushed as an exec frame; the daemon's result frames (captured in
 *  `pendingResults`) feed the next turn. */
async function runTask(task, stream, ctx) {
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: task }];
  let answer = '';
  for (let step = 0; step < MAX_STEPS; step++) {
    const line = (await brain(messages)).trim();
    record({ ev: 'brain', step, line });
    const done = /^DONE:\s*([\s\S]+)/.exec(line);
    if (done) { answer = done[1].trim(); record({ ev: 'task-done', step, answer }); return answer; }
    const run = /^RUN:\s*([\s\S]+)/.exec(line);
    // no RUN and no DONE — treat the whole line as a direct answer to the user
    if (!run) { answer = line.replace(/^DONE:\s*/i, ''); record({ ev: 'task-freeform', step, answer }); return answer; }
    const cmd = run[1].trim();
    const frame = execFrame(cmd);
    ctx.awaiting = frame.requestId;
    ctx.output = '';
    ctx.done = false;
    sseSend(stream, frame);
    record({ ev: 'exec-push', step, requestId: frame.requestId, cmd });
    // wait for the daemon's result frames for this requestId (or timeout)
    const out = await waitResult(ctx, 60_000);
    messages.push({ role: 'assistant', content: line });
    messages.push({ role: 'user', content: `output:\n${out || '(none)'}` });
  }
  return answer || '(reached step limit without finishing)';
}

function waitResult(ctx, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (ctx.done || Date.now() - started > timeoutMs) {
        clearInterval(iv); ctx.done = false; resolve(ctx.output || '');
      }
    }, 250);
  });
}

// ----------------------------------------------------------------- servers --

// per-connection context so a result frame can be matched to its exec
const ctxByToken = new Map();
// the single live daemon (Grok Bot's local-exec on the user's Mac). Set when it
// opens its SSE; the /drive endpoint pushes exec frames down THIS stream.
let activeDaemon = null;
// one exec loop at a time against the shared daemon ctx — two concurrent
// runTask calls would interleave result frames onto the same ctx.output.
let driveQueue = Promise.resolve();
function queueDrive(fn) {
  const next = driveQueue.then(fn, fn);
  driveQueue = next.catch(() => {});
  return next;
}

for (const port of PORTS) {
  const server = http.createServer((req, res) => {
    // The daemon's receive-channel: hold the SSE open. The TASK does NOT come
    // from here or from any env var — it arrives via POST /drive, forwarded by
    // the backend from whatever the user typed into the Grok Bot UI.
    if (req.method === 'GET' && req.url && req.url.startsWith('/local-exec/requests')) {
      const token = (req.headers['x-anyrun-network-token'] || 'default');
      const ctx = { awaiting: null, output: '', done: false };
      ctxByToken.set(token, ctx);
      activeDaemon = { stream: res, ctx };
      record({ port, method: 'GET', path: req.url, note: 'SSE opened — daemon connected', bodyBytes: 0 });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(':ok\n\n');
      // announce ourselves; then wait for the UI to drive us
      sseSend(res, { kind: 'welcome', providerId: 'openzoo' });
      req.on('close', () => {
        ctxByToken.delete(token);
        if (activeDaemon && activeDaemon.stream === res) activeDaemon = null;
      });
      return;
    }

    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      let parsed, kinds;
      try { parsed = JSON.parse(body.toString('utf8')); kinds = parsed.frames?.map((f) => f.kind).join(','); } catch { /* not json */ }
      record({ port, method: req.method, path: req.url, bodyBytes: body.length, frames: kinds,
        bodyUtf8: body.slice(0, 1024).toString('utf8').replace(/[^\x20-\x7e]/g, '.') });

      // THE TRIGGER: the backend forwards the user's Grok Bot prompt here. Drive
      // the agent loop against the connected daemon and return the answer text.
      if (req.method === 'POST' && req.url && req.url.startsWith('/drive')) {
        let task = '';
        try { task = (JSON.parse(body.toString('utf8')).task || '').toString(); }
        catch { task = body.toString('utf8'); }
        record({ ev: 'drive', task: task.slice(0, 160) });
        if (!activeDaemon) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, text: '(sandbox not connected yet — give the app a moment and retry)' }));
          return;
        }
        let text;
        try {
          text = await queueDrive(() => runTask(task, activeDaemon.stream, activeDaemon.ctx));
        } catch (e) { text = `agent error: ${e.message}`; record({ ev: 'drive-error', err: String(e) }); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, text }));
        return;
      }

      // the daemon posts result frames here — accumulate output for the loop
      if (parsed?.frames && req.url?.includes('/local-exec/responses')) {
        const token = (req.headers['x-anyrun-network-token'] || 'default');
        const ctx = ctxByToken.get(token);
        for (const f of parsed.frames) {
          if (ctx && (f.kind === 'output' || f.kind === 'stdout')) ctx.output += (f.data || f.text || f.chunk || '');
          if (ctx && (f.kind === 'result' || f.kind === 'exit')) ctx.done = true;
        }
      }

      // THE REAL TRIGGER. Grok Bot's own chat (StreamUnifiedChat) never reaches
      // us — inference happens server-side inside whatever pod EnsureSandBox
      // named, and since we hijacked that to a pod that doesn't exist on
      // Cursor's side, the UI's chat box just sits silent forever. But the app
      // ALSO opens this vnc.html URL — OUR box — inside its own sandbox panel.
      // Serve a real chat page here instead of a stub: the user types inside
      // Grok Bot's own window, it POSTs straight to /drive on this box.
      if (req.url && req.url.includes('/vnc')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(VNC_CHAT_HTML);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }
    });
  });
  server.on('upgrade', (req, socket) => {
    record({ port, method: 'UPGRADE', path: req.url, bodyBytes: 0 });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  // NEVER FATAL. These are the Grok-Bot-shaped agent ports, a nicety — but an
  // unhandled 'error' event takes the whole process down, and the process that
  // dies is the one also serving the CHAT on :4173. A stale instance holding
  // :1337 therefore black-screened the app: Electron loaded :4173 and got
  // ERR_CONNECTION_REFUSED, with the real cause (EADDRINUSE on a port nobody
  // cares about) buried in a log the user never sees.
  server.on('error', (e) => console.log(`[agent] :${port} unavailable (${e.code}) — continuing without it`));
  server.listen(port, '0.0.0.0', () => console.log(`[agent] on :${port}`));
}

console.log(`[agent] brain=${MODEL} via ${PROXY}  task=${process.env.OZ_TASK ? JSON.stringify(process.env.OZ_TASK).slice(0, 60) : '(none — waiting)'}`);
