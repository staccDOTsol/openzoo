/**
 * Spill-side bookkeeping that used to live (and die) inside proxy.js.
 *
 * Three things the status line needs, and that a live session was not getting:
 *   1. A corpus ledger that accumulates bind + append + file bytes, persisted
 *      so a sidecar restart still knows how big the bound context is.
 *   2. File-path extraction that matches Claude Code / Anthropic tool_use
 *      (and the OpenAI shape those requests are translated into).
 *   3. Counters for spilled calls, file-bind events, and offloaded chars —
 *      incremented on the spill path, never on a pass-through.
 *
 * Kept as pure-enough helpers so test/spill.test.js can cover them without
 * standing up the proxy or the gateway.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PATH_KEYS = new Set([
  'file_path', 'path', 'target_file', 'filePath', 'filename', 'file',
  'targetFile', 'filepath',
]);
const PATH_ARRAY_KEYS = new Set(['files', 'file_paths', 'paths', 'filePaths']);

export function boundCharsFile(home = os.homedir()) {
  return process.env.OPENZOO_BOUND_CHARS_PATH
    || path.join(home, '.openzoo', 'bound-chars.json');
}

/**
 * Load ~/.openzoo/bound-chars.json into the maps the proxy holds.
 * Missing / corrupt file is a cold start, not an error.
 */
export function loadBoundChars(boundChars, extra = {}) {
  const file = extra.file || boundCharsFile(extra.home);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, reason: 'missing' }; }
  let data;
  try { data = JSON.parse(raw); } catch { return { ok: false, reason: 'corrupt' }; }
  const chars = data?.chars && typeof data.chars === 'object' ? data.chars
    : (data && typeof data === 'object' && !data.sessions && !data.files ? data : {});
  for (const [id, n] of Object.entries(chars)) {
    const v = Number(n);
    if (id && Number.isFinite(v) && v > 0) boundChars.set(id, v);
  }
  if (extra.sessions && data?.sessions && typeof data.sessions === 'object') {
    for (const [k, v] of Object.entries(data.sessions)) {
      if (k && v && typeof v.contextId === 'string') extra.sessions.set(k, v);
    }
  }
  if (extra.boundFiles && Array.isArray(data?.files)) {
    for (const key of data.files) {
      if (typeof key === 'string') extra.boundFiles.add(key);
    }
  }
  return { ok: true, contexts: boundChars.size };
}

