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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { brain, brainStream, PROXY } from './podagent.mjs';

const PORT = Number(process.env.OZ_GROKUI_PORT || 4173);
// BIND HOST. Default 127.0.0.1 so the desktop app never exposes a shell-capable
// UI to the LAN. A container MUST override it: binding the container's loopback
// makes `docker run -p 4173:4173` refuse the connection, because the published
// port forwards to the container's external interface, which nothing is on.
// Mirrors OPENZOO_BIND in lib/proxy.js — same reasoning, same default.
const BIND = process.env.OZ_GROKUI_BIND || process.env.OPENZOO_BIND || '127.0.0.1';
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

You are running as __OZ_MODEL__ (openzoo substitutes the real model id here at call time, so
it is accurate for THIS turn — note it can differ between turns, since a thread containing
an image routes to a vision model). State it if asked, and do not assert some other lab's
model from your training prior. Never spend a paid turn arguing about your own identity —
it costs the user real money and settles nothing.

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
  MCP: <url>                                          list the tools an MCP server exposes
  MCP: <url> | <tool> | {"arg": "value"}              CALL one of them, for real
                                                       An MCP endpoint speaks JSON-RPC over
                                                       POST. FETCH does a GET, so it will
                                                       always come back 405 Method Not
                                                       Allowed — that is NOT a broken URL and
                                                       NOT a reason to curl it or write your
                                                       own client. Use this directive; it
                                                       does the initialize handshake, holds
                                                       the session, and calls the tool.
  LS: <path, or blank for the root>                   list a directory
  GLOB: <pattern>                                     find files — *.js, **/*.test.ts, src/**
  GREP: <regex> | <optional path or glob>             search file CONTENTS, with line numbers
  EDIT: <path> | <exact old text> ||| <new text>      change PART of a file. Prefer this over
                                                       WRITE for edits — WRITE replaces the
                                                       whole file, so anything you don't
                                                       reproduce from memory is destroyed.
                                                       The old text must match byte for byte
                                                       and appear exactly once; READ first.
  TODO: <one item per line>                           set a visible checklist
  TODO: done <n>                                      tick an item   (TODO: alone = show it)

WORK IN PARALLEL. READ, LS, GLOB, GREP, FETCH, PEEK and MCP are read-only, and if you emit
several of them in ONE reply the harness runs them CONCURRENTLY and returns every result
together. Four files in one turn costs one round trip; four turns costs four, and you pay per
call. Ask for everything you know you need at once instead of discovering it one file at a
time. Mutating directives (RUN, WRITE, EDIT, SPAWN, SEND) stay sequential on purpose — racing
them against each other corrupts the tree.
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
THESE DIRECTIVES ARE REAL, and they are NOT function-calling tools. Your tools array holds
only web search; RUN/WRITE/READ/SERVE/FETCH are executed by the harness that reads your reply
text, so their absence from that array proves nothing. Emit the line and the harness runs it.

Do not announce that you "don't actually have a shell" or that this environment is roleplay.
Until recently a bug meant a RUN line was only detected when it was the FIRST characters of a
reply, so any preamble before it caused the command to be silently ignored — if earlier turns
in THIS thread look like RUN did nothing, that was the bug, now fixed. Do not infer from that
history that the tools are fictional. If a command genuinely fails you will get its real
output and exit code back; that, not silence, is what failure looks like.

Never fabricate command output, file contents, or payment receipts. If you did not run it,
say so and then actually run it.

Via RUN you can also make YOUR OWN paid openzoo calls — POST to
http://localhost:8402/v1/chat/completions (or /v1/hrr/bind) with curl/python/etc. Auth is
"Authorization: Bearer sk-openzoo" — any string works, x402 pays per call, not the key. Do
NOT tell the user you "can't fire the paid calls" or need "their client's bearer key" —
that's wrong, you can make these calls yourself via RUN. When you do, set max_tokens
generously (1000+, not 50) — a reasoning model can burn its ENTIRE budget on internal
reasoning before writing any visible answer, especially against a large bound corpus, and
comes back with content:null and finish_reason:"length" (confirmed live) if you starve it.
/v1/hrr/bind also caps around ~8MB per request after JSON-escaping — chunk large corpora
(e.g. 512KB raw per request) and pass the PREVIOUS chunk's context_id on each next request
to append to the same bound context, rather than one giant request that silently fails partway.

COST ACCOUNTING — do NOT compute this yourself from token counts. Every response carries an
"x402" object; read the numbers off it: x402.billedUsd (what the user paid), x402.cogsUsd
(our upstream cost), x402.directUsd (what answering WITHOUT the zoo would have cost), and
x402.savesVsDirect (the multiple). Summing usage.cost or usage.prompt_tokens and comparing
that to a provider's list price is WRONG and understates the saving enormously: against a
bound context, prompt_tokens counts only the small slice leCore recalled, NOT the corpus
that slice stands in for — so you end up pricing the discount against itself and concluding
the zoo "cost more". MEASURED: a real 21-question run reported 202,238 prompt tokens while
each attach call stood in for a 5,356,546-token corpus — a 556x understatement, and that
corpus is ~42x larger than the model's own context window, so the "direct" comparison it
was measured against was not merely pricier but IMPOSSIBLE. When the user asks what they
saved, quote x402.directUsd and x402.savesVsDirect. If savesVsDirect is below 1x, say so
plainly — that happens on small inputs, where the corpus is too small to save anything.
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

You are running as __OZ_MODEL__ (openzoo substitutes the real model id here at call time, so
it is accurate for THIS turn). State it if asked, and do not assert some other lab's model
from your training prior. Never spend a paid turn arguing about your own identity.

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
THESE DIRECTIVES ARE REAL, and they are NOT function-calling tools — your tools array holds
only web search, while these are executed by the harness that reads your reply text, so their
absence from that array proves nothing. Never say you "don't actually have a shell" or that
this is roleplay, and never fabricate command output or receipts. A real failure comes back
as real output and an exit code, not as silence.

COST ACCOUNTING — read it off the response's "x402" object (billedUsd, cogsUsd, directUsd,
savesVsDirect). Never derive it by summing usage.cost or usage.prompt_tokens against a
provider's list price: on a bound context prompt_tokens counts only the slice leCore
recalled, not the corpus it stands in for, so that math prices the discount against itself
and wrongly concludes the zoo cost more.
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
// Chunked, not one shot: a single request over ~8MB (post JSON-escaping)
// gets rejected, so a large/growing thread's bind would silently fail past
// whatever point it crossed that line — confirmed live by a bot's own RUN
// diagnostic ("Failed at chunk 2 — JSON escaping pushed a 3MB chunk over the
// ~8MB request limit"). 512KB raw per request leaves wide margin. Each
// chunk after the first carries the PREVIOUS chunk's context_id so the
// sidecar appends to the same bound context instead of starting fresh.
const BIND_CHUNK_BYTES = 512 * 1024;
// Chained auto-run commands per user message. Each hop is a paid call.
const AUTO_MAX_STEPS = Number(process.env.OZ_AUTO_MAX_STEPS || 8);

// Injected fresh on every AUTO turn, never persisted into the thread.
//
// The auto loop only continues while directives keep parsing, so a reply that
// merely OFFERS ends the run — auto silently degrades to ask the moment the
// model hedges. Observed live: "If you want, I can rewrite the prompt with
// these fixes folded in", "Spawned mcp-integration — working on it" with
// nothing spawned, and a user reduced to answering "no, this... impl all".
// Models are trained to close on a consent question; in auto that instinct is
// the bug. The system prompt is frozen into a thread at creation, so an
// existing thread can only be reached by a per-turn message.
const AUTO_DIRECTIVE = `AUTO MODE IS ON for this thread.

Do the work in this turn. Do not ask whether to proceed, do not offer to do it,
do not say what you are "about to" do and stop. The user has already consented
by enabling auto — a question back to them is a dropped turn, and they must
type "yes" to get what they already asked for.

Concretely, NEVER end a turn with any of: "If you want, I can…", "Should I…?",
"Let me know and I'll…", "Ready to proceed?", or a plan with no directive after
it. If you catch yourself writing one, emit the RUN/WRITE/READ/SERVE/FETCH line
instead — that IS the answer.

Announcing an action does not perform it. "Spawned X", "working on it" and
"kicked that off" are false unless the directive line is in this same reply.
If a task needs several commands, emit the FIRST one now; you get its real
output back and continue from there. Only stop to ask when the next step is
genuinely destructive and irreversible, or when you truly cannot proceed
without a fact only the user has.`;
async function bindThread(t) {
  // Only bind what's NEW since the last successful bind, continuing the
  // existing context_id — previously this rebuilt and re-sent the WHOLE
  // history from scratch every turn (discarding t.contextId), so bind cost
  // grew with total conversation length and was re-paid on every message.
  const from = t.boundHistoryCount || 0;
  const delta = t.history.slice(from);
  if (!delta.length) return;
  const corpus = delta.map((h) => (h.who === 'user' ? 'you' : (h.name || t.name)) + ': ' + h.text).join('\n');
  if (!corpus.trim()) { t.boundHistoryCount = t.history.length; return; }
  try {
    let ctx = t.contextId;
    for (let i = 0; i < corpus.length; i += BIND_CHUNK_BYTES) {
      const part = corpus.slice(i, i + BIND_CHUNK_BYTES);
      const body = ctx ? { corpus: part, context_id: ctx } : { corpus: part };
      const r = await fetch(`${PROXY}/hrr/bind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (j?.context_id) ctx = j.context_id;
      else break; // this chunk failed — stop, keep whatever bound so far rather than lose it all
    }
    if (ctx) { t.contextId = ctx; t.boundHistoryCount = t.history.length; saveThreads(); }
  } catch { /* leCore sidecar unreachable — thread still works, just not bound this round */ }
}

