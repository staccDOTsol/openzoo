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
    const delta = ev.event?.delta;
    if (delta?.type === 'thinking_delta' && delta.thinking) {
      return { kind: 'think', text: delta.thinking, sessionId };
    }
    if (delta?.type === 'text_delta' && delta.text) {
      return { kind: 'text', text: delta.text, sessionId };
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
      else if (b.type === 'text' && b.text) text.push(b.text);
      else if (b.type === 'tool_use') tools.push({ name: b.name, input: b.input || {} });
    }
    return {
      kind: 'assistant',
      thinking: thinking.join('\n'),
      text: text.join(''),
      tools,
      sessionId,
    };
  }
  if (ev.type === 'result') {
    const raw = ev.result != null ? String(ev.result) : (ev.error != null ? String(ev.error) : '');
    const pay = paymentFailText(raw);
    return {
      kind: 'result',
      text: raw,
      error: Boolean(ev.is_error || ev.subtype === 'error' || ev.subtype === 'error_during_execution'),
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
      const s = String(chunk);
      if (which === 'err') stderr += s;
      else stdout += s;
      if (which !== 'out') return;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || '';
      for (const line of lines) {
        const raw = parseNdjsonLine(line);
        if (!raw) continue;
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
      if (!text && stderr.trim()) text = stderr.trim().slice(0, 4000);
      if (!text && code && code !== 0) text = `claude exited ${code}`;
      resolve({
        text: text || '',
        error: sawError || (code !== 0 && code != null),
        paymentFailed: outPay,
        sessionId: sid,
        stderr,
        exitCode: code,
      });
    });
  });
}
