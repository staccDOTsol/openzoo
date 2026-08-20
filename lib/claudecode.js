/**
 * Drive Claude Code as grokui Auto over a real PTY — the interactive TUI,
 * not `claude --print --output-format stream-json`.
 *
 * `--print` is a one-shot JSON harness. `/context` still prints text there,
 * but `/agents` and `/tasks` answer "wizard removed" / "isn't available in
 * this environment" because those screens are the Ink TUI. Chat-box lines
 * (including Claude slashes) are written to PTY stdin; folded output is
 * painted on the grokui canvas.
 *
 * Env is the same writer as `openzoo claude`: claudeZooEnv
 * (ANTHROPIC_BASE_URL=http://localhost:8402/v1, ANTHROPIC_AUTH_TOKEN=sk-openzoo,
 * ANTHROPIC_API_KEY unset). cwd is the thread dir. bypassPermissions stays.
 *
 * Attach order: node-pty when it is already installed (optional; Electron
 * would need its own ABI rebuild), else Mac/Linux `script` which allocates a
 * host PTY. Windows without node-pty is not first-class — say so rather than
 * falling back to --print.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeZooEnv, resolveOpenzooClaude } from './launch.js';
import { isAutoModel } from './modelroute.js';

export const AUTO_CLAUDE_SYSTEM = 'You are grokui Auto, paid per call through the local OpenZoo proxy (x402 on :8402). '
  + 'Use your native tools (Bash, Read, Write, Edit, Glob, Grep) to do the work in this working directory. '
  + 'Do not curl localhost:8402/v1/chat/completions and do not emit RUN:/WRITE:/DONE: text directives — you already have real tools. '
  + 'Do not ask the user to type continue.';

export const CLAUDE_MISSING = 'openzoo-claude is installing. Auto will use chat until the harness is ready.';

export const PTY_WINDOWS = 'Auto PTY is Mac/Linux first (`script` host PTY). On Windows install node-pty '
  + '(conpty) — --print cannot grow the TUI, so we do not fall back to it.';

const SESSION_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const TERM_ROWS = 36;
const TERM_COLS = 120;

let runnerOverride = null;
export function setClaudeRunnerForTest(fn) {
  runnerOverride = typeof fn === 'function' ? fn : null;
}
export function claudeRunnerOverridden() {
  return typeof runnerOverride === 'function';
}

/** Grokui keeps these even in Auto. Everything else that looks like a slash
 *  (Claude's /agents /tasks /context /model, plus unknown CLI slashes) goes
 *  to the PTY. */
export const GROKUI_RESERVED_SLASH = Object.freeze(['mode', 'tier', 'help', 'dir']);

/** Claude Code does not know openzoo/auto. The picker Auto id must never
 *  become `claude --model openzoo/auto` — that fails session init and
 *  refreshes the canvas. Leave --model off and let the OpenZoo env pick. */
export function claudeModelArg(model) {
  const id = String(model || '').trim();
  if (!id || isAutoModel(id)) return undefined;
  return id;
}

export function claudeInteractiveArgs({ sessionId, model, system } = {}) {
  const args = ['--permission-mode', 'bypassPermissions'];
  const sys = system === undefined ? AUTO_CLAUDE_SYSTEM : system;
  if (sys) args.push('--append-system-prompt', sys);
  if (sessionId) args.push('--resume', String(sessionId));
  const pin = claudeModelArg(model);
  if (pin) args.push('--model', pin);
  return args;
}

export function toolStatusLine(name, input) {
  const n = String(name || 'tool');
  const i = input && typeof input === 'object' ? input : {};
  if (n === 'Write' || n === 'Edit' || n === 'Read' || n === 'NotebookEdit') {
    return `${n} ${i.file_path || i.path || ''}`.trim();
  }
  if (n === 'Bash') return `Bash ${String(i.command || i.cmd || '').slice(0, 80)}`.trim();
  if (n === 'Glob') return `Glob ${i.pattern || ''}`.trim();
  if (n === 'Grep') return `Grep ${i.pattern || ''}`.trim();
  if (n === 'Task' || n === 'Agent') return `${n} ${i.description || i.prompt || i.name || ''}`.trim();
  return n;
}

