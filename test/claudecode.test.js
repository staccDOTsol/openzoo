import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  claudeInteractiveArgs, foldClaudeEvent, foldTuiText, stripAnsi,
  sanitizeClaudeOutput, looksRawToolJson, tuiLooksIdle, TinyTerm,
  toolStatusLine, paymentFailText, GROKUI_RESERVED_SLASH,
  AUTO_CLAUDE_SYSTEM, CLAUDE_MISSING, PTY_WINDOWS,
  spawnClaudeInteractive, setClaudeRunnerForTest, runClaudeCode,
  sanitizeClaudeCanvas, looksBinaryCanvas, canvasHttpErrorLine,
} from '../lib/claudecode.js';
import { claudeZooEnv } from '../lib/launch.js';

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
  assert.match(miss.text, /still installing Claude/);
  assert.match(CLAUDE_MISSING, /installing Claude/);
  assert.doesNotMatch(CLAUDE_MISSING, /curl -fsSL/);
  assert.doesNotMatch(CLAUDE_MISSING, /install\.sh/);
  assert.match(PTY_WINDOWS, /node-pty/);
});