export function persistBoundChars(boundChars, extra = {}) {
  const file = extra.file || boundCharsFile(extra.home);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = {
      chars: Object.fromEntries(boundChars),
    };
    if (extra.sessions) payload.sessions = Object.fromEntries(extra.sessions);
    if (extra.boundFiles) payload.files = [...extra.boundFiles];
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Accumulate bound bytes for a context.
 *
 *   init  — first bind: ledger becomes `chars` (the bound corpus size)
 *   add   — append / file: ledger += chars
 *
 * Persist after every successful update so a crash mid-session keeps the count.
 */
export function accumulateBoundChars(boundChars, contextId, chars, opts = {}) {
  if (!contextId || !Number.isFinite(chars) || chars < 0) return boundChars.get(contextId) || 0;
  const next = opts.init ? chars : (boundChars.get(contextId) || 0) + chars;
  boundChars.set(contextId, next);
  if (opts.sessionKey && opts.sessions) {
    opts.sessions.set(opts.sessionKey, { contextId, chars: next });
  }
  if (opts.persist !== false) persistBoundChars(boundChars, opts);
  return next;
}

/**
 * Conversation chars use Math.max so a stale smaller ledger (the 34056
 * files-only row) cannot cap a later, larger prefix. New file bytes add on top.
 *
 *   next = max(prev, corpusChars) + fileChars
 */
export function noteCorpusLedger(boundChars, {
  contextId, corpusChars = 0, fileChars = 0, ...opts
} = {}) {
  if (!contextId) return 0;
  const prev = boundChars.get(contextId) || 0;
  const next = Math.max(prev, Number(corpusChars) || 0) + (Number(fileChars) || 0);
  boundChars.set(contextId, next);
  if (opts.sessionKey && opts.sessions) {
    opts.sessions.set(opts.sessionKey, { contextId, chars: next });
  }
  persistBoundChars(boundChars, opts);
  return next;
}

/** send() must not let `stale || thisTurn` pick the smaller number. */
export function corpusCharsForSend(boundChars, contextId, thisTurn) {
  return Math.max(boundChars.get(contextId) || 0, thisTurn || 0);
}

/**
 * Pricing / unspilled basis: the unspilled size, never the shrunken sent
 * (tokensAfter) size. Same unit on both args — tokens or chars, not mixed.
 */
export function unspilledBasis({ tokensBefore, corpus } = {}) {
  return Math.max(Number(tokensBefore) || 0, Number(corpus) || 0);
}

/**
 * Gateway counterfactual the tell-line must print. Missing / non-finite /
 * non-positive → null (`basis ?`). Never reads lecore.corpusTokens.
 */
export function spillPricedTellBasis(x) {
  const n = Number(x?.counterfactualTokensUsed);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Exact `spill priced:` / `spill priced (streamed):` line the proxy logs. */
export function spillPricedLine(x, { streamed = false } = {}) {
  const lc = x?.lecore || {};
  const basis = spillPricedTellBasis(x);
  const prefix = streamed ? 'spill priced (streamed):' : 'spill priced:';
  return `${prefix} ${x?.pricing} · basis ${basis ?? '?'} tok vs sent ${lc.tokensBefore ?? '?'} -> ${lc.tokensAfter ?? '?'} · billed ${(x?.billedUsd ?? 0).toFixed(5)} direct ${(x?.directUsd ?? 0).toFixed(5)}`;
}

/** Expand ~ and resolve relative paths against cwd. Returns null if unusable. */
export function resolveReadablePath(p, cwd = process.cwd()) {
  if (typeof p !== 'string') return null;
  let s = p.trim();
  if (!s || s.length > 1024 || /[\n\r]/.test(s)) return null;
  if (/^https?:\/\//i.test(s)) return null;
  if (s.startsWith('~/') || s === '~') s = path.join(os.homedir(), s.slice(1).replace(/^\//, '') || '');
  if (!path.isAbsolute(s)) s = path.resolve(cwd, s);
  return s;
}

function looksLikePath(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length < 2 || t.length > 1024 || /[\n\r]/.test(t)) return false;
  if (/^https?:\/\//i.test(t)) return false;
  return /[\\/]/.test(t) || /\.\w{1,10}$/.test(t) || t.startsWith('~') || t.startsWith('.');
}

function parseArgs(args) {
  if (args == null) return {};
  if (typeof args === 'object' && !Array.isArray(args)) return args;
  if (typeof args === 'string') {
    const t = args.trim();
    if (!t) return {};
    try { return JSON.parse(t); } catch { return {}; }
  }
  return {};
}

function collectStructuredPaths(args, out) {
  if (!args || typeof args !== 'object') return;
  for (const k of PATH_KEYS) {
    if (typeof args[k] === 'string' && args[k]) out.push(args[k]);
  }
  for (const k of PATH_ARRAY_KEYS) {
    if (!Array.isArray(args[k])) continue;
    for (const x of args[k]) {
      if (typeof x === 'string') out.push(x);
      else if (x && typeof x === 'object') collectStructuredPaths(x, out);
    }
  }
}

const CWD_HINT = /(?:current working directory is[:\s]+|<cwd>\s*|cwd:\s+)([^\s<]+)/i;

export function parseCwdHint(text) {
  if (typeof text !== 'string' || !text) return null;
  const m = text.match(CWD_HINT);
  if (!m) return null;
  const p = m[1].trim();
  return path.isAbsolute(p) ? p : null;
}

/**
 * Pull path-like tokens out of a Bash `command` string.
 * `head -80 programs/README.md` and `cat /abs/file` both count; bare `ls` does not.
 */
export function extractBashPaths(command, cwd = process.cwd()) {
  const found = [];
  if (typeof command !== 'string' || !command) return { paths: found, cwd };
  let localCwd = cwd;
  for (const part of command.split(/(?:&&|\|\||;|\n)/)) {
    const cd = part.match(/^\s*cd\s+(?:\/[dD]\s+)?(['"]?)(.+?)\1\s*$/);
    if (cd) {
      const dest = resolveReadablePath(cd[2].trim(), localCwd);
      if (dest) localCwd = dest;
      continue;
    }
    for (const m of part.matchAll(/(['"])([^'"]+)\1/g)) {
      const t = m[2].trim();
      if (looksLikePath(t) || path.isAbsolute(t)) found.push({ raw: t, cwd: localCwd });
    }
    for (const tok of part.split(/\s+/)) {
      const t = tok.replace(/^[`'"]|[`'"]$/g, '');
      if (!t || t.startsWith('-') || t.startsWith('$') || t === '.' || t === '..') continue;
      if (looksLikePath(t) || path.isAbsolute(t)) found.push({ raw: t, cwd: localCwd });
    }
  }
  return { paths: found, cwd: localCwd };
}

/**
 * Live Claude Code msgs are OpenAI-shaped (spill runs AFTER anthropicToOpenAI).
 * Read/Edit/Write land on tool_calls[].function.arguments as a JSON string
 * {file_path:"/abs/..."}. Bash is {command:"head -80 programs/README.md"}.
 * Do not expect Read tool_result to carry the path. Do not harvest import
 * paths out of tool_result bodies.
 */
export function extractFileCandidates(msgs, { cwd = process.cwd() } = {}) {
  const structured = [];
  const bash = [];
  let currentCwd = cwd;
  if (!Array.isArray(msgs)) return { structured, bash, cwd: currentCwd };
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'tool' && typeof m.content === 'string') {
      const hint = parseCwdHint(m.content);
      if (hint) currentCwd = hint;
    }
    const calls = [
      ...(Array.isArray(m.tool_calls) ? m.tool_calls : []),
      ...(m.function_call ? [m.function_call] : []),
    ];
    for (const c of calls) {
      const args = parseArgs(c?.function?.arguments ?? c?.arguments);
      const fromArgs = [];
      collectStructuredPaths(args, fromArgs);
      for (const raw of fromArgs) structured.push({ raw, cwd: currentCwd });
      if (typeof args.command === 'string') {
        const got = extractBashPaths(args.command, currentCwd);
        for (const p of got.paths) bash.push({ ...p, bash: true });
        currentCwd = got.cwd;
      }
    }
    // Harmless leftover: pre-conversion Anthropic tool_use. Live Claude Code
    // never has this by the time spillTranscript runs.
    const blocks = Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (b?.input) {
        const fromInput = [];
        collectStructuredPaths(b.input, fromInput);
        for (const raw of fromInput) structured.push({ raw, cwd: currentCwd });
        if (typeof b.input.command === 'string') {
          const got = extractBashPaths(b.input.command, currentCwd);
          for (const p of got.paths) bash.push({ ...p, bash: true });
          currentCwd = got.cwd;
        }
      }
    }
  }
  return { structured, bash, cwd: currentCwd };
}

export function extractFilePaths(msgs, opts) {
  const { structured, bash } = extractFileCandidates(msgs, opts);
  const seen = new Set();
  const out = [];
  for (const item of [...structured, ...bash]) {
    const t = typeof item === 'string' ? item : item?.raw;
    if (typeof t !== 'string') continue;
    const s = t.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'target']);

function fileBindLog({ kept, bytes, enoent, cap, dir, rel, bash }) {
  return `file-bind kept=${kept} bytes=${bytes} skip enoent=${enoent} cap=${cap} dir=${dir} rel=${rel} bash=${bash}`;
}

function emptyFileBind({ reason = 'none-kept', ...extra } = {}) {
  return {
    text: '',
    files: 0,
    bytes: 0,
    pending: [],
    kept: 0,
    enoent: 0,
    cap: 0,
    dir: 0,
    rel: 0,
    bash: 0,
    reason,
    ...extra,
  };
}

/**
 * Request-path filebind: collect paths + cheap stat/mtime only.
 *
 * Live path is OpenAI tool_calls (Read/Edit/Write + Bash command). Relative
 * paths resolve against cwd / last "current working directory is …" hint.
 *
 * MUST NOT read file contents and MUST NOT readdir children. A 2MB Read
 * (or a directory the agent listed) used to stall the chat turn here.
 * Bytes, directory expansion, and bindCorpus belong in readFilesForCorpus,
 * which the proxy runs after the turn is already on the wire.
 *
 * Dedupes on path+mtime into `boundFiles`, applies the size cap, and
 * reserves directory keys so the same tree is not re-queued every turn.
 * The `file-bind kept=N bytes=B …` line is logged here only when there is
 * nothing to read (disabled / none-kept) — otherwise readFilesForCorpus
 * fills bytes after the background read, never on the hot path.
 */
export function filesForCorpus(msgs, {
  boundFiles,
  cwd = process.cwd(),
  cap = Number(process.env.OPENZOO_BIND_FILE_MAX || 400_000),
  disabled = process.env.OPENZOO_BIND_FILES === '0',
  log = () => {},
  statSync = (p) => fs.statSync(p),
} = {}) {
  if (disabled) {
    const empty = emptyFileBind({ reason: 'disabled' });
    log(fileBindLog(empty));
    return empty;
  }
  const { structured, bash } = extractFileCandidates(msgs, { cwd });
  const candidates = [
    ...structured.map((p) => ({ ...p, bash: false })),
    ...bash.map((p) => ({ ...p, bash: true })),
  ];
  const skip = { enoent: 0, cap: 0, dir: 0, rel: 0 };
  const seen = new Set();
  const pending = [];

  const queue = (abs) => {
    if (!abs || seen.has(abs)) return;
    seen.add(abs);
    let st;
    try { st = statSync(abs); } catch { skip.enoent += 1; return; }
    if (st.isDirectory()) {
      skip.dir += 1;
      const key = `${abs}:${st.mtimeMs}`;
      if (boundFiles?.has(key)) return;
      boundFiles?.add(key);
      pending.push({ abs, kind: 'dir' });
      return;
    }
    if (!st.isFile()) { skip.enoent += 1; return; }
    if (st.size > cap) { skip.cap += 1; return; }
    const key = `${abs}:${st.mtimeMs}`;
    if (boundFiles?.has(key)) return;
    boundFiles?.add(key);
    pending.push({ abs, kind: 'file' });
  };

  for (const item of candidates) {
    const raw = item.raw;
    if (!path.isAbsolute(raw) && !(raw.startsWith('~/') || raw === '~')) skip.rel += 1;
    const abs = resolveReadablePath(raw, item.cwd || cwd);
    if (!abs) { skip.enoent += 1; continue; }
    queue(abs);
  }

  const stats = {
    kept: 0,
    bytes: 0,
    enoent: skip.enoent,
    cap: skip.cap,
    dir: skip.dir,
    rel: skip.rel,
    bash: bash.length,
  };
  if (!pending.length) log(fileBindLog(stats));
  return {
    text: '',
    files: 0,
    bytes: 0,
    pending,
    reason: pending.length ? null : 'none-kept',
    ...stats,
  };
}

/**
 * Background filebind: expand directories, read bytes, log the real totals.
 *
 * Takes the `pending` list (or the whole collect result) from filesForCorpus.
 * Children of a directory skip node_modules/.git/dist/build/__pycache__/.venv/target
 * and hidden names. Same size cap as the request-path collector.
 *
 * Always logs `file-bind kept=N bytes=B skip enoent=X cap=Y dir=Z rel=W bash=K`
 * so grep-for-FILES is no longer the only signal. Bytes, not 0.0MB.
 */
export function readFilesForCorpus(collected, {
  boundFiles,
  cap = Number(process.env.OPENZOO_BIND_FILE_MAX || 400_000),
  log = () => {},
  statSync = (p) => fs.statSync(p),
  readFileSync = (p) => fs.readFileSync(p, 'utf8'),
  readdirSync = (p) => fs.readdirSync(p),
} = {}) {
  const pending = Array.isArray(collected) ? collected : (collected?.pending || []);
  const skip = {
    enoent: Number(collected?.enoent) || 0,
    cap: Number(collected?.cap) || 0,
    dir: Number(collected?.dir) || 0,
    rel: Number(collected?.rel) || 0,
  };
  const bash = Number(collected?.bash) || 0;
  const chunks = [];
  const readSeen = new Set();

  const readOne = (abs) => {
    if (!abs || readSeen.has(abs)) return;
    readSeen.add(abs);
    try {
      chunks.push(`FILE ${abs}\n${readFileSync(abs)}`);
    } catch {
      skip.enoent += 1;
    }
  };

  const bindChild = (abs) => {
    let st;
    try { st = statSync(abs); } catch { skip.enoent += 1; return; }
    if (!st.isFile()) return;
    if (st.size > cap) { skip.cap += 1; return; }
    const key = `${abs}:${st.mtimeMs}`;
    if (boundFiles?.has(key)) return;
    boundFiles?.add(key);
    readOne(abs);
  };

  for (const item of pending) {
    const abs = typeof item === 'string' ? item : item?.abs;
    if (!abs) continue;
    if (item?.kind === 'dir') {
      let kids = [];
      try { kids = readdirSync(abs); } catch { skip.enoent += 1; continue; }
      for (const name of kids) {
        if (!name || name.startsWith('.') || SKIP_DIR_NAMES.has(name)) continue;
        bindChild(path.join(abs, name));
      }
      continue;
    }
    readOne(abs);
  }

  const text = chunks.join('\n\n');
  const stats = {
    kept: chunks.length,
    bytes: text.length,
    enoent: skip.enoent,
    cap: skip.cap,
    dir: skip.dir,
    rel: skip.rel,
    bash,
  };
  log(fileBindLog(stats));
  return { text, files: chunks.length, bytes: text.length, reason: chunks.length ? null : 'none-kept', ...stats };
}

/**
 * path:mtime keys -> absolute paths. mtime is always the last `:Number` segment
 * so `C:\foo:1734.2` still splits correctly.
 */
export function boundAbsFromKeys(boundFiles) {
  const out = new Set();
  if (!boundFiles) return out;
  for (const key of boundFiles) {
    if (typeof key !== 'string' || !key) continue;
    const i = key.lastIndexOf(':');
    if (i <= 0) { out.add(key); continue; }
    const rest = key.slice(i + 1);
    if (rest !== '' && Number.isFinite(Number(rest))) out.add(key.slice(0, i));
    else out.add(key);
  }
  return out;
}

const FILE_VIEW = /^(head|tail|cat|less|more|type|Get-Content|gc)\b/i;

/** `head -80 notes.md` and `cd dir && cat x` count; `npm test` and `cat x | rg y` do not. */
export function looksLikeFileView(command) {
  if (typeof command !== 'string' || !command.trim()) return false;
  let sawView = false;
  for (const part of command.split(/(?:&&|\|\||;|\n)/)) {
    const t = part.trim();
    if (!t) continue;
    if (/^cd\s+/.test(t)) continue;
    if (/\|/.test(t)) return false;
    if (FILE_VIEW.test(t)) { sawView = true; continue; }
    return false;
  }
  return sawView;
}

function toolFnName(c) {
  return c?.function?.name || c?.name || '';
}

/**
 * Read / Edit / Write (and file-view Bash). Bodies for these that remain
 * after the last user ask must stay real — a `[bound, N chars]` placeholder
 * in the live tail makes the model think Read is broken and cat files.
 */
export function isLiveFileTool(name, args = {}) {
  const n = String(name || '');
  if (/^(read|edit|write)/i.test(n)) return true;
  if (/bash/i.test(n) && looksLikeFileView(args?.command)) return true;
  return false;
}

/**
 * Same number the HUD green `x` uses: this-call / running spill
 * direct÷billed, else session-wide. Null when no dollar figure exists.
 */
export function hudDollarX({
  spillDirect, spillSpend, sessionDirect, sessionSpent,
} = {}) {
  const billed = Number(spillSpend);
  const direct = Number(spillDirect);
  if (billed > 0 && Number.isFinite(direct)) return direct / billed;
  const sessBilled = Number(sessionSpent);
  const sessDirect = Number(sessionDirect);
  if (sessBilled > 0 && Number.isFinite(sessDirect)) return sessDirect / sessBilled;
  return null;
}

/** Tool result larger than this is "fat" — stub it in the forwarded tail. */
export const FAT_TOOL_CHARS = 400;

/**
 * Over-budget forwarded-tail shrink (SHRINK_OVER). When the tail exceeds
 * this many chars (or the caller `budget`), oldest tool_results are
 * considered for `[bound]` stubs. A stub is emitted only if HRR recall
 * actually returns overlapping bytes for that item — `boundFiles` /
 * `boundAbs` is not proof.
 */
export const SHRINK_OVER = 6000;

/**
 * Last-round bodies under this floor stay even after a follow-up ask
 * (0.48.77: a 461-byte bound Read must remain visible). Older rounds use
 * the 0.48.76 rules (bound / fat / over budget) whether or not they sit
 * after the last user ask.
 */
export const KEEP_TOOL_CHARS = 4096;

function toolCallIds(m) {
  if (!m || typeof m !== 'object') return [];
  const ids = [];
  if (Array.isArray(m.tool_calls)) {
    for (const c of m.tool_calls) {
      const id = c?.id || c?.tool_call_id;
      if (id) ids.push(id);
    }
  }
  if (m.function_call) {
    const id = m.function_call.id || m.function_call.tool_call_id;
    if (id) ids.push(id);
  }
  if (Array.isArray(m.content)) {
    for (const b of m.content) {
      if (b?.type === 'tool_use' && b.id) ids.push(b.id);
    }
  }
  return ids;
}

/**
 * Most recent assistant tool_calls / Anthropic tool_use in the forwarded
 * tail, plus those ids. Not "everything after the last user ask".
 *
 * A long continue / ultracode turn parks the last user ask early and then
 * stacks Read/Bash/WebSearch rounds after it. Only the latest batch is
 * this turn's eyes — even a 461-byte Read, even a fat WebSearch. Older
 * batches in that same tail stub/trim under the 0.48.76 rules. When the
 * ask follows the last batch, KEEP_TOOL_CHARS still keeps that last
 * round's small bodies (0.48.77) while fat completed rounds may stub.
 */
export function currentToolRound(msgs, { lastUser = -1, fromIndex = 0 } = {}) {
  let index = -1;
  const ids = new Set();
  if (!Array.isArray(msgs)) return { index, ids, inFlight: false };
  const start = Math.max(0, Number(fromIndex) || 0);
  for (let i = start; i < msgs.length; i++) {
    const here = toolCallIds(msgs[i]);
    if (!here.length) continue;
    index = i;
    ids.clear();
    for (const id of here) ids.add(id);
  }
  return { index, ids, inFlight: index >= 0 && index > lastUser };
}

export function fileBoundStub(paths, n) {
  const list = [...new Set((paths || []).filter(Boolean))].join(' ');
  const mark = Number.isFinite(n) && n > 0 ? `[bound, ${n} chars]` : '[bound]';
  return list ? `FILE ${list} ${mark}` : `FILE ${mark}`;
}

/** Generic stub for WebSearch / Fetch / Bash / any fat tool_result. */
export function toolResultStub(n, paths) {
  const list = [...new Set((paths || []).filter(Boolean))].join(' ');
  const mark = `[bound, ${Number(n) || 0} chars]`;
  return list ? `FILE ${list} ${mark}` : mark;
}

function toolCallArgLength(tc) {
  const a = tc?.function?.arguments ?? tc?.arguments;
  if (typeof a === 'string') return a.length;
  if (a && typeof a === 'object') return JSON.stringify(a).length;
  return 0;
}

/**
 * Keep path/query/url/command so pairing still names the call; drop the
 * fat payload (Write contents, Edit hunks, pasted Bash, tool JSON).
 */
export function slimToolCallArgs(tc, n) {
  const args = parseArgs(tc?.function?.arguments ?? tc?.arguments);
  const slim = {};
  for (const k of PATH_KEYS) {
    if (typeof args[k] === 'string' && args[k]) slim[k] = args[k];
  }
  if (typeof args.query === 'string') {
    slim.query = args.query.length > 240 ? `${args.query.slice(0, 240)}…` : args.query;
  }
  if (typeof args.url === 'string') {
    slim.url = args.url.length > 300 ? `${args.url.slice(0, 300)}…` : args.url;
  }
  if (typeof args.command === 'string') {
    slim.command = args.command.length > 240 ? `${args.command.slice(0, 240)}…` : args.command;
  }
  slim._stub = `[bound, ${Number(n) || 0} chars]`;
  const encoded = JSON.stringify(slim);
  if (tc?.function) return { ...tc, function: { ...tc.function, arguments: encoded } };
  return { ...tc, arguments: encoded };
}

function isStubText(content) {
  if (typeof content === 'string') return /\[bound(?:, \d+ chars)?\]/.test(content);
  if (Array.isArray(content)) return content.some((b) => isStubText(typeof b === 'string' ? b : b?.text ?? b?.content));
  return false;
}

function toolContentLength(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((n, b) => n + (typeof b === 'string' ? b.length : String(b?.text ?? b?.content ?? '').length), 0);
  }
  if (content && typeof content === 'object') return JSON.stringify(content).length;
  return 0;
}

function toolContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === 'string' ? b : String(b?.text ?? b?.content ?? ''))).join('');
  }
  if (content && typeof content === 'object') return JSON.stringify(content);
  return content == null ? '' : String(content);
}

/** Normalize a recall hook result to text. Empty means a miss. */
export function recallText(got) {
  if (got == null) return '';
  if (typeof got === 'string') return got;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(got)) return got.toString('utf8');
  if (typeof got === 'object') {
    if (typeof got.text === 'string') return got.text;
    if (typeof got.content === 'string') return got.content;
    if (typeof got.bytes === 'string') return got.bytes;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(got.bytes)) return got.bytes.toString('utf8');
  }
  return '';
}

/** True when recalled text is non-empty and overlaps the original body. */
export function recallOverlapsBody(recalled, body) {
  const a = recallText(recalled);
  const b = toolContentText(body);
  if (!a || !b) return false;
  if (b.includes(a) || a.includes(b)) return true;
  const n = Math.min(32, a.length, b.length);
  if (n < 1) return false;
  for (let i = 0; i + n <= a.length; i += Math.max(1, Math.floor(n / 2))) {
    if (b.includes(a.slice(i, i + n))) return true;
  }
  return false;
}

/**
 * Probe `recall` for this tool_result / file. True only when the hook
 * actually produced overlapping bytes — not when we merely think the
 * path is bound.
 */
export function recallReturnedBytes(recall, item = {}) {
  if (typeof recall !== 'function') return false;
  let got;
  try {
    const content = toolContentText(item.content);
    got = recall({
      id: item.id,
      paths: item.paths || [],
      content,
      query: item.query || (Array.isArray(item.paths) && item.paths[0]) || content.slice(0, 80),
    });
  } catch {
    return false;
  }
  return recallOverlapsBody(got, item.content);
}

/**
 * Local recall over already-bound corpus text. Hard-proof stand-in when a
 * live HRR probe is not available: the exact bytes must be in the corpus
 * AND the probe must return a non-empty overlapping slice.
 */
export function corpusRecall(corpus) {
  const text = typeof corpus === 'string' ? corpus : '';
  return (item = {}) => {
    if (!text) return '';
    const body = toolContentText(item.content);
    const snippet = body.length >= 16 ? body.slice(0, 64) : body;
    if (snippet && text.includes(snippet)) {
      const i = text.indexOf(snippet);
      return text.slice(i, i + Math.min(Math.max(body.length, snippet.length), 8192));
    }
    return '';
  };
}

function resolveBoundPath(raw, cwd, boundAbs) {
  if (!boundAbs?.size) return null;
  const t = typeof raw === 'string' ? raw.trim() : '';
  if (!t) return null;
  const abs = resolveReadablePath(t, cwd);
  if (abs && boundAbs.has(abs)) return abs;
  if (boundAbs.has(t)) return t;
  return null;
}

/**
 * After a file is bound, drop its tool_result / file body from the forwarded
 * tail. Keep the path and a short marker. Shipping those bytes again makes
 * sent ≈ corpus and the gateway's `counterfactualTokens > promptTokens`
 * gate barely fires (live: 5MB filebind, lastSend 13/107, savingX 1.22
 * instead of ~7x).
 *
 * A `[bound]` marker is a promise that HRR recall can return those bytes.
 * `boundAbs` / `boundFiles` only means we think we bound the path — that
 * is not proof. On the SHRINK_OVER path (tail over `budget`), and whenever
 * a `recall` hook is installed on a budgeted tail, stub only if recall
 * actually returns non-empty overlapping content. Prefer the original body
 * over a lying stub (context missing, file not in corpus, recall miss).
 *
 * Cheap rewrite — no disk I/O. First-read results (not yet in boundAbs) and
 * non-file tool output stay verbatim UNLESS `aggressive` / `stubMore` or a
 * tail `budget` is set. Those two are what beat a WebSearch/Fetch/Bash
 * storm: the 800-byte floor cannot move `cut` inside a tool chain
 * (`isSeverable` is false), so the byte budget has to win by stubbing
 * bodies (and fat tool_call JSON) instead of orphaning a pairing.
 *
 * `keepTail` is the vote cutTranscript cannot cast on an un-severable
 * chain: drop older complete tool_call + tool_result pairs (rewrite the
 * assistant's tool_calls, do not leave orphans). Live 0.48.75: keep 16/8/6/2
 * all cut at the same index and left ~728k after file-only stubs.
 *
 * `fromIndex` limits the rewrite to the forwarded tail so the spilled prefix
 * that becomes the conversation corpus is unchanged. The last user ask is
 * never rewritten. The current tool round is only the most recent assistant
 * tool_calls / tool_use in that tail, plus tool results for those ids — not
 * every Read/Bash/Search after the last user ask. In-flight latest bodies
 * stay even when large. KEEP_TOOL_CHARS applies only to that last round so
 * a 461-byte Read survives a follow-up ask.
 *
 * After the last user ask, remaining Read/Edit/Write / Bash-file bodies
 * stay verbatim. Drop older post-ask rounds (trimRoundsAfterAsk) instead
 * of rewriting them to `[bound, N chars]` — a placeholder in the live tail
 * is 76-style blindness (model cats files). Fat WebSearch/Fetch in older
 * kept rounds may still stub. stubMore tightens SEARCH, not live files.
 */
export function stubBoundFileResults(msgs, {
  boundFiles,
  boundAbs,
  cwd = process.cwd(),
  fromIndex = 0,
  // When the live tuner is below target, stub file-view results even if
  // this turn has not yet recorded them in boundAbs (first-read bodies).
  // Also stubs fat non-file tools (WebSearch / Fetch / Bash) and fat
  // tool_call argument JSON.
  aggressive = false,
  // When the forwarded tail is over this many chars, stub older tool_result
  // bodies and fat tool_call JSON (oldest first) until it fits. Pairing
  // stays; the ask stays. If still over, drop older complete pairs.
  budget = null,
  // How many complete tool pairs to keep at the end of an un-severable
  // assistant(tool_calls)+results chain. Ignored when the tail is severable.
  keepTail = null,
  fatChars = FAT_TOOL_CHARS,
  // (query) => bytes. SHRINK_OVER [bound] stubs require a non-empty
  // overlapping hit. boundFiles alone is not enough.
  recall = null,
} = {}) {
  const absSet = boundAbs || boundAbsFromKeys(boundFiles);
  const wantBudget = budget != null && Number.isFinite(Number(budget));
  const wantKeep = keepTail != null && Number.isFinite(Number(keepTail));
  if (!Array.isArray(msgs) || (!absSet.size && !aggressive && !wantBudget && !wantKeep)) {
    return { messages: msgs, stubbed: 0, dropped: 0 };
  }

  const stubIds = new Set();
  const fileIds = new Set();
  const afterAskIds = new Set();
  const idPaths = new Map();
  let currentCwd = cwd;

  const noteCall = (c) => {
    const id = c?.id || c?.tool_call_id;
    const args = parseArgs(c?.function?.arguments ?? c?.arguments);
    if (id && isLiveFileTool(toolFnName(c), args)) fileIds.add(id);
    const raws = [];
    collectStructuredPaths(args, raws);
    if (typeof args.command === 'string' && looksLikeFileView(args.command)) {
      for (const p of extractBashPaths(args.command, currentCwd).paths) raws.push(p.raw);
    }
    const resolved = [];
    for (const raw of raws) {
      const hit = resolveBoundPath(raw, currentCwd, absSet);
      if (hit) resolved.push(hit);
      else if (aggressive && raw) resolved.push(resolveReadablePath(raw, currentCwd) || raw);
    }
    if (!resolved.length || !id) return;
    stubIds.add(id);
    idPaths.set(id, [...(idPaths.get(id) || []), ...resolved]);
  };

  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'tool' && typeof m.content === 'string') {
      const hint = parseCwdHint(m.content);
      if (hint) currentCwd = hint;
    }
    const calls = [
      ...(Array.isArray(m.tool_calls) ? m.tool_calls : []),
      ...(m.function_call ? [m.function_call] : []),
    ];
    for (const c of calls) noteCall(c);
    const blocks = Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (b?.type === 'tool_use') {
        noteCall({ id: b.id, arguments: b.input, function: { name: b.name, arguments: b.input } });
      }
    }
  }

  const firstSpillable = firstSpillableIndex(msgs);
  let lastUser = lastUserAskIndex(msgs, firstSpillable);
  const fatLimit = Number.isFinite(Number(fatChars)) ? Number(fatChars) : FAT_TOOL_CHARS;
  const keepFloor = KEEP_TOOL_CHARS;
  const slimArgs = aggressive || wantBudget;
  let round = currentToolRound(msgs, { lastUser, fromIndex });

  const markAfterAsk = (list) => {
    afterAskIds.clear();
    if (lastUser < 0 || !Array.isArray(list)) return;
    for (let i = lastUser + 1; i < list.length; i++) {
      for (const id of toolCallIds(list[i])) afterAskIds.add(id);
    }
  };
  markAfterAsk(msgs);

  const stubFor = (id, n) => {
    const paths = idPaths.get(id);
    return paths?.length ? fileBoundStub(paths, n) : toolResultStub(n);
  };

  const shouldStubBody = (id, n, { overBudget = false } = {}) => {
    if (!n || isStubText(typeof n === 'number' ? '' : n)) return false;
    // Latest in-flight batch (after the ask): never stub, even if fat.
    if (id && round.inFlight && round.ids.has(id)) return false;
    // Last completed batch (ask follows): keep small bodies only.
    if (id && round.ids.has(id) && n < keepFloor) return false;
    // Remaining post-ask file bodies stay real. Drop the round instead.
    if (id && afterAskIds.has(id) && fileIds.has(id)) return false;
    if (stubIds.has(id)) return true;
    if (slimArgs && n >= fatLimit) return true;
    if (overBudget && n > 0) return true;
    return false;
  };

  const recallCache = new Map();
  const probeRecall = (id, content) => {
    const key = id || toolContentText(content);
    if (recallCache.has(key)) return recallCache.get(key);
    const ok = recallReturnedBytes(recall, {
      id,
      content,
      paths: idPaths.get(id) || [],
    });
    recallCache.set(key, ok);
    return ok;
  };

  const allowBoundStub = (id, content, { overBudget = false } = {}) => {
    // SHRINK_OVER leftovers always need real recall bytes (fail closed
    // when no hook is installed). When a recall hook is installed on a
    // budgeted tail, every [bound] claim uses the same gate.
    if (overBudget || (wantBudget && typeof recall === 'function')) {
      return probeRecall(id, content);
    }
    return true;
  };

  let stubbed = 0;
  let dropped = 0;
  let messages = msgs;

  // keepTail votes here because cutTranscript cannot move inside the chain
  // *or* past the last user ask. A continue turn stacks severable
  // assistant+result rounds after that ask; trim those older rounds first
  // so lastSend cannot grow to hundreds of fully-billed messages.
  if (wantKeep) {
    messages = trimRoundsAfterAsk(messages, {
      fromIndex,
      keepTail: Number(keepTail),
      lastUser,
    });
    lastUser = lastUserAskIndex(messages, firstSpillableIndex(messages));
    messages = trimUnseverablePairs(messages, {
      fromIndex,
      keepTail: Number(keepTail),
      lastUser,
      firstSpillable: firstSpillableIndex(messages),
    });
    lastUser = lastUserAskIndex(messages, firstSpillableIndex(messages));
    markAfterAsk(messages);
    round = currentToolRound(messages, { lastUser, fromIndex });
  }

  const skipSlimCalls = (i) => round.inFlight && i === round.index;

  messages = messages.map((m, i) => {
    if (i < fromIndex || !m || i === lastUser) return m;
    if (m.role === 'tool') {
      const n = toolContentLength(m.content);
      if (!shouldStubBody(m.tool_call_id, n) || isStubText(m.content)) return m;
      if (!allowBoundStub(m.tool_call_id, m.content)) return m;
      dropped += n;
      stubbed += 1;
      return { ...m, content: stubFor(m.tool_call_id, n) };
    }
    let next = m;
    if (Array.isArray(m.tool_calls) && slimArgs && !skipSlimCalls(i)) {
      let changed = false;
      const calls = m.tool_calls.map((tc) => {
        const n = toolCallArgLength(tc);
        const raw = tc?.function?.arguments ?? tc?.arguments;
        if (n < fatLimit || isStubText(typeof raw === 'string' ? raw : '')) return tc;
        dropped += n;
        stubbed += 1;
        changed = true;
        return slimToolCallArgs(tc, n);
      });
      if (changed) next = { ...next, tool_calls: calls };
    }
    if (next.function_call && slimArgs && !skipSlimCalls(i)) {
      const n = toolCallArgLength(next.function_call);
      const raw = next.function_call.arguments;
      if (n >= fatLimit && !isStubText(typeof raw === 'string' ? raw : '')) {
        dropped += n;
        stubbed += 1;
        next = { ...next, function_call: slimToolCallArgs(next.function_call, n) };
      }
    }
    if (!Array.isArray(next.content)) return next;
    let changed = false;
    const blocks = next.content.map((b) => {
      if (b?.type !== 'tool_result') return b;
      const n = toolContentLength(b.content);
      if (!shouldStubBody(b.tool_use_id, n) || isStubText(b.content)) return b;
      if (!allowBoundStub(b.tool_use_id, b.content)) return b;
      dropped += n;
      stubbed += 1;
      changed = true;
      return { ...b, content: stubFor(b.tool_use_id, n) };
    });
    return changed ? { ...next, content: blocks } : next;
  });

  // SHRINK_OVER: byte budget wins inside a tool chain. cutTranscript cannot
  // move tailStart past assistant(tool_calls) / role:tool (pairing 400s the
  // provider), so a 300-result storm used to ride in at ~728k after file-only
  // stubs. Stub bodies first, then fat tool_call JSON; if still over, drop
  // older pairs. Never drop the ask. Never orphan a remaining tool_result.
  // Never write `[bound]` unless recall returned those bytes.
  if (wantBudget) {
    const cap = Number(budget);
    let used = sliceChars(messages, fromIndex);
    if (used > cap) {
      const next = messages.slice();
      for (let i = fromIndex; i < next.length && used > cap; i++) {
        if (i === lastUser) continue;
        const m = next[i];
        if (!m) continue;
        if (m.role === 'tool') {
          if (isStubText(m.content)) continue;
          const n = toolContentLength(m.content);
          if (!shouldStubBody(m.tool_call_id, n, { overBudget: true })) continue;
          if (!allowBoundStub(m.tool_call_id, m.content, { overBudget: true })) continue;
          const stub = stubFor(m.tool_call_id, n);
          if (stub.length >= n) continue;
          used = used - n + stub.length;
          next[i] = { ...m, content: stub };
          stubbed += 1;
          dropped += n;
          continue;
        }
        if (Array.isArray(m.tool_calls) && !skipSlimCalls(i)) {
          let changed = false;
          const calls = m.tool_calls.map((tc) => {
            if (used <= cap) return tc;
            const n = toolCallArgLength(tc);
            const raw = tc?.function?.arguments ?? tc?.arguments;
            if (n < fatLimit || isStubText(typeof raw === 'string' ? raw : '')) return tc;
            const slim = slimToolCallArgs(tc, n);
            const after = toolCallArgLength(slim);
            if (after >= n) return tc;
            used = used - n + after;
            stubbed += 1;
            dropped += n;
            changed = true;
            return slim;
          });
          if (changed) next[i] = { ...m, tool_calls: calls };
        }
        if (!Array.isArray((next[i] || m).content)) continue;
        const cur = next[i];
        let changed = false;
        const blocks = cur.content.map((b) => {
          if (b?.type !== 'tool_result' || used <= cap || isStubText(b.content)) return b;
          const n = toolContentLength(b.content);
          if (!shouldStubBody(b.tool_use_id, n, { overBudget: true })) return b;
          if (!allowBoundStub(b.tool_use_id, b.content, { overBudget: true })) return b;
          const stub = stubFor(b.tool_use_id, n);
          if (stub.length >= n) return b;
          used = used - n + stub.length;
          stubbed += 1;
          dropped += n;
          changed = true;
          return { ...b, content: stub };
        });
        if (changed) next[i] = { ...cur, content: blocks };
      }
      messages = next;
      used = sliceChars(messages, fromIndex);
      if (used > cap) {
        // Still over: drop older post-ask rounds rather than rewriting
        // remaining file bodies to `[bound]`. Then trim an un-severable
        // last chain. Latest batch stays.
        messages = trimRoundsAfterAsk(messages, {
          fromIndex,
          keepTail: 1,
          lastUser,
        });
        lastUser = lastUserAskIndex(messages, firstSpillableIndex(messages));
        messages = trimUnseverablePairs(messages, {
          fromIndex,
          keepTail: 1,
          lastUser,
          firstSpillable: firstSpillableIndex(messages),
        });
      }
    }
  }

  return { messages, stubbed, dropped };
}

