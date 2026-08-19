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
 * Apply the bind/append/file rule in one place so spillTranscript and the
 * tests cannot drift.
 *
 * First bind initializes to the conversation corpus; each append adds the
 * delta; file bytes are added on top either way.
 */
export function noteCorpusLedger(boundChars, {
  contextId, reused, corpusChars = 0, deltaChars = 0, fileChars = 0, ...opts
} = {}) {
  if (!contextId) return 0;
  if (reused) {
    if (deltaChars) accumulateBoundChars(boundChars, contextId, deltaChars, { ...opts, persist: false });
  } else {
    accumulateBoundChars(boundChars, contextId, corpusChars, { ...opts, init: true, persist: false });
  }
  if (fileChars) accumulateBoundChars(boundChars, contextId, fileChars, { ...opts, persist: false });
  persistBoundChars(boundChars, opts);
  return boundChars.get(contextId) || 0;
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

function collectFromValue(value, out, depth) {
  if (depth > 6 || value == null) return;
  if (typeof value === 'string') {
    if (looksLikePath(value)) out.push(value);
    const t = value.trim();
    if ((t.startsWith('{') || t.startsWith('[')) && t.length < 100_000) {
      try { collectFromValue(JSON.parse(t), out, depth + 1); } catch { /* not json */ }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const x of value) collectFromValue(x, out, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    if (PATH_KEYS.has(k) && typeof v === 'string' && v) out.push(v);
    else if (PATH_ARRAY_KEYS.has(k) && Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === 'string') out.push(x);
        else collectFromValue(x, out, depth + 1);
      }
    } else if (k === 'input' || k === 'arguments' || k === 'params' || k === 'parameters') {
      collectFromValue(typeof v === 'string' ? parseArgs(v) : v, out, depth + 1);
    }
  }
}

/**
 * Pull file paths out of a transcript that may still be Anthropic-shaped,
 * already translated to OpenAI tool_calls, or a mix (Responses → chat).
 *
 * Structured fields only — never walks tool_result *bodies*, which are file
 * contents and would harvest every import path in the source.
 */
export function extractFilePaths(msgs) {
  const raw = [];
  if (!Array.isArray(msgs)) return [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const blocks = Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.input) collectFromValue(b.input, raw, 0);
      for (const k of PATH_KEYS) {
        if (typeof b[k] === 'string') raw.push(b[k]);
      }
      // tool_result: only structured content, never a long body string
      if (b.type === 'tool_result' && b.content && typeof b.content === 'object') {
        collectFromValue(b.content, raw, 0);
      } else if (b.type === 'tool_result' && typeof b.content === 'string' && b.content.length < 512 && looksLikePath(b.content)) {
        raw.push(b.content.trim());
      }
    }
    const calls = [
      ...(Array.isArray(m.tool_calls) ? m.tool_calls : []),
      ...(m.function_call ? [m.function_call] : []),
    ];
    for (const c of calls) {
      collectFromValue(parseArgs(c?.function?.arguments ?? c?.arguments), raw, 0);
      if (c?.input) collectFromValue(c.input, raw, 0);
      if (typeof c?.function?.name === 'string' && c.function.arguments == null && typeof c.name === 'string') {
        collectFromValue(c, raw, 0);
      }
    }
  }
  const seen = new Set();
  const out = [];
  for (const p of raw) {
    if (typeof p !== 'string') continue;
    const t = p.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Read every new file the agent touched and return the corpus slice to bind.
 *
 * Read-only, size-capped, path+mtime deduped. Failures never throw — this
 * runs on the request path.
 *
 * Always reports `file-bind N files / X bytes` or `file-bind 0 because …`
 * so a silent empty extract cannot hide again.
 */
export function filesForCorpus(msgs, {
  boundFiles,
  cwd = process.cwd(),
  cap = Number(process.env.OPENZOO_BIND_FILE_MAX || 400_000),
  disabled = process.env.OPENZOO_BIND_FILES === '0',
  log = () => {},
  statSync = (p) => fs.statSync(p),
  readFileSync = (p) => fs.readFileSync(p, 'utf8'),
} = {}) {
  if (disabled) {
    log('file-bind 0 because OPENZOO_BIND_FILES=0');
    return { text: '', files: 0, bytes: 0, reason: 'disabled' };
  }
  const paths = extractFilePaths(msgs);
  if (!paths.length) {
    log('file-bind 0 because no file paths in tool_use / tool_calls');
    return { text: '', files: 0, bytes: 0, reason: 'no-paths' };
  }
  const seen = new Set();
  const chunks = [];
  let skippedCap = 0;
  let skippedBound = 0;
  let skippedMissing = 0;
  let skippedRelative = 0;
  for (const raw of paths) {
    const p = resolveReadablePath(raw, cwd);
    if (!p) { skippedRelative += 1; continue; }
    if (seen.has(p)) continue;
    seen.add(p);
    try {
      const st = statSync(p);
      if (!st.isFile()) { skippedMissing += 1; continue; }
      if (st.size > cap) { skippedCap += 1; continue; }
      const key = `${p}:${st.mtimeMs}`;
      if (boundFiles?.has(key)) { skippedBound += 1; continue; }
      boundFiles?.add(key);
      chunks.push(`FILE ${p}\n${readFileSync(p)}`);
    } catch {
      skippedMissing += 1;
    }
  }
  if (!chunks.length) {
    const why = skippedBound && !skippedMissing && !skippedCap
      ? 'already bound'
      : skippedCap && !skippedMissing
        ? `over OPENZOO_BIND_FILE_MAX (${cap})`
        : skippedMissing
          ? 'unreadable or not a file'
          : 'paths did not resolve';
    log(`file-bind 0 because ${why}`);
    return { text: '', files: 0, bytes: 0, reason: why };
  }
  const text = chunks.join('\n\n');
  log(`file-bind ${chunks.length} files / ${text.length} bytes`);
  return { text, files: chunks.length, bytes: text.length, reason: null };
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
    snapshot() {
      return {
        calls: this.spillCalls,
        chars: this.spilledChars,
        tokensApprox: Math.round(this.spilledChars / 4),
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
