/**
 * `openzoo voice` — write (and rewrite) in the operator's own voice, paid
 * per call over x402. Standalone: no agent framework, just the shim.
 *
 * Two of the three voice layers live here (the third, a LoRA, lives in
 * weights someday):
 *
 *   THEMING — a style card distilled once from real turns (an explicit
 *   voice spec + verbatim exemplars), pinned into every rewrite prompt.
 *   RECALL — the operator's whole message history bound into leCore, so
 *   each rewrite retrieves how they ACTUALLY talked in similar spots.
 *
 * TIERED CONTEXTS, CASCADED RETRIEVAL (leCore's retrieval_dispatch shape):
 * the corpus binds into progressively larger tiers — cream (best few
 * thousand turns), telegram (all of it), twitter (all of it) — and every
 * bind lands TWICE: on the gateway (attachable via x-hrr-context) and on
 * the local leCore daemon (scored recall). A rewrite recalls against
 * cream first; when the top-1/top-2 margin says the match is ambiguous,
 * it ESCALATES into the full tiers and fuses. Exemplars go inline; the
 * gateway context rides as x-hrr-context only when the daemon is down.
 *
 * Ingestion sources are the operator's own exports:
 *   Telegram Desktop dump   (telegram_messages.txt format)
 *   X/Twitter archive       (dir containing data/tweets.js)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitIntoParts } from './bindpath.js';
import { config } from './config.js';

/**
 * VOICE CALLS ARE SLOW CALLS, AND THE DEFAULT TIMEOUT ASSUMES THEY ARE NOT.
 *
 * fetchHeaders aborts when response headers have not arrived in 120s. A
 * style-card distillation ships 150 exemplars and asks for 1,800 tokens of
 * analysis; a rewrite may attach a fat context. OBSERVED: "openzoo: This
 * operation was aborted" on the first card run. Raised only for this
 * process, and only when the operator has not chosen a value.
 */
if (!process.env.OPENZOO_UPSTREAM_HEADERS_MS) {
  process.env.OPENZOO_UPSTREAM_HEADERS_MS = String(Number(process.env.OPENZOO_VOICE_HEADERS_MS || 420_000));
}

const GATEWAY = config.apiBase;
const DAEMON = process.env.OPENZOO_LECORE_URL || 'http://127.0.0.1:8787';
const DAEMON_TOKEN = process.env.OPENZOO_LECORE_TOKEN || 'hrr-lab-token';
const DAEMON_TENANT = process.env.OPENZOO_LECORE_TENANT || 'claude-code';

const STATE_FILE = process.env.OPENZOO_VOICE_STATE || path.join(os.homedir(), '.openzoo', 'voice.json');
const CARD_FILE = process.env.OPENZOO_VOICE_CARD || path.join(os.homedir(), '.openzoo', 'voice-card.md');

/** Which senders are "me" in the telegram dump. */
const ME = new RegExp(process.env.OPENZOO_VOICE_ME || 'stacc overflow|notStacc', 'i');

/**
 * fable-5, PINNED — never `openzoo/auto` here.
 *
 * auto is cheaper (measured: gemini-2.5-flash-lite at $0.00087 against
 * fable-5's $0.0414 on one draft, output word-for-word identical that
 * time) but it is a LOTTERY: a different model every call, so the voice
 * drifts between posts and a bad draw ships in your name. Voice is the
 * one place where consistency is the product and a few cents a post is
 * not worth arguing about. Operator directive, and it is the right call.
 */
export const VOICE_MODEL = process.env.OPENZOO_VOICE_MODEL || 'fable-5';

/**
 * The retry chain. fable-5 first (pinned for consistency), then other
 * providers to fall through to when it returns garbage.
 *
 * A gateway to ~490 models means one model looping is a ROUTING problem,
 * not a dead end — so a degenerate rewrite gets another provider rather
 * than a shrug. OBSERVED, published live: fable-5 caught a repetition
 * cycle and shipped "…below for proof serhots below for proof ser…"
 * fifteen times over, because nothing retried and nothing checked.
 */
