import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  claudeInteractiveArgs, claudeModelArg, foldClaudeEvent, foldTuiText, stripAnsi,
  sanitizeClaudeOutput, looksRawToolJson, tuiLooksIdle, TinyTerm,
  toolStatusLine, paymentFailText, GROKUI_RESERVED_SLASH,
  AUTO_CLAUDE_SYSTEM, CLAUDE_MISSING, PTY_PENDING,
  spawnClaudeInteractive, setClaudeRunnerForTest, runClaudeCode, waitIdle,
  sanitizeClaudeCanvas, looksBinaryCanvas, canvasHttpErrorLine,
  WAIT_IDLE_HARD_MS, setNodePtyLoaderForTest, setPtyPlatformForTest,
  hasLiveClaudeSession, closeClaudeSession, isToolRunningLine,
} from '../lib/claudecode.js';
import { claudeZooEnv } from '../lib/launch.js';
import { CANVAS_PTY_RECIPE } from '../lib/packed-runtime.js';
import { fileURLToPath } from 'node:url';

const RECIPE = /install node-pty|\bconpty\b|PTY_WINDOWS|--print cannot grow/;
const claudeSrc = readFileSync(fileURLToPath(new URL('../lib/claudecode.js', import.meta.url)), 'utf8');

test('claudeInteractiveArgs is the TUI, not --print stream-json', () => {
  const args = claudeInteractiveArgs({ sessionId: 's1', model: 'openzoo-claude-sonnet-5' });
  assert.ok(!args.includes('--print'));
  assert.ok(!args.includes('--output-format'));
  assert.ok(!args.includes('stream-json'));
  assert.ok(args.includes('--permission-mode'));
  assert.ok(args.includes('bypassPermissions'));
  assert.ok(args.includes('--append-system-prompt'));
  assert.ok(args.includes(AUTO_CLAUDE_SYSTEM));
  assert.match(AUTO_CLAUDE_SYSTEM, /Do not curl localhost:8402\/v1\/chat\/completions/);
  assert.doesNotMatch(AUTO_CLAUDE_SYSTEM, /RUN: curl/);
  assert.ok(args.includes('--resume'));
  assert.ok(args.includes('s1'));
  assert.ok(!args.includes('write hello'), 'prompt is written to PTY stdin, not argv');
  assert.deepEqual([...GROKUI_RESERVED_SLASH], ['mode', 'tier', 'help', 'dir']);
  assert.ok(!GROKUI_RESERVED_SLASH.includes('goal'), '/goal is a Claude slash — write it to PTY stdin');
});

test('claudeInteractiveArgs never passes --model openzoo/auto', () => {
  assert.equal(claudeModelArg('openzoo/auto'), undefined);
  assert.equal(claudeModelArg('openzoo-auto'), undefined);
  assert.equal(claudeModelArg('auto'), undefined);
  assert.equal(claudeModelArg(''), undefined);
  assert.equal(claudeModelArg(undefined), undefined);
  assert.equal(claudeModelArg('openzoo-claude-sonnet-5'), 'openzoo-claude-sonnet-5');
  for (const id of ['openzoo/auto', 'openzoo-auto', 'auto', '', undefined]) {
    const args = claudeInteractiveArgs({ model: id });
    assert.equal(args.includes('--model'), false, String(id));
    assert.equal(args.includes('openzoo/auto'), false, String(id));
  }
  const pinned = claudeInteractiveArgs({ model: 'openzoo-claude-sonnet-5' });
  assert.ok(pinned.includes('--model'));
  assert.ok(pinned.includes('openzoo-claude-sonnet-5'));
});

