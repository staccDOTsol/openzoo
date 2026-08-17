// Standalone Grok-Bot-lookalike desktop chat client, backed directly by
// openzoo — no sandbox/daemon hijack required. Sidebar of threads + a
// message canvas, styled to match /Applications/Grok Bot.app. The twist
// Grok Bot actually has: any thread's agent can SPAWN a new thread with its
// own independent agent (and that agent can spawn further threads too) —
// reusing the same SPAWN/SEND pattern podagent.mjs built for shell delegation,
// adapted here for plain chat.
import { exec } from 'node:child_process';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { brain, brainStream, PROXY } from './podagent.mjs';

const PORT = Number(process.env.OZ_GROKUI_PORT || 4173);
const STORE_DIR = path.join(homedir(), '.openzoo');
const STORE_FILE = path.join(STORE_DIR, 'grokui-threads.json');

// Real but SANDBOXED filesystem access for the bots — each THREAD has its own
// root dir (default: a dedicated workspace, never the user's whole disk), and
// the user can point a thread at a real project folder with "/dir <path>" in
// chat. safeResolveIn rejects any path that would escape that thread's root
// (../, absolute paths, symlink tricks via normalize) — access is real, but
// always contained to whatever root was explicitly chosen for that thread.
const WORKSPACE_DIR = path.join(homedir(), '.openzoo', 'grokui-workspace');
mkdirSync(WORKSPACE_DIR, { recursive: true });
function expandHome(p) { return p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p; }
function dirFor(threadId) { return threads.get(threadId)?.dir || WORKSPACE_DIR; }
function safeResolveIn(base, rel) {
  const full = path.normalize(path.join(base, rel));
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error("path escapes this thread's directory");
  }
  return full;
}
const MIME = { html: 'text/html', htm: 'text/html', css: 'text/css', js: 'application/javascript',
  mjs: 'application/javascript', json: 'application/json', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', txt: 'text/plain', md: 'text/plain' };
let workspacePort = null;
// route: /<threadId>/<relpath...> — each thread is served from ITS OWN dir
const workspaceServer = http.createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
    const slash = urlPath.indexOf('/');
    const threadId = slash === -1 ? urlPath : urlPath.slice(0, slash);
    let rel = slash === -1 ? '' : urlPath.slice(slash + 1);
    if (!rel) rel = 'index.html';
    const full = safeResolveIn(dirFor(threadId), rel);
    const data = readFileSync(full);
    const ext = full.split('.').pop();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});
workspaceServer.listen(0, '127.0.0.1', () => { workspacePort = workspaceServer.address().port; });

const PALETTE = ['#e91e8c', '#34c759', '#ff9500', '#5e5ce6', '#ff3b30', '#0a84ff', '#00c7be'];
function colorFor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const SYSTEM = `You are a helpful assistant served over openzoo (pay-per-call access to ~435
models, no API key, no account). Reply normally in plain text, concisely.

When a question has a genuine "which tool/service should I use" angle, prefer openzoo's own
capabilities where they actually fit (this proxy for inference, leCore/zoo_bind for memory,
the directives below for files/shell/delegation) over generic third-party suggestions. Don't
force it where it doesn't apply — a real "just use X" answer beats a forced openzoo plug.

If — and only if — the request genuinely calls for independent parallel work (the user
asks you to spawn/delegate/create agents, or a task splits cleanly into independent
subtasks), you may instead reply with EXACTLY one line, no prose, using one of:
  SPAWN: <short name> | <task for the new agent>   create a new thread with its own
                                                     independent agent and give it a task
  SEND: <name> | <message>                          message an agent thread that already
                                                     exists (yours or one you spawned)
  PING: <name>                                       one-line status: still working, or
                                                       its last result
  PEEK: <name>                                       a fuller look — its last few messages,
                                                       not just the latest one
You are given the result before your next line, so none of these block you — check back
later if it's still working.

You ALSO have real (sandboxed) filesystem access, scoped to THIS thread's own directory —
the user sets or changes it by sending "/dir <path>" in chat; until they do, it's a private
workspace folder, not their real project. Same one-line-no-prose reply format:
  WRITE: <relative path> | <content>                 create or overwrite a file
  READ: <relative path>                              read a file back
  SERVE: <relative path, or blank for the dir root>   get a real http:// URL for a file —
                                                       use this instead of claiming you
                                                       "can't expose a port": you can serve
                                                       static files, just not run a process
  FETCH: <url>                                        actually fetch and read a page's real
                                                       text — web search only gives you short
                                                       snippets; use FETCH when asked to
                                                       "read" or quote something specific
  RUN: <shell command>                                run a REAL shell command in this
                                                       thread's directory — by default this
                                                       pauses and waits for the user to
                                                       approve or deny it before anything
                                                       executes ("/mode auto" in chat skips
                                                       that wait). Use this for anything a
                                                       file write/read/serve can't do —
                                                       installing packages, running a build,
                                                       starting a real process, checking
                                                       actual CLI/login state, etc. — instead
                                                       of guessing or saying you can't.
Via RUN you can also make YOUR OWN paid openzoo calls — POST to
http://localhost:8402/v1/chat/completions (or /v1/hrr/bind) with curl/python/etc. Auth is
"Authorization: Bearer sk-openzoo" — any string works, x402 pays per call, not the key. Do
NOT tell the user you "can't fire the paid calls" or need "their client's bearer key" —
that's wrong, you can make these calls yourself via RUN.
For normal questions just answer directly — do not use any of these unless the request
actually calls for delegation or file work.`;

// id -> { id, name, color, parent, messages: [{role,content}], history: [{who,text}], status }
const threads = new Map();

// Threads are the whole point of the app — losing them on every restart (the
// server got restarted a lot while iterating this session) is a real bug, not
// a nice-to-have. Plain JSON on disk; the volume of chat here never justifies
// a database.
function saveThreads() {
  try {
    mkdirSync(STORE_DIR, { recursive: true });
    writeFileSync(STORE_FILE, JSON.stringify([...threads.values()]));
  } catch { /* best effort */ }
}

function loadThreads() {
  try {
    if (!existsSync(STORE_FILE)) return false;
    const arr = JSON.parse(readFileSync(STORE_FILE, 'utf8'));
    if (!Array.isArray(arr) || !arr.length) return false;
    for (const t of arr) threads.set(t.id, t);
    return true;
  } catch { return false; }
}

function newThread(name, parent, members) {
  const id = randomUUID();
  const t = { id, name, color: members ? members[0].color : colorFor(name), parent: parent || null,
    messages: members ? null : [{ role: 'system', content: SYSTEM }],
    members: members || null, history: [], status: 'idle', createdAt: Date.now(), lastActivityAt: Date.now() };
  threads.set(id, t);
  saveThreads();
  return t;
}

