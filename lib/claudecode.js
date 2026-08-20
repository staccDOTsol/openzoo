/**
 * Drive Claude Code (`claude --print --output-format stream-json`) as grokui
 * Auto. This is the same harness `openzoo claude` launches: env from
 * claudeZooEnv (ANTHROPIC_BASE_URL + AUTH_TOKEN at :8402, no Anthropic
 * API key). Tools are Claude Code's own (Bash, Read, Write, Edit, Glob, Grep).
 *
 * Do not re-parse RUN:/WRITE:/DONE: here. Stream-json is Claude Code's
 * official print protocol; we only fold those events onto the canvas.
 */
import { spawn } from 'node:child_process';
import { claudeZooEnv, resolveClaudeCli } from './launch.js';

export const AUTO_CLAUDE_SYSTEM = 'You are grokui Auto, paid per call through the local OpenZoo proxy (x402 on :8402). '
  + 'Use your native tools (Bash, Read, Write, Edit, Glob, Grep) to do the work in this working directory. '
  + 'Do not curl localhost:8402/v1/chat/completions and do not emit RUN:/WRITE:/DONE: text directives — you already have real tools. '
  + 'Do not ask the user to type continue.';

export const CLAUDE_MISSING = 'claude CLI not found. Auto is the Claude Code harness via OpenZoo — install it with: '
  + 'curl -fsSL https://claude.ai/install.sh | bash  (then ensure ~/.local/bin is on PATH). '
  + 'No Anthropic login: `openzoo claude` already points ANTHROPIC_BASE_URL at the local proxy.';

let runnerOverride = null;
export function setClaudeRunnerForTest(fn) {
  runnerOverride = typeof fn === 'function' ? fn : null;
}

export function claudePrintArgs({ prompt, sessionId, model, system } = {}) {
  const args = [
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
    '--permission-mode', 'bypassPermissions',
  ];
  const sys = system === undefined ? AUTO_CLAUDE_SYSTEM : system;
  if (sys) args.push('--append-system-prompt', sys);
  if (sessionId) args.push('--resume', String(sessionId));
  if (model) args.push('--model', String(model));
  if (prompt != null && prompt !== '') args.push(String(prompt));
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
  if (n === 'Task') return `Task ${i.description || i.prompt || ''}`.trim();
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

function chunkToText(chunk) {
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(chunk)) {
    if (chunk.length >= 2 && chunk[0] === 0x1f && chunk[1] === 0x8b) return '\uFFFD';
    return chunk.toString('utf8');
  }
  return String(chunk ?? '');
}

/**
 * Fold one Claude Code stream-json object into a grokui-sized event.
 * Not a RUN: parser — just the official print protocol.
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
} = {}) {
  if (runnerOverride) {
    return runnerOverride({ prompt, cwd, sessionId, model, system, env, port, onEvent, signal });
  }
  const zooEnv = claudeZooEnv(env, { port });
  const cli = resolveClaudeCli(zooEnv);
  if (!cli) {
    return { text: CLAUDE_MISSING, error: true, paymentFailed: '', sessionId: sessionId || '', missing: true };
  }
  const args = claudePrintArgs({ prompt, sessionId, model, system });
  return spawnClaudePrint({ cli, args, cwd, env: zooEnv, onEvent, signal, sessionId });
}

export function spawnClaudePrint({ cli, args, cwd, env, onEvent, signal, sessionId }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cli, args, {
        cwd: cwd || process.cwd(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({
        text: `could not launch claude: ${e.message}`,
        error: true,
        paymentFailed: '',
        sessionId: sessionId || '',
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let sid = sessionId || '';
    let lastText = '';
    let lastPay = '';
    let sawError = false;
    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch { /* gone */ }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const take = (chunk, which) => {
      const s = chunkToText(chunk);
      if (which === 'err') stderr += s;
      else stdout += s;
      if (which === 'err') {
        const errLine = canvasHttpErrorLine(s, { error: true });
        if (errLine) {
          lastText = lastText || errLine;
          sawError = true;
        }
        return;
      }
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || '';
      for (const line of lines) {
        const raw = parseNdjsonLine(line);
        if (!raw) {
          const dump = canvasHttpErrorLine(line, { error: /API Error/i.test(line) });
          if (dump) {
            lastText = dump;
            sawError = true;
          }
          continue;
        }
        const folded = foldClaudeEvent(raw);
        if (!folded) continue;
        if (folded.sessionId) sid = folded.sessionId;
        if (folded.kind === 'result') {
          lastText = folded.text || lastText;
          lastPay = folded.paymentFailed || lastPay;
          if (folded.error) sawError = true;
        } else if (folded.kind === 'assistant' && folded.text) {
          lastText = folded.text;
        }
        try { onEvent?.(folded); } catch { /* paint must not kill the child */ }
      }
    };
    child.stdout.on('data', (d) => take(d, 'out'));
    child.stderr.on('data', (d) => take(d, 'err'));
    child.on('error', (e) => {
      if (signal) signal.removeEventListener?.('abort', onAbort);
      resolve({
        text: `could not launch claude: ${e.message}`,
        error: true,
        paymentFailed: '',
        sessionId: sid,
      });
    });
    child.on('close', (code) => {
      if (signal) signal.removeEventListener?.('abort', onAbort);
      if (stdout.trim()) take('\n', 'out');
      const errPay = paymentFailText(stderr);
      const outPay = lastPay || paymentFailText(lastText) || errPay;
      let text = lastText;
      if (!text) {
        const dump = [stdout, stderr].filter((x) => String(x || '').trim()).join('\n');
        if (dump.trim()) text = sanitizeClaudeCanvas(dump, { error: true });
      } else {
        text = sanitizeClaudeCanvas(text, { error: sawError }) || text;
      }
      if (!text && code && code !== 0) text = `claude exited ${code}`;
      resolve({
        text: text || '',
        error: sawError || (code !== 0 && code != null),
        paymentFailed: outPay,
        sessionId: sid,
        stderr: looksBinaryCanvas(stderr) ? '' : stderr,
        exitCode: code,
      });
    });
  });
}