test('foldClaudeEvent still maps leaked stream-json, not RUN:/WRITE: text', () => {
  const init = foldClaudeEvent({
    type: 'system', subtype: 'init', session_id: 'abc', model: 'openzoo-claude',
    tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
  });
  assert.equal(init.kind, 'init');
  assert.equal(init.sessionId, 'abc');
  assert.ok(init.tools.includes('Write'));

  const think = foldClaudeEvent({
    type: 'stream_event', session_id: 'abc',
    event: { delta: { type: 'thinking_delta', thinking: 'plan' } },
  });
  assert.equal(think.kind, 'think');
  assert.equal(think.text, 'plan');

  const asst = foldClaudeEvent({
    type: 'assistant',
    session_id: 'abc',
    message: {
      content: [
        { type: 'thinking', thinking: 'secret' },
        { type: 'text', text: 'Writing files' },
        { type: 'tool_use', name: 'Write', input: { file_path: 'a.txt', content: 'hi' } },
      ],
    },
  });
  assert.equal(asst.kind, 'assistant');
  assert.equal(asst.thinking, 'secret');
  assert.equal(asst.text, 'Writing files');
  assert.equal(asst.tools[0].name, 'Write');
  assert.equal(toolStatusLine('Write', { file_path: 'a.txt' }), 'Write a.txt');
  assert.equal(toolStatusLine('Bash', { command: 'ls -la' }), 'Bash ls -la');
  assert.doesNotMatch(toolStatusLine('Bash', { command: 'pwd' }), /RUN:/);

  const pay = foldClaudeEvent({
    type: 'result', is_error: true, session_id: 'abc',
    result: 'HTTP 402 the wallet is empty',
  });
  assert.match(pay.paymentFailed, /wallet is empty/);
  assert.match(paymentFailText('openzoo wallet underfunded: need more'), /underfunded|empty/);
  assert.equal(paymentFailText('ok'), '');

  const toolStart = foldClaudeEvent({
    type: 'stream_event', session_id: 'abc',
    event: {
      type: 'content_block_start',
      content_block: { type: 'tool_use', name: 'Read', input: { file_path: 'foo.js' } },
    },
  });
  assert.equal(toolStart.kind, 'tool');
  assert.equal(toolStart.name, 'Read');
  assert.equal(toolStatusLine(toolStart.name, toolStart.input), 'Read foo.js');

  const toolResult = foldClaudeEvent({
    type: 'user', session_id: 'abc',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] },
  });
  assert.equal(toolResult.kind, 'tool_result');

  const thinkStart = foldClaudeEvent({
    type: 'stream_event', session_id: 'abc',
    event: { type: 'content_block_start', content_block: { type: 'thinking', thinking: '' } },
  });
  assert.equal(thinkStart.kind, 'think');

  const bad = foldClaudeEvent({
    type: 'result', is_error: true, session_id: 'abc',
    result: 'API Error: 400 ' + '\uFFFD'.repeat(8) + 'gzip',
  });
  assert.equal(bad.text, 'upstream HTTP 400');
  assert.equal(bad.error, true);
});

test('sanitizeClaudeCanvas never paints dumps, reminders, or binary 400s', () => {
  assert.equal(sanitizeClaudeCanvas('hello'), 'hello');
  assert.equal(sanitizeClaudeCanvas('API Error: 400 {"type":"error"}', { error: true }), 'upstream HTTP 400');
  assert.equal(canvasHttpErrorLine('API Error: 400 ' + '\uFFFD'.repeat(12)), 'upstream HTTP 400');
  assert.equal(looksBinaryCanvas('\uFFFD\uFFFD\uFFFD'), true);
  assert.equal(looksBinaryCanvas(Buffer.from([0x1f, 0x8b, 0x08, 0x00])), true);
  assert.equal(
    sanitizeClaudeCanvas('ok\n<system-reminder>do not leak</system-reminder>\nmore'),
    'ok\n\nmore',
  );
  assert.doesNotMatch(
    sanitizeClaudeCanvas('visible\ncurrentDir: /tmp/secret\nmore'),
    /currentDir/,
  );
  assert.doesNotMatch(sanitizeClaudeCanvas('RUN: mkdir -p foo\nWRITE: a.txt'), /RUN:|WRITE:/);
  assert.equal(sanitizeClaudeCanvas('{"type":"tool_use","file_path":"/tmp/x"}'), '');
  assert.doesNotMatch(sanitizeClaudeCanvas('SPAWN: kid | go'), /SPAWN:/);
  assert.equal(isToolRunningLine('[LS] running...'), true);
  assert.equal(isToolRunningLine('[Read] running...'), true);
  assert.equal(isToolRunningLine('[Bash] running...'), true);
  assert.doesNotMatch(
    sanitizeClaudeCanvas('Hello\n[LS] running...\n[Read] running...\n[Bash] running...\nDone'),
    /\[LS\]|\[Read\]|\[Bash\]|running\.\.\./,
  );
  assert.doesNotMatch(
    sanitizeClaudeCanvas('ok\n<tool-use>{"name":"Bash"}</tool-use>\nmore'),
    /tool-use|Bash/,
  );
  const trail = foldTuiText('[LS] running...\n[Read] running...\n[Bash] running...\nThe files are ready.\n> ');
  assert.match(trail.text, /The files are ready/);
  assert.doesNotMatch(trail.text, /\[LS\]|\[Read\]|\[Bash\]|running\.\.\./);
});

