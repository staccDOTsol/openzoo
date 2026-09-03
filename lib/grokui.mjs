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
import { adaptiveTopK, brain, brainRace, brainStream, tierModels, MODEL, PROXY, TIER_NAMES, normalizeTier } from './podagent.mjs';
import { routeChatBody } from './modelroute.js';
import { peekDirectiveStatus, formatRaceStatus, STALE_THINKING_MS, summarizeRaceFailures, RACE_EVERY_FAILED } from './livestatus.js';
import { creditBalance } from './info.js';
import { guardFindCwd } from './runguard.js';
/* subscription.js lane stripped — unrestricted clients, x402 only */
import {
  prepareChildDir, finishChildDir, lockWorktree, unlockWorktree,
  parsePrRef, fetchSpecsForOrigin, agentSlug,
} from './worktree.mjs';
import {
  filesForCorpus as collectFilesForCorpus,
  readFilesForCorpus,
  looksLikeFileView,
  extractBashPaths,
} from './spill.js';
import { BIND_MIN_CHARS } from './hrr.js';
import { stripThinkTags, takeThink } from './think.js';
import {
  runClaudeCode, setClaudeRunnerForTest, toolStatusLine, CLAUDE_MISSING,
} from './claudecode.js';

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
// chat. inDir / safeResolveIn reject any path that would escape that thread's
// root (../, symlink tricks). An absolute path that is ALREADY inside the
// root is used as-is — path.join(base, '/Users/...') doubles the prefix
// (MEASURED live: LIST of t.dir produced
// ENOENT scandir '/Users/…/Users/…/'). path.resolve treats an absolute
// second arg as a new root, which is the right join.
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
/**
 * Resolve `rel` inside `base`. If `rel` is already absolute, use it as-is
 * when it stays inside `base` — never path.join(base, '/Users/...').
 */
function inDir(base, rel) {
  const root = path.resolve(expandHome(String(base || '.')));
  const raw = expandHome(String(rel ?? '').trim() || '.');
  const full = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error("path escapes this thread's directory");
  }
  return full;
}
function safeResolveIn(base, rel) { return inDir(base, rel); }
function listDir(base, rel = '.') {
  return readdirSync(inDir(base, rel), { withFileTypes: true });
}
/** If `spec` is an absolute path inside `base`, return the relative remainder
 *  ('' when it IS the base). Non-absolute specs are left alone (null). */
function stripBasePrefix(base, spec) {
  const raw = expandHome(String(spec || '').trim());
  if (!raw || !path.isAbsolute(raw)) return null;
  const root = path.resolve(expandHome(String(base || '.')));
  const full = path.resolve(raw);
  if (full === root) return '';
  if (full.startsWith(root + path.sep)) return full.slice(root.length + 1);
  throw new Error("path escapes this thread's directory");
}

/**
 * Reasoning used to leak `<think>…</think>` into the visible bubble and then
 * get sent back to the model. Visible text is still stripped (see takeThink);
 * the plaintext is kept on the history row as `thinking` and folded in the
 * canvas. Encrypted blobs never become a chip — that lives in lib/think.js.
 */
const MIME = { html: 'text/html', htm: 'text/html', css: 'text/css', js: 'application/javascript',
  mjs: 'application/javascript', json: 'application/json', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', txt: 'text/plain', md: 'text/plain' };
let workspacePort = null;
let workspacePortResolve = () => {};
let workspaceBinding = false;
const workspacePortReady = new Promise((resolve) => { workspacePortResolve = resolve; });
function bindWorkspaceServer() {
  if (workspaceServer.listening) {
    workspacePort = workspaceServer.address().port;
    workspacePortResolve(workspacePort);
    return;
  }
  if (workspaceBinding) return;
  workspaceBinding = true;
  try {
    workspaceServer.listen(0, '127.0.0.1', () => {
      workspacePort = workspaceServer.address().port;
      workspacePortResolve(workspacePort);
    });
  } catch (err) {
    workspaceBinding = false;
    console.error('[grokui] workspace server:', err.message);
    setTimeout(bindWorkspaceServer, 250);
  }
}
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
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      // EDIT of the same html must not be served from a cached first write.
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});
workspaceServer.on('error', (err) => {
  workspaceBinding = false;
  console.error('[grokui] workspace server:', err.message);
  setTimeout(bindWorkspaceServer, 250);
});
bindWorkspaceServer();

function isPreviewableRel(rel) {
  const base = path.basename(String(rel || '').split('?')[0]).toLowerCase();
  return base.endsWith('.html') || base.endsWith('.htm');
}

async function ensureWorkspacePort(ms = 4000) {
  if (workspacePort) return workspacePort;
  if (!workspaceServer.listening) bindWorkspaceServer();
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  const port = await Promise.race([workspacePortReady, timeout]);
  clearTimeout(timer);
  return port || workspacePort;
}

function workspaceFileUrl(originId, rel) {
  const clean = String(rel || '').replace(/^\/+/, '');
  return `http://localhost:${workspacePort}/${originId}/${clean}`;
}

// WRITE/EDIT of a playable page must ack a real http:// URL (same shape as
// SERVE), not a dead disk path. Wait for the static server rather than
// telling the user to try again after they just wrote a game.
async function previewAck(originId, rel) {
  if (!isPreviewableRel(rel)) return '';
  const port = await ensureWorkspacePort();
  if (!port) {
    return `\nPreview: the workspace server is binding; the page is ${rel} and will be at `
      + `http://localhost/<port>/${originId}/${String(rel).replace(/^\/+/, '')}.`;
  }
  return `\nPreview: ${workspaceFileUrl(originId, rel)}`;
}

const HTML_PREVIEW_RULE = `
PREVIEW IS AUTOMATIC. After you WRITE or EDIT a .html / .htm file (including index.html),
the harness already served it — the WRITE ack includes a real http://localhost URL and the
chat bubble shows a live iframe. The harness will preview. Do not tell the user you
"can't preview", cannot open a browser, or dump a raw disk path (/Users/..., ~/.openzoo/...)
as the punchline. The page is already on screen. If you mention a location, use that
http://localhost link, never a filesystem path.
`;