export const VOICE_CHAIN = (process.env.OPENZOO_VOICE_CHAIN
  || [VOICE_MODEL, 'x-ai/grok-4.6', 'openzoo/auto'].join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------- state

export function loadVoiceState(file = STATE_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { tiers: {} }; }
}

function saveVoiceState(state, file = STATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export function loadVoiceCard(file = CARD_FILE) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

// ---------------------------------------------------------------- parsers

/**
 * telegram_messages.txt: `=== CHAT id: Title ===` sections, then
 * `--- messageID | date | sender ---` blocks whose body starts with an
 * HH:MM line and, on sender change, a repeated sender-name line.
 *
 * Turns collapse the operator's shotgun runs — consecutive messages from
 * "me" become ONE reply — with up to 6 preceding messages as context.
 */
export function parseTelegramDump(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const turns = [];
  let chat = '';
  let msgs = [];

  // A shotgun RUN is one utterance typed across several bubbles — minutes
  // apart it is a new thought, not the same one. Without these bounds a
  // monologue chat collapses an entire session into a single "turn":
  // MEASURED, 69,261 of my messages became 4,463 turns (~15 each).
  const RUN_GAP_MS = Number(process.env.OPENZOO_VOICE_RUN_GAP_MS || 180_000);
  const RUN_MAX = Number(process.env.OPENZOO_VOICE_RUN_MAX || 6);

  const flushChat = () => {
    for (let i = 0; i < msgs.length; i++) {
      if (!ME.test(msgs[i].sender)) continue;
      let j = i;
      const mine = [];
      while (
        j < msgs.length
        && ME.test(msgs[j].sender)
        && mine.length < RUN_MAX
        && (j === i || msgs[j].at - msgs[j - 1].at <= RUN_GAP_MS)
      ) { mine.push(msgs[j].text); j++; }
      const reply = mine.join('\n').trim();
      const context = msgs.slice(Math.max(0, i - 6), i)
        .map((c) => `${ME.test(c.sender) ? 'me' : c.sender}: ${c.text}`);
      if (reply) turns.push({ source: 'telegram', where: chat, when: msgs[i].when, context, reply });
      i = j - 1;
    }
    msgs = [];
  };

  for (const block of raw.split(/\n(?==== CHAT |--- message)/)) {
    const chatHead = block.match(/^=== CHAT [^:]*: (.*) ===/);
    if (chatHead) { flushChat(); chat = chatHead[1].trim(); continue; }
    const head = block.match(/^--- message\S* \| ([^|]*) \| (.*?) ---\n?([\s\S]*)$/);
    if (!head) continue;
    const sender = head[2].trim();
    if (!sender || sender === '[service]') continue;
    const d = head[1].trim();                       // dd.mm.yyyy hh:mm:ss UTC+00:00
    const when = d ? `${d.slice(6, 10)}-${d.slice(3, 5)}` : '';
    const at = d
      ? Date.parse(`${d.slice(6, 10)}-${d.slice(3, 5)}-${d.slice(0, 2)}T${d.slice(11, 19)}Z`) || 0
      : 0;
    let lines = head[3].split('\n');
    if (/^\d{2}:\d{2}$/.test((lines[0] || '').trim())) lines = lines.slice(1);
    if ((lines[0] || '').trim() === sender) lines = lines.slice(1);
    const text = lines.join('\n')
      // Export artifact: a quoted-reply header the exporter inlines into the
      // body. It is chrome, not something the author typed.
      .replace(/\n?In reply to\n(this message|[^\n]*)\n?/g, '\n')
      .trim();
    if (!text || /^\[(photo|video|sticker|file|voice|gif|animation)/i.test(text)) continue;
    msgs.push({ sender, when, at, text });
  }
  flushChat();
  return turns;
}

/** data/tweets.js from the X archive: window.YTD.tweets.part0 = [...] */
export function parseTwitterDump(archiveDir) {
  const raw = fs.readFileSync(path.join(archiveDir, 'data', 'tweets.js'), 'utf8');
  const arr = JSON.parse(raw.slice(raw.indexOf('[')));
  const turns = [];
  for (const row of arr) {
    const t = row?.tweet;
    const text = String(t?.full_text || '').trim();
    if (!text || text.startsWith('RT @')) continue;
    const when = t?.created_at ? new Date(t.created_at).toISOString().slice(0, 7) : '';
    turns.push({
      source: 'twitter',
      where: t?.in_reply_to_screen_name ? `reply to @${t.in_reply_to_screen_name}` : '(original post)',
      when,
      context: t?.in_reply_to_screen_name ? [`(replying to @${t.in_reply_to_screen_name})`] : [],
      reply: text,
    });
  }
  return turns;
}

// ---------------------------------------------------------------- tiers

function renderTurn(t) {
  return [`[${t.source} · ${t.where}${t.when ? ` · ${t.when}` : ''}]`, ...t.context, `me: ${t.reply}`].join('\n');
}

/** The turns worth imitating: substantial, not link dumps, deduped,
 *  sampled evenly across time so no single era dominates. */
export function creamOf(turns, max = 4000) {
  const seen = new Set();
  const good = turns.filter((t) => {
    if (t.reply.length < 12 || t.reply.length > 600) return false;
    if (/^https?:\/\/\S+$/.test(t.reply)) return false;
    const key = t.reply.toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (good.length <= max) return good;
  const step = good.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(good[Math.floor(i * step)]);
  return out;
}

async function bindGateway(corpus, log, label) {
  const parts = splitIntoParts(corpus);
  let contextId = null;
  for (let i = 0; i < parts.length; i++) {
    const r = await fetch(`${GATEWAY}/v1/hrr/bind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(contextId ? { context_id: contextId, corpus: parts[i] } : { corpus: parts[i] }),
    });
    if (!r.ok) throw new Error(`gateway bind ${label} ${i + 1}/${parts.length}: HTTP ${r.status}`);
    contextId = (await r.json()).context_id;
    log(`voice: ${label} gateway part ${i + 1}/${parts.length}`);
  }
  return contextId;
}

/**
 * Local daemon bind — what makes SCORED recall (and the cascade) possible.
 *
 * ONE ITEM PER TURN, deliberately: the daemon indexes discrete items, so a
 * turn stays whole and recall returns something imitable. Chunking a
 * concatenated corpus instead would cut mid-conversation and hand the
 * rewriter half an exchange.
 *
 * An absent daemon is not an error: the gateway context still works, and
 * voiceText falls back to attaching it (see below).
 */
async function bindDaemon(turns, log, label) {
  const BATCH = Number(process.env.OPENZOO_VOICE_BIND_BATCH || 500);
  try {
    let contextId = null;
    for (let i = 0; i < turns.length; i += BATCH) {
      const items = turns.slice(i, i + BATCH).map((t) => ({
        text: renderTurn(t),
        metadata: { source: t.source, where: t.where, when: t.when },
      }));
      const r = await fetch(`${DAEMON}/internal/v1/hrr/bind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${DAEMON_TOKEN}` },
        body: JSON.stringify({
          tenant_id: DAEMON_TENANT,
          items,
          ...(contextId ? { context_id: contextId } : {}),
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
      contextId = (await r.json()).context_id;
      log(`voice: ${label} daemon ${Math.min(i + BATCH, turns.length)}/${turns.length} turns`);
    }
    return contextId;
  } catch (e) {
    log(`voice: ${label} daemon bind unavailable (${e.message}) — cascade disabled for this tier`);
    return null;
  }
}

/**
 * Ingest the buckets into the tier cascade. Re-runnable: the dumps are
 * snapshots, so each run rebinds fresh contexts and overwrites the state.
 */
export async function ingestVoice({ telegramFile, twitterDir }, log = () => {}) {
  const tg = telegramFile ? parseTelegramDump(telegramFile) : [];
  const tw = twitterDir ? parseTwitterDump(twitterDir) : [];
  if (!tg.length && !tw.length) throw new Error('nothing to ingest — pass --telegram and/or --twitter');
  log(`voice: parsed ${tg.length} telegram turns, ${tw.length} twitter turns`);

  const state = { tiers: {}, builtAt: new Date().toISOString() };
  const tiers = [
    ['cream', creamOf([...tg, ...tw])],
    ['telegram', tg],
    ['twitter', tw],
  ];
  for (const [name, turns] of tiers) {
    if (!turns.length) continue;
    const corpus = turns.map(renderTurn).join('\n\n');
    // Daemon FIRST: it is local, free and instant, and it is what powers
    // scored recall. The gateway bind is the fallback path and the slow
    // one, so a Ctrl-C mid-ingest still leaves the useful half done.
    const daemonCtx = await bindDaemon(turns, log, name);
    const gatewayCtx = process.env.OPENZOO_VOICE_SKIP_GATEWAY === '1'
      ? null
      : await bindGateway(corpus, log, name).catch((e) => {
          log(`voice: ${name} gateway bind failed (${e.message}) — daemon recall still works`);
          return null;
        });
    state.tiers[name] = { gatewayCtx, daemonCtx, turns: turns.length, bytes: Buffer.byteLength(corpus) };
    saveVoiceState(state);   // persist per tier — a long ingest is resumable
    log(`voice: tier ${name} bound (${turns.length} turns, ${(state.tiers[name].bytes / 1048576).toFixed(1)}MB)`);
  }
  saveVoiceState(state);
  return state;
}

// ---------------------------------------------------------------- card

/**
 * Distill the style card ONCE from real turns: rules a model can follow,
 * things the author would never write, verbatim exemplars. One paid call.
 */
export async function distillStyleCard(turns, log = () => {}) {
  const { PayClient } = await import('./pay.js');
  /**
   * NEVER FLATTEN A BURST INTO ONE LINE.
   *
   * This used to render each sample as `reply.replace(/\n/g, ' / ')` so a
   * sample fit on one line. The analyst read those separators as
   * PUNCTUATION and wrote the rule "chain thoughts with ' / '; treat / as
   * the primary delimiter" — so every rewrite came out slash-chained.
   * The author has never typed " / " in their life: those newlines are
   * where one message ended and the next was sent, an artifact of the
   * shotgun-collapse in parseTelegramDump. Bursts are now rendered as
   * what they are, and the prompt says so.
   */
  const sample = creamOf(turns, 150)
    .map((t, i) => {
      const lines = t.reply.split('\n').filter((l) => l.trim());
      const body = lines.map((l) => `  ${l}`).join('\n');
      return `[sample ${i + 1} · ${t.source}${lines.length > 1 ? ` · burst of ${lines.length}` : ''}]\n${body}`;
    })
    .join('\n');
  const { data } = await new PayClient().chat({
    model: VOICE_MODEL,
    max_tokens: 1800,
    messages: [
      {
        role: 'system',
        content: [
          'You are a forensic style analyst. From the writing samples, produce a STYLE CARD another model can follow to write indistinguishably from this author.',
          '',
          'HOW TO READ THE SAMPLES: each sample is one turn. A sample marked "burst of N" is N SEPARATE MESSAGES the author fired one after another — the line breaks are message boundaries, not punctuation the author typed. Describe that habit as what it is (sends several short messages in a row rather than one long one). Never invent a separator character to represent it, and never claim the author writes " / " or "|" between thoughts.',
          '',
          'Sections:',
          '1) VOICE RULES — 12-20 terse, concrete, falsifiable rules (casing, punctuation, abbreviations, sentence length, slang, emoji policy, how they open/close, how they disagree, how they hype or refuse to).',
          '2) NEVER — 5-10 things this author would never write.',
          '3) EXEMPLARS BY SITUATION — first identify the distinct SITUATIONS these samples cover (e.g. answering a technical question, disagreeing, being hyped, shipping/announcing, refusing, small talk, self-deprecation, explaining something to a peer). For EACH situation, quote the best 3 VERBATIM lines from the samples. Quote ONE message per exemplar — never stitch several messages of a burst together into a single quoted line. Label each group with its situation. Coverage of the range matters more than picking the funniest lines — a rewriter will match the incoming message to a situation and imitate that group.',
          '',
          'Output only the card, markdown.',
        ].join('\n'),
      },
      { role: 'user', content: `Writing samples (one per line):\n${sample}` },
    ],
  });
  const card = data?.choices?.[0]?.message?.content?.trim() || '';
  if (!card) throw new Error('style card came back empty');
  const { recordReceipt } = await import('./receipts.js');
  recordReceipt({
    kind: 'voice:card',
    tool: 'voice',
    model: data?.model || VOICE_MODEL,
    billedUsd: Number(data?.x402?.billedUsd ?? data?.usage?.cost ?? 0),
    directUsd: Number(data?.x402?.directUsd ?? 0),
    inChars: sample.length,
    output: card,
  });
  fs.mkdirSync(path.dirname(CARD_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CARD_FILE, card + '\n', { mode: 0o600 });
  log(`voice: style card written to ${CARD_FILE} (${card.length} chars, ${usd(Number(data?.x402?.billedUsd ?? data?.usage?.cost ?? 0))})`);
  return card;
}

// ---------------------------------------------------------------- recall

async function daemonRecall(contextId, query, topK) {
  const r = await fetch(`${DAEMON}/internal/v1/hrr/recall`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${DAEMON_TOKEN}` },
    body: JSON.stringify({ tenant_id: DAEMON_TENANT, context_id: contextId, query, top_k: topK }),
  });
  if (!r.ok) throw new Error(`recall HTTP ${r.status}`);
  return (await r.json()).items || [];
}

/**
 * The retrieval_dispatch cascade, client-side: recall against CREAM
 * first; when the top-1/top-2 score margin is too thin to trust (the
 * match is ambiguous), escalate into the full tiers and fuse by score.
 * Returns { exemplars, stage } or null when the daemon is unreachable —
 * callers then fall back to attaching the gateway context instead.
 */
export async function recallExemplars(query, { topK = 8, marginFloor = 0.12, state = loadVoiceState() } = {}) {
  const cream = state.tiers?.cream?.daemonCtx;
  if (!cream) return null;
  try {
    const first = await daemonRecall(cream, query, topK);
    const s1 = Number(first[0]?.score ?? 0);
    const s2 = Number(first[1]?.score ?? 0);
    const margin = s1 > 0 ? (s1 - s2) / s1 : 0;
    if (first.length && margin >= marginFloor) {
      return { exemplars: first.map((i) => i.text), stage: 'cream' };
    }
    // Ambiguous — escalate into the full tiers and fuse dense-dominant.
    const deep = [];
    for (const name of ['telegram', 'twitter']) {
      const ctx = state.tiers?.[name]?.daemonCtx;
      if (!ctx) continue;
      deep.push(...await daemonRecall(ctx, query, topK).catch(() => []));
    }
    const fused = [...first, ...deep]
      .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))
      .filter((item, idx, arr) => arr.findIndex((x) => x.text === item.text) === idx)
      .slice(0, topK);
    return fused.length ? { exemplars: fused.map((i) => i.text), stage: 'escalated' } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- guard

/**
 * REFUSE A DEGENERATE REWRITE. A bad rewrite is worse than no rewrite:
 * this ships under the operator's name, in public, with no undo.
 *
 * OBSERVED, published live: "screenshots below for proof serhots below
 * for proof serhots below for proof ser..." — the model caught a
 * repetition cycle on the card's "ser" habit and looped it fifteen times.
 * Nothing downstream checked, so it went out.
 *
 * Two detectors, both cheap and both on the OUTPUT (no extra model call):
 *   1. a repeated word n-gram — the signature of a decoding loop
 *   2. runaway length against the draft it was supposed to be rewriting
 * Either one fails the rewrite, and the caller sends the draft as typed.
 */
export function looksDegenerate(text, draft) {
  const t = String(text || '');
  if (!t.trim()) return 'empty';

  // A rewrite is a rewrite, not an essay. The prompt asks for ~1.3x; 3x
  // (plus a floor, so short drafts are not judged harshly) is a runaway.
  const ceiling = Math.max(400, draft.length * 3);
  if (t.length > ceiling) return `runaway length (${t.length} chars from a ${draft.length}-char draft)`;

  // Any 4-word phrase appearing 3+ times is a loop, not a style. Real
  // writing repeats short function words, not four-word runs.
  const words = t.toLowerCase().replace(/\s+/g, ' ').trim().split(' ');
  if (words.length >= 12) {
    const seen = new Map();
    for (let i = 0; i + 4 <= words.length; i++) {
      const gram = words.slice(i, i + 4).join(' ');
      const n = (seen.get(gram) || 0) + 1;
      if (n >= 3) return `repetition loop ("${gram}" x${n})`;
      seen.set(gram, n);
    }
  }

  // The same cycle can land without word boundaries ("serhots below for
  // proof serhots"), so also check a long character run repeating.
  const collapsed = t.replace(/\s+/g, ' ');
  for (const len of [24, 40]) {
    if (collapsed.length < len * 3) continue;
    const probe = collapsed.slice(Math.floor(collapsed.length / 2), Math.floor(collapsed.length / 2) + len);
    if (probe.trim().length < len) continue;
    let count = 0;
    let idx = collapsed.indexOf(probe);
    while (idx !== -1) { count++; idx = collapsed.indexOf(probe, idx + 1); }
    if (count >= 3) return `repetition loop (${len}-char run x${count})`;
  }
  return null;
}

// ---------------------------------------------------------------- rewrite

/**
 * The receipt — same shape xbot printed, inlined rather than imported so
 * this survives xbot's retirement. Equal prices are reported as equal:
 * on a short rewrite leCore has nothing to spill, and inventing a saving
 * would be the same lie in a smaller font.
 */
export function usd(n) {
  if (!(n > 0)) return '$0';
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  if (n >= 0.000001) return `$${n.toFixed(6)}`;
  return `$${n.toExponential(1)}`;
}

export function priceLine({ routedModel, billedUsd, directUsd }) {
  const bits = [String(routedModel).split('/').pop(), usd(billedUsd)];
  if (directUsd > 0 && billedUsd > 0) {
    const x = directUsd / billedUsd;
    if (x >= 1.05) bits.push(`vs ${usd(directUsd)} direct on OpenRouter — ${x.toFixed(1)}× cheaper`);
    else bits.push('same as OpenRouter direct — never more');
  }
  return bits.join(' · ');
}

/**
 * Rewrite (or write) text in the operator's voice. The style card pins the
 * rules; recalled exemplars show the register for THIS kind of message.
 */
/** What kind of thing is being written — steers length and register. */
const KIND_HINT = {
  post: 'This is a standalone X post. No greeting, no sign-off. It must stand alone.',
  reply: 'This is a REPLY to someone on X. Short. Conversational. It answers what was said — it does not restate it.',
  quote: 'This is a QUOTE-TWEET comment on someone else\'s post. One or two lines of the author\'s own take.',
  dm: 'This is a DIRECT MESSAGE to one person. Casual, familiar, shorter than a post.',
};

export async function voiceText(draft, { log = () => {}, kind = 'post' } = {}) {
  const { PayClient } = await import('./pay.js');
  const { recordReceipt } = await import('./receipts.js');
  const startedAt = Date.now();
  const state = loadVoiceState();
  const card = loadVoiceCard();
  const recalled = await recallExemplars(draft, { state });

  const system = [
    'You rewrite drafts in the authentic voice of the author described below. Preserve the meaning and intent exactly; change only voice, rhythm and wording. If the draft is already perfectly in voice, return it unchanged. Output ONLY the rewritten text — no preamble, no quotes, no explanation, no surrounding quotation marks.',
    // The recalled examples are TRANSCRIPTS: a multi-line "me:" block is
    // several messages the author sent in a row, not one message with
    // separators in it. Without this the rewriter reproduces the message
    // boundaries as literal " / " and every post comes out slash-chained.
    'The examples below are chat transcripts. Where one speaker turn spans several lines, those are SEPARATE MESSAGES sent one after another — the line breaks are message boundaries. You are writing ONE message, so never reproduce those boundaries as punctuation: no " / ", " | " or " - " chaining between thoughts. Use ordinary sentences, fragments or line breaks the way the author does inside a single message.',
    KIND_HINT[kind] ? `\n${KIND_HINT[kind]}` : '',
    // The author's own ceiling, not the platform's: a rewrite that doubles
    // the length is not the same message in a different voice.
    `\nKeep it within ~${Math.max(120, Math.ceil(draft.length * 1.3))} characters — the author is terse and the draft sets the scale.`,
    card ? `\n${card}` : '',
    recalled
      ? `\nHow the author actually wrote in similar spots (imitate the register, never copy):\n${recalled.exemplars.map((e) => `---\n${e}`).join('\n')}`
      : '',
  ].join('\n');

  const headers = {};
  if (!recalled && state.tiers?.cream?.gatewayCtx) {
    headers['x-hrr-context'] = state.tiers.cream.gatewayCtx;   // daemon down — recall server-side
  }

  const pay = new PayClient();
  const stage = recalled?.stage ?? 'attach';
  const body = {
    // GENEROUS, because fable-5 is a REASONING model and its thinking
    // tokens are drawn from this same budget. A draft-proportional cap
    // (draft.length / 2) looked prudent and starved the answer: the model
    // spent the budget thinking and returned "I love openzoo.fun / it let
    // me bind my whole telegram + twitter exports, so recall" — cut dead
    // mid-sentence. Runaway output is bounded by looksDegenerate on the
    // way out, which is the right place for it.
    max_tokens: Math.max(1000, draft.length * 2),
    // Decoding-loop insurance. The published failure was a repetition
    // cycle; these make it less likely, and looksDegenerate catches what
    // still gets through.
    frequency_penalty: 0.4,
    presence_penalty: 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Rewrite this in the author's voice:\n\n${draft}` },
    ],
  };

  /**
   * GARBAGE MEANS TRY ANOTHER PROVIDER, not give up. The whole point of a
   * gateway to ~490 models is that one model looping is a routing problem,
   * not a dead end. Each attempt is checked before it can be returned, and
   * every attempt — including the refused ones — is billed and logged,
   * because a rewrite you paid for and threw away is exactly what belongs
   * in the ledger.
   *
   * Only if the whole chain degenerates does the draft go out as typed.
   */
  let text = '';
  let receipt = '';
  let bad = null;
  const attempts = [];
  for (const model of VOICE_CHAIN) {
    const t0 = Date.now();
    let data;
    try {
      ({ data } = await pay.chat({ ...body, model }, { headers }));
    } catch (e) {
      attempts.push({ model, error: String(e.message || e).slice(0, 120) });
      log(`voice: ${model} failed (${String(e.message || e).slice(0, 80)}) — next provider`);
      continue;
    }
    const out = data?.choices?.[0]?.message?.content?.trim() || '';
    const routedModel = data?.model || model;
    const billedUsd = Number(data?.x402?.billedUsd ?? data?.usage?.cost ?? 0);
    const directUsd = Number(data?.x402?.directUsd ?? 0);
    // A truncated rewrite is garbage too, and it announces itself: the
    // provider says finish_reason "length" when it ran out of budget
    // mid-sentence. Retry rather than publish half a thought.
    const finish = data?.choices?.[0]?.finish_reason || '';
    bad = finish === 'length' ? 'truncated (hit the token budget)' : looksDegenerate(out, draft);

    recordReceipt({
      kind: `voice:${kind}`,
      tool: 'voice',
      model: routedModel,
      billedUsd,
      directUsd,
      seconds: (Date.now() - t0) / 1000,
      stage,
      ...(bad ? { refused: bad } : {}),
      input: draft,
      output: out,
    });
    attempts.push({ model: routedModel, billedUsd, refused: bad });

    if (!bad) {
      text = out;
      receipt = priceLine({ routedModel, billedUsd, directUsd });
      break;
    }
    log(`voice: ${routedModel} returned garbage (${bad}) — retrying on another provider`);
  }

  if (!text) {
    // Every provider degenerated (or errored). The draft is untouched —
    // publishing a loop under the author's name is the one outcome worse
    // than not rewriting at all.
    log(`voice: all ${VOICE_CHAIN.length} providers failed — sending the draft as typed`);
    return {
      text: draft,
      receipt: `no usable rewrite after ${attempts.length} attempt(s) — sent as typed`,
      stage,
      refused: bad,
      attempts,
    };
  }

  log(`voice: ${recalled ? `recall ${recalled.stage}` : 'gateway attach'}${attempts.length > 1 ? ` · ${attempts.length} attempts` : ''} · ${receipt}`);
  return { text, receipt, stage, attempts };
}

// ---------------------------------------------------------------- CLI

export async function runVoice(args) {
  const cmd = args[0] || 'help';
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const log = (m) => console.error(`  ${m}`);

  if (cmd === 'ingest') {
    const state = await ingestVoice({ telegramFile: flag('telegram'), twitterDir: flag('twitter') }, log);
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  if (cmd === 'card') {
    const tgFile = flag('telegram');
    const twDir = flag('twitter');
    const turns = [
      ...(tgFile ? parseTelegramDump(tgFile) : []),
      ...(twDir ? parseTwitterDump(twDir) : []),
    ];
    if (!turns.length) throw new Error('voice card needs --telegram and/or --twitter to sample from');
    console.log(await distillStyleCard(turns, log));
    return;
  }
  if (cmd === 'status') {
    const s = loadVoiceState();
    console.log(JSON.stringify({ ...s, card: loadVoiceCard() ? `${CARD_FILE} (present)` : '(none — run voice card)' }, null, 2));
    return;
  }
  if (cmd === 'say') {
    const draft = args.slice(1).filter((a) => !a.startsWith('--')).join(' ');
    if (!draft) throw new Error('usage: openzoo voice say "your draft"');
    const r = await voiceText(draft, { log });
    console.log(r.text);
    console.error(`\n  ${r.receipt}`);
    return;
  }
  if (cmd === 'receipts') {
    const { readReceipts, summarizeReceipts, formatSummary } = await import('./receipts.js');
    const rows = readReceipts();
    if (args.includes('--json')) { console.log(JSON.stringify(summarizeReceipts(rows), null, 2)); return; }
    if (args.includes('--all')) { for (const r of rows) console.log(JSON.stringify(r)); return; }
    console.log(formatSummary(summarizeReceipts(rows)));
    return;
  }
  if (cmd === 'serve') {
    const { runVoiceServe } = await import('./voiceserve.js');
    await runVoiceServe(args.slice(1));
    return;
  }
  if (cmd === 'watch' || cmd === 'login') {
    const { runVoiceWatch } = await import('./voicewatch.js');
    await runVoiceWatch(cmd, args.slice(1));
    return;
  }
  console.log([
    'openzoo voice — write like you, paid per call over x402',
    '',
    '  voice ingest --telegram <telegram_messages.txt> --twitter <archive dir>',
    '      parse your exports into turns and bind the tier cascade',
    '      (cream / full telegram / full twitter) to the gateway + local leCore',
    '  voice card --telegram <file> [--twitter <dir>]',
    '      distill the style card from real turns (one paid call)',
    '  voice say "draft"        rewrite a draft in your voice (receipt printed)',
    '  voice serve              run the local endpoint the X browser extension calls',
    '                           (load extension/ via chrome://extensions -> Load unpacked);',
    '                           posts, replies, QTs and DMs are revised BEFORE they publish',
    '  voice login / watch      Telegram userbot: revise your own outgoing messages in place',
    '  voice status             tiers, contexts, card',
    '  voice receipts           what every paid call cost vs OpenRouter direct',
    '                           (--json rollup · --all raw ledger)',
    '',
    'env: OPENZOO_VOICE_ME (sender regex), OPENZOO_VOICE_MODEL (default fable-5),',
    '     TELEGRAM_APP_ID / TELEGRAM_APP_HASH (from my.telegram.org, for watch)',
  ].join('\n'));
}
