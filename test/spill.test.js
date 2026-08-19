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
  filesForCorpus,
  resolveReadablePath,
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
  const first = noteCorpusLedger(map, { contextId: 'ctx-a', reused: false, corpusChars: 20_000, file });
  assert.equal(first, 20_000);
  const second = noteCorpusLedger(map, { contextId: 'ctx-a', reused: true, deltaChars: 4_500, file });
  assert.equal(second, 24_500);
  const third = noteCorpusLedger(map, { contextId: 'ctx-a', reused: true, deltaChars: 1_200, file });
  assert.equal(third, 25_700);
  // The accumulated basis is larger than a live tail / this-turn body.
  assert.ok(map.get('ctx-a') > 6_000);
  assert.ok(fs.existsSync(file), 'conversation-only session writes bound-chars.json');
});

test('file bytes add on top of the conversation ledger', () => {
  const file = tmpFile();
  const map = new Map();
  noteCorpusLedger(map, { contextId: 'ctx-b', reused: false, corpusChars: 10_000, fileChars: 40_000, file });
  assert.equal(map.get('ctx-b'), 50_000);
  noteCorpusLedger(map, { contextId: 'ctx-b', reused: true, deltaChars: 2_000, fileChars: 8_000, file });
  assert.equal(map.get('ctx-b'), 60_000);
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
  assert.match(logs.join('\n'), /file-bind 2 files \/ \d+ bytes/);

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
  assert.match(logs.join('\n'), /file-bind 0 because no file paths/);
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
