import { readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { quoteableRows } from './models.js';

/**
 * `/model <name>` AS A CHAT COMMAND.
 *
 * THE FAILURE THIS EXISTS FOR. A user running ChatGPT desktop (Codex side,
 * pointed at this proxy) typed `/model fable-5` into the chat box expecting the
 * app to switch models. The app has NO such command — it forwarded the line to
 * the model as an ordinary question. The model then spent six minutes and real
 * money shelling around the gateway trying to work out what the user meant,
 * and the model never changed. Codex/ChatGPT gives no model picker for a
 * custom provider, so without this the only ways to switch are editing
 * ~/.codex/config.toml and restarting the app.
 *
 * So the PROXY answers the command: it never reaches the wire, nothing is
 * paid, and the override is remembered on disk so it survives a proxy restart.
 * Everything here is a pure function except the four file helpers, so the
 * tests can drive it without a socket.
 */

/**
 * Normalised form for id comparison. MUST mirror the gateway's own matcher
 * (x402-tokens src/modelmatch.ts) — a name the proxy accepts and the gateway
 * then rejects is worse than no command at all, because the user has already
 * been told "switched".
 *
 * Drop the vendor prefix, lowercase, and treat `.`/`_`/space as `-`, because
 * the same model is spelled `claude-fable-5.1`, `claude_fable_5_1` and
 * `anthropic/claude-fable-5-1` depending on who is printing it.
 */
export function normaliseModelId(s) {
  const raw = String(s ?? '');
  const bare = raw.slice(raw.lastIndexOf('/') + 1);
  return bare
    .toLowerCase()
    .replace(/[._\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Shortest normalised id first, then lexical on the REAL id — a total order,
 *  so the same typed name always lands on the same model. `claude-fable-5` and
 *  `venice/claude-fable-5` normalise identically; without the second key the
 *  winner would depend on catalog order, which changes hourly. */
function bestOf(cands) {
  return cands.sort((a, b) => (
    a.norm.length - b.norm.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  ))[0]?.id ?? null;
}

/**
 * Resolve a typed name against the gateway catalog. Exact normalised match,
 * else a candidate ENDING in `-<want>` (so `fable-5` finds `claude-fable-5`),
 * else a candidate merely containing it. Returns null when nothing fits.
 *
 * Two-character inputs are refused outright: `/model o3` style stubs matched
 * dozens of unrelated ids by substring and the shortest-id tiebreak then picked
 * an arbitrary one. A wrong model chosen silently is the failure mode this
 * whole file is trying to end.
 */
export function matchCatalogId(want, ids) {
  const w = normaliseModelId(want);
  if (w.length < 3) return null;
  const cands = (Array.isArray(ids) ? ids : [])
    .filter((id) => typeof id === 'string' && id)
    .map((id) => ({ id, norm: normaliseModelId(id) }));
  const exact = cands.filter((c) => c.norm === w);
  if (exact.length) return bestOf(exact);
  const suffix = cands.filter((c) => c.norm.endsWith(`-${w}`));
  if (suffix.length) return bestOf(suffix);
  const contains = cands.filter((c) => c.norm.includes(w));
  if (contains.length) return bestOf(contains);
  return null;
}

/**
 * Up to `n` ids to suggest after a miss. matchCatalogId already tried plain
 * substring, so this deliberately goes LOOSER — every dash-token of what was
 * typed, then shrinking prefixes — or a typo like `fabel-5` would print
 * "no model matches" with no way forward.
 */
export function closestIds(want, ids, n = 3) {
  const w = normaliseModelId(want);
  const cands = (Array.isArray(ids) ? ids : [])
    .filter((id) => typeof id === 'string' && id)
    .map((id) => ({ id, norm: normaliseModelId(id) }));
  const probes = [];
  for (const tok of w.split('-')) if (tok.length >= 3) probes.push(tok);
  for (let len = w.length - 1; len >= 3; len -= 1) probes.push(w.slice(0, len));
  const out = [];
  const seen = new Set();
  for (const probe of probes) {
    const hits = cands.filter((c) => c.norm.includes(probe))
      .sort((a, b) => a.norm.length - b.norm.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const h of hits) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      out.push(h.id);
      if (out.length >= n) return out;
    }
  }
  return out;
}

/** Names people actually type, resolved against the LIVE catalog rather than
 *  hardcoded — a hardcoded list goes stale the week the zoo re-quotes. */
const POPULAR_HINTS = ['claude-fable-5', 'claude-opus-5', 'gpt-5', 'grok-4', 'gemini-3-pro'];

export function popularIds(ids, n = 5) {
  const out = [];
  const push = (id) => { if (id && !out.includes(id)) out.push(id); };
  for (const hint of POPULAR_HINTS) push(matchCatalogId(hint, ids));
  for (const id of Array.isArray(ids) ? ids : []) { if (out.length >= n) break; push(id); }
  return out.slice(0, n);
}

// ---------------------------------------------------------------------------
// Detection: what did the user's LAST turn actually say?
// ---------------------------------------------------------------------------

/** Text of one message/item `content`, which is a bare string on the Chat
 *  Completions side and an array of typed parts on the Responses side
 *  (Codex sends `input_text`, browsers send `text`). */
function partsText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => p && typeof p.text === 'string' && (!p.type || p.type === 'text' || p.type === 'input_text' || p.type === 'output_text'))
    .map((p) => p.text)
    .join('\n');
}

/**
 * The last USER turn of a request body, for both shapes we are ever sent:
 * `messages[]` (chat completions + Anthropic messages) and `input`
 * (Responses API — what ChatGPT/Codex posts). Anything else returns ''.
 *
 * Last-user-turn only, never a scan of the whole conversation: a transcript
 * that happens to quote "/model fable-5" from three turns ago must not
 * re-trigger the switch on an unrelated question.
 */
export function lastUserText(body) {
  if (!body || typeof body !== 'object') return '';
  if (Array.isArray(body.messages)) {
    for (let i = body.messages.length - 1; i >= 0; i -= 1) {
      const m = body.messages[i];
      if (m && m.role === 'user') return partsText(m.content);
    }
    return '';
  }
  if (typeof body.input === 'string') return body.input;
  if (Array.isArray(body.input)) {
    for (let i = body.input.length - 1; i >= 0; i -= 1) {
      const it = body.input[i];
      if (it && it.role === 'user') return partsText(it.content);
    }
    return '';
  }
  return '';
}

/**
 * `{ arg }` when the last user turn IS the command, else null. Deliberately
 * anchored: a message that merely mentions /model, or asks a question about
 * it, is a real question and must be paid for and answered by a model.
 */
export function detectModelCommand(body) {
  const text = String(lastUserText(body) || '').trim();
  if (!text) return null;
  const m = /^\/model(?:\s+(.+))?$/i.exec(text);
  if (!m) return null;
  return { arg: (m[1] || '').trim() };
}

// ---------------------------------------------------------------------------
// Persistence — one line in ~/.openzoo/model
// ---------------------------------------------------------------------------

/** Same directory as the wallet and proxy.log; there is no OPENZOO_HOME
 *  convention in this codebase, so homedir() it is (which honours $HOME, and
 *  that is how the tests get a throwaway one). */
export function modelFilePath(home = os.homedir()) {
  return path.join(home, '.openzoo', 'model');
}

// Cached by (mtime,size) rather than read-once: `openzoo model X` in a second
// terminal writes this file while the proxy is running, and a plain in-memory
// cache would keep serving the old id until restart — the exact "no restart"
// promise the command makes.
let memo = { file: null, stamp: null, id: null };

export function readOverride(file = modelFilePath()) {
  let stamp = 'missing';
  try { const st = statSync(file); stamp = `${st.mtimeMs}:${st.size}`; } catch { /* not set */ }
  if (memo.file === file && memo.stamp === stamp) return memo.id;
  let id = null;
  if (stamp !== 'missing') {
    try { id = readFileSync(file, 'utf8').split('\n')[0].trim() || null; } catch { id = null; }
  }
  memo = { file, stamp, id };
  return id;
}

export function writeOverride(id, file = modelFilePath()) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${id}\n`);
  memo = { file: null, stamp: null, id: null };
  return id;
}

export function clearOverride(file = modelFilePath()) {
  try { unlinkSync(file); } catch { /* already gone */ }
  memo = { file: null, stamp: null, id: null };
}

const RESET_WORDS = new Set(['reset', 'default', 'off', 'none', 'clear']);

/**
 * Run the command and return what to say back. Pure apart from the one file
 * write, so the reply text is testable.
 */
export function applyModelCommand(arg, ids, file = modelFilePath()) {
  const current = readOverride(file);
  const wanted = String(arg || '').trim();
  if (!wanted) {
    return { text: statusText(current, ids), model: current || 'openzoo', changed: false };
  }
  if (RESET_WORDS.has(wanted.toLowerCase())) {
    clearOverride(file);
    return {
      text: current
        ? `Cleared the model override (was ${current}). Chats now use whatever the app sends.`
        : 'No model override was set. Chats use whatever the app sends.',
      model: 'openzoo',
      changed: Boolean(current),
    };
  }
  const hit = matchCatalogId(wanted, ids);
  if (!hit) {
    // A catalog we could not reach is NOT a bad name. Refusing here would make
    // the command useless exactly when the gateway is flaky, so take the id as
    // typed and say so — the next real request surfaces a wrong id anyway.
    if (!Array.isArray(ids) || !ids.length) {
      writeOverride(wanted, file);
      return {
        text: `Could not reach the model catalog, so I took "${wanted}" as typed. Every chat from here uses it until you send /model reset.`,
        model: wanted,
        changed: true,
      };
    }
    const near = closestIds(wanted, ids);
    return {
      text: near.length
        ? `No model matches "${wanted}". Closest: ${near.join(', ')}.`
        : `No model matches "${wanted}". Send /model on its own to see some ids.`,
      model: current || 'openzoo',
      changed: false,
    };
  }
  writeOverride(hit, file);
  return {
    text: `Switched to ${hit}. Every chat from here uses it until you send /model reset.`,
    model: hit,
    changed: hit !== current,
  };
}

export function statusText(current, ids) {
  const lines = [current
    ? `Model override: ${current} — every chat uses it until you send /model reset.`
    : 'Model override: none, using what the app sends.'];
  const pop = popularIds(ids);
  if (pop.length) {
    lines.push('', 'Popular ids:');
    for (const id of pop) lines.push(`  ${id}`);
  }
  lines.push('', 'Usage:  /model <name>   ·   /model reset');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Reply synthesisers — one per wire shape the proxy serves
// ---------------------------------------------------------------------------

/** Which of the four paid shapes is this? The reply has to be in the SHAPE the
 *  client parses; a chat.completion sent to Codex's Responses parser is a hard
 *  client error, which reads to the user as "the proxy is broken". */
export function shapeForPath(rawPath) {
  const p = String(rawPath || '');
  if (/\/responses$/.test(p)) return 'responses';
  if (/\/messages$/.test(p)) return 'anthropic';
  return 'chat';
}

export function chatCompletionReply(text, model, now = Date.now()) {
  return {
    id: `chatcmpl-model-${now}`,
    object: 'chat.completion',
    created: Math.floor(now / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export function responsesReply(text, model, now = Date.now()) {
  return {
    id: `resp_model_${now}`,
    object: 'response',
    created_at: Math.floor(now / 1000),
    status: 'completed',
    model,
    output: [{
      type: 'message',
      id: `msg_model_${now}`,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    }],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

/**
 * The Responses SSE script, in the order Codex's parser walks it. Codex
 * ALWAYS streams, so this — not the JSON object above — is the path that
 * actually runs in the app. `sequence_number` increments from 0 on every
 * event: the parser tolerates gaps today, but an out-of-order or missing
 * counter is the first thing that breaks when it stops tolerating them.
 */
export function responsesStreamEvents(text, model, now = Date.now()) {
  const id = `resp_model_${now}`;
  const itemId = `msg_model_${now}`;
  const head = { id, object: 'response', created_at: Math.floor(now / 1000), model };
  const item = (status, content) => ({ type: 'message', id: itemId, status, role: 'assistant', content });
  const finished = item('completed', [{ type: 'output_text', text, annotations: [] }]);
  let seq = 0;
  const ev = (event, data) => ({ event, data: { ...data, sequence_number: seq++ } });
  return [
    ev('response.created', { type: 'response.created', response: { ...head, status: 'in_progress', output: [] } }),
    ev('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: item('in_progress', []) }),
    ev('response.content_part.added', { type: 'response.content_part.added', output_index: 0, item_id: itemId, content_index: 0, part: { type: 'output_text', text: '' } }),
    ev('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, item_id: itemId, content_index: 0, delta: text }),
    ev('response.output_text.done', { type: 'response.output_text.done', output_index: 0, item_id: itemId, content_index: 0, text }),
    ev('response.content_part.done', { type: 'response.content_part.done', output_index: 0, item_id: itemId, content_index: 0, part: { type: 'output_text', text, annotations: [] } }),
    ev('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: finished }),
    ev('response.completed', { type: 'response.completed', response: { ...head, status: 'completed', output: [finished], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }),
  ];
}

export function anthropicReply(text, model, now = Date.now()) {
  return {
    id: `msg_model_${now}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

/** Anthropic's own event script. Same reason as the Responses one: a Messages
 *  client that asked for a stream and got a JSON body sits on a dead socket. */
export function anthropicStreamEvents(text, model, now = Date.now()) {
  const message = { ...anthropicReply('', model, now), content: [], stop_reason: null };
  return [
    { event: 'message_start', data: { type: 'message_start', message } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
}

export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  // Same reason as serveAsSse in proxy.js: a buffering hop in front of us
  // (quick tunnel, nginx) merges frames and the client sees nothing until the
  // end, which looks like a hang.
  'x-accel-buffering': 'no',
  connection: 'keep-alive',
};

export function writeSseEvents(res, events) {
  res.writeHead(200, SSE_HEADERS);
  for (const { event, data } of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

/**
 * Answer the command on the socket, in whatever shape/streaming mode the
 * client asked for. `serveAsSse` is injected rather than imported so this
 * module stays free of proxy.js (which would be a cycle) and so the tests can
 * pass a recording fake.
 */
export function serveModelCommand(res, { rawPath, stream, text, model, serveAsSse, now = Date.now() }) {
  const shape = shapeForPath(rawPath);
  if (shape === 'responses') {
    if (stream) { writeSseEvents(res, responsesStreamEvents(text, model, now)); return shape; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(responsesReply(text, model, now)));
    return shape;
  }
  if (shape === 'anthropic') {
    if (stream) { writeSseEvents(res, anthropicStreamEvents(text, model, now)); return shape; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(anthropicReply(text, model, now)));
    return shape;
  }
  const data = chatCompletionReply(text, model, now);
  if (stream && typeof serveAsSse === 'function') { serveAsSse(res, data, null); return shape; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
  return shape;
}

/** Catalog ids for the CLI, which has no proxy cache to borrow. Soft-fails to
 *  [] so `openzoo model x` still sets an override with the gateway down. */
export async function catalogIds(apiBase = config.apiBase) {
  try {
    const r = await fetch(`${apiBase}/v1/models`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const payload = await r.json();
    return quoteableRows(payload?.data).map((m) => m.id);
  } catch { return []; }
}

/** `openzoo model [id|reset]` — same override file the chat command writes, so
 *  a terminal and the chat box cannot disagree about which model is live. */
export async function cliModel(arg) {
  const ids = await catalogIds();
  const out = applyModelCommand(arg, ids);
  console.log(out.text);
  if (out.changed) console.log('(a running proxy picks this up on its next request — no restart)');
}
