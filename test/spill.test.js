import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  accumulateBoundChars,
  noteCorpusLedger,
  persistBoundChars,
  loadBoundChars,
  extractFilePaths,
  extractBashPaths,
  filesForCorpus,
  resolveReadablePath,
  corpusCharsForSend,
  createSpillStats,
} from '../lib/spill.js';
import { anthropicToOpenAI } from '../lib/anthropic.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-spill-'));
  return path.join(dir, 'bound-chars.json');
}

test('ledger accumulates on first bind and each append, without files', () => {
  const file = tmpFile();
  const map = new Map();
  const first = noteCorpusLedger(map, { contextId: 'ctx-a', corpusChars: 20_000, file });
  assert.equal(first, 20_000);
  const second = noteCorpusLedger(map, { contextId: 'ctx-a', corpusChars: 24_500, file });
  assert.equal(second, 24_500);
  const third = noteCorpusLedger(map, { contextId: 'ctx-a', corpusChars: 25_700, file });
  assert.equal(third, 25_700);
  assert.ok(map.get('ctx-a') > 6_000);
  assert.ok(fs.existsSync(file), 'conversation-only session writes bound-chars.json');
});

test('Math.max keeps a larger ledger when this-turn prefix shrinks', () => {
  const file = tmpFile();
  const map = new Map([['ctx-stale', 34_056]]);
  noteCorpusLedger(map, { contextId: 'ctx-stale', corpusChars: 100_000, file });
  assert.equal(map.get('ctx-stale'), 100_000);
  noteCorpusLedger(map, { contextId: 'ctx-stale', corpusChars: 20_000, file });
  assert.equal(map.get('ctx-stale'), 100_000);
});

test('send() uses Math.max so a stale 34056 cannot cap a bigger prefix', () => {
  const map = new Map([['ctx', 34_056]]);
  assert.equal(corpusCharsForSend(map, 'ctx', 100_000), 100_000);
  assert.equal(corpusCharsForSend(map, 'ctx', 20_000), 34_056);
  assert.equal(corpusCharsForSend(new Map(), 'missing', 45_000), 45_000);
});

test('file bytes add on top of the conversation ledger', () => {
  const file = tmpFile();
  const map = new Map();
  noteCorpusLedger(map, { contextId: 'ctx-b', corpusChars: 10_000, fileChars: 40_000, file });
  assert.equal(map.get('ctx-b'), 50_000);
  noteCorpusLedger(map, { contextId: 'ctx-b', corpusChars: 12_000, fileChars: 8_000, file });
  assert.equal(map.get('ctx-b'), 58_000);
});

test('persist/restore survives a sidecar-style restart', () => {
  const file = tmpFile();
  const sessions = new Map();
  const boundFiles = new Set();
  const live = new Map();
  noteCorpusLedger(live, {
    contextId: 'ctx-c',
    reused: false,
    corpusChars: 30_000,
    sessionKey: 'sid:abc',
    sessions,
    boundFiles,
    file,
  });
  accumulateBoundChars(live, 'ctx-c', 9_000, { sessionKey: 'sid:abc', sessions, boundFiles, file });
  boundFiles.add('/tmp/foo.js:1');
  persistBoundChars(live, { file, sessions, boundFiles });

  const restored = new Map();
  const sessions2 = new Map();
  const files2 = new Set();
  const result = loadBoundChars(restored, { file, sessions: sessions2, boundFiles: files2 });
  assert.equal(result.ok, true);
  assert.equal(restored.get('ctx-c'), 39_000);
  assert.equal(sessions2.get('sid:abc').contextId, 'ctx-c');
  assert.equal(sessions2.get('sid:abc').chars, 39_000);
  assert.ok(files2.has('/tmp/foo.js:1'));
});

test('missing ledger file is a cold start, not an error', () => {
  const restored = new Map();
  const result = loadBoundChars(restored, { file: path.join(os.tmpdir(), 'oz-no-such-bound-chars.json') });
  assert.equal(result.ok, false);
  assert.equal(restored.size, 0);
});

test('extractFilePaths reads Anthropic tool_use and OpenAI tool_calls', () => {
  const abs = '/workspace/lib/proxy.js';
  const rel = 'lib/spill.js';
  const msgs = [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'Read', input: { file_path: abs } }],
    },
    {
      role: 'assistant',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'Read', arguments: JSON.stringify({ file_path: rel }) },
      }],
    },
    {
      role: 'assistant',
      tool_calls: [{
        function: { name: 'read_file', arguments: JSON.stringify({ target_file: 'src/app.ts' }) },
      }],
    },
  ];
  assert.deepEqual(extractFilePaths(msgs), [abs, rel, 'src/app.ts']);
});

test('extractFilePaths accepts arguments as an object and Cursor/read_file names', () => {
  const msgs = [{
    role: 'assistant',
    tool_calls: [{ function: { name: 'read_file', arguments: { path: 'notes.md' } } }],
  }];
  assert.deepEqual(extractFilePaths(msgs), ['notes.md']);
});

test('extractFilePaths does not harvest import paths from tool_result bodies', () => {
  const msgs = [{
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 't1',
      content: "import fs from 'node:fs';\nimport { foo } from './secret.js';\n",
    }],
  }];
  assert.deepEqual(extractFilePaths(msgs), []);
});