test('foldTuiText strips ANSI, folds thinking, drops tool JSON', () => {
  const raw = '\x1b[2m✻ Thinking…\x1b[0m\nplan the write\n● Write note.md\n'
    + '{"type":"tool_use","name":"Write","input":{"file_path":"note.md"}}\n'
    + 'Created note.md\n> ';
  const folded = foldTuiText(raw);
  assert.match(folded.thinking, /plan the write|thinking/);
  assert.match(folded.text, /Created note.md/);
  assert.doesNotMatch(folded.text, /tool_use/);
  assert.doesNotMatch(folded.text, /file_path/);
  assert.equal(folded.tools[0]?.name, 'Write');
  const taskFold = foldTuiText('● Task Worker A\n● Agent planner\nCrew is up.\n> ');
  assert.equal(taskFold.tools[0]?.name, 'Task');
  assert.equal(taskFold.tools[0]?.input?.description, 'Worker A');
  assert.equal(taskFold.tools[0]?.input?.file_path, undefined);
  assert.equal(taskFold.tools[1]?.name, 'Agent');
  assert.equal(taskFold.tools[1]?.input?.description, 'planner');
  assert.doesNotMatch(taskFold.text, /tool_use|file_path/);
  assert.equal(looksRawToolJson('{"type":"assistant","message":{}}'), true);
  assert.equal(tuiLooksIdle('Agents\n> '), true);
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
});

test('binary HTTP 400 bodies become a short line, not diamond mojibake', () => {
  const gzip = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x41, 0x42, 0x43, 0x00, 0xff]);
  assert.equal(sanitizeClaudeOutput(gzip), 'upstream HTTP 400');
  const diamonds = Buffer.from('HTTP/1.1 400 Bad Request\n' + '\x80\x81\x82\x83\x84\x85\x86\x87', 'latin1');
  assert.equal(sanitizeClaudeOutput(diamonds), 'upstream HTTP 400');
  assert.equal(foldTuiText(diamonds).text, 'upstream HTTP 400');
  assert.equal(sanitizeClaudeOutput('hello from claude'), 'hello from claude');
});

test('TinyTerm applies cursor home instead of dumping CSI', () => {
  const t = new TinyTerm(4, 20);
  t.write('old frame\n');
  t.write('\x1b[2J\x1b[HAgents\r\n  Explore\r\n> ');
  assert.match(t.text(), /Agents/);
  assert.match(t.text(), /Explore/);
  assert.doesNotMatch(t.text(), /old frame/);
});

function writeFakeClaude(dir) {
  const cli = path.join(dir, 'claude');
  writeFileSync(cli, `#!/usr/bin/env node
const tty = !!(process.stdout.isTTY && process.stdin.isTTY);
const print = process.argv.includes('--print');
if (print || !tty) {
  process.stdout.write('wizard removed\\n');
  process.stdout.write("isn't available in this environment\\n");
  process.exit(0);
}
process.stdout.write('session_id=sess-pty-1\\n> ');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  const parts = buf.split(/\\r\\n|\\n|\\r/);
  buf = parts.pop() || '';
  for (const raw of parts) {
    const line = raw.replace(/\\r/g, '').trim();
    if (line === '/agents') process.stdout.write('Agents\\n  Explore\\n  Plan\\n> ');
    else if (line === '/tasks') process.stdout.write('Tasks\\n  (none yet)\\n> ');
    else if (line === 'quit') process.exit(0);
    else process.stdout.write('got:' + line + '\\n> ');
  }
});
`);
  chmodSync(cli, 0o755);
  return cli;
}