// REAL shell execution, scoped to the thread's own directory. 'ask' mode
// (default) pauses and waits for an explicit approve/deny over HTTP before
// anything runs; 'auto' mode (set via "/mode auto" in chat) runs immediately.
// Either way this is not sandboxed like WRITE/READ — it can do anything the
// signed-in user's shell can — so 'ask' is the default, not 'auto'.
// Some underlying models were tuned with native tool-calling and leak their
// own control tokens (e.g. DeepSeek's "<||DSML||tool_calls>") as trailing
// plain text when this harness doesn't wire a `tools` schema. Left in, that
// text becomes part of the shell command string and breaks /bin/sh's parser
// ("unexpected token `newline'") — confirmed live. Strip it before exec.
function sanitizeRunCommand(command) {
  return command.replace(/<\|+[^<>\n]*\|+>/g, '').trim();
}

// Finds a RUN directive anywhere a line starts with it, NOT only at the very
// start of the reply.
//
// This anchor used to be /^RUN:/ with no `m` flag, so `^` matched only the
// first character of the whole reply. The moment a model wrote ANY preamble
// ("Command only, as requested:") before its directive, the match failed and
// the directive degraded silently into ordinary chat text — nothing ran, no
// error surfaced. MEASURED live: a bot repeatedly emitted correct RUN blocks,
// saw nothing happen, concluded "I don't actually have a working shell/RUN
// tool", and began fabricating plausible terminal output and wallet receipts
// instead. The user had to reverse-engineer it themselves and ask for "the cmd
// without any pretext". Models put preamble before directives constantly, so
// this failed far more often than it worked.
//
// Also tolerates the directive being wrapped in a markdown code fence, which
// is the other shape models reach for unprompted.
function parseRun(reply) {
  // NATIVE TOOL-CALL ENVELOPE FIRST. deepseek-v4-pro has real function calling,
  // and when told to emit "RUN: <cmd>" it frequently wraps the call in its own
  // DSML markup instead:
  //
  //   <DSML | tool_calls><DSML | invoke name="RUN">
  //   <DSML | parameter name="command" string="true">cd ~/x && ls</DSML | parameter>
  //
  // Matching only a line starting `RUN:` misses that entirely, so the command
  // never ran, the harness stayed silent, and the model went on to NARRATE work
  // it had not done — MEASURED live: a bot reported "Done. Scheduling a
  // recurring nudge every 2 minutes", a capability that does not exist, after
  // several such calls were dropped. Same failure as the old /^RUN:/ anchor,
  // different shape: a silently discarded directive reads to the model as a
  // tool that does nothing, and it fabricates rather than reporting failure.
  // The separator is NOT always an ASCII pipe. DeepSeek's real special tokens
  // use U+FF5C FULLWIDTH VERTICAL LINE (｜) — matching only `|` parsed the
  // pretty-printed form in tests while missing what the model actually emits,
  // which is exactly how this survived one round of "fixed".
  // The PARAMETER NAME is not fixed either. Models emit name="command",
  // name="cmd", name="shell_command" and name="script" for the same thing —
  // MEASURED live emitting `name="cmd"` inside an invoke named exec_command,
  // against a parser that demanded name="command". One attribute apart, and
  // the whole envelope was dropped in silence: the bot then explained what it
  // was "about to run" forever, never running anything. Match the shape of the
  // envelope, not one vendor's spelling of it.
  const SEP = '[|｜\\s]*';
  const NAME = '(?:command|cmd|shell_command|script)';
  const dsml = new RegExp(`<${SEP}DSML[^>]*\\bparameter\\b[^>]*\\bname="${NAME}"[^>]*>([\\s\\S]*?)<\\/${SEP}DSML`, 'i').exec(reply);
  if (dsml) return sanitizeRunCommand(dsml[1]);

  const m = /^[ \t>*-]*RUN:[ \t]*([\s\S]+)/m.exec(reply);
  if (!m) return null;
  let cmd = m[1];
  const fenced = /^```[\w-]*\n([\s\S]*?)```/.exec(cmd.trim());
  if (fenced) cmd = fenced[1];
  else cmd = cmd.replace(/\n```[\s\S]*$/, ''); // trailing fence + any posttext
  return sanitizeRunCommand(cmd);
}

// RUN through BASH, not /bin/sh. node's exec() defaults to /bin/sh, which on
// Debian is dash — so every bash-ism a model writes (`for … do`, `[[ ]]`,
// arrays, process substitution) dies as
//   /bin/sh: 40: Syntax error: "do" unexpected
// which reads as the model writing bad code when it wrote perfectly good bash.
// Models overwhelmingly emit bash; give them bash. Windows is left alone so
// node picks cmd.exe, and a box without /bin/bash falls back to the default.
const RUN_SHELL = process.platform !== 'win32' && existsSync('/bin/bash') ? '/bin/bash' : undefined;
// Installing a toolchain (apt-get, pip, cargo) routinely outruns two minutes,
// and a killed install leaves a half-configured box that fails confusingly.
const RUN_TIMEOUT_MS = Number(process.env.OZ_RUN_TIMEOUT_MS || 600000);

function execCommand(command, cwd) {
  return new Promise((resolve) => {
    exec(command, { cwd, shell: RUN_SHELL, timeout: RUN_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
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
// Directives that only READ. These are safe to run at the same time, so a
// reply carrying several of them costs one round trip instead of N — a model
// that wants four files currently spends four full turns (and four payments)
// fetching them one at a time.
//
// Deliberately excludes RUN / WRITE / EDIT / SPAWN / SEND: those mutate, and
// concurrent mutation of the same tree is a race the model cannot reason
// about. Reads fan out, writes stay sequential.
const PARALLEL_DIRECTIVE = /^[ \t>*-]*(READ|LS|GLOB|GREP|FETCH|PEEK|MCP):[ \t]*(.+)$/gm;

// Walk a thread dir once, cheaply, skipping the things nobody means to search.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv']);
function walkDir(base, rel = '', out = [], depth = 0) {
  if (depth > 12 || out.length > 5000) return out;
  let entries = [];
  try { entries = readdirSync(path.join(base, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walkDir(base, r, out, depth + 1);
    } else out.push(r);
  }
  return out;
}

// Glob -> RegExp. `**` crosses separators, `*` and `?` do not.
function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

async function tryDirective(reply, originId) {
  // FAN OUT FIRST. Each line is re-entered on its own, so every branch below
  // stays single-directive and none of them had to learn about batching.
  const batch = [...reply.matchAll(PARALLEL_DIRECTIVE)];
  if (batch.length > 1) {
    const results = await Promise.all(
      batch.map((m) => tryDirective(m[0].replace(/^[ \t>*-]*/, ''), originId)
        .catch((e) => `${m[1]}: ${e.message}`)),
    );
    return results.filter(Boolean).join('\n\n');
  }

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
  // EDIT beats WRITE for changing part of a file: WRITE overwrites the whole
  // thing, so a model that wants a one-line change has to reproduce the entire
  // file from memory and silently drops whatever it forgot.
  const edit = /^EDIT:\s*([^|]+)\|([\s\S]*?)\|\|\|([\s\S]*)$/.exec(reply);
  if (edit) {
    const rel = edit[1].trim();
    const oldStr = edit[2].replace(/^\n/, '').replace(/\n$/, '');
    const newStr = edit[3].replace(/^\n/, '').replace(/\n$/, '');
    try {
      const full = safeResolveIn(dirFor(originId), rel);
      const before = readFileSync(full, 'utf8');
      const hits = before.split(oldStr).length - 1;
      if (hits === 0) return `EDIT ${rel}: that exact text isn't in the file — READ it first, the copy must match byte for byte.`;
      if (hits > 1) return `EDIT ${rel}: that text appears ${hits} times — include more surrounding context so it matches exactly once.`;
      writeFileSync(full, before.replace(oldStr, newStr));
      return `Edited ${rel} (${before.length} -> ${before.replace(oldStr, newStr).length} bytes).`;
    } catch (e) { return `Couldn't edit ${rel}: ${e.message}`; }
  }

  const ls = /^LS:\s*(.*)$/.exec(reply);
  if (ls) {
    const rel = ls[1].trim() || '.';
    try {
      const full = safeResolveIn(dirFor(originId), rel);
      const entries = readdirSync(full, { withFileTypes: true });
      if (!entries.length) return `${rel}: (empty)`;
      const lines = entries.slice(0, 300).map((e) => {
        if (e.isDirectory()) return `  ${e.name}/`;
        let size = '';
        try { size = ` (${statSync(path.join(full, e.name)).size}b)`; } catch { /* raced */ }
        return `  ${e.name}${size}`;
      });
      return `${rel}:\n${lines.join('\n')}${entries.length > 300 ? `\n  …${entries.length - 300} more` : ''}`;
    } catch (e) { return `Couldn't list ${rel}: ${e.message}`; }
  }

  const glob = /^GLOB:\s*(.+)$/.exec(reply);
  if (glob) {
    const pattern = glob[1].trim();
    try {
      const base = dirFor(originId);
      const re = globToRe(pattern.startsWith('./') ? pattern.slice(2) : pattern);
      const hits = walkDir(base).filter((f) => re.test(f) || re.test(path.basename(f)));
      if (!hits.length) return `GLOB ${pattern}: no matches`;
      return `GLOB ${pattern} — ${hits.length} match(es):\n${hits.slice(0, 200).map((h) => '  ' + h).join('\n')}`
        + (hits.length > 200 ? `\n  …${hits.length - 200} more` : '');
    } catch (e) { return `GLOB ${pattern}: ${e.message}`; }
  }

  const grep = /^GREP:\s*([^|]+?)(?:\s*\|\s*(.+))?$/.exec(reply);
  if (grep) {
    const pattern = grep[1].trim();
    const scope = (grep[2] || '').trim();
    try {
      const base = dirFor(originId);
      let re;
      try { re = new RegExp(pattern, 'i'); }
      catch { return `GREP: ${pattern} isn't a valid regex.`; }
      let files = walkDir(base);
      if (scope) { const sre = globToRe(scope); files = files.filter((f) => sre.test(f) || f.startsWith(scope)); }
      const out = [];
      for (const f of files) {
        if (out.length > 200) break;
        let text;
        try { text = readFileSync(path.join(base, f), 'utf8'); } catch { continue; }
        if (text.indexOf(String.fromCharCode(0)) !== -1) continue; // binary — NUL, not whitespace
        text.split('\n').forEach((line, i) => {
          if (out.length <= 200 && re.test(line)) out.push(`  ${f}:${i + 1}: ${line.trim().slice(0, 200)}`);
        });
      }
      if (!out.length) return `GREP ${pattern}: no matches`;
      return `GREP ${pattern} — ${out.length} hit(s):\n${out.join('\n')}`;
    } catch (e) { return `GREP: ${e.message}`; }
  }

  // A real, persisted checklist. Bots were already narrating plans; this makes
  // the plan a thing the user can see and the model can be held to.
  const todo = /^TODO:\s*([\s\S]*)$/.exec(reply);
  if (todo) {
    const t = threads.get(originId);
    if (!t) return 'TODO: no such thread.';
    t.todos = t.todos || [];
    const body = todo[1].trim();
    if (!body || /^(list|show)$/i.test(body)) {
      if (!t.todos.length) return 'TODO: (empty)';
      return 'TODO:\n' + t.todos.map((x, i) => `  ${i + 1}. [${x.done ? 'x' : ' '}] ${x.text}`).join('\n');
    }
    const done = /^done\s+(\d+)/i.exec(body);
    if (done) {
      const idx = Number(done[1]) - 1;
      if (!t.todos[idx]) return `TODO: no item ${done[1]}.`;
      t.todos[idx].done = true;
      saveThreads();
      return 'TODO:\n' + t.todos.map((x, i) => `  ${i + 1}. [${x.done ? 'x' : ' '}] ${x.text}`).join('\n');
    }
    if (/^clear$/i.test(body)) { t.todos = []; saveThreads(); return 'TODO: cleared.'; }
    // Otherwise: replace the list with the lines given.
    t.todos = body.split('\n').map((l) => l.replace(/^[-*\d.)\]\s]+/, '').trim())
      .filter(Boolean).map((text) => ({ text, done: false }));
    saveThreads();
    return 'TODO:\n' + t.todos.map((x, i) => `  ${i + 1}. [ ] ${x.text}`).join('\n');
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
      // A 405 on an MCP endpoint is not a broken URL, and a model cannot tell
      // the difference — it retries the same GET, then gives up and hand-rolls
      // a client. Say what actually happened and point at the directive that
      // works. MEASURED: three wasted turns curling /api/mcp before the user
      // had to intervene with "stop hitting /api/mcp as a curl".
      if (r.status === 405 && /\/mcp\/?$/.test(url)) {
        return `${url} (405): that is an MCP endpoint, not a web page — it speaks `
          + `JSON-RPC over POST and rejects the GET that FETCH does. Use the MCP `
          + `directive instead:\n  MCP: ${url}\nto list its tools, then\n  `
          + `MCP: ${url} | <tool> | {"arg": "value"}\nto call one.`;
      }
      return `${url} (${r.status}):\n${text.slice(0, 8000)}${text.length > 8000 ? '\n…(truncated)' : ''}`;
    } catch (e) { return `Couldn't fetch ${url}: ${e.message}`; }
  }

  const mcpD = /^MCP:\s*(\S+)\s*(?:\|\s*([^|]+?)\s*(?:\|\s*([\s\S]+))?)?$/m.exec(reply);
  if (mcpD) {
    const [, url, tool, argsRaw] = mcpD;
    let args = {};
    if (argsRaw) {
      const fenced = /```[\w-]*\n([\s\S]*?)```/.exec(argsRaw);
      try { args = JSON.parse((fenced ? fenced[1] : argsRaw).trim()); }
      catch (e) { return `MCP: couldn't parse the arguments as JSON — ${e.message}`; }
    }
    return await mcpDirective(url.trim(), tool?.trim(), args);
  }
  return null;
}

