import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  claudePrintArgs, foldClaudeEvent, toolStatusLine, paymentFailText,
  AUTO_CLAUDE_SYSTEM, CLAUDE_MISSING, spawnClaudePrint, setClaudeRunnerForTest,
  runClaudeCode,
} from '../lib/claudecode.js';
import { claudeZooEnv } from '../lib/launch.js';

test('claudePrintArgs is the official print loop, not a RUN: parser', () => {
  const args = claudePrintArgs({ prompt: 'write hello', sessionId: 's1', model: 'openzoo-claude-sonnet-5' });
  assert.ok(args.includes('--print'));
  assert.ok(args.includes('--verbose'));
  assert.ok(args.includes('stream-json'));
  assert.ok(args.includes('--permission-mode'));
  assert.ok(args.includes('bypassPermissions'));
  assert.ok(args.includes('--append-system-prompt'));
  assert.ok(args.includes(AUTO_CLAUDE_SYSTEM));
  assert.doesNotMatch(AUTO_CLAUDE_SYSTEM, /curl localhost:8402\/v1\/chat\/completions/);
  assert.match(AUTO_CLAUDE_SYSTEM, /Do not curl localhost:8402\/v1\/chat\/completions/);
  assert.ok(args.includes('--resume'));
  assert.ok(args.includes('s1'));
  assert.ok(args.includes('write hello'));
  assert.ok(!args.includes('RUN:'));
});

test('foldClaudeEvent maps stream-json, not RUN:/WRITE: text', () => {
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
});

test('spawnClaudePrint reads NDJSON from a fake claude binary', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-fake-claude-'));
  const cli = path.join(dir, 'claude');
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs');
function emit(o) { process.stdout.write(JSON.stringify(o) + '\\n'); }
emit({ type: 'system', subtype: 'init', session_id: 'sess-fake', model: 'openzoo-claude', tools: ['Write'] });
emit({ type: 'assistant', session_id: 'sess-fake', message: { content: [
  { type: 'thinking', thinking: 'write it' },
  { type: 'text', text: 'Creating note.md' },
  { type: 'tool_use', name: 'Write', input: { file_path: 'note.md', content: 'hi' } },
] } });
fs.writeFileSync('note.md', 'hi from fake claude');
emit({ type: 'result', subtype: 'success', result: 'Created note.md', session_id: 'sess-fake' });
`);
  chmodSync(cli, 0o755);
  const events = [];
  const r = await spawnClaudePrint({
    cli,
    args: ['--print', '--output-format', 'stream-json', 'go'],
    cwd: dir,
    env: process.env,
    onEvent: (ev) => events.push(ev),
  });
  assert.equal(r.sessionId, 'sess-fake');
  assert.match(r.text, /Created note.md/);
  assert.ok(events.some((e) => e.kind === 'assistant' && e.tools?.[0]?.name === 'Write'));
  assert.ok(events.some((e) => e.kind === 'assistant' && e.thinking === 'write it'));
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
  assert.match(miss.text, /claude CLI not found/);
  assert.match(CLAUDE_MISSING, /install\.sh/);
});