export const ADAPT_TARGET = 10;
export const ADAPT_LOOSEN_AT = 20;
/** lastSend growing past this while dollar x < target is a tighten signal. */
export const LAST_SEND_TIGHTEN = 24;

export const KNOB_DEFAULTS = Object.freeze({
  keepTail: 8,
  minTurns: 6,
  budget: SHRINK_OVER,
  stubMore: false,
});

const KEEP_STEPS = [2, 3, 4, 6, 8, 12, 16];
const TURNS_STEPS = [2, 3, 4, 6, 8, 12];
const BUDGET_STEPS = [800, 1500, 2500, 4000, 6000, 9000, 12000, 18000, 24000];

/** Flatten one Anthropic content block to text leCore can index. */
export function blockText(b) {
  if (typeof b === 'string') return b;
  if (!b || typeof b !== 'object') return '';
  if (b.type === 'text') return b.text || '';
  if (b.type === 'tool_use') return `[tool_use ${b.name}] ${JSON.stringify(b.input ?? {})}`;
  if (b.type === 'tool_result') {
    const c = b.content;
    return `[tool_result] ${typeof c === 'string' ? c : (Array.isArray(c) ? c.map(blockText).join('\n') : JSON.stringify(c ?? ''))}`;
  }
  if (b.type === 'thinking') return '';
  return '';
}

