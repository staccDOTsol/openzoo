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
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import path from 'node:path';
import { brain, brainRace, brainStream, tierModels, MODEL, PROXY, TIER_NAMES } from './podagent.mjs';

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
// Where a thread's WRITE/READ/RUN/LS/GLOB/GREP are scoped by default.
//
// Overridable because a BOX puts uploaded files somewhere else: box-server
// unpacks them into /workspace, while this defaulted to ~/.openzoo/grokui-
// workspace. So a user uploaded a 670-part archive, asked a bot to find it,
// and got "GLOB **/prooffront: no matches" — the bot was searching an empty
// directory and looked broken while the files sat one path away. The site had
// resorted to printing "grokui: /dir /workspace" as a hint for the user to
// fix it by hand every time.
const WORKSPACE_DIR = process.env.OZ_WORKSPACE_DIR
  || path.join(homedir(), '.openzoo', 'grokui-workspace');
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
  MULTIEDIT: <path> | a ||| b ;; c ||| d              several edits to ONE file, ALL-OR-
                                                       NOTHING — if any piece doesn't match,
                                                       the file is left untouched. Prefer this
                                                       over a run of EDITs, where the third
                                                       can fail after the first two landed.
  NOTEBOOK: <path> | <cell index> | <new source>      replace a Jupyter cell (0-indexed);
                                                       stale outputs are cleared
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
  // A subagent INHERITS its parent's run mode, working directory and model.
  //
  // runMode especially: children defaulted to 'ask', so a bot spawned in auto
  // mode emitted a RUN, the harness parked it awaiting approval, and nobody
  // was watching that thread to approve it. The subagent looked "stuck
  // typing…" forever while the parent reported it as working. Spawning from
  // auto and landing in ask is never what the user meant.
  //
  // dir matters just as much — a child that defaults elsewhere cannot see the
  // files the parent was sent to work on.
  //
  // tier/race/raceMode for the same reason, and one more: they are the SPEND
  // dial. Setting a project to the expensive tier and then having every
  // subagent it spawns silently drop back to medium means the setting applies
  // to the one bot you happened to be looking at and nothing that does the
  // actual work. The opposite is worse — dropping to cheap should not be
  // quietly undone by a fan-out into four frontier models.
  const p = parent ? threads.get(parent) : null;
  const t = { id, name, color: members ? members[0].color : colorFor(name), parent: parent || null,
    messages: members ? null : [{ role: 'system', content: SYSTEM }],
    members: members || null, history: [], status: 'idle', createdAt: Date.now(), lastActivityAt: Date.now(),
    ...(p?.runMode ? { runMode: p.runMode } : {}),
    ...(p?.dir ? { dir: p.dir } : {}),
    ...(p?.model ? { model: p.model } : {}),
    ...(p?.tier ? { tier: p.tier } : {}),
    ...(p?.race ? { race: p.race } : {}),
    ...(p?.raceNeed ? { raceNeed: p.raceNeed } : {}) };
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
// 8 was far too tight. A real task — install a toolchain, read a tree, wire a
// service — is dozens of directives, so auto kept halting mid-job and telling
// the user to type "continue", which is the exact thing auto exists to avoid.
// Still bounded, because every hop is a paid call, but bounded at a number
// that lets a job finish.
const AUTO_MAX_STEPS = Number(process.env.OZ_AUTO_MAX_STEPS || 60);
// An empty completion is a provider hiccup, not an answer. In auto we retry it
// silently rather than parking the thread behind a "say continue" note the
// user then has to answer — that turned a transient blip into a manual step.
const AUTO_EMPTY_RETRIES = Number(process.env.OZ_AUTO_EMPTY_RETRIES || 3);
// Ceiling on subagents per thread. Spawning is fire-and-forget and each child
// can spawn too, so without a count it is unbounded — MEASURED as 15+ threads
// all named tetris-contract, every one of them a live agent making paid calls.
//
// Scaled to the box rather than a magic number: a 2-core container and a
// 32-core one should not get the same allowance. Agents are network-bound, not
// CPU-bound — they spend their time waiting on the model — so the multiplier
// is generous, and cores are a proxy for "how big is this machine" rather than
// a real parallelism limit. The honest limit is money, which is why the
// refusal message says so.
const SPAWN_MAX_CHILDREN = Number(process.env.OZ_SPAWN_MAX_CHILDREN)
  || Math.max(8, (cpus()?.length || 2) * 4);

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
  // Stamp every line with WHICH BOT said it. The context is shared across a
  // project now, so an unlabelled line is worse than useless — recall would
  // hand one agent another's words with no way to tell them apart.
  const corpus = delta.map((h) => '[' + t.name + '] ' + (h.who === 'user' ? 'you' : (h.name || t.name)) + ': ' + h.text).join('\n');
  if (!corpus.trim()) { t.boundHistoryCount = t.history.length; return; }
  try {
    // ONE CONTEXT PER PROJECT, not per thread. Every thread used to bind to
    // its own private context, so sibling agents spawned for the same job were
    // memory-isolated: arc-tetris-engine could not recall a thing
    // arc-token-bets had established, and the user paid to re-explain shared
    // facts to each one. They are a team; the memory should be too.
    // The context lives on the ROOT and every descendant binds into it, while
    // each thread keeps its OWN boundHistoryCount so nothing is re-sent.
    const root = threads.get(rootOf(t).rootId) || t;
    let ctx = root.contextId || t.contextId;
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
    // Write to the ROOT so later siblings inherit it, and to this thread so
    // the per-call header is readable without walking the tree again.
    if (ctx) { root.contextId = ctx; t.contextId = ctx; t.boundHistoryCount = t.history.length; saveThreads(); }
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
      resolve(keepWhole(out) || '(no output)');
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
// ---------------------------------------------------------------------------
// Slash commands. Local, free, instant — none of these call a model, so
// checking your spend or clearing a thread costs nothing.
//
// Exposed over /slash-commands so the composer can autocomplete them; keeping
// one list means the menu can never drift from what actually works.
const SLASH_COMMANDS = [
  { name: '/help', args: '', help: 'every command and directive' },
  { name: '/tools', args: '', help: 'the directives bots can emit' },
  { name: '/cost', args: '', help: 'what this session has actually cost' },
  { name: '/tokens', args: '', help: 'tokens and calls this session' },
  { name: '/model', args: '[id]', help: 'show or switch this thread’s model' },
  { name: '/models', args: '[filter]', help: 'search the ~435 served models' },
  { name: '/tier', args: 'cheap|medium|expensive', help: 'how much to spend per turn when no model is pinned' },
  { name: '/race', args: '<n> | <k> <n>', help: 'launch n models; judge the first k back (k=1 = fastest wins)' },
  { name: '/compact', args: '', help: 'summarise history to shrink context' },
  { name: '/clear', args: '', help: 'wipe this thread’s history' },
  { name: '/undo', args: '', help: 'drop the last exchange' },
  { name: '/memory', args: '[text|clear]', help: 'facts injected into every turn' },
  { name: '/sessions', args: '', help: 'list all threads' },
  { name: '/all', args: '<message>', help: 'send a message to every bot in this project' },
  { name: '/ping', args: '', help: 'status of every bot in this project' },
  { name: '/cron', args: '<mins> | <message>', help: 'repeat a message on a timer' },
  { name: '/crons', args: '', help: 'list timers  (/cron del <id> removes one)' },
  { name: '/dir', args: '<path>', help: 'set this thread’s working directory' },
  { name: '/mode', args: 'auto|ask', help: 'run commands immediately, or ask first' },
];

const usd = (n) => (n >= 0.01 || n === 0 ? '$' + n.toFixed(2) : '$' + n.toFixed(5));

// BIND, DON'T PASTE — the whole point of the thing this runs on.
//
// Directive results get fed back to the model as a user message, verbatim. A
// GLOB over a 670-part upload, an LS of a big tree or an MCP tool dump is
// thousands of tokens, and in an auto chain it is re-sent on EVERY subsequent
// hop as conversation history: the window grows quadratically and the user
// pays for it each time. Meanwhile the full text is already going into
// t.history, which bindThread pushes into the thread's leCore context — so
// the model can recall any of it on demand.
//
// So: feed back the head and tail (where the answer nearly always is) and say
// plainly that the middle is recallable rather than lost.
// Directive output goes into t.history VERBATIM, because bindThread() binds
// history — so whatever is cut here is not "elided", it is DESTROYED before
// the holographic context ever sees it.
//
// These used to be hard slices at 4-8k right where the output was produced:
// a command's stdout, a READ, a FETCH, an MCP tool result. The user saw
// "…(truncated)" and the rest was simply gone — unrecallable, because it was
// never stored. That is the opposite of what this product does.
//
// So: keep the whole thing (up to a sanity ceiling that exists only to stop a
// runaway `yes` or a binary dump from bloating the thread store), let it bind,
// and let condense() decide how much the MODEL sees on the next hop. Big
// outputs are exactly the case leCore is for.
const KEEP_MAX = Number(process.env.OZ_KEEP_MAX || 400000);
function keepWhole(text) {
  const s = String(text ?? '');
  if (s.length <= KEEP_MAX) return s;
  return `${s.slice(0, KEEP_MAX)}\n…[${s.length - KEEP_MAX} chars over the ${KEEP_MAX}-char store ceiling and dropped]`;
}

const FEEDBACK_MAX = Number(process.env.OZ_FEEDBACK_MAX || 3000);
function condense(label, text) {
  const s = String(text ?? '');
  if (s.length <= FEEDBACK_MAX) return `${label}\n${s}`;
  const head = s.slice(0, Math.floor(FEEDBACK_MAX * 0.7));
  const tail = s.slice(-Math.floor(FEEDBACK_MAX * 0.3));
  // The wording matters. Retrieval is AUTOMATIC — the thread's context id
  // rides on every call as x-hrr-context and leCore injects whatever slice is
  // relevant to what you say next. Telling the model to "ask for it" invites
  // it to invent a RECALL directive that does not exist, which is the exact
  // failure mode this whole harness keeps hitting: a model fabricating a
  // mechanism instead of using the real one.
  return `${label}\n${head}\n\n…[${s.length - head.length - tail.length} chars elided from THIS message — the full output is bound to this thread's holographic memory. It is not lost: mention what you need in your next message and the relevant part is retrieved automatically. Do not invent a command to fetch it.]…\n\n${tail}`;
}

// threadId -> open SSE responses. A Set because the same thread can be open in
// two tabs, and both should see the same tokens.
const streamListeners = new Map();
function emitToThread(threadId, ev) {
  const set = streamListeners.get(threadId);
  if (!set?.size) return;                       // nobody watching — free
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of set) {
    try { res.write(line); } catch { set.delete(res); }
  }
}