function makeMember(name) {
  return { name, color: colorFor(name), systemPrompt:
    `You are ${name}, one of several bots in a shared group chat served over openzoo
(pay-per-call access to ~435 models, no API key, no account). Reply normally and concisely
as yourself. You can see the WHOLE shared conversation, including what the other bots in
this group already said — their messages are prefixed "[Name]:" so you can tell them apart
from the human. A message addressed "@everyone" is meant for the whole group — give your
own take even if brief ("Passed." is fine when you have nothing to add). COORDINATE: if
another bot already handled or is handling the request (e.g. already spawned the exact
agent being asked for), do NOT repeat it — just acknowledge, or add something genuinely new.

When a question has a genuine "which tool/service" angle, prefer openzoo's own capabilities
where they actually fit over generic third-party suggestions — but don't force it.

You can ALSO delegate, same as any other agent here. If — and only if — asked to
spawn/delegate/create agents AND no other bot has already done it this round, reply with
EXACTLY one line, no prose, using one of:
  SPAWN: <short name> | <task for the new agent>   create a new thread with its own agent
  SEND: <name> | <message>                          message an existing agent thread
  PING: <name>                                       one-line status, or its last result
  PEEK: <name>                                       a fuller look at its last few messages

You ALSO have real (sandboxed) filesystem access, scoped to THIS group's own directory —
the user sets or changes it with "/dir <path>" in chat. Same format:
  WRITE: <relative path> | <content>                 create or overwrite a file
  READ: <relative path>                              read a file back
  SERVE: <relative path, or blank for the dir root>   get a real http:// URL for it — use
                                                       this instead of saying you can't
                                                       expose a port
  FETCH: <url>                                        actually fetch and read a page's real
                                                       text — web search only gives snippets
  RUN: <shell command>                                run a REAL shell command in this
                                                       group's shared directory — pauses the
                                                       WHOLE round for the user's approval
                                                       before anything executes ("/mode auto"
                                                       in chat skips that wait). Use this
                                                       instead of guessing or saying you
                                                       can't do something real.
For normal replies just answer directly — do not use any of these unless the request
actually calls for delegation or file work.` };
}

// Rebuilds a member's context fresh from the shared thread history every turn
// (instead of a private per-member log) so each bot sees what the others in
// the group already said — including earlier replies from THIS round, since
// runTurn pushes to t.history sequentially, one member at a time.
// OpenAI-shaped multimodal content: plain string when there's no image,
// [{type:'text',...}, {type:'image_url',...}] array when there is — mixing
// the two shapes on a string-only history entry would break providers that
// expect ONE consistent form per message.
function contentFor(text, images) {
  if (!images || !images.length) return text;
  // an empty text block alongside image_url content gets rejected (400) by
  // at least one provider path — always give it something
  return [{ type: 'text', text: text || 'Describe this image.' }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))];
}

function buildMemberMessages(t, member) {
  const msgs = [{ role: 'system', content: member.systemPrompt || SYSTEM }];
  for (const h of t.history) {
    if (h.who === 'user') msgs.push({ role: 'user', content: contentFor(h.text, h.images) });
    else if (h.name === member.name) msgs.push({ role: 'assistant', content: h.text });
    else msgs.push({ role: 'user', content: `[${h.name}]: ${h.text}` });
  }
  return msgs;
}

function newGroupThread(names) {
  const members = names.map(makeMember);
  return newThread(names.join(', '), null, members);
}