test('spawnClaudeInteractive PTY runs /agents — not the print-mode stub', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-pty-claude-'));
  const cli = writeFakeClaude(dir);
  const events = [];
  const r = await spawnClaudeInteractive({
    cli,
    args: ['--permission-mode', 'bypassPermissions'],
    cwd: dir,
    env: { ...process.env, TERM: 'xterm-256color' },
    prompt: '/agents',
    onEvent: (ev) => events.push(ev),
  });
  assert.doesNotMatch(r.text, /wizard removed/);
  assert.doesNotMatch(r.text, /isn't available in this environment/);
  assert.match(r.text, /Agents/);
  assert.match(r.text, /Explore/);
  assert.ok(r.kind === 'script' || r.kind === 'node-pty');
  assert.ok(events.some((e) => (e.text || '').includes('Agents') || (e.kind === 'tui' && /Agents/.test(e.text || ''))));
});

function mockPtySession({ text = '', term = '', dead = false } = {}) {
  const listeners = new Set();
  const sess = {
    dead,
    _text: text,
    _term: term,
    term: { text: () => sess._term },
    screenText: () => ({ text: sess._text, thinking: sess._thinking || '' }),
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(ev) {
      for (const fn of listeners) fn(ev);
    },
    paint({ text, term, thinking } = {}) {
      if (text != null) sess._text = text;
      if (term != null) sess._term = term;
      if (thinking != null) sess._thinking = thinking;
    },
  };
  return sess;
}

test('waitIdle hard-cap settles when think events never stop', async () => {
  assert.equal(WAIT_IDLE_HARD_MS, 90_000);
  const sess = mockPtySession({ term: '✻ Thinking…', text: '' });
  const iv = setInterval(() => sess.emit({ kind: 'think', text: '…' }), 15);
  const t0 = Date.now();
  await waitIdle(sess, { hardCapMs: 200, minWait: 10, promptWaitMs: 5_000 });
  clearInterval(iv);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 160, `hard cap must hold (~200ms), got ${elapsed}ms`);
  assert.ok(elapsed < 900, `think loop must not hang waitIdle, got ${elapsed}ms`);
});

test('waitIdle does not finish early on a question or dummy write + idle', async () => {
  const question = mockPtySession();
  const t0 = Date.now();
  const q = waitIdle(question, { hardCapMs: 350, minWait: 10, promptWaitMs: 5_000 });
  setTimeout(() => {
    question.paint({
      text: 'what would you like to do?',
      term: 'what would you like to do?\n> ',
    });
    question.emit({ kind: 'tui', text: 'what would you like to do?' });
  }, 20);
  await q;
  const qElapsed = Date.now() - t0;
  assert.ok(qElapsed >= 280, `question+idle must not complete the send, got ${qElapsed}ms`);
  assert.match(question.screenText().text, /what would you like to do/);
  assert.notEqual(question.screenText().text, '(no response)');

  const dummy = mockPtySession();
  const d0 = Date.now();
  const d = waitIdle(dummy, { hardCapMs: 350, minWait: 10, promptWaitMs: 5_000 });
  setTimeout(() => {
    dummy.paint({ text: 'Wrote dummy.txt', term: 'Wrote dummy.txt\n> ' });
    dummy.emit({ kind: 'tui', text: 'Wrote dummy.txt' });
  }, 20);
  await d;
  const dElapsed = Date.now() - d0;
  assert.ok(dElapsed >= 280, `dummy write+idle must not complete the send, got ${dElapsed}ms`);
  assert.equal(dummy.dead, false);
});