export function msgText(m) {
  const c = m?.content;
  const body = typeof c === 'string' ? c : (Array.isArray(c) ? c.map(blockText).filter(Boolean).join('\n') : '');
  return body ? `${(m.role || '?').toUpperCase()}: ${body}` : '';
}

/** Characters that actually ride in a forwarded message (content + tool_calls). */
export function messageChars(m) {
  if (!m) return 0;
  let n = 0;
  const c = m.content;
  if (typeof c === 'string') n += c.length;
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (typeof b === 'string') n += b.length;
      else if (b && typeof b === 'object') {
        if (typeof b.text === 'string') n += b.text.length;
        else if (typeof b.content === 'string') n += b.content.length;
        else if (b.content != null) n += toolContentLength(b.content);
        else n += JSON.stringify(b).length;
      }
    }
  } else if (c && typeof c === 'object') n += JSON.stringify(c).length;
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) n += toolCallArgLength(tc);
  }
  const legacy = m.function_call;
  if (legacy) n += toolCallArgLength(legacy);
  return n;
}

export function sliceChars(msgs, from = 0, to = undefined) {
  if (!Array.isArray(msgs)) return 0;
  const end = to == null ? msgs.length : to;
  let n = 0;
  for (let i = from; i < end && i < msgs.length; i++) n += messageChars(msgs[i]);
  return n;
}

