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

export function fileBoundStub(paths) {
  const list = [...new Set((paths || []).filter(Boolean))].join(' ');
  return list ? `FILE ${list} [bound]` : 'FILE [bound]';
}

function toolContentLength(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((n, b) => n + (typeof b === 'string' ? b.length : String(b?.text ?? b?.content ?? '').length), 0);
  }
  if (content && typeof content === 'object') return JSON.stringify(content).length;
  return 0;
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
 * tail. Keep the path and a short marker. The model already has the bytes in
 * the bound corpus via recall; shipping them again makes sent ≈ corpus and
 * the gateway's `counterfactualTokens > promptTokens` gate barely fires
 * (live: 5MB filebind, lastSend 13/107, savingX 1.22 instead of ~7x).
 *
 * Cheap rewrite — no disk I/O. First-read results (not yet in boundAbs) and
 * non-file tool output (npm test, grep, …) stay verbatim. The ask stays.
 *
 * `fromIndex` limits the rewrite to the forwarded tail so the spilled prefix
 * that becomes the conversation corpus is unchanged.
 */
export function stubBoundFileResults(msgs, {
  boundFiles,
  boundAbs,
  cwd = process.cwd(),
  fromIndex = 0,
  // When the live tuner is below target, stub file-view results even if
  // this turn has not yet recorded them in boundAbs (first-read bodies).
  aggressive = false,
} = {}) {
  const absSet = boundAbs || boundAbsFromKeys(boundFiles);
  if (!Array.isArray(msgs) || (!absSet.size && !aggressive)) {
    return { messages: msgs, stubbed: 0, dropped: 0 };
  }

  const stubIds = new Set();
  const idPaths = new Map();
  let currentCwd = cwd;

  const noteCall = (c) => {
    const id = c?.id || c?.tool_call_id;
    const args = parseArgs(c?.function?.arguments ?? c?.arguments);
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

  if (!stubIds.size) return { messages: msgs, stubbed: 0, dropped: 0 };

  let stubbed = 0;
  let dropped = 0;
  const messages = msgs.map((m, i) => {
    if (i < fromIndex || !m) return m;
    if (m.role === 'tool' && stubIds.has(m.tool_call_id)) {
      const n = toolContentLength(m.content);
      if (!n) return m;
      dropped += n;
      stubbed += 1;
      return { ...m, content: fileBoundStub(idPaths.get(m.tool_call_id)) };
    }
    if (!Array.isArray(m.content)) return m;
    let changed = false;
    const blocks = m.content.map((b) => {
      if (b?.type !== 'tool_result' || !stubIds.has(b.tool_use_id)) return b;
      const n = toolContentLength(b.content);
      if (!n) return b;
      dropped += n;
      stubbed += 1;
      changed = true;
      return { ...b, content: fileBoundStub(idPaths.get(b.tool_use_id)) };
    });
    return changed ? { ...m, content: blocks } : m;
  });
  return { messages, stubbed, dropped };
}

export const ADAPT_TARGET = 10;
export const ADAPT_LOOSEN_AT = 20;

export const KNOB_DEFAULTS = Object.freeze({
  keepTail: 8,
  minTurns: 6,
  budget: 6000,
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
      else n += String(b?.text ?? (typeof b?.content === 'string' ? b.content : '')).length;
    }
  } else if (c && typeof c === 'object') n += JSON.stringify(c).length;
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      const a = tc?.function?.arguments ?? tc?.arguments;
      n += typeof a === 'string' ? a.length : (a ? JSON.stringify(a).length : 0);
    }
  }
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

function adaptLine({ action, ratio, knobs, target = ADAPT_TARGET }) {
  if (action === 'hold') return `adapt hold ratio=${fmtRatio(ratio)}`;
  return `adapt ratio=${fmtRatio(ratio)} target=${target} tail=${knobs.keepTail} budget=${knobs.budget}`;
}

/**
 * Decide whether to shrink, loosen, or hold. Tighten recuts this request;
 * loosen only remembers a safer notch for the NEXT one so we do not
 * flip-flop every call after an overshoot.
 */