export function paymentFailText(text) {
  const s = String(text || '');
  if (/\b(?:wallet is empty|empty wallet|wallet underfunded|underfunded)\b/i.test(s)) {
    return s.includes('HTTP 402') || /payment/i.test(s)
      ? s
      : `(payment required — HTTP 402, the wallet is empty.) ${s}`.trim();
  }
  if (/\b(?:payment failed|HTTP 402|payment required)\b/i.test(s)) return s;
  return '';
}

const SYSTEM_REMINDER = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi;
const SYSTEM_REMINDER_OPEN = /<system-reminder\b[^>]*>[\s\S]*$/i;
const CURRENT_DIR_LINE = /^[ \t]*(?:#\s*)?currentDir\b[^\n]*\n?/gim;
const HARNESS_DUMP_LINE = /^(?:RUN|WRITE|SPAWN|READ|EDIT|GLOB|GREP|MULTIEDIT):\s*.*$/gim;

/** Gzip magic, NULs, or UTF-8 replacement diamonds — never paint that. */
export function looksBinaryCanvas(raw) {
  if (raw == null) return false;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw)) {
    if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) return true;
    raw = raw.toString('utf8');
  }
  const s = String(raw);
  if (!s) return false;
  if (s.includes('\uFFFD')) return true;
  if (s.charCodeAt(0) === 0x1f && s.charCodeAt(1) === 0x8b) return true;
  let ctrl = 0;
  const n = Math.min(s.length, 256);
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 0 || c < 8 || (c > 13 && c < 32)) ctrl += 1;
  }
  return ctrl >= 4;
}

function apiErrorCode(text) {
  const s = String(text || '');
  const api = /API Error:\s*(\d{3})\b/i.exec(s);
  if (api) return api[1];
  const http = /\bHTTP\s+(\d{3})\b/i.exec(s);
  if (http && Number(http[1]) >= 400) return http[1];
  return '';
}

/**
 * Short readable canvas line for a dead child. Binary / API Error 400
 * bodies become `upstream HTTP 400` — never the gzip dump.
 */
export function canvasHttpErrorLine(text, { error = false } = {}) {
  const s = String(text || '');
  const code = apiErrorCode(s);
  if (looksBinaryCanvas(s)) return `upstream HTTP ${code || '400'}`;
  if (code && code !== '402' && (error || /^\s*API Error:/im.test(s))) {
    return `upstream HTTP ${code}`;
  }
  return '';
}

export function stripClaudeNoise(text) {
  let s = String(text || '');
  s = s.replace(SYSTEM_REMINDER, '');
  s = s.replace(SYSTEM_REMINDER_OPEN, '');
  s = s.replace(CURRENT_DIR_LINE, '');
  s = s.replace(HARNESS_DUMP_LINE, '');
  return s.replace(/^\n+|\n+$/g, '').trim();
}

function looksLikeToolJsonDump(text) {
  const t = String(text || '').trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return false;
  try {
    const j = JSON.parse(t);
    if (!j || typeof j !== 'object') return false;
    return Boolean(
      j.tool_use || j.tool_result || j.type === 'tool_use' || j.type === 'tool_result'
      || j.file_path || j.currentDir || j['system-reminder'],
    );
  } catch {
    return false;
  }
}

/**
 * What grokui may paint as the Auto bubble. Model prose stays; RUN dumps,
 * tool JSON, system-reminder / currentDir blocks, and binary 400s do not.
 */
export function sanitizeClaudeCanvas(text, { error = false } = {}) {
  if (text == null) return '';
  const raw = typeof Buffer !== 'undefined' && Buffer.isBuffer(text)
    ? text.toString('utf8')
    : String(text);
  const err = canvasHttpErrorLine(raw, { error });
  if (err) return err;
  const s = stripClaudeNoise(raw);
  if (!s) return '';
  if (looksLikeToolJsonDump(s)) return '';
  return s;
}

/**
 * Fold one Claude Code stream-json object into a grokui-sized event.
 * Print-mode is gone; this only folds JSON that still leaks onto the PTY.
 */