// ---------------------------------------------------------------------------
// MCP client — streamable-http, written against fetch on purpose.
//
// grokui runs STANDALONE from /opt/grokui/grokui.mjs, which has no
// node_modules beside it, so importing @modelcontextprotocol/sdk would break
// the copy that boxes actually execute. The wire protocol is small: POST
// JSON-RPC, accept both JSON and SSE, carry the session id the server hands
// back on initialize.
//
// This exists because bots were told to "install an MCP" and had no way to
// speak to one. FETCH does a GET; every MCP endpoint answers GET with 405, so
// the model saw a dead URL, retried, then wrote its own Python client.
let mcpId = 0;

async function mcpRpc(url, method, params, session, notify = false) {
  const id = notify ? undefined : ++mcpId;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // BOTH are required. Servers negotiate between a plain JSON reply and an
      // SSE stream, and offering only one gets a 406 from spec-strict servers.
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...(session ? { 'mcp-session-id': session } : {}),
    },
    body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }),
  });
  const sid = r.headers.get('mcp-session-id') || session;
  const body = await r.text();
  if (notify) return { status: r.status, session: sid, json: null };

  let json = null;
  if ((r.headers.get('content-type') || '').includes('text/event-stream')) {
    // SSE frames: take the last `data:` payload that carries a result/error.
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try {
        const j = JSON.parse(line.slice(5).trim());
        if (j && (j.result !== undefined || j.error !== undefined)) json = j;
      } catch { /* keep-alive or partial frame */ }
    }
  } else {
    try { json = JSON.parse(body); } catch { /* non-JSON error page */ }
  }
  return { status: r.status, session: sid, json, raw: body };
}