async function sessionStats() {
  try { return await (await fetch(`${PROXY}/session`)).json(); }
  catch { return null; }
}

function todoBlock(t) {
  return (t.todos || []).length
    ? '\n\nTODO:\n' + t.todos.map((x, i) => `  ${i + 1}. [${x.done ? 'x' : ' '}] ${x.text}`).join('\n')
    : '';
}

async function handleSlash(task, t) {
  const m = /^\/(\w+)\s*([\s\S]*)$/.exec(task);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const arg = m[2].trim();

  if (cmd === 'help') {
    return 'Commands:\n'
      + SLASH_COMMANDS.map((c) => `  ${(c.name + ' ' + c.args).padEnd(26)} ${c.help}`).join('\n')
      + '\n\nDirectives bots can emit:\n'
      + '  RUN / WRITE / EDIT / READ / LS / GLOB / GREP / SERVE / FETCH / MCP / TODO / SPAWN / SEND / PING / PEEK\n'
      + '  (/tools for the full signatures)';
  }
  if (cmd === 'tools') {
    return 'Directives:\n'
      + '  RUN: <cmd>                          real shell, in this thread’s dir\n'
      + '  WRITE: <path> | <content>           create/overwrite a file\n'
      + '  EDIT: <path> | <old> ||| <new>      change part of a file\n'
      + '  MULTIEDIT: <path> | a|||b ;; c|||d  several edits, all-or-nothing\n'
      + '  NOTEBOOK: <path> | <cell> | <src>   replace a Jupyter cell\n'
      + '  READ: <path>                        read a file\n'
      + '  LS: <path>                          list a directory\n'
      + '  GLOB: <pattern>                     find files\n'
      + '  GREP: <regex> | <path>              search contents\n'
      + '  SERVE: <path>                       real http:// URL for a file\n'
      + '  FETCH: <url>                        read a page’s text\n'
      + '  MCP: <url> [| tool | {json}]        list or call MCP tools\n'
      + '  TODO: <lines>                       visible checklist\n'
      + '  SPAWN: <name> | <task>              a NEW subagent (names are unique —\n'
      + '                                      spawning an existing one sends to it)\n'
      + '  SEND: <name> | <msg>                more work for an EXISTING subagent\n'
      + '  PING / PEEK                         reach or inspect another bot\n\n'
      + 'READ, LS, GLOB, GREP, FETCH, PEEK and MCP run CONCURRENTLY when several\n'
      + 'appear in one reply — four files cost one round trip, not four.';
  }
  if (cmd === 'cost' || cmd === 'tokens') {
    const s = await sessionStats();
    if (!s) return 'The local openzoo proxy isn’t reachable, so there are no real numbers to show. (Not zero — unknown.)';
    const spent = Number(s.spentUsd) || 0, cogs = Number(s.cogsUsd) || 0, direct = Number(s.directUsd) || 0;
    const lines = [
      `  paid            ${usd(spent)}`,
      `  our cost        ${usd(cogs)}`,
      `  without openzoo ${usd(direct)}   (counterfactual, not a bill anyone got)`,
      `  paid calls      ${s.paidCalls || 0}`,
    ];
    if (spent > 0) {
      const mult = direct / spent;
      lines.push(`  multiple        ${mult >= 100 ? Math.round(mult) : mult.toFixed(2)}x`
        + (mult < 1 ? '  — under 1x: small inputs cost MORE than sending them directly' : ''));
    }
    return 'This session:\n' + lines.join('\n');
  }
  if (cmd === 'model') {
    if (!arg) return `This thread: ${t.model || MODEL}${t.model ? '' : '  (default)'}\nSwitch with  /model <id>   ·  /models to search.`;
    if (/^(default|reset)$/i.test(arg)) { delete t.model; saveThreads(); return `Back to the default, ${MODEL}.`; }
    t.model = arg;
    saveThreads();
    return `This thread now uses ${arg}.\nNote: while images are in play the vision model still wins, or the call would just fail.`;
  }
  // /tier — the spend dial for "auto". A pinned /model outranks it, because a
  // tier silently overriding an explicit id would make /model a suggestion.
  if (cmd === 'tier') {
    if (!arg) {
      const picks = await tierModels(t.tier || 'medium', 3);
      return `This thread: ${t.tier || 'medium'}${t.tier ? '' : '  (default)'}\n`
        + `Tiers: ${TIER_NAMES.join(' · ')}\n`
        + `Top of ${t.tier || 'medium'} right now: ${picks.join(', ')}\n`
        + (t.model ? `NOTE: /model ${t.model} is pinned on this thread, so the tier is ignored until you /model default.\n` : '')
        + 'Switch with  /tier <name>   ·  /race <n> to ask several at once.';
    }
    const want = arg.trim().toLowerCase();
    if (!TIER_NAMES.includes(want)) return `Unknown tier "${arg}". One of: ${TIER_NAMES.join(', ')}.`;
    t.tier = want; saveThreads();
    const picks = await tierModels(want, 3);
    return `This thread now runs on the ${want} tier — ${picks.join(', ')}…`
      + (t.model ? `\nBut /model ${t.model} is still pinned and wins. Run /model default to let the tier take over.` : '');
  }

  // /race — spend more to wait less, and to survive one provider having a bad
  // minute. Every entrant is PAID FOR; say so plainly, because the cost is not
  // visible anywhere else until the bill.
  if (cmd === 'race') {
    const showNow = () => {
      const n = Number(t.race) || 0, k = Math.min(Number(t.raceNeed) || 1, n || 1);
      if (n < 2) return 'not racing';
      return k > 1 ? `best of the first ${k} back, out of ${n} launched` : `${n} launched, first one back wins`;
    };
    if (!arg) {
      return `This thread: ${showNow()}\n`
        + 'Set with  /race <n>        launch n (2-4), FIRST real answer wins.\n'
        + '          /race <k> <n>    launch n, and the moment k of them are back, judge those k\n'
        + '                           and ship the winner. The stragglers are abandoned mid-flight.\n\n'
        + '/race 2 3 is the useful one. k=1 optimises latency only — on a hard question it rewards\n'
        + 'whichever model thought LEAST. k=n buys quality with the slowest entrant\'s latency, so one\n'
        + 'wedged provider stalls the whole turn. Taking the first k bounds the wait at the k-th\n'
        + 'fastest and still gives the judge something to compare.\n'
        + 'Judging is blind (A/B/C/D) and done by a cheap model. Empty replies do not count toward k.\n'
        + 'You pay for every entrant, including the abandoned ones, so n=4 costs about 4x a turn.';
    }
    const nums = arg.trim().split(/[^0-9]+/).filter(Boolean).map(Number);
    if (!nums.length) return `"${arg}" is not a number. Use /race 0 to turn it off, /race 3, or /race 2 3.`;
    // One number is n (judge nothing). Two is "k of n" — and accept them in
    // either order, because "best 2 of 3" and "3, judge 2" are the same wish
    // and guessing wrong silently changes what the user pays for.
    let n = nums.length === 1 ? nums[0] : Math.max(nums[0], nums[1]);
    let k = nums.length === 1 ? 1 : Math.min(nums[0], nums[1]);
    n = Math.max(0, Math.min(4, Math.round(n)));
    k = Math.max(1, Math.min(k, n || 1));
    if (n < 2) { delete t.race; delete t.raceNeed; saveThreads(); return 'Racing off — one model per turn.'; }
    t.race = n;
    if (k > 1) t.raceNeed = k; else delete t.raceNeed;
    saveThreads();
    const pool = await tierModels(t.tier || 'medium', 99);
    return (k > 1
      ? `Launching ${n} models per turn from the ${t.tier || 'medium'} tier (${pool.length} in the pool, drawn at random).\n`
        + `As soon as ${k} of them are back, a cheap model reads those ${k} blind and picks the best. `
        + `The other ${n - k} are abandoned.`
      : `Launching ${n} models per turn from the ${t.tier || 'medium'} tier (${pool.length} in the pool, drawn at random).\n`
        + 'First real answer wins; the rest are discarded.')
      + `\nCosts about ${n}x a normal turn — you pay for the abandoned ones too.`
      + (t.model ? `\nNOTE: /model ${t.model} is pinned, which disables racing. /model default to race.` : '');
  }

  if (cmd === 'models') {
    try {
      const list = await (await fetch(`${PROXY}/models`)).json();
      let ids = (list.data || []).map((x) => x.id);
      if (arg) ids = ids.filter((i) => i.toLowerCase().includes(arg.toLowerCase()));
      if (!ids.length) return `No model ids match "${arg}".`;
      return `${ids.length} model(s)${arg ? ` matching "${arg}"` : ''}:\n`
        + ids.slice(0, 60).map((i) => '  ' + i).join('\n')
        + (ids.length > 60 ? `\n  …${ids.length - 60} more — narrow it with /models <text>` : '');
    } catch (e) { return `Couldn’t reach the proxy: ${e.message}`; }
  }
  if (cmd === 'clear') {
    const sys = t.messages?.[0]?.role === 'system' ? [t.messages[0]] : [];
    t.messages = sys;
    t.history = [];
    delete t.contextId;
    delete t.boundHistoryCount;
    saveThreads();
    return 'Cleared. (The system prompt stays; the bound context is dropped so the next turn re-binds.)';
  }
  if (cmd === 'undo') {
    if (!t.history.length) return 'Nothing to undo.';
    // Drop back through the bot turns to the user message that caused them.
    while (t.history.length && t.history[t.history.length - 1].who !== 'user') t.history.pop();
    t.history.pop();
    if (t.messages) {
      while (t.messages.length > 1 && t.messages[t.messages.length - 1].role !== 'user') t.messages.pop();
      if (t.messages.length > 1) t.messages.pop();
    }
    saveThreads();
    return 'Undone.';
  }
  if (cmd === 'compact') {
    if (!t.messages || t.messages.length < 4) return 'Not enough history to be worth compacting.';
    const before = t.messages.length;
    const transcript = t.messages.slice(1)
      .map((x) => `${x.role}: ${typeof x.content === 'string' ? x.content : '[parts]'}`).join('\n')
      .slice(-60000);
    const sum = await brain([
      { role: 'system', content: 'Summarise this conversation so it can be CONTINUED from the summary alone. Keep decisions, file paths, commands that worked, open problems and anything the user asked for and has not received. Drop pleasantries. No preamble.' },
      { role: 'user', content: transcript },
    ], undefined, t.model).catch((e) => `(compact failed: ${e.message})`);
    if (/^\(compact failed/.test(sum)) return sum;
    t.messages = [t.messages[0], { role: 'user', content: `[summary of the conversation so far]\n${sum}` }];
    delete t.contextId;
    delete t.boundHistoryCount;
    saveThreads();
    return `Compacted ${before} messages into a summary.\n\n${sum.slice(0, 1200)}${sum.length > 1200 ? '\n…' : ''}`;
  }
  if (cmd === 'memory') {
    t.memory = t.memory || [];
    if (!arg) return t.memory.length ? 'Memory:\n' + t.memory.map((x, i) => `  ${i + 1}. ${x}`).join('\n') : 'Memory is empty. Add with  /memory <fact>';
    if (/^clear$/i.test(arg)) { t.memory = []; saveThreads(); return 'Memory cleared.'; }
    const del = /^(?:del|rm)\s+(\d+)$/i.exec(arg);
    if (del) {
      const i = Number(del[1]) - 1;
      if (!t.memory[i]) return `No memory item ${del[1]}.`;
      t.memory.splice(i, 1); saveThreads();
      return 'Memory:\n' + (t.memory.map((x, n) => `  ${n + 1}. ${x}`).join('\n') || '  (empty)');
    }
    t.memory.push(arg);
    saveThreads();
    return `Remembered. This is injected into every turn of this thread.\n  ${t.memory.length}. ${arg}`;
  }
  // Talk to the WHOLE project at once. PING: * exists for bots, but there was
  // no way for a person to do it — you had to open each thread and retype the
  // same message, which is exactly the chore that makes a 12-agent project
  // unusable.
  if (cmd === 'all') {
    if (!arg) return 'Usage:  /all <message>   — sends it to every other bot in this project.';
    const root = rootOf(t).rootId;
    const crew = [...threads.values()].filter((x) => x.id !== t.id && rootOf(x).rootId === root);
    if (!crew.length) return 'No other bots in this project yet.';
    for (const x of crew) runTurn(x.id, arg).catch(() => {});
    return `Sent to ${crew.length} bot(s): ${crew.map((x) => x.name).join(', ')}`;
  }

  // Read the room without spending anything: who is working, who is blocked on
  // an approval, what each said last.
  if (cmd === 'ping') {
    const root = rootOf(t).rootId;
    const crew = [...threads.values()].filter((x) => rootOf(x).rootId === root);
    if (crew.length < 2) return 'No other bots in this project yet.';
    return crew.map((x) => {
      const mark = x.id === t.id ? ' (here)' : '';
      const last = x.history[x.history.length - 1];
      return x.pendingRun ? `  ${x.name}${mark}: BLOCKED — waiting for your approval`
        : x.status === 'thinking' ? `  ${x.name}${mark}: working`
        : last ? `  ${x.name}${mark}: ${String(last.text).replace(/\s+/g, ' ').slice(0, 90)}`
        : `  ${x.name}${mark}: nothing yet`;
    }).join('\n');
  }

  if (cmd === 'sessions') {
    const all = [...threads.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    if (!all.length) return 'No threads.';
    return `${all.length} thread(s):\n` + all.slice(0, 40).map((x) => {
      const age = Math.round((Date.now() - x.lastActivityAt) / 60000);
      return `  ${x.name}${x.id === t.id ? ' ← here' : ''}  · ${x.status} · ${x.history.length} msgs · ${age}m ago`;
    }).join('\n');
  }
  if (cmd === 'cron' || cmd === 'crons') {
    t.crons = t.crons || [];
    const show = () => (t.crons.length
      ? 'Timers:\n' + t.crons.map((c) => `  ${c.id}  every ${c.everyMin}m  →  ${c.text.slice(0, 60)}`).join('\n')
      : 'No timers. Add one with  /cron <minutes> | <message>');
    if (cmd === 'crons' || !arg || /^(list|show)$/i.test(arg)) return show();
    const del = /^(?:del|rm)\s+(\S+)$/i.exec(arg);
    if (del) {
      const before = t.crons.length;
      t.crons = t.crons.filter((c) => c.id !== del[1]);
      saveThreads();
      return t.crons.length === before ? `No timer ${del[1]}.` : `Removed ${del[1]}.\n${show()}`;
    }
    const mk = /^(\d+)\s*m?\s*\|\s*([\s\S]+)$/.exec(arg);
    if (!mk) return 'Usage:  /cron <minutes> | <message>   ·   /cron del <id>';
    const everyMin = Math.max(1, Number(mk[1]));
    const c = { id: randomUUID().slice(0, 6), everyMin, text: mk[2].trim(), nextAt: Date.now() + everyMin * 60000 };
    t.crons.push(c);
    saveThreads();
    return `Timer ${c.id} set: every ${everyMin}m I'll send this thread “${c.text.slice(0, 60)}”.\nThis is REAL — it fires whether or not anyone is watching, and each firing costs a model call.`;
  }
  return null; // not one of ours — /dir and /mode fall through to their handlers
}

// One ticker for every thread's timers, rather than a timer per cron: it
// survives a restart with no re-arming step, because due-ness is derived from
// persisted nextAt rather than from a live setInterval.
//
// This exists because a bot once told the user it had scheduled "a recurring
// nudge every 2 minutes" — a capability that did not exist anywhere in the
// product. Now it does, and the claim can be true.
setInterval(() => {
  const now = Date.now();
  for (const t of threads.values()) {
    if (!t.crons?.length) continue;
    for (const c of t.crons) {
      if (c.nextAt > now) continue;
      c.nextAt = now + c.everyMin * 60000;
      saveThreads();
      runTurn(t.id, c.text).catch(() => {});
    }
  }
}, 15000).unref();

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
    // NAMES ARE UNIQUE. This used to call newThread() unconditionally, so a
    // model asked to "keep spawning" produced FIFTEEN threads all called
    // tetris-contract, each one a live agent burning paid calls, and the
    // sidebar became an unusable wall of identical rows. A repeat SPAWN is
    // almost always the model re-issuing work for the same worker, not asking
    // for a second identical one — so route it to the existing thread, which
    // is what SEND already does.
    const existing = findByName(name);
    if (existing) {
      runTurn(existing.id, task).catch(() => {});
      return `${name} already exists — sent it the task instead of spawning a duplicate.`;
    }
    // Storm guard. Fire-and-forget spawning is unbounded by construction: each
    // child can spawn, and nothing above it is counting.
    const siblings = [...threads.values()].filter((x) => x.parent === originId).length;
    if (siblings >= SPAWN_MAX_CHILDREN) {
      return `Not spawning "${name}": this thread already has ${siblings} subagents `
        + `(limit ${SPAWN_MAX_CHILDREN}). Reuse one with  SEND: <name> | <task>  — `
        + `every live subagent costs paid calls.`;
    }
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
    // PING: * (or 'all' / 'project') reaches EVERY bot in this project.
    // Coordinating a spawn tree by naming siblings one at a time is a chore
    // the parent should not have to do, and it cannot know who else exists.
    if (/^(\*|all|project|everyone)$/i.test(name)) {
      const me = threads.get(originId);
      const root = me ? rootOf(me).rootId : null;
      const crew = [...threads.values()].filter((x) => x.id !== originId && rootOf(x).rootId === root);
      if (!crew.length) return 'No other bots in this project yet.';
      return crew.map((x) => {
        const last = x.history[x.history.length - 1];
        return x.pendingRun ? x.name + ': BLOCKED — waiting for approval'
          : x.status === 'thinking' ? x.name + ': still working'
          : last ? x.name + ': ' + String(last.text).slice(0, 200)
          : x.name + ': no reply yet';
      }).join('\n');
    }
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
      return `${rel}:\n${keepWhole(data)}`;
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

  // Several edits to ONE file, applied all-or-nothing. Sequential EDITs are a
  // trap: the third can fail after the first two already landed, leaving the
  // file in a state neither the model nor the user expected.
  const multi = /^MULTIEDIT:\s*([^|]+)\|([\s\S]+)$/.exec(reply);
  if (multi) {
    const rel = multi[1].trim();
    const pairs = multi[2].split(';;').map((p) => p.split('|||')).filter((p) => p.length === 2);
    if (!pairs.length) return 'MULTIEDIT: expected  <path> | old ||| new ;; old2 ||| new2';
    try {
      const full = safeResolveIn(dirFor(originId), rel);
      const before = readFileSync(full, 'utf8');
      let next = before;
      const applied = [];
      for (const [oldRaw, newRaw] of pairs) {
        const o = oldRaw.trim(), n = newRaw.trim();
        const hits = next.split(o).length - 1;
        if (hits === 0) return `MULTIEDIT ${rel}: edit ${applied.length + 1} — text not found, NOTHING was written:\n  ${o.slice(0, 120)}`;
        if (hits > 1) return `MULTIEDIT ${rel}: edit ${applied.length + 1} matches ${hits} times, NOTHING was written — add context.`;
        next = next.replace(o, n);
        applied.push(o.slice(0, 40));
      }
      writeFileSync(full, next);
      return `MULTIEDIT ${rel}: ${applied.length} edit(s) applied (${before.length} -> ${next.length} bytes).`;
    } catch (e) { return `Couldn't multiedit ${rel}: ${e.message}`; }
  }

  // Jupyter: replace one cell's source by index, keeping the notebook valid.
  const nb = /^NOTEBOOK:\s*([^|]+)\|\s*(\d+)\s*\|([\s\S]+)$/.exec(reply);
  if (nb) {
    const rel = nb[1].trim();
    const idx = Number(nb[2]);
    const src = nb[3].replace(/^\n/, '');
    try {
      const full = safeResolveIn(dirFor(originId), rel);
      const doc = JSON.parse(readFileSync(full, 'utf8'));
      if (!Array.isArray(doc.cells)) return `NOTEBOOK ${rel}: no cells array — is this really a .ipynb?`;
      if (!doc.cells[idx]) return `NOTEBOOK ${rel}: no cell ${idx} (it has ${doc.cells.length}, 0-indexed).`;
      // nbformat stores source as a LIST OF LINES WITH the newlines kept.
      doc.cells[idx].source = src.split('\n').map((l, i, a) => (i === a.length - 1 ? l : l + '\n'));
      // Stale outputs next to new code are worse than none.
      if (doc.cells[idx].cell_type === 'code') { doc.cells[idx].outputs = []; doc.cells[idx].execution_count = null; }
      writeFileSync(full, JSON.stringify(doc, null, 1));
      return `NOTEBOOK ${rel}: replaced cell ${idx} (${doc.cells[idx].cell_type}); outputs cleared.`;
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
      return `${url} (${r.status}):\n${keepWhole(text)}`;
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
    return `${banner}\n$ ${tool}\n${keepWhole(out)}`;
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
  const extras = [];
  // /memory is worthless unless it reaches the model. Injected per-turn for
  // the same reason AUTO_DIRECTIVE is: the system prompt is frozen into the
  // thread at creation, so anything added there would never reach a thread
  // that already exists.
  if (t.memory?.length) {
    extras.push({ role: 'system', content: `Remember, for this thread:\n${t.memory.map((x) => `- ${x}`).join('\n')}` });
  }
  if (t.todos?.length) {
    extras.push({ role: 'system', content: `Current checklist (TODO: done <n> to tick one off):\n${t.todos.map((x, i) => `${i + 1}. [${x.done ? 'x' : ' '}] ${x.text}`).join('\n')}` });
  }
  if (t.runMode === 'auto') extras.push({ role: 'system', content: AUTO_DIRECTIVE });
  const callMsgs = extras.length ? [...t.messages, ...extras] : t.messages;
  // WHICH MODEL SERVES THIS TURN.
  //   /model <id>  pins one explicitly and always wins — an explicit choice is
  //                not something a tier gets to override.
  //   /race <n>    fires n models from the tier at once, first real answer wins.
  //   /tier        otherwise picks the tier's best model.
  // `attempt` exists because a retry must be allowed to land somewhere else:
  // see the empty-completion loop below.
  const ask = async (attempt = 0) => {
    const emit = (delta) => onEvent && onEvent({ type: 'delta', name: t.name, color: t.color, delta });
    const race = Math.min(Number(t.race) || 0, 4);
    if (!t.model && race >= 2) {
      const models = await tierModels(t.tier || 'medium', race, true);
      // need = how many must come BACK before judging. need 1 is a plain
      // first-past-the-post race; need N waits for all of them. The point of
      // the middle (2 of 3) is a judged answer without the slowest entrant
      // setting the latency.
      const need = Math.min(Math.max(Number(t.raceNeed) || 1, 1), race);
      return (await brainRace(callMsgs, emit, t.contextId, models, need)).trim();
    }
    // A retry draws a DIFFERENT model from the tier rather than the same one.
    const model = t.model || (await tierModels(t.tier || 'medium', attempt + 1, attempt > 0))[attempt] || undefined;
    return (onEvent
      ? (await brainStream(callMsgs, emit, t.contextId, model)).trim()
      : (await brain(callMsgs, t.contextId, model)).trim());
  };
  try {
    reply = await ask();
    // An EMPTY completion is transient far more often than it is meaningful —
    // it showed up repeatedly as a dead "(no response)" bubble that cost the
    // user a turn and told them nothing. Retry once before giving up, and if
    // it is still empty, say what actually happened instead of "(no
    // response)", which reads like the harness broke.
    // Retry in place rather than parking the thread behind a note the user has
    // to answer. In auto especially: a transient blip must not become a manual
    // step, which is the whole point of auto.
    // Each retry goes to a DIFFERENT model in the tier. Asking the same model
    // a fourth time after three empty completions is the definition of doing
    // the same thing and expecting a different result — and it is what produced
    // the "(the model returned nothing 4 times)" bubbles: four attempts, one
    // sick provider. Empties are per-model and uncorrelated, so moving is the
    // fix. A thread pinned with /model stays pinned; that was an explicit
    // choice and silently answering as something else would be worse.
    for (let i = 0; !reply && i < AUTO_EMPTY_RETRIES; i++) {
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      reply = await ask(t.model ? 0 : i + 1);
    }
    if (!reply) {
      reply = t.model
        ? `(${t.model} returned nothing ${AUTO_EMPTY_RETRIES + 1} times. It is pinned on this thread, so nothing else was tried — /model default frees it to fall back, or /model <id> to switch.)`
        : `(${AUTO_EMPTY_RETRIES + 1} different models in the ${t.tier || 'medium'} tier each returned nothing — that is upstream, not your input. Try /tier expensive, /race 3, or send anything to retry.)`;
    }
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
        // BIND BEFORE CHAINING. bindThread only ran at the end of a normal
        // turn, and both auto paths return before reaching it — so in auto
        // mode nothing was ever bound, exactly when the agent produces the
        // most material (command output, GLOB results, MCP tool lists). The
        // holographic context stopped growing precisely when it mattered.
        bindThread(t).catch(() => {});
        runTurn(threadId, condense('(command output)', output), onEvent).catch(() => {});
      } else {
        const note = `(auto-run paused after ${AUTO_MAX_STEPS} chained commands — that is the spend ceiling, not the end of the job. Send anything to carry on, or raise OZ_AUTO_MAX_STEPS.)`;
        t.history.push({ who: 'bot', text: note });
        onEvent?.({ type: 'final', name: t.name, color: t.color, text: note });
        saveThreads();
        bindThread(t).catch(() => {});
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

  // AUTO CONTINUES AFTER *ANY* DIRECTIVE, not just RUN.
  //
  // Only the RUN branch above fed its output back and looped, so a turn that
  // used SPAWN / WRITE / EDIT / MCP / GLOB executed one directive, posted its
  // ack, and stopped dead — the user had to type "continue" to get each
  // subsequent step, on every single turn, which is not what auto means. The
  // model never saw its own directive's result either, so it could not react
  // to "no matches" or "already exists".
  //
  // Same budget as RUN (shared t.autoSteps, reset when the user speaks), so
  // this cannot spend more than a chained RUN loop already could.
  if (t.runMode === 'auto' && ack !== null && ack !== undefined) {
    t.autoSteps = (t.autoSteps || 0) + 1;
    if (t.autoSteps < AUTO_MAX_STEPS) {
      bindThread(t).catch(() => {});   // bind every hop, not just the last one
      runTurn(threadId, condense('(directive result)', ack), onEvent).catch(() => {});
      return;
    }
    const note = `(auto paused after ${AUTO_MAX_STEPS} steps — that is the spend ceiling, not the end of the job. Send anything to carry on, or raise OZ_AUTO_MAX_STEPS.)`;
    t.history.push({ who: 'bot', text: note });
    onEvent?.({ type: 'final', name: t.name, color: t.color, text: note });
    saveThreads();
  }
  bindThread(t).catch(() => {});
}

/**
 * The PROJECT a thread belongs to = the root of its spawn tree, and how deep
 * it sits. Every thread already carried the parent id; nothing ever walked it, so
 * fifteen agents rendered as one flat list with no hint that twelve of them
 * were spawned by one root.
 *
 * Depth is capped and visited-guarded: SPAWN sets parent from whoever emitted
 * the directive, and a bot messaging its own ancestor could otherwise close a
 * cycle and hang the render loop.
 */
function rootOf(t) {
  const seen = new Set();
  let cur = t;
  let depth = 0;
  while (cur?.parent && depth < 32 && !seen.has(cur.id)) {
    seen.add(cur.id);
    const next = threads.get(cur.parent);
    if (!next) break;
    cur = next;
    depth += 1;
  }
  return { rootId: cur?.id || t.id, depth };
}

/**
 * Order threads as a TREE, not by recency.
 *
 * The sidebar sorted purely by lastActivityAt, which scrambled the hierarchy —
 * a child that just spoke jumped ABOVE its own parent, so the indentation drew
 * a structure the order contradicted. A tree you cannot read is worse than a
 * flat list, because it looks like it means something.
 *
 * Projects are ordered by their most recent activity (an active project stays
 * near the top, which is what recency was for), but WITHIN a project the order
 * is depth-first from the root, so a child is always directly under its parent
 * and indentation matches position. Siblings are ordered by recency.
 *
 * Cycle-guarded: SPAWN sets parent from whoever emitted the directive, and a
 * bot spawning toward its own ancestor could otherwise loop forever here.
 */
function orderedThreads() {
  const all = [...threads.values()];
  const byParent = new Map();
  for (const t of all) {
    const key = t.parent || '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(t);
  }
  for (const list of byParent.values()) list.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));

  // Newest-active project first.
  const roots = all.filter((t) => !t.parent || !threads.has(t.parent));
  const freshest = (t) => {
    let best = t.lastActivityAt || 0;
    const stack = [t.id];
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const c of byParent.get(id) || []) {
        best = Math.max(best, c.lastActivityAt || 0);
        stack.push(c.id);
      }
    }
    return best;
  };
  roots.sort((a, b) => freshest(b) - freshest(a));

  const out = [];
  const seen = new Set();
  const walk = (t) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    out.push(t);
    for (const c of byParent.get(t.id) || []) walk(c);
  };
  for (const r of roots) walk(r);
  // Anything unreachable (orphaned parent id) still has to appear — a thread
  // you cannot see is a thread you cannot stop, and it bills.
  for (const t of all) if (!seen.has(t.id)) out.push(t);
  return out;
}