export function foldClaudeEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const sessionId = ev.session_id || ev.sessionId;
  if (ev.type === 'system' && ev.subtype === 'init') {
    return { kind: 'init', sessionId, model: ev.model, tools: ev.tools || [] };
  }
  if (ev.type === 'stream_event') {
    const event = ev.event || {};
    const delta = event.delta;
    const block = event.content_block || event.contentBlock;
    if (delta?.type === 'thinking_delta' && delta.thinking) {
      return { kind: 'think', text: delta.thinking, sessionId };
    }
    if (delta?.type === 'text_delta' && delta.text) {
      return { kind: 'text', text: sanitizeClaudeCanvas(delta.text), sessionId };
    }
    if (event.type === 'content_block_start' && block?.type === 'tool_use') {
      return { kind: 'tool', name: block.name, input: block.input || {}, sessionId };
    }
    if (event.type === 'content_block_start' && block?.type === 'thinking') {
      return { kind: 'think', text: '', sessionId };
    }
    return { kind: 'partial', sessionId };
  }
  if (ev.type === 'user' && ev.message) {
    const content = ev.message.content;
    const blocks = Array.isArray(content) ? content : [];
    if (blocks.some((b) => b && b.type === 'tool_result')) {
      return { kind: 'tool_result', sessionId };
    }
    return { kind: 'partial', sessionId };
  }
  if (ev.type === 'assistant' && ev.message) {
    const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
    const thinking = [];
    const text = [];
    const tools = [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'thinking' && b.thinking) thinking.push(b.thinking);
      else if (b.type === 'text' && b.text) text.push(sanitizeClaudeCanvas(b.text));
      else if (b.type === 'tool_use') tools.push({ name: b.name, input: b.input || {} });
    }
    return {
      kind: 'assistant',
      thinking: thinking.join('\n'),
      text: text.filter(Boolean).join(''),
      tools,
      sessionId,
    };
  }
  if (ev.type === 'result') {
    const raw = ev.result != null ? String(ev.result) : (ev.error != null ? String(ev.error) : '');
    const pay = paymentFailText(raw);
    const error = Boolean(ev.is_error || ev.subtype === 'error' || ev.subtype === 'error_during_execution');
    return {
      kind: 'result',
      text: pay || sanitizeClaudeCanvas(raw, { error }),
      error,
      paymentFailed: pay,
      sessionId,
    };
  }
  return { kind: ev.type || 'other', sessionId };
}

function parseNdjsonLine(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export function looksRawToolJson(s) {
  const t = String(s || '').trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return false;
  const raw = parseNdjsonLine(t);
  if (!raw || typeof raw !== 'object') return false;
  if (raw.type === 'tool_use' || raw.type === 'assistant' || raw.type === 'stream_event'
    || raw.type === 'system' || raw.type === 'result' || raw.type === 'user') return true;
  if (Array.isArray(raw.content) && raw.content.some((c) => c && c.type === 'tool_use')) return true;
  if (raw.tool_use_id || raw.file_path && raw.content && raw.type) return true;
  return false;
}

export function stripAnsi(s) {
  return String(s ?? '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_][\s\S]*?(?:\x1b\\|\x07)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\x1b./g, '');
}

function nonTextRatio(buf) {
  if (!buf.length) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c === 0x7f) n += 1;
  }
  return n / buf.length;
}

/**
 * Binary / diamond-mojibake HTTP 400 bodies become a short line.
 * Do not paint `` from a gzip 400.
 */
export function sanitizeClaudeOutput(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ''), 'utf8');
  if (!buf.length) return '';
  const utf = buf.toString('utf8');
  const latin = buf.toString('latin1');
  const diamonds = utf.split('\uFFFD').length - 1;
  const binary = buf.includes(0) || diamonds >= 3 || nonTextRatio(buf) > 0.18
    || (buf[0] === 0x1f && buf[1] === 0x8b);
  const mentions400 = /\bHTTP\/?\s*1\.[01]\s*400\b|\bstatus["']?\s*[:=]\s*400\b|\b400 Bad Request\b|\bupstream[^.\n]{0,40}400\b/i.test(latin)
    || /\bHTTP 400\b|\bstatus["']?\s*[:=]\s*400\b|\b400 Bad Request\b/i.test(utf);
  if (binary && (mentions400 || diamonds >= 3 || (buf[0] === 0x1f && buf[1] === 0x8b))) {
    return 'upstream HTTP 400';
  }
  if (mentions400 && diamonds) return 'upstream HTTP 400';
  return utf;
}

export function tuiLooksIdle(plain) {
  const s = String(plain || '').replace(/[ \t]+$/g, '');
  const lines = s.split('\n').filter((l) => l.trim());
  const last = (lines[lines.length - 1] || '').trim();
  if (/^(?:>|❯|➜|›)\s*$/.test(last)) return true;
  if (/^(?:>|❯)\s+\S/.test(last) && /type |message|prompt/i.test(s.slice(-400))) return true;
  if (/^\?\s/.test(last) && /agents|tasks|select/i.test(s.slice(-800))) return true;
  return false;
}

const TOOL_LINE = /^(?:[●◆✶✻▸➤]|[-*])\s+(Read|Write|Edit|Bash|Glob|Grep|Task|Agent|NotebookEdit)\s+(\S.*)?$/i;
const THINK_LINE = /^(?:[✻✶*·]\s*)?(?:thinking|thoughts?)\b[:.…\s]*/i;
const SPINNER_ONLY = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷\s]+$/;
const FILE_TRAIL = /^(?:\s*(?:⎿|└|├|│)\s+|\s{2,}(?:Found|Loaded|Wrote|Edited|Read)\b)/;