export function spillRatio(corpusChars, sentChars) {
  const c = Number(corpusChars) || 0;
  const s = Number(sentChars) || 0;
  if (s <= 0) return c > 0 ? Infinity : 0;
  return c / s;
}

function envNumber(key, fallback) {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function envKnobs() {
  return {
    keepTail: envNumber('OPENZOO_KEEP_TAIL_MSGS', KNOB_DEFAULTS.keepTail),
    minTurns: envNumber('OPENZOO_TAIL_MIN_TURNS', KNOB_DEFAULTS.minTurns),
    budget: envNumber('OPENZOO_TAIL_MAX_CHARS', KNOB_DEFAULTS.budget),
    stubMore: process.env.OPENZOO_STUB_MORE === '1',
  };
}

export function adaptEnabled() {
  return process.env.OPENZOO_ADAPT !== '0';
}

export function knobsFile(home = os.homedir()) {
  return process.env.OPENZOO_KNOBS_PATH
    || path.join(home, '.openzoo', 'knobs.json');
}

function clampInt(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

export function sanitizeKnobs(raw = {}) {
  if (!raw || typeof raw !== 'object') return { ...KNOB_DEFAULTS };
  return {
    keepTail: clampInt(raw.keepTail, KEEP_STEPS[0], KEEP_STEPS[KEEP_STEPS.length - 1], KNOB_DEFAULTS.keepTail),
    minTurns: clampInt(raw.minTurns, TURNS_STEPS[0], TURNS_STEPS[TURNS_STEPS.length - 1], KNOB_DEFAULTS.minTurns),
    budget: clampInt(raw.budget, BUDGET_STEPS[0], BUDGET_STEPS[BUDGET_STEPS.length - 1], KNOB_DEFAULTS.budget),
    stubMore: Boolean(raw.stubMore),
  };
}

export function loadKnobs(extra = {}) {
  const file = extra.file || knobsFile(extra.home);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, reason: 'missing' }; }
  let data;
  try { data = JSON.parse(raw); } catch { return { ok: false, reason: 'corrupt' }; }
  if (!data || typeof data !== 'object') return { ok: false, reason: 'corrupt' };
  return { ok: true, knobs: sanitizeKnobs(data) };
}