const PALETTE = ['#e91e8c', '#34c759', '#ff9500', '#5e5ce6', '#ff3b30', '#0a84ff', '#00c7be'];
function colorFor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// Frozen SYSTEM is baked into old threads at creation. This string is also
// injected every turn (extras + AUTO_DIRECTIVE) so live Auto cannot "shell
// the proxy" just because the thread was born with the old "you CAN curl
// :8402" paragraph. Site-check curls of localhost:8080 stay allowed.
const CHAT_NOT_PROXY = `You already ARE the chat. Never RUN curl, wget, or fetch against localhost:8402 or
/v1/chat/completions — that dumps another model's JSON into the canvas and pays twice.
Orange Auto = WRITE / READ / RUN / GLOB for real work, not "shell the proxy."
Never mkdir empty trees and declare DONE — WRITE the files.`;
const PROXY_SHELL_REFUSE = 'refused: you already ARE the chat. Never curl/wget/fetch localhost:8402 or /v1/chat/completions — Orange Auto is WRITE/READ/RUN for real work, not shelling the proxy.';
function looksLikeProxyShell(cmd) {
  const s = String(cmd || '');
  if (!/\b(curl|wget|fetch)\b/i.test(s)) return false;
  if (/(?:localhost|127\.0\.0\.1|\[::1\])/i.test(s) && /:8402\b/.test(s)) return true;
  if (/(?:localhost|127\.0\.0\.1|\[::1\])[^\s'"]*\/v1\/chat\/completions/i.test(s)) return true;
  return false;
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
  PING: <name>                                       wake that agent to take a turn now
                                                       (* / all / everyone = the whole project).
                                                       You get back "pinged, working" — that is
                                                       an ack, not the child's result
  PEEK: <name>                                       a fuller look — its last few messages,
                                                       not just the latest one. Read-only.
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
                                                       static files, just not run a process.
                                                       HTML writes are auto-served — you do
                                                       not need a separate SERVE for a
                                                       playable page.
  FETCH: <url>                                        actually fetch and read a page's real
                                                       text — web search only gives you short
                                                       snippets; use FETCH when asked to
                                                       "read" or quote something specific
${HTML_PREVIEW_RULE}

HOW YOUR SITE ACTUALLY GETS A URL — read this before writing web files.

The working directory is served as a STATIC FILE SERVER at a public URL. It does not run
a bundler, a dev server, or a build step. Nothing watches your files and compiles them.
MEASURED failure: a crew wrote tetris-metagame/index.html containing
  <script type="module" src="/src/main.jsx">
an unbuilt Vite scaffold. Browsers CANNOT execute JSX, so that page returned 200 and
rendered a blank screen — for hours, while the crew reported the site as built.

1. BUILD BEFORE YOU CLAIM A SITE EXISTS. For a Vite/React app: install, build, and put the
   OUTPUT where it is served. Then RUN a command that prints the built index.html and check
   the script tag points at a real .js file, not a .jsx/.ts/.tsx source.
2. PREFER PLAIN HTML. One self-contained index.html — inline CSS, vanilla JS — needs no
   build and works the instant you write it. For most things asked of you that is entirely
   sufficient, and it gets a live URL now instead of after a toolchain fight.
3. PUT index.html AT THE WORKSPACE ROOT unless you have a reason not to. The SHALLOWEST
   index.html is the one the preview shows.
4. RELATIVE ASSET PATHS: src="assets/app.js", never src="/assets/app.js". The site is
   served under a path prefix, so a leading slash resolves off the site entirely.
5. CHECK IT YOURSELF before reporting done —  RUN: curl -s localhost:8080/site/ | head -20
   and READ the output. A .jsx reference, or <div id="root"></div> with no working script,
   means it is broken and you are not finished.

Never report a site as finished until you have curled it and seen real markup.


SHIP IT IN ONE PASS. This is the single most important instruction here.

You are not a planning assistant. The user wants a WORKING THING at a URL, and they want
it from the first reply — the way v0 or lovable answers: you describe it, it exists.

So on any "build me X" request:

  WRITE THE WHOLE THING NOW. One self-contained index.html at the workspace root, with
  inline CSS and vanilla JS, complete enough to open and use. Not a skeleton, not a
  scaffold, not "here is the structure and I will fill it in" — a real, playable,
  clickable artifact on the FIRST reply. Ugly and working beats elegant and absent.

  NO BUILD STEP unless the user asked for one. Do not npm init, do not scaffold Vite or
  React or Next, do not create package.json, do not make a src/ tree. The directory is a
  static file server: a plain index.html works the instant you write it, and a framework
  scaffold is a blank page until someone runs a build nobody asked for.

  ITERATE ON THE FILE, NOT ON A PLAN. When something needs changing, EDIT the file and
  say what changed in one line. Never restate the roadmap, never re-list the features,
  never ask which part to do first.

  DO NOT SPLIT ONE ARTIFACT ACROSS AGENTS. If it is one page, one game, one dashboard —
  build it yourself. Spawning a subagent per feature produces five halves of a thing and
  no thing. Spawn only for work that is genuinely separate and parallel, and only when
  told to.

  DO NOT WRITE DOCUMENTS INSTEAD OF CODE. SPEC.md, ARCHITECTURE.md, a design doc, a
  checklist — none of these are what was asked for and none of them render at a URL.
  Write the artifact. If you truly need to think first, think in the reply, not in a file.

  A STACK IS NEVER YOURS TO PICK. If the brief names one — a chain, an engine, an SDK, a
  token — use exactly that, even where your training pulls somewhere else. "Smart
  contract" does not mean Solidity. Anything you were told about the stack outranks
  anything you assume.

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
  LS: [path]                                          list a directory. The argument is
                                                       OPTIONAL — a bare  LS:  on its own
                                                       line lists the working directory.
                                                       Never write a placeholder like
                                                       <blank> or <path>; either give a
                                                       real path or give nothing.
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
                                                       thread's directory. Stay in that directory. Never find / — use GLOB: or find . -maxdepth N. By default this
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

${CHAT_NOT_PROXY}

COST ACCOUNTING — do NOT compute this yourself from token counts. Every response carries an
"x402" object; read the numbers off it: x402.billedUsd (what the user paid — OpenRouter price, plus 33% of savings vs
direct when any), x402.cogsUsd (our upstream cost), x402.directUsd (what answering
WITHOUT the zoo would have cost), x402.savedUsd (dollars saved), and
x402.savesVsDirect (the multiple). Summing usage.cost or usage.prompt_tokens and comparing
that to a provider's list price is WRONG and understates the saving enormously: against a
bound context, prompt_tokens counts only the small slice leCore recalled, NOT the corpus
that slice stands in for — so you end up pricing the discount against itself and concluding
the zoo "cost more". MEASURED: a real 21-question run reported 202,238 prompt tokens while
each attach call stood in for a 5,356,546-token corpus — a 556x understatement, and that
corpus is ~42x larger than the model's own context window, so the "direct" comparison it
was measured against was not merely pricier but IMPOSSIBLE. When the user asks what they
saved, quote x402.billedUsd, x402.directUsd and x402.savedUsd. If savedUsd is 0 / savesVsDirect is below 1x, say so
plainly — that happens on small inputs, where the corpus is too small to save anything.
For normal questions just answer directly — do not use any of these unless the request
actually calls for delegation or file work.`;

// id -> { id, name, color, parent, messages: [{role,content}], history: [{who,text}], status }
const threads = new Map();
const turnAborts = new WeakMap();

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
    for (const t of arr) {
      // A crash mid-turn persisted status=thinking. Do not reload into mute "…".
      if (t.status === 'thinking') {
        t.status = 'idle';
        t.liveStatus = '';
        t.liveRace = null;
      }
      if (Array.isArray(t.history)) {
        for (const h of t.history) {
          if (h && h.who === 'bot' && typeof h.text === 'string') {
            const parts = takeThink(h.text, h.thinking);
            h.text = parts.text;
            if (parts.thinking) h.thinking = parts.thinking;
            else delete h.thinking;
          }
        }
      }
      if (Array.isArray(t.messages)) {
        for (const m of t.messages) {
          if (m && m.role === 'assistant' && typeof m.content === 'string') {
            m.content = stripThinkTags(m.content);
          }
        }
      }
      threads.set(t.id, t);
    }
    return true;
  } catch { return false; }
}

function attachChildDir(t, parent, spec) {
  // Never copy parent.dir — that is the testingcluade bug: every tetris kid
  // sat in the parent's checkout and collided. Isolated worktree (git) or
  // ~/.openzoo/grokui-worktrees/<slug> (not git). Same Node process; cwd is t.dir.
  if (t.dir && t.worktree?.path && existsSync(t.dir)) return t;
  const ws = prepareChildDir(parent, t.name, spec);
  t.dir = ws.path;
  t.worktree = {
    path: ws.path,
    branch: ws.branch || null,
    parentDir: ws.parentDir,
    kind: ws.kind,
    repo: ws.repo || null,
    fetchRef: ws.fetchRef || '',
    baseRef: ws.baseRef || '',
  };
  return t;
}

function newThread(name, parent, members, spec) {
  const id = randomUUID();
  // A subagent INHERITS its parent's run mode and model — not its directory.
  //
  // runMode especially: children defaulted to 'ask', so a bot spawned in auto
  // mode emitted a RUN, the harness parked it awaiting approval, and nobody
  // was watching that thread to approve it. The subagent looked "stuck
  // typing…" forever while the parent reported it as working. Spawning from
  // auto and landing in ask is never what the user meant.
  //
  // dir is isolated per child (git worktree or ~/.openzoo/grokui-worktrees).
  // Copying p.dir put every SPAWN in /Users/stacc/testingcluade.
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
    members: members || null, history: [], status: 'idle', turnSeq: 0, createdAt: Date.now(), lastActivityAt: Date.now(),
    ...(p?.runMode ? { runMode: p.runMode } : {}),
    ...(p?.model ? { model: p.model } : {}),
    ...(p?.tier ? { tier: p.tier } : {}),
    ...(p?.race ? { race: p.race } : {}),
    ...(p?.raceNeed ? { raceNeed: p.raceNeed } : {}) };
  if (p) attachChildDir(t, p, spec);
  // Brand-new chat (no parent) starts empty: own holobrain, no contextId,
  // no boundItems. Do not copy the previous thread's bind / corpus.
  // SPAWN kids also start unbound here; bindThread shares the parent root
  // on first bind. Existing threads on disk keep whatever they already have.
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
  PING: <name>                                       wake that agent (* / all = the project)
  PEEK: <name>                                       a fuller look at its last few messages

You ALSO have real (sandboxed) filesystem access, scoped to THIS group's own directory —
the user sets or changes it with "/dir <path>" in chat. Same format:
  WRITE: <relative path> | <content>                 create or overwrite a file
  READ: <relative path>                              read a file back
  SERVE: <relative path, or blank for the dir root>   get a real http:// URL for it — use
                                                       this instead of saying you can't
                                                       expose a port. HTML writes are
                                                       auto-served; you do not need SERVE
                                                       just to preview a playable page.
  FETCH: <url>                                        actually fetch and read a page's real
                                                       text — web search only gives snippets
${HTML_PREVIEW_RULE}
  RUN: <shell command>                                run a REAL shell command in this
                                                       group's shared directory — pauses the
                                                       WHOLE round for the user's approval

SHIP IT IN ONE PASS. This is the single most important instruction here.

You are not a planning assistant. The user wants a WORKING THING at a URL, and they want
it from the first reply — the way v0 or lovable answers: you describe it, it exists.

So on any "build me X" request:

  WRITE THE WHOLE THING NOW. One self-contained index.html at the workspace root, with
  inline CSS and vanilla JS, complete enough to open and use. Not a skeleton, not a
  scaffold, not "here is the structure and I will fill it in" — a real, playable,
  clickable artifact on the FIRST reply. Ugly and working beats elegant and absent.

  NO BUILD STEP unless the user asked for one. Do not npm init, do not scaffold Vite or
  React or Next, do not create package.json, do not make a src/ tree. The directory is a
  static file server: a plain index.html works the instant you write it, and a framework
  scaffold is a blank page until someone runs a build nobody asked for.

  ITERATE ON THE FILE, NOT ON A PLAN. When something needs changing, EDIT the file and
  say what changed in one line. Never restate the roadmap, never re-list the features,
  never ask which part to do first.

  DO NOT SPLIT ONE ARTIFACT ACROSS AGENTS. If it is one page, one game, one dashboard —
  build it yourself. Spawning a subagent per feature produces five halves of a thing and
  no thing. Spawn only for work that is genuinely separate and parallel, and only when
  told to.

  DO NOT WRITE DOCUMENTS INSTEAD OF CODE. SPEC.md, ARCHITECTURE.md, a design doc, a
  checklist — none of these are what was asked for and none of them render at a URL.
  Write the artifact. If you truly need to think first, think in the reply, not in a file.

  A STACK IS NEVER YOURS TO PICK. If the brief names one — a chain, an engine, an SDK, a
  token — use exactly that, even where your training pulls somewhere else. "Smart
  contract" does not mean Solidity. Anything you were told about the stack outranks
  anything you assume.


HOW YOUR SITE ACTUALLY GETS A URL — read this before writing web files.

The working directory is served as a STATIC FILE SERVER at a public URL. It does not run
a bundler, a dev server, or a build step. Nothing watches your files and compiles them.
MEASURED failure: a crew wrote tetris-metagame/index.html containing
  <script type="module" src="/src/main.jsx">
an unbuilt Vite scaffold. Browsers CANNOT execute JSX, so that page returned 200 and
rendered a blank screen — for hours, while the crew reported the site as built.

1. BUILD BEFORE YOU CLAIM A SITE EXISTS. For a Vite/React app: install, build, and put the
   OUTPUT where it is served. Then RUN a command that prints the built index.html and check
   the script tag points at a real .js file, not a .jsx/.ts/.tsx source.
2. PREFER PLAIN HTML. One self-contained index.html — inline CSS, vanilla JS — needs no
   build and works the instant you write it. For most things asked of you that is entirely
   sufficient, and it gets a live URL now instead of after a toolchain fight.
3. PUT index.html AT THE WORKSPACE ROOT unless you have a reason not to. The SHALLOWEST
   index.html is the one the preview shows.
4. RELATIVE ASSET PATHS: src="assets/app.js", never src="/assets/app.js". The site is
   served under a path prefix, so a leading slash resolves off the site entirely.
5. CHECK IT YOURSELF before reporting done —  RUN: curl -s localhost:8080/site/ | head -20
   and READ the output. A .jsx reference, or <div id="root"></div> with no working script,
   means it is broken and you are not finished.

Never report a site as finished until you have curled it and seen real markup.

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
savedUsd, savesVsDirect). Never derive it by summing usage.cost or usage.prompt_tokens against a
provider's list price: on a bound context prompt_tokens counts only the slice leCore
recalled, not the corpus it stands in for, so that math prices the discount against itself
and wrongly concludes the zoo cost more.
${CHAT_NOT_PROXY}
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
  const msgs = [
    { role: 'system', content: member.systemPrompt || SYSTEM },
    { role: 'system', content: CHAT_NOT_PROXY },
  ];
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
// passthrough the wiki documents. Fire-and-forget after each turn so the
// project corpus stays bound. Completions must NOT send X-HRR-Context:
// sidecar maybeCacheCorpus skips spill when that header is set, which is
// the path `npx openzoo claude` uses (bind-prefix / send-3/131-turns).
// Chunked, not one shot: a single request over ~8MB (post JSON-escaping)
// gets rejected, so a large/growing thread's bind would silently fail past
// whatever point it crossed that line — confirmed live by a bot's own RUN
// diagnostic ("Failed at chunk 2 — JSON escaping pushed a 3MB chunk over the
// ~8MB request limit"). 512KB raw per request leaves wide margin. Each
// chunk after the first carries the PREVIOUS chunk's context_id so the
// sidecar appends to the same bound context instead of starting fresh.
const BIND_CHUNK_BYTES = 512 * 1024;
// Soft hop counter per user message. Each hop is a paid call. 8 parked a real
// job mid-toolchain and told the user to type "continue" — the thing auto
// exists to avoid. 60 was still a "type continue" trap on anything with a
// crew. Hitting the number now INJECTS continue and keeps going until the
// model emits DONE or the user flips to ask. The env var is a nudge interval,
// not a stop.
const AUTO_MAX_STEPS = Number(process.env.OZ_AUTO_MAX_STEPS || 500);
// An empty completion is a provider hiccup, not an answer. In auto we retry it
// silently rather than parking the thread behind a "say continue" note the
// user then has to answer — that turned a transient blip into a manual step.
const AUTO_EMPTY_RETRIES = Number(process.env.OZ_AUTO_EMPTY_RETRIES || 3);
const NUDGE = 'That reply announced work instead of doing it — no directive line reached the harness, '
  + 'so nothing ran. Emit the directive NOW, as the first line of your reply, with no preamble: '
  + 'RUN:, SPAWN:, READ:, WRITE:, GLOB:, FETCH:, MCP: or SERVE:. '
  + 'Exactly the syntax from your instructions — not [TOOL_CALL], not JSON, not a function-call envelope. '
  + 'If several steps are needed, emit the FIRST one; you get its real output back and continue from there.';
const AUTO_CONTINUE = 'Please continue the current job. Do not stop to ask the user.';
const AUTO_RACE_RETRY = 'AUTO is still on — the last model call failed (race/empty/error). '
  + 'Do not stop and do not ask the user to type continue. '
  + 'Emit the next directive now (RUN:/SPAWN:/SEND:/READ:/WRITE:/GLOB:/FETCH:/MCP:/SERVE:), '
  + 'or DONE: if the job is actually finished.';
const AUTO_EMPTY_RETRY = 'AUTO_EMPTY_RETRY: the command produced no output, try a different command or a different path, do not stop.';
// Said it would, without a directive line. "Spawned X" and "working on it" are
// in here because they are FALSE without a SPAWN: in the same reply — the bot
// reports success for something the harness never saw.
const ANNOUNCEMENT = /\b(?:I(?:'| a)?ll |I will |let me |I'm going to |I am going to |first,? |next,? |now I'll |starting|kicking off|spawn(?:ing|ed)|about to|going to (?:check|run|create|start|install))\b/i;
const STALLED_OFFER = /\b(?:if you want(?:ed)?,? I can|should I\b|let me know(?: and I['’]ll)?|ready to proceed|want me to|would you like(?: me to)?|spawned \S[\s\S]{0,80}working on it|kicked that off)\b/i;
function isDoneReply(text) {
  return /^[ \t>*-]*DONE:/m.test(String(text || ''));
}
function isTransientModelFail(text) {
  const s = String(text || '').trim();
  if (s === RACE_EVERY_FAILED || /^\(race:\s*every model failed/i.test(s)) return true;
  if (/^error:/i.test(s)) return true;
  if (/returned nothing \d+ times|each returned nothing/i.test(s)) return true;
  return false;
}
function isEmptyWalletPayment(text) {
  // Empty/underfunded only — not a generic HTTP 402 handshake.
  return /\b(?:wallet is empty|empty wallet|wallet underfunded|underfunded)\b/i.test(String(text || ''));
}
function isPaymentFailed(text) {
  return isEmptyWalletPayment(text)
    || /\b(?:payment failed|HTTP 402|payment required)\b/i.test(String(text || ''));
}
// Empty stdout, "(no output)", or a directive that found nothing. That is
// still a command-output hop today, so AUTO used to chain once and then park
// as if the job had succeeded. It has not — try another command or path.
function isEmptyExecOutput(text) {
  const s = String(text ?? '').trim();
  return !s || s === '(no output)';
}
function isEmptyDirectiveAck(text) {
  const s = String(text ?? '').trim();
  if (isEmptyExecOutput(s)) return true;
  if (/:\s*\(empty\)$/i.test(s)) return true;
  if (/:\s*no matches\s*$/i.test(s)) return true;
  return false;
}
function isEmptyToolResult(text) {
  if (text == null) return false;
  const s = String(text).trim();
  if (isEmptyExecOutput(s)) return true;
  const cmd = /^\(command output\)\s*([\s\S]*)$/.exec(s);
  if (cmd) return isEmptyExecOutput(cmd[1]);
  const dir = /^\(directive result\)\s*([\s\S]*)$/.exec(s);
  if (dir) return isEmptyDirectiveAck(dir[1]);
  return false;
}
function isEmptyShownRun(text) {
  const shown = /^\$ [^\n]*\n([\s\S]*)$/.exec(String(text ?? ''));
  return Boolean(shown && isEmptyExecOutput(shown[1]));
}
// Park only: ask mode, pendingRun, DONE:, 402/empty-wallet, or the hard cap.
// Empty /(no output) exec is not DONE — keep going with AUTO_EMPTY_RETRY.
function shouldKeepAuto(t, reply, userText) {
  if (!t || t.runMode !== 'auto') return false;
  if (t.pendingRun) return false;
  if ((t.autoSteps || 0) >= AUTO_MAX_STEPS) return false;
  if (isPaymentFailed(reply)) return false;
  if (isEmptyToolResult(userText) || isEmptyShownRun(reply)) return true;
  if (isDoneReply(reply)) return false;
  return true;
}
function enqueueAutoHop(t, threadId, userText, onEvent) {
  bindThread(t).catch(() => {});
  t.autoSteps = (t.autoSteps || 0) + 1;
  if (t.autoSteps >= AUTO_MAX_STEPS) return false;
  kickTurn(threadId, userText, onEvent).catch(() => {});
  return true;
}
function autoHopText(reply, userText) {
  if (isEmptyToolResult(userText) || isEmptyShownRun(reply)) return AUTO_EMPTY_RETRY;
  return isTransientModelFail(reply) ? AUTO_RACE_RETRY : AUTO_CONTINUE;
}
// PING used to be a read: last-line status, no turn. Idle children stayed idle
// while the parent treated the dump as evidence they had acted. A ping is a
// wake — the same harness continue AUTO already uses, unless a custom message
// was given. Thinking threads are left alone; pendingRun stays on the human.
let runTurnOverride = null;
function setRunTurnForTest(fn) {
  runTurnOverride = typeof fn === 'function' ? fn : null;
}
let brainAskOverride = null;
function setBrainAskForTest(fn) {
  brainAskOverride = typeof fn === 'function' ? fn : null;
}
function kickTurn(threadId, userText, onEvent, images) {
  // Default to emitToThread so a spawned/pinged kid streams when someone has
  // that thread open. emitToThread is a no-op if nobody is watching.
  const emit = onEvent === undefined ? (ev) => emitToThread(threadId, ev) : onEvent;
  return (runTurnOverride || runTurn)(threadId, userText, emit, images);
}
function pingWakeText(extra) {
  const msg = String(extra || '').trim();
  // A restated spawn brief is not a nudge. MEASURED live: existing-SPAWN
  // wrapped children in childKickoff({fresh:false}) → "CONTEXT REFRESH —
  // you already exist" and they thought, then refused to redo the job.
  if (!msg || /CONTEXT REFRESH|--- your specific job ---|ROOT ASK —/.test(msg)) return AUTO_CONTINUE;
  return msg;
}
function pingCanWake(x) {
  return Boolean(x) && !x.pendingRun && x.status !== 'thinking';
}
function wakeOnPing(x, extra) {
  // Never childKickoff. Ping is a short continue, not a first-day re-brief.
  kickTurn(x.id, pingWakeText(extra)).catch(() => {});
}
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
// The auto loop keeps going until DONE:, a real blocking question, or the
// step cap. A reply that merely OFFERS used to end the run — auto silently
// degraded to ask the moment the model hedged. Observed live: "If you want,
// I can rewrite the prompt", "Spawned mcp-integration — working on it" with
// nothing spawned, and a kid that RAN ls then sat idle. Models are trained
// to close on a consent question; in auto that instinct is the bug. The
// system prompt is frozen into a thread at creation, so an existing thread
// can only be reached by a per-turn message.
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
without a fact only the user has.

When the job is actually finished, emit DONE: as the first line. A status
sentence is not a stop — the harness keeps this thread working until DONE:,
a real blocking question, or the step cap. Empty output, "(no output)", and
GLOB/GREP with no matches are not finished — try a different command or path.

${CHAT_NOT_PROXY}`;

/**
 * Holobrain owner for a thread.
 * SPAWN kids share the project root (current SPAWN semantics).
 * A brand-new chat (no parent) is its own root — never attach another
 * thread's contextId / boundItems.
 */
function holobrainOf(t) {
  if (!t) return null;
  if (t.parent) return threads.get(rootOf(t).rootId) || t;
  return t;
}

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
    // SPAWN kids share the project root holobrain so sibling agents can
    // recall what the crew already bound. A brand-new chat (no parent) is
    // its own root — do not attach the previous thread's contextId.
    // Existing threads that already have a bind keep it (we never delete
    // contextId here).
    const brain = holobrainOf(t) || t;
    let ctx = brain.contextId || t.contextId;
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
      // How many chunks the project's holobrain now holds. This is the number
      // adaptive top_k scales on — without it we would be guessing, which is
      // exactly how top_k ended up pinned at 8 in the first place.
      if (Number(j?.bound)) brain.boundItems = (brain.boundItems || 0) + Number(j.bound);
      else break; // this chunk failed — stop, keep whatever bound so far rather than lose it all
    }
    // Write to the holobrain owner (project root for SPAWN kids, this thread
    // for a new chat) and to this thread so the per-call header is local.
    if (ctx) { brain.contextId = ctx; t.contextId = ctx; t.boundHistoryCount = t.history.length; saveThreads(); }
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
const MCP_AS_BASH_REFUSE = 'That RUN: body is MCP tool names, not a shell command. '
  + 'get_skill, proofnetwork-*, publish-update, and MCP: lines must not be executed by bash '
  + '— that is how a live thread printed `/bin/bash: get_skill: command not found`. '
  + 'Emit a real MCP call instead:\n'
  + '  MCP: <url> | <tool> | {"arg": "value"}\n'
  + 'or list tools with:\n'
  + '  MCP: <url>';

/** Skill names / MCP: lines the model listed, then a RUN: tried to shell. */
function looksLikeMcpAsBash(command) {
  const text = String(command || '');
  if (/^[ \t>*-]*MCP:/m.test(text)) return true;
  return /^(?:[ \t>*-]*)(?:get_skill|publish-update|proofnetwork[-_][A-Za-z0-9._-]*)\b/im.test(text);
}

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
  const dsmlCmd = dsmlRunCommand(reply);
  if (dsmlCmd !== undefined) return dsmlCmd && !looksLikeMcpAsBash(dsmlCmd) ? dsmlCmd : null;

  // SEVERAL "RUN:" LINES IN ONE REPLY RUN BACK TO BACK.
  //
  // This capture is `[\s\S]+` on purpose — a command can legitimately span
  // lines (heredocs, trailing backslashes, fenced blocks). But it is GREEDY,
  // so when a model emitted three RUN: lines the FIRST match swallowed the
  // other two and handed bash:
  //     cd .oz-parts && cat ... > ../full.zip
  //     RUN: cd .oz-parts && ls -lh full.zip
  //     RUN: cd .oz-parts && unzip -q full.zip
  // which is exactly the MEASURED failure:
  //     /bin/bash: line 3: RUN:: command not found   (lines 3, 5, 7 — exit 127)
  // The first command ran, the rest died as literal text, and the model then
  // concluded the RUN: prefix itself was the problem and started emitting bare
  // commands — which do nothing at all. One greedy quantifier, and the agent
  // reasons its way out of using the only tool it has.
  //
  // Split on the RUN: lines and join with newlines: sequential, one shell, in
  // order. NOT `&&` — that stops the batch at the first non-zero exit, and a
  // model batching three steps means "do these three", not "abort quietly if
  // the first one greps nothing".
  const heads = [...reply.matchAll(/^[ \t>*-]*RUN:[ \t]*/gm)];
  if (!heads.length) return null;
  const cmds = [];
  for (let i = 0; i < heads.length; i++) {
    const from = heads[i].index + heads[i][0].length;
    const to = i + 1 < heads.length ? heads[i + 1].index : reply.length;
    let cmd = reply.slice(from, to);
    const fenced = /^```[\w-]*\n([\s\S]*?)```/.exec(cmd.trim());
    if (fenced) cmd = fenced[1];
    else cmd = cmd.replace(/\n```[\s\S]*$/, ''); // trailing fence + any posttext
    cmd = sliceToNextDirective(cmd);
    cmd = sanitizeRunCommand(cmd);
    // A RUN: that swallowed MCP: / get_skill / proofnetwork-* is the
    // over-match that produced `/bin/bash: line 3: RUN:: command not found`
    // and then `/bin/bash: get_skill: command not found`. Refuse the batch
    // rather than join skill names into one script.
    if (cmd && looksLikeMcpAsBash(cmd)) return null;
    if (cmd) cmds.push(cmd);
  }
  return cmds.length ? cmds.join('\n') : null;
}

function dsmlRunCommand(reply) {
  const SEP = '[|｜\\s]*';
  const NAME = '(?:command|cmd|shell_command|script)';
  const dsml = new RegExp(`<${SEP}DSML[^>]*\\bparameter\\b[^>]*\\bname="${NAME}"[^>]*>([\\s\\S]*?)<\\/${SEP}DSML`, 'i').exec(reply);
  if (!dsml) return undefined;
  return sanitizeRunCommand(dsml[1]);
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
  if (looksLikeProxyShell(command)) return Promise.resolve(PROXY_SHELL_REFUSE);
  const guarded = guardFindCwd(command, cwd);
  return new Promise((resolve) => {
    exec(guarded, { cwd, shell: RUN_SHELL, timeout: RUN_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      let out = (stdout || '') + (stderr ? '\n' + stderr : '');
      if (err) out += `\n(exit ${err.code ?? 1})`;
      resolve(keepWhole(out).trim() || '(no output)');
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
  { name: '/tier', args: 'cheap|medium|expensive|grok 4.6', help: 'how much to spend per turn when no model is pinned' },
  { name: '/race', args: '<n> | <k> <n>', help: 'launch n models; judge the first k back (k=1 = fastest wins)' },
  { name: '/sitrep', args: '', help: 'session sitrep (drawer)' },
  { name: '/compact', args: '', help: 'summarise history to shrink context' },
  { name: '/clear', args: '', help: 'wipe this thread’s history' },
  { name: '/undo', args: '', help: 'drop the last exchange' },
  { name: '/memory', args: '[text|clear]', help: 'facts injected into every turn' },
  { name: '/sessions', args: '', help: 'list all threads' },
  { name: '/all', args: '<message>', help: 'send a message to every bot in this project' },
  { name: '/ping', args: '', help: 'wake idle bots below you to take a turn now' },
  { name: '/cron', args: '<mins> | <message>', help: 'repeat a message on a timer' },
  { name: '/crons', args: '', help: 'list timers  (/cron del <id> removes one)' },
  { name: '/dir', args: '<path>', help: 'set this thread’s working directory' },
  { name: '/mode', args: 'auto|ask', help: 'Auto = Claude Code via OpenZoo; ask = chat + approve RUN' },
];

const usd = (n) => (n >= 0.01 || n === 0 ? '$' + n.toFixed(2) : '$' + n.toFixed(5));

/**
 * HUD / sitrep / /cost: prefer spilled-call x when anything bound.
 * Never an unlabeled Nx — "2.10x spilled" vs "2.10x session".
 * Rounding: 100+ integer, 10+ 1dp, else 2dp.
 */
function formatSavingLabel(you) {
  const spent = Number(you && you.spentUsd) || 0;
  if (spent <= 0) return { text: '—', mult: null, spilled: false };
  const spillX = Number(you && you.spilled && you.spilled.savingX);
  const sessionX = (Number(you && you.directUsd) || 0) / spent;
  const spilled = Number.isFinite(spillX) && spillX > 0;
  const mult = spilled ? spillX : sessionX;
  if (!Number.isFinite(mult)) return { text: '—', mult: null, spilled: false };
  const num = (mult >= 100 ? String(Math.round(mult)) : Number(mult).toFixed(mult >= 10 ? 1 : 2)) + 'x';
  return { text: num + (spilled ? ' spilled' : ' session'), mult, spilled };
}

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
  // The wording matters. Retrieval is AUTOMATIC — sidecar spill binds the
  // transcript the same way Claude CLI does (maybeCacheCorpus), and leCore
  // injects whatever slice is relevant to what you say next. Telling the
  // model to "ask for it" invites
  // it to invent a RECALL directive that does not exist, which is the exact
  // failure mode this whole harness keeps hitting: a model fabricating a
  // mechanism instead of using the real one.
  return `${label}\n${head}\n\n…[${s.length - head.length - tail.length} chars elided from THIS message — the full output is bound to this thread's holographic memory. It is not lost: mention what you need in your next message and the relevant part is retrieved automatically. Do not invent a command to fetch it.]…\n\n${tail}`;
}

// Files the grokui agent READ/WRITE/EDIT/MULTIEDIT/NOTEBOOK'd (and RUN
// cat/head/type) must land in the HRR corpus as path-prefixed file parts —
// not as unlabeled chat text via bindThread, and not as the ~3k condense()
// stub the next completion sends. Sidecar maybeCacheCorpus only sees that
// stub; bindThread never labels them as files. filesForCorpus (spill.js)
// already dedups path:mtime and caps at KEEP_MAX (400KB). We reuse it.
const boundFiles = new Set();

function pathToReadMsgs(paths) {
  return (Array.isArray(paths) ? paths : [paths]).filter(Boolean).map((file_path) => ({
    role: 'assistant',
    tool_calls: [{
      function: { name: 'Read', arguments: JSON.stringify({ file_path }) },
    }],
  }));
}

function commandToBashMsgs(command) {
  return [{
    role: 'assistant',
    tool_calls: [{
      function: { name: 'Bash', arguments: JSON.stringify({ command }) },
    }],
  }];
}

/**
 * Collect grokui file reads/writes for the HRR corpus.
 *
 * Accepts an absolute/relative path, a list of paths, or already-shaped
 * chat messages (OpenAI tool_calls / Anthropic tool_use). Dedup and the
 * 400KB cap live in spill.js — this is the grokui entry point so READ
 * records the same way Claude Code Read does.
 */
function filesForCorpus(target, opts = {}) {
  const keys = opts.boundFiles || boundFiles;
  const cwd = opts.cwd || process.cwd();
  const cap = opts.cap ?? KEEP_MAX;
  let msgs = target;
  if (typeof target === 'string') msgs = pathToReadMsgs(target);
  else if (Array.isArray(target) && (target.length === 0 || typeof target[0] === 'string')) {
    msgs = pathToReadMsgs(target);
  }
  return collectFilesForCorpus(msgs, { ...opts, boundFiles: keys, cwd, cap });
}

function filesForCorpusKeys() {
  return boundFiles;
}

function resetFilesForCorpus() {
  boundFiles.clear();
}

function inFlightChars(t) {
  if (!t) return 0;
  if (Array.isArray(t.messages)) {
    let n = 0;
    for (const m of t.messages) {
      const c = m?.content;
      if (typeof c === 'string') n += c.length;
      else if (c != null) n += JSON.stringify(c).length;
    }
    return n;
  }
  let n = 0;
  for (const h of t.history || []) n += String(h?.text || '').length;
  return n;
}

/**
 * POST file bytes to ${PROXY}/hrr/bind, appending to the project context.
 * Always fire-and-forget so a READ does not wait on the bind round-trip.
 * When the in-flight corpus/messages are below BIND_MIN_CHARS the bind
 * still happens — reuse only "wins" on a big body, but the file must be
 * recallable next turn. Completions keep omitting x-hrr-context.
 */
function scheduleFilesForCorpus(t, collected, opts = {}) {
  if (!collected?.pending?.length) return null;
  const brain = t ? holobrainOf(t) : null;
  const ctx = opts.contextId || brain?.contextId || t?.contextId || null;
  const chars = opts.sentChars ?? inFlightChars(t);
  const background = chars < BIND_MIN_CHARS;
  const fetchImpl = opts.fetchImpl || fetch;
  const run = () => {
    let read;
    try { read = readFilesForCorpus(collected, { boundFiles: opts.boundFiles || boundFiles, cap: opts.cap ?? KEEP_MAX }); }
    catch { return Promise.resolve(null); }
    if (!read?.text) return Promise.resolve(null);
    const payload = ctx ? { corpus: read.text, context_id: ctx } : { corpus: read.text };
    return fetchImpl(`${PROXY}/hrr/bind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (j?.context_id && t) {
        const live = holobrainOf(t) || t;
        live.contextId = j.context_id;
        t.contextId = j.context_id;
        if (Number(j.bound)) live.boundItems = (live.boundItems || 0) + Number(j.bound);
      }
      return j;
    }).catch(() => null);
  };
  const job = { pending: collected.pending, background, append: Boolean(ctx), run };
  const kick = () => { job.promise = run(); };
  if (opts.defer === false) kick();
  else setImmediate(kick);
  return job;
}

function noteFileForCorpus(originId, relOrAbs, extra = {}) {
  const t = extra.thread || (originId ? threads.get(originId) : null);
  const cwd = extra.cwd || (originId ? dirFor(originId) : process.cwd());
  let abs = relOrAbs;
  if (typeof abs === 'string' && !path.isAbsolute(abs)) {
    try { abs = originId ? safeResolveIn(cwd, abs) : path.resolve(cwd, abs); }
    catch { abs = path.resolve(cwd, abs); }
  }
  const collected = filesForCorpus(abs, {
    cwd,
    boundFiles: extra.boundFiles || boundFiles,
    cap: extra.cap ?? KEEP_MAX,
    ...(extra.collectOpts || {}),
  });
  return scheduleFilesForCorpus(t, collected, extra);
}

function noteRunForCorpus(originId, command, extra = {}) {
  if (!looksLikeFileView(command)) return null;
  const t = extra.thread || (originId ? threads.get(originId) : null);
  const cwd = extra.cwd || (originId ? dirFor(originId) : process.cwd());
  const collected = filesForCorpus(commandToBashMsgs(command), {
    cwd,
    boundFiles: extra.boundFiles || boundFiles,
    cap: extra.cap ?? KEEP_MAX,
  });
  if (!collected.pending.length) {
    const { paths } = extractBashPaths(command, cwd);
    const abs = paths.map((p) => {
      const raw = p?.raw;
      if (!raw) return null;
      if (path.isAbsolute(raw)) return raw;
      try { return originId ? safeResolveIn(p.cwd || cwd, raw) : path.resolve(p.cwd || cwd, raw); }
      catch { return path.resolve(p.cwd || cwd, raw); }
    }).filter(Boolean);
    if (!abs.length) return null;
    return noteFileForCorpus(originId, abs, extra);
  }
  return scheduleFilesForCorpus(t, collected, extra);
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

async function attachSpilled(you) {
  if (!you || you.spilled != null) return you;
  try {
    const info = await (await fetch(`${PROXY}/info`, { signal: AbortSignal.timeout(2000) })).json();
    if (info && info.spilled) you.spilled = info.spilled;
  } catch { /* session label stays honest if info is down */ }
  return you;
}

async function sessionStats() {
  try {
    const s = await (await fetch(`${PROXY}/session`, { signal: AbortSignal.timeout(2000) })).json();
    return attachSpilled(s);
  } catch { return null; }
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

  if (cmd === 'sitrep') return null; // drawer-only — never a transcript line
  if (cmd === 'help') {
    return 'Commands:\n'
      + SLASH_COMMANDS.map((c) => `  ${(c.name + ' ' + c.args).padEnd(26)} ${c.help}`).join('\n')
      + '\n\nDirectives bots can emit:\n'
      + '  RUN / WRITE / EDIT / READ / LS / GLOB / GREP / SERVE / FETCH / MCP / TODO / SPAWN / SEND / PING / PEEK\n'
      + '  (/tools for the full signatures)';
  }
  if (cmd === 'tools') {
    return 'Directives:\n'
      + '  RUN: <cmd>                          real shell, in this thread’s dir (never find /)\n'
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
      + '  PING: <name>                        wake that bot (* wakes the project)\n'
      + '  PEEK: <name>                        read-only look at another bot\n\n'
      + 'READ, LS, GLOB, GREP, FETCH, PEEK and MCP run CONCURRENTLY when several\n'
      + 'appear in one reply — four files cost one round trip, not four.';
  }
  // Header Pay / ◎ echo through the same /drive → history.push path as
  // /mode and /tier. Short lines only — never wallet JSON or a sitrep dump.
  if (cmd === 'pay') {
    return 'Pay — card checkout or the local wallet/x402 burner. Drawer opened.';
  }
  if (cmd === 'hud') {
    const s = await sessionStats();
    const mode = t.runMode || 'ask';
    const tier = t.tier || 'auto';
    if (!s) return `Sitrep — mode ${mode} · ${tier} · proxy unreachable.`;
    const spent = Number(s.spentUsd) || 0;
    const sav = formatSavingLabel(s);
    return `Sitrep — mode ${mode} · ${tier} · paid ${usd(spent)} · ${sav.text} · ${s.paidCalls || 0} calls`;
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
      const sav = formatSavingLabel(s);
      lines.push(`  multiple        ${sav.text}`
        + (sav.mult != null && sav.mult < 1 ? '  — under 1x: small inputs cost MORE than sending them directly' : ''));
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
      const cur = t.tier || 'auto';
      if (cur === 'auto') {
        return `This thread: auto  (classifier — openzoo/auto)\n`
          + `Tiers: auto · ${TIER_NAMES.join(' · ')}\n`
          + (t.model ? `NOTE: /model ${t.model} is pinned on this thread, so Auto is ignored until you /model default.\n` : '')
          + 'Switch with  /tier <name>   ·  /race <n> to ask several at once.';
      }
      const picks = await tierModels(cur, 3);
      return `This thread: ${cur}\n`
        + `Tiers: auto · ${TIER_NAMES.join(' · ')}\n`
        + `Top of ${cur} right now: ${picks.join(', ')}\n`
        + (t.model ? `NOTE: /model ${t.model} is pinned on this thread, so the tier is ignored until you /model default.\n` : '')
        + 'Switch with  /tier <name>   ·  /race <n> to ask several at once.';
    }
    const want = normalizeTier(arg);
    if (!want) return `Unknown tier "${arg}". One of: auto, ${TIER_NAMES.join(', ')} (also: grok 4.6).`;
    t.tier = want; saveThreads();
    if (want === 'auto') {
      return 'This thread now uses Auto — cheapest model that clears the bar (openzoo/auto).'
        + (t.model ? `\nBut /model ${t.model} is still pinned and wins. Run /model default to let Auto take over.` : '');
    }
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
    if (!arg) {
      return 'Usage:  /all <message>   — sends it to everyone BELOW you: your subagents, '
        + 'their subagents, all the way down.\n'
        + 'It is scoped to your own branch, not the whole project — run it from the top '
        + 'thread to reach everybody.';
    }
    const crew = subtreeOf(t.id);
    if (!crew.length) return 'You have no subagents to send to.';
    for (const x of crew) kickTurn(x.id, arg).catch(() => {});
    if (t.runMode === 'auto' && pingCanWake(t)) wakeOnPing(t, arg);
    return `Sent down your branch to ${crew.length} bot(s): ${crew.map((x) => x.name).join(', ')}`;
  }

  // Wake the room. Used to be a free last-line dump — idle children stayed
  // idle, and a parent reading "kid: <old reply>" thought they had acted.
  // Empty extra is a continue wake (Claude Code on Auto), not a cancel. Thinking stays
  // thinking; pendingRun stays on the human. Same branch scope as /all.
  if (cmd === 'ping') {
    const crew = subtreeOf(t.id, true);
    if (crew.length < 2) return 'You have no subagents yet.';
    return crew.map((x) => {
      const mark = x.id === t.id ? ' (here)' : '';
      if (x.id === t.id) {
        if (t.runMode === 'auto' && pingCanWake(t)) {
          wakeOnPing(t, arg);
          return `  ${x.name}${mark}: pinged, working`;
        }
        const last = x.history[x.history.length - 1];
        return x.pendingRun ? `  ${x.name}${mark}: BLOCKED — waiting for your approval`
          : x.status === 'thinking' ? `  ${x.name}${mark}: working`
          : last ? `  ${x.name}${mark}: ${String(last.text).replace(/\s+/g, ' ').slice(0, 90)}`
          : `  ${x.name}${mark}: nothing yet`;
      }
      if (x.pendingRun) return `  ${x.name}${mark}: BLOCKED — waiting for your approval`;
      if (x.status === 'thinking') return `  ${x.name}${mark}: working`;
      wakeOnPing(x, arg);
      return `  ${x.name}${mark}: pinged, working`;
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
      kickTurn(t.id, c.text).catch(() => {});
    }
  }
}, 15000).unref();

// A turn that is thinking with no deltas/status for too long is dead — the
// stream reader used to hang forever and block the next user prompt behind
// mute dots. Bump turnSeq so the in-flight runTurn bails, then idle.
setInterval(() => {
  const now = Date.now();
  let dirty = false;
  for (const t of threads.values()) {
    if (t.status !== 'thinking') continue;
    const last = t.lastDeltaAt || t.thinkingAt || 0;
    if (!last || now - last < STALE_THINKING_MS) continue;
    t.turnSeq = (t.turnSeq || 0) + 1;
    try { turnAborts.get(t)?.abort(); } catch { /* none */ }
    const lastBot = [...(t.history || [])].reverse().find((h) => h.who === 'bot');
    const lastText = lastBot?.text || '';
    if (shouldKeepAuto(t, lastText)) {
      kickTurn(t.id, autoHopText(lastText)).catch(() => {});
    } else {
      t.status = 'idle';
      t.liveStatus = '';
      t.liveRace = null;
      unlockWorktree(t);
    }
    dirty = true;
  }
  if (dirty) saveThreads();
}, 5000).unref();

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
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', '.openzoo']);
function walkDir(base, rel = '', out = [], depth = 0) {
  if (depth > 12 || out.length > 5000) return out;
  let entries = [];
  try {
    const dir = rel && path.isAbsolute(rel) ? inDir(base, rel) : path.join(base, rel);
    entries = readdirSync(dir, { withFileTypes: true });
  } catch { return out; }
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

/**
 * Translate a FOREIGN tool-call envelope into our directive lines.
 *
 * Models carry other harnesses' call syntax out of training and emit it here
 * even when the system prompt spells ours out. MEASURED live on a fresh box:
 *
 *   [TOOL_CALL]
 *   {tool => "LS", args => {
 *     --path ""
 *   }}
 *   [/TOOL_CALL]
 *
 * Nothing matched, so it rendered as chat text, nothing ran, and the user had
 * to type "continue?" — three prompts to get one spawn. This is the same class
 * of bug as the DSML envelope in parseRun and the old /^RUN:/ anchor: a
 * silently discarded directive reads to the model as a tool that does nothing,
 * and it narrates work it never did rather than reporting a failure.
 *
 * Translating beats correcting: a correction costs another paid turn, this
 * costs nothing and the model never learns it was wrong — which is fine,
 * because being right about the envelope was never the job.
 */
function translateForeignToolCall(reply) {
  const src = String(reply);
  // THREE envelope dialects seen in production, all from models carrying some
  // other harness's format out of training:
  //   [TOOL_CALL]{tool => "LS", args => { --path "" }}[/TOOL_CALL]
  //   <tool_call>RUN<arg_key>command</arg_key><arg_value>ls -la</arg_value></tool_call>
  //   <DSML|invoke name="RUN">…   (handled separately, inside parseRun)
  // Each one shipped as chat text and did nothing until it was taught here, so
  // the shape of the fix is: normalise ANY of them into {tool, args} and share
  // one mapping. A fourth dialect should be a few lines, not another outage.
  const out = [];
  // DELIMITERS DO NOT HAVE TO MATCH. Models MIX the dialects — measured live:
  //     [TOOL_CALL]
  //     RUN
  //     <arg_key>command</arg_key><arg_value>pwd; ls -la</arg_value>
  //     </tool_call>
  // opens with the bracket form and closes with the XML one. Matching PAIRS
  // ([TOOL_CALL]…[/TOOL_CALL] or <tool_call>…</tool_call>) misses that
  // entirely, so it rendered as chat text and nothing ran. Scan from ANY
  // opener to the NEXT closer of EITHER kind.
  const blocks = [...src.matchAll(
    /(?:\[TOOL_CALL\]|<tool_call>)([\s\S]*?)(?:\[\/TOOL_CALL\]|<\/tool_call>|$)/gi,
  )].map((m) => ({ body: m[1] }));

  // DEEPSEEK'S NATIVE SPECIAL-TOKEN FORM — a fifth dialect, and the costliest.
  //     <|tool_call_begin|>functions.WRITE:0<|tool_call_argument_begin|>
  //     {"path": "/workspace/x/anti-cheat.js", "content": "…"}
  //     <|tool_call_end|>
  // MEASURED: a complete anti-cheat implementation, several hundred lines,
  // rendered as chat text and written nowhere. The name carries a
  // "functions." prefix and a ":0" call index; the argument is plain JSON, so
  // this one maps straight onto our directives once the wrapper is peeled.
  const dsBlocks = [...src.matchAll(
    /<\|tool_call_begin\|>([\s\S]*?)<\|tool_call_argument_begin\|>([\s\S]*?)(?:<\|tool_call_end\|>|$)/g,
  )];
  for (const m of dsBlocks) {
    const rawName = m[1].trim().replace(/^functions?\./i, '').replace(/[:.]\d+$/, '');
    let a = {};
    try { a = JSON.parse(m[2].trim()); } catch { continue; }
    const t = rawName.toUpperCase();
    const pick = (...ks) => ks.map((k) => a[k]).find((v) => v !== undefined && v !== '');
    if (t === 'WRITE' || t === 'WRITE_FILE') out.push('WRITE: ' + (pick('path', 'file') || '') + ' | ' + (pick('content', 'text', 'body') || ''));
    else if (t === 'RUN' || t === 'BASH' || t === 'SHELL' || t === 'EXEC') out.push('RUN: ' + (pick('command', 'cmd', 'script') || ''));
    else if (t === 'READ' || t === 'READ_FILE' || t === 'CAT') out.push('READ: ' + (pick('path', 'file') || ''));
    else if (t === 'LS' || t === 'LIST') out.push('LS: ' + (pick('path', 'dir') || ''));
    else if (t === 'GLOB' || t === 'FIND') out.push('GLOB: ' + (pick('pattern', 'glob', 'query') || '*'));
    else if (t === 'FETCH') out.push('FETCH: ' + (pick('url', 'uri') || ''));
    else if (t === 'SPAWN') out.push('SPAWN: ' + (pick('name', 'agent') || 'helper') + ' | ' + (pick('task', 'prompt', 'goal') || ''));
    else if (t === 'SEND') out.push('SEND: ' + (pick('name', 'agent', 'to') || '') + ' | ' + (pick('message', 'msg', 'task') || ''));
    else if (t === 'MCP') {
      const tool2 = pick('tool', 'name', 'method') || '';
      const argj = pick('arg', 'args', 'arguments', 'params');
      out.push('MCP: ' + (pick('url', 'server') || '')
        + (tool2 ? ' | ' + tool2 + (argj !== undefined ? ' | ' + (typeof argj === 'string' ? argj : JSON.stringify(argj)) : '') : ''));
    }
  }
  for (const b of blocks) {
    const body = b.body;
    // The name is either quoted ({tool => "LS"}) or bare on its own first line
    // (<tool_call>RUN). Which delimiter opened the block tells us nothing once
    // models mix them, so try both spellings every time.
    const tool = (/tool\s*(?:=>|:)\s*"([^"]+)"/i.exec(body) || [])[1]
      || (/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/m.exec(body) || [])[1];
    if (!tool) continue;
    // Arguments come in three spellings across harnesses: --flag "v",
    // "key" => "v", and key: "v". Accept all of them rather than betting on one.
    const args = {};
    for (const m of body.matchAll(/--([a-z_]+)\s+"([^"]*)"/gi)) args[m[1].toLowerCase()] = m[2];
    for (const m of body.matchAll(/"?([a-z_]+)"?\s*(?:=>|:)\s*"([^"]*)"/gi)) {
      if (m[1].toLowerCase() !== 'tool') args[m[1].toLowerCase()] = m[2];
    }
    // <arg_key>name</arg_key><arg_value>value</arg_value>, repeated. Values are
    // NOT quoted in this dialect and may contain anything, so the value regex
    // has to be lazy to its own closing tag rather than stop at a quote.
    for (const m of body.matchAll(/<arg_key>\s*([^<]+?)\s*<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi)) {
      args[m[1].toLowerCase()] = m[2];
    }
    const a = (...names) => names.map((n) => args[n]).find((v) => v !== undefined && v !== '');
    const t = tool.toUpperCase();
    if (t === 'LS' || t === 'LIST') out.push('GLOB: ' + ((a('path', 'dir', 'directory') || '.').replace(/\/$/, '') + '/*'));
    else if (t === 'GLOB' || t === 'FIND' || t === 'SEARCH_FILES') out.push('GLOB: ' + (a('pattern', 'glob', 'query') || '*'));
    else if (t === 'READ' || t === 'READ_FILE' || t === 'CAT') out.push('READ: ' + (a('path', 'file', 'filename') || ''));
    else if (t === 'WRITE' || t === 'WRITE_FILE') out.push('WRITE: ' + (a('path', 'file') || '') + ' | ' + (a('content', 'text', 'body') || ''));
    else if (t === 'FETCH' || t === 'HTTP' || t === 'BROWSE') out.push('FETCH: ' + (a('url', 'uri') || ''));
    else if (t === 'RUN' || t === 'BASH' || t === 'SHELL' || t === 'EXEC') out.push('RUN: ' + (a('command', 'cmd', 'script') || ''));
    else if (t === 'SPAWN') out.push('SPAWN: ' + (a('name', 'agent') || 'helper') + ' | ' + (a('task', 'prompt', 'goal') || ''));
    else if (t === 'MCP') {
      // MCP takes url [| tool | {json}] — rebuild whichever form was meant.
      const url = a('url', 'server', 'endpoint') || '';
      const tool2 = a('tool', 'name', 'method') || '';
      const argj = a('arg', 'args', 'arguments', 'params') || '';
      out.push('MCP: ' + url + (tool2 ? ' | ' + tool2 + (argj ? ' | ' + argj : '') : ''));
    }
    else if (t === 'SEND') out.push('SEND: ' + (a('name', 'agent', 'to') || '') + ' | ' + (a('message', 'msg', 'task') || ''));
    else if (t === 'PING') out.push('PING: ' + (a('name', 'agent') || ''));
    else if (t === 'SERVE') out.push('SERVE: ' + (a('path', 'file') || ''));
    else if (t === 'GREP') out.push('GREP: ' + (a('pattern', 'query', 'text') || ''));
  }
  // Only claim a translation when a directive actually came out of it — an
  // unrecognised tool must fall through to the no-directive nudge, not vanish
  // into an empty string that looks like a successful parse.
  if (!blocks.length && !out.length) return null;
  const text = out.filter((l) => !/(:|\|)\s*$/.test(l)).join('\n');
  return text || null;
}

/**
 * Cut a directive's argument at the START OF THE NEXT DIRECTIVE.
 *
 * Directive bodies are captured with a greedy [\s\S]+ so a task or a command
 * may span lines. Greedy means the FIRST directive in a reply swallows every
 * one after it — measured on RUN (three commands became one broken script) and
 * again on SPAWN, where an orchestrator emitting five SPAWN lines would have
 * created one agent whose "task" was the other four.
 */
function sliceToNextDirective(text) {
  const m = /\n[ \t>*-]*(?:RUN|SPAWN|SEND|PING|PEEK|READ|WRITE|EDIT|GLOB|LS|LIST|DIR|FIND|GREP|SERVE|FETCH|MCP|DONE|TODO):/.exec(text);
  let out = m ? text.slice(0, m.index) : text;
  // Models fence their directive lists, so the LAST one in a block otherwise
  // ends up owning the closing ``` and every word of prose after it — a
  // subagent whose task was "Design anti-cheat ``` These subagents will work
  // independently." Cut at the closing fence, same as parseRun does.
  out = out.replace(/\n[ \t]*```[\s\S]*$/, '');
  return out.trim();
}

/** Every head of one directive in a reply, in order, each with its argument
 *  already cut at the next head. Tolerates preamble, list markers and quotes —
 *  models put "1. " and "> " in front of directives constantly. */
function directiveLines(reply, keyword) {
  const heads = [...String(reply).matchAll(new RegExp('^[ \\t>*-]*(?:\\d+[.)]\\s*)?' + keyword + ':[ \\t]*', 'gm'))];
  return heads.map((h, i) => {
    const from = h.index + h[0].length;
    const to = i + 1 < heads.length ? heads[i + 1].index : reply.length;
    return sliceToNextDirective(reply.slice(from, to));
  }).filter(Boolean);
}

/**
 * Undo the two things models do to a directive line that make it unrecognisable.
 *
 * MEASURED live, repeatedly:  <LS: <blank>>
 *
 * Both halves come from our own prompt. It documented the argument as
 * "<path, or blank for the root>", so the model copied the angle brackets AND
 * the word blank, producing a placeholder where a path goes and wrapping the
 * whole line for good measure. The prompt no longer teaches that, but models
 * carry <ARG> notation out of training regardless, and a directive we refuse
 * over its punctuation costs a paid turn every time.
 *
 * Only the directive HEAD is touched — never a body. WRITE content legitimately
 * contains angle brackets (it is usually HTML), and rewriting that would corrupt
 * files to fix a cosmetic problem.
 */
function unwrapDirectiveLine(reply) {
  const KW = 'RUN|SPAWN|SEND|PING|PEEK|READ|WRITE|EDIT|MULTIEDIT|NOTEBOOK|GLOB|LS|LIST|DIR|FIND|GREP|SERVE|FETCH|MCP|DONE|TODO';
  return String(reply).split('\n').map((line) => {
    // <LS: ...>  ->  LS: ...     (a whole directive wrapped in angle brackets)
    let out = line.replace(new RegExp('^([ \\t>*-]*)<\\s*((?:' + KW + '):[\\s\\S]*?)\\s*>\\s*$'), '$1$2');
    // LS: <blank>  ->  LS:       (a placeholder standing in for "no argument")
    out = out.replace(new RegExp('^([ \\t>*-]*(?:' + KW + '):)[ \\t]*<(?:blank|empty|none|nothing|path|dir|directory|optional)>[ \\t]*$', 'i'), '$1');
    return out;
  }).join('\n');
}

/**
 * The brief a subagent is missing.
 *
 * A SPAWN task is the ORCHESTRATOR'S PARAPHRASE, and it is the whole world the
 * child ever sees. MEASURED: the user told the orchestrator "remember always:
 * proofnetwork can do it all, from rng to rpc/wallet management", and the
 * orchestrator emitted
 *     SPAWN: meta_game_dev | Develop a meta-game where non-player users can wager
 * with ProofNetwork nowhere in it. The child heard "smart contract for
 * wagering", and wrote TetrisMetaGame.SOL — Solidity, on a Solana project —
 * because that is what "smart contract" means in the training distribution
 * when nothing says otherwise. The stack WAS specified. It just never reached
 * the agent doing the work.
 *
 * So a child now starts with the message that caused its own existence. Not a
 * summary of it, not the parent's whole transcript — the actual words the user
 * last wrote to the parent, which is where constraints like "this is
 * ProofNetwork" and "use token22 <mint>" always live.
 */
function isHarnessUserText(text) {
  return /^\((command output|directive result)\)/.test(String(text || ''))
    || String(text || '') === NUDGE
    || String(text || '') === AUTO_CONTINUE
    || String(text || '') === AUTO_RACE_RETRY
    || String(text || '') === AUTO_EMPTY_RETRY
    || String(text || '').startsWith('AUTO_EMPTY_RETRY:');
}

function firstUserAsk(t) {
  return (t?.history || []).find((m) => m.who === 'user' && !isHarnessUserText(m.text));
}

function lastUserAsk(t) {
  return [...(t?.history || [])].reverse().find((m) => m.who === 'user' && !isHarnessUserText(m.text));
}

function siblingJob(sib) {
  const text = String(firstUserAsk(sib)?.text || '');
  const job = text.includes('--- your specific job ---')
    ? text.split('--- your specific job ---').pop().split('--- your place in the team ---')[0]
    : text;
  return job.trim().replace(/\s+/g, ' ').slice(0, 400);
}

function spawnBrief(parent, { refresh = false, child } = {}) {
  if (!parent) return '';
  const rootId = rootOf(parent).rootId;
  const root = threads.get(rootId) || parent;
  const rootAsk = String(firstUserAsk(root)?.text || '').trim();
  const latest = String(lastUserAsk(parent)?.text || '').trim();
  const recent = (parent.history || []).filter((m) => !isHarnessUserText(m.text)).slice(-8);
  const siblings = [...threads.values()].filter((x) => x.parent === parent.id);
  const cwd = child?.dir || WORKSPACE_DIR;
  const branch = child?.worktree?.branch;
  const mode = parent.runMode || 'ask';
  const tier = parent.tier || 'auto';
  const race = Number(parent.race) || 0;
  const raceNeed = Number(parent.raceNeed) || 1;
  const model = parent.model || '';
  const lines = [
    refresh
      ? 'CONTEXT REFRESH — you already exist; this is the current brief. Constraints (stack, token, MCP URL, what NOT to do) outrank your training prior.'
      : 'CONTEXT — this is what was asked of the team you were just spawned into. Constraints in here (the stack, addresses, what NOT to do) apply to you, and outrank any assumption you would otherwise make from your own training.',
  ];
  // The root ask is kept WHOLE. A 4000-char slice ate "proofnetwork can do it
  // all" / token / MCP URL and the child invented a stack from training prior.
  if (rootAsk) {
    lines.push('', 'ROOT ASK — the original user request for this project (not a paraphrase):', rootAsk);
  }
  if (latest && latest !== rootAsk) {
    lines.push('', 'LATEST from the parent thread:', latest);
  }
  if (recent.length) {
    lines.push('', 'RECENT PARENT TURNS (what the orchestrator already decided):');
    for (const m of recent) {
      const who = m.who === 'user' ? 'user' : (m.name || parent.name);
      lines.push('[' + who + '] ' + String(m.text || '').trim().slice(0, 1200));
    }
  }
  lines.push('', 'WORKING SET:');
  lines.push('cwd: ' + cwd);
  if (branch) lines.push('branch: ' + branch);
  lines.push('run mode: ' + mode);
  lines.push('tier: ' + tier
    + (race >= 2 ? ' · race ' + (raceNeed > 1 ? raceNeed + ' of ' + race : race) : '')
    + (model ? ' · pinned model: ' + model : ''));
  if (siblings.length) {
    lines.push('', 'CREW — the split already happened. Do not re-split work they own:');
    for (const s of siblings) {
      const job = siblingJob(s);
      lines.push('- ' + s.name + ': ' + (job || '(no task recorded yet)'));
    }
  }
  lines.push('', '--- your specific job ---', '');
  return lines.join('\n');
}

function childKickoff(parent, childName, task, { fresh = true } = {}) {
  const child = findByName(childName);
  return spawnBrief(parent, { refresh: !fresh, child }) + task + spawnPosition(parent, childName);
}

/**
 * WHERE YOU SIT IN THE TREE — the thing that stops pointless re-fanning.
 *
 * There is deliberately NO depth cap on SPAWN. A cap is the wrong tool: real
 * work is n-tiered and the right depth is whatever the job is. What actually
 * went wrong is that a child had no idea the split had ALREADY HAPPENED —
 * MEASURED, tetris-engine-builder was handed "build the Tetris game", could
 * not see that four siblings already owned the other quarters, and spawned
 * agent-1..agent-4 to re-split its own slice. Sixteen threads, generic names,
 * nobody building anything.
 *
 * So tell it: who you are, how many of you there are, what each sibling holds,
 * and how deep you already are. An agent that can see the decomposition does
 * the work instead of re-performing the decomposition.
 */
function spawnPosition(parent, childName) {
  if (!parent) return '';
  const depth = rootOf(parent).depth + 1;
  const others = [...threads.values()].filter((x) => x.parent === parent.id && x.name !== childName);
  const me = findByName(childName);
  return '\n\n--- your place in the team ---\n'
    + `You are "${childName}", spawned by "${parent.name}". You are at tier ${depth} of this project.\n`
    + (others.length
      ? `The work was ALREADY SPLIT before you existed. Your siblings under ${parent.name} are:\n`
        + others.map((s) => `- ${s.name}: ${siblingJob(s) || '(no task recorded yet)'}`).join('\n')
        + '\nThey hold the other slices. Yours is yours to BUILD.\n'
      : '')
    + 'Do NOT re-split your own slice into more agents just because it has several parts — '
    + 'that is how a team becomes sixteen bots and zero artifacts. SPAWN only if your slice '
    + 'contains genuinely independent work that NO existing sibling covers, and name any agent '
    + 'you do spawn after what it owns, never "agent-1".\n'
    + (me?.dir
      ? `Your working directory is ${me.dir}`
        + (me.worktree?.branch ? ` on ${me.worktree.branch}` : '')
        + ' — isolated from the parent checkout. Write here, not in the parent tree.\n'
      : '')
    + 'Everything else — build it yourself, now.\n';
}

/**
 * "AGENT-NAME: do the thing"  ->  "SEND: AGENT-NAME | do the thing"
 *
 * Gated on the name resolving to a real thread, so prose like "Note:" or
 * "Warning:" cannot be mistaken for an address. Names are compared with
 * separators and case stripped, because a model writes INSTALL-ANALYZE-MCP for
 * a thread called install-analyze-mcp and means the same bot.
 */
function nameAddressedToSend(reply, originId) {
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
  const byNorm = new Map();
  for (const x of threads.values()) if (x.id !== originId) byNorm.set(norm(x.name), x.name);
  if (!byNorm.size) return reply;
  return String(reply).split('\n').map((line) => {
    const m = /^([ \t>*-]*)([A-Za-z][A-Za-z0-9 _-]{1,48}):[ \t]+(\S[\s\S]*)$/.exec(line);
    if (!m) return line;
    const real = byNorm.get(norm(m[2]));
    // A directive keyword that happens to match a thread name stays a directive.
    if (!real || /^(RUN|SPAWN|SEND|PING|PEEK|READ|WRITE|EDIT|GLOB|LS|LIST|DIR|FIND|GREP|SERVE|FETCH|MCP|DONE|TODO)$/i.test(m[2].trim())) return line;
    return `${m[1]}SEND: ${real} | ${m[3]}`;
  }).join('\n');
}

function emitLiveStatus(originId, onEvent, detail) {
  if (!detail) return;
  const t = threads.get(originId);
  if (t) {
    t.liveStatus = detail;
    t.lastDeltaAt = Date.now();
  }
  onEvent?.({ type: 'status', name: t?.name, color: t?.color, detail });
}

async function tryDirective(reply, originId, onEvent) {
  const trail = peekDirectiveStatus(reply);
  if (trail) emitLiveStatus(originId, onEvent, trail);
  // Foreign envelope in, our directives out — before any matching runs, so
  // every branch below sees the shape it was written for.
  const translated = translateForeignToolCall(reply);
  if (translated) reply = translated;
  // Then strip angle-bracket wrapping and placeholder arguments.
  reply = unwrapDirectiveLine(reply);
  // ADDRESSING A BOT BY BARE NAME IS A SEND.
  //
  // MEASURED: an orchestrator wrote a block of
  //     INSTALL-ANALYZE-MCP: Please proceed with installing the MCP…
  //     GAME-ENGINE: Please proceed with designing the prototype…
  // one line per subagent, and the user had to ask "sorry did you forget
  // 'SEND: '". It is a perfectly clear instruction in every sense except the
  // one the parser cares about.
  //
  // Only rewritten when the prefix MATCHES AN EXISTING THREAD, case- and
  // separator-insensitive. That is what makes this safe: "Note:" or "Step 2:"
  // never matches a live agent, so ordinary prose is untouched.
  reply = nameAddressedToSend(reply, originId);
  // MCP SKILL NAMES ARE NOT SHELL. parseRun used to hand get_skill /
  // proofnetwork-* / MCP: to bash. Refuse here so the model sees the
  // real MCP: directive, including DSML-wrapped RUN bodies with no RUN: line.
  const runBodies = directiveLines(reply, 'RUN');
  const dsmlCmd = dsmlRunCommand(reply);
  if (runBodies.some(looksLikeMcpAsBash) || (dsmlCmd && looksLikeMcpAsBash(dsmlCmd))) {
    return MCP_AS_BASH_REFUSE;
  }
  // FAN OUT FIRST. Each line is re-entered on its own, so every branch below
  // stays single-directive and none of them had to learn about batching.
  const batch = [...reply.matchAll(PARALLEL_DIRECTIVE)];
  if (batch.length > 1) {
    const results = await Promise.all(
      batch.map((m) => tryDirective(m[0].replace(/^[ \t>*-]*/, ''), originId, onEvent)
        .catch((e) => `${m[1]}: ${e.message}`)),
    );
    return results.filter(Boolean).join('\n\n');
  }

  // EVERY SPAWN LINE, NOT JUST THE FIRST — AND NOT ONLY AT THE START.
  //
  // This was /^SPAWN:...([\s\S]+)/ with NO `m` flag, which is two bugs at once:
  //
  //   `^` without `m` anchors to the start of the WHOLE REPLY. An orchestrator
  //   that writes "To address your requirements, I will spawn subagents:" and
  //   then lists its directives never matched AT ALL — measured live, five
  //   SPAWN lines, five SEND lines and five PING lines across three turns, and
  //   the sidebar still held exactly one bot. Identical to the /^RUN:/ anchor
  //   bug this file already documents, never applied to SPAWN.
  //
  //   And [\s\S]+ is greedy, so even once it matched, the FIRST spawn would
  //   swallow the other four into its own task.
  //
  // Fan out over every head, cutting each task at the next directive.
  const spawnAll = directiveLines(reply, 'SPAWN');
  if (spawnAll.length > 1) {
    // CREATE THE WHOLE COHORT BEFORE ANY OF THEM STARTS THINKING.
    //
    // Re-entering tryDirective per line spawns them one at a time, and
    // spawnPosition reads the sibling set AT SPAWN TIME — so the first child
    // was told it had no siblings, the second one, the fifth four. MEASURED:
    // tetris-game, spawned second of five, was told "Your siblings under
    // openzoo are: mcp-analyzer" while three more were seconds behind it. The
    // whole point of telling a child the split already happened is defeated if
    // it cannot see most of the split.
    //
    // The full cohort is knowable up front — it is right there in the reply.
    // So: parse every line, create every thread, THEN start their turns.
    const parent = threads.get(originId);
    const parsed = spawnAll.map((line) => /^([^|]+)\|([\s\S]+)/.exec(line))
      .filter(Boolean).map((m) => ({ name: m[1].trim(), task: m[2].trim() }));
    const made = [];
    const notes = [];
    for (const { name, task } of parsed) {
      const existing = findByName(name);
      if (existing) {
        attachChildDir(existing, parent, task);
        notes.push(`${name} already exists — woke it to keep working.`);
        made.push({ t: existing, task, fresh: false });
        continue;
      }
      const siblings = [...threads.values()].filter((x) => x.parent === originId).length;
      if (siblings >= SPAWN_MAX_CHILDREN) { notes.push(`Not spawning "${name}": already at ${SPAWN_MAX_CHILDREN} subagents.`); continue; }
      made.push({ t: newThread(name, originId, undefined, task), task, fresh: true });
    }
    // Every thread now exists, so spawnPosition sees the COMPLETE cohort.
    for (const { t: sub, task, fresh } of made) {
      if (fresh) kickTurn(sub.id, childKickoff(parent, sub.name, task, { fresh })).catch(() => {});
      else wakeOnPing(sub);
    }
    const fresh = made.filter((m) => m.fresh).map((m) => m.t.name);
    return [fresh.length ? `Spawned ${fresh.length} together (they can each see the full crew): ${fresh.join(', ')}` : '', ...notes]
      .filter(Boolean).join('\n');
  }
  const spawn = spawnAll.length === 1 ? /^([^|]+)\|([\s\S]+)/.exec(spawnAll[0]) : null;
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
      // Repeat SPAWN is a wake, not a CONTEXT REFRESH. childKickoff({fresh:false})
      // restates the original job and tells the child it already exists — MEASURED,
      // the crew flipped to that preview, thought once, and sat.
      attachChildDir(existing, threads.get(originId), task);
      wakeOnPing(existing);
      return `${name} already exists — woke it to keep working.`;
    }
    // Storm guard. Fire-and-forget spawning is unbounded by construction: each
    // child can spawn, and nothing above it is counting.
    const siblings = [...threads.values()].filter((x) => x.parent === originId).length;
    if (siblings >= SPAWN_MAX_CHILDREN) {
      return `Not spawning "${name}": this thread already has ${siblings} subagents `
        + `(limit ${SPAWN_MAX_CHILDREN}). Reuse one with  SEND: <name> | <task>  — `
        + `every live subagent costs paid calls.`;
    }
    const sub = newThread(name, originId, undefined, task);
    // The child gets the ORIGINATING brief plus its own job — see spawnBrief.
    kickTurn(sub.id, childKickoff(threads.get(originId), name, task)).catch(() => {}); // fire and forget
    return `Spawned ${name} — working on it.`;
  }
  // SEND TO A NAME THAT DOES NOT EXIST YET *SPAWNS* IT.
  //
  // SPAWN already degrades to SEND when the name is taken ("already exists —
  // sent it the task instead of spawning a duplicate"). This is that rule's
  // missing half, and without it the pair was asymmetric in the direction that
  // costs money: an orchestrator planning a crew names all of them up front and
  // then SENDs, so every not-yet-spawned member returned
  //   No thread named "Solana-Betting-Metagame" to message.
  // — MEASURED live, twice in one chain. Each one is a dead turn the model then
  // has to notice, diagnose and recover from, at auto-mode prices.
  //
  // Creating it is what was meant. The message IS the task; that is exactly the
  // argument SPAWN takes, so there is nothing to invent.
  // Same two bugs as SPAWN above: no `m`, and a greedy body.
  const sendAll = directiveLines(reply, 'SEND');
  if (sendAll.length > 1) {
    const out = [];
    for (const line of sendAll) out.push(await tryDirective('SEND: ' + line, originId, onEvent));
    return out.filter(Boolean).join('\n');
  }
  const sendM = sendAll.length === 1 ? /^([^|]+)\|([\s\S]+)/.exec(sendAll[0]) : null;
  if (sendM) {
    const name = sendM[1].trim();
    const msg = sendM[2].trim();
    const target = findByName(name);
    if (target) {
      kickTurn(target.id, childKickoff(threads.get(originId), target.name, msg, { fresh: false })).catch(() => {});
      return `Messaged ${name}.`;
    }
    // The SAME storm guard SPAWN uses — promoting a SEND must not be a way
    // around the subagent ceiling, or a chatty orchestrator fans out for free
    // just by spelling its directive differently.
    const siblings = [...threads.values()].filter((x) => x.parent === originId).length;
    if (siblings >= SPAWN_MAX_CHILDREN) {
      return `Cannot create "${name}": this thread already has ${siblings} subagents `
        + `(limit ${SPAWN_MAX_CHILDREN}). Reuse one with  SEND: <existing name> | <task>.`;
    }
    const sub = newThread(name, originId, undefined, msg);
    kickTurn(sub.id, childKickoff(threads.get(originId), name, msg)).catch(() => {});
    return `${name} did not exist — spawned it with that message as its task.`;
  }
  // PING had the same anchor bug — no `m`, so a PING after any preamble (or
  // inside a fence, which is where models put lists of them) never matched.
  const pingAll = directiveLines(reply, 'PING');
  if (pingAll.length > 1) {
    const out = [];
    for (const line of pingAll) out.push(await tryDirective('PING: ' + line, originId, onEvent));
    return out.filter(Boolean).join('\n');
  }
  const ping = pingAll.length === 1 ? [null, pingAll[0]] : null;
  if (ping) {
    const name = ping[1].trim();
    // PING: * (or 'all' / 'project') WAKES every other bot in this project.
    // Coordinating a spawn tree by naming siblings one at a time is a chore
    // the parent should not have to do, and it cannot know who else exists.
    // The return is an ack ("pinged, working"), not a last-line dump that
    // lets the parent think the child already acted.
    if (/^(\*|all|project|everyone)$/i.test(name)) {
      const me = threads.get(originId);
      const root = me ? rootOf(me).rootId : null;
      const crew = [...threads.values()].filter((x) => x.id !== originId && rootOf(x).rootId === root);
      if (!crew.length) return 'No other bots in this project yet.';
      return crew.map((x) => {
        if (x.pendingRun) return x.name + ': BLOCKED — waiting for approval';
        if (x.status === 'thinking') return x.name + ': still working';
        wakeOnPing(x);
        return x.name + ': pinged, working';
      }).join('\n');
    }
    const target = findByName(name);
    if (!target) return `No thread named "${name}".`;
    if (target.pendingRun) return `${name}: BLOCKED — waiting for approval`;
    if (target.status === 'thinking') return `${name} is still working.`;
    wakeOnPing(target);
    return `${name}: pinged, working`;
  }
  const done = /^[ \t>*-]*DONE:\s*/m.exec(reply);
  if (done) {
    const t = threads.get(originId);
    if (!t) return 'Done.';
    const result = finishChildDir(t);
    if (result.removed) return 'Done — clean worktree removed.';
    if (result.kept) return 'Done — worktree kept (has local work).';
    return 'Done.';
  }
  const peek = /^[ \t>*-]*PEEK:\s*(.+)/m.exec(reply);
  if (peek) {
    const name = peek[1].trim();
    const target = findByName(name);
    if (!target) return `No thread named "${name}".`;
    const recent = target.history.slice(-4)
      .map((h) => (h.who === 'user' ? 'you' : (h.name || target.name)) + ': ' + h.text).join('\n');
    return `${name} (${target.status}):\n${recent || '(nothing yet)'}`;
  }
  const write = /^[ \t>*-]*WRITE:\s*([^|]+)\|([\s\S]+)/m.exec(reply);
  if (write) {
    const rel = write[1].trim();
    const content = write[2].replace(/^\n/, '');
    try {
      const full = safeResolveIn(dirFor(originId), rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
      noteFileForCorpus(originId, full);
      return `Wrote ${rel} (${Buffer.byteLength(content)} bytes) to ${dirFor(originId)}.${await previewAck(originId, rel)}`;
    } catch (e) { return `Couldn't write ${rel}: ${e.message}`; }
  }
  const readD = /^[ \t>*-]*READ:\s*(.+)/m.exec(reply);
  if (readD) {
    const rel = readD[1].trim();
    try {
      const full = safeResolveIn(dirFor(originId), rel);
      const data = readFileSync(full, 'utf8');
      noteFileForCorpus(originId, full);
      return `${rel}:\n${keepWhole(data)}`;
    } catch (e) { return `Couldn't read ${rel}: ${e.message}`; }
  }
  // EDIT beats WRITE for changing part of a file: WRITE overwrites the whole
  // thing, so a model that wants a one-line change has to reproduce the entire
  // file from memory and silently drops whatever it forgot.
  const edit = /^[ \t>*-]*EDIT:\s*([^|]+)\|([\s\S]*?)\|\|\|([\s\S]*)$/m.exec(reply);
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
      noteFileForCorpus(originId, full);
      return `Edited ${rel} (${before.length} -> ${before.replace(oldStr, newStr).length} bytes).${await previewAck(originId, rel)}`;
    } catch (e) { return `Couldn't edit ${rel}: ${e.message}`; }
  }

  // Several edits to ONE file, applied all-or-nothing. Sequential EDITs are a
  // trap: the third can fail after the first two already landed, leaving the
  // file in a state neither the model nor the user expected.
  const multi = /^[ \t>*-]*MULTIEDIT:\s*([^|]+)\|([\s\S]+)$/m.exec(reply);
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
      noteFileForCorpus(originId, full);
      return `MULTIEDIT ${rel}: ${applied.length} edit(s) applied (${before.length} -> ${next.length} bytes).${await previewAck(originId, rel)}`;
    } catch (e) { return `Couldn't multiedit ${rel}: ${e.message}`; }
  }

  // Jupyter: replace one cell's source by index, keeping the notebook valid.
  const nb = /^[ \t>*-]*NOTEBOOK:\s*([^|]+)\|\s*(\d+)\s*\|([\s\S]+)$/m.exec(reply);
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
      noteFileForCorpus(originId, full);
      return `NOTEBOOK ${rel}: replaced cell ${idx} (${doc.cells[idx].cell_type}); outputs cleared.`;
    } catch (e) { return `Couldn't edit ${rel}: ${e.message}`; }
  }

  // The real directory listing. It has always existed and never once fired:
  // no `m` flag, so a bare LS: after any preamble was invisible, which is why
  // it looked like LS had no handler at all.
  const ls = /^[ \t>*-]*(?:LS|LIST|DIR):[ \t]*(.*)$/m.exec(reply);
  if (ls) {
    const rel = ls[1].trim() || '.';
    try {
      const full = inDir(dirFor(originId), rel);
      const entries = listDir(dirFor(originId), rel);
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

  // LS:/LIST:/DIR:/FIND: are ALIASES for GLOB, and the argument is optional.
  //
  // Models reach for "LS:" constantly — it is the obvious name for the thing
  // and it is all over their training. We only ever documented GLOB, so a bot
  // emitted a bare `LS:` (MEASURED live, right after announcing "let me first
  // check the current directory"), nothing matched, the line rendered as chat
  // text, and the user typed "continue…". Refusing a directive over its
  // spelling is not a rule, it is a bug that costs a paid turn every time.
  //
  // A bare LS: means "what is here" — the empty pattern that GLOB would reject
  // becomes `*`, which is what was meant.
  const glob = /^(?:GLOB|LS|LIST|DIR|FIND):[ \t]*(.*)$/m.exec(reply);
  if (glob) {
    let pattern = glob[1].trim() || '*';
    try {
      const base = dirFor(originId);
      const stripped = stripBasePrefix(base, pattern);
      if (stripped !== null) pattern = stripped || '*';
      const re = globToRe(pattern.startsWith('./') ? pattern.slice(2) : pattern);
      const hits = walkDir(base).filter((f) => re.test(f) || re.test(path.basename(f)));
      if (!hits.length) return `GLOB ${pattern}: no matches`;
      return `GLOB ${pattern} — ${hits.length} match(es):\n${hits.slice(0, 200).map((h) => '  ' + h).join('\n')}`
        + (hits.length > 200 ? `\n  …${hits.length - 200} more` : '');
    } catch (e) { return `GLOB ${pattern}: ${e.message}`; }
  }

  const grep = /^[ \t>*-]*GREP:\s*([^|]+?)(?:\s*\|\s*(.+))?$/m.exec(reply);
  if (grep) {
    const pattern = grep[1].trim();
    const scope = (grep[2] || '').trim();
    try {
      const base = dirFor(originId);
      let re;
      try { re = new RegExp(pattern, 'i'); }
      catch { return `GREP: ${pattern} isn't a valid regex.`; }
      let files = walkDir(base);
      if (scope) {
        const stripped = stripBasePrefix(base, scope);
        const use = stripped !== null ? stripped : scope;
        const sre = globToRe(use);
        files = files.filter((f) => sre.test(f) || f.startsWith(use));
      }
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
  const todo = /^[ \t>*-]*TODO:\s*([\s\S]*)$/m.exec(reply);
  if (todo) {
    const t = threads.get(originId);
    if (!t) return 'TODO: no such thread.';
    t.todos = t.todos || [];
    const body = todo[1].trim();
    if (!body || /^(list|show)$/i.test(body)) {
      if (!t.todos.length) return 'TODO: (empty)';
      return 'TODO:\n' + t.todos.map((x, i) => `  ${i + 1}. [${x.done ? 'x' : ' '}] ${x.text}`).join('\n');
    }
    // TICKING SOMETHING OFF TELLS THE CREW.
    //
    // A goal completed in silence is a goal the rest of the project cannot
    // build on. Every agent was working blind: five bots writing five halves
    // of the same thing, nobody able to see what already existed, and the
    // orchestrator reduced to PINGing for status one bot at a time. The
    // information was there the whole time — it just never left the thread.
    //
    // "done <n> | <summary>" broadcasts a short peek to the project. The
    // summary is OPTIONAL; without one the item's own text is the peek, which
    // is usually enough and costs nothing to write.
    const done = /^done\s+(\d+)\s*(?:\|\s*([\s\S]+))?$/i.exec(body);
    if (done) {
      const idx = Number(done[1]) - 1;
      if (!t.todos[idx]) return `TODO: no item ${done[1]}.`;
      t.todos[idx].done = true;
      const peek = (done[2] || '').trim() || t.todos[idx].text;
      saveThreads();
      const left = t.todos.filter((x) => !x.done).length;
      // Everyone in the project EXCEPT the sender, and only when there is a
      // project — a lone bot broadcasting to nobody is just a wasted turn.
      const root = rootOf(t).rootId;
      const crew = [...threads.values()].filter((x) => x.id !== t.id && rootOf(x).rootId === root);
      for (const x of crew) {
        kickTurn(x.id, `[${t.name} finished] ${peek}\n`
          + `(${t.todos.length - left}/${t.todos.length} of its goals done. `
          + `This is a status peek — do NOT redo this work, and do not reply unless it changes yours.)`)
          .catch(() => {});
      }
      return 'TODO:\n' + t.todos.map((x, i) => `  ${i + 1}. [${x.done ? 'x' : ' '}] ${x.text}`).join('\n')
        + (crew.length ? `\n\nTold ${crew.length} bot(s) in this project: ${peek.slice(0, 90)}` : '');
    }
    if (/^clear$/i.test(body)) { t.todos = []; saveThreads(); return 'TODO: cleared.'; }
    // Otherwise: replace the list with the lines given.
    t.todos = body.split('\n').map((l) => l.replace(/^[-*\d.)\]\s]+/, '').trim())
      .filter(Boolean).map((text) => ({ text, done: false }));
    saveThreads();
    return 'TODO:\n' + t.todos.map((x, i) => `  ${i + 1}. [ ] ${x.text}`).join('\n');
  }

  const serve = /^[ \t>*-]*SERVE:\s*(.*)$/m.exec(reply);
  if (serve) {
    let rel = serve[1].trim();
    try {
      if (rel) {
        const root = path.resolve(dirFor(originId));
        const full = inDir(root, rel);
        rel = full === root ? '' : full.slice(root.length + 1);
      }
    } catch (e) { return `Couldn't serve ${serve[1].trim()}: ${e.message}`; }
    const port = await ensureWorkspacePort();
    if (!port) {
      return `Serving ${rel || 'index.html'} from ${dirFor(originId)} — waiting for the workspace port to bind.`;
    }
    return `Serving at http://localhost:${port}/${originId}/${rel}`;
  }
  const fetchD = /^[ \t>*-]*FETCH:\s*(\S+)/m.exec(reply);
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

function autoClaudePrompt(t, userText, images) {
  const bits = [];
  if (t.memory?.length) bits.push(`Remember, for this thread:\n${t.memory.map((x) => `- ${x}`).join('\n')}`);
  if (t.todos?.length) {
    bits.push(`Current checklist:\n${t.todos.map((x, i) => `${i + 1}. [${x.done ? 'x' : ' '}] ${x.text}`).join('\n')}`);
  }
  if (images?.length) bits.push(`(${images.length} image(s) were attached in the desktop UI; work from the text ask.)`);
  bits.push(String(userText || ''));
  return bits.join('\n\n');
}

/**
 * Orange Auto = Claude Code print loop, paid through OpenZoo. Not the
 * RUN:/WRITE:/DONE: text harness (that parked on "Done." after empty mkdirs).
 */
async function runAutoClaudeTurn(t, userText, images, paint, stillMine, turnAbort) {
  paint({ type: 'start', name: t.name, color: t.color, detail: t.liveStatus || 'Claude Code via OpenZoo…' });
  let visible = '';
  let thinking = '';
  let streamedText = false;
  const result = await runClaudeCode({
    prompt: autoClaudePrompt(t, userText, images),
    cwd: dirFor(t.id),
    sessionId: t.claudeSessionId,
    model: t.model || undefined,
    env: process.env,
    signal: turnAbort.signal,
    onEvent(folded) {
      if (!stillMine() || !folded) return;
      if (folded.sessionId) t.claudeSessionId = folded.sessionId;
      if (folded.kind === 'init') {
        paint({ type: 'status', name: t.name, color: t.color, detail: folded.model || 'Claude Code' });
        return;
      }
      if (folded.kind === 'think' && folded.text) {
        thinking += folded.text;
        paint({ type: 'think', name: t.name, color: t.color, delta: folded.text });
        return;
      }
      if (folded.kind === 'text' && folded.text) {
        streamedText = true;
        visible += folded.text;
        paint({ type: 'delta', name: t.name, color: t.color, delta: folded.text });
        return;
      }
      if (folded.kind !== 'assistant') return;
      if (folded.thinking && !thinking) {
        thinking = folded.thinking;
        paint({ type: 'think', name: t.name, color: t.color, delta: folded.thinking });
      }
      if (folded.text && !streamedText) {
        visible = folded.text;
        paint({ type: 'delta', name: t.name, color: t.color, delta: folded.text, replace: true });
      }
      for (const tool of folded.tools || []) {
        paint({ type: 'status', name: t.name, color: t.color, detail: toolStatusLine(tool.name, tool.input) });
      }
    },
  });
  if (!stillMine()) return result.paymentFailed || result.text || visible || '';
  if (result.sessionId) t.claudeSessionId = result.sessionId;
  const finalText = result.paymentFailed
    || result.text
    || visible
    || (result.missing ? CLAUDE_MISSING : '')
    || '(no response)';
  t.history.push({ who: 'bot', text: finalText, thinking: thinking || undefined });
  paint({ type: 'final', name: t.name, color: t.color, text: finalText, thinking: thinking || undefined });
  return finalText;
}

// onEvent (optional) gets live progress for whoever's actually watching this
// call: {type:'start',name,color} when a bot begins its turn, {type:'status',
// detail} while paying / waiting / racing / walking tools, {type:'race',race}
// for the spectator grid (one cell per launched model + a judging beat),
// {type:'delta',name,color,delta} per streamed token (replace:true swaps the
// bubble once), {type:'think',delta} for folded chain-of-thought (not the
// Auto run-mode chip), {type:'final',name,color,text} once its full reply (or
// directive ack) is settled. Background turns go through kickTurn →
// emitToThread, which is a no-op if nobody has the thread open.
async function runTurn(threadId, userText, onEvent, images) {
  const t = threads.get(threadId);
  if (!t) return;
  // A new user prompt must not sit behind a dead auto-continue. Bump the
  // generation so the previous runTurn's awaits bail instead of keeping
  // status=thinking and the UI on "…".
  if (!isHarnessUserText(userText)) t.turnSeq = (t.turnSeq || 0) + 1;
  const seq = t.turnSeq || 0;
  // Missing turnSeq is 0, not undefined. A ping/AUTO_CONTINUE as the first
  // message used to make stillMine() always false (undefined === 0), so the
  // RUN ran or the model was paid and then the hop bailed before chaining —
  // kids looked "pinged" then dead.
  const stillMine = () => (threads.get(threadId)?.turnSeq || 0) === seq;
  const paint = (ev) => {
    if (!stillMine()) return;
    if (ev.type === 'status' && ev.detail && t.status === 'thinking') t.liveStatus = ev.detail;
    if (ev.type === 'race' && ev.race && t.status === 'thinking') t.liveRace = ev.race;
    if (ev.type === 'delta' || ev.type === 'think' || ev.type === 'status' || ev.type === 'start' || ev.type === 'race') t.lastDeltaAt = Date.now();
    onEvent?.(ev);
  };
  t.history.push(images && images.length ? { who: 'user', text: userText, images } : { who: 'user', text: userText });
  t.lastActivityAt = Date.now();
  t.status = 'thinking';
  t.thinkingAt = Date.now();
  t.lastDeltaAt = Date.now();
  try { turnAborts.get(t)?.abort(); } catch { /* none */ }
  const turnAbort = new AbortController();
  turnAborts.set(t, turnAbort);
  lockWorktree(t);
  const raceN = Math.min(Number(t.race) || 0, 4);
  const raceNeed = Math.min(Math.max(Number(t.raceNeed) || 1, 1), raceN || 1);
  t.liveRace = null;
  t.liveStatus = (!t.model && raceN >= 2) ? formatRaceStatus(0, raceNeed) : 'waiting on model…';
  let chained = false;
  let parked = false;
  let usedClaude = false;
  let lastReply = '';
  try {
  if (t.members) {
    // sequential, not parallel: each member's context is rebuilt from
    // t.history right before its turn, so it sees every reply (including
    // spawns/sends) the earlier members in THIS round already made
    let memberReply = '';
    for (const m of t.members) {
      if (!stillMine()) return;
      const msgs = buildMemberMessages(t, m);
      let r = '';
      paint({ type: 'start', name: m.name, color: m.color, detail: 'waiting on model…' });
      const emitStatus = (detail) => paint({ type: 'status', name: m.name, color: m.color, detail });
      try {
        r = onEvent
          ? (await brainStream(msgs, (delta, meta) => {
            if (meta?.think) paint({ type: 'think', name: m.name, color: m.color, delta });
            else paint({ type: 'delta', name: m.name, color: m.color, delta });
          }, t.contextId, undefined, undefined, 0, 0, emitStatus)).trim()
          : (await brain(msgs, t.contextId)).trim();
      } catch (e) { r = `error: ${e.message}`; }
      if (!stillMine()) return;
      const memberThink = takeThink(r);
      r = memberThink.text;
      memberReply = r;
      const runCmd = parseRun(r);
      if (runCmd) {
        const command = runCmd;
        if (t.runMode === 'auto') {
          emitLiveStatus(t.id, paint, peekDirectiveStatus('', command));
          const output = await execCommand(command, dirFor(t.id));
          noteRunForCorpus(t.id, command, { cwd: dirFor(t.id) });
          const shown = `$ ${command}\n${output}`;
          t.history.push({
            who: 'bot', text: command, runStatus: 'done', runOutput: output,
            name: m.name, color: m.color, thinking: memberThink.thinking,
          });
          paint({ type: 'final', name: m.name, color: m.color, text: command, thinking: memberThink.thinking });
          memberReply = shown;
          // this member's turn is done; the round continues to the next member
          continue;
        }
        const runId = randomUUID();
        t.pendingRun = { runId, command, cwd: dirFor(t.id) };
        t.history.push({ who: 'bot', text: command, runId, runStatus: 'pending', name: m.name, color: m.color, thinking: memberThink.thinking });
        paint({ type: 'run-pending', runId, command, name: m.name, color: m.color, thinking: memberThink.thinking });
        // pauses the WHOLE round here — the rest of the group gets their turn
        // on the round that runs after the user approves/denies
        parked = true;
        return;
      }
      const ack = await tryDirective(r, t.id, paint);
      const finalText = ack ?? (r || '(no response)');
      t.history.push({ who: 'bot', text: finalText, name: m.name, color: m.color, thinking: memberThink.thinking });
      paint({ type: 'final', name: m.name, color: m.color, text: finalText, thinking: memberThink.thinking });
      memberReply = r;
    }
    bindThread(t).catch(() => {});
    lastReply = memberReply;
    if (shouldKeepAuto(t, memberReply, userText)) {
      chained = enqueueAutoHop(t, threadId, autoHopText(memberReply, userText), onEvent);
    }
    return;
  }
  // Orange Auto is Claude Code (`openzoo claude` env), not the RUN:/WRITE:
  // text loop. Ask (and group members above) still use chat/completions.
  if (t.runMode === 'auto') {
    usedClaude = true;
    lastReply = await runAutoClaudeTurn(t, userText, images, paint, stillMine, turnAbort);
    if (stillMine()) bindThread(t).catch(() => {});
    return;
  }
  // A real message from the user resets the auto budget AND the announcement
  // nudge. Harness-injected hops (command output, directive result, nudge,
  // auto-continue) must not re-arm — that would make AUTO_MAX_STEPS a no-op
  // on the directive path (it used to reset every hop because only
  // "(command output)" was excluded).
  if (!isHarnessUserText(userText) && !/^\((command output|directive result)\)/.test(userText)) {
    t.autoSteps = 0;
    delete t.autoNudged;
  }
  t.messages.push({ role: 'user', content: contentFor(userText, images) });
  let reply = '';
  paint({ type: 'start', name: t.name, color: t.color, detail: t.liveStatus || 'waiting on model…' });
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
  extras.push({ role: 'system', content: CHAT_NOT_PROXY });
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
    if (brainAskOverride) {
      return String(await brainAskOverride({
        thread: t, attempt, userText, messages: callMsgs,
      }) ?? '').trim();
    }
    const emit = (delta, meta) => {
      if (meta?.think) {
        paint({ type: 'think', name: t.name, color: t.color, delta });
        return;
      }
      paint({
        type: 'delta', name: t.name, color: t.color, delta,
        ...(meta?.replace ? { replace: true } : {}),
        ...(meta?.model ? { model: meta.model } : {}),
      });
    };
    const emitStatus = (detail) => paint({ type: 'status', name: t.name, color: t.color, detail });
    // SPAWN kids search the project root's corpus. A brand-new chat is its
    // own holobrain — do not scale top_k off another thread's boundItems.
    const topK = adaptiveTopK((holobrainOf(t) || t).boundItems);
    const race = Math.min(Number(t.race) || 0, 4);
    if (!t.model && race >= 2) {
      const useAuto = !t.tier || t.tier === 'auto';
      let models = [];
      if (useAuto) {
        try {
          const routed = routeChatBody({ messages: callMsgs }, { k: race, allow_free: false, bindable: true });
          models = (routed.shortlist || []).map((s) => s.model).filter(Boolean);
          if (routed.model && !models.includes(routed.model)) models.unshift(routed.model);
          models = [...new Set(models)].slice(0, race);
        } catch { models = []; }
      }
      if (!models.length) models = await tierModels(useAuto ? 'medium' : (t.tier || 'medium'), race, true);
      // need = how many must come BACK before judging. need 1 is a plain
      // first-past-the-post race; need N waits for all of them. The point of
      // the middle (2 of 3) is a judged answer without the slowest entrant
      // setting the latency. Collection is first-X-back (non-empty);
      // classify runs only on those X.
      const need = Math.min(Math.max(Number(t.raceNeed) || 1, 1), race);
      return (await brainRace(callMsgs, emit, t.contextId, models, need, undefined, emitStatus, {
        signal: turnAbort.signal,
        onArrivals: (arr) => { t.lastRaceFail = summarizeRaceFailures(arr); },
        onRace: (snap) => paint({ type: 'race', name: t.name, color: t.color, race: snap }),
        tier: t.tier || 'medium',
      })).trim();
    }
    // A retry draws a DIFFERENT model from the tier rather than the same one.
    const model = t.model || 'openzoo/auto';
    return (onEvent
      ? (await brainStream(callMsgs, emit, t.contextId, model, undefined, 0, topK, emitStatus)).trim()
      : (await brain(callMsgs, t.contextId, model, topK)).trim());
  };
  try {
    reply = await ask();
    if (!stillMine()) return;
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
    for (let i = 0; (!reply || isTransientModelFail(reply)) && i < AUTO_EMPTY_RETRIES; i++) {
      paint({ type: 'status', name: t.name, color: t.color, detail: 'retrying…' });
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      if (!stillMine()) return;
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
  if (!stillMine()) return;
  const settled = takeThink(reply);
  reply = settled.text;
  lastReply = reply;
  t.messages.push({ role: 'assistant', content: reply });
  const runCmd = parseRun(reply);
  if (runCmd) {
    const command = runCmd;
    if (t.runMode === 'auto') {
      emitLiveStatus(t.id, paint, peekDirectiveStatus('', command));
      const output = await execCommand(command, dirFor(t.id));
      noteRunForCorpus(t.id, command, { cwd: dirFor(t.id) });
      if (!stillMine()) return;
      const shown = `$ ${command}\n${output}`;
      t.history.push({ who: 'bot', text: command, runStatus: 'done', runOutput: output, thinking: settled.thinking });
      paint({ type: 'final', name: t.name, color: t.color, text: command, thinking: settled.thinking });
      // FEED THE OUTPUT BACK. The 'ask' path already does this on approve, so
      // auto mode was strictly LESS capable than the gated one: the command
      // ran, the result was shown, and the model never saw it — no diagnosis,
      // no follow-up, no next step. It looked like "auto mode does nothing".
      //
      // Bounded, because this is a loop that spends real money on every hop:
      // AUTO_MAX_STEPS chained commands per user message, reset whenever the
      // user speaks again.
      // BIND BEFORE CHAINING. bindThread only ran at the end of a normal
      // turn, and both auto paths return before reaching it — so in auto
      // mode nothing was ever bound, exactly when the agent produces the
      // most material (command output, GLOB results, MCP tool lists). The
      // holographic context stopped growing precisely when it mattered.
      lastReply = shown;
      chained = enqueueAutoHop(
        t, threadId,
        isEmptyExecOutput(output) ? AUTO_EMPTY_RETRY : condense('(command output)', output),
        onEvent,
      );
      return;
    }
    {
      const runId = randomUUID();
      t.pendingRun = { runId, command, cwd: dirFor(t.id) };
      t.history.push({ who: 'bot', text: command, runId, runStatus: 'pending', thinking: settled.thinking });
      paint({ type: 'run-pending', runId, command, name: t.name, color: t.color, thinking: settled.thinking });
    }
    parked = true;
    return;
  }
  const ack = await tryDirective(reply, t.id, paint);
  if (!stillMine()) return;
  const finalText = ack ?? (reply || '(no response)');
  t.history.push({ who: 'bot', text: finalText, thinking: settled.thinking });
  paint({ type: 'final', name: t.name, color: t.color, text: finalText, thinking: settled.thinking });

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
  if (t.runMode === 'auto' && ack !== null && ack !== undefined
      && (isEmptyDirectiveAck(ack) || !isDoneReply(reply))) {
    chained = enqueueAutoHop(
      t, threadId,
      isEmptyDirectiveAck(ack) ? AUTO_EMPTY_RETRY : condense('(directive result)', ack),
      onEvent,
    );
    return;
  }

  // ANNOUNCING IS NOT DOING — so do not let it end the turn.
  //
  // In auto, a reply with NO directive stopped the chain dead. The common one
  // is not a finished answer, it is an announcement: "I'll break this down and
  // spawn subagents immediately. First, let me check the uploaded files." The
  // harness posted that as the final word and waited, so the user typed
  // "continue?" — MEASURED live, three prompts to get one SPAWN.
  //
  // AUTO_DIRECTIVE already forbids this in the prompt, and models do it anyway.
  // A prompt rule with no enforcement is a suggestion. Re-ask once, in-band.
  //
  // NUDGE announcements (stronger than a bare continue). Plain replies used
  // to park here; they now fall through to AUTO_CONTINUE unless DONE: or a
  // real blocking question. The step cap is the wallet bound.
  if (t.runMode === 'auto' && (ack === null || ack === undefined)
      && (STALLED_OFFER.test(reply) || ANNOUNCEMENT.test(reply))) {
    // Offers and "Spawned X — working on it" with no directive must not end
    // the run. The old once-only autoNudged gate parked the thread after one
    // hedge and the user typed continue.
    t.autoNudged = true;
    chained = enqueueAutoHop(t, threadId, NUDGE, onEvent);
    return;
  }

  // After any auto reply that is not DONE: and not waiting on approval,
  // kick immediately. Race/empty/error uses AUTO_RACE_RETRY.
  if (shouldKeepAuto(t, reply, userText)) {
    chained = enqueueAutoHop(t, threadId, autoHopText(reply, userText), onEvent);
    return;
  }
  bindThread(t).catch(() => {});
  } finally {
    // Idle only when this hop should not keep AUTO going: DONE:, pendingRun,
    // ask mode, 402/empty-wallet, or the hard cap. Empty /(no output) is not
    // DONE — AUTO_EMPTY_RETRY. Otherwise kick again.
    if (stillMine() && !chained && !parked) {
      if (!usedClaude && shouldKeepAuto(t, lastReply, userText)) {
        enqueueAutoHop(t, threadId, autoHopText(lastReply, userText), onEvent);
      } else if (!t.pendingRun) {
        t.status = 'idle';
        t.liveStatus = '';
        t.liveRace = null;
        unlockWorktree(t);
      }
    }
    t.lastActivityAt = Date.now();
    saveThreads();
  }
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

/**
 * Everyone at or below a thread. Ping-all lives HERE, not on the project root.
 *
 * "/all" used to mean "every bot sharing my rootId" — the whole project,
 * regardless of who you were talking to. That is the wrong unit once a tree has
 * real tiers: a mid-level owner wants to reach ITS OWN crew, not the eleven
 * cousins under a sibling. Addressing the whole project from a leaf is how one
 * message costs twenty paid turns.
 *
 * Cycle-guarded, because SPAWN sets parent from whoever emitted the directive
 * and a bot spawning toward its own ancestor would otherwise loop here.
 */
function subtreeOf(id, includeSelf = false) {
  const out = [];
  const seen = new Set([id]);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const x of threads.values()) {
      if (x.parent === cur && !seen.has(x.id)) {
        seen.add(x.id);
        out.push(x);
        stack.push(x.id);
      }
    }
  }
  const self = threads.get(id);
  return includeSelf && self ? [self, ...out] : out;
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
    liveStatus: t.status === 'thinking' ? (t.liveStatus || '') : '',
    rootId: rootOf(t).rootId, depth: rootOf(t).depth,
    rootName: (threads.get(rootOf(t).rootId) || t).name,
    // The spend dial, so the header can show it without a round trip per
    // thread. `model` pinned means tier/race are inert — the UI says so.
    tier: t.tier || 'medium', race: Number(t.race) || 0, raceNeed: Number(t.raceNeed) || 1, model: t.model || '',
    // How many bots sit BELOW this one. The ping-all affordance belongs on
    // anyone with a crew, not only on a project root.
    kids: subtreeOf(t.id).length,
    // Names only — enough for the sidebar/header to stack a little crew PFP
    // without shipping every member's system prompt to the browser.
    members: t.members ? t.members.map((m) => m.name) : undefined,
    workspacePort: workspacePort || 0 };
}

const APP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>openzoo</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; width: 100%; overflow: hidden; background: #000; }
  body { color: #ececec; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         display: flex; }
  #dragbar { -webkit-app-region: drag; position: fixed; top: 0; left: 0; right: 0; height: 28px; z-index: 1000; }
  #sidebar { width: 280px; flex: 0 0 280px; border-right: 1px solid #1c1c1e; display: flex; flex-direction: column;
             height: 100%; padding-top: 28px; min-height: 0; position: relative; }
  #main { padding-top: 28px; }
  #sideTop { display: flex; align-items: center; gap: 4px; padding: 0 8px; }
  #sideTop #search { flex: 1; }
  #search { margin: 12px; padding: 8px 12px; background: #1c1c1e; border-radius: 10px; color: #ececec;
            border: none; font: inherit; }
  #search::placeholder { color: #8e8e93; }
  #threads { flex: 1; min-height: 0; overflow-y: auto; }
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
  /* On a THREAD row the button sits beside the close X, so it follows the same
     reveal-on-hover rule — a permanently visible control on every parent row
     would turn the sidebar into a wall of buttons. */
  .trow .pingall { flex: 0 0 auto; margin-left: 2px; }
  .trow:hover .pingall, .trow.active .pingall { opacity: 1; }
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
  /* BOT PFPs. Grok Bot uses a cute illustrated face, not two letters in a
     rounded square. The SVG is generated in botPfp(); this just frames it
     as a round clip and runs a cheap idle bob/blink. overflow:hidden clips
     the bounce so it cannot paint over the HUD or wallet. */
  .tavatar { width: 36px; height: 36px; border-radius: 50%; flex: 0 0 36px; overflow: hidden;
             display: flex; align-items: center; justify-content: center; background: #1c1c1e;
             color: #fff; font-weight: 600; font-size: 14px; }
  .tavatar svg { width: 100%; height: 100%; display: block; }
  .tavatar-sm { width: 28px; height: 28px; flex: 0 0 28px; }
  .tavatar-plus { background: #3a3a3c; font-size: 15px; }
  .bot-pfp .bot-bob { transform-box: fill-box; transform-origin: 50% 70%;
                      animation: botbob 2.8s ease-in-out infinite; animation-delay: var(--bot-delay, 0s); }
  .bot-pfp .bot-eyes { transform-box: fill-box; transform-origin: 50% 50%;
                       animation: botblink 3.8s step-end infinite; animation-delay: var(--bot-blink, 0s); }
  @keyframes botbob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-1.5px); } }
  @keyframes botblink { 0%,88%,100% { transform: scaleY(1); } 90%,94% { transform: scaleY(0.08); } }
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
  @media (prefers-reduced-motion: reduce) {
    .twarn, .bot-pfp .bot-bob, .bot-pfp .bot-eyes { animation: none; }
  }
  #main { position: relative; flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; height: 100%; }
  #chatHeader { padding: 14px 20px; border-bottom: 1px solid #1c1c1e; display: flex; align-items: center;
                flex-wrap: wrap; gap: 8px 10px; font-weight: 600; }
  #chatHeader .tavatar { width: 26px; height: 26px; border-radius: 50%; font-size: 11px; flex: 0 0 26px; }
  /* Title shrinks and wraps; the spend dials must stay on screen. margin-left:auto
     on #modeToggle used to shove cheap/race/wallet off the right edge. */
  #chatHeaderId { display: flex; align-items: center; gap: 10px; flex: 1 1 120px; min-width: 0; overflow: hidden; }
  #headerDials { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-left: auto; flex: 0 1 auto; }
  .hname { display: flex; flex-direction: column; gap: 1px; min-width: 0; overflow: hidden; }
  .hname > div:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hdir { font-weight: 400; font-size: 11px; color: #8e8e93; white-space: nowrap; overflow: hidden;
          text-overflow: ellipsis; max-width: 420px; }
  /* Run-mode toggle. The "/mode auto|ask" chat command still works and is
     still what the bots are told about, but it is invisible until you know it
     exists — and it controls whether shell commands run without asking, which
     is exactly the setting a user should be able to SEE at a glance. */
  #modeToggle { display: flex; align-items: center; gap: 0;
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
  /* WALLET. GET /wallet shipped in 1.5.22 with nothing pointing at it, so the
     box's own deposit addresses were reachable only by curl — on a product
     whose entire premise is that the box pays for itself. Click-to-copy is a
     shortcut; the address is selectable so Cmd/Ctrl+C still works if copy
     fails. */
  #walletOverlay, #sitrepOverlay { position: fixed; inset: 0; background: rgba(0,0,0,.66); z-index: 1200;
                   display: none; align-items: center; justify-content: center; padding: 24px; }
  #walletOverlay.show, #sitrepOverlay.show { display: flex; }
  .payneed-btn { display: block; margin-top: 10px; border: 0; cursor: pointer;
    background: #b8f240; color: #0b0b0d; font: 700 12px/1.2 inherit;
    letter-spacing: .04em; padding: 7px 14px; border-radius: 999px; }
  .payneed-btn:hover { filter: brightness(1.05); }
  #walletBox, #sitrepBox { width: 100%; max-width: 560px; max-height: 82vh; overflow-y: auto; background: #111113;
               border: 1px solid #2c2c2e; border-radius: 16px; padding: 20px 22px; }
  #walletBox h3, #sitrepBox h3 { margin: 0 0 2px; font-size: 15px; font-weight: 600; }
  #sitrepBox { max-width: 420px; }
  .srow { display: flex; justify-content: space-between; align-items: baseline; gap: 14px;
          padding: 8px 0; border-bottom: 1px solid #1c1c1e; }
  .srow:last-child { border-bottom: 0; }
  .slab { color: #6f7080; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; flex: 0 0 auto; }
  .sval { color: #ececec; font-size: 13px; text-align: right; word-break: break-word; min-width: 0; }
  .sval.hlime { color: #b8f240; }
  .sval.hember { color: #f28c4d; }
  .wsub { color: #8e8e93; font-size: 12px; margin-bottom: 16px; }
  .wrow { border: 1px solid #1c1c1e; border-radius: 12px; padding: 10px 12px; margin-bottom: 10px;
          display: flex; align-items: center; gap: 10px; cursor: pointer; }
  .wrow:hover { border-color: #3a3a3c; background: #151517; }
  .wrow .wlab { flex: 0 0 74px; color: #6f7080; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  /* min-width:0 or the address (one unbreakable token) widens the row and
     pushes the copy affordance out of the box — the same flexbox trap that
     once pushed the cost button off-screen. */
  .wrow .waddr { flex: 1; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                 font-size: 12px; word-break: break-all; line-height: 1.45; cursor: text;
                 -webkit-user-select: all; user-select: all; -webkit-app-region: no-drag; }
  .wrow .wcopy { flex: 0 0 auto; color: #6f7080; font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
                 user-select: none; }
  .wrow:hover .wcopy { color: #b8f240; }
  .wcredit { border: 1px solid #2a3a18; background: rgba(184,242,64,.08); border-radius: 12px;
             padding: 12px 14px; margin-bottom: 12px; }
  .wcredit .wbig { color: #b8f240; font-size: 22px; font-weight: 700; letter-spacing: -0.03em; }
  .wcredit .wlab2 { color: #8e8e93; font-size: 11px; margin-top: 2px; }
  .wbal { border: 1px solid #1c1c1e; border-radius: 12px; padding: 10px 12px; margin-bottom: 10px;
          font-size: 12px; color: #ececec; line-height: 1.7; word-break: break-word; }
  .wnote { color: #6f7080; font-size: 11px; line-height: 1.6; margin-top: 12px; }
  .wempty { color: #f28c4d; }
  .wlane { border-top: 1px solid #2c2c2e; margin-top: 16px; padding-top: 14px; }
  .wlanetitle { font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
                color: #ececec; margin-bottom: 4px; }
  .wtag { color: #b8f240; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; margin-bottom: 8px; }
  .wtier { border: 1px solid #1c1c1e; border-radius: 12px; padding: 10px 12px; margin-bottom: 8px; }
  .wtier.hot { border-color: #b8f240; }
  .wtier .wtn { font-size: 14px; font-weight: 600; }
  .wtier .wtp { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 18px;
                font-weight: 700; margin: 4px 0 2px; }
  .wtier .wts { color: #b8f240; font-size: 11px; }
  .wtier .wtb { color: #8e8e93; font-size: 11px; margin: 4px 0 8px; }
  .wtier button { border: 1px solid #2c2c2e; background: #131315; color: #ececec; font: inherit;
                  font-size: 12px; border-radius: 8px; padding: 6px 10px; cursor: pointer; }
  .wtier.hot button { background: #b8f240; border-color: #b8f240; color: #0b0b0d; font-weight: 600; }
  .wtier button:disabled { opacity: .5; cursor: default; }
  .wpaste { margin-top: 10px; }
  .wpaste input { width: 100%; background: #0b0b0d; border: 1px solid #2c2c2e; border-radius: 8px;
                  color: #ececec; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
                  padding: 8px 10px; margin: 6px 0; }
  .wpaste button { border: 1px solid #2c2c2e; background: #131315; color: #ececec; font: inherit;
                   font-size: 12px; border-radius: 8px; padding: 6px 10px; cursor: pointer; }
  .wquiet { margin-top: 10px; font-size: 11px; }
  .wquiet a { color: #6ab0ff; }
  .wsubon { color: #b8f240; font-size: 13px; font-weight: 600; margin-bottom: 8px; }
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
  #hudBtn { margin-left: 2px; }
  /* Below #chatHeader, not a hardcoded 40px — the header wraps, so 40px lands
     inside the dials (race / wallet / ◎) once they take a second row. top is
     set from the header's live bottom in placeHud(). z-index stays high; the
     bug was geometry, not stacking. */
  #hud { position: absolute; right: 14px; width: 270px; background: rgba(14,14,17,.94);
         border: 1px solid #333340; border-radius: 10px; padding: 12px 14px; font: 11px/1.5 Menlo, monospace;
         display: none; z-index: 300; box-shadow: 0 12px 30px rgba(0,0,0,.5); }
  /* Always-on strip. Sidebar footer — bottom-left of the window, inside the
     bot list column. Never a child of #main: position:absolute; left:14px
     there sat on the transcript and covered the last bubbles. ◎ stays a
     toggle; this one never hides. pointer-events none so it cannot steal
     thread-row clicks. */
  #dockHud { flex: 0 0 auto; position: relative; left: auto; bottom: auto;
    width: 100%; max-width: 100%; z-index: 1;
    pointer-events: none; background: rgba(14,14,17,.94);
    border: 0; border-top: 1px solid #333340; border-radius: 0;
    padding: 8px 12px 12px; color: #8e8e93;
    font: 10.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; }
  #dockHud .dk { color: #6f7080; }
  #dockHud .dv { color: #c8c8c2; }
  #dockHud .dv.hlime { color: #b8f240; }
  #hud.show { display: block; }
  #hud .htitle { color: #b8f240; font-size: 10px; letter-spacing: .04em; margin-bottom: 10px; }
  #hud .htitle.hsession { margin-top: 12px; padding-top: 10px; border-top: 1px solid #333340; color: #6f7080; }
  #hud .hcredit { color: #b8f240; font-size: 22px; font-weight: 700; letter-spacing: -0.03em; line-height: 1.15; }
  #hud .hcreditlab { color: #999aa8; font-size: 10px; margin: 2px 0 8px; }
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
  #sidebar, #main, #walletOverlay, #sitrepOverlay, #composeOverlay, #findBar,
  #inp, #search, #composeInp, #findInp, .bubble, .md-pre, .runoutput, .runcmd {
    -webkit-app-region: no-drag; }
  #log { flex: 1; min-width: 0; overflow-y: auto; overflow-x: hidden; padding: 20px 24px 12px;
         display: flex; flex-direction: column; gap: 6px;
         -webkit-user-select: text; user-select: text; }
  .hdr { align-self: flex-start; display: flex; align-items: center; gap: 6px; margin: 12px 0 4px;
         color: #8e8e93; font-size: 13px; }
  .hdr .avatar { width: 18px; height: 18px; border-radius: 50%; overflow: hidden; display: flex;
                 align-items: center; justify-content: center; background: #1c1c1e; }
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
  .bubble:has(> p, > .md-h, > .md-table, > .md-list, > .md-pre, > .html-preview-wrap) { white-space: normal; }
  .row:has(.html-preview) { max-width: 92%; }
  .html-preview-wrap { margin-top: 10px; }
  .html-preview-open { display: inline-block; margin-bottom: 6px; font-size: 12px; color: #6ab0ff;
                       text-decoration: underline; cursor: pointer; }
  .html-preview { display: block; width: 100%; height: 420px; border: 1px solid #3a3a3c;
                  border-radius: 12px; background: #111; }
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
    letter-spacing: .02em; cursor: pointer; user-select: none;
    transition: opacity .12s ease, background .12s ease, color .12s ease;
  }
  .md-pre, .runoutput, .runcmd { -webkit-user-select: text; user-select: text; }
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
  /* Done RUNs collapse like thinking… — raw curl JSON must not be the message. */
  .runcard.folded { background: transparent; border: none; padding: 0; }
  .runfold { align-self: flex-start; max-width: 100%; min-width: 0; }
  .runchip {
    border: 0; background: transparent; color: #8e8e93; padding: 0;
    font: 12px/1.4 inherit; cursor: pointer; letter-spacing: .01em;
    -webkit-user-select: none; user-select: none;
  }
  .runchip:hover { color: #c8c8d0; }
  .runchip:focus-visible { outline: 2px solid #ff9500; outline-offset: 2px; border-radius: 4px; }
  .runbody { display: none; margin: 4px 0 2px; }
  .runfold.open .runbody { display: block; }
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
  /* Folded chain-of-thought. Not the Auto run-mode chip — that is /mode auto.
     Default collapsed; click the label to unfurl, click again to furl.
     No empty chip: the fold is omitted when the model did not reason. */
  .msgcol { display: flex; flex-direction: column; gap: 6px; min-width: 0; max-width: 100%; flex: 1; }
  .thinkfold { align-self: flex-start; max-width: 100%; min-width: 0; }
  .thinkchip {
    border: 0; background: transparent; color: #8e8e93; padding: 0;
    font: 12px/1.4 inherit; cursor: pointer; letter-spacing: .01em;
    -webkit-user-select: none; user-select: none;
  }
  .thinkchip:hover { color: #c8c8d0; }
  .thinkchip:focus-visible { outline: 2px solid #b8f240; outline-offset: 2px; border-radius: 4px; }
  .thinkbody {
    display: none; margin: 4px 0 2px; padding: 8px 12px;
    color: #8e8e93; font-size: 12.5px; line-height: 1.45;
    white-space: pre-wrap; word-break: break-word;
    border-left: 2px solid #3a3a3c; max-height: 240px; overflow-y: auto;
  }
  .thinkfold.open .thinkbody { display: block; }
  .row.bot.pending .bubble { color: #8e8e93; }
  .dots span { display: inline-block; width: 5px; height: 5px; margin-right: 3px; border-radius: 50%;
               background: #8e8e93; animation: blink 1.2s infinite ease-in-out; }
  .dots span:nth-child(2) { animation-delay: .2s; } .dots span:nth-child(3) { animation-delay: .4s; }
  @keyframes blink { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }
  .tstatus { color: #8e8e93; font-size: 13px; margin-left: 6px; }
  .ttrail { display: block; color: #8e8e93; font-size: 12.5px; margin-top: 8px; }
  /* Race spectator board. Lives in the transcript, never over the header
     dials / wallet / cost HUD. 2×2 for four, a row for two, wrap otherwise. */
  .row.bot:has(.raceboard) { max-width: 92%; }
  .bubble.raceboard { padding: 10px 11px; background: #1a1a1d; }
  .racewrap { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .racecaption { color: #6f7080; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; }
  .racegrid { display: grid; gap: 7px; grid-template-columns: 1fr 1fr; }
  .racegrid.n1 { grid-template-columns: 1fr; }
  .racegrid.n2 { grid-template-columns: 1fr 1fr; }
  .racegrid.n3 { grid-template-columns: 1fr 1fr; }
  @media (min-width: 720px) { .racegrid.n3 { grid-template-columns: 1fr 1fr 1fr; } }
  .racecell { border: 1px solid #2c2c32; border-radius: 12px; padding: 8px 9px 7px;
              background: #141416; min-width: 0; min-height: 0; transition: opacity .18s ease, border-color .18s ease; }
  .racecell.streaming { border-color: #3d3d4a; }
  .racecell.back { border-color: #2a3a18; }
  .racecell.failed { border-color: #3a2424; }
  .racecell.abandoned { opacity: .42; }
  .racecell.winner { border-color: #b8f240; box-shadow: 0 0 0 1px rgba(184,242,64,.28); }
  .racehead { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; min-width: 0; }
  .racename { font-size: 12px; font-weight: 600; color: #ececec; white-space: nowrap;
              overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .racechip { flex: 0 0 auto; font-size: 10px; letter-spacing: .03em; color: #8e8e93;
              border: 1px solid #2c2c32; border-radius: 999px; padding: 1px 7px; }
  .racecell.streaming .racechip { color: #b8f240; border-color: #3a4a18; }
  .racecell.back .racechip { color: #b8f240; border-color: #2a3a18; }
  .racecell.failed .racechip { color: #f28c4d; border-color: #5a3020; }
  .racecell.abandoned .racechip { color: #6f7080; }
  .racecell.winner .racechip { color: #0b0b0d; background: #b8f240; border-color: #b8f240; }
  .raceprev { font: 11.5px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; color: #9a9aa6;
              white-space: pre-wrap; word-break: break-word; max-height: 8.2em; overflow: hidden; }
  .racefail { display: inline-block; margin-top: 2px; font-size: 11px; color: #f28c4d; letter-spacing: .03em; }
  .racejudge { border: 1px dashed #3a4a18; border-radius: 12px; padding: 9px 11px;
               background: rgba(184,242,64,.05); color: #c8c8b8; }
  .racejudge.won { border-style: solid; border-color: #b8f240; }
  .racejudge-lab { font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: #b8f240;
                   margin-bottom: 3px; }
  .racejudge-msg { font-size: 13px; color: #ececec; }
  @media (prefers-reduced-motion: reduce) {
    .racecell { transition: none; }
  }
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
  /* Sidebar names and header titles are readable text — they must be
     selectable so select-to-copy works there, not only in bubbles. */
  .tname, .tprev, .pname, .hname, .hdir, .hdr, .wbal, .wnote, .wsub, #chatHeader {
    -webkit-user-select: text; user-select: text; }
  /* SELECT-TO-COPY. A blink, not a dialog: selection landed on the clipboard. */
  #copiedToast {
    position: fixed; z-index: 4000; pointer-events: none;
    padding: 7px 14px; border-radius: 999px;
    background: #b8f240; color: #0b0b0d;
    font: 700 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    letter-spacing: .06em;
    box-shadow: 0 8px 24px rgba(0,0,0,.5);
    opacity: 0; transform: translate(-50%, -6px);
    transition: opacity .14s ease, transform .14s ease;
  }
  #copiedToast.show { opacity: 1; transform: translate(-50%, 0); }
  /* FIND IN THREAD. Cmd/Ctrl+F — not the sidebar thread search (that's Cmd+K).
     Sits over #log so matches stay in the conversation, not the thread list. */
  #findBar { display: none; position: absolute; right: 16px; z-index: 320;
             align-items: center; gap: 6px; background: rgba(18,18,22,.98);
             border: 1px solid #3a3a3c; border-radius: 12px; padding: 6px 8px;
             box-shadow: 0 10px 28px rgba(0,0,0,.45); }
  #findBar.show { display: flex; }
  #findInp { width: 180px; background: #0b0b0d; border: 1px solid #2c2c2e; border-radius: 8px;
             color: #ececec; font: inherit; font-size: 13px; padding: 5px 8px; }
  #findInp:focus { outline: 2px solid #6ab0ff; outline-offset: 1px; }
  #findCount { min-width: 48px; color: #8e8e93; font-size: 12px; text-align: right;
               font-variant-numeric: tabular-nums; }
  #findBar button { border: 0; background: transparent; color: #ececec; width: 26px; height: 26px;
                    border-radius: 8px; cursor: pointer; font: inherit; line-height: 1; }
  #findBar button:hover { background: #3a3a3c; }
  mark.findhit { background: #f2d64b; color: #111; border-radius: 3px; padding: 0 1px; }
  mark.findhit.cur { background: #b8f240; }
</style></head>
<body>
  <div id="copiedToast" role="status" aria-live="polite">copied</div>
  <div id="dragbar"></div>
  <div id="sidebar">
    <div id="sideTop">
      <button class="icon-btn" id="newMsgBtn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
      <input id="search" placeholder="Search">
    </div>
    <div id="threads"></div>
    <div id="rooms"></div>
    <div id="dockHud" data-component="dock-hud">
      <span><span class="dk">spill</span> <span id="dockSpill" class="dv">—</span></span>
      <span><span class="dk">session</span> <span id="dockSession" class="dv">—</span></span>
      <span><span class="dk">paid</span> <span id="dockPaid" class="dv">—</span></span>
      <span><span class="dk">bind</span> <span id="dockBind" class="dv">no</span></span>
      <span><span class="dk">calls</span> <span id="dockCalls" class="dv">0</span></span>
    </div>
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
  <div id="walletOverlay" data-component="wallet-modal">
    <div id="walletBox">
      <h3>Pay with the wallet</h3>
      <div class="wsub">x402 per call from your own wallet. No subscription, no card, no account — fund the burner and every model is open.</div>
      <div class="wlane" id="x402Lane" data-component="x402-lane">
        <div class="wlanetitle">Wallet / x402</div>
        <div class="wsub">This is <b>your</b> local burner on this machine (or this box). Keys stay in ~/.openzoo/wallet.json. It is not openzoo’s wallet, not a shared zoo account, not the model’s. You fund these deposit addresses; the app pays x402 per call from this wallet. Public addresses only — the UI never shows the key.</div>
        <div id="walletBody">loading…</div>
      </div>
    </div>
  </div>
  <div id="sitrepOverlay" data-component="sitrep-drawer">
    <div id="sitrepBox">
      <h3>Sitrep</h3>
      <div class="wsub">This thread and this session. No keys.</div>
      <div id="sitrepBody">loading…</div>
    </div>
  </div>
  <div id="main">
    <div id="chatHeader">
      <div id="chatHeaderId"></div>
      <div id="headerDials">
      <div id="modeToggle" data-component="run-mode-toggle" role="group" aria-label="Shell command mode">
        <button class="modebtn ask on" id="modeAsk" data-mode="ask"
                title="Shell commands pause and wait for your approval">ask</button>
        <button class="modebtn auto" id="modeAuto" data-mode="auto"
                title="Shell commands run immediately, with no approval prompt">auto</button>
      </div>
      <select class="dial" id="tierSel" data-component="model-tier" aria-label="Model tier"
              title="Auto = cheapest model that clears the bar. Other tiers only apply to /race.">
        <option value="auto" selected>auto</option>
        <option value="cheap">cheap</option>
        <option value="medium">medium</option>
        <option value="expensive">expensive</option>
        <option value="grok4.6">grok 4.6</option>
      </select>
      <select class="dial" id="raceSel" data-component="model-race" aria-label="Race models"
              title="Ask N models from the tier at once, drawn at random — fastest real answer wins. You pay for every entrant.">
        <option value="0" selected>1 model  0%</option>
        <optgroup label="first back wins">
          <option value="2">race 2  −50%</option>
          <option value="3">race 3  −67%</option>
          <option value="4">race 4  −75%</option>
        </optgroup>
        <optgroup label="judge the first k back">
          <option value="2 3">best 2 of 3  −67%</option>
          <option value="2 4">best 2 of 4  −75%</option>
          <option value="3 4">best 3 of 4  −75%</option>
          <option value="4 4">best 4 of 4  −75%</option>
        </optgroup>
      </select>
      <button class="dial" id="walletBtn" data-component="wallet-open"
              title="Wallet / x402">pay</button>
      <button class="icon-btn" id="reloadBtn" title="Restart grokui on this box">&#8635;</button>
      <button class="icon-btn" id="hudBtn">◎</button>
      </div>
    </div>
    <div id="hud">
      <div class="htitle">YOUR WALLET · THIS SESSION</div>
      <div class="hrow"><span>prepaid credit</span><span id="hCredit" class="hlime">—</span></div>
      <div class="hrow"><span>you've paid</span><span id="hYouSpent">—</span></div>
      <div class="hrow"><span>our cost (cogs)</span><span id="hYouCogs">—</span></div>
      <div class="hrow"><span>margin</span><span id="hYouMargin" class="hlime">—</span></div>
      <div class="hrow"><span>direct would be</span><span id="hYouDirect" class="hember">—</span></div>
      <div class="hrow"><span>saved vs. naked calls</span><span id="hYouSaved" class="hlime">—</span></div>
      <div class="hhint" id="hHint"></div>
      <div class="hfoot" id="hFoot">loading…</div>
    </div>
    <div id="log"></div>
    <div id="findBar" role="search" data-component="find-in-thread">
      <input id="findInp" type="search" placeholder="Find in conversation" autocomplete="off" spellcheck="false">
      <span id="findCount" aria-live="polite"></span>
      <button type="button" id="findPrev" title="Previous" aria-label="Previous match">↑</button>
      <button type="button" id="findNext" title="Next" aria-label="Next match">↓</button>
      <button type="button" id="findClose" title="Close" aria-label="Close find">×</button>
    </div>
    <div id="bar">
      <div id="plusMenu">
        <div class="pop-item" id="attachBtn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          <span>Attach files</span>
        </div>
        <div class="pop-item" id="sitrepBtn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="13" y2="16"/></svg>
          <span>Sitrep</span>
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
  function formatSavingLabel(you) {
    const spent = Number(you && you.spentUsd) || 0;
    if (spent <= 0) return { text: '—', mult: null, spilled: false };
    const spillX = Number(you && you.spilled && you.spilled.savingX);
    const sessionX = (Number(you && you.directUsd) || 0) / spent;
    const spilled = Number.isFinite(spillX) && spillX > 0;
    const mult = spilled ? spillX : sessionX;
    if (!Number.isFinite(mult)) return { text: '—', mult: null, spilled: false };
    const num = (mult >= 100 ? String(Math.round(mult)) : Number(mult).toFixed(mult >= 10 ? 1 : 2)) + 'x';
    return { text: num + (spilled ? ' spilled' : ' session'), mult, spilled };
  }
  const threadsEl = document.getElementById('threads');
  const chatHeader = document.getElementById('chatHeader');
  const log = document.getElementById('log');
  const inp = document.getElementById('inp');
  const send = document.getElementById('send');
  // WHERE OUR OWN API LIVES.
  //
  // This UI is served from TWO places: the box root (the RunPod proxy,
  // https://<pod>-8080.proxy.runpod.net/) and behind a path prefix on the site
  // (openzoo.fun/api/box/go/<pod>/). Every fetch here was root-absolute —
  // fetch(API + '/threads') — which is correct at the root and wrong behind a prefix,
  // where it resolves to openzoo.fun/threads and 404s. MEASURED in a clean
  // browser: the page loads, and the sidebar is empty forever.
  //
  // A <base href> does NOT fix this. base only affects RELATIVE urls; a leading
  // slash is root-absolute and ignores it entirely. So derive the prefix from
  // the path we were actually served under and put it in front of every call.
  // NO REGEX HERE. Backslash escapes inside the APP_HTML template literal are
  // consumed before the browser ever sees them, so /^\/api\// arrives as
  // /^/api// — "Invalid regular expression flags", and the whole script dies.
  // That is the same class of bug that shipped a dead UI in v1.5.22. Plain
  // string ops cannot be mangled that way.
  const API = location.pathname.startsWith('/api/box/go/')
    ? location.pathname.split('/').slice(0, 5).join('/')
    : '';
  let activeId = null;
  let knownThreads = [];
  let workspacePort = 0;

  // BOT PFPs. Same job as Grok Bot's agent faces: a round illustrated
  // creature, unique per name, idle-animated, no network. Hash is the same
  // 31-multiply used by colorFor, so a name always paints the same bot.
  // Built with string concat — template literals inside APP_HTML would be
  // interpolated by the outer backtick string before the browser sees them.
  let botPfpSeq = 0;
  function nameHash(name) {
    let h = 0;
    const s = String(name || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  }
  function botPalettes() {
    return [
      ['#ff6b9d', '#ffd0e0', '#c9184a'],
      ['#ffb347', '#ffe4b3', '#c27800'],
      ['#5eead4', '#ccfbf1', '#0f766e'],
      ['#b8f240', '#e6ffb3', '#4d7c0f'],
      ['#c084fc', '#edd4ff', '#7e22ce'],
      ['#60a5fa', '#dbeafe', '#1d4ed8'],
      ['#fb7185', '#ffe4e6', '#be123c'],
      ['#34d399', '#d1fae5', '#047857'],
      ['#fbbf24', '#fef3c7', '#b45309'],
      ['#a78bfa', '#ede9fe', '#6d28d9'],
      ['#38bdf8', '#e0f2fe', '#0369a1'],
      ['#f472b6', '#fce7f3', '#9d174d']
    ];
  }
  function botFaceInner(name) {
    const h = nameHash(name);
    const pal = botPalettes()[h % 12];
    const fur = pal[0], light = pal[1], line = pal[2];
    const ears = (h >>> 4) % 5;
    const eyes = (h >>> 8) % 5;
    const mouth = (h >>> 12) % 5;
    const extra = (h >>> 16) % 4;
    const gid = 'bfg' + (++botPfpSeq);
    let s = '<g class="bot-bob">';
    s += '<defs><radialGradient id="' + gid + '" cx="35%" cy="30%" r="75%">'
      + '<stop offset="0%" stop-color="' + light + '"/>'
      + '<stop offset="100%" stop-color="' + fur + '"/>'
      + '</radialGradient></defs>';
    if (ears === 0) {
      s += '<ellipse cx="16" cy="18" rx="9" ry="10" fill="' + fur + '"/>'
        + '<ellipse cx="48" cy="18" rx="9" ry="10" fill="' + fur + '"/>'
        + '<ellipse cx="16" cy="19" rx="4.5" ry="5.5" fill="' + light + '"/>'
        + '<ellipse cx="48" cy="19" rx="4.5" ry="5.5" fill="' + light + '"/>';
    } else if (ears === 1) {
      s += '<polygon points="10,28 17,6 29,22" fill="' + fur + '"/>'
        + '<polygon points="54,28 47,6 35,22" fill="' + fur + '"/>'
        + '<polygon points="14,26 18,11 26,22" fill="' + light + '"/>'
        + '<polygon points="50,26 46,11 38,22" fill="' + light + '"/>';
    } else if (ears === 2) {
      s += '<ellipse cx="11" cy="34" rx="8" ry="14" fill="' + fur + '" transform="rotate(-28 11 34)"/>'
        + '<ellipse cx="53" cy="34" rx="8" ry="14" fill="' + fur + '" transform="rotate(28 53 34)"/>'
        + '<ellipse cx="12" cy="34" rx="4" ry="8" fill="' + light + '" transform="rotate(-28 12 34)"/>'
        + '<ellipse cx="52" cy="34" rx="4" ry="8" fill="' + light + '" transform="rotate(28 52 34)"/>';
    } else if (ears === 3) {
      s += '<line x1="22" y1="20" x2="17" y2="6" stroke="' + line + '" stroke-width="2.2" stroke-linecap="round"/>'
        + '<line x1="42" y1="20" x2="47" y2="6" stroke="' + line + '" stroke-width="2.2" stroke-linecap="round"/>'
        + '<circle cx="16" cy="5" r="3.6" fill="' + light + '" stroke="' + line + '" stroke-width="1"/>'
        + '<circle cx="48" cy="5" r="3.6" fill="' + light + '" stroke="' + line + '" stroke-width="1"/>';
    } else {
      s += '<ellipse cx="22" cy="10" rx="6" ry="16" fill="' + fur + '"/>'
        + '<ellipse cx="42" cy="10" rx="6" ry="16" fill="' + fur + '"/>'
        + '<ellipse cx="22" cy="11" rx="2.6" ry="10" fill="' + light + '"/>'
        + '<ellipse cx="42" cy="11" rx="2.6" ry="10" fill="' + light + '"/>';
    }
    s += '<circle cx="32" cy="36" r="22" fill="url(#' + gid + ')" stroke="' + line + '" stroke-width="1.1"/>'
      + '<ellipse cx="24" cy="26" rx="8" ry="5" fill="#fff" opacity="0.28"/>';
    if (extra === 1 || extra === 2) {
      s += '<ellipse cx="20" cy="42" rx="5.5" ry="3.2" fill="#ff8fab" opacity="0.5"/>'
        + '<ellipse cx="44" cy="42" rx="5.5" ry="3.2" fill="#ff8fab" opacity="0.5"/>';
    }
    if (extra === 3) {
      s += '<circle cx="22" cy="40" r="1.1" fill="' + line + '" opacity="0.4"/>'
        + '<circle cx="26" cy="43" r="0.9" fill="' + line + '" opacity="0.35"/>'
        + '<circle cx="42" cy="40" r="1.1" fill="' + line + '" opacity="0.4"/>'
        + '<circle cx="38" cy="43" r="0.9" fill="' + line + '" opacity="0.35"/>';
    }
    s += '<g class="bot-eyes">';
    if (eyes === 0) {
      s += '<circle cx="24" cy="35" r="3.6" fill="#1a1220"/>'
        + '<circle cx="40" cy="35" r="3.6" fill="#1a1220"/>'
        + '<circle cx="25.2" cy="33.8" r="1.15" fill="#fff"/>'
        + '<circle cx="41.2" cy="33.8" r="1.15" fill="#fff"/>';
    } else if (eyes === 1) {
      s += '<ellipse cx="24" cy="35" rx="3.2" ry="4.6" fill="#1a1220"/>'
        + '<ellipse cx="40" cy="35" rx="3.2" ry="4.6" fill="#1a1220"/>'
        + '<circle cx="24.8" cy="33.2" r="1" fill="#fff"/>'
        + '<circle cx="40.8" cy="33.2" r="1" fill="#fff"/>';
    } else if (eyes === 2) {
      s += '<path d="M20 36 q4 -6 8 0" fill="none" stroke="#1a1220" stroke-width="2.2" stroke-linecap="round"/>'
        + '<path d="M36 36 q4 -6 8 0" fill="none" stroke="#1a1220" stroke-width="2.2" stroke-linecap="round"/>';
    } else if (eyes === 3) {
      s += '<circle cx="24" cy="35" r="4.4" fill="#1a1220"/>'
        + '<circle cx="40" cy="35" r="4.4" fill="#1a1220"/>'
        + '<circle cx="25.4" cy="33.4" r="1.5" fill="#fff"/>'
        + '<circle cx="41.4" cy="33.4" r="1.5" fill="#fff"/>'
        + '<circle cx="22.8" cy="36.4" r="0.7" fill="#fff" opacity="0.7"/>';
    } else {
      s += '<path d="M20 35 q4 5 8 0" fill="none" stroke="#1a1220" stroke-width="2.2" stroke-linecap="round"/>'
        + '<circle cx="40" cy="35" r="3.6" fill="#1a1220"/>'
        + '<circle cx="41.2" cy="33.8" r="1.15" fill="#fff"/>';
    }
    s += '</g>';
    if (mouth === 0) {
      s += '<path d="M26 46 q6 7 12 0" fill="none" stroke="#1a1220" stroke-width="2" stroke-linecap="round"/>';
    } else if (mouth === 1) {
      s += '<ellipse cx="32" cy="48" rx="5" ry="3.4" fill="#3a1a22"/>'
        + '<ellipse cx="32" cy="49.4" rx="3.2" ry="1.6" fill="#ff6b8a" opacity="0.85"/>';
    } else if (mouth === 2) {
      s += '<path d="M25 46 q4 6 6 0 q4 6 6 0" fill="none" stroke="#1a1220" stroke-width="2" stroke-linecap="round"/>';
    } else if (mouth === 3) {
      s += '<path d="M26 45 q6 6 12 0" fill="none" stroke="#1a1220" stroke-width="2" stroke-linecap="round"/>'
        + '<ellipse cx="34" cy="50.5" rx="3.1" ry="3.4" fill="#ff6b8a"/>';
    } else {
      s += '<circle cx="32" cy="47.5" r="1.7" fill="#1a1220"/>';
    }
    s += '</g>';
    return s;
  }
  function botPfp(name, members) {
    let names = (members && members.length > 1) ? members.slice(0, 3) : [name || 'Bot'];
    if (names.length === 1 && String(name || '').indexOf(', ') !== -1) {
      const parts = String(name).split(', ');
      const cleaned = [];
      for (let i = 0; i < parts.length && cleaned.length < 3; i++) {
        if (parts[i]) cleaned.push(parts[i]);
      }
      if (cleaned.length > 1) names = cleaned;
    }
    const delay = nameHash(names[0]);
    let inner = '';
    if (names.length === 1) inner = botFaceInner(names[0]);
    else if (names.length === 2) {
      inner = '<g transform="translate(-2,6) scale(0.7)">' + botFaceInner(names[0]) + '</g>'
        + '<g transform="translate(20,8) scale(0.7)">' + botFaceInner(names[1]) + '</g>';
    } else {
      inner = '<g transform="translate(-4,2) scale(0.58)">' + botFaceInner(names[0]) + '</g>'
        + '<g transform="translate(22,4) scale(0.58)">' + botFaceInner(names[1]) + '</g>'
        + '<g transform="translate(8,16) scale(0.62)">' + botFaceInner(names[2]) + '</g>';
    }
    return '<svg class="bot-pfp" viewBox="0 0 64 64" aria-hidden="true" style="--bot-delay:-'
      + ((delay % 20) / 8) + 's;--bot-blink:-' + (((delay >>> 3) % 30) / 10) + 's">'
      + inner + '</svg>';
  }

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
          searchHits = await (await fetch(API + '/search?q=' + encodeURIComponent(q))).json();
        } catch (e) { searchHits = []; }
        loadThreads();
      }, 180);
    });
    searchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { searchEl.value = ''; searchHits = null; loadThreads(); }
    });
  }

  async function loadThreads() {
    const list = await (await fetch(API + '/threads')).json();
    // When a search is active, show ONLY matches, ordered by hit count, and
    // replace the preview with the matching line — the point of a search is
    // seeing WHY something matched, not just that it did.
    const hitById = searchHits ? new Map(searchHits.map((h) => [h.id, h])) : null;
    knownThreads = list;
    if (list[0] && list[0].workspacePort) workspacePort = Number(list[0].workspacePort) || workspacePort;
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
          '<span class="pcount">' + n + '</span>';
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
      row.innerHTML = '<div class="tavatar">' + botPfp(t.name, t.members) + '</div>' +
        '<div class="tmeta"><div class="tname">' + t.name + '</div><div class="tprev">' +
        (hitById && hitById.get(t.id) && hitById.get(t.id).snippet
            ? hitById.get(t.id).snippet
            : t.awaitingUser ? 'waiting for you' : t.status === 'thinking' ? escapeHtml(t.liveStatus || 'typing…') : (t.preview || '')) + '</div></div>' +
          // awaitingUser WINS over thinking: a thread blocked on an approval is
          // NOT working, and showing a working indicator there is a lie that
          // quietly costs you a subagent nobody knows is stuck.
          (t.awaitingUser ? '<div class="twarn" title="Waiting for your approval"></div>'
            : t.status === 'thinking' ? '<div class="tdot"></div>' : '') +
        // PING ALL BELONGS TO WHOEVER HAS A CREW. It used to sit only on the
        // project header, so a mid-level owner could not reach its own
        // subagents without retyping — and pressing it addressed the WHOLE
        // project, cousins included. Now every thread with descendants gets
        // one, scoped to its own branch.
        (t.kids ? '<button class="pingall trow-ping" data-testid="ping-all" title="Wake all '
          + t.kids + ' bot(s) below ' + escapeHtml(t.name) + '">\u21f2 ' + t.kids + '</button>' : '') +
        '<button class="tclose" title="Remove">✕</button>';
      row.addEventListener('click', () => {
        activeId = t.id;
        render();
        // Selecting a bot means you intend to talk to it. Landing focus in the
        // composer saves a second click every single time, and on mobile it is
        // what raises the keyboard at all.
        requestAnimationFrame(() => { try { inp.focus(); } catch (e) {} });
      });
      const pingBtn = row.querySelector('.trow-ping');
      if (pingBtn) {
        pingBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          // Default click = wake with the harness continue. window.prompt is
          // missing or blocked in Electron, so a modal here silently no-op'd
          // the only UI path that tried to reach the crew. /all still sends
          // exact text; ping is "poke them to work".
          pingBtn.disabled = true;
          const was = pingBtn.textContent;
          pingBtn.textContent = '…';
          try {
            await fetch(API + '/drive', { method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ threadId: t.id, task: '/ping' }) });
            pingBtn.textContent = 'pinged';
          } catch (err) { pingBtn.textContent = 'failed'; }
          setTimeout(() => { pingBtn.disabled = false; pingBtn.textContent = was; }, 1500);
          await loadThreads();
        });
      }
      row.querySelector('.tclose').addEventListener('click', async (e) => {
        e.stopPropagation();
        await fetch(API + '/threads/' + t.id, { method: 'DELETE' });
        if (activeId === t.id) activeId = null;
        await loadThreads();
        if (activeId) render();
      });
      threadsEl.appendChild(row);
    }
  }

  async function loadActiveMessages() {
    if (!activeId) return null;
    const data = await (await fetch(API + '/threads/' + activeId)).json();
    if (data && data.workspacePort) workspacePort = Number(data.workspacePort) || workspacePort;
    return data;
  }

  function renderHeader(t) {
    document.getElementById('chatHeaderId').innerHTML =
      '<div class="tavatar">' + botPfp(t.name, t.members) + '</div>' +
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
    tierSel.value = t.tier || 'auto';
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
      if (t.tier === 'expensive' || t.tier === 'grok4.6') tierSel.className = 'dial hot';
      if ((t.race || 0) >= 2) raceSel.className = 'dial hot';
    }
  }

  // Header dials and Pay / ◎ all go through /drive so handleSlash (or the
  // /mode handler) appends the same short bot line as typing the command.
  async function echoSlash(task) {
    if (!activeId) return;
    await fetch(API + '/drive', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: activeId, task: task }) });
    await loadThreads();
    await render();
  }
  async function setDial(cmd, value) {
    await echoSlash('/' + cmd + ' ' + value);
  }
  // WALLET MODAL.
  //
  // Public addresses and balances only — /wallet proxies the proxy's own
  // endpoint, which never exposes a key. Nothing here can move funds, and it
  // must stay that way: this UI is served on a box reachable from a public
  // *.proxy.runpod.net URL.
  const walletOverlay = document.getElementById('walletOverlay');
  const walletBody = document.getElementById('walletBody');
  function walletRow(label, addr) {
    const row = document.createElement('div');
    row.className = 'wrow';
    row.title = 'Click to copy';
    const l = document.createElement('div'); l.className = 'wlab'; l.textContent = label;
    const a = document.createElement('div'); a.className = 'waddr'; a.textContent = addr;
    const c = document.createElement('div'); c.className = 'wcopy'; c.textContent = 'copy';
    row.append(l, a, c);
    // The whole row, not a 20px target. Copying a deposit address by hand is
    // how funds go to the wrong chain.
    row.addEventListener('click', async () => {
      const ok = await copyText(addr);
      c.textContent = ok ? 'copied' : 'select it';
      setTimeout(() => { c.textContent = 'copy'; }, 1400);
    });
    return row;
  }
  function isEmptyWalletPayment(text) {
    // String ops. A word-boundary regex inside APP_HTML is eaten: \b
    // becomes a literal backspace and the client never matches a real 402.
    const s = String(text || '').toLowerCase();
    return s.includes('wallet is empty')
      || s.includes('empty wallet')
      || s.includes('wallet underfunded')
      || s.includes('underfunded');
  }
  var openedPayForEmpty = false;
  function maybeOpenPayForEmptyWallet(text) {
    if (openedPayForEmpty || !isEmptyWalletPayment(text)) return;
    openedPayForEmpty = true;
    openWallet();
  }
  async function openWallet() {
    walletOverlay.classList.add('show');
    walletBody.textContent = 'loading…';
    let w = null;
    try {
      const r = await fetch(API + '/wallet');
      // fetch does NOT reject on 4xx/5xx, and an older proxy returns an error
      // body that parses fine into undefined fields — check ok AND the fields.
      w = r.ok ? await r.json() : null;
    } catch (e) { w = null; }
    walletBody.innerHTML = '';
    if (!w || (!w.solana && !w.evm && w.creditUsd == null)) {
      const p = document.createElement('div');
      p.className = 'wnote wempty';
      p.textContent = 'Could not reach the local openzoo proxy on :8402. It may still be starting — try again in a few seconds. You can still subscribe with a card above.';
      walletBody.appendChild(p);
      return;
    }
    if (w.creditUsd != null && w.creditUsd !== '') {
      const c = document.createElement('div');
      c.className = 'wbal';
      c.style.color = '#b8f240';
      c.style.fontSize = '18px';
      c.style.fontWeight = '700';
      c.textContent = 'Prepaid credit  $' + (Number(w.creditUsd) || 0).toFixed(2);
      walletBody.appendChild(c);
    }
    if (w.solana) walletBody.appendChild(walletRow('Solana', w.solana));
    if (w.evm) walletBody.appendChild(walletRow('Base / RH', w.evm));
    if (Array.isArray(w.holdings) && w.holdings.length) {
      const b = document.createElement('div');
      b.className = 'wbal';
      b.textContent = w.holdings.filter((h) => h.chain === 'solana' || Number(h.ui) > 0).map((h) => {
        const qty = (h.ui) + ' ' + h.symbol + (h.chain && h.chain !== 'solana' ? ' (' + h.chain + ')' : '');
        if (h.usd == null || !isFinite(Number(h.usd))) return qty;
        const n = Number(h.usd);
        return qty + '  ($' + (n >= 0.01 || n === 0 ? n.toFixed(2) : n.toFixed(4)) + ')';
      }).join('\\n');
      walletBody.appendChild(b);
    } else if (w.balances) {
      const b = document.createElement('div');
      b.className = 'wbal';
      b.textContent = w.balances;
      walletBody.appendChild(b);
    }
    const note = document.createElement('div');
    note.className = 'wnote';
    // funded === false is the genuinely-empty case. Undefined means the proxy
    // did not say, and guessing "empty" there would send someone to top up a
    // wallet that is fine. A live subscription is the other pay lane — do not
    // nag an empty wallet as fatal when calls already skip x402.
    note.textContent = w.funded === false
      ? ('This wallet is EMPTY — wallet/x402 calls will fail with HTTP 402 until you fund the addresses above. ' + (w.funding || ''))
      : (w.funding || '');
    if (w.funded === false) note.classList.add('wempty');
    if (note.textContent.trim()) walletBody.appendChild(note);
  }
  function openSystemBrowser(url) {
    // Electron's setWindowOpenHandler routes target=_blank to shell.openExternal.
    // Never load Stripe inside this window.
    window.open(url, '_blank', 'noopener,noreferrer');
  }
  document.getElementById('walletBtn').addEventListener('click', () => {
    echoSlash('/pay');
    openWallet();
  });
  // First launch: if the burner is empty AND there is no subscription, open
  // the pay modal once so they see card plans first — and burner addresses
  // below. localStorage so a funded session, a saved key, or a dismiss does
  // not keep popping it.
  (async function maybeOpenWalletOnce() {
    return; // auto-open gate removed — wallet drawer is opt-in (header Pay / /pay)
    if (localStorage.getItem('openzoo.wallet.seen')) return;
    for (let i = 0; i < 8; i++) {
      try {
        const r = await fetch(API + '/wallet');
        const w = r.ok ? await r.json() : null;
        if (!w || (!w.solana && !w.evm && !(w.subscription && w.subscription.active))) {
          await new Promise((res) => setTimeout(res, 400));
          continue;
        }
        localStorage.setItem('openzoo.wallet.seen', '1');
        if (w.funded === false && !(w.subscription && w.subscription.active)) await openWallet();
        return;
      } catch (e) {
        await new Promise((res) => setTimeout(res, 400));
      }
    }
  })();
  // Click-outside and Escape both close it — a modal you can only dismiss one
  // way is a modal people get stuck in.
  walletOverlay.addEventListener('click', (e) => {
    if (e.target === walletOverlay) walletOverlay.classList.remove('show');
  });
  const sitrepOverlay = document.getElementById('sitrepOverlay');
  const sitrepBody = document.getElementById('sitrepBody');
  function raceCutPct(y) {
    const n = Math.max(1, Number(y) || 1);
    return Math.round((1 - 1 / n) * 100);
  }
  function raceChoiceLabel(y, need) {
    const n = Math.max(1, Number(y) || 1);
    const k = Math.max(1, Math.min(Number(need) || 1, n));
    const cut = raceCutPct(n);
    const cutTxt = cut === 0 ? '0%' : ('−' + cut + '%');
    if (n < 2) return '1 model  ' + cutTxt;
    if (k > 1) return 'best ' + k + ' of ' + n + '  ' + cutTxt;
    return 'race ' + n + '  ' + cutTxt;
  }
  function sitrepRow(lab, val, cls) {
    return '<div class="srow"><span class="slab">' + escapeHtml(lab) + '</span><span class="sval'
      + (cls ? (' ' + cls) : '') + '">' + escapeHtml(val) + '</span></div>';
  }
  async function openSitrep() {
    sitrepOverlay.classList.add('show');
    sitrepBody.textContent = 'loading…';
    const t = knownThreads.find((x) => x.id === activeId) || {};
    let full = null;
    try { if (activeId) full = await (await fetch(API + '/threads/' + activeId)).json(); } catch (e) { full = null; }
    let you = {};
    try { you = await (await fetch(API + '/hud-summary')).json(); } catch (e) { you = {}; }
    const y = Number(t.race) || 0;
    const need = Number(t.raceNeed) || 1;
    const raceY = y >= 2 ? y : 1;
    const spent = Number(you.spentUsd) || 0;
    const cogs = Number(you.cogsUsd) || 0;
    const direct = Number(you.directUsd) || 0;
    const sav = formatSavingLabel(you);
    const saved = sav.text;
    const savedCls = sav.mult == null ? '' : (sav.mult >= 1 ? 'hlime' : 'hember');
    const thinking = (full && full.status === 'thinking') || t.status === 'thinking';
    const race = (full && full.liveRace) || null;
    let flight = 'idle';
    if (thinking && race && race.phase === 'judging') flight = 'classifier judging';
    else if (thinking && race && race.phase === 'winner') flight = 'winner';
    else if (thinking && (full && full.liveStatus)) flight = full.liveStatus;
    else if (thinking && t.liveStatus) flight = t.liveStatus;
    else if (thinking) flight = 'in flight';
    const cwd = (full && full.dir) || t.dir || '—';
    sitrepBody.innerHTML =
      sitrepRow('race', raceChoiceLabel(raceY, need))
      + sitrepRow('band', t.tier || 'medium')
      + sitrepRow('mode', t.runMode || 'ask')
      + sitrepRow('cwd', cwd)
      + sitrepRow('in flight', flight)
      + '<div class="wlanetitle" style="margin-top:16px">this session</div>'
      + sitrepRow('paid', '$' + (spent >= 0.01 || spent === 0 ? spent.toFixed(2) : spent.toFixed(5)))
      + sitrepRow('cogs', '$' + (cogs >= 0.01 || cogs === 0 ? cogs.toFixed(2) : cogs.toFixed(5)))
      + sitrepRow('direct', '$' + (direct >= 0.01 || direct === 0 ? direct.toFixed(2) : direct.toFixed(5)))
      + sitrepRow('saved vs naked', saved, savedCls)
      + sitrepRow('paid calls', String(you.paidCalls || 0))
      + sitrepRow('prepaid', (Number(you.creditUsd) > 0) ? 'yes' : 'no');
  }
  function closeSitrep() { sitrepOverlay.classList.remove('show'); }
  sitrepOverlay.addEventListener('click', (e) => {
    if (e.target === sitrepOverlay) closeSitrep();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && walletOverlay.classList.contains('show')) walletOverlay.classList.remove('show');
    if (e.key === 'Escape' && sitrepOverlay.classList.contains('show')) closeSitrep();
  });

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
    await echoSlash('/mode ' + mode);
  }
  document.getElementById('modeAsk').addEventListener('click', () => setMode('ask'));
  document.getElementById('modeAuto').addEventListener('click', () => setMode('auto'));

  function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  function splitThinkTags(s) {
    s = String(s == null ? '' : s);
    var bits = [];
    s = s.replace(/<think(?:ing)?\\b[^>]*>[\\s\\S]*?<\\/think(?:ing)?>/gi, function (m) {
      var a = m.indexOf('>');
      var b = m.toLowerCase().lastIndexOf('</think');
      if (a >= 0 && b > a) bits.push(m.slice(a + 1, b));
      return '';
    });
    s = s.replace(/<think(?:ing)?\\b[^>]*>[\\s\\S]*$/i, function (m) {
      var a = m.indexOf('>');
      bits.push(a >= 0 ? m.slice(a + 1) : '');
      return '';
    });
    s = s.replace(/<\\/think(?:ing)?>/gi, '');
    return {
      visible: s.replace(/^\\n+|\\n+$/g, '').trim(),
      thinking: bits.join('\\n').replace(/^\\n+|\\n+$/g, '').trim()
    };
  }
  function stripThinkTags(s) { return splitThinkTags(s).visible; }
  function clientWorkspaceUrl(rel) {
    if (!workspacePort || !activeId) return '';
    rel = String(rel || '').replace(/^\\/+/, '');
    return 'http://localhost:' + workspacePort + '/' + activeId + '/' + rel;
  }
  function relFromDiskPath(p) {
    p = String(p || '');
    if (p.indexOf('file://') === 0) p = decodeURIComponent(p.slice(7));
    const t = knownThreads.find(function (x) { return x.id === activeId; });
    const dir = (t && t.dir) || '';
    if (dir && (p === dir || p.indexOf(dir + '/') === 0)) {
      return p.slice(dir.length).replace(/^\\/+/, '');
    }
    const marker = '/grokui-workspace/';
    const i = p.indexOf(marker);
    if (i >= 0) return p.slice(i + marker.length);
    const base = p.split('/').pop() || '';
    return /\\.(html?|HTML?)$/.test(base) ? base : '';
  }
  function servedHrefForPath(p) {
    p = String(p || '');
    const t = knownThreads.find(function (x) { return x.id === activeId; });
    const dir = (t && t.dir) || '';
    if (dir && p === dir) return clientWorkspaceUrl('');
    if (/\\.(html?|HTML?)$/.test(p) || p.indexOf('grokui-workspace') >= 0 || (dir && p.indexOf(dir) === 0)) {
      return clientWorkspaceUrl(relFromDiskPath(p));
    }
    return '';
  }
  // Turn "Wrote foo.html" and /Users/.../foo.html into the live localhost URL
  // the workspace server already exposes — never a file:// Electron blocks.
  function linkWorkspacePaths(o) {
    o = o.replace(/\\b(Wrote|Edited)\\s+([^\\n<]+?)\\s+\\(/g, function (m, verb, file) {
      const f = file.trim();
      if (!/\\.(html?|HTML?)$/.test(f)) return m;
      const url = clientWorkspaceUrl(f);
      if (!url) return m;
      return verb + ' <a href="' + url + '" target="_blank" rel="noopener">' + f + '</a> (';
    });
    o = o.replace(/\\b(MULTIEDIT)\\s+([^\\s:<]+\\.(?:html?|HTML?))/g, function (m, verb, file) {
      const url = clientWorkspaceUrl(file);
      if (!url) return m;
      return verb + ' <a href="' + url + '" target="_blank" rel="noopener">' + file + '</a>';
    });
    o = o.replace(/file:\\/\\/([^\\s<)]+)/g, function (m, raw) {
      return servedHrefForPath(decodeURIComponent(raw)) || m;
    });
    o = o.replace(/(^|[\\s(])((?:\\/Users\\/|\\/home\\/|\\/opt\\/|\\/workspace\\/|\\/tmp\\/|\\/var\\/|~\\/)[^\\s<)]+)/g, function (m, pre, raw) {
      const punct = /[.,;:]+$/.exec(raw);
      const p = punct ? raw.slice(0, -punct[0].length) : raw;
      const href = servedHrefForPath(p);
      if (!href) return m;
      return pre + '<a href="' + href + '" target="_blank" rel="noopener">' + p + '</a>' + (punct ? punct[0] : '');
    });
    return o;
  }
  function htmlPreviewUrl(text) {
    const s = String(text || '');
    let m = /https?:\\/\\/localhost:\\d+\\/\\S+\\.(?:html?|HTML?)/.exec(s);
    if (m) return m[0].replace(/[.,;)]+$/, '');
    m = /(?:Preview:|Serving at)\\s+(https?:\\/\\/localhost:\\d+\\/\\S+)/.exec(s);
    if (m) {
      const u = m[1].replace(/[.,;)]+$/, '');
      if (/\\.(html?|HTML?)/.test(u) || /\\/[0-9a-fA-F-]{36}\\/?$/.test(u)) return u;
    }
    m = /\\b(?:Wrote|Edited|MULTIEDIT)\\s+([^\\n]+?)\\s*(?:\\(|:)/.exec(s);
    if (m && /\\.(html?|HTML?)$/.test(m[1].trim())) return clientWorkspaceUrl(m[1].trim());
    m = /(?:\\/Users\\/|\\/home\\/|\\/workspace\\/)\\S+\\.(?:html?|HTML?)/.exec(s);
    if (m) return servedHrefForPath(m[0].replace(/[.,;)]+$/, '')) || '';
    return '';
  }
  function htmlPreviewKey(text, url) {
    const bytes = /\\((\\d+)\\s+bytes/.exec(text) || /->\\s+(\\d+)\\s+bytes/.exec(text);
    return url + '#' + (bytes ? bytes[1] : '0');
  }
  let parkedPreviews = {};
  function parkPreviews() {
    const parked = {};
    const nodes = log.querySelectorAll('.html-preview-wrap');
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const k = el.getAttribute('data-preview');
      if (k) parked[k] = el;
      el.remove();
    }
    return parked;
  }
  function previewFrame(url, key) {
    const existing = parkedPreviews[key];
    if (existing) { delete parkedPreviews[key]; return existing; }
    const wrap = document.createElement('div');
    wrap.className = 'html-preview-wrap';
    wrap.setAttribute('data-preview', key);
    const open = document.createElement('a');
    open.className = 'html-preview-open';
    open.href = url;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = 'open';
    const frame = document.createElement('iframe');
    frame.className = 'html-preview';
    frame.src = url;
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-pointer-lock allow-forms');
    frame.title = 'preview';
    wrap.appendChild(open);
    wrap.appendChild(frame);
    return wrap;
  }
  // Inline span-level markdown. Runs AFTER escapeHtml, so every tag below is
  // one we created — model output can never inject its own.
  function mdInline(s) {
    let o = escapeHtml(s);
    o = o.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    o = o.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    o = o.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, '$1<em>$2</em>');
    o = o.replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    o = linkWorkspacePaths(o);
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
    const value = String(text ?? '');
    try {
      if (window.electronAPI && typeof window.electronAPI.copyText === 'function') {
        const ok = await window.electronAPI.copyText(value);
        if (ok) return true;
      }
    } catch (e) { /* fall through */ }
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (e) { /* fall through to the legacy path */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
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

  /* SELECT → CLIPBOARD. A finished selection copies itself. No ⌘C, no hunting
     for a 10px button. Empty click / caret-only is a no-op so we do not spam
     "copied". The highlight stays put: copy must not steal focus or collapse
     the range. */
  function selectedText() {
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      if (el.type === 'password') return '';
      const a = el.selectionStart;
      const b = el.selectionEnd;
      if (typeof a === 'number' && typeof b === 'number' && b > a) {
        return String(el.value || '').slice(a, b);
      }
      return '';
    }
    const sel = window.getSelection();
    return sel ? sel.toString() : '';
  }
  function selectedRect() {
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.type !== 'password') {
      const a = el.selectionStart;
      const b = el.selectionEnd;
      if (typeof a === 'number' && typeof b === 'number' && b > a) return el.getBoundingClientRect();
    }
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0)) return null;
    return r;
  }
  function snapshotSelection() {
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      return { kind: 'field', el: el, start: el.selectionStart, end: el.selectionEnd };
    }
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return { kind: 'none' };
    const ranges = [];
    for (let i = 0; i < sel.rangeCount; i++) ranges.push(sel.getRangeAt(i).cloneRange());
    return { kind: 'dom', ranges: ranges };
  }
  function restoreSelection(snap) {
    if (!snap) return;
    if (snap.kind === 'field' && snap.el && document.contains(snap.el)) {
      try {
        snap.el.focus({ preventScroll: true });
        snap.el.setSelectionRange(snap.start, snap.end);
      } catch (e) {}
      return;
    }
    if (snap.kind === 'dom') {
      const sel = window.getSelection();
      sel.removeAllRanges();
      for (let i = 0; i < snap.ranges.length; i++) {
        try { sel.addRange(snap.ranges[i]); } catch (e) {}
      }
    }
  }
  let copiedToastTimer = 0;
  function showCopiedToast(rect) {
    const el = document.getElementById('copiedToast');
    if (!el) return;
    let x = window.innerWidth / 2;
    let y = 40;
    if (rect && (rect.width || rect.height)) {
      x = rect.left + rect.width / 2;
      y = rect.top - 38;
      if (y < 8) y = rect.bottom + 10;
    }
    if (x < 48) x = 48;
    if (x > window.innerWidth - 48) x = window.innerWidth - 48;
    if (y < 8) y = 8;
    if (y > window.innerHeight - 36) y = window.innerHeight - 36;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.classList.add('show');
    clearTimeout(copiedToastTimer);
    copiedToastTimer = setTimeout(function () { el.classList.remove('show'); }, 1200);
  }
  let selectPointerDown = false;
  let selectShiftHeld = false;
  let selectCopying = false;
  let selectTimer = 0;
  let selectLastText = '';
  let selectLastAt = 0;
  async function copySettledSelection() {
    if (selectCopying) return;
    const text = selectedText();
    if (!text) return;
    const now = Date.now();
    if (text === selectLastText && (now - selectLastAt) < 500) return;
    selectLastText = text;
    selectLastAt = now;
    const rect = selectedRect();
    const snap = snapshotSelection();
    selectCopying = true;
    let ok = false;
    try { ok = await copyText(text); }
    finally { restoreSelection(snap); selectCopying = false; }
    if (ok) showCopiedToast(rect);
  }
  function scheduleCopySelection() {
    if (selectPointerDown || selectCopying) return;
    clearTimeout(selectTimer);
    selectTimer = setTimeout(copySettledSelection, 40);
  }
  document.addEventListener('pointerdown', function (e) {
    if (e.button !== undefined && e.button !== 0) return;
    selectPointerDown = true;
  });
  document.addEventListener('pointerup', function (e) {
    if (e.button !== undefined && e.button !== 0) return;
    selectPointerDown = false;
    scheduleCopySelection();
  });
  document.addEventListener('pointercancel', function () { selectPointerDown = false; });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Shift') selectShiftHeld = true;
  });
  document.addEventListener('keyup', function (e) {
    if (e.key === 'Shift') selectShiftHeld = false;
    const withMod = e.metaKey || e.ctrlKey;
    const selectish = e.key === 'Shift'
      || e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown'
      || e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' || e.key === 'PageDown'
      || ((e.key === 'a' || e.key === 'A') && withMod);
    if (selectish) scheduleCopySelection();
  });
  document.addEventListener('selectionchange', function () {
    if (selectPointerDown || selectCopying || selectShiftHeld) return;
    scheduleCopySelection();
  });

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
  let liveThinkOpen = false;
  function thinkLabel(live) { return live ? 'thinking...' : 'thought'; }
  function makeThinkFold(text, live, open) {
    const fold = document.createElement('div');
    fold.className = 'thinkfold' + (open ? ' open' : '');
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'thinkchip';
    chip.textContent = thinkLabel(live);
    chip.setAttribute('aria-expanded', open ? 'true' : 'false');
    const body = document.createElement('div');
    body.className = 'thinkbody';
    if (open) body.textContent = text;
    chip.addEventListener('click', function (e) {
      e.preventDefault();
      const next = !fold.classList.contains('open');
      fold.classList.toggle('open', next);
      chip.setAttribute('aria-expanded', next ? 'true' : 'false');
      if (live) liveThinkOpen = next;
      if (next) body.textContent = fold.getAttribute('data-think') || text || '';
      else body.textContent = '';
      if (live) paintStream();
    });
    fold.setAttribute('data-think', text || '');
    fold.appendChild(chip);
    fold.appendChild(body);
    return fold;
  }
  function runFoldLabel(status) {
    if (status === 'pending') return 'run';
    if (status === 'running') return 'running...';
    if (status === 'denied') return 'denied';
    return 'ran';
  }
  function parseLegacyRun(text) {
    const raw = String(text || '');
    if (!raw.startsWith('$ ')) return null;
    const nl = raw.indexOf('\\n');
    if (nl < 0) return { command: raw.slice(2), output: '', status: 'done' };
    return { command: raw.slice(2, nl), output: raw.slice(nl + 1), status: 'done' };
  }
  function makeRunFold(command, output, status) {
    const pending = status === 'pending' || status === 'running';
    const fold = document.createElement('div');
    fold.className = 'runfold' + (pending ? ' open' : '');
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'runchip';
    chip.textContent = runFoldLabel(status);
    chip.setAttribute('aria-expanded', pending ? 'true' : 'false');
    const body = document.createElement('div');
    body.className = 'runbody';
    function fillBody() {
      body.innerHTML = '';
      const cmdEl = document.createElement('div');
      cmdEl.className = 'runcmd';
      cmdEl.textContent = '$ ' + command;
      cmdEl.appendChild(copyBtn(() => command, 'copy'));
      body.appendChild(cmdEl);
      if (status && status !== 'pending') {
        const st = document.createElement('div');
        st.className = 'runstatus';
        st.textContent = status === 'running' ? 'Running…' : status === 'denied' ? 'Denied' : 'Done';
        body.appendChild(st);
      }
      if (output) {
        const out = document.createElement('pre');
        out.className = 'runoutput';
        out.textContent = output;
        out.appendChild(copyBtn(() => output, 'copy'));
        body.appendChild(out);
      }
    }
    if (pending) fillBody();
    chip.addEventListener('click', function (e) {
      e.preventDefault();
      const next = !fold.classList.contains('open');
      fold.classList.toggle('open', next);
      chip.setAttribute('aria-expanded', next ? 'true' : 'false');
      if (next) fillBody();
      else body.innerHTML = '';
    });
    fold.appendChild(chip);
    fold.appendChild(body);
    return fold;
  }
  function addRow(who, text, color, name, run, images, thinking, live) {
    if (who === 'bot') {
      const parts = splitThinkTags(text);
      text = parts.visible;
      if (!thinking) thinking = parts.thinking;
    }
    const speakerKey = who + '|' + name;
    if (who === 'bot' && speakerKey !== lastSpeaker) {
      const hdr = document.createElement('div');
      hdr.className = 'hdr';
      hdr.innerHTML = '<span class="avatar">' + botPfp(name) + '</span><span>' + name + '</span>';
      log.appendChild(hdr);
    }
    lastSpeaker = speakerKey;
    const row = document.createElement('div');
    row.className = 'row ' + who;
    const col = document.createElement('div');
    col.className = 'msgcol';
    const thinkText = (who === 'bot' && thinking) ? String(thinking).trim() : '';
    if (live) {
      const fold = makeThinkFold(thinkText, true, liveThinkOpen && !!thinkText);
      fold.id = 'streamThink';
      if (!thinkText) fold.hidden = true;
      col.appendChild(fold);
    } else if (thinkText) {
      col.appendChild(makeThinkFold(thinkText, false, false));
    }
    if (run) {
      const cmd = run.command || text;
      const st = run.status || 'pending';
      const pending = st === 'pending' || st === 'running';
      const card = document.createElement('div');
      card.className = 'runcard' + (pending ? ' pending' : ' folded');
      card.appendChild(makeRunFold(cmd, run.output || '', st));
      if (run.id && st === 'pending') {
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
          await fetch(API + '/threads/' + activeId + '/run/' + run.id + '/approve', { method: 'POST' });
          render();
        });
        deny.addEventListener('click', async () => {
          approve.disabled = true; deny.disabled = true;
          await fetch(API + '/threads/' + activeId + '/run/' + run.id + '/deny', { method: 'POST' });
          render();
        });
        actions.appendChild(approve);
        actions.appendChild(deny);
        card.appendChild(actions);
      }
      col.appendChild(card);
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
      if (who === 'bot') {
        const preview = htmlPreviewUrl(text);
        if (preview) textEl.appendChild(previewFrame(preview, htmlPreviewKey(text, preview)));
      }
      if (who === 'bot' && isEmptyWalletPayment(text)) {
        const pay = document.createElement('button');
        pay.type = 'button';
        pay.className = 'payneed-btn';
        pay.textContent = 'payment required';
        pay.addEventListener('click', function (e) { e.preventDefault(); openWallet(); });
        textEl.appendChild(pay);
        maybeOpenPayForEmptyWallet(text);
      }
      bubble.appendChild(textEl);
      col.appendChild(bubble);
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
    row.appendChild(col);
    log.appendChild(row);
  }

  let lastRenderKey = '';
  async function render() {
    const t = knownThreads.find((x) => x.id === activeId);
    if (!t) return;
    renderHeader(t);
    inp.placeholder = 'Message ' + t.name;
    const full = await loadActiveMessages();
    if (!full || full.id !== activeId) return;
    const renderKey = String(workspacePort) + '|' + full.id + '|' + full.status + '|' + (full.history || []).map(function (h) {
      return [h.who, h.text, h.thinking, h.runStatus, h.runOutput, (h.images || []).join(',')].join('|#');
    }).join('||');
    if (renderKey === lastRenderKey) {
      if (streamBuf || streamThink) paintStream();
      return;
    }
    lastRenderKey = renderKey;
    // only re-pin to bottom if the reader was already there — otherwise a
    // background poll (tick() runs every 1.2s) yanks them back mid-scroll
    const wasNearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    parkedPreviews = parkPreviews();
    log.innerHTML = '';
    lastSpeaker = null;
    for (const h of full.history) {
      let run;
      if (h.runId || h.runStatus) {
        run = { id: h.runId, status: h.runStatus, output: h.runOutput, command: h.text };
      } else if (h.who === 'bot') {
        const legacy = parseLegacyRun(h.text);
        if (legacy) run = { status: legacy.status, output: legacy.output, command: legacy.command };
      }
      addRow(h.who, h.text, h.color || t.color, h.name || t.name, run, h.images, h.thinking);
    }
    if (full.status === 'thinking') {
      if (full.liveStatus) streamStatus = full.liveStatus;
      if (full.liveRace && full.liveRace.racers && full.liveRace.racers.length >= 2) {
        streamRace = full.liveRace;
        streamRaceId = full.id;
      } else if (streamRaceId !== full.id) {
        streamRace = null;
      }
      addRow('bot', streamBuf || '…', t.color, t.name, undefined, undefined, streamThink, true);
      // Tag the live bubble so deltas can repaint just this node instead of
      // re-rendering (and re-fetching) the whole thread on every token.
      const b = log.querySelector('.row:last-child .bubble');
      if (b) { b.id = 'streamBubble'; paintStream(); }
    }
    if (wasNearBottom) log.scrollTop = log.scrollHeight;
    if (findBarOpen()) applyFind(true);
  }

  // --- live token stream ---------------------------------------------------
  // The server has always been able to stream; /drive just never asked for it,
  // so a turn showed "…" for its whole duration and then arrived in one lump.
  let streamBuf = '';
  let streamThink = '';
  let streamStatus = '';
  let streamRace = null;
  let streamRaceId = '';
  let raceHandoff = 0;
  let es = null, esId = null;
  function raceIsLive(r) {
    return !!(r && r.racers && r.racers.length >= 2 && streamRaceId === activeId);
  }
  function shortRaceName(id) {
    const s = String(id || '');
    const i = s.lastIndexOf('/');
    return (i >= 0 ? s.slice(i + 1) : s) || 'model';
  }
  function raceGridHtml(race) {
    const racers = race.racers || [];
    const n = racers.length;
    const need = Math.max(1, Number(race.need) || 1);
    const caption = (need > 1 ? ('first ' + need + ' of ' + n) : (n + ' launched'))
      + (race.recut ? ' · recut' : '');
    let cells = '';
    for (let i = 0; i < racers.length; i++) {
      const r = racers[i];
      const win = race.phase === 'winner' && race.winner && r.model === race.winner;
      const cls = 'racecell ' + (r.status || 'waiting') + (win ? ' winner' : '');
      const chip = win ? 'winner' : (r.status || 'waiting');
      let body = '';
      if (r.status === 'failed') {
        body = '<span class="racefail">' + escapeHtml(r.fail ? ('fail · ' + r.fail) : 'fail') + '</span>';
      } else if (r.preview) {
        body = '<div class="raceprev">' + escapeHtml(r.preview) + '</div>';
      } else if (r.status === 'abandoned') {
        body = '<div class="raceprev">abandoned</div>';
      } else {
        body = '<div class="raceprev"></div>';
      }
      cells += '<div class="' + cls + '"><div class="racehead"><span class="racename">'
        + escapeHtml(r.short || shortRaceName(r.model)) + '</span><span class="racechip">'
        + escapeHtml(chip) + '</span></div>' + body + '</div>';
    }
    let judge = '';
    if (need > 1 && (race.phase === 'judging' || race.phase === 'winner')) {
      const won = race.phase === 'winner' && race.winner;
      const msg = won
        ? ('goes to ' + shortRaceName(race.winner))
        : ('looking at the ' + need + ' that made it back');
      judge = '<div class="racejudge' + (won ? ' won' : '') + '"><div class="racejudge-lab">classifier</div>'
        + '<div class="racejudge-msg">' + escapeHtml(msg)
        + (won ? '' : ' <span class="dots"><span></span><span></span><span></span></span>')
        + '</div></div>';
    }
    return '<div class="racewrap"><div class="racecaption">' + escapeHtml(caption) + '</div>'
      + '<div class="racegrid n' + n + '">' + cells + '</div>' + judge + '</div>';
  }
  function streamParts() {
    const parts = splitThinkTags(streamBuf);
    var think = streamThink;
    if (parts.thinking) think = think ? (think + '\\n' + parts.thinking) : parts.thinking;
    return { visible: parts.visible, think: think };
  }
  function liveBubbleHtml() {
    if (raceIsLive(streamRace)) return raceGridHtml(streamRace);
    const vis = streamParts().visible;
    if (vis) {
      const trail = streamStatus && /^(RUN|READ|WRITE|EDIT|SPAWN|SEND|GLOB|GREP|MCP|FETCH|TODO|SERVE|PING|PEEK|MULTIEDIT|NOTEBOOK):/i.test(streamStatus)
        ? '<span class="ttrail">' + escapeHtml(streamStatus) + '</span>' : '';
      return escapeHtml(vis) + trail;
    }
    const dots = '<span class="dots"><span></span><span></span><span></span></span>';
    const st = streamStatus ? '<span class="tstatus">' + escapeHtml(streamStatus) + '</span>' : '';
    return dots + (st ? ' ' + st : '');
  }
  function paintThinkFoldLive(think) {
    const fold = document.getElementById('streamThink');
    if (!fold) return;
    const chip = fold.querySelector('.thinkchip');
    const body = fold.querySelector('.thinkbody');
    const has = !!(think && String(think).trim());
    fold.hidden = !has;
    if (!has) {
      if (body) body.textContent = '';
      return;
    }
    fold.setAttribute('data-think', think);
    fold.classList.toggle('open', !!liveThinkOpen);
    if (chip) {
      chip.textContent = 'thinking...';
      chip.setAttribute('aria-expanded', liveThinkOpen ? 'true' : 'false');
    }
    if (body) body.textContent = liveThinkOpen ? think : '';
  }
  function paintStream() {
    const b = document.getElementById('streamBubble');
    if (!b) { render(); return; }
    const parts = streamParts();
    paintThinkFoldLive(parts.think);
    if (raceIsLive(streamRace)) {
      b.classList.add('raceboard');
      b.innerHTML = liveBubbleHtml();
      if (log.scrollHeight - log.scrollTop - log.clientHeight < 140) log.scrollTop = log.scrollHeight;
      scheduleFindPaint();
      return;
    }
    b.classList.remove('raceboard');
    // Visible tokens only. Chain-of-thought stays in the fold — and only
    // paints into the fold body when the user has unfurled it.
    if (parts.visible && !(streamStatus && /^(RUN|READ|WRITE|EDIT|SPAWN|SEND|GLOB|GREP|MCP|FETCH|TODO|SERVE|PING|PEEK|MULTIEDIT|NOTEBOOK):/i.test(streamStatus))) {
      b.textContent = parts.visible;
    } else {
      b.innerHTML = liveBubbleHtml();
    }
    if (log.scrollHeight - log.scrollTop - log.clientHeight < 140) log.scrollTop = log.scrollHeight;
    scheduleFindPaint();
  }
  function connectStream(id) {
    if (!id || esId === id) return;
    if (es) es.close();
    esId = id;
    streamBuf = '';
    streamThink = '';
    streamStatus = '';
    streamRace = null;
    streamRaceId = id;
    liveThinkOpen = false;
    raceHandoff += 1;
    es = new EventSource('/stream/' + id);   // EventSource reconnects on its own
    es.onmessage = (e) => {
      let ev;
      try { ev = JSON.parse(e.data); } catch { return; }
      if (ev.type === 'start') {
        streamBuf = '';
        streamThink = '';
        streamStatus = ev.detail || 'waiting on model…';
        streamRace = null;
        streamRaceId = id;
        liveThinkOpen = false;
        paintStream();
      }
      else if (ev.type === 'status') { streamStatus = ev.detail || streamStatus; paintStream(); }
      else if (ev.type === 'race') {
        if (ev.race && ev.race.racers && ev.race.racers.length >= 2) {
          streamRace = ev.race;
          streamRaceId = id;
        }
        paintStream();
      }
      else if (ev.type === 'think') {
        streamThink += ev.delta || '';
        paintStream();
      }
      else if (ev.type === 'delta') {
        streamBuf = ev.replace ? (ev.delta || '') : streamBuf + (ev.delta || '');
        if (ev.replace) streamThink = '';
        paintStream();
      }
      else if (ev.type === 'final' || ev.type === 'run-pending') {
        if (ev.type === 'final' && raceIsLive(streamRace)) {
          paintStream();
          const token = ++raceHandoff;
          setTimeout(function () {
            if (token !== raceHandoff) return;
            streamBuf = '';
            streamThink = '';
            streamStatus = '';
            streamRace = null;
            render();
          }, 420);
          return;
        }
        streamBuf = '';
        streamThink = '';
        streamStatus = '';
        streamRace = null;
        render();
      }
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
    // String compare — never a regex. A sitrep word-boundary regex inside
    // this template literal is eaten by the backtick parser and the whole
    // client script dies (empty sidebar, send is a no-op).
    const s = String(task).trim().toLowerCase();
    if (s === '/sitrep' || s.startsWith('/sitrep ')) {
      inp.value = '';
      send.classList.remove('show');
      openSitrep();
      return;
    }
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
    await fetch(API + '/drive', {
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
  fetch(API + '/slash-commands').then((r) => r.json()).then((c) => { slashCmds = c; }).catch(() => {});

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
    if (c.name === '/sitrep') {
      inp.value = '';
      slashMenu.classList.remove('show');
      openSitrep();
      return;
    }
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
  document.getElementById('sitrepBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    plusMenu.classList.remove('show');
    openSitrep();
  });
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
    createRow.innerHTML = '<div class="tavatar tavatar-sm tavatar-plus">+</div>' +
      '<div>Create new Bot' + (q ? ': ' + escapeHtml(composeInp.value.trim()) : '') + '</div>' +
      '<div class="kbd"><kbd>⌘</kbd><kbd>1</kbd></div>';
    createRow.addEventListener('click', async () => {
      const name = composeInp.value.trim() || prompt('Bot name?');
      if (!name) return;
      const t = await (await fetch(API + '/threads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })).json();
      activeId = t.id;
      closeCompose();
      await loadThreads(); await render();
    });
    composeList.appendChild(createRow);
    candidates.slice(0, 8).forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'crow';
      row.innerHTML = '<div class="tavatar tavatar-sm">' + botPfp(t.name) + '</div>' +
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
      const t = await (await fetch(API + '/threads/group', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ names: composeSel.map((c) => c.name) }) })).json();
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
  // Cmd/Ctrl+K -> sidebar thread search (GET /search). Cmd/Ctrl+F is find
  // inside the current #log — a different box, on purpose. Bound on document
  // keydown so it works no matter which pane has focus; preventDefault so
  // Chromium cannot swallow F for a page-find that was never wired.
  document.addEventListener('keydown', (e) => {
    const k = (e.key || '').toLowerCase();
    const withMod = e.metaKey || e.ctrlKey;
    if (withMod && k === 'k') {
      e.preventDefault();
      const el = document.getElementById('search');
      if (el) { el.focus(); el.select(); }
      return;
    }
    if (withMod && k === 'f') {
      e.preventDefault();
      openFindBar();
      return;
    }
    if (withMod && k === 'g' && findBarOpen()) {
      e.preventDefault();
      findStep(e.shiftKey ? -1 : 1);
      return;
    }
    if (k === 'escape' && findBarOpen()) {
      e.preventDefault();
      closeFindBar();
      return;
    }
    // Cmd/Ctrl+Enter sends from anywhere — useful when focus drifted into a
    // RUN card or a copy button mid-thought.
    if (withMod && k === 'enter') {
      e.preventDefault();
      try { submit(); } catch (err) { /* not ready */ }
    }
  });

  // FIND IN THREAD. Highlights visible .bubble text only — not sidebar
  // threads, not think folds, not RUN cards, not tool JSON dumps.
  let findMarks = [];
  let findIndex = 0;
  let findPaintTimer = null;
  const findBar = document.getElementById('findBar');
  const findInp = document.getElementById('findInp');
  const findCount = document.getElementById('findCount');
  function scheduleFindPaint() {
    if (!findBarOpen()) return;
    clearTimeout(findPaintTimer);
    findPaintTimer = setTimeout(function () { applyFind(true); }, 160);
  }
  function findBarOpen() {
    const el = document.getElementById('findBar');
    return !!(el && el.classList.contains('show'));
  }
  function placeFindBar() {
    const bar = document.getElementById('findBar');
    const main = document.getElementById('main');
    if (!bar || !chatHeader || !main) return;
    const top = chatHeader.getBoundingClientRect().bottom - main.getBoundingClientRect().top + 8;
    bar.style.top = Math.max(8, Math.round(top)) + 'px';
  }
  function clearFindMarks() {
    const logEl = document.getElementById('log');
    if (!logEl) { findMarks = []; return; }
    const marks = logEl.querySelectorAll('mark.findhit');
    for (let i = 0; i < marks.length; i++) {
      const mark = marks[i];
      const parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    }
    findMarks = [];
  }
  function paintFindCount() {
    if (!findCount) return;
    const n = findMarks.length;
    findCount.textContent = n ? ((findIndex + 1) + ' / ' + n) : (findInp && findInp.value.trim() ? '0 / 0' : '');
  }
  function skipFindNode(node) {
    const p = node && node.parentNode;
    if (!p || !p.closest) return true;
    return !!p.closest('.copybtn, .html-preview-wrap, button, script, style');
  }
  function highlightTextNode(node, query) {
    const text = node.nodeValue || '';
    const hay = text.toLowerCase();
    const needle = query.toLowerCase();
    if (!needle) return;
    let from = 0;
    const parts = [];
    let idx = hay.indexOf(needle, from);
    while (idx !== -1) {
      if (idx > from) parts.push({ t: text.slice(from, idx), hit: false });
      parts.push({ t: text.slice(idx, idx + needle.length), hit: true });
      from = idx + needle.length;
      idx = hay.indexOf(needle, from);
    }
    if (!parts.length) return;
    if (from < text.length) parts.push({ t: text.slice(from), hit: false });
    const frag = document.createDocumentFragment();
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].hit) {
        const mark = document.createElement('mark');
        mark.className = 'findhit';
        mark.textContent = parts[i].t;
        findMarks.push(mark);
        frag.appendChild(mark);
      } else {
        frag.appendChild(document.createTextNode(parts[i].t));
      }
    }
    node.parentNode.replaceChild(frag, node);
  }
  function applyFind(preserve) {
    const q = findInp ? findInp.value.trim() : '';
    const keep = preserve ? findIndex : 0;
    clearFindMarks();
    if (!q) { findIndex = 0; paintFindCount(); return; }
    const logEl = document.getElementById('log');
    if (!logEl) { paintFindCount(); return; }
    const bubbles = logEl.querySelectorAll('.bubble');
    for (let b = 0; b < bubbles.length; b++) {
      const nodes = [];
      const walker = document.createTreeWalker(bubbles[b], NodeFilter.SHOW_TEXT, null);
      let n = walker.nextNode();
      while (n) {
        if (n.nodeValue && !skipFindNode(n)) nodes.push(n);
        n = walker.nextNode();
      }
      for (let i = 0; i < nodes.length; i++) highlightTextNode(nodes[i], q);
    }
    if (!findMarks.length) { findIndex = 0; paintFindCount(); return; }
    findIndex = keep % findMarks.length;
    if (findIndex < 0) findIndex = 0;
    focusFindHit(findIndex);
  }
  function focusFindHit(i) {
    for (let m = 0; m < findMarks.length; m++) findMarks[m].classList.remove('cur');
    const mark = findMarks[i];
    if (!mark) { paintFindCount(); return; }
    mark.classList.add('cur');
    if (mark.scrollIntoView) mark.scrollIntoView({ block: 'center', inline: 'nearest' });
    paintFindCount();
  }
  function findStep(dir) {
    if (!findMarks.length) return;
    findIndex = (findIndex + dir + findMarks.length) % findMarks.length;
    focusFindHit(findIndex);
  }
  function openFindBar() {
    if (!findBar || !findInp) return;
    findBar.classList.add('show');
    placeFindBar();
    findInp.focus();
    findInp.select();
    if (findInp.value.trim()) applyFind(true);
    else paintFindCount();
  }
  function closeFindBar() {
    if (findBar) findBar.classList.remove('show');
    clearFindMarks();
    findIndex = 0;
    if (findCount) findCount.textContent = '';
    if (inp) inp.focus();
  }
  if (findInp) {
    findInp.addEventListener('input', () => applyFind(false));
    findInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        findStep(e.shiftKey ? -1 : 1);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeFindBar();
      }
    });
  }
  if (findBar) {
    const prevBtn = document.getElementById('findPrev');
    const nextBtn = document.getElementById('findNext');
    const closeBtn = document.getElementById('findClose');
    if (prevBtn) prevBtn.addEventListener('click', () => findStep(-1));
    if (nextBtn) nextBtn.addEventListener('click', () => findStep(1));
    if (closeBtn) closeBtn.addEventListener('click', closeFindBar);
  }
  if (window.electronAPI && typeof window.electronAPI.onFindInThread === 'function') {
    window.electronAPI.onFindInThread(function () { openFindBar(); });
  }

  const reloadBtn = document.getElementById('reloadBtn');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', async () => {
      reloadBtn.disabled = true;
      reloadBtn.textContent = '\u2026';
      try { await fetch(API + '/restart', { method: 'POST' }); } catch (e) { /* exit races the reply */ }
      // Poll until it answers again — a fixed timeout either reloads into a
      // dead port or waits long after it is already back.
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try { const r = await fetch(API + '/threads', { cache: 'no-store' }); if (r.ok) break; } catch (e) { /* still down */ }
      }
      location.reload();
    });
  }

  const hudBtn = document.getElementById('hudBtn');
  const hud = document.getElementById('hud');
  const mainEl = document.getElementById('main');
  // Pin the cost card just under the header. #chatHeader wraps, so a fixed
  // 40px sat on top of the spend dials. Measure the live bottom each time
  // it opens or the header changes height.
  function placeHud() {
    if (!hud || !chatHeader || !mainEl) return;
    const top = chatHeader.getBoundingClientRect().bottom - mainEl.getBoundingClientRect().top + 8;
    hud.style.top = Math.max(8, Math.round(top)) + 'px';
  }
  function fmtDockX(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    return (n >= 100 ? String(Math.round(n)) : Number(n).toFixed(n >= 10 ? 1 : 2)) + 'x';
  }
  function paintDock(you) {
    const spillEl = document.getElementById('dockSpill');
    const sessEl = document.getElementById('dockSession');
    const paidEl = document.getElementById('dockPaid');
    const bindEl = document.getElementById('dockBind');
    const callsEl = document.getElementById('dockCalls');
    if (!spillEl || !sessEl || !paidEl || !bindEl || !callsEl) return;
    const spent = Number(you && you.spentUsd) || 0;
    const direct = Number(you && you.directUsd) || 0;
    const spillX = Number(you && you.spilled && you.spilled.savingX);
    const spillCalls = Number(you && you.spilled && you.spilled.calls) || 0;
    const spillOn = Number.isFinite(spillX) && spillX > 0;
    const bound = spillOn || spillCalls > 0;
    const sessionX = spent > 0 ? direct / spent : null;
    spillEl.textContent = spillOn ? fmtDockX(spillX) : '—';
    spillEl.className = spillOn ? 'dv hlime' : 'dv';
    sessEl.textContent = sessionX == null ? '—' : fmtDockX(sessionX);
    sessEl.className = 'dv';
    paidEl.textContent = usd(spent);
    bindEl.textContent = bound ? 'yes' : 'no';
    callsEl.textContent = String((you && you.paidCalls) || 0);
  }
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
      const you = await (await fetch(API + '/hud-summary')).json();
      const creditEl = document.getElementById('hCredit');
      if (creditEl) creditEl.textContent = (you.creditUsd == null) ? '—' : usd(Number(you.creditUsd) || 0);
      const spent = Number(you.spentUsd) || 0;
      const cogs = Number(you.cogsUsd) || 0;
      const direct = Number(you.directUsd) || 0;
      const margin = spent > 0 ? Math.round((spent - cogs) / spent * 100) + '%' : '—';
      const cogsOver = cogs > spent;
      document.getElementById('hYouSpent').textContent = usd(spent);
      const cogsEl = document.getElementById('hYouCogs');
      cogsEl.textContent = usd(cogs);
      cogsEl.className = cogsOver ? 'hember' : '';
      const marginEl = document.getElementById('hYouMargin');
      marginEl.textContent = margin;
      marginEl.className = cogsOver ? 'hember' : 'hlime';
      document.getElementById('hYouDirect').textContent = usd(direct);
      const savedEl = document.getElementById('hYouSaved');
      const hintEl = document.getElementById('hHint');
      if (spent > 0) {
        const sav = formatSavingLabel(you);
        const mult = sav.mult;
        // honest either way: >=1x is a real saving vs a naked direct call,
        // <1x means you're currently paying MORE than direct would cost —
        // don't dress that up as green when it isn't one.
        // Asking a bound corpus makes this genuinely large (the counterfactual
        // is shipping the WHOLE corpus), so 2dp would read as noise up there.
        // Label the number: "Nx spilled" when bound, else "Nx session".
        savedEl.textContent = sav.text;
        savedEl.className = mult >= 1 ? 'hlime' : 'hember';
        // Session direct/spent (never first-call). Ember when cogs > spent —
        // house losing. Do not treat race_unused as a user refund.
        if (cogsOver) {
          hintEl.className = 'hhint show';
          hintEl.innerHTML = '<b>cogs above paid.</b> house is losing — our cost exceeded what you were billed. '
            + 'you pay for every entrant we actually launched; failures still cost us.';
        } else {
          hintEl.className = mult >= 1 ? 'hhint' : 'hhint show';
          hintEl.innerHTML = '<b>feed it more.</b> you\\'re billed on the slice actually sent, '
            + 'not the corpus — so the more you bind, the further ahead this gets. '
            + 'small inputs cost more than sending them straight. HUD is spilled-call x when any call bound.';
        }
      } else {
        savedEl.textContent = '—';
        if (cogsOver) {
          hintEl.className = 'hhint show';
          hintEl.innerHTML = '<b>cogs above paid.</b> our cost exceeded what you were billed.';
        } else {
          hintEl.className = 'hhint';
        }
      }
      document.getElementById('hFoot').textContent = (you.paidCalls || 0) + ' paid calls this session';
      paintDock(you);
    } catch (e) {
      document.getElementById('hFoot').textContent = 'error: ' + e.message;
    }
  }
  let hudTimer = null;
  function ensureHudTick() {
    if (hudTimer) return;
    hudTimer = setInterval(refreshHud, 30000);
  }
  hudBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    hud.classList.toggle('show');
    if (hud.classList.contains('show')) {
      placeHud();
      refreshHud();
    }
    echoSlash('/hud');
  });
  refreshHud();
  ensureHudTick();
  window.addEventListener('resize', () => {
    if (hud.classList.contains('show')) placeHud();
    if (findBarOpen()) placeFindBar();
  });
  if (typeof ResizeObserver !== 'undefined') {
    if (chatHeader) {
      new ResizeObserver(() => {
        if (hud.classList.contains('show')) placeHud();
        if (findBarOpen()) placeFindBar();
      }).observe(chatHeader);
    }
  }
  document.addEventListener('click', (e) => { if (!hud.contains(e.target)) hud.classList.remove('show'); });
</script>

<script>
// GROKROOM — solana gossip rooms in the sidebar. Fully additive: any failure
// in here must never blank the thread list, hence the outer try/catch.
(function () {
  try {
    var ROOM_API = 'http://127.0.0.1:4799';
    var st = document.createElement('style');
    st.textContent =
      '#rooms { flex: 0 0 auto; border-top: 1px solid #1c1c1e; padding: 8px 8px 10px; max-height: 220px; overflow-y: auto; }' +
      '.rhead { font-size: 10px; letter-spacing: .12em; color: #55606c; padding: 4px 6px 6px; text-transform: uppercase; display: flex; justify-content: space-between; align-items: center; }' +
      '.rhead .rdot { color: #2fbf71; } .rhead .rdot.off { color: #b4453c; }' +
      '.rrow { display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer; border-radius: 10px; color: #c8cdd4; }' +
      '.rrow:hover { background: #17171a; } .rrow.active { background: #1c1c1e; }' +
      '.rrow .ric { width: 22px; text-align: center; }' +
      '.rrow .rname { flex: 1 1 auto; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }' +
      '.rrow .rcount { font-size: 11px; color: #55606c; }' +
      '#main.roommode > *:not(#roomFrame) { display: none !important; }' +
      '#roomFrame { flex: 1 1 auto; border: 0; width: 100%; height: 100%; background: #0b0b0d; }';
    document.head.appendChild(st);

    var roomsEl = document.getElementById('rooms');
    var mainEl = document.getElementById('main');
    var threadsEl = document.getElementById('threads');
    if (!roomsEl || !mainEl) return;
    var activeRoom = null;

    function exitRoom() {
      if (!activeRoom) return;
      activeRoom = null;
      mainEl.classList.remove('roommode');
      var f = document.getElementById('roomFrame');
      if (f) f.remove();
      renderRooms(window.__grokroomState || null);
    }
    // Clicking any real thread row leaves the room (capture phase, so it
    // fires regardless of what the thread handler does).
    if (threadsEl) threadsEl.addEventListener('click', function () { setTimeout(exitRoom, 0); }, true);

    function enterRoom(id) {
      activeRoom = id;
      var f = document.getElementById('roomFrame');
      if (!f) {
        f = document.createElement('iframe');
        f.id = 'roomFrame';
        mainEl.appendChild(f);
      }
      f.src = ROOM_API + '/?room=' + encodeURIComponent(id);
      mainEl.classList.add('roommode');
      renderRooms(window.__grokroomState || null);
    }

    function renderRooms(state) {
      var html = '<div class="rhead"><span>\u25C9 rooms \u00B7 solana testnet</span><span class="rdot' + (state ? '' : ' off') + '">\u25CF</span></div>';
      if (!state) {
        html += '<div class="rrow" style="cursor:default"><span class="rname" style="color:#55606c">room server offline \u2014 ~/grokroom</span></div>';
        roomsEl.innerHTML = html;
        return;
      }
      (state.rooms || []).forEach(function (r) {
        var n = (r.count != null ? r.count : (r.msgs != null ? r.msgs : (r.messages != null ? r.messages : '')));
        html += '<div class="rrow' + (r.id === activeRoom ? ' active' : '') + '" data-room="' + r.id + '">' +
          '<span class="ric">\u25C8</span>' +
          '<span class="rname">' + r.id + '</span>' +
          '<span class="rcount">' + n + '</span></div>';
      });
      roomsEl.innerHTML = html;
      Array.prototype.forEach.call(roomsEl.querySelectorAll('.rrow[data-room]'), function (row) {
        row.addEventListener('click', function () { enterRoom(row.getAttribute('data-room')); });
      });
    }

    function poll() {
      fetch(ROOM_API + '/state').then(function (r) { return r.json(); }).then(function (j) {
        window.__grokroomState = j;
        renderRooms(j);
      }).catch(function () {
        window.__grokroomState = null;
        renderRooms(null);
      });
    }
    poll();
    setInterval(poll, 15000);
  } catch (e) { /* rooms are optional; threads must survive */ }
})();
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
      try {
        w.creditUsd = await creditBalance();
      } catch { /* leave credit off if the gateway is down */ }
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
      let you = { spentUsd: 0, cogsUsd: 0, directUsd: 0, paidCalls: 0, creditUsd: null, chainUsd: null };
      try { you = { ...you, ...(await (await fetch('http://127.0.0.1:8402/v1/session', { signal: AbortSignal.timeout(2000) })).json()) }; }
      catch { /* local proxy not running — HUD shows zeros rather than guessing */ }
      await attachSpilled(you);
      try {
        you.creditUsd = await creditBalance();
      } catch { /* credit is advisory */ }
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
    res.end(t ? JSON.stringify({
      id: t.id, history: t.history, status: t.status,
      liveStatus: t.status === 'thinking' ? (t.liveStatus || '') : '',
      liveRace: t.status === 'thinking' ? (t.liveRace || null) : null,
      lastRaceFail: t.lastRaceFail || null,
      workspacePort: workspacePort || 0, dir: t.dir || WORKSPACE_DIR,
    }) : '{}');
    return;
  }
  if (req.method === 'DELETE' && req.url.startsWith('/threads/')) {
    const doomed = threads.get(req.url.split('/')[2]);
    if (doomed) finishChildDir(doomed);
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
        kickTurn(t.id, '(you denied running that command)').catch(() => {});
        return;
      }
      entry.runStatus = 'running';
      saveThreads();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      execCommand(command, cwd).then((output) => {
        noteRunForCorpus(t.id, command, { cwd });
        entry.runStatus = 'done';
        entry.runOutput = output;
        saveThreads();
        kickTurn(t.id, `(command output)\n${output}`).catch(() => {});
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
        // Drawer-only. Never dump sitrep into the transcript.
        if (/^\/sitrep\b/i.test(task.trim())) return;
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
      // "/mode auto|ask" — Auto is the Claude Code harness (openzoo claude
      // env). Ask stays a chat completion; RUN: waits for approve/deny.
      const modeCmd = /^\/mode\s+(auto|ask)\b/.exec(task.trim());
      if (modeCmd && t) {
        t.runMode = modeCmd[1];
        t.history.push({ who: 'bot', text: `Run mode set to ${modeCmd[1]}${modeCmd[1] === 'auto' ? ' — Claude Code via OpenZoo (x402). Native tools, not RUN: text.' : ' — chat completion; RUN: waits for your approval.'}` });
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

export {
  tryDirective, ensureWorkspacePort, isPreviewableRel, previewAck, workspaceFileUrl,
  parseRun, looksLikeMcpAsBash, stripThinkTags, takeThink, safeResolveIn, inDir, listDir,
  handleSlash, newThread, setRunTurnForTest, setBrainAskForTest, setClaudeRunnerForTest, runTurn,
  runAutoClaudeTurn, autoClaudePrompt,
  AUTO_CONTINUE, AUTO_RACE_RETRY, AUTO_EMPTY_RETRY, pingWakeText, pingCanWake, shouldKeepAuto,
  isDoneReply, isTransientModelFail, isPaymentFailed, isEmptyWalletPayment, isEmptyToolResult, enqueueAutoHop, childKickoff, findByName,
  attachChildDir, finishChildDir,
  lockWorktree, unlockWorktree, parsePrRef, fetchSpecsForOrigin, agentSlug,
  filesForCorpus, noteFileForCorpus, noteRunForCorpus, resetFilesForCorpus,
  filesForCorpusKeys, scheduleFilesForCorpus, inFlightChars, BIND_MIN_CHARS, KEEP_MAX,
  formatSavingLabel, holobrainOf, looksLikeProxyShell, CHAT_NOT_PROXY, PROXY_SHELL_REFUSE,
};