test('runClaudeCode override and missing CLI', async () => {
  setClaudeRunnerForTest(async ({ prompt }) => ({
    text: 'overridden ' + prompt, sessionId: 'x', error: false, paymentFailed: '',
  }));
  const r = await runClaudeCode({ prompt: 'hi' });
  assert.equal(r.text, 'overridden hi');
  setClaudeRunnerForTest(null);
  const env = claudeZooEnv({ PATH: '/no/claude/here', ANTHROPIC_API_KEY: 'sk-ant' }, { port: 8402 });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  const miss = await runClaudeCode({
    prompt: 'x',
    env: { ...process.env, PATH: '/no/claude/here', OPENZOO_CLAUDE_PATH_ONLY: '1' },
  });
  assert.equal(miss.missing, true);
  assert.equal(miss.ptyPending, true);
  assert.equal(miss.text, PTY_PENDING);
  assert.equal(CLAUDE_MISSING, PTY_PENDING);
  assert.match(PTY_PENDING, /Auto is starting/);
  assert.doesNotMatch(miss.text, /will use chat/);
  assert.doesNotMatch(CLAUDE_MISSING, /npx -y openzoo-claude/);
  assert.doesNotMatch(CLAUDE_MISSING, /npm i -g/);
  assert.doesNotMatch(CLAUDE_MISSING, /install\.sh/);
  assert.doesNotMatch(CLAUDE_MISSING, /claude\.ai/);
  assert.doesNotMatch(claudeSrc, /PTY_WINDOWS/);
  assert.doesNotMatch(claudeSrc, /install node-pty/);
  assert.doesNotMatch(claudeSrc, /--print cannot grow/);
  assert.doesNotMatch(PTY_PENDING, RECIPE);
  assert.equal(sanitizeClaudeCanvas(
    'Auto PTY is Mac/Linux first (`script` host PTY). On Windows install node-pty (conpty) — --print cannot grow the TUI',
  ), '');
});

test('runClaudeCode on win32 without a loaded pty never returns an install recipe', async () => {
  setPtyPlatformForTest('win32');
  setNodePtyLoaderForTest(() => null);
  const prev = process.env.OZ_PTY_WAIT_MS;
  process.env.OZ_PTY_WAIT_MS = '0';
  try {
    const dir = mkdtempSync(path.join(tmpdir(), 'oz-win-pty-'));
    const cli = writeReplyIdleClaude(dir);
    const r = await runClaudeCode({
      prompt: 'hi',
      cwd: dir,
      env: { ...process.env, PATH: dir, OZ_PTY_WAIT_MS: '0', OPENZOO_CLAUDE_PATH_ONLY: '1' },
    });
    const text = String(r.text || '');
    assert.doesNotMatch(text, RECIPE);
    assert.doesNotMatch(text, CANVAS_PTY_RECIPE);
    assert.equal(r.ptyPending, true);
    assert.equal(r.error, true);
    assert.ok(cli);
  } finally {
    setPtyPlatformForTest(null);
    setNodePtyLoaderForTest(null);
    if (prev == null) delete process.env.OZ_PTY_WAIT_MS;
    else process.env.OZ_PTY_WAIT_MS = prev;
  }
});

function writeReplyIdleClaude(dir) {
  const cli = path.join(dir, 'openzoo-claude');
  writeFileSync(cli, `#!/usr/bin/env node
process.stdout.write('session_id=sess-reply-1\\n> ');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  const parts = buf.split(/\\r\\n|\\n|\\r/);
  buf = parts.pop() || '';
  for (const raw of parts) {
    const line = raw.replace(/\\r/g, '').trim();
    if (!line) continue;
    process.stdout.write('The files are written.\\n> ');
  }
});
`);
  chmodSync(cli, 0o755);
  return cli;
}

function writeThinkForeverClaude(dir) {
  const cli = path.join(dir, 'openzoo-claude');
  writeFileSync(cli, `#!/usr/bin/env node
process.stdout.write('session_id=sess-think-1\\n> ');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  if (!buf.trim()) return;
  const tick = () => process.stdout.write('\\x1b[2m✻ Thinking…\\x1b[0m\\n');
  tick();
  setInterval(tick, 20);
});
`);
  chmodSync(cli, 0o755);
  return cli;
}