export function foldTuiText(raw) {
  const sanitized = sanitizeClaudeOutput(raw);
  if (sanitized === 'upstream HTTP 400') {
    return { text: 'upstream HTTP 400', thinking: '', tools: [], paymentFailed: '' };
  }
  const plain = stripAnsi(sanitized)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[╭╮╰╯│─┌┐└┘├┤┬┴┼━┃┏┓┗┛║═╔╗╚╝]/g, '')
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/g, '');
  const thinking = [];
  const text = [];
  const tools = [];
  let inThink = false;
  for (const line of plain.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || SPINNER_ONLY.test(trimmed)) continue;
    if (looksRawToolJson(trimmed)) continue;
    if (FILE_TRAIL.test(line) && !TOOL_LINE.test(trimmed)) continue;
    const tool = TOOL_LINE.exec(trimmed);
    if (tool) {
      const name = tool[1][0].toUpperCase() + tool[1].slice(1);
      const rest = (tool[2] || '').trim();
      if (/^(Task|Agent)$/i.test(name)) {
        tools.push({ name, input: { description: rest, prompt: rest } });
      } else {
        tools.push(name === 'Bash' ? { name, input: { command: rest } } : { name, input: { file_path: rest } });
      }
      inThink = false;
      continue;
    }
    if (THINK_LINE.test(trimmed)) {
      const rest = trimmed.replace(THINK_LINE, '').trim();
      if (rest) thinking.push(rest);
      else thinking.push('thinking…');
      inThink = true;
      continue;
    }
    if (tuiLooksIdle(trimmed) && /^(?:>|❯|➜|›)\s*$/.test(trimmed)) continue;
    if (inThink && trimmed.length < 200 && !/^(?:here's|here is|i |the |done|wrote|created)\b/i.test(trimmed)) {
      thinking.push(trimmed);
      continue;
    }
    inThink = false;
    text.push(line.replace(/[ \t]+$/g, ''));
  }
  const visible = text.join('\n').replace(/^\n+|\n+$/g, '').replace(/\n{3,}/g, '\n\n');
  const pay = paymentFailText(plain);
  const canvasErr = canvasHttpErrorLine(plain, { error: true });
  return {
    text: pay || canvasErr || sanitizeClaudeCanvas(visible),
    thinking: thinking.join('\n').replace(/^\n+|\n+$/g, ''),
    tools,
    paymentFailed: pay,
  };
}