function threadSummary(t) {
  const last = t.history[t.history.length - 1];
  return { id: t.id, name: t.name, color: t.color, parent: t.parent, status: t.status,
    preview: last ? (last.who === 'user' ? last.text : last.text).slice(0, 60) : '',
    createdAt: t.createdAt, lastActivityAt: t.lastActivityAt || t.createdAt,
    dir: t.dir || WORKSPACE_DIR, runMode: t.runMode || 'ask',
    // BLOCKED ON YOU. A thread with a pending RUN is stopped dead until
    // someone approves or denies it, and nothing in the sidebar said so — it
    // looked identical to an idle thread, so a subagent could sit waiting for
    // an approval nobody knew it wanted. The blue dot means "working"; this
    // means "your move".
    awaitingUser: Boolean(t.pendingRun),
    rootId: rootOf(t).rootId, depth: rootOf(t).depth,
    rootName: (threads.get(rootOf(t).rootId) || t).name,
    // The spend dial, so the header can show it without a round trip per
    // thread. `model` pinned means tier/race are inert — the UI says so.
    tier: t.tier || 'medium', race: Number(t.race) || 0, raceNeed: Number(t.raceNeed) || 1, model: t.model || '' };
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
  /* PROJECT HEADER. The tree indentation shows who spawned whom, but there was
     no handle on a project as a WHOLE — no way to see where one ends and the
     next begins, and no way to talk to all of it at once without opening each
     bot and retyping. This row is that handle. It only appears for a root that
     actually has children; a lone bot is not a project and does not need a
     label above it. */
  .prow { display: flex; align-items: center; gap: 8px; padding: 10px 12px 4px; margin: 0 6px;
          font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: #6f7080; }
  .prow .pname { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pcount { color: #4c4d5a; letter-spacing: 0; text-transform: none; }
  .pingall { border: 1px solid #2c2c2e; background: transparent; color: #8e8e93; font: inherit; font-size: 10px;
             letter-spacing: .04em; text-transform: uppercase; padding: 2px 7px; border-radius: 999px;
             cursor: pointer; opacity: 0; transition: opacity .12s ease, color .12s ease, border-color .12s ease; }
  .prow:hover .pingall, .pingall:focus-visible { opacity: 1; }
  .pingall:hover { color: #b8f240; border-color: #b8f240; }
  .pingall:focus-visible { outline: 2px solid #6ab0ff; outline-offset: 2px; }
  .pingall[disabled] { opacity: 1; color: #4c4d5a; border-color: #1c1c1e; cursor: default; }
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
  /* "Your move" — a CSS triangle, so it reads as a different SHAPE and not
     just a different colour. Colour alone would be invisible to a red/green
     colour-blind user, and this is the one state that needs acting on. */
  .twarn {
    width: 0; height: 0; flex: 0 0 auto;
    border-left: 5px solid transparent; border-right: 5px solid transparent;
    border-bottom: 9px solid #ffcc00;
    animation: twarnpulse 1.6s ease-in-out infinite;
  }
  @keyframes twarnpulse { 0%,100% { opacity: 1; } 50% { opacity: .45; } }
  @media (prefers-reduced-motion: reduce) { .twarn { animation: none; } }
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
  /* SPEND DIAL. Two selects rather than more pill toggles: ask/auto is a safety
     switch you flip constantly, these are set once and forgotten, and giving
     them the same visual weight would say they matter equally. Muted until
     they are off default, then they colour — an expensive tier or a live race
     should be visible at a glance, because both are spending your wallet. */
  .dial { border: 1px solid #2c2c2e; background: #131315; color: #8e8e93; font: inherit; font-size: 11px;
          border-radius: 999px; padding: 4px 8px; cursor: pointer; -webkit-appearance: none; appearance: none; }
  .dial:hover { color: #ececec; border-color: #3a3a3c; }
  .dial:focus-visible { outline: 2px solid #6ab0ff; outline-offset: 2px; }
  .dial.hot { color: #f28c4d; border-color: #f28c4d; }
  .dial.pinned { color: #4c4d5a; border-color: #1c1c1e; }
  /* Slash autocomplete. Anchored above the composer because the composer sits
     at the bottom of the viewport — a dropdown BELOW it would render off
     screen. */
  #slashMenu { display: none; position: absolute; bottom: calc(100% + 8px); left: 0; right: 0;
    max-height: 280px; overflow-y: auto; background: rgba(18,18,22,.98); border: 1px solid #2a2a33;
    border-radius: 12px; padding: 6px; z-index: 40; box-shadow: 0 10px 34px rgba(0,0,0,.55); }
  #slashMenu.show { display: block; }
  .scmd { display: flex; align-items: baseline; gap: 10px; padding: 7px 10px; border-radius: 8px;
    cursor: pointer; font-size: 12.5px; }
  .scmd:hover, .scmd.sel { background: #24242c; }
  .scmd b { color: #b8f240; font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .scmd i { color: #6f7080; font-style: normal; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .scmd span { color: #999aa8; margin-left: auto; text-align: right; }
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

  /* COPY AFFORDANCES.
     Hidden until the row is hovered so they never compete with the text, but
     always in the DOM — a button that only exists on hover is unreachable by
     keyboard, so :focus-within reveals them too and each one is tabbable. */
  .row { position: relative; }
  .copybtn {
    position: absolute; top: 2px; opacity: 0; pointer-events: none;
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 8px; border: 1px solid #3a3a3d; border-radius: 8px;
    background: #1c1c1e; color: #b9b9c0;
    font: 500 10.5px/1.4 ui-sans-serif, -apple-system, system-ui, sans-serif;
    letter-spacing: .02em; cursor: pointer;
    transition: opacity .12s ease, background .12s ease, color .12s ease;
  }
  .row.bot .copybtn { right: -2px; }
  .row.user .copybtn { left: -2px; }
  .row:hover .copybtn, .row:focus-within .copybtn { opacity: 1; pointer-events: auto; }
  .copybtn:hover { background: #2a2a2d; color: #f0f0eb; }
  .copybtn:focus-visible { opacity: 1; pointer-events: auto; outline: 2px solid #b8f240; outline-offset: 2px; }
  .copybtn.ok { background: #b8f240; border-color: #b8f240; color: #0b0b0d; }

  /* Code blocks and RUN output get their own button, pinned inside the block —
     copying one command out of a long reply is the common case, and selecting
     it by hand in a scrolling <pre> is exactly what people fail at. */
  .md-pre, .runoutput, .runcmd { position: relative; }
  .md-pre .copybtn, .runoutput .copybtn, .runcmd .copybtn { top: 6px; right: 6px; left: auto; }
  .md-pre:hover .copybtn, .runoutput:hover .copybtn, .runcmd:hover .copybtn,
  .md-pre:focus-within .copybtn, .runoutput:focus-within .copybtn, .runcmd:focus-within .copybtn {
    opacity: 1; pointer-events: auto;
  }
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
  /* position: relative anchors #slashMenu, which is absolutely positioned
     ABOVE the composer (the composer is pinned to the bottom, so a dropdown
     below it would render off screen). */
  #pill { flex: 1; display: flex; align-items: center; gap: 6px; background: #2c2c2e; border-radius: 26px;
          padding: 8px 10px 8px 14px; position: relative; }
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
      <select class="dial" id="tierSel" data-component="model-tier" aria-label="Model tier"
              title="How much to spend per turn when no model is pinned">
        <option value="cheap">cheap</option>
        <option value="medium" selected>medium</option>
        <option value="expensive">expensive</option>
      </select>
      <select class="dial" id="raceSel" data-component="model-race" aria-label="Race models"
              title="Ask N models from the tier at once, drawn at random — fastest real answer wins. You pay for every entrant.">
        <option value="0" selected>1 model</option>
        <optgroup label="first back wins">
          <option value="2">race 2</option>
          <option value="3">race 3</option>
          <option value="4">race 4</option>
        </optgroup>
        <optgroup label="judge the first k back">
          <option value="2 3">best 2 of 3</option>
          <option value="2 4">best 2 of 4</option>
          <option value="3 4">best 3 of 4</option>
          <option value="4 4">best 4 of 4</option>
        </optgroup>
      </select>
      <button class="icon-btn" id="reloadBtn" title="Restart grokui on this box">&#8635;</button>
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
          <div id="slashMenu" data-component="slash-autocomplete"></div>
          <input id="inp" placeholder="Message" autofocus autocomplete="off">
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

  // SEARCH. The input existed with no handler at all — typing in it did
  // nothing, which is worse than not shipping it. Debounced because every
  // keystroke otherwise walks every message of every thread server-side.
  let searchHits = null;   // null = not searching; [] = searched, no hits
  let searchTimer = null;
  const searchEl = document.getElementById('search');
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = searchEl.value.trim();
      if (!q) { searchHits = null; loadThreads(); return; }
      searchTimer = setTimeout(async () => {
        try {
          searchHits = await (await fetch('/search?q=' + encodeURIComponent(q))).json();
        } catch (e) { searchHits = []; }
        loadThreads();
      }, 180);
    });
    searchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { searchEl.value = ''; searchHits = null; loadThreads(); }
    });
  }

  async function loadThreads() {
    const list = await (await fetch('/threads')).json();
    // When a search is active, show ONLY matches, ordered by hit count, and
    // replace the preview with the matching line — the point of a search is
    // seeing WHY something matched, not just that it did.
    const hitById = searchHits ? new Map(searchHits.map((h) => [h.id, h])) : null;
    knownThreads = list;
    if (!activeId && list.length) activeId = list[0].id;
    threadsEl.innerHTML = '';
    const shown = hitById
      ? list.filter((t) => hitById.has(t.id))
          .sort((a, b) => (hitById.get(b.id).hits || 0) - (hitById.get(a.id).hits || 0))
      : list;
    if (hitById && !shown.length) {
      const empty = document.createElement('div');
      empty.className = 'tprev';
      empty.style.cssText = 'padding:14px 12px;color:#6f7080';
      empty.textContent = 'no messages match';
      threadsEl.appendChild(empty);
    }
    // How many bots share each root, so a header can be drawn only where there
    // is actually a project. Counted over the FULL list, not the filtered one —
    // a search that matches two of a project's nine bots should still say nine.
    const crewSize = new Map();
    for (const t of list) crewSize.set(t.rootId, (crewSize.get(t.rootId) || 0) + 1);

    let lastRoot = null;
    for (const t of shown) {
      // PROJECT HEADER + PING ALL. /all and /ping existed but only as typed
      // commands, which meant the feature was invisible: you had to know it was
      // there. This is the button.
      if (!hitById && t.depth === 0 && (crewSize.get(t.rootId) || 1) > 1 && t.rootId !== lastRoot) {
        const n = crewSize.get(t.rootId);
        const head = document.createElement('div');
        head.className = 'prow';
        head.innerHTML = '<span class="pname">' + escapeHtml(t.name) + '</span>' +
          '<span class="pcount">' + n + '</span>' +
          '<button class="pingall" data-testid="ping-all" title="Send one message to all ' + n + ' bots in this project">ping all</button>';
        head.querySelector('.pingall').addEventListener('click', async (e) => {
          e.stopPropagation();
          const btn = e.currentTarget;
          const msg = prompt('Send to all ' + n + ' bots in ' + t.name + ':');
          // Empty is a cancel, not a message — sending "" would spend a paid
          // turn on every bot in the project for nothing.
          if (msg === null || !msg.trim()) return;
          btn.disabled = true;
          btn.textContent = 'sending';
          try {
            // Routed through the ROOT with /all, so it reaches every member of
            // the project including ones not on screen — same code path as
            // typing it, so the two can never disagree.
            await fetch('/drive', { method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ threadId: t.rootId, task: '/all ' + msg.trim() }) });
            btn.textContent = 'sent';
          } catch (err) {
            btn.textContent = 'failed';
          }
          setTimeout(() => { btn.disabled = false; btn.textContent = 'ping all'; }, 1500);
          await loadThreads();
        });
        threadsEl.appendChild(head);
        lastRoot = t.rootId;
      }
      const row = document.createElement('div');
      row.className = 'trow' + (t.id === activeId ? ' active' : '');
      // SPAWN HIERARCHY. the parent id was always on every thread and nothing ever
      // rendered it, so fifteen agents looked like fifteen unrelated bots when
      // twelve of them were one project. Indent by depth; a subagent is visibly
      // a subagent. Capped at 4 so a deep tree cannot squeeze the name column
      // to nothing.
      if (t.depth) row.style.paddingLeft = (10 + Math.min(t.depth, 4) * 12) + 'px';
      if (t.depth) row.title = 'spawned under ' + (t.rootName || 'a parent');
      row.innerHTML = '<div class="tavatar" style="background:' + t.color + '">' + initials(t.name) + '</div>' +
        '<div class="tmeta"><div class="tname">' + t.name + '</div><div class="tprev">' +
        (hitById && hitById.get(t.id) && hitById.get(t.id).snippet
            ? hitById.get(t.id).snippet
            : t.awaitingUser ? 'waiting for you' : t.status === 'thinking' ? 'typing…' : (t.preview || '')) + '</div></div>' +
          // awaitingUser WINS over thinking: a thread blocked on an approval is
          // NOT working, and showing a working indicator there is a lie that
          // quietly costs you a subagent nobody knows is stuck.
          (t.awaitingUser ? '<div class="twarn" title="Waiting for your approval"></div>'
            : t.status === 'thinking' ? '<div class="tdot"></div>' : '') +
        '<button class="tclose" title="Remove">✕</button>';
      row.addEventListener('click', () => {
        activeId = t.id;
        render();
        // Selecting a bot means you intend to talk to it. Landing focus in the
        // composer saves a second click every single time, and on mobile it is
        // what raises the keyboard at all.
        requestAnimationFrame(() => { try { inp.focus(); } catch (e) {} });
      });
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
    setDials(t);
  }

  // Same rule as the mode toggle: reflect the SERVER's value, never track it
  // client-side. Both dials are also settable by typing /tier and /race, so a
  // local copy would drift the moment anyone used the chat path.
  function setDials(t) {
    const tierSel = document.getElementById('tierSel');
    const raceSel = document.getElementById('raceSel');
    if (!tierSel || !raceSel) return;
    tierSel.value = t.tier || 'medium';
    raceSel.value = (t.race || 0) < 2 ? '0'
      : ((t.raceNeed || 1) > 1 ? t.raceNeed + ' ' + t.race : String(t.race));
    // A pinned /model makes BOTH dials inert. Showing them live while they do
    // nothing is the kind of lie that costs an hour — grey them out and say why
    // on hover, rather than letting someone set "expensive" and wonder why the
    // answers never changed.
    const pinned = Boolean(t.model);
    for (const el of [tierSel, raceSel]) {
      el.disabled = pinned;
      el.className = 'dial' + (pinned ? ' pinned' : '');
      el.title = pinned
        ? t.model + ' is pinned on this thread with /model, so the tier and race are ignored. Run /model default to free them.'
        : el === tierSel
          ? 'How much to spend per turn when no model is pinned'
          : 'Ask N models from the tier at once, drawn at random — fastest real answer wins. You pay for every entrant.';
    }
    if (!pinned && (t.tier === 'expensive' || (t.race || 0) >= 2)) {
      if (t.tier === 'expensive') tierSel.className = 'dial hot';
      if ((t.race || 0) >= 2) raceSel.className = 'dial hot';
    }
  }

  async function setDial(cmd, value) {
    if (!activeId) return;
    // Reuses the SAME slash-command path, so there is one implementation of the
    // rule rather than a second that can disagree with it.
    await fetch('/drive', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: activeId, task: '/' + cmd + ' ' + value }) });
    await loadThreads();
    await render();
  }
  document.getElementById('tierSel').addEventListener('change', (e) => setDial('tier', e.target.value));
  document.getElementById('raceSel').addEventListener('change', (e) => setDial('race', e.target.value));

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
  /* Copy the given text, and say so. Returns true on success.

     navigator.clipboard is NOT always available: it requires a secure context,
     and grokui binds 0.0.0.0 inside a box, so reaching it by LAN IP (rather
     than localhost or the RunPod https proxy) is plain http — where the API is
     simply undefined. Falling back to execCommand keeps copy working there
     instead of silently doing nothing, which is the worst outcome for a button
     whose entire job is invisible. */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall through to the legacy path */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      // Off-screen but focusable: display:none or visibility:hidden make
      // execCommand('copy') a no-op in several browsers.
      ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
      ta.setAttribute('readonly', '');
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length); // iOS needs the explicit range
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  /* A copy button bound to a getter, not a value — RUN output and streaming
     replies grow after the button is created, and a captured string would copy
     a stale prefix. */
  function copyBtn(getText, label) {
    const b = document.createElement('button');
    b.className = 'copybtn';
    b.type = 'button';
    b.textContent = label || 'copy';
    b.title = 'Copy to clipboard';
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await copyText(String(getText() ?? ''));
      b.textContent = ok ? 'copied' : 'press ⌘C';
      b.classList.toggle('ok', ok);
      if (!ok) {
        // Last resort: select it so the keyboard shortcut works.
        const sel = window.getSelection();
        const r = document.createRange();
        r.selectNodeContents(b.closest('.bubble, .runcard, .md-pre') || b);
        sel.removeAllRanges(); sel.addRange(r);
      }
      setTimeout(() => { b.textContent = label || 'copy'; b.classList.remove('ok'); }, 1400);
    });
    return b;
  }

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
      // Copy WITHOUT the '$ ' prompt — pasting that into a shell is a syntax
      // error, and this is the single most re-run thing in the UI.
      cmdEl.appendChild(copyBtn(() => text, 'copy'));
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
          out.appendChild(copyBtn(() => run.output, 'copy'));
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
      // Copy the message SOURCE, not rendered HTML — markdown, code fences and
      // directive lines are what people want back; innerText drops fences and
      // mangles indentation.
      row.appendChild(copyBtn(() => text, 'copy'));
      for (const pre of textEl.querySelectorAll('.md-pre, pre')) {
        pre.appendChild(copyBtn(() => {
            // No regex here on purpose: this string lives inside a template
            // literal, so an escape sequence is eaten before the browser sees
            // it. A literal newline inside /.../ is a SyntaxError that kills
            // the entire script — the sidebar renders empty and nothing works.
            const t = pre.innerText;
            return t.endsWith('copy') ? t.slice(0, -4).replace(/\\s+$/, '') : t;
          }, 'copy'));
      }
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
    if (full.status === 'thinking') {
      addRow('bot', streamBuf || '…', t.color, t.name);
      // Tag the live bubble so deltas can repaint just this node instead of
      // re-rendering (and re-fetching) the whole thread on every token.
      const b = log.querySelector('.row:last-child .bubble');
      if (b) b.id = 'streamBubble';
    }
    if (wasNearBottom) log.scrollTop = log.scrollHeight;
  }

  // --- live token stream ---------------------------------------------------
  // The server has always been able to stream; /drive just never asked for it,
  // so a turn showed "…" for its whole duration and then arrived in one lump.
  let streamBuf = '';
  let es = null, esId = null;
  function paintStream() {
    const b = document.getElementById('streamBubble');
    if (!b) { render(); return; }
    // textContent, not markdown: the partial text is frequently mid-fence or
    // mid-link, and half-parsed markdown flickers. The final render formats it.
    b.textContent = streamBuf || '…';
    if (log.scrollHeight - log.scrollTop - log.clientHeight < 140) log.scrollTop = log.scrollHeight;
  }
  function connectStream(id) {
    if (!id || esId === id) return;
    if (es) es.close();
    esId = id;
    streamBuf = '';
    es = new EventSource('/stream/' + id);   // EventSource reconnects on its own
    es.onmessage = (e) => {
      let ev;
      try { ev = JSON.parse(e.data); } catch { return; }
      if (ev.type === 'start') { streamBuf = ''; paintStream(); }
      else if (ev.type === 'delta') { streamBuf += ev.delta || ''; paintStream(); }
      else if (ev.type === 'final' || ev.type === 'run-pending') { streamBuf = ''; render(); }
    };
    es.onerror = () => { /* EventSource retries; the 1.2s poll is the backstop */ };
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
  // --- slash autocomplete --------------------------------------------------
  // The list comes from the SERVER (/slash-commands), so the menu can never
  // offer something the server doesn't actually handle.
  const slashMenu = document.getElementById('slashMenu');
  let slashCmds = [];
  let slashHits = [];
  let slashSel = 0;
  fetch('/slash-commands').then((r) => r.json()).then((c) => { slashCmds = c; }).catch(() => {});

  function slashOpen() { return slashMenu.classList.contains('show'); }
  function renderSlash() {
    const v = inp.value;
    // Only while typing the command itself: once there's a space, the user is
    // writing arguments and a menu in the way is just noise.
    const m = /^\\/(\\w*)$/.exec(v);
    if (!m || !slashCmds.length) { slashMenu.classList.remove('show'); return; }
    const q = m[1].toLowerCase();
    slashHits = slashCmds.filter((c) => c.name.slice(1).toLowerCase().startsWith(q));
    if (!slashHits.length) { slashMenu.classList.remove('show'); return; }
    if (slashSel >= slashHits.length) slashSel = 0;
    slashMenu.innerHTML = slashHits.map((c, i) =>
      '<div class="scmd' + (i === slashSel ? ' sel' : '') + '" data-i="' + i + '">'
      + '<b>' + escapeHtml(c.name) + '</b><i>' + escapeHtml(c.args) + '</i>'
      + '<span>' + escapeHtml(c.help) + '</span></div>').join('');
    slashMenu.classList.add('show');
  }
  function slashAccept(i) {
    const c = slashHits[i];
    if (!c) return;
    // Commands that take arguments keep the caret going; ones that don't are
    // ready to send, so don't make the user delete a trailing space.
    inp.value = c.name + (c.args ? ' ' : '');
    slashMenu.classList.remove('show');
    inp.focus();
    send.classList.add('show');
  }
  slashMenu.addEventListener('mousedown', (e) => {
    const el = e.target.closest('.scmd');
    if (!el) return;
    e.preventDefault();          // keep focus in the input
    slashAccept(Number(el.dataset.i));
  });
  inp.addEventListener('input', renderSlash);
  inp.addEventListener('blur', () => setTimeout(() => slashMenu.classList.remove('show'), 120));

  inp.addEventListener('keydown', (e) => {
    if (slashOpen()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); slashSel = (slashSel + 1) % slashHits.length; renderSlash(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slashSel = (slashSel - 1 + slashHits.length) % slashHits.length; renderSlash(); return; }
      if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); slashAccept(slashSel); return; }
      if (e.key === 'Escape') { slashMenu.classList.remove('show'); return; }
    }
    if (e.key === 'Enter') submit();
  });

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

  async function tick() { connectStream(activeId); await loadThreads(); await render(); }
  tick();
  setInterval(tick, 1200);

  // --- cost HUD (ported from the Hammerspoon menu-bar widget, same source) ---
  // RESTART GROKUI. box-boot supervises this process, so exiting IS the
  // restart. Useful when a box is wedged or has a newer grokui on disk: it
  // re-execs in seconds instead of costing a box respawn and a 349MB pull.
  // It cannot change the version baked into the IMAGE — only the site's spawn
  // path can — so it says restart, not update. Promising an upgrade it cannot
  // deliver is how a UI teaches people to distrust it.
  // Cmd/Ctrl+K -> search, the shortcut every chat app trains you to expect.
  // Escape returns focus to the composer instead of leaving you stranded in
  // a box you just cleared. Bound on keydown at the document so it works no
  // matter which pane has focus.
  document.addEventListener('keydown', (e) => {
    const k = (e.key || '').toLowerCase();
    if ((e.metaKey || e.ctrlKey) && k === 'k') {
      e.preventDefault();
      const el = document.getElementById('search');
      if (el) { el.focus(); el.select(); }
      return;
    }
    // Cmd/Ctrl+Enter sends from anywhere — useful when focus drifted into a
    // RUN card or a copy button mid-thought.
    if ((e.metaKey || e.ctrlKey) && k === 'enter') {
      e.preventDefault();
      try { submit(); } catch (err) { /* not ready */ }
    }
  });

  const reloadBtn = document.getElementById('reloadBtn');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', async () => {
      reloadBtn.disabled = true;
      reloadBtn.textContent = '\u2026';
      try { await fetch('/restart', { method: 'POST' }); } catch (e) { /* exit races the reply */ }
      // Poll until it answers again — a fixed timeout either reloads into a
      // dead port or waits long after it is already back.
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try { const r = await fetch('/threads', { cache: 'no-store' }); if (r.ok) break; } catch (e) { /* still down */ }
      }
      location.reload();
    });
  }

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
  // Deposit addresses for the wallet THIS box pays from. Server-side fetch for
  // the same reason /hud-summary is: the browser cannot reach 127.0.0.1:8402
  // inside the box. The proxy only ever returns PUBLIC addresses — the key
  // never leaves /root/.openzoo/wallet.json.
  if (req.method === 'GET' && req.url === '/wallet') {
    (async () => {
      let w = { error: 'proxy unreachable' };
      try { w = await (await fetch(`${PROXY}/wallet`)).json(); }
      catch { /* proxy not up yet — say so rather than render an empty modal */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(w));
    })();
    return;
  }

  // Restart grokui in place — and ACTUALLY PICK UP THE NEW BUILD.
  //
  // Exiting is the restart: on a production box, box-server's ensureOz() poll
  // notices :4173 is closed and relaunches. (box-boot.sh does NOT supervise
  // grokui when OZ_UI_B64 is set — box-server owns it, and two supervisors is
  // the EADDRINUSE bug this file was already fighting.)
  //
  // But relaunching alone upgrades NOTHING, and that was the real bug. It runs
  // /workspace/.grokui/grokui.mjs, and box-server's seedFromImage() overwrites
  // that only when it is MISSING, under 1KB, or a saved 429 page — a perfectly
  // valid OLD copy is never replaced. /workspace is a persistent network
  // volume, so the file a box seeded on its very first boot survived every
  // restart and every fresh image pull, forever. Symptom: a new image lands,
  // the box restarts fine, and the UI is byte-identical to the day it spawned.
  //
  // So copy the baked build over the workspace copy HERE, before exiting.
  // Doing it in grokui rather than only in box-server is deliberate: box-server
  // is injected at spawn, so a fix there reaches new boxes only. This reaches
  // any box whose grokui can still serve one request.
  if (req.method === 'POST' && req.url === '/restart') {
    let seeded = null;
    try {
      // Only when they actually DIFFER — an unconditional copy would rewrite
      // the file on every restart and make "did it upgrade?" unanswerable.
      for (const f of ['grokui.mjs', 'podagent.mjs']) {
        const baked = `/opt/grokui/${f}`;
        const live = `/workspace/.grokui/${f}`;
        if (!existsSync(baked)) continue;
        const a = statSync(baked);
        const b = existsSync(live) ? statSync(live) : null;
        if (!b || a.size !== b.size) {
          mkdirSync('/workspace/.grokui', { recursive: true });
          copyFileSync(baked, live);
          seeded = (seeded || 0) + 1;
        }
      }
    } catch (e) {
      // A read-only or missing /opt is a plain `docker run`, not a box. Restart
      // is still worth doing; just do not claim an upgrade that did not happen.
      seeded = null;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, restarting: true, upgraded: seeded || 0 }));
    setTimeout(() => process.exit(0), 150);
    return;
  }

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
  // LIVE TOKENS. runTurn has always been able to stream — it takes an onEvent
  // and calls brainStream — but /drive never passed one, so every turn used
  // the non-streaming brain() and the UI just polled /threads every 1.2s.
  // The user watched a "…" bubble for the whole generation and then got the
  // answer in one lump. Same work, all of the latency, none of the feedback.
  const sse = /^\/stream\/([^/?]+)$/.exec(req.url || '');
  if (req.method === 'GET' && sse) {
    const id = sse[1];
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // Proxies in front of a box (RunPod, nginx) will happily buffer an
      // event stream into nothing until it ends, which looks exactly like
      // streaming being broken.
      'x-accel-buffering': 'no',
    });
    res.write(': open\n\n');
    if (!streamListeners.has(id)) streamListeners.set(id, new Set());
    streamListeners.get(id).add(res);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* gone */ } }, 20000);
    req.on('close', () => {
      clearInterval(ka);
      streamListeners.get(id)?.delete(res);
      if (!streamListeners.get(id)?.size) streamListeners.delete(id);
    });
    return;
  }
  // One source of truth for the composer's autocomplete — a hand-kept menu in
  // the client would drift from what the server actually handles.
  if (req.method === 'GET' && req.url === '/slash-commands') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(SLASH_COMMANDS));
    return;
  }
  // Search ACROSS MESSAGE BODIES, not just names. The sidebar only carries a
  // 60-char preview, so a client-side filter can only match what is already on
  // screen — useless for "which bot did the tetris contract". The server has
  // every message, so it does the work and returns a hit count plus the
  // matching line, and the client renders that instead of the preview.
  if (req.method === 'GET' && req.url.startsWith('/search')) {
    const q = (new URL(req.url, 'http://x').searchParams.get('q') || '').trim().toLowerCase();
    res.writeHead(200, { 'content-type': 'application/json' });
    if (!q) { res.end('[]'); return; }
    const out = [];
    for (const t of threads.values()) {
      let hits = 0;
      let snippet = '';
      for (const h of t.history) {
        const text = String(h.text || '');
        if (!text.toLowerCase().includes(q)) continue;
        hits += 1;
        if (!snippet) {
          // Centre the window on the match so the term is visible, rather than
          // returning the first 60 chars of a message that matched at char 900.
          const at = text.toLowerCase().indexOf(q);
          const from = Math.max(0, at - 24);
          snippet = (from ? '…' : '') + text.slice(from, from + 90).replace(/\s+/g, ' ');
        }
      }
      const nameHit = t.name.toLowerCase().includes(q);
      if (hits || nameHit) out.push({ id: t.id, name: t.name, color: t.color, hits, snippet });
    }
    out.sort((a, b) => b.hits - a.hits);
    res.end(JSON.stringify(out));
    return;
  }
  if (req.method === 'GET' && req.url === '/threads') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(orderedThreads().map(threadSummary)));
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
      const t = threads.get(threadId);
      // Every OTHER slash command. Local, free, instant — no model call, so
      // checking your spend or clearing a thread never costs anything.
      // /dir and /mode keep their own handlers below, untouched.
      if (t && /^\//.test(task.trim())) {
        const handled = await handleSlash(task.trim(), t).catch((e) => `error: ${e.message}`);
        if (handled !== null && handled !== undefined) {
          t.history.push({ who: 'bot', text: handled });
          t.lastActivityAt = Date.now();
          saveThreads();
          return;
        }
      }
      // "/dir <path>" is a LOCAL control command, not sent to the model at
      // all — free, instant, sets which folder this thread's WRITE/READ/SERVE
      // are scoped to. Respecify any time by sending it again.
      const dirCmd = /^\/dir\s+(.+)/.exec(task.trim());
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
      // Stream to whoever is watching this thread. emitToThread is a no-op
      // when nobody is, so a spawned subagent nobody has open costs nothing.
      runTurn(threadId, task, (ev) => emitToThread(threadId, ev), images).catch(() => {});
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(APP_HTML);
});

server.listen(PORT, BIND, () => console.log(`[grokui] http://${BIND === '0.0.0.0' ? 'localhost' : BIND}:${PORT}`));