export function persistKnobs(knobs, extra = {}) {
  const file = extra.file || knobsFile(extra.home);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(sanitizeKnobs(knobs)));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

let memoryKnobs = null;
let lastAdaptAction = 'hold';
let knobsLoaded = false;

export function resetAdaptState(knobs = null) {
  memoryKnobs = knobs ? sanitizeKnobs(knobs) : null;
  lastAdaptAction = 'hold';
  knobsLoaded = false;
}

export function lastAdapt() {
  return lastAdaptAction;
}

export function getLiveKnobs(extra = {}) {
  if (!adaptEnabled()) return envKnobs();
  if (memoryKnobs) return { ...memoryKnobs };
  if (!knobsLoaded) {
    knobsLoaded = true;
    const loaded = loadKnobs(extra);
    if (loaded.ok) {
      memoryKnobs = sanitizeKnobs({ ...envKnobs(), ...loaded.knobs });
      return { ...memoryKnobs };
    }
  }
  memoryKnobs = envKnobs();
  return { ...memoryKnobs };
}

export function rememberKnobs(knobs, extra = {}) {
  memoryKnobs = sanitizeKnobs(knobs);
  if (extra.persist !== false) persistKnobs(memoryKnobs, extra);
  return { ...memoryKnobs };
}

function nearestIndex(steps, value) {
  let best = 0;
  let dist = Infinity;
  for (let i = 0; i < steps.length; i++) {
    const d = Math.abs(steps[i] - value);
    if (d < dist) { dist = d; best = i; }
  }
  return best;
}

export function tightenKnobs(knobs, { ratio, corpusChars, target = ADAPT_TARGET } = {}) {
  const cur = sanitizeKnobs(knobs);
  const gap = target / Math.max(Number(ratio) || 0.01, 0.01);
  // Mild miss: one notch. Far below target (live 1–4x): jump toward the
  // floor so a single recut can clear 10x. Always stub more on the way down.
  const steps = gap > 1.5 ? 2 : 1;
  const keepI = Math.max(0, nearestIndex(KEEP_STEPS, cur.keepTail) - steps);
  const turnI = Math.max(0, nearestIndex(TURNS_STEPS, cur.minTurns) - steps);
  let budget = cur.budget;
  for (let i = 0; i < steps; i++) {
    budget = BUDGET_STEPS[Math.max(0, nearestIndex(BUDGET_STEPS, budget) - 1)];
  }
  if (gap > 1.5 && Number.isFinite(corpusChars) && corpusChars > 0) {
    const needSent = Math.floor(corpusChars / target);
    if (needSent > 0) budget = Math.min(budget, Math.max(BUDGET_STEPS[0], needSent));
    return sanitizeKnobs({
      keepTail: KEEP_STEPS[0],
      minTurns: TURNS_STEPS[0],
      budget,
      stubMore: true,
    });
  }
  return sanitizeKnobs({
    keepTail: KEEP_STEPS[keepI],
    minTurns: TURNS_STEPS[turnI],
    budget,
    stubMore: true,
  });
}

export function loosenKnobs(knobs) {
  const cur = sanitizeKnobs(knobs);
  const keepI = Math.min(KEEP_STEPS.length - 1, nearestIndex(KEEP_STEPS, cur.keepTail) + 1);
  const turnI = Math.min(TURNS_STEPS.length - 1, nearestIndex(TURNS_STEPS, cur.minTurns) + 1);
  const budI = Math.min(BUDGET_STEPS.length - 1, nearestIndex(BUDGET_STEPS, cur.budget) + 1);
  return sanitizeKnobs({
    keepTail: KEEP_STEPS[keepI],
    minTurns: TURNS_STEPS[turnI],
    budget: BUDGET_STEPS[budI],
    stubMore: false,
  });
}

function sameKnobs(a, b) {
  return a.keepTail === b.keepTail
    && a.minTurns === b.minTurns
    && a.budget === b.budget
    && Boolean(a.stubMore) === Boolean(b.stubMore);
}

function fmtRatio(ratio) {
  if (!Number.isFinite(ratio)) return 'inf';
  return String(Number(ratio.toFixed(2)));
}

function adaptLine({ action, ratio, knobs, target = ADAPT_TARGET, dollarX } = {}) {
  const d = Number(dollarX);
  const hasD = Number.isFinite(d) && d > 0;
  const via = hasD
    ? `dollar=${fmtRatio(d)} chars=${fmtRatio(ratio)}`
    : `ratio=${fmtRatio(ratio)}`;
  if (action === 'hold') return `adapt hold ${via}`;
  return `adapt ${via} target=${target} tail=${knobs.keepTail} budget=${knobs.budget}`;
}

/**
 * Decide whether to shrink, loosen, or hold.
 *
 * Score the HUD dollar multiple (direct/billed) when present. Char ratio
 * is the fallback only. Tighten recuts this request. Loosen only when the
 * scored metric is above loosenAt AND last action was hold — never loosen
 * off a char-only overshoot while dollar x is in hand and below loosenAt.
 */
export function adaptTail({
  ratio,
  dollarX,
  lastSend,
  knobs,
  lastAction = 'hold',
  corpusChars,
  target = ADAPT_TARGET,
  loosenAt = ADAPT_LOOSEN_AT,
} = {}) {
  const cur = sanitizeKnobs(knobs);
  const dollar = Number(dollarX);
  const hasDollar = Number.isFinite(dollar) && dollar > 0;
  const score = hasDollar ? dollar : Number(ratio);
  const sendN = Number(lastSend);
  const sendGrowing = Number.isFinite(sendN) && sendN > LAST_SEND_TIGHTEN;
  const line = (action, knobsNow) => adaptLine({
    action, ratio, knobs: knobsNow, target, dollarX: hasDollar ? dollar : undefined,
  });
  if (!Number.isFinite(score)) {
    return { action: 'hold', knobs: cur, recut: false, ratio, dollarX: hasDollar ? dollar : null, score, log: line('hold', cur) };
  }
  // Dollar miss, or lastSend growing while dollar x is under target.
  if (score < target || (hasDollar && dollar < target && sendGrowing)) {
    const next = tightenKnobs(cur, { ratio: score, corpusChars, target });
    const changed = !sameKnobs(next, cur);
    const action = changed ? 'tighten' : 'hold';
    return { action, knobs: next, recut: changed, ratio, dollarX: hasDollar ? dollar : null, score, log: line(action, next) };
  }
  if (score > loosenAt && lastAction === 'hold') {
    const next = loosenKnobs(cur);
    const changed = !sameKnobs(next, cur);
    const action = changed ? 'loosen' : 'hold';
    return { action, knobs: next, recut: false, ratio, dollarX: hasDollar ? dollar : null, score, log: line(action, next) };
  }
  return { action: 'hold', knobs: cur, recut: false, ratio, dollarX: hasDollar ? dollar : null, score, log: line('hold', cur) };
}

function firstSpillableIndex(msgs) {
  return msgs.findIndex((m) => m?.role !== 'system');
}

function lastUserAskIndex(msgs, firstSpillable) {
  for (let i = msgs.length - 1; i > firstSpillable; i--) {
    if (msgs[i]?.role === 'user' && msgText(msgs[i]).trim()) return i;
  }
  return -1;
}

function countRealTurns(msgs, from, to = msgs.length) {
  let n = 0;
  for (let i = from; i < to; i++) {
    const r = msgs[i]?.role;
    if (r === 'user' || r === 'assistant') n += 1;
  }
  return n;
}