/** Minimal VT so TUI redraws become a screen, not a dump of CSI junk. */
export class TinyTerm {
  constructor(rows = TERM_ROWS, cols = TERM_COLS) {
    this.rows = rows;
    this.cols = cols;
    this.scrollback = [];
    this.r = 0;
    this.c = 0;
    this._blank();
  }
  _blank() {
    this.grid = Array.from({ length: this.rows }, () => Array(this.cols).fill(' '));
  }
  _put(ch) {
    if (this.c >= this.cols) this._nl();
    if (this.r >= this.rows) this.r = this.rows - 1;
    this.grid[this.r][this.c] = ch;
    this.c += 1;
  }
  _nl() {
    this.c = 0;
    this.r += 1;
    if (this.r >= this.rows) {
      const top = this.grid.shift().join('').replace(/ +$/g, '');
      if (top.trim()) this.scrollback.push(top);
      if (this.scrollback.length > 400) this.scrollback.splice(0, this.scrollback.length - 400);
      this.grid.push(Array(this.cols).fill(' '));
      this.r = this.rows - 1;
    }
  }
  write(chunk) {
    const s = String(chunk ?? '');
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\x1b') {
        const rest = s.slice(i);
        const osc = rest.match(/^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/);
        if (osc) { i += osc[0].length; continue; }
        const csi = rest.match(/^\x1b\[([0-9;?]*)([ -/]*[@-~])/);
        if (csi) {
          this._csi(csi[1], csi[2]);
          i += csi[0].length;
          continue;
        }
        i += rest[1] ? 2 : 1;
        continue;
      }
      if (ch === '\n') { this._nl(); i += 1; continue; }
      if (ch === '\r') { this.c = 0; i += 1; continue; }
      if (ch === '\b') { this.c = Math.max(0, this.c - 1); i += 1; continue; }
      if (ch === '\t') { this.c = Math.min(this.cols - 1, this.c + (8 - (this.c % 8))); i += 1; continue; }
      if (ch < ' ' && ch !== '') { i += 1; continue; }
      this._put(ch);
      i += 1;
    }
  }
  _csi(params, cmd) {
    const parts = String(params || '').split(';').map((n) => (n === '' ? 0 : Number(n)));
    const n = (i, d) => { const v = parts[i]; return Number.isFinite(v) && v > 0 ? v : d; };
    switch (cmd) {
      case 'A': this.r = Math.max(0, this.r - n(0, 1)); break;
      case 'B': this.r = Math.min(this.rows - 1, this.r + n(0, 1)); break;
      case 'C': this.c = Math.min(this.cols - 1, this.c + n(0, 1)); break;
      case 'D': this.c = Math.max(0, this.c - n(0, 1)); break;
      case 'H':
      case 'f': {
        const row = Math.max(1, parts[0] || 1) - 1;
        const col = Math.max(1, parts[1] || 1) - 1;
        this.r = Math.min(this.rows - 1, row);
        this.c = Math.min(this.cols - 1, col);
        break;
      }
      case 'J': {
        const mode = parts[0] || 0;
        if (mode === 2 || mode === 3) this._blank();
        break;
      }
      case 'K': {
        const mode = parts[0] || 0;
        if (mode === 2) this.grid[this.r] = Array(this.cols).fill(' ');
        else if (mode === 1) {
          for (let x = 0; x <= this.c; x++) this.grid[this.r][x] = ' ';
        } else {
          for (let x = this.c; x < this.cols; x++) this.grid[this.r][x] = ' ';
        }
        break;
      }
      default:
        break;
    }
  }
  text() {
    const screen = this.grid.map((row) => row.join('').replace(/ +$/g, ''));
    return [...this.scrollback, ...screen].join('\n').replace(/^\n+|\n+$/g, '');
  }
}

export function latestClaudeSessionId(cwd, home = os.homedir()) {
  const root = path.join(home, '.claude', 'projects');
  if (!existsSync(root) || !cwd) return '';
  const slug = String(path.resolve(cwd)).replace(/[^A-Za-z0-9]/g, '-');
  let dir = path.join(root, slug);
  if (!existsSync(dir)) {
    let hit = '';
    try {
      for (const name of readdirSync(root)) {
        if (name === slug || name.endsWith(slug) || slug.endsWith(name)) {
          hit = path.join(root, name);
          break;
        }
      }
    } catch { /* none */ }
    if (!hit) return '';
    dir = hit;
  }
  let best = '';
  let bestM = 0;
  try {
    for (const name of readdirSync(dir)) {
      const m = name.match(new RegExp(`^(${SESSION_UUID.source})\\.jsonl$`, 'i'));
      if (!m) continue;
      let t = 0;
      try { t = statSync(path.join(dir, name)).mtimeMs; } catch { t = 0; }
      if (t >= bestM) { bestM = t; best = m[1]; }
    }
  } catch { /* none */ }
  return best;
}