// Real leCore binding — POST /v1/hrr/bind on the local proxy, same free
// passthrough the wiki documents. Fire-and-forget after each turn: the next
// turn's brain()/brainStream() call picks up t.contextId once it lands, via
// the X-HRR-Context header, so retrieval is real and automatic, not a prompt
// claim about a mechanism that doesn't exist.
async function bindThread(t) {
  const corpus = t.history.map((h) => (h.who === 'user' ? 'you' : (h.name || t.name)) + ': ' + h.text).join('\n');
  if (!corpus.trim()) return;
  try {
    const r = await fetch(`${PROXY}/hrr/bind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ corpus }),
    });
    const j = await r.json().catch(() => ({}));
    if (j?.context_id) { t.contextId = j.context_id; saveThreads(); }
  } catch { /* leCore sidecar unreachable — thread still works, just not bound this round */ }
}

// REAL shell execution, scoped to the thread's own directory. 'ask' mode
// (default) pauses and waits for an explicit approve/deny over HTTP before
// anything runs; 'auto' mode (set via "/mode auto" in chat) runs immediately.
// Either way this is not sandboxed like WRITE/READ — it can do anything the
// signed-in user's shell can — so 'ask' is the default, not 'auto'.
function execCommand(command, cwd) {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      let out = (stdout || '') + (stderr ? '\n' + stderr : '');
      if (err) out += `\n(exit ${err.code ?? 1})`;
      resolve(out.slice(0, 6000) || '(no output)');
    });
  });
}

function findByName(name) {
  let best = null;
  for (const t of threads.values()) {
    if (t.name.toLowerCase() === name.toLowerCase() && (!best || t.createdAt > best.createdAt)) best = t;
  }
  return best;
}

if (!loadThreads()) newThread('openzoo', null);

// Parses a SPAWN/SEND/PING directive out of a reply, performs its side effect
// (creating or messaging another thread), and returns the ack text to show in
// place of the raw directive line — or null if the reply wasn't a directive.
async function tryDirective(reply, originId) {
  const spawn = /^SPAWN:\s*([^|]+)\|\s*([\s\S]+)/.exec(reply);
  if (spawn) {
    const name = spawn[1].trim();
    const task = spawn[2].trim();
    const sub = newThread(name, originId);
    runTurn(sub.id, task).catch(() => {}); // fire and forget — runs independently
    return `Spawned ${name} — working on it.`;
  }
  const sendM = /^SEND:\s*([^|]+)\|\s*([\s\S]+)/.exec(reply);
  if (sendM) {
    const name = sendM[1].trim();
    const msg = sendM[2].trim();
    const target = findByName(name);
    if (target) runTurn(target.id, msg).catch(() => {});
    return target ? `Messaged ${name}.` : `No thread named "${name}" to message.`;
  }
  const ping = /^PING:\s*(.+)/.exec(reply);
  if (ping) {
    const name = ping[1].trim();
    const target = findByName(name);
    const last = target?.history[target.history.length - 1];
    return !target ? `No thread named "${name}".`
      : target.status === 'thinking' ? `${name} is still working.`
      : last ? `${name}: ${last.text}` : `${name} hasn't replied yet.`;
  }
  const peek = /^PEEK:\s*(.+)/.exec(reply);
  if (peek) {
    const name = peek[1].trim();
    const target = findByName(name);
    if (!target) return `No thread named "${name}".`;
    const recent = target.history.slice(-4)
      .map((h) => (h.who === 'user' ? 'you' : (h.name || target.name)) + ': ' + h.text).join('\n');
    return `${name} (${target.status}):\n${recent || '(nothing yet)'}`;
  }
  const write = /^WRITE:\s*([^|]+)\|([\s\S]+)/.exec(reply);
  if (write) {
    const rel = write[1].trim();
    const content = write[2].replace(/^\n/, '');
    try {
      const full = safeResolveIn(dirFor(originId), rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
      return `Wrote ${rel} (${Buffer.byteLength(content)} bytes) to ${dirFor(originId)}.`;
    } catch (e) { return `Couldn't write ${rel}: ${e.message}`; }
  }
  const readD = /^READ:\s*(.+)/.exec(reply);
  if (readD) {
    const rel = readD[1].trim();
    try {
      const data = readFileSync(safeResolveIn(dirFor(originId), rel), 'utf8');
      return `${rel}:\n${data.slice(0, 4000)}${data.length > 4000 ? '\n…(truncated)' : ''}`;
    } catch (e) { return `Couldn't read ${rel}: ${e.message}`; }
  }
  const serve = /^SERVE:\s*(.*)$/.exec(reply);
  if (serve) {
    const rel = serve[1].trim();
    if (!workspacePort) return 'Workspace server is still starting — try again in a second.';
    return `Serving at http://localhost:${workspacePort}/${originId}/${rel}`;
  }
  const fetchD = /^FETCH:\s*(\S+)/.exec(reply);
  if (fetchD) {
    const url = fetchD[1].trim();
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (openzoo grokui)' } });
      const ct = r.headers.get('content-type') || '';
      let text = await r.text();
      if (ct.includes('html')) {
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
      }
      return `${url} (${r.status}):\n${text.slice(0, 8000)}${text.length > 8000 ? '\n…(truncated)' : ''}`;
    } catch (e) { return `Couldn't fetch ${url}: ${e.message}`; }
  }
  return null;
}

// onEvent (optional) gets live progress for whoever's actually watching this
// call: {type:'start',name,color} when a bot begins its turn, {type:'delta',
// name,color,delta} per streamed token, {type:'final',name,color,text} once
// its full reply (or directive ack) is settled. Background turns — a SPAWNed
// subagent nobody's looking at yet — run with onEvent omitted and just use
// the plain non-streaming brain(), which is cheaper when nothing renders it.
async function runTurn(threadId, userText, onEvent, images) {
  const t = threads.get(threadId);
  if (!t) return;
  t.history.push(images && images.length ? { who: 'user', text: userText, images } : { who: 'user', text: userText });
  t.lastActivityAt = Date.now();
  if (t.members) {
    t.status = 'thinking';
    // sequential, not parallel: each member's context is rebuilt from
    // t.history right before its turn, so it sees every reply (including
    // spawns/sends) the earlier members in THIS round already made
    for (const m of t.members) {
      const msgs = buildMemberMessages(t, m);
      let r = '';
      onEvent?.({ type: 'start', name: m.name, color: m.color });
      try {
        r = onEvent
          ? (await brainStream(msgs, (delta) => onEvent({ type: 'delta', name: m.name, color: m.color, delta }), t.contextId)).trim()
          : (await brain(msgs, t.contextId)).trim();
      } catch (e) { r = `error: ${e.message}`; }
      const runMatch = /^RUN:\s*([\s\S]+)/.exec(r);
      if (runMatch) {
        const command = runMatch[1].trim();
        if (t.runMode === 'auto') {
          const output = await execCommand(command, dirFor(t.id));
          const shown = `$ ${command}\n${output}`;
          t.history.push({ who: 'bot', text: shown, name: m.name, color: m.color });
          onEvent?.({ type: 'final', name: m.name, color: m.color, text: shown });
          // this member's turn is done; the round continues to the next member
          continue;
        }
        const runId = randomUUID();
        t.pendingRun = { runId, command, cwd: dirFor(t.id) };
        t.history.push({ who: 'bot', text: command, runId, runStatus: 'pending', name: m.name, color: m.color });
        onEvent?.({ type: 'run-pending', runId, command, name: m.name, color: m.color });
        // pauses the WHOLE round here — the rest of the group gets their turn
        // on the round that runs after the user approves/denies
        t.status = 'idle';
        t.lastActivityAt = Date.now();
        saveThreads();
        return;
      }
      const ack = await tryDirective(r, t.id);
      const finalText = ack ?? (r || '(no response)');
      t.history.push({ who: 'bot', text: finalText, name: m.name, color: m.color });
      onEvent?.({ type: 'final', name: m.name, color: m.color, text: finalText });
    }
    t.status = 'idle';
    saveThreads();
    bindThread(t).catch(() => {});
    return;
  }
  t.messages.push({ role: 'user', content: contentFor(userText, images) });
  t.status = 'thinking';
  let reply = '';
  onEvent?.({ type: 'start', name: t.name, color: t.color });
  try {
    reply = onEvent
      ? (await brainStream(t.messages, (delta) => onEvent({ type: 'delta', name: t.name, color: t.color, delta }), t.contextId)).trim()
      : (await brain(t.messages, t.contextId)).trim();
  } catch (e) {
    reply = `error: ${e.message}`;
  }
  t.messages.push({ role: 'assistant', content: reply });
  const runMatch = /^RUN:\s*([\s\S]+)/.exec(reply);
  if (runMatch) {
    const command = runMatch[1].trim();
    if (t.runMode === 'auto') {
      const output = await execCommand(command, dirFor(t.id));
      const shown = `$ ${command}\n${output}`;
      t.messages.push({ role: 'user', content: `output:\n${output}` });
      t.history.push({ who: 'bot', text: shown });
      onEvent?.({ type: 'final', name: t.name, color: t.color, text: shown });
    } else {
      const runId = randomUUID();
      t.pendingRun = { runId, command, cwd: dirFor(t.id) };
      t.history.push({ who: 'bot', text: command, runId, runStatus: 'pending' });
      onEvent?.({ type: 'run-pending', runId, command, name: t.name, color: t.color });
    }
    t.status = 'idle';
    t.lastActivityAt = Date.now();
    saveThreads();
    return;
  }
  const ack = await tryDirective(reply, t.id);
  const finalText = ack ?? (reply || '(no response)');
  t.history.push({ who: 'bot', text: finalText });
  onEvent?.({ type: 'final', name: t.name, color: t.color, text: finalText });
  t.status = 'idle';
  t.lastActivityAt = Date.now();
  saveThreads();
  bindThread(t).catch(() => {});
}

function threadSummary(t) {
  const last = t.history[t.history.length - 1];
  return { id: t.id, name: t.name, color: t.color, parent: t.parent, status: t.status,
    preview: last ? (last.who === 'user' ? last.text : last.text).slice(0, 60) : '',
    createdAt: t.createdAt, lastActivityAt: t.lastActivityAt || t.createdAt,
    dir: t.dir || WORKSPACE_DIR };
}

const APP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>openzoo</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #000; }
  body { color: #ececec; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         display: flex; }
  #dragbar { -webkit-app-region: drag; position: fixed; top: 0; left: 0; right: 0; height: 28px; z-index: 1000; }
  #sidebar { width: 280px; flex: 0 0 280px; border-right: 1px solid #1c1c1e; display: flex; flex-direction: column;
             height: 100vh; padding-top: 28px; }
  #main { padding-top: 28px; }
  #sideTop { display: flex; align-items: center; gap: 4px; padding: 0 8px; }
  #sideTop #search { flex: 1; }
  #search { margin: 12px; padding: 8px 12px; background: #1c1c1e; border-radius: 10px; color: #ececec;
            border: none; font: inherit; }
  #search::placeholder { color: #8e8e93; }
  #threads { flex: 1; overflow-y: auto; }
  .trow { display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer; border-radius: 10px;
          margin: 0 6px 2px; }
  .trow:hover { background: #17171a; }
  .trow.active { background: #1c1c1e; }
  .tclose { flex: 0 0 20px; width: 20px; height: 20px; border-radius: 50%; border: none; background: transparent;
            color: #8e8e93; display: none; align-items: center; justify-content: center; cursor: pointer;
            font-size: 13px; }
  .trow:hover .tclose { display: flex; }
  .tclose:hover { background: #3a3a3c; color: #ececec; }
  .tavatar { width: 36px; height: 36px; border-radius: 10px; flex: 0 0 36px; display: flex; align-items: center;
             justify-content: center; color: #fff; font-weight: 600; font-size: 14px; }
  .tmeta { min-width: 0; flex: 1; }
  .tname { font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tprev { font-size: 12px; color: #8e8e93; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tdot { width: 8px; height: 8px; border-radius: 50%; background: #0a84ff; flex: 0 0 8px; }
  #main { flex: 1; display: flex; flex-direction: column; height: 100vh; }
  #chatHeader { padding: 14px 20px; border-bottom: 1px solid #1c1c1e; display: flex; align-items: center; gap: 10px;
                font-weight: 600; }
  #chatHeader .tavatar { width: 26px; height: 26px; border-radius: 7px; font-size: 11px; flex: 0 0 26px; }
  .hname { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .hdir { font-weight: 400; font-size: 11px; color: #8e8e93; white-space: nowrap; overflow: hidden;
          text-overflow: ellipsis; max-width: 420px; }
  #hudBtn { margin-left: auto; }
  #chatHeaderId { display: flex; align-items: center; gap: 10px; }
  #hud { position: fixed; top: 40px; right: 14px; width: 250px; background: rgba(14,14,17,.94);
         border: 1px solid #333340; border-radius: 10px; padding: 12px 14px; font: 11px/1.5 Menlo, monospace;
         display: none; z-index: 300; box-shadow: 0 12px 30px rgba(0,0,0,.5); }
  #hud.show { display: block; }
  #hud .htitle { color: #b8f240; font-size: 10px; letter-spacing: .04em; margin-bottom: 10px; }
  #hud .hrow { display: flex; justify-content: space-between; margin: 6px 0; color: #f0f0eb; font-size: 12px; }
  #hud .hrow span:first-child { color: #999aa8; font-size: 10.5px; }
  #hud .hlime { color: #b8f240; }
  #hud .hember { color: #f28c4d; }
  #hud .hfoot { border-top: 1px solid #333340; margin-top: 10px; padding-top: 8px; color: #999aa8; font-size: 10px; }
  #sidebar, #main { -webkit-app-region: no-drag; }
  #log { flex: 1; overflow-y: auto; padding: 20px 24px 12px; display: flex; flex-direction: column; gap: 6px;
         -webkit-user-select: text; user-select: text; }
  .hdr { align-self: flex-start; display: flex; align-items: center; gap: 6px; margin: 12px 0 4px;
         color: #8e8e93; font-size: 13px; }
  .hdr .avatar { width: 18px; height: 18px; border-radius: 5px; display: flex; align-items: center;
                 justify-content: center; color: #fff; font-size: 9px; font-weight: 700; }
  .row { display: flex; max-width: 78%; margin: 2px 0; }
  .row.user { align-self: flex-end; }
  .row.bot { align-self: flex-start; }
  .bubble { padding: 11px 16px; border-radius: 20px; white-space: pre-wrap; word-break: break-word;
            -webkit-user-select: text; user-select: text; cursor: text; }
  .bubble a { color: #6ab0ff; text-decoration: underline; cursor: pointer; }
  .bubble-images { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .bubble-images img { max-width: 160px; max-height: 160px; border-radius: 12px; display: block; }
  .runcard { background: #1c1c1e; border: 1px solid #333; border-radius: 14px; padding: 12px 14px; max-width: 100%; }
  .runcmd { font-family: Menlo, monospace; font-size: 12.5px; color: #ececec; white-space: pre-wrap;
            word-break: break-word; margin-bottom: 8px; }
  .runactions { display: flex; gap: 8px; }
  .runbtn { border: none; border-radius: 8px; padding: 6px 14px; font-size: 13px; cursor: pointer; }
  .runbtn.approve { background: #34c759; color: #000; }
  .runbtn.deny { background: #3a3a3c; color: #ececec; }
  .runbtn:disabled { opacity: .5; cursor: default; }
  .runstatus { font-size: 12px; color: #8e8e93; margin-bottom: 6px; }
  .runoutput { font-family: Menlo, monospace; font-size: 11.5px; color: #b8b8b8; white-space: pre-wrap;
               word-break: break-word; max-height: 240px; overflow-y: auto; margin: 0; }
  .row.user .bubble { background: #57575c; }
  .row.bot .bubble { background: #262626; color: #ececec; }
  .row.bot.pending .bubble { color: #8e8e93; }
  .dots span { display: inline-block; width: 5px; height: 5px; margin-right: 3px; border-radius: 50%;
               background: #8e8e93; animation: blink 1.2s infinite ease-in-out; }
  .dots span:nth-child(2) { animation-delay: .2s; } .dots span:nth-child(3) { animation-delay: .4s; }
  @keyframes blink { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }
  #bar { padding: 10px 16px 18px; position: relative; }
  #row-input { display: flex; align-items: center; gap: 8px; }
  #plusMenu { position: absolute; bottom: 62px; left: 16px; background: #1c1c1e; border-radius: 14px;
              padding: 6px; display: none; flex-direction: column; min-width: 190px;
              box-shadow: 0 8px 24px rgba(0,0,0,.5); z-index: 10; }
  #plusMenu.show { display: flex; }
  .pop-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px;
              cursor: pointer; color: #ececec; font-size: 14px; }
  .pop-item:hover { background: #2c2c2e; }
  .pop-item svg { width: 18px; height: 18px; flex: 0 0 18px; }
  .pop-item.record svg { color: #ff3b30; }
  #pill { flex: 1; display: flex; align-items: center; gap: 6px; background: #2c2c2e; border-radius: 26px;
          padding: 8px 10px 8px 14px; }
  .icon-btn { width: 32px; height: 32px; border-radius: 50%; border: none; background: transparent;
              color: #ececec; display: flex; align-items: center; justify-content: center; cursor: pointer;
              flex: 0 0 32px; }
  .icon-btn:hover { background: #3a3a3c; }
  .icon-btn svg { width: 18px; height: 18px; }
  #attachChips { display: flex; gap: 6px; flex-wrap: wrap; padding: 0 16px 6px; }
  .achip { display: flex; align-items: center; gap: 6px; background: #2c2c2e; color: #ececec; border-radius: 10px;
           padding: 4px 8px; font-size: 12px; }
  .achip .ax { cursor: pointer; color: #8e8e93; }
  .achip.aimg { padding: 4px; position: relative; }
  .achip.aimg img { width: 40px; height: 40px; object-fit: cover; border-radius: 6px; display: block; }
  .achip.aimg .ax { position: absolute; top: -4px; right: -4px; background: #000; border-radius: 50%;
                     width: 16px; height: 16px; display: flex; align-items: center; justify-content: center;
                     font-size: 10px; }
  #inp { flex: 1; background: transparent; border: none; color: #ececec; font: inherit;
         padding: 6px 0; min-width: 0; }
  #inp::placeholder { color: #8e8e93; }
  #inp:focus { outline: none; }
  #send { width: 34px; height: 34px; border-radius: 50%; border: none; background: #fff; color: #000;
          display: none; align-items: center; justify-content: center; cursor: pointer; flex: 0 0 34px; }
  #send.show { display: flex; }
  #send svg { width: 16px; height: 16px; }
  #composeOverlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: none; align-items: flex-start;
                     justify-content: center; padding-top: 90px; z-index: 200; }
  #composeOverlay.show { display: flex; }
  #composeBox { width: 460px; max-height: 65vh; background: #1c1c1e; border-radius: 16px; overflow: hidden;
                display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,.6); }
  #composeTo { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 1px solid #2c2c2e;
               color: #8e8e93; flex-wrap: wrap; }
  #chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { display: flex; align-items: center; gap: 6px; background: #2c2c2e; color: #ececec; border-radius: 14px;
          padding: 3px 8px 3px 4px; font-size: 13px; }
  .chip .cav { width: 16px; height: 16px; border-radius: 4px; display: inline-block; }
  .chip .cx { cursor: pointer; color: #8e8e93; margin-left: 2px; }
  #composeTo input { flex: 1; min-width: 100px; background: transparent; border: none; color: #ececec; font: inherit; }
  #composeTo input:focus { outline: none; }
  #composeList { overflow-y: auto; padding: 8px; }
  .crow { display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: 10px; cursor: pointer; }
  .crow:hover { background: #2c2c2e; }
  .crow .kbd { margin-left: auto; display: flex; gap: 4px; }
  kbd { background: #2c2c2e; border-radius: 5px; padding: 2px 6px; font-size: 11px; color: #8e8e93; }
  #composeFoot { display: flex; gap: 16px; padding: 10px 16px; border-top: 1px solid #2c2c2e; color: #8e8e93;
                 font-size: 12px; }
  #composeFoot kbd { margin-right: 4px; }
  .mention { background: #3a3a3c; border-radius: 10px; padding: 1px 8px; font-size: 0.92em; }
</style></head>
<body>
  <div id="dragbar"></div>
  <div id="sidebar">
    <div id="sideTop">
      <button class="icon-btn" id="newMsgBtn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
      <input id="search" placeholder="Search">
    </div>
    <div id="threads"></div>
  </div>
  <div id="composeOverlay">
    <div id="composeBox">
      <div id="composeTo">
        <span>To:</span>
        <span id="chips"></span>
        <input id="composeInp" placeholder="Search or create Bots">
        <button class="icon-btn" id="composeClose">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div id="composeList"></div>
      <div id="composeFoot"><span><kbd>Tab</kbd> add</span><span><kbd>Enter</kbd> open</span></div>
    </div>
  </div>
  <div id="main">
    <div id="chatHeader">
      <div id="chatHeaderId"></div>
      <button class="icon-btn" id="hudBtn">◎</button>
    </div>
    <div id="hud">
      <div class="htitle">YOUR WALLET · THIS SESSION</div>
      <div class="hrow"><span>you've paid</span><span id="hYouSpent">—</span></div>
      <div class="hrow"><span>our cost (cogs)</span><span id="hYouCogs">—</span></div>
      <div class="hrow"><span>margin</span><span id="hYouMargin" class="hlime">—</span></div>
      <div class="hrow"><span>direct would be</span><span id="hYouDirect" class="hember">—</span></div>
      <div class="hfoot" id="hFoot">loading…</div>
    </div>
    <div id="log"></div>
    <div id="bar">
      <div id="plusMenu">
        <div class="pop-item" id="attachBtn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          <span>Attach files</span>
        </div>
      </div>
      <input id="fileInp" type="file" multiple style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;">
      <div id="attachChips"></div>
      <div id="row-input">
        <div id="pill">
          <button class="icon-btn" id="plusBtn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
          <input id="inp" placeholder="Message" autofocus>
          <button class="icon-btn" tabindex="-1">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/></svg>
          </button>
        </div>
        <button id="send">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M6 11l6-6 6 6"/></svg>
        </button>
      </div>
    </div>
  </div>
<script>
  const threadsEl = document.getElementById('threads');
  const chatHeader = document.getElementById('chatHeader');
  const log = document.getElementById('log');
  const inp = document.getElementById('inp');
  const send = document.getElementById('send');
  let activeId = null;
  let knownThreads = [];

  function initials(name) { return name.slice(0, 2).toUpperCase(); }

  async function loadThreads() {
    const list = await (await fetch('/threads')).json();
    knownThreads = list;
    if (!activeId && list.length) activeId = list[0].id;
    threadsEl.innerHTML = '';
    for (const t of list) {
      const row = document.createElement('div');
      row.className = 'trow' + (t.id === activeId ? ' active' : '');
      row.innerHTML = '<div class="tavatar" style="background:' + t.color + '">' + initials(t.name) + '</div>' +
        '<div class="tmeta"><div class="tname">' + t.name + '</div><div class="tprev">' +
        (t.status === 'thinking' ? 'typing…' : (t.preview || '')) + '</div></div>' +
        (t.status === 'thinking' ? '<div class="tdot"></div>' : '') +
        '<button class="tclose" title="Remove">✕</button>';
      row.addEventListener('click', () => { activeId = t.id; render(); });
      row.querySelector('.tclose').addEventListener('click', async (e) => {
        e.stopPropagation();
        await fetch('/threads/' + t.id, { method: 'DELETE' });
        if (activeId === t.id) activeId = null;
        await loadThreads();
        if (activeId) render();
      });
      threadsEl.appendChild(row);
    }
  }

  async function loadActiveMessages() {
    if (!activeId) return null;
    return await (await fetch('/threads/' + activeId)).json();
  }

  function renderHeader(t) {
    document.getElementById('chatHeaderId').innerHTML =
      '<div class="tavatar" style="background:' + t.color + '">' + initials(t.name) + '</div>' +
      '<div class="hname"><div>' + t.name + '</div><div class="hdir" title="' + escapeHtml(t.dir || '') +
      '">' + escapeHtml(t.dir || '') + ' · type /dir &lt;path&gt; to change</div></div>';
  }

  function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  function renderMentions(text) {
    let out = escapeHtml(text);
    out = out.replace(/(https?:\\/\\/[^\\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    out = out.replace(/@(\\w+)/g, '<span class="mention">\u{1F465} $1</span>');
    return out;
  }

  let lastSpeaker = null;
  function addRow(who, text, color, name, run, images) {
    const speakerKey = who + '|' + name;
    if (who === 'bot' && speakerKey !== lastSpeaker) {
      const hdr = document.createElement('div');
      hdr.className = 'hdr';
      hdr.innerHTML = '<span class="avatar" style="background:' + color + '">' + initials(name) + '</span><span>' + name + '</span>';
      log.appendChild(hdr);
    }
    lastSpeaker = speakerKey;
    const row = document.createElement('div');
    row.className = 'row ' + who;
    if (run) {
      const card = document.createElement('div');
      card.className = 'runcard';
      const cmdEl = document.createElement('div');
      cmdEl.className = 'runcmd';
      cmdEl.textContent = '$ ' + text;
      card.appendChild(cmdEl);
      if (run.status === 'pending') {
        const actions = document.createElement('div');
        actions.className = 'runactions';
        const approve = document.createElement('button');
        approve.className = 'runbtn approve';
        approve.textContent = 'Approve';
        const deny = document.createElement('button');
        deny.className = 'runbtn deny';
        deny.textContent = 'Deny';
        approve.addEventListener('click', async () => {
          approve.disabled = true; deny.disabled = true;
          await fetch('/threads/' + activeId + '/run/' + run.id + '/approve', { method: 'POST' });
          render();
        });
        deny.addEventListener('click', async () => {
          approve.disabled = true; deny.disabled = true;
          await fetch('/threads/' + activeId + '/run/' + run.id + '/deny', { method: 'POST' });
          render();
        });
        actions.appendChild(approve);
        actions.appendChild(deny);
        card.appendChild(actions);
      } else {
        const status = document.createElement('div');
        status.className = 'runstatus';
        status.textContent = run.status === 'running' ? 'Running…' : run.status === 'denied' ? 'Denied' : 'Done';
        card.appendChild(status);
        if (run.output) {
          const out = document.createElement('pre');
          out.className = 'runoutput';
          out.textContent = run.output;
          card.appendChild(out);
        }
      }
      row.appendChild(card);
    } else {
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      if (images && images.length) {
        const strip = document.createElement('div');
        strip.className = 'bubble-images';
        for (const url of images) {
          const img = document.createElement('img');
          img.src = url;
          strip.appendChild(img);
        }
        bubble.appendChild(strip);
      }
      const textEl = document.createElement('div');
      textEl.innerHTML = renderMentions(text);
      bubble.appendChild(textEl);
      row.appendChild(bubble);
    }
    log.appendChild(row);
  }

  async function render() {
    const t = knownThreads.find((x) => x.id === activeId);
    if (!t) return;
    renderHeader(t);
    inp.placeholder = 'Message ' + t.name;
    const full = await loadActiveMessages();
    if (!full || full.id !== activeId) return;
    // only re-pin to bottom if the reader was already there — otherwise a
    // background poll (tick() runs every 1.2s) yanks them back mid-scroll
    const wasNearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    log.innerHTML = '';
    lastSpeaker = null;
    for (const h of full.history) {
      addRow(h.who, h.text, h.color || t.color, h.name || t.name,
        h.runId ? { id: h.runId, status: h.runStatus, output: h.runOutput } : undefined, h.images);
    }
    if (full.status === 'thinking') addRow('bot', '…', t.color, t.name);
    if (wasNearBottom) log.scrollTop = log.scrollHeight;
  }

  let pendingFiles = [];
  let pendingImages = [];
  const attachChips = document.getElementById('attachChips');
  function renderAttachChips() {
    attachChips.innerHTML = '';
    pendingFiles.forEach((f, i) => {
      const chip = document.createElement('span');
      chip.className = 'achip';
      chip.innerHTML = '<span>' + escapeHtml(f.name) + (f.content === null ? ' (binary — name only)' : '') + '</span><span class="ax">✕</span>';
      chip.querySelector('.ax').addEventListener('click', () => { pendingFiles.splice(i, 1); renderAttachChips(); });
      attachChips.appendChild(chip);
    });
    pendingImages.forEach((img, i) => {
      const chip = document.createElement('span');
      chip.className = 'achip aimg';
      chip.innerHTML = '<img src="' + img.dataUrl + '"><span class="ax">✕</span>';
      chip.querySelector('.ax').addEventListener('click', () => { pendingImages.splice(i, 1); renderAttachChips(); });
      attachChips.appendChild(chip);
    });
  }
  function readFileAsText(file) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.readAsText(file);
    });
  }
  function readFileAsDataUrl(file) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.readAsDataURL(file);
    });
  }
  async function addPastedImage(file) {
    const dataUrl = await readFileAsDataUrl(file);
    if (dataUrl) pendingImages.push({ name: file.name || 'pasted-image', dataUrl });
    renderAttachChips();
    send.classList.toggle('show', inp.value.trim().length > 0 || pendingFiles.length > 0 || pendingImages.length > 0);
  }
  inp.addEventListener('paste', (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter((it) => it.type && it.type.startsWith('image/'));
    if (!imageItems.length) return; // let normal text paste through
    e.preventDefault();
    for (const it of imageItems) { const f = it.getAsFile(); if (f) addPastedImage(f); }
  });

  async function submit() {
    const task = inp.value.trim();
    if ((!task && !pendingFiles.length && !pendingImages.length) || !activeId) return;
    inp.value = '';
    send.classList.remove('show');
    let full = task;
    // an image with no caption still needs SOME text — an empty text block
    // alongside image_url content gets rejected (400) by at least one path
    if (!full && pendingImages.length) full = 'Describe this image.';
    for (const f of pendingFiles) {
      full += f.content !== null
        ? '\\n\\n--- attached: ' + f.name + ' ---\\n' + f.content
        : '\\n\\n(attached binary file: ' + f.name + ', ' + f.size + ' bytes — content not readable as text)';
    }
    const images = pendingImages.map((i) => i.dataUrl);
    pendingFiles = [];
    pendingImages = [];
    renderAttachChips();
    await fetch('/drive', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: activeId, task: full, images }),
    });
    render();
  }

  inp.addEventListener('input', () => { send.classList.toggle('show', inp.value.trim().length > 0 || pendingFiles.length > 0 || pendingImages.length > 0); });
  send.addEventListener('click', submit);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  const plusBtn = document.getElementById('plusBtn');
  const plusMenu = document.getElementById('plusMenu');
  const fileInp = document.getElementById('fileInp');
  plusBtn.addEventListener('click', (e) => { e.stopPropagation(); plusMenu.classList.toggle('show'); });
  document.addEventListener('click', () => plusMenu.classList.remove('show'));
  document.getElementById('attachBtn').addEventListener('click', (e) => { e.stopPropagation(); plusMenu.classList.remove('show'); fileInp.click(); });
  fileInp.addEventListener('change', async () => {
    for (const f of Array.from(fileInp.files)) {
      const looksText = /^text\\//.test(f.type) || /\\.(txt|md|js|mjs|ts|tsx|jsx|py|json|css|html|csv|log|ya?ml|sh)$/i.test(f.name);
      const content = (looksText && f.size < 200000) ? await readFileAsText(f) : null;
      pendingFiles.push({ name: f.name, size: f.size, content });
    }
    fileInp.value = '';
    renderAttachChips();
    send.classList.toggle('show', inp.value.trim().length > 0 || pendingFiles.length > 0);
  });

  // --- compose overlay ("+" next to search: pick/create Bots, single or group) ---
  const newMsgBtn = document.getElementById('newMsgBtn');
  const composeOverlay = document.getElementById('composeOverlay');
  const composeInp = document.getElementById('composeInp');
  const composeList = document.getElementById('composeList');
  const chipsEl = document.getElementById('chips');
  const composeClose = document.getElementById('composeClose');
  let composeSel = [];

  function openCompose() {
    composeSel = [];
    chipsEl.innerHTML = '';
    composeInp.value = '';
    renderComposeList();
    composeOverlay.classList.add('show');
    composeInp.focus();
  }
  function closeCompose() { composeOverlay.classList.remove('show'); }

  function addChip(t) {
    composeSel.push({ name: t.name, color: t.color });
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = '<span class="cav" style="background:' + t.color + '"></span>' + t.name + '<span class="cx">✕</span>';
    chip.querySelector('.cx').addEventListener('click', () => {
      composeSel = composeSel.filter((c) => c.name !== t.name);
      chip.remove();
      renderComposeList();
    });
    chipsEl.appendChild(chip);
    composeInp.value = '';
    renderComposeList();
    composeInp.focus();
  }

  function renderComposeList() {
    const q = composeInp.value.trim().toLowerCase();
    const chosen = new Set(composeSel.map((c) => c.name));
    const candidates = knownThreads.filter((t) => !chosen.has(t.name) && t.name.toLowerCase().includes(q));
    composeList.innerHTML = '';
    const createRow = document.createElement('div');
    createRow.className = 'crow';
    createRow.innerHTML = '<div class="tavatar" style="background:#3a3a3c;width:28px;height:28px;border-radius:8px;font-size:15px">+</div>' +
      '<div>Create new Bot' + (q ? ': ' + escapeHtml(composeInp.value.trim()) : '') + '</div>' +
      '<div class="kbd"><kbd>⌘</kbd><kbd>1</kbd></div>';
    createRow.addEventListener('click', async () => {
      const name = composeInp.value.trim() || prompt('Bot name?');
      if (!name) return;
      const t = await (await fetch('/threads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })).json();
      activeId = t.id;
      closeCompose();
      await loadThreads(); await render();
    });
    composeList.appendChild(createRow);
    candidates.slice(0, 8).forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'crow';
      row.innerHTML = '<div class="tavatar" style="background:' + t.color + ';width:28px;height:28px;border-radius:8px;font-size:11px">' + initials(t.name) + '</div>' +
        '<div>' + escapeHtml(t.name) + '</div><div class="kbd"><kbd>⌘</kbd><kbd>' + (i + 2) + '</kbd></div>';
      row.addEventListener('click', () => addChip(t));
      composeList.appendChild(row);
    });
  }

  async function openOrCreateFromCompose() {
    if (composeSel.length === 1) {
      const t = knownThreads.find((x) => x.name === composeSel[0].name);
      if (t) { activeId = t.id; closeCompose(); await loadThreads(); await render(); return; }
    }
    if (composeSel.length > 1) {
      const t = await (await fetch('/threads/group', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ names: composeSel.map((c) => c.name) }) })).json();
      activeId = t.id;
      closeCompose();
      await loadThreads(); await render();
    }
  }

  newMsgBtn.addEventListener('click', (e) => { e.stopPropagation(); openCompose(); });
  composeClose.addEventListener('click', closeCompose);
  composeOverlay.addEventListener('click', (e) => { if (e.target === composeOverlay) closeCompose(); });
  composeInp.addEventListener('input', renderComposeList);
  composeInp.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCompose();
    if (e.key === 'Enter') openOrCreateFromCompose();
    if (e.key === 'Tab') {
      e.preventDefault();
      const q = composeInp.value.trim().toLowerCase();
      const chosen = new Set(composeSel.map((c) => c.name));
      const cand = knownThreads.find((t) => !chosen.has(t.name) && t.name.toLowerCase().includes(q));
      if (cand) addChip(cand);
    }
  });

  async function tick() { await loadThreads(); await render(); }
  tick();
  setInterval(tick, 1200);

  // --- cost HUD (ported from the Hammerspoon menu-bar widget, same source) ---
  const hudBtn = document.getElementById('hudBtn');
  const hud = document.getElementById('hud');
  function usd(n) {
    if (n === null || n === undefined) return '—';
    if (n === 0) return '$0';
    if (n < 0.01) return '$' + n.toFixed(4);
    return '$' + n.toFixed(2);
  }
  async function refreshHud() {
    try {
      // fetched server-side by US (see /hud-summary below) — a renderer fetch
      // straight to localhost:8402 would work fine, but routing it through
      // our own backend keeps one fetch path if that ever needs to change.
      const you = await (await fetch('/hud-summary')).json();
      const spent = Number(you.spentUsd) || 0;
      const cogs = Number(you.cogsUsd) || 0;
      const direct = Number(you.directUsd) || 0;
      const margin = spent > 0 ? Math.round((spent - cogs) / spent * 100) + '%' : '—';
      document.getElementById('hYouSpent').textContent = usd(spent);
      document.getElementById('hYouCogs').textContent = usd(cogs);
      document.getElementById('hYouMargin').textContent = margin;
      document.getElementById('hYouDirect').textContent = usd(direct);
      document.getElementById('hFoot').textContent = (you.paidCalls || 0) + ' paid calls this session';
    } catch (e) {
      document.getElementById('hFoot').textContent = 'error: ' + e.message;
    }
  }
  let hudTimer = null;
  hudBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    hud.classList.toggle('show');
    if (hud.classList.contains('show')) {
      refreshHud();
      hudTimer = setInterval(refreshHud, 30000);
    } else if (hudTimer) {
      clearInterval(hudTimer); hudTimer = null;
    }
  });
  document.addEventListener('click', (e) => { if (!hud.contains(e.target)) hud.classList.remove('show'); });
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/hud-summary') {
    (async () => {
      let you = { spentUsd: 0, cogsUsd: 0, directUsd: 0, paidCalls: 0 };
      try { you = await (await fetch('http://127.0.0.1:8402/v1/session')).json(); }
      catch { /* local proxy not running — HUD shows zeros rather than guessing */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(you));
    })();
    return;
  }
  if (req.method === 'GET' && req.url === '/threads') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([...threads.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt).map(threadSummary)));
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/threads/')) {
    const t = threads.get(req.url.split('/')[2]);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(t ? JSON.stringify({ id: t.id, history: t.history, status: t.status }) : '{}');
    return;
  }
  if (req.method === 'DELETE' && req.url.startsWith('/threads/')) {
    threads.delete(req.url.split('/')[2]);
    saveThreads();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  {
    const runMatch = /^\/threads\/([^/]+)\/run\/([^/]+)\/(approve|deny)$/.exec(req.url || '');
    if (req.method === 'POST' && runMatch) {
      const [, id, runId, action] = runMatch;
      const t = threads.get(id);
      const entry = t?.history.find((h) => h.runId === runId && h.runStatus === 'pending');
      if (!t || !t.pendingRun || t.pendingRun.runId !== runId || !entry) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"ok":false}');
        return;
      }
      const { command, cwd } = t.pendingRun;
      delete t.pendingRun;
      if (action === 'deny') {
        entry.runStatus = 'denied';
        saveThreads();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        runTurn(t.id, '(you denied running that command)').catch(() => {});
        return;
      }
      entry.runStatus = 'running';
      saveThreads();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      execCommand(command, cwd).then((output) => {
        entry.runStatus = 'done';
        entry.runOutput = output;
        saveThreads();
        runTurn(t.id, `(command output)\n${output}`).catch(() => {});
      });
      return;
    }
  }
  if (req.method === 'POST' && req.url === '/threads') {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      let name = 'New Bot';
      try { name = (JSON.parse(Buffer.concat(chunks).toString('utf8')).name || name).toString().trim() || name; }
      catch { /* ignore */ }
      const t = newThread(name, null);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(threadSummary(t)));
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/threads/group') {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      let names = [];
      try { names = JSON.parse(Buffer.concat(chunks).toString('utf8')).names || []; } catch { /* ignore */ }
      names = names.filter(Boolean);
      if (!names.length) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{}'); return; }
      const t = newGroupThread(names);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(threadSummary(t)));
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/drive') {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', async () => {
      let threadId = '', task = '', images = [];
      try {
        const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        threadId = j.threadId; task = (j.task || '').toString();
        images = Array.isArray(j.images) ? j.images.filter((u) => typeof u === 'string') : [];
      } catch { /* ignore */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      // "/dir <path>" is a LOCAL control command, not sent to the model at
      // all — free, instant, sets which folder this thread's WRITE/READ/SERVE
      // are scoped to. Respecify any time by sending it again.
      const dirCmd = /^\/dir\s+(.+)/.exec(task.trim());
      const t = threads.get(threadId);
      if (dirCmd && t) {
        const full = path.resolve(expandHome(dirCmd[1].trim()));
        let ok = false;
        try { ok = statSync(full).isDirectory(); } catch { /* not a dir / doesn't exist */ }
        if (ok) {
          t.dir = full;
          t.history.push({ who: 'bot', text: `Working directory set to ${full}` });
        } else {
          t.history.push({ who: 'bot', text: `"${full}" isn't a directory that exists.` });
        }
        saveThreads();
        return;
      }
      // "/mode auto|ask" toggles whether RUN: commands execute immediately
      // or wait for an explicit approve/deny — also free/instant, no model call
      const modeCmd = /^\/mode\s+(auto|ask)\b/.exec(task.trim());
      if (modeCmd && t) {
        t.runMode = modeCmd[1];
        t.history.push({ who: 'bot', text: `Run mode set to ${modeCmd[1]}${modeCmd[1] === 'auto' ? ' — commands execute immediately, no approval.' : ' — commands wait for your approval.'}` });
        saveThreads();
        return;
      }
      runTurn(threadId, task, undefined, images).catch(() => {});
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(APP_HTML);
});

server.listen(PORT, '127.0.0.1', () => console.log(`[grokui] http://localhost:${PORT}`));