async function mcpDirective(url, tool, args) {
  try {
    const init = await mcpRpc(url, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'openzoo-grokui', version: '1' },
    });
    if (init.json?.error) return `MCP ${url}: initialize failed — ${JSON.stringify(init.json.error)}`;
    if (!init.json) return `MCP ${url}: no JSON-RPC reply (HTTP ${init.status})\n${(init.raw || '').slice(0, 600)}`;
    const session = init.session;
    // Required by spec before any other request; skipping it makes some
    // servers reject everything after initialize.
    await mcpRpc(url, 'notifications/initialized', {}, session, true).catch(() => {});

    const server = init.json.result?.serverInfo;
    const banner = `MCP ${url}${server ? ` — ${server.name} ${server.version || ''}`.trimEnd() : ''}`;

    if (!tool) {
      const list = await mcpRpc(url, 'tools/list', {}, session);
      if (list.json?.error) return `${banner}\ntools/list failed — ${JSON.stringify(list.json.error)}`;
      const tools = list.json?.result?.tools || [];
      if (!tools.length) return `${banner}\n(no tools)`;
      const lines = tools.map((t) => {
        const req = t.inputSchema?.required || [];
        const props = Object.keys(t.inputSchema?.properties || {});
        const sig = props.map((p) => (req.includes(p) ? p : `${p}?`)).join(', ');
        return `  ${t.name}(${sig})\n      ${(t.description || '').split('\n')[0].slice(0, 160)}`;
      });
      return `${banner}\n${tools.length} tools:\n${lines.join('\n')}\n\n`
        + `Call one with:  MCP: ${url} | <tool> | {"arg": "value"}`;
    }

    const call = await mcpRpc(url, 'tools/call', { name: tool, arguments: args }, session);
    if (call.json?.error) return `${banner}\n${tool} failed — ${JSON.stringify(call.json.error)}`;
    const res = call.json?.result;
    const out = (res?.content || [])
      .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
      .join('\n') || JSON.stringify(res ?? call.raw);
    return `${banner}\n$ ${tool}\n${out.slice(0, 6000)}${out.length > 6000 ? '\n…(truncated)' : ''}`;
  } catch (e) {
    return `MCP ${url}: ${e.message}`;
  }
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
      const runCmd = parseRun(r);
      if (runCmd) {
        const command = runCmd;
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
  if (!/^\(command output\)/.test(userText)) t.autoSteps = 0;
  t.messages.push({ role: 'user', content: contentFor(userText, images) });
  t.status = 'thinking';
  let reply = '';
  onEvent?.({ type: 'start', name: t.name, color: t.color });
  // Transient: the nudge is appended for THIS call only and never pushed into
  // t.messages, so it can't accumulate across a chained auto run or get bound
  // into the thread's context.
  const callMsgs = t.runMode === 'auto'
    ? [...t.messages, { role: 'system', content: AUTO_DIRECTIVE }]
    : t.messages;
  try {
    reply = onEvent
      ? (await brainStream(callMsgs, (delta) => onEvent({ type: 'delta', name: t.name, color: t.color, delta }), t.contextId)).trim()
      : (await brain(callMsgs, t.contextId)).trim();
  } catch (e) {
    reply = `error: ${e.message}`;
  }
  t.messages.push({ role: 'assistant', content: reply });
  const runCmd = parseRun(reply);
  if (runCmd) {
    const command = runCmd;
    if (t.runMode === 'auto') {
      const output = await execCommand(command, dirFor(t.id));
      const shown = `$ ${command}\n${output}`;
      t.history.push({ who: 'bot', text: shown });
      onEvent?.({ type: 'final', name: t.name, color: t.color, text: shown });
      // FEED THE OUTPUT BACK. The 'ask' path already does this on approve, so
      // auto mode was strictly LESS capable than the gated one: the command
      // ran, the result was shown, and the model never saw it — no diagnosis,
      // no follow-up, no next step. It looked like "auto mode does nothing".
      //
      // Bounded, because this is a loop that spends real money on every hop:
      // AUTO_MAX_STEPS chained commands per user message, reset whenever the
      // user speaks again.
      t.autoSteps = (t.autoSteps || 0) + 1;
      t.status = 'idle';
      t.lastActivityAt = Date.now();
      saveThreads();
      if (t.autoSteps < AUTO_MAX_STEPS) {
        runTurn(threadId, `(command output)\n${output}`, onEvent).catch(() => {});
      } else {
        const note = `(auto-run stopped after ${AUTO_MAX_STEPS} chained commands — say "continue" to keep going)`;
        t.history.push({ who: 'bot', text: note });
        onEvent?.({ type: 'final', name: t.name, color: t.color, text: note });
        saveThreads();
      }
      return;
    }
    {
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
    dir: t.dir || WORKSPACE_DIR, runMode: t.runMode || 'ask' };
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
  #main { flex: 1; min-width: 0; display: flex; flex-direction: column; height: 100vh; }
  #chatHeader { padding: 14px 20px; border-bottom: 1px solid #1c1c1e; display: flex; align-items: center; gap: 10px;
                font-weight: 600; }
  #chatHeader .tavatar { width: 26px; height: 26px; border-radius: 7px; font-size: 11px; flex: 0 0 26px; }
  .hname { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .hdir { font-weight: 400; font-size: 11px; color: #8e8e93; white-space: nowrap; overflow: hidden;
          text-overflow: ellipsis; max-width: 420px; }
  /* Run-mode toggle. The "/mode auto|ask" chat command still works and is
     still what the bots are told about, but it is invisible until you know it
     exists — and it controls whether shell commands run without asking, which
     is exactly the setting a user should be able to SEE at a glance. */
  #modeToggle { margin-left: auto; display: flex; align-items: center; gap: 0;
                background: #1c1c1e; border: 1px solid #333340; border-radius: 999px; padding: 2px; }
  .modebtn { border: 0; background: none; color: #8e8e93; font: inherit; font-size: 11px;
             font-weight: 600; padding: 4px 11px; border-radius: 999px; cursor: pointer;
             white-space: nowrap; transition: background .12s, color .12s; }
  .modebtn:hover { color: #ececec; }
  .modebtn.on { color: #000; }
  .modebtn.ask.on { background: #b8f240; }
  .modebtn.auto.on { background: #f28c4d; }
  .modebtn:focus-visible { outline: 2px solid #6ab0ff; outline-offset: 2px; }
  #hudBtn { margin-left: 10px; }
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
  /* Only rendered when the multiple is under 1x — it explains WHY, and what to
     do about it, instead of leaving a bad-looking number unexplained. */
  #hud .hhint { display: none; margin-top: 8px; padding: 7px 9px; border-radius: 8px;
                background: rgba(242,140,77,.10); border: 1px solid rgba(242,140,77,.32);
                color: #f0c9a8; font-size: 10.5px; line-height: 1.45; }
  #hud .hhint.show { display: block; }
  #hud .hhint b { color: #f28c4d; font-weight: 600; }
  #sidebar, #main { -webkit-app-region: no-drag; }
  #log { flex: 1; min-width: 0; overflow-y: auto; overflow-x: hidden; padding: 20px 24px 12px;
         display: flex; flex-direction: column; gap: 6px;
         -webkit-user-select: text; user-select: text; }
  .hdr { align-self: flex-start; display: flex; align-items: center; gap: 6px; margin: 12px 0 4px;
         color: #8e8e93; font-size: 13px; }
  .hdr .avatar { width: 18px; height: 18px; border-radius: 5px; display: flex; align-items: center;
                 justify-content: center; color: #fff; font-size: 9px; font-weight: 700; }
  /* min-width:0 is load-bearing. A flex item defaults to min-width:auto, so it
     refuses to shrink below its content's intrinsic width — one long
     unbreakable line (a curl command, a JSON blob) in a <pre> then stretches
     the row past max-width, widens the whole column, and pushes the header's
     cost button off-screen. */
  .row { display: flex; max-width: 78%; min-width: 0; margin: 2px 0; }
  .row.user { align-self: flex-end; }
  .row.bot { align-self: flex-start; }
  .bubble { padding: 11px 16px; border-radius: 20px; white-space: pre-wrap; word-break: break-word;
            min-width: 0; max-width: 100%; overflow-x: hidden;
            -webkit-user-select: text; user-select: text; cursor: text; }
  .bubble a { color: #6ab0ff; text-decoration: underline; cursor: pointer; }
  /* rendered markdown. The bubble is pre-wrap for plain text, but block
     elements carry their own spacing — leaving pre-wrap on would add the
     source newlines back on top of it and double every gap. */
  .bubble:has(> p, > .md-h, > .md-table, > .md-list, > .md-pre) { white-space: normal; }
  .bubble > p { margin: 0 0 10px; }
  .bubble > p:last-child { margin-bottom: 0; }
  .md-h { margin: 14px 0 8px; font-size: 15px; font-weight: 600; line-height: 1.3; }
  .md-h:first-child { margin-top: 0; }
  .md-hr { border: 0; border-top: 1px solid #3a3a3c; margin: 14px 0; }
  .md-list { margin: 0 0 10px; padding-left: 22px; }
  .md-list li { margin: 3px 0; }
  .bubble code { background: #1c1c1e; border: 1px solid #333; border-radius: 5px;
                 padding: 1px 5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
  .md-pre { background: #1c1c1e; border: 1px solid #333; border-radius: 10px; padding: 10px 12px;
            overflow-x: auto; margin: 0 0 10px; }
  .md-pre code { background: none; border: 0; padding: 0; font-size: 12.5px; line-height: 1.45; }
  .md-table { border-collapse: collapse; margin: 0 0 10px; font-size: 13px; display: block; overflow-x: auto; }
  .md-table th, .md-table td { border: 1px solid #3a3a3c; padding: 5px 10px; text-align: left; vertical-align: top; }
  .md-table th { background: #1c1c1e; font-weight: 600; }
  .bubble-images { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .bubble-images img { max-width: 160px; max-height: 160px; border-radius: 12px; display: block; }
  .runcard { background: #1c1c1e; border: 1px solid #333; border-radius: 14px; padding: 12px 14px;
             max-width: 100%; min-width: 0; overflow: hidden; }
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
      <div id="modeToggle" data-component="run-mode-toggle" role="group" aria-label="Shell command mode">
        <button class="modebtn ask on" id="modeAsk" data-mode="ask"
                title="Shell commands pause and wait for your approval">ask</button>
        <button class="modebtn auto" id="modeAuto" data-mode="auto"
                title="Shell commands run immediately, with no approval prompt">auto</button>
      </div>
      <button class="icon-btn" id="hudBtn">◎</button>
    </div>
    <div id="hud">
      <div class="htitle">YOUR WALLET · THIS SESSION</div>
      <div class="hrow"><span>you've paid</span><span id="hYouSpent">—</span></div>
      <div class="hrow"><span>our cost (cogs)</span><span id="hYouCogs">—</span></div>
      <div class="hrow"><span>margin</span><span id="hYouMargin" class="hlime">—</span></div>
      <div class="hrow"><span>direct would be</span><span id="hYouDirect" class="hember">—</span></div>
      <div class="hrow"><span>saved vs. naked calls</span><span id="hYouSaved" class="hlime">—</span></div>
      <div class="hhint" id="hHint"></div>
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
    setModeButtons(t.runMode || 'ask');
  }

  // The toggle reflects the SERVER's value rather than local state — the mode
  // is per-thread and also settable by typing "/mode auto", so anything that
  // tracked it client-side would drift the moment either path was used.
  function setModeButtons(mode) {
    document.getElementById('modeAsk').className = 'modebtn ask' + (mode === 'ask' ? ' on' : '');
    document.getElementById('modeAuto').className = 'modebtn auto' + (mode === 'auto' ? ' on' : '');
  }

  async function setMode(mode) {
    if (!activeId) return;
    setModeButtons(mode); // optimistic: the click should feel instant
    // Reuses the SAME "/mode" path the chat command takes, so there is one
    // implementation of the rule rather than a second one that can disagree.
    await fetch('/drive', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: activeId, task: '/mode ' + mode }) });
    await loadThreads(); // refresh runMode + the confirmation line /mode appends
    await render();
  }
  document.getElementById('modeAsk').addEventListener('click', () => setMode('ask'));
  document.getElementById('modeAuto').addEventListener('click', () => setMode('auto'));

  function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  // Inline span-level markdown. Runs AFTER escapeHtml, so every tag below is
  // one we created — model output can never inject its own.
  function mdInline(s) {
    let o = escapeHtml(s);
    o = o.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    o = o.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    o = o.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, '$1<em>$2</em>');
    o = o.replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // bare URLs, but only at a boundary — inside href="..." the preceding
    // char is a quote, so links we just built are left alone
    o = o.replace(/(^|[\\s(])(https?:\\/\\/[^\\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    o = o.replace(/@(\\w+)/g, '<span class="mention">\u{1F465} $1</span>');
    return o;
  }

  // Block-level markdown: fenced code, tables, headings, lists. Models answer
  // in markdown by default, and rendering it as literal "## " and "| --- |"
  // made every structured answer unreadable.
  function renderMentions(text) {
    const fences = [];
    const src = String(text).replace(/\`\`\`([\\w-]*)\\n?([\\s\\S]*?)\`\`\`/g, (m, lang, code) => {
      fences.push('<pre class="md-pre"><code>' + escapeHtml(code.replace(/\\n$/, '')) + '</code></pre>');
      return '\\u0000F' + (fences.length - 1) + '\\u0000';
    });
    const lines = src.split('\\n');
    const out = [];
    let list = null, tbl = null, para = [];
    const flushPara = () => {
      if (!para.length) return;
      out.push('<p>' + para.map(mdInline).join('<br>') + '</p>');
      para = [];
    };
    const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
    const closeTbl = () => {
      if (!tbl) return;
      let h = '<table class="md-table"><thead><tr>'
        + tbl[0].map((c) => '<th>' + mdInline(c) + '</th>').join('') + '</tr></thead><tbody>';
      for (const r of tbl.slice(1)) h += '<tr>' + r.map((c) => '<td>' + mdInline(c) + '</td>').join('') + '</tr>';
      tbl = null;
      out.push(h + '</tbody></table>');
    };
    const cells = (l) => l.replace(/^\\s*\\|/, '').replace(/\\|\\s*$/, '').split('|').map((c) => c.trim());
    for (const line of lines) {
      if (/^\\s*\\|.*\\|\\s*$/.test(line)) {                       // table row
        flushPara(); closeList();
        if (/^[\\s|:-]+$/.test(line)) continue;                 // |---|---| separator
        (tbl = tbl || []).push(cells(line));
        continue;
      }
      closeTbl();
      const h = /^(#{1,4})\\s+(.*)$/.exec(line);
      if (h) { flushPara(); closeList(); out.push('<h' + (h[1].length + 2) + ' class="md-h">' + mdInline(h[2]) + '</h' + (h[1].length + 2) + '>'); continue; }
      if (/^\\s*([-*_])\\s*\\1\\s*\\1[\\s\\-*_]*$/.test(line)) { flushPara(); closeList(); out.push('<hr class="md-hr">'); continue; }
      const ul = /^\\s*[-*]\\s+(.*)$/.exec(line);
      const ol = /^\\s*\\d+[.)]\\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara();
        const want = ul ? 'ul' : 'ol';
        if (list && list !== want) closeList();
        if (!list) { list = want; out.push('<' + want + ' class="md-list">'); }
        out.push('<li>' + mdInline((ul || ol)[1]) + '</li>');
        continue;
      }
      closeList();
      if (!line.trim()) { flushPara(); continue; }
      // a fence placeholder is a BLOCK — letting it fall into a paragraph
      // emits <p><pre>…</pre></p>, which browsers silently split apart
      if (/^\\u0000F\\d+\\u0000$/.test(line.trim())) { flushPara(); out.push(line.trim()); continue; }
      para.push(line);
    }
    flushPara(); closeList(); closeTbl();
    return out.join('').replace(/\\u0000F(\\d+)\\u0000/g, (m, i) => fences[Number(i)]);
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
      const savedEl = document.getElementById('hYouSaved');
      const hintEl = document.getElementById('hHint');
      if (spent > 0) {
        const mult = direct / spent;
        // honest either way: >=1x is a real saving vs a naked direct call,
        // <1x means you're currently paying MORE than direct would cost —
        // don't dress that up as green when it isn't one.
        // Asking a bound corpus makes this genuinely large (the counterfactual
        // is shipping the WHOLE corpus), so 2dp would read as noise up there.
        savedEl.textContent = (mult >= 100 ? Math.round(mult) : mult.toFixed(mult >= 10 ? 1 : 2)) + 'x';
        savedEl.className = mult >= 1 ? 'hlime' : 'hember';
        // Under 1x is real, but on its own it just reads as "this is a bad
        // deal". It isn't a verdict on the product — it's a verdict on how
        // little you've given it to work against: you're billed on the tokens
        // actually forwarded, while "direct" is the cost of shipping the whole
        // corpus. The forwarded slice grows barely at all as the corpus grows,
        // so the ratio climbs with corpus size. Say that, and say what to do.
        hintEl.className = mult >= 1 ? 'hhint' : 'hhint show';
        hintEl.innerHTML = '<b>feed it more.</b> you\\'re billed on the slice actually sent, '
          + 'not the corpus — so the more you bind, the further ahead this gets. '
          + 'small inputs cost more than sending them straight.';
      } else {
        savedEl.textContent = '—';
        hintEl.className = 'hhint';
      }
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

server.listen(PORT, BIND, () => console.log(`[grokui] http://${BIND === '0.0.0.0' ? 'localhost' : BIND}:${PORT}`));