function shEscape(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function loadNodePty() {
  try {
    const require = createRequire(import.meta.url);
    return require('node-pty');
  } catch {
    return null;
  }
}

function ptyEnv(env) {
  return {
    ...env,
    TERM: env.TERM || 'xterm-256color',
    COLORTERM: env.COLORTERM || 'truecolor',
    COLUMNS: String(env.COLUMNS || TERM_COLS),
    LINES: String(env.LINES || TERM_ROWS),
  };
}

/**
 * Spawn `cli args` on a PTY. Returns a handle: write, onData, onExit, kill, kind.
 */
export function spawnClaudePty({ cli, args, cwd, env }) {
  const runEnv = ptyEnv(env || process.env);
  const nodePty = loadNodePty();
  if (nodePty?.spawn) {
    const term = nodePty.spawn(cli, args, {
      name: 'xterm-256color',
      cols: TERM_COLS,
      rows: TERM_ROWS,
      cwd: cwd || process.cwd(),
      env: runEnv,
    });
    return {
      kind: 'node-pty',
      write: (s) => { try { term.write(s); } catch { /* closed */ } },
      onData: (fn) => { term.onData((d) => fn(Buffer.from(String(d), 'utf8'))); },
      onExit: (fn) => { term.onExit(({ exitCode }) => fn(exitCode ?? 0)); },
      kill: () => { try { term.kill(); } catch { /* gone */ } },
      pid: term.pid,
    };
  }
  if (process.platform === 'win32') {
    const err = new Error(PTY_WINDOWS);
    err.code = 'PTY_WINDOWS';
    throw err;
  }
  const scriptBin = existsSync('/usr/bin/script') ? '/usr/bin/script' : 'script';
  let child;
  if (process.platform === 'darwin') {
    child = spawn(scriptBin, ['-q', '/dev/null', cli, ...args], {
      cwd: cwd || process.cwd(),
      env: runEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } else {
    const inner = `stty cols ${TERM_COLS} rows ${TERM_ROWS} 2>/dev/null; exec ${[cli, ...args].map(shEscape).join(' ')}`;
    child = spawn(scriptBin, ['-qefc', inner, '/dev/null'], {
      cwd: cwd || process.cwd(),
      env: runEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  return {
    kind: 'script',
    write: (s) => { try { child.stdin.write(s); } catch { /* closed */ } },
    onData: (fn) => {
      child.stdout.on('data', fn);
      child.stderr.on('data', fn);
    },
    onExit: (fn) => { child.on('close', (code) => fn(code ?? 0)); },
    kill: () => {
      try { child.kill('SIGTERM'); } catch { /* gone */ }
    },
    pid: child.pid,
    child,
  };
}

const liveSessions = new Map();

export function closeClaudeSession(key) {
  const sess = liveSessions.get(key);
  if (!sess) return;
  liveSessions.delete(key);
  try { sess.dispose(); } catch { /* gone */ }
}

class ClaudePtySession {
  constructor({ cli, args, cwd, env, sessionId, key }) {
    this.cli = cli;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.sessionId = sessionId || '';
    this.key = key;
    this.dead = false;
    this.term = new TinyTerm();
    this.rawTail = '';
    this.handle = spawnClaudePty({ cli, args, cwd, env });
    this.exitCode = null;
    this.listeners = new Set();
    this.handle.onData((chunk) => this._ingest(chunk));
    this.handle.onExit((code) => {
      this.dead = true;
      this.exitCode = code;
      if (!this.sessionId) this.sessionId = latestClaudeSessionId(this.cwd) || this.sessionId;
      for (const fn of this.listeners) {
        try { fn({ kind: 'exit', exitCode: code, sessionId: this.sessionId }); } catch { /* paint */ }
      }
    });
  }
  _ingest(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    const sanitized = sanitizeClaudeOutput(buf);
    if (sanitized === 'upstream HTTP 400') {
      this.rawTail = 'upstream HTTP 400';
      this.term = new TinyTerm();
      this.term.write('upstream HTTP 400');
      this._emitFold();
      return;
    }
    const utf = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const sid = utf.match(SESSION_UUID);
    if (sid) this.sessionId = sid[0];
    // NDJSON leak from a confused child — fold, do not dump.
    const lines = utf.split(/\r?\n/);
    for (const line of lines) {
      const raw = parseNdjsonLine(line);
      if (!raw) continue;
      const folded = foldClaudeEvent(raw);
      if (folded?.sessionId) this.sessionId = folded.sessionId;
      if (folded) {
        for (const fn of this.listeners) {
          try { fn(folded); } catch { /* paint */ }
        }
      }
    }
    this.term.write(utf);
    this.rawTail = (this.rawTail + utf).slice(-80_000);
    this._emitFold();
  }
  _emitFold() {
    const folded = foldTuiText(this.term.text() || this.rawTail);
    folded.sessionId = this.sessionId;
    folded.kind = 'tui';
    for (const fn of this.listeners) {
      try { fn(folded); } catch { /* paint */ }
    }
  }
  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  writeLine(text) {
    const line = String(text ?? '').replace(/\r?\n$/, '');
    this.handle.write(`${line}\r`);
  }
  screenText() {
    return foldTuiText(this.term.text() || this.rawTail);
  }
  dispose() {
    this.dead = true;
    try { this.handle.kill(); } catch { /* gone */ }
  }
}

function waitReady(sess, ms = 2500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      off();
      resolve();
    };
    const off = sess.onEvent(() => finish());
    const t = setTimeout(finish, ms);
    if (sess.term.text().trim()) finish();
  });
}

/** Wall-clock waitIdle cap. Spinner / think / keepFold events must not reset it. */
export const WAIT_IDLE_HARD_MS = 90_000;
/** If writeLine never paints a TUI prompt (and no assistant text), settle sooner than 90s. */
export const WAIT_IDLE_PROMPT_MS = 8_000;

function eventKeepsAlive(ev) {
  if (!ev || typeof ev !== 'object') return false;
  const k = ev.kind;
  if (k === 'think' || k === 'partial' || k === 'init' || k === 'tool_result') return true;
  if (k === 'tui' && !String(ev.text || '').trim()) return true;
  return false;
}

function sessionVisibleText(sess) {
  return String(sess.screenText().text || '').trim();
}

function sessionIdle(sess) {
  return tuiLooksIdle(sess.term.text()) || tuiLooksIdle(sess.screenText().text);
}

/**
 * Wait until the TUI is done with this send.
 * Hard-cap (~90s) is a wall clock — spinner/think/keepFold must not reset it.
 * Finish early when visible assistant text AND (idle prompt or result).
 * After writeLine, a blank TUI that never shows a prompt settles at promptWait
 * so we do not hang forever — but a live think stream is allowed to run to the cap.
 */
export function waitIdle(sess, {
  signal, minWait = 200, hardCapMs, promptWaitMs,
} = {}) {
  const hard = Math.max(50, Number(hardCapMs ?? process.env.OZ_WAIT_IDLE_MS ?? WAIT_IDLE_HARD_MS));
  const promptWait = Math.max(50, Number(promptWaitMs ?? process.env.OZ_WAIT_PROMPT_MS ?? WAIT_IDLE_PROMPT_MS));
  return new Promise((resolve) => {
    let finished = false;
    let quietTimer;
    let hardTimer;
    let promptTimer;
    let minTimer;
    let sawActivity = false;
    let sawResult = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      clearTimeout(promptTimer);
      clearTimeout(minTimer);
      off();
      if (signal) signal.removeEventListener?.('abort', onAbort);
      resolve();
    };
    const tryEarly = () => {
      if (sessionVisibleText(sess) && (sessionIdle(sess) || sawResult || sess.dead)) {
        finish();
        return true;
      }
      return false;
    };
    const armQuiet = () => {
      clearTimeout(quietTimer);
      if (!sawActivity) return;
      const delay = sessionIdle(sess) ? 280 : 1100;
      quietTimer = setTimeout(() => {
        if (tryEarly()) return;
        if (sess.dead || sessionIdle(sess)) finish();
      }, delay);
    };
    const off = sess.onEvent((ev) => {
      sawActivity = true;
      if (ev?.kind === 'result' || ev?.kind === 'exit') sawResult = true;
      if (tryEarly()) return;
      // think / spinner / empty tui keep-alives must not reset the hard cap
      // and must not re-arm the quiet timer (that is how a think loop hung).
      if (eventKeepsAlive(ev)) return;
      armQuiet();
    });
    const onAbort = () => finish();
    if (signal) {
      if (signal.aborted) { finish(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const hardTimer = setTimeout(finish, hard);
    const promptTimer = setTimeout(() => {
      if (finished) return;
      if (tryEarly()) return;
      // writeLine produced no activity and no assistant text — TUI never took the line.
      if (!sawActivity && !sessionVisibleText(sess)) finish();
    }, Math.min(promptWait, hard));
    const minTimer = setTimeout(() => {
      if (tryEarly()) return;
    }, minWait);
  });
}

async function attachSession({ cli, prefixArgs = [], cwd, sessionId, model, system, env, key }) {
  const resume = sessionId || latestClaudeSessionId(cwd);
  const args = [...prefixArgs, ...claudeInteractiveArgs({ sessionId: resume, model, system })];
  const sess = new ClaudePtySession({ cli, args, cwd, env, sessionId: resume, key });
  await waitReady(sess);
  if (!sess.sessionId) sess.sessionId = latestClaudeSessionId(cwd) || resume || '';
  return sess;
}

export async function runClaudeCode({
  prompt,
  cwd,
  sessionId,
  model,
  system,
  env = process.env,
  port,
  onEvent,
  signal,
  sessionKey,
  waitIdleMs,
} = {}) {
  if (runnerOverride) {
    return runnerOverride({
      prompt, cwd, sessionId, model, system, env, port, onEvent, signal, sessionKey, waitIdleMs,
    });
  }
  const zooEnv = claudeZooEnv(env, { port });
  const resolved = resolveOpenzooClaude(zooEnv);
  if (!resolved) {
    return { text: CLAUDE_MISSING, error: true, paymentFailed: '', sessionId: sessionId || '', missing: true };
  }
  const cli = resolved.command;
  const prefixArgs = resolved.prefixArgs;
  if (process.platform === 'win32' && !loadNodePty()) {
    return { text: PTY_WINDOWS, error: true, paymentFailed: '', sessionId: sessionId || '' };
  }
  const key = sessionKey || cwd || '__default__';
  let sess = liveSessions.get(key);
  const wantResume = sessionId || sess?.sessionId || '';
  if (!sess || sess.dead) {
    try {
      sess = await attachSession({
        cli, prefixArgs, cwd, sessionId: wantResume, model, system, env: zooEnv, key,
      });
    } catch (e) {
      return {
        text: e.code === 'PTY_WINDOWS' ? PTY_WINDOWS : `could not launch claude: ${e.message}`,
        error: true,
        paymentFailed: '',
        sessionId: wantResume,
      };
    }
    liveSessions.set(key, sess);
  }
  const off = onEvent ? sess.onEvent((ev) => {
    if (ev.sessionId) { /* keep */ }
    try { onEvent(ev); } catch { /* paint */ }
  }) : () => {};
  try {
    if (prompt != null && String(prompt) !== '') sess.writeLine(prompt);
    await waitIdle(sess, { signal, hardCapMs: waitIdleMs });
    if (sess.dead && wantResume && !signal?.aborted) {
      // PTY died mid-turn — one resume, do not pkill anything else.
      liveSessions.delete(key);
      try {
        sess = await attachSession({
          cli, prefixArgs, cwd, sessionId: sess.sessionId || wantResume, model, system, env: zooEnv, key,
        });
        liveSessions.set(key, sess);
        if (prompt != null && String(prompt) !== '') sess.writeLine(prompt);
        await waitIdle(sess, { signal, hardCapMs: waitIdleMs });
      } catch { /* keep the death text */ }
    }
    const folded = sess.screenText();
    const sid = sess.sessionId || latestClaudeSessionId(cwd) || wantResume;
    const pay = folded.paymentFailed || paymentFailText(folded.text);
    const deadErr = Boolean(sess.dead && sess.exitCode && sess.exitCode !== 0);
    let text = pay || folded.text || '';
    if (!pay) text = sanitizeClaudeCanvas(text, { error: deadErr }) || text;
    return {
      text,
      thinking: folded.thinking || '',
      error: Boolean(pay) || deadErr,
      paymentFailed: pay,
      sessionId: sid,
      exitCode: sess.dead ? sess.exitCode : null,
    };
  } finally {
    off();
  }
}

/** Test helper: one-shot PTY to a given binary (same attach as Auto). */
export async function spawnClaudeInteractive({
  cli, args, cwd, env, onEvent, signal, prompt = '', waitIdleMs,
}) {
  const sess = new ClaudePtySession({
    cli, args: args || claudeInteractiveArgs({}), cwd, env: env || process.env, key: `test-${Date.now()}`,
  });
  const off = onEvent ? sess.onEvent(onEvent) : () => {};
  try {
    await waitReady(sess, 1500);
    if (prompt) sess.writeLine(prompt);
    await waitIdle(sess, { signal, minWait: 80, hardCapMs: waitIdleMs });
    const folded = sess.screenText();
    return {
      text: folded.text,
      thinking: folded.thinking,
      tools: folded.tools,
      sessionId: sess.sessionId,
      error: Boolean(sess.dead && sess.exitCode && sess.exitCode !== 0),
      paymentFailed: folded.paymentFailed,
      kind: sess.handle.kind,
    };
  } finally {
    off();
    sess.dispose();
  }
}
