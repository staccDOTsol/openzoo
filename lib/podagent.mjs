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
async function postChat(body, contextId) {
  let r;
  for (let attempt = 0; attempt <= PAYMENT_RETRIES; attempt++) {
    r = await fetch(`${PROXY}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', authorization: 'Bearer sk-openzoo',
        // real leCore memory for this thread, bound via POST /v1/hrr/bind — NOT
        // a fabricated mechanism. Retrieval runs automatically once this header
        // is set; nothing more for the model to invent or explain.
        ...(contextId ? { 'x-hrr-context': contextId } : {}),
      },
      body: JSON.stringify(body),
    });
    if (r.status !== 402 || attempt === PAYMENT_RETRIES) return r;
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

export async function brain(messages, contextId, modelOverride) {
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
    contextId,
  );
  const j = await r.json().catch(() => ({}));
  const content = j?.choices?.[0]?.message?.content;
  return content || (r.ok ? '' : await httpErrorNote(r.status));
}

/** Same call, but streamed — invokes onDelta(text) as tokens arrive (for a
 *  live-typing UI) and resolves with the full accumulated text at the end, so
 *  callers that need to parse a directive out of the complete reply still can. */
export async function brainStream(messages, onDelta, contextId, modelOverride) {
  const vision = hasImages(messages);
  const model = vision ? VISION_MODEL : (modelOverride || MODEL);
  messages = vision ? messages : stripImages(messages);
  const r = await postChat(
    { model, max_tokens: 4096, messages: withModelId(messages, model), plugins: [{ id: 'web' }], stream: true },
    contextId,
  );
  if (!r.ok || !r.body) {
    // fall back to the non-streaming path rather than fail outright
    const content = await r.json().then((j) => j?.choices?.[0]?.message?.content).catch(() => undefined);
    const text = content || (r.ok ? '' : await httpErrorNote(r.status));
    if (text) onDelta(text);
    return text;
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', full = '';
  for (;;) {
    const { value, done } = await reader.read();
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
        const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
        if (delta) { full += delta; onDelta(delta); }
      } catch { /* keep-alive line or partial JSON — ignore */ }
    }
  }
  return full;
}

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