export function adaptTail({
  ratio,
  knobs,
  lastAction = 'hold',
  corpusChars,
  target = ADAPT_TARGET,
  loosenAt = ADAPT_LOOSEN_AT,
} = {}) {
  const cur = sanitizeKnobs(knobs);
  if (!Number.isFinite(ratio)) {
    return { action: 'hold', knobs: cur, recut: false, ratio, log: adaptLine({ action: 'hold', ratio, knobs: cur, target }) };
  }
  if (ratio < target) {
    const next = tightenKnobs(cur, { ratio, corpusChars, target });
    const changed = !sameKnobs(next, cur);
    const action = changed ? 'tighten' : 'hold';
    return { action, knobs: next, recut: changed, ratio, log: adaptLine({ action, ratio, knobs: next, target }) };
  }
  if (ratio > loosenAt && lastAction === 'hold') {
    const next = loosenKnobs(cur);
    const changed = !sameKnobs(next, cur);
    const action = changed ? 'loosen' : 'hold';
    return { action, knobs: next, recut: false, ratio, log: adaptLine({ action, ratio, knobs: next, target }) };
  }
  return { action: 'hold', knobs: cur, recut: false, ratio, log: adaptLine({ action: 'hold', ratio, knobs: cur, target }) };
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

function countRealTurns(msgs, from) {
  let n = 0;
  for (let i = from; i < msgs.length; i++) {
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
 * Pick a severable cut: keep a recent tail, honour the byte budget, floor
 * at minTurns of user/assistant, and never drop the last user ask.
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

  let tailStart = cut;
  {
    let used = 0;
    for (let i = msgs.length - 1; i >= cut; i--) {
      used += msgText(msgs[i]).length;
      if (used > budget && isSeverable(msgs, i, firstSpillable)) { tailStart = i; break; }
    }
  }
  if (tailStart > cut) cut = tailStart;

  if (countRealTurns(msgs, cut) < minTurns) {
    for (let i = cut - 1; i > firstSpillable; i--) {
      if (isSeverable(msgs, i, firstSpillable) && countRealTurns(msgs, i) >= minTurns) { cut = i; break; }
      if (i === firstSpillable + 1) { if (isSeverable(msgs, i, firstSpillable)) cut = i; break; }
    }
  }

  const lastUser = lastUserAskIndex(msgs, firstSpillable);
  if (lastUser > firstSpillable && cut > lastUser) cut = lastUser;

  // Never shrink below 2 real turns when that would drop the ask — the ask
  // always stays; expand earlier only if two turns exist and remain after it.
  if (lastUser > firstSpillable && countRealTurns(msgs, cut) < 2) {
    for (let i = cut - 1; i > firstSpillable; i--) {
      if (isSeverable(msgs, i, firstSpillable) && countRealTurns(msgs, i) >= 2) { cut = i; break; }
    }
    if (cut > lastUser) cut = lastUser;
  }

  return { cut, firstSpillable, lastUser, knobs: k };
}

function stubForCut(msgs, cut, opts) {
  return stubBoundFileResults(msgs, {
    boundFiles: opts.boundFiles,
    boundAbs: opts.boundAbs,
    cwd: opts.cwd,
    fromIndex: cut,
    aggressive: Boolean(opts.aggressive),
  });
}

/**
 * Cut + stub, then retune knobs toward a >10x corpus/sent ratio in process
 * memory. A miss recuts once this request. A huge overshoot loosens one
 * notch for the next request only (no flip-flop). Env OPENZOO_ADAPT=0
 * disables the tuner; env still seeds the initial knobs.
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
    const sentChars = sliceChars(msgs, 0);
    const corpus = Math.max(Number(corpusChars) || 0, sentChars);
    return { ...empty, sentChars, ratio: spillRatio(corpus, sentChars) };
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

  let stubbed = stubForCut(msgs, plan.cut, { boundFiles, boundAbs, cwd, aggressive: k.stubMore });
  let stats = measure(plan.cut, stubbed, k);
  let action = 'hold';

  if (adapt) {
    const decision = adaptTail({
      ratio: stats.ratio,
      knobs: k,
      lastAction: lastAdaptAction,
      corpusChars: stats.corpusChars,
    });
    k = decision.knobs;
    action = decision.action;
    if (decision.recut) {
      plan = cutTranscript(msgs, k);
      if (plan.cut > plan.firstSpillable) {
        stubbed = stubForCut(msgs, plan.cut, { boundFiles, boundAbs, cwd, aggressive: k.stubMore });
        stats = measure(plan.cut, stubbed, k);
      }
    }
    rememberKnobs(k, persistOpts);
    lastAdaptAction = action;
    log(adaptLine({ action, ratio: stats.ratio, knobs: k }));
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