function isSeverable(msgs, i, firstSpillable) {
  if (i <= firstSpillable || i >= msgs.length) return false;
  const prev = msgs[i - 1];
  if (!prev) return false;
  if (prev.role === 'assistant' && Array.isArray(prev.tool_calls) && prev.tool_calls.length) return false;
  return msgs[i].role !== 'tool';
}

/**
 * cutTranscript pins `cut` at the last user ask, so every later tool round
 * on a continue / ultracode turn used to ride in the forwarded tail. Keep
 * the newest `keepTail` complete assistant(tool_calls)+results rounds after
 * that ask and drop the older ones. Pairing stays valid; the ask stays;
 * the latest round is never dropped.
 */
export function trimRoundsAfterAsk(msgs, {
  fromIndex = 0,
  keepTail = 1,
  lastUser = -1,
} = {}) {
  if (!Array.isArray(msgs) || lastUser < 0) return msgs;
  const keep = Math.max(1, Math.round(Number(keepTail) || 1));
  const start = Math.max(fromIndex, lastUser + 1);
  const starts = [];
  for (let i = start; i < msgs.length; i++) {
    if (toolCallIds(msgs[i]).length) starts.push(i);
  }
  if (starts.length <= keep) return msgs;
  const keepFrom = starts[starts.length - keep];
  const out = [];
  for (let i = 0; i < msgs.length; i++) {
    if (i > lastUser && i < keepFrom) continue;
    out.push(msgs[i]);
  }
  return out;
}

/**
 * On an un-severable assistant(tool_calls)+results chain, keepTail cannot
 * move `cut`. Drop older complete pairs (rewrite tool_calls, drop their
 * results) so keep 16 vs 2 actually differ and the byte budget can land.
 */
export function trimUnseverablePairs(msgs, {
  fromIndex = 0,
  keepTail = 2,
  lastUser = -1,
  firstSpillable = 0,
} = {}) {
  if (!Array.isArray(msgs) || !msgs.length) return msgs;
  const keep = Math.max(1, Math.round(Number(keepTail) || 2));
  const end = lastUser > fromIndex ? lastUser : msgs.length;
  let asstIdx = -1;
  for (let i = fromIndex; i < end; i++) {
    if (Array.isArray(msgs[i]?.tool_calls) && msgs[i].tool_calls.length) {
      asstIdx = i;
      break;
    }
  }
  if (asstIdx < 0) return msgs;
  for (let i = asstIdx + 1; i < end; i++) {
    if (isSeverable(msgs, i, firstSpillable)) return msgs;
  }
  const calls = msgs[asstIdx].tool_calls;
  if (calls.length <= keep) return msgs;
  const keptCalls = calls.slice(-keep);
  const keptIds = new Set(keptCalls.map((c) => c.id).filter(Boolean));
  const out = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (i === asstIdx) {
      out.push({ ...m, tool_calls: keptCalls });
      continue;
    }
    if (i > asstIdx && i !== lastUser && m?.role === 'tool' && m.tool_call_id && !keptIds.has(m.tool_call_id)) {
      continue;
    }
    if (i > asstIdx && i !== lastUser && Array.isArray(m?.content)) {
      const blocks = m.content.filter((b) => b?.type !== 'tool_result' || keptIds.has(b.tool_use_id));
      if (blocks.length !== m.content.length) {
        if (!blocks.length && m.role !== 'assistant') continue;
        out.push({ ...m, content: blocks });
        continue;
      }
    }
    out.push(m);
  }
  return out;
}

/**
 * Pick a severable cut: keep a recent tail, honour the byte budget, floor
 * at minTurns of user/assistant on a LONG thread, and never drop the last
 * user ask. minTurns must not empty the bind prefix — a short AUTO thread
 * binds early turns and may forward a tail with fewer than minTurns.
 */
export function cutTranscript(msgs, knobs = {}) {
  const k = sanitizeKnobs({ ...envKnobs(), ...knobs });
  if (!Array.isArray(msgs) || !msgs.length) {
    return { cut: -1, firstSpillable: -1, lastUser: -1, knobs: k };
  }
  const firstSpillable = firstSpillableIndex(msgs);
  if (firstSpillable < 0) return { cut: -1, firstSpillable: -1, lastUser: -1, knobs: k };

  const keepTail = Math.min(k.keepTail, Math.max(2, Math.floor(msgs.length / 2)));
  const minTurns = Math.max(2, k.minTurns);
  const budget = k.budget;

  let cut = -1;
  for (let i = msgs.length - keepTail; i > firstSpillable; i--) {
    if (isSeverable(msgs, i, firstSpillable)) { cut = i; break; }
  }
  if (cut <= firstSpillable) {
    for (let i = msgs.length - 2; i > firstSpillable; i--) {
      if (isSeverable(msgs, i, firstSpillable)) { cut = i; break; }
    }
  }
  if (cut <= firstSpillable) {
    return { cut: -1, firstSpillable, lastUser: lastUserAskIndex(msgs, firstSpillable), knobs: k };
  }

  // Only moves the cut at a severable index. A current-turn tool storm
  // (assistant(tool_calls) + N tool results + user ask) has no severable
  // index inside the chain, so this walk is a no-op — the byte budget is
  // applied by stubbing bodies in stubBoundFileResults, not by orphaning
  // a tool_result.
  let tailStart = cut;
  {
    let used = 0;
    for (let i = msgs.length - 1; i >= cut; i--) {
      used += msgText(msgs[i]).length;
      if (used > budget && isSeverable(msgs, i, firstSpillable)) { tailStart = i; break; }
    }
  }
  if (tailStart > cut) cut = tailStart;

  const lastUser = lastUserAskIndex(msgs, firstSpillable);

  // minTurns may still size the tail on a long thread. If walking earlier
  // would empty the bind prefix (the old firstSpillable+1 fallback), keep a
  // non-empty prefix and allow fewer than minTurns in the tail. On a short
  // thread that cannot satisfy minTurns at all, pin the last ask so early
  // user/assistant turns bind instead of riding in the forwarded tail.
  if (countRealTurns(msgs, cut) < minTurns) {
    let moved = false;
    for (let i = cut - 1; i > firstSpillable; i--) {
      if (isSeverable(msgs, i, firstSpillable) && countRealTurns(msgs, i) >= minTurns) {
        cut = i;
        moved = true;
        break;
      }
    }
    if (!moved && lastUser > firstSpillable && isSeverable(msgs, lastUser, firstSpillable)) {
      cut = lastUser;
    }
  }

  if (lastUser > firstSpillable && cut > lastUser) cut = lastUser;

  // 2-real-turn floor protects the last user ask: never drop it, and expand
  // the tail to two turns on a LONG thread. Do not steal the first
  // user+assistant pair from the prefix just to pad a short tail.
  if (lastUser > firstSpillable && countRealTurns(msgs, cut) < 2) {
    for (let i = cut - 1; i > firstSpillable; i--) {
      if (!isSeverable(msgs, i, firstSpillable) || countRealTurns(msgs, i) < 2) continue;
      if (countRealTurns(msgs, firstSpillable, i) < 2) continue;
      cut = i;
      break;
    }
    if (cut > lastUser) cut = lastUser;
  }

  return { cut, firstSpillable, lastUser, knobs: k };
}

/** Opening slice used as a content-anchor when no session header is sent. */
export const SPILL_CONTENT_ANCHOR_CHARS = 2048;

/**
 * Find a memoized / ledger bind for this request. Prefers an explicit
 * session key; otherwise matches a stored prefix so a growing content-anchor
 * (grokui AUTO sends no session header) still recalls the same contextId.
 */
export function lookupSpillMemo(spillMemo, sessionLedger, { sessionKey, corpus } = {}) {
  if (sessionKey && spillMemo?.has(sessionKey)) {
    return { key: sessionKey, source: 'memo', ...spillMemo.get(sessionKey) };
  }
  if (sessionKey && sessionLedger?.has(sessionKey)) {
    const led = sessionLedger.get(sessionKey);
    if (led?.contextId) return { key: sessionKey, source: 'ledger', restored: !led.corpus, ...led };
  }
  if (corpus && spillMemo) {
    for (const [k, v] of spillMemo) {
      if (typeof v?.corpus === 'string' && v.corpus.length && corpus.startsWith(v.corpus)) {
        return { key: k, source: 'memo-prefix', ...v };
      }
    }
    const opening = corpus.slice(0, SPILL_CONTENT_ANCHOR_CHARS);
    for (const [k, v] of spillMemo) {
      if (typeof k !== 'string' || k.startsWith('sid:')) continue;
      if (opening.startsWith(k) || (k && k.startsWith(opening))) {
        return { key: k, source: 'memo-anchor', ...v };
      }
    }
  }
  return null;
}

export function rememberSpillMemo(spillMemo, key, entry, { max = 32 } = {}) {
  if (!spillMemo || !key) return;
  spillMemo.set(key, entry);
  while (spillMemo.size > max) spillMemo.delete(spillMemo.keys().next().value);
}

