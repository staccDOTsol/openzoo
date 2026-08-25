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
 * `openzoo/auto` by default, NOT a flagship. MEASURED on the same draft:
 * auto routed to gemini-2.5-flash-lite for $0.00087, fable-5 cost $0.0414
 * — 47x the price for output that was word-for-word identical, because
 * the card and the recalled exemplars are doing the work, not the model's
 * raw intelligence. A prehook that fires on every post has to be cheap.
 *
 * Latency is the real variable (1-33s depending on where auto lands, and
 * the per-call x402 settlement). Pin OPENZOO_VOICE_MODEL to a model you
 * have measured as fast if the wait bothers you more than the price.
 */
export const VOICE_MODEL = process.env.OPENZOO_VOICE_MODEL || 'openzoo/auto';

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
  const sample = creamOf(turns, 150).map((t) => `- ${t.reply.replace(/\n/g, ' / ')}`).join('\n');
  const { data } = await new PayClient().chat({
    model: VOICE_MODEL,
    max_tokens: 1800,
    messages: [
      {
        role: 'system',
        content: [
          'You are a forensic style analyst. From the writing samples, produce a STYLE CARD another model can follow to write indistinguishably from this author.',
          '',
          'Sections:',
          '1) VOICE RULES — 12-20 terse, concrete, falsifiable rules (casing, punctuation, abbreviations, sentence length, slang, emoji policy, how they open/close, how they disagree, how they hype or refuse to).',
          '2) NEVER — 5-10 things this author would never write.',
          '3) EXEMPLARS BY SITUATION — first identify the distinct SITUATIONS these samples cover (e.g. answering a technical question, disagreeing, being hyped, shipping/announcing, refusing, small talk, self-deprecation, explaining something to a peer). For EACH situation, quote the best 3 VERBATIM lines from the samples. Label each group with its situation. Coverage of the range matters more than picking the funniest lines — a rewriter will match the incoming message to a situation and imitate that group.',
          '',
          'Output only the card, markdown.',
        ].join('\n'),
      },
      { role: 'user', content: `Writing samples (one per line):\n${sample}` },
    ],
  });
  const card = data?.choices?.[0]?.message?.content?.trim() || '';
  if (!card) throw new Error('style card came back empty');
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
  const state = loadVoiceState();
  const card = loadVoiceCard();
  const recalled = await recallExemplars(draft, { state });

  const system = [
    'You rewrite drafts in the authentic voice of the author described below. Preserve the meaning and intent exactly; change only voice, rhythm and wording. If the draft is already perfectly in voice, return it unchanged. Output ONLY the rewritten text — no preamble, no quotes, no explanation, no surrounding quotation marks.',
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

  const { data } = await new PayClient().chat({
    model: VOICE_MODEL,
    max_tokens: 800,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Rewrite this in the author's voice:\n\n${draft}` },
    ],
  }, { headers });

  const text = data?.choices?.[0]?.message?.content?.trim() || '';
  const receipt = priceLine({
    routedModel: data?.model || VOICE_MODEL,
    billedUsd: Number(data?.x402?.billedUsd ?? data?.usage?.cost ?? 0),
    directUsd: Number(data?.x402?.directUsd ?? 0),
  });
  log(`voice: ${recalled ? `recall ${recalled.stage}` : 'gateway attach'} · ${receipt}`);
  return { text, receipt, stage: recalled?.stage ?? 'attach' };
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
    '',
    'env: OPENZOO_VOICE_ME (sender regex), OPENZOO_VOICE_MODEL (default fable-5),',
    '     TELEGRAM_APP_ID / TELEGRAM_APP_HASH (from my.telegram.org, for watch)',
  ].join('\n'));
}