test('filesForCorpus binds absolute AND relative Read paths from Anthropic tool_use', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-files-'));
  const absPath = path.join(dir, 'abs.txt');
  const relName = 'rel.txt';
  fs.writeFileSync(absPath, 'ABS_BODY_UNIQUE');
  fs.writeFileSync(path.join(dir, relName), 'REL_BODY_UNIQUE');
  const logs = [];
  const bound = new Set();
  const anthropic = [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: absPath } }],
    },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'u2', name: 'Read', input: { file_path: relName } }],
    },
  ];
  const got = filesForCorpus(anthropic, {
    boundFiles: bound,
    cwd: dir,
    log: (m) => logs.push(m),
  });
  assert.match(got.text, /ABS_BODY_UNIQUE/);
  assert.match(got.text, /REL_BODY_UNIQUE/);
  assert.equal(got.files, 2);
  assert.match(logs.join('\n'), /file-bind kept=2 bytes=\d+ skip enoent=0 cap=0 dir=0 rel=1 bash=0/);

  // Same files after the live Claude Code translation (tool_use → tool_calls).
  const translated = anthropicToOpenAI({ messages: anthropic }).messages;
  const logs2 = [];
  const got2 = filesForCorpus(translated, {
    boundFiles: new Set(),
    cwd: dir,
    log: (m) => logs2.push(m),
  });
  assert.match(got2.text, /ABS_BODY_UNIQUE/);
  assert.match(got2.text, /REL_BODY_UNIQUE/);
  assert.equal(got2.files, 2);
});

test('filesForCorpus logs an explicit zero reason and does not throw', () => {
  const logs = [];
  const got = filesForCorpus([{ role: 'user', content: 'hello' }], {
    boundFiles: new Set(),
    log: (m) => logs.push(m),
  });
  assert.equal(got.text, '');
  assert.equal(got.files, 0);
  assert.match(logs.join('\n'), /file-bind kept=0 bytes=0 skip enoent=0 cap=0 dir=0 rel=0 bash=0/);
});

test('filesForCorpus binds a Bash relative path and a directory\'s children', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-bash-'));
  const sub = path.join(dir, 'programs');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(dir, 'notes.md'), 'BASH_REL_BODY');
  fs.writeFileSync(path.join(sub, 'a.rs'), 'CHILD_A');
  fs.writeFileSync(path.join(sub, 'b.rs'), 'CHILD_B');
  const logs = [];
  const msgs = [
    { role: 'tool', content: `The current working directory is ${dir}` },
    {
      role: 'assistant',
      tool_calls: [{
        type: 'function',
        function: { name: 'Bash', arguments: JSON.stringify({ command: 'head -80 notes.md' }) },
      }],
    },
    {
      role: 'assistant',
      tool_calls: [{
        type: 'function',
        function: { name: 'Read', arguments: JSON.stringify({ file_path: sub }) },
      }],
    },
  ];
  const got = filesForCorpus(msgs, {
    boundFiles: new Set(),
    cwd: '/tmp',
    log: (m) => logs.push(m),
  });
  assert.match(got.text, /BASH_REL_BODY/);
  assert.match(got.text, /CHILD_A/);
  assert.match(got.text, /CHILD_B/);
  assert.equal(got.files, 3);
  assert.match(logs.join('\n'), /file-bind kept=3 bytes=\d+ skip enoent=\d+ cap=0 dir=1 rel=\d+ bash=1/);
});

test('extractBashPaths finds head/cat targets and honours cd', () => {
  const { paths, cwd } = extractBashPaths('cd /workspace && head -80 lib/spill.js', '/tmp');
  assert.equal(cwd, '/workspace');
  assert.ok(paths.some((p) => p.raw === 'lib/spill.js' && p.cwd === '/workspace'));
});

test('resolveReadablePath expands ~ and relative cwd', () => {
  const cwd = '/workspace';
  assert.equal(resolveReadablePath('lib/spill.js', cwd), path.join(cwd, 'lib/spill.js'));
  assert.equal(resolveReadablePath('/abs/x', cwd), '/abs/x');
  assert.equal(resolveReadablePath('https://example.com/x', cwd), null);
});

test('spill counters increment on spill and not on a pass-through', () => {
  const s = createSpillStats();
  // a paid call that did not spill — do not call noteSpill
  assert.equal(s.spillCalls, 0);
  assert.equal(s.snapshot().calls, 0);
  assert.equal(s.snapshot().fileBinds, 0);

  s.noteSpill({ corpusChars: 12_000 });
  assert.equal(s.spillCalls, 1);
  assert.equal(s.spilledChars, 12_000);
  assert.equal(s.spillReuses, 0);

  // another non-spill in between
  assert.equal(s.spillCalls, 1);

  s.noteSpill({ corpusChars: 3_000, reused: true });
  assert.equal(s.spillCalls, 2);
  assert.equal(s.spillReuses, 1);
  assert.equal(s.spilledChars, 15_000);

  s.noteFileBind(2, 8_000);
  assert.equal(s.fileBinds, 2);
  assert.equal(s.fileBindBytes, 8_000);
  assert.equal(s.spilledChars, 23_000);

  const snap = s.snapshot();
  assert.equal(snap.calls, 2);
  assert.equal(snap.fileBinds, 2);
  assert.equal(snap.tokensApprox, Math.round(23_000 / 4));
  assert.equal(snap.reusedBinds, 1);
});