/**
 * Decide first-bind vs later-turn recall. No I/O — bindCorpus is injected
 * by the caller (or mocked in tests).
 *
 *   cold-bind     — fire-and-forget first bind; this turn may go unspilled
 *   await-pending — later turn while that bind is in flight; await, then tail
 *   recall        — contextId known; send tail (+ optional delta append)
 */
export function planConversationBind({ sessionKey, corpus, spillMemo, sessionLedger } = {}) {
  const key = sessionKey || (corpus ? corpus.slice(0, SPILL_CONTENT_ANCHOR_CHARS) : null);
  const prior = lookupSpillMemo(spillMemo, sessionLedger, { sessionKey: key, corpus });
  if (!prior) {
    return { action: 'cold-bind', send: 'full', key, corpus };
  }
  if (prior.pending && !prior.contextId) {
    return {
      action: 'await-pending',
      send: 'tail',
      key: prior.key || key,
      corpus,
      ready: prior.ready,
    };
  }
  if (prior.contextId) {
    let delta = '';
    let append = false;
    if (prior.restored) {
      append = true;
    } else if (typeof prior.corpus === 'string' && corpus.startsWith(prior.corpus) && corpus.length > prior.corpus.length) {
      delta = corpus.slice(prior.corpus.length);
      append = true;
    }
    return {
      action: 'recall',
      send: 'tail',
      key: prior.key || key,
      corpus,
      contextId: prior.contextId,
      hash: prior.hash,
      reused: true,
      append,
      delta,
      restored: Boolean(prior.restored),
    };
  }
  return { action: 'cold-bind', send: 'full', key, corpus };
}

/**
 * Cut the transcript and plan the conversation bind. Tests use this instead
 * of standing up the proxy or a live gateway.
 */
export function planTranscriptSpill(msgs, {
  knobs,
  sessionKey,
  spillMemo,
  sessionLedger,
  corpusChars = 0,
  adapt = false,
  persist = false,
  ...cutOpts
} = {}) {
  const adapted = applySpillCut(msgs, {
    knobs,
    corpusChars,
    adapt,
    persist,
    ...cutOpts,
  });
  const empty = { ...adapted, corpus: '', bindPlan: null };
  if (adapted.cut <= adapted.firstSpillable) return empty;
  const corpus = msgs.slice(adapted.firstSpillable, adapted.cut).map(msgText).filter(Boolean).join('\n\n');
  const bindPlan = planConversationBind({ sessionKey, corpus, spillMemo, sessionLedger });
  return { ...adapted, corpus, bindPlan };
}

function stubForCut(msgs, cut, opts) {
  return stubBoundFileResults(msgs, {
    boundFiles: opts.boundFiles,
    boundAbs: opts.boundAbs,
    cwd: opts.cwd,
    fromIndex: Math.max(0, cut),
    aggressive: Boolean(opts.aggressive),
    budget: opts.budget,
    keepTail: opts.keepTail,
    recall: opts.recall,
  });
}

/**
 * Cut + stub, then retune knobs toward the HUD dollar multiple (direct /
 * billed) when present, else corpus/sent. A miss recuts once this request
 * (smaller keepTail; stubMore for SEARCH, not live file bodies). A dollar
 * overshoot loosens one notch for the next request only (no flip-flop).
 * Env OPENZOO_ADAPT=0 disables the tuner; env still seeds the initial knobs.
 */
export function applySpillCut(msgs, {
  knobs,
  corpusChars = 0,
  boundFiles,
  boundAbs,
  cwd = process.cwd(),
  log = () => {},
  adapt = adaptEnabled(),
  persist = false,
  file,
  home,
  dollarX,
  lastSend,
  recall,
} = {}) {
  const persistOpts = { persist, file, home };
  let k = sanitizeKnobs(knobs || getLiveKnobs(persistOpts));
  let plan = cutTranscript(msgs, k);
  const empty = {
    cut: plan.cut,
    firstSpillable: plan.firstSpillable,
    lastUser: plan.lastUser,
    knobs: k,
    stubbed: { messages: msgs, stubbed: 0, dropped: 0 },
    sentChars: 0,
    prefixChars: 0,
    ratio: 0,
    action: 'hold',
  };
  if (plan.cut <= plan.firstSpillable) {
    // No severable index — still stub/trim the un-severable tail so a
    // 300-result storm is not forwarded at full size.
    const stubFrom = plan.firstSpillable >= 0 ? plan.firstSpillable : 0;
    let stubbed = stubForCut(msgs, stubFrom, {
      boundFiles, boundAbs, cwd, aggressive: k.stubMore, budget: k.budget, keepTail: k.keepTail, recall,
    });
    let sentChars = sliceChars(stubbed.messages, stubFrom);
    const corpus = Math.max(Number(corpusChars) || 0, sentChars);
    let ratio = spillRatio(corpus, sentChars);
    let action = 'hold';
    if (adapt) {
      const thisSend = Math.max(0, stubbed.messages.length - stubFrom);
      const decision = adaptTail({
        ratio,
        dollarX,
        lastSend: Math.max(Number(lastSend) || 0, thisSend),
        knobs: k,
        lastAction: lastAdaptAction,
        corpusChars: corpus,
      });
      k = decision.knobs;
      action = decision.action;
      if (decision.recut) {
        stubbed = stubForCut(msgs, stubFrom, {
          boundFiles, boundAbs, cwd, aggressive: k.stubMore, budget: k.budget, keepTail: k.keepTail, recall,
        });
        sentChars = sliceChars(stubbed.messages, stubFrom);
        ratio = spillRatio(corpus, sentChars);
      }
      rememberKnobs(k, persistOpts);
      lastAdaptAction = action;
      log(adaptLine({ action, ratio, knobs: k, dollarX }));
    }
    return { ...empty, knobs: k, stubbed, sentChars, ratio, action };
  }

  const measure = (cut, stubbed, knobsNow) => {
    const prefixChars = sliceChars(msgs, plan.firstSpillable, cut);
    const sentChars = sliceChars(stubbed.messages, cut);
    const corpus = Math.max(Number(corpusChars) || 0, prefixChars);
    return {
      prefixChars,
      sentChars,
      corpusChars: corpus,
      ratio: spillRatio(corpus, sentChars),
      knobs: knobsNow,
    };
  };

  let stubbed = stubForCut(msgs, plan.cut, {
    boundFiles, boundAbs, cwd, aggressive: k.stubMore, budget: k.budget, keepTail: k.keepTail, recall,
  });
  let stats = measure(plan.cut, stubbed, k);
  let action = 'hold';

  if (adapt) {
    const thisSend = Math.max(0, stubbed.messages.length - plan.cut);
    const decision = adaptTail({
      ratio: stats.ratio,
      dollarX,
      lastSend: Math.max(Number(lastSend) || 0, thisSend),
      knobs: k,
      lastAction: lastAdaptAction,
      corpusChars: stats.corpusChars,
    });
    k = decision.knobs;
    action = decision.action;
    if (decision.recut) {
      plan = cutTranscript(msgs, k);
      if (plan.cut > plan.firstSpillable) {
        stubbed = stubForCut(msgs, plan.cut, {
          boundFiles, boundAbs, cwd, aggressive: k.stubMore, budget: k.budget, keepTail: k.keepTail, recall,
        });
        stats = measure(plan.cut, stubbed, k);
      }
    }
    rememberKnobs(k, persistOpts);
    lastAdaptAction = action;
    log(adaptLine({ action, ratio: stats.ratio, knobs: k, dollarX }));
  }

  return {
    cut: plan.cut,
    firstSpillable: plan.firstSpillable,
    lastUser: plan.lastUser,
    knobs: k,
    stubbed,
    sentChars: stats.sentChars,
    prefixChars: stats.prefixChars,
    ratio: stats.ratio,
    action,
  };
}

/** Session counters the HUD reads off /v1/info. */
export function createSpillStats() {
  return {
    spillCalls: 0,
    spilledChars: 0,
    spillReuses: 0,
    fileBinds: 0,
    fileBindBytes: 0,
    spillSpend: 0,
    spillDirect: 0,
    noteSpill({ corpusChars = 0, reused = false } = {}) {
      this.spillCalls += 1;
      this.spilledChars += corpusChars;
      if (reused) this.spillReuses += 1;
    },
    noteFileBind(n, bytes = 0) {
      if (!n) return;
      this.fileBinds += n;
      this.fileBindBytes += bytes;
      this.spilledChars += bytes;
    },
    snapshot({ boundChars = null } = {}) {
      const unique = boundChars == null ? this.spilledChars : boundChars;
      return {
        calls: this.spillCalls,
        chars: this.spilledChars,
        // Unique bound size — do not re-add the same prefix on every reuse.
        tokensApprox: Math.round(unique / 4),
        reusedBinds: this.spillReuses,
        fileBinds: this.fileBinds,
        fileBindBytes: this.fileBindBytes,
        spend: this.spillSpend,
        direct: this.spillDirect,
        savedUsd: Math.max(0, this.spillDirect - this.spillSpend),
        savingX: this.spillSpend > 0 ? Number((this.spillDirect / this.spillSpend).toFixed(4)) : null,
      };
    },
  };
}
