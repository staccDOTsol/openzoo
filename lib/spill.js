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

/**
 * Read every new file the agent touched and return the corpus slice to bind.
 *
 * Live path is OpenAI tool_calls (Read/Edit/Write + Bash command). Relative
 * paths resolve against cwd / last "current working directory is …" hint.
 * Directories expand to children that are files under the cap.
 *
 * Always logs `file-bind kept=N bytes=B skip enoent=X cap=Y dir=Z rel=W bash=K`
 * so grep-for-FILES is no longer the only signal. Bytes, not 0.0MB.
 */
export function filesForCorpus(msgs, {
  boundFiles,
  cwd = process.cwd(),
  cap = Number(process.env.OPENZOO_BIND_FILE_MAX || 400_000),
  disabled = process.env.OPENZOO_BIND_FILES === '0',
  log = () => {},
  statSync = (p) => fs.statSync(p),
  readFileSync = (p) => fs.readFileSync(p, 'utf8'),
  readdirSync = (p) => fs.readdirSync(p),
} = {}) {
  const empty = { kept: 0, bytes: 0, enoent: 0, cap: 0, dir: 0, rel: 0, bash: 0 };
  if (disabled) {
    log(fileBindLog(empty));
    return { text: '', files: 0, bytes: 0, reason: 'disabled', ...empty };
  }
  const { structured, bash } = extractFileCandidates(msgs, { cwd });
  const candidates = [
    ...structured.map((p) => ({ ...p, bash: false })),
    ...bash.map((p) => ({ ...p, bash: true })),
  ];
  const skip = { enoent: 0, cap: 0, dir: 0, rel: 0 };
  const seen = new Set();
  const chunks = [];

  const tryBind = (abs) => {
    if (!abs || seen.has(abs)) return;
    seen.add(abs);
    let st;
    try { st = statSync(abs); } catch { skip.enoent += 1; return; }
    if (st.isDirectory()) {
      skip.dir += 1;
      let kids = [];
      try { kids = readdirSync(abs); } catch { skip.enoent += 1; return; }
      for (const name of kids) {
        if (!name || name.startsWith('.') || SKIP_DIR_NAMES.has(name)) continue;
        const kid = path.join(abs, name);
        let ks;
        try { ks = statSync(kid); } catch { skip.enoent += 1; continue; }
        if (ks.isFile()) tryBind(kid);
      }
      return;
    }
    if (!st.isFile()) { skip.enoent += 1; return; }
    if (st.size > cap) { skip.cap += 1; return; }
    const key = `${abs}:${st.mtimeMs}`;
    if (boundFiles?.has(key)) return;
    boundFiles?.add(key);
    try {
      chunks.push(`FILE ${abs}\n${readFileSync(abs)}`);
    } catch {
      skip.enoent += 1;
    }
  };

  for (const item of candidates) {
    const raw = item.raw;
    if (!path.isAbsolute(raw) && !(raw.startsWith('~/') || raw === '~')) skip.rel += 1;
    const abs = resolveReadablePath(raw, item.cwd || cwd);
    if (!abs) { skip.enoent += 1; continue; }
    tryBind(abs);
  }

  const text = chunks.join('\n\n');
  const stats = {
    kept: chunks.length,
    bytes: text.length,
    enoent: skip.enoent,
    cap: skip.cap,
    dir: skip.dir,
    rel: skip.rel,
    bash: bash.length,
  };
  log(fileBindLog(stats));
  return { text, files: chunks.length, bytes: text.length, reason: chunks.length ? null : 'none-kept', ...stats };
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