test('spawnClaudeInteractive reply + idle is that reply, not (no response)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-pty-reply-'));
  const cli = writeReplyIdleClaude(dir);
  const r = await spawnClaudeInteractive({
    cli,
    args: ['--permission-mode', 'bypassPermissions'],
    cwd: dir,
    env: { ...process.env, TERM: 'xterm-256color' },
    prompt: 'write the files',
    waitIdleMs: 4000,
  });
  assert.match(r.text, /The files are written/);
  assert.notEqual(r.text.trim(), '(no response)');
  assert.doesNotMatch(r.text, /\(no response\)/);
});

function writeQuestionIdleClaude(dir) {
  const cli = path.join(dir, 'openzoo-claude');
  writeFileSync(cli, `#!/usr/bin/env node
process.stdout.write('session_id=sess-ask-1\\n> ');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  const parts = buf.split(/\\r\\n|\\n|\\r/);
  buf = parts.pop() || '';
  for (const raw of parts) {
    const line = raw.replace(/\\r/g, '').trim();
    if (!line) continue;
    process.stdout.write('what would you like to do?\\n> ');
  }
});
`);
  chmodSync(cli, 0o755);
  return cli;
}

function writeGoalClaude(dir) {
  const cli = path.join(dir, 'openzoo-claude');
  writeFileSync(cli, `#!/usr/bin/env node
process.stdout.write('session_id=sess-goal-1\\n> ');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  const parts = buf.split(/\\r\\n|\\n|\\r/);
  buf = parts.pop() || '';
  for (const raw of parts) {
    const line = raw.replace(/\\r/g, '').trim();
    if (!line) continue;
    if (line.startsWith('/goal')) process.stdout.write('goal accepted: ' + line + '\\nworking\\n> ');
    else process.stdout.write('got:' + line + '\\n> ');
  }
});
`);
  chmodSync(cli, 0o755);
  return cli;
}

test('runClaudeCode stays on liveSessions after a question — not (no response)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-pty-live-q-'));
  writeQuestionIdleClaude(dir);
  const key = 'live-question';
  try {
    const r = await runClaudeCode({
      prompt: 'hi',
      cwd: dir,
      sessionKey: key,
      env: { ...process.env, PATH: dir, OPENZOO_CLAUDE_PATH_ONLY: '1', TERM: 'xterm-256color' },
      waitIdleMs: 400,
      stayLive: false,
    });
    assert.match(String(r.text || ''), /what would you like to do/i);
    assert.notEqual(String(r.text || '').trim(), '(no response)');
    assert.doesNotMatch(String(r.text || ''), /\(no response\)/);
    assert.equal(r.live, true);
    assert.equal(hasLiveClaudeSession(key), true);
  } finally {
    closeClaudeSession(key);
  }
});

test('spawnClaudeInteractive writes /goal to PTY stdin', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-pty-goal-'));
  const cli = writeGoalClaude(dir);
  const r = await spawnClaudeInteractive({
    cli,
    args: ['--permission-mode', 'bypassPermissions'],
    cwd: dir,
    env: { ...process.env, TERM: 'xterm-256color' },
    prompt: '/goal ship the work',
    waitIdleMs: 4000,
  });
  assert.match(r.text, /goal accepted/);
  assert.match(r.text, /\/goal ship the work/);
  assert.doesNotMatch(r.text, /wizard removed/);
  assert.notEqual(r.text.trim(), '(no response)');
});

test('spawnClaudeInteractive infinite think settles at waitIdle hard-cap', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-pty-think-'));
  const cli = writeThinkForeverClaude(dir);
  const t0 = Date.now();
  const r = await spawnClaudeInteractive({
    cli,
    args: ['--permission-mode', 'bypassPermissions'],
    cwd: dir,
    env: { ...process.env, TERM: 'xterm-256color' },
    prompt: 'think forever',
    waitIdleMs: 400,
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 3000, `think-forever PTY must settle via cap, got ${elapsed}ms`);
  assert.doesNotMatch(String(r.text || ''), /wizard removed/);
});
