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
  readFilesForCorpus,
  boundAbsFromKeys,
  stubBoundFileResults,
  looksLikeFileView,
  resolveReadablePath,
  corpusCharsForSend,
  createSpillStats,
  applySpillCut,
  resetAdaptState,
  rememberKnobs,
  loadKnobs,
  adaptTail,
  tightenKnobs,
  loosenKnobs,
  cutTranscript,
  sliceChars,
  currentToolRound,
  KEEP_TOOL_CHARS,
} from '../lib/spill.js';
import { anthropicToOpenAI } from '../lib/anthropic.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-spill-'));
  return path.join(dir, 'bound-chars.json');
}

/** Background path: collect then read. Request-path tests call filesForCorpus alone. */
function bindFilesForTest(msgs, opts) {
  return readFilesForCorpus(filesForCorpus(msgs, opts), opts);
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

test('filesForCorpus request path does not readFileSync or readdirSync', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-nread-'));
  const fat = path.join(dir, 'fat.txt');
  const sub = path.join(dir, 'tree');
  fs.writeFileSync(fat, 'X'.repeat(2_000_000));
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'child.txt'), 'CHILD_SHOULD_WAIT');
  const bound = new Set();
  let reads = 0;
  let dirReads = 0;
  const origRead = fs.readFileSync;
  const origDir = fs.readdirSync;
  fs.readFileSync = (...args) => { reads += 1; return origRead(...args); };
  fs.readdirSync = (...args) => { dirReads += 1; return origDir(...args); };
  let collected;
  try {
    collected = filesForCorpus([
      {
        role: 'assistant',
        tool_calls: [{
          function: { name: 'Read', arguments: JSON.stringify({ file_path: fat }) },
        }],
      },
      {
        role: 'assistant',
        tool_calls: [{
          function: { name: 'Read', arguments: JSON.stringify({ file_path: sub }) },
        }],
      },
    ], {
      boundFiles: bound,
      cwd: dir,
      cap: 3_000_000,
      readFileSync: () => { reads += 1; return 'LEAK'; },
      readdirSync: () => { dirReads += 1; return ['child.txt']; },
    });
  } finally {
    fs.readFileSync = origRead;
    fs.readdirSync = origDir;
  }
  assert.equal(reads, 0, 'request path must not read file bytes');
  assert.equal(dirReads, 0, 'request path must not expand directory children');
  assert.equal(collected.text, '');
  assert.equal(collected.bytes, 0);
  assert.ok(collected.pending.some((p) => p.abs === fat && p.kind === 'file'));
  assert.ok(collected.pending.some((p) => p.abs === sub && p.kind === 'dir'));

  const again = filesForCorpus([
    {
      role: 'assistant',
      tool_calls: [{
        function: { name: 'Read', arguments: JSON.stringify({ file_path: fat }) },
      }],
    },
  ], { boundFiles: bound, cwd: dir, cap: 3_000_000 });
  assert.equal(again.pending.length, 0, 'path+mtime dedupe reserves the file on collect');

  const got = readFilesForCorpus(collected, { boundFiles: bound, cap: 3_000_000 });
  assert.match(got.text, /X{100,}/);
  assert.match(got.text, /CHILD_SHOULD_WAIT/);
  assert.equal(got.files, 2);
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
  const got = bindFilesForTest(anthropic, {
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
  const got2 = bindFilesForTest(translated, {
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
  fs.mkdirSync(path.join(sub, 'node_modules'));
  fs.writeFileSync(path.join(sub, 'node_modules', 'skip.js'), 'SHOULD_NOT_BIND');
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
  const got = bindFilesForTest(msgs, {
    boundFiles: new Set(),
    cwd: '/tmp',
    log: (m) => logs.push(m),
  });
  assert.match(got.text, /BASH_REL_BODY/);
  assert.match(got.text, /CHILD_A/);
  assert.match(got.text, /CHILD_B/);
  assert.doesNotMatch(got.text, /SHOULD_NOT_BIND/);
  assert.equal(got.files, 3);
  assert.match(logs.join('\n'), /file-bind kept=3 bytes=\d+ skip enoent=\d+ cap=0 dir=1 rel=\d+ bash=1/);
});

test('filesForCorpus skips an over-cap file via stat, not read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-cap-'));
  const fat = path.join(dir, 'fat.txt');
  fs.writeFileSync(fat, 'Y'.repeat(500_000));
  let reads = 0;
  const got = filesForCorpus([{
    role: 'assistant',
    tool_calls: [{
      function: { name: 'Read', arguments: JSON.stringify({ file_path: fat }) },
    }],
  }], {
    boundFiles: new Set(),
    cap: 400_000,
    readFileSync: () => { reads += 1; return 'LEAK'; },
  });
  assert.equal(reads, 0);
  assert.equal(got.pending.length, 0);
  assert.equal(got.cap, 1);
  assert.equal(got.text, '');
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

test('looksLikeFileView accepts head/cat and rejects mixed commands', () => {
  assert.equal(looksLikeFileView('head -80 notes.md'), true);
  assert.equal(looksLikeFileView('cd /workspace && cat lib/spill.js'), true);
  assert.equal(looksLikeFileView('npm test'), false);
  assert.equal(looksLikeFileView('cat notes.md | rg foo'), false);
  assert.equal(looksLikeFileView('cat notes.md && npm test'), false);
});

test('boundAbsFromKeys strips the mtime suffix', () => {
  const abs = boundAbsFromKeys(new Set(['/tmp/foo.js:1734.25', 'C:\\x:9']));
  assert.ok(abs.has('/tmp/foo.js'));
  assert.ok(abs.has('C:\\x'));
});

test('stubBoundFileResults drops a bound Read body so the tail is much smaller than the corpus', () => {
  const abs = '/tmp/huge.rs';
  const body = 'Z'.repeat(5_000_000);
  const boundFiles = new Set([`${abs}:1`]);
  const msgs = [
    {
      role: 'assistant',
      tool_calls: [{
        id: 'c1',
        type: 'function',
        function: { name: 'Read', arguments: JSON.stringify({ file_path: abs }) },
      }],
    },
    { role: 'tool', tool_call_id: 'c1', content: body },
    { role: 'user', content: 'what does huge.rs export?' },
  ];
  let reads = 0;
  const origRead = fs.readFileSync;
  fs.readFileSync = (...args) => { reads += 1; return origRead(...args); };
  let got;
  try {
    got = stubBoundFileResults(msgs, { boundFiles });
  } finally {
    fs.readFileSync = origRead;
  }
  assert.equal(reads, 0, 'stub is a string rewrite, not another disk read');
  assert.equal(got.stubbed, 1);
  assert.ok(got.dropped >= 5_000_000);
  assert.match(got.messages[1].content, /\/tmp\/huge\.rs/);
  assert.match(got.messages[1].content, /\[bound, \d+ chars\]/);
  assert.doesNotMatch(got.messages[1].content, /Z{20}/);
  assert.equal(got.messages[2].content, 'what does huge.rs export?');
  const sent = got.messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
  assert.ok(sent < 2_000, `forwarded tail should be tiny, got ${sent}`);
  assert.ok(sent * 100 < body.length);
});

test('stubBoundFileResults leaves a first-read tool_result and non-file bash verbatim', () => {
  const abs = '/tmp/new.rs';
  const msgs = [
    {
      role: 'assistant',
      tool_calls: [{
        id: 'c1',
        function: { name: 'Read', arguments: JSON.stringify({ file_path: abs }) },
      }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'NEW_BODY_UNIQUE' },
    {
      role: 'assistant',
      tool_calls: [{
        id: 'c2',
        function: { name: 'Bash', arguments: JSON.stringify({ command: 'npm test' }) },
      }],
    },
    { role: 'tool', tool_call_id: 'c2', content: 'FAIL lots of test output '.repeat(50) },
  ];
  const got = stubBoundFileResults(msgs, { boundFiles: new Set() });
  assert.equal(got.stubbed, 0);
  assert.equal(got.messages[1].content, 'NEW_BODY_UNIQUE');
  assert.match(got.messages[3].content, /FAIL lots of test output/);

  const still = stubBoundFileResults(msgs, { boundFiles: new Set(['/tmp/other.js:1']) });
  assert.equal(still.messages[1].content, 'NEW_BODY_UNIQUE');
  assert.match(still.messages[3].content, /FAIL lots of test output/);
});

test('stubBoundFileResults stubs Bash head/cat of a bound relative path', () => {
  const dir = '/workspace';
  const rel = 'notes.md';
  const abs = path.join(dir, rel);
  const msgs = [
    { role: 'tool', content: `The current working directory is ${dir}` },
    {
      role: 'assistant',
      tool_calls: [{
        id: 'b1',
        function: { name: 'Bash', arguments: JSON.stringify({ command: 'head -80 notes.md' }) },
      }],
    },
    { role: 'tool', tool_call_id: 'b1', content: '# Notes\n' + 'line\n'.repeat(1200) },
    { role: 'user', content: 'what is in the notes?' },
  ];
  const got = stubBoundFileResults(msgs, { boundFiles: new Set([`${abs}:9`]) });
  assert.equal(got.stubbed, 1);
  assert.match(got.messages[2].content, /notes\.md|\/workspace\/notes\.md/);
  assert.doesNotMatch(got.messages[2].content, /line\nline/);
});

test('stubBoundFileResults works on the live Claude Code translation', () => {
  const abs = '/tmp/a.rs';
  const anthropic = {
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: abs } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'BODY'.repeat(2_000) }] },
      { role: 'user', content: 'summarize' },
    ],
  };
  const translated = anthropicToOpenAI(anthropic).messages;
  const got = stubBoundFileResults(translated, { boundFiles: new Set([`${abs}:1`]) });
  assert.equal(got.stubbed, 1);
  const tool = got.messages.find((m) => m.role === 'tool');
  assert.match(tool.content, /\[bound, \d+ chars\]/);
  assert.doesNotMatch(tool.content, /BODYBODY/);
  assert.equal(got.messages.at(-1).content, 'summarize');
});

test('stubBoundFileResults fromIndex leaves the spilled prefix intact', () => {
  const abs = '/tmp/kept.rs';
  const msgs = [
    {
      role: 'assistant',
      tool_calls: [{
        id: 'old',
        function: { name: 'Read', arguments: JSON.stringify({ file_path: abs }) },
      }],
    },
    { role: 'tool', tool_call_id: 'old', content: 'PREFIX_BODY' },
    {
      role: 'assistant',
      tool_calls: [{
        id: 'new',
        function: { name: 'Read', arguments: JSON.stringify({ file_path: abs }) },
      }],
    },
    { role: 'tool', tool_call_id: 'new', content: 'TAIL_BODY' + 'Z'.repeat(KEEP_TOOL_CHARS) },
    { role: 'user', content: 'summarize the tail' },
  ];
  const got = stubBoundFileResults(msgs, { boundFiles: new Set([`${abs}:1`]), fromIndex: 2 });
  assert.equal(got.messages[1].content, 'PREFIX_BODY');
  assert.match(got.messages[3].content, /\[bound, \d+ chars\]/);
  assert.doesNotMatch(got.messages[3].content, /TAIL_BODY/);
});

/** Live Claude Code shape: 250k already bound + 13 × ~20k Read tool_results + ask. */
function agentShapedFixture({
  reads = 13,
  readChars = 20_000,
  ask = 'LAST_USER_ASK please continue from here',
  bound = true,
} = {}) {
  const abs = '/tmp/openzoo-live-corpus.rs';
  const msgs = [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'work through the repo' },
    { role: 'assistant', content: 'I will read the files.' },
  ];
  for (let i = 0; i < reads; i++) {
    msgs.push({
      role: 'assistant',
      tool_calls: [{
        id: `r${i}`,
        type: 'function',
        function: { name: 'Read', arguments: JSON.stringify({ file_path: abs }) },
      }],
    });
    msgs.push({ role: 'tool', tool_call_id: `r${i}`, content: 'R'.repeat(readChars) });
  }
  msgs.push({ role: 'user', content: ask });
  return {
    msgs,
    abs,
    ask,
    boundFiles: bound ? new Set([`${abs}:1`]) : new Set(),
  };
}

function forwardedHasAsk(got, ask) {
  const msgs = got.stubbed?.messages || [];
  const tail = got.cut > got.firstSpillable ? msgs.slice(got.cut) : msgs;
  return tail.some((m) => typeof m.content === 'string' && m.content.includes(ask));
}

const START_KNOBS = { keepTail: 8, minTurns: 6, budget: 6000, stubMore: false };

test('adapt reaches >=10x on the agent-shaped fixture without deleting the ask', () => {
  resetAdaptState();
  // Unbound Reads — 0.48.72 stub does not fire; the tuner must shrink / stub more.
  const { msgs, ask, boundFiles } = agentShapedFixture({ bound: false });
  const logs = [];
  const got = applySpillCut(msgs, {
    knobs: START_KNOBS,
    corpusChars: 250_000,
    boundFiles,
    adapt: true,
    persist: false,
    log: (m) => logs.push(m),
  });
  assert.ok(got.ratio >= 10, `corpus/sent ${got.ratio} should be >= 10`);
  assert.ok(forwardedHasAsk(got, ask), 'last user ask must stay in the forwarded tail');
  assert.match(logs.join('\n'), /adapt /);
  assert.doesNotMatch(logs.join('\n'), /restart the proxy|kill|74122/i);
});

test('adapt on the bound live fixture (stub + 13 Reads) stays >=10x with the ask', () => {
  resetAdaptState();
  const { msgs, ask, boundFiles } = agentShapedFixture({ bound: true });
  const got = applySpillCut(msgs, {
    knobs: START_KNOBS,
    corpusChars: 250_000,
    boundFiles,
    adapt: true,
    persist: false,
  });
  assert.ok(got.ratio >= 10, `corpus/sent ${got.ratio} should be >= 10`);
  assert.ok(forwardedHasAsk(got, ask), 'last user ask must stay in the forwarded tail');
});

test('one-line ask against a 250k pile stays well above 10', () => {
  resetAdaptState();
  const ask = 'what does the pile export?';
  const msgs = [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'here is the bound pile' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: ask },
  ];
  const got = applySpillCut(msgs, {
    knobs: START_KNOBS,
    corpusChars: 250_000,
    adapt: true,
    persist: false,
  });
  assert.ok(got.ratio >= 10, `corpus/sent ${got.ratio} should be >= 10`);
  assert.ok(got.ratio >= 20, `one-liner should be well above 10, got ${got.ratio}`);
  assert.ok(forwardedHasAsk(got, ask), 'one-line ask must stay forwarded');
});

test('two back-to-back adapt calls do not flip-flop knobs', () => {
  resetAdaptState();
  const { msgs, ask, boundFiles } = agentShapedFixture({ bound: false });
  const a = applySpillCut(msgs, {
    knobs: START_KNOBS,
    corpusChars: 250_000,
    boundFiles,
    adapt: true,
    persist: false,
  });
  assert.ok(a.ratio >= 10, `first adapt ratio ${a.ratio}`);
  const knobsA = { ...a.knobs };
  const b = applySpillCut(msgs, {
    knobs: a.knobs,
    corpusChars: 250_000,
    boundFiles,
    adapt: true,
    persist: false,
  });
  assert.ok(b.ratio >= 10, `second adapt ratio ${b.ratio}`);
  assert.equal(b.knobs.keepTail, knobsA.keepTail);
  assert.equal(b.knobs.minTurns, knobsA.minTurns);
  assert.equal(b.knobs.budget, knobsA.budget);
  assert.equal(Boolean(b.knobs.stubMore), Boolean(knobsA.stubMore));
  assert.ok(forwardedHasAsk(b, ask));
});

test('OPENZOO_ADAPT=0 freezes env knobs', () => {
  resetAdaptState();
  const prev = process.env.OPENZOO_ADAPT;
  process.env.OPENZOO_ADAPT = '0';
  try {
    const { msgs, boundFiles } = agentShapedFixture({ bound: false });
    const logs = [];
    const got = applySpillCut(msgs, {
      knobs: START_KNOBS,
      corpusChars: 250_000,
      boundFiles,
      persist: false,
      log: (m) => logs.push(m),
    });
    assert.equal(got.action, 'hold');
    assert.equal(got.knobs.keepTail, 8);
    assert.equal(got.knobs.minTurns, 6);
    assert.equal(got.knobs.budget, 6000);
    assert.equal(got.knobs.stubMore, false);
    assert.equal(logs.join('\n').includes('adapt '), false);
  } finally {
    if (prev === undefined) delete process.env.OPENZOO_ADAPT;
    else process.env.OPENZOO_ADAPT = prev;
    resetAdaptState();
  }
});

test('adapted knobs persist to knobs.json and resume', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oz-knobs-')), 'knobs.json');
  resetAdaptState();
  rememberKnobs({ keepTail: 4, minTurns: 2, budget: 2500, stubMore: true }, { file });
  assert.ok(fs.existsSync(file));
  const loaded = loadKnobs({ file });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.knobs.keepTail, 4);
  assert.equal(loaded.knobs.minTurns, 2);
  assert.equal(loaded.knobs.budget, 2500);
  assert.equal(loaded.knobs.stubMore, true);
});

test('adaptTail hysteresis: tighten then a 25x overshoot holds, does not loosen', () => {
  resetAdaptState();
  const start = { ...START_KNOBS };
  const down = adaptTail({ ratio: 4, knobs: start, lastAction: 'hold', corpusChars: 250_000 });
  assert.equal(down.action, 'tighten');
  assert.ok(down.recut);
  const hold = adaptTail({ ratio: 25, knobs: down.knobs, lastAction: 'tighten', corpusChars: 250_000 });
  assert.equal(hold.action, 'hold');
  assert.equal(hold.knobs.keepTail, down.knobs.keepTail);
  assert.equal(hold.knobs.budget, down.knobs.budget);
  const loose = adaptTail({ ratio: 25, knobs: start, lastAction: 'hold', corpusChars: 250_000 });
  assert.equal(loose.action, 'loosen');
  assert.equal(loose.recut, false);
  assert.ok(loose.knobs.keepTail > start.keepTail || loose.knobs.budget > start.budget);
});

test('tightenKnobs / loosenKnobs stay on the notch ladder', () => {
  const mid = tightenKnobs({ keepTail: 8, minTurns: 6, budget: 6000 }, { ratio: 8, corpusChars: 250_000 });
  assert.ok(mid.keepTail <= 8);
  assert.ok(mid.minTurns <= 6);
  assert.ok(mid.budget <= 6000);
  assert.equal(mid.stubMore, true);
  const up = loosenKnobs(mid);
  assert.ok(up.keepTail >= mid.keepTail);
  assert.ok(up.budget >= mid.budget);
  assert.equal(up.stubMore, false);
});

/**
 * Live ultracode failure: ONE assistant turn with ~13 fat tool_results
 * (Read AND WebSearch/Fetch) + last user ask. Nothing in that tail is
 * severable, so the 800-byte walk used to be a no-op and lastSend stayed
 * ~16 full bodies.
 */
function toolStormFixture({
  tools = 13,
  bodyChars = 20_000,
  ask = 'LAST_USER_ASK please continue from here',
} = {}) {
  const abs = '/tmp/openzoo-live-corpus.rs';
  const calls = [];
  const results = [];
  for (let i = 0; i < tools; i++) {
    const id = `t${i}`;
    if (i % 3 === 0) {
      calls.push({
        id,
        type: 'function',
        function: { name: 'Read', arguments: JSON.stringify({ file_path: abs }) },
      });
      results.push({ role: 'tool', tool_call_id: id, content: 'R'.repeat(bodyChars) });
    } else if (i % 3 === 1) {
      calls.push({
        id,
        type: 'function',
        function: { name: 'WebSearch', arguments: JSON.stringify({ query: `topic ${i}` }) },
      });
      results.push({ role: 'tool', tool_call_id: id, content: 'W'.repeat(bodyChars) });
    } else {
      calls.push({
        id,
        type: 'function',
        function: { name: 'WebFetch', arguments: JSON.stringify({ url: `https://example.com/${i}` }) },
      });
      results.push({ role: 'tool', tool_call_id: id, content: 'F'.repeat(bodyChars) });
    }
  }
  const msgs = [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'work through the repo' },
    { role: 'assistant', content: 'I will look around.' },
    { role: 'assistant', content: '', tool_calls: calls },
    ...results,
    { role: 'user', content: ask },
  ];
  return { msgs, ask, abs, boundFiles: new Set([`${abs}:1`]) };
}

function tailOf(got) {
  const msgs = got.stubbed?.messages || [];
  return got.cut > got.firstSpillable ? msgs.slice(got.cut) : msgs;
}

function pairingValid(msgs) {
  const ids = new Set();
  for (const m of msgs) {
    for (const tc of m.tool_calls || []) {
      if (tc?.id) ids.add(tc.id);
    }
    if (m.function_call?.id) ids.add(m.function_call.id);
  }
  for (const m of msgs) {
    if (m.role === 'tool' && m.tool_call_id && !ids.has(m.tool_call_id)) return false;
  }
  return true;
}

function fullToolBodies(msgs) {
  return msgs.filter((m) => {
    if (m.role !== 'tool' || typeof m.content !== 'string') return false;
    if (/\[bound/.test(m.content)) return false;
    return m.content.length > 1000;
  });
}

const FLOOR_KNOBS = { keepTail: 2, minTurns: 2, budget: 800, stubMore: true };

test('tool-result storm: cut+stub+adapt keeps corpus/sent >= 10 and the ask', () => {
  resetAdaptState();
  const { msgs, ask, boundFiles } = toolStormFixture();
  const logs = [];
  const got = applySpillCut(msgs, {
    knobs: START_KNOBS,
    corpusChars: 250_000,
    boundFiles,
    adapt: true,
    persist: false,
    log: (m) => logs.push(m),
  });
  assert.ok(got.ratio >= 10, `corpus/sent ${got.ratio} should be >= 10`);
  assert.ok(forwardedHasAsk(got, ask), 'last user ask must stay in the forwarded tail');
  assert.equal(fullToolBodies(tailOf(got)).length, 0, 'no full 20k bodies in the tail');
  assert.ok(pairingValid(tailOf(got)), 'no orphan tool result without its tool_call');
  assert.match(logs.join('\n'), /adapt /);
});

test('floor knobs do not forward 15 full tool bodies inside a tool chain', () => {
  resetAdaptState();
  const { msgs, ask, boundFiles } = toolStormFixture({ tools: 15 });
  const got = applySpillCut(msgs, {
    knobs: FLOOR_KNOBS,
    corpusChars: 250_000,
    boundFiles,
    adapt: true,
    persist: false,
  });
  const tail = tailOf(got);
  assert.equal(fullToolBodies(tail).length, 0, 'budget 800 must stub the storm, not ship 15×20k');
  assert.ok(got.sentChars < 15 * 20_000 * 0.1, `sent ${got.sentChars} still looks like full bodies`);
  assert.ok(got.ratio >= 10, `corpus/sent ${got.ratio} should be >= 10`);
  assert.ok(forwardedHasAsk(got, ask), 'last user ask must survive');
  assert.ok(pairingValid(tail), 'pairing must stay valid');
  const asst = tail.find((m) => Array.isArray(m.tool_calls) && m.tool_calls.length);
  const tools = tail.filter((m) => m.role === 'tool');
  assert.ok(asst, 'assistant tool_calls must stay so remaining tool results are not orphans');
  assert.equal(asst.tool_calls.length, tools.length, 'kept tool_calls must match kept results');
  assert.ok(tools.length >= 1 && tools.length <= FLOOR_KNOBS.keepTail,
    `keepTail ${FLOOR_KNOBS.keepTail} should trim the 15-result storm, got ${tools.length}`);
});

test('stubMore stubs fat WebSearch/Bash, not just bound files', () => {
  const msgs = [
    {
      role: 'assistant',
      tool_calls: [
        { id: 'w1', function: { name: 'WebSearch', arguments: '{"query":"x"}' } },
        { id: 'b1', function: { name: 'Bash', arguments: '{"command":"npm test"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'w1', content: 'W'.repeat(8000) },
    { role: 'tool', tool_call_id: 'b1', content: 'B'.repeat(8000) },
    { role: 'user', content: 'ok continue' },
  ];
  const got = stubBoundFileResults(msgs, { boundFiles: new Set(), aggressive: true });
  assert.ok(got.stubbed >= 2);
  assert.match(got.messages[1].content, /\[bound, 8000 chars\]/);
  assert.match(got.messages[2].content, /\[bound, 8000 chars\]/);
  assert.doesNotMatch(got.messages[1].content, /W{20}/);
  assert.equal(got.messages[3].content, 'ok continue');
});

test('budget 800 stubs old tool_result bodies when nothing is severable', () => {
  const { msgs, ask } = toolStormFixture({ tools: 13 });
  const assistantAt = msgs.findIndex((m) => Array.isArray(m.tool_calls) && m.tool_calls.length >= 13);
  const got = stubBoundFileResults(msgs, { boundFiles: new Set(), budget: 800, fromIndex: assistantAt });
  const tail = got.messages.slice(assistantAt);
  assert.equal(fullToolBodies(tail).length, 0);
  assert.ok(got.stubbed >= 1);
  assert.equal(tail.at(-1).content, ask);
  assert.ok(pairingValid(tail));
  assert.ok(Array.isArray(tail[0].tool_calls) && tail[0].tool_calls.length >= 1);
});

/**
 * Live 0.48.75 shape: one assistant with hundreds of tool_calls, then that
 * many tool results, then the ask. No isSeverable break in the last hundreds
 * of messages — keepTail 16/8/6/2 all cut at the same index. File stubs
 * dropped ~722k (136 Reads) and left ~728k of WebSearch/Fetch/Bash/tool JSON.
 */
function liveUnseverableStorm({
  fileReads = 136,
  otherTools = 164,
  fileChars = 5300,
  otherChars = 4450,
  argChars = 120,
  ask = 'LAST_USER_ASK please continue from here',
} = {}) {
  const abs = '/tmp/openzoo-live-corpus.rs';
  const calls = [];
  const results = [];
  const fileBody = 'R'.repeat(fileChars);
  const extras = [
    { name: 'WebSearch', key: 'query', prefix: 'topic ', body: JSON.stringify({ hits: 'S'.repeat(otherChars) }) },
    { name: 'WebFetch', key: 'url', prefix: 'https://example.com/', body: 'H'.repeat(otherChars) },
    { name: 'Bash', key: 'command', prefix: 'echo ', body: 'O'.repeat(otherChars) },
  ];
  for (let i = 0; i < fileReads + otherTools; i++) {
    const id = `s${i}`;
    if (i < fileReads) {
      calls.push({
        id,
        type: 'function',
        function: { name: 'Read', arguments: JSON.stringify({ file_path: abs, extra: 'A'.repeat(argChars) }) },
      });
      results.push({ role: 'tool', tool_call_id: id, content: fileBody });
    } else {
      const spec = extras[(i - fileReads) % extras.length];
      calls.push({
        id,
        type: 'function',
        function: {
          name: spec.name,
          arguments: JSON.stringify({ [spec.key]: `${spec.prefix}${i}`, extra: 'J'.repeat(argChars) }),
        },
      });
      results.push({ role: 'tool', tool_call_id: id, content: spec.body });
    }
  }
  const prefix = [];
  for (let i = 0; i < 20; i++) {
    prefix.push(i % 2 === 0
      ? { role: 'user', content: `prefix turn ${i}` }
      : { role: 'assistant', content: `prefix reply ${i}` });
  }
  const msgs = [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'work through the repo' },
    { role: 'assistant', content: 'I will look around.' },
    ...prefix,
    { role: 'assistant', content: '', tool_calls: calls },
    ...results,
    { role: 'user', content: ask },
  ];
  return { msgs, ask, abs, boundFiles: new Set([`${abs}:1`]), tools: fileReads + otherTools };
}

test('un-severable 300-tool storm: keepTail 16 vs 2 differ; floor knobs do not ship ~728k', () => {
  resetAdaptState();
  const { msgs, ask, boundFiles, tools } = liveUnseverableStorm();
  const cut16 = cutTranscript(msgs, { keepTail: 16, minTurns: 2, budget: 24000, stubMore: false });
  const cut2 = cutTranscript(msgs, { keepTail: 2, minTurns: 2, budget: 800, stubMore: true });
  assert.equal(cut16.cut, cut2.cut, 'cut index may stay put — keepTail votes in stub/trim');

  const loose = applySpillCut(msgs, {
    knobs: { keepTail: 16, minTurns: 2, budget: 24000, stubMore: false },
    corpusChars: 1_580_000,
    boundFiles,
    adapt: false,
    persist: false,
  });
  const floor = applySpillCut(msgs, {
    knobs: FLOOR_KNOBS,
    corpusChars: 1_580_000,
    boundFiles,
    adapt: false,
    persist: false,
  });
  assert.ok(floor.sentChars < loose.sentChars,
    `keep 2 sent ${floor.sentChars} should be < keep 16 sent ${loose.sentChars}`);
  assert.ok(floor.sentChars < 100_000, `keep 2 + budget 800 must not ship ~728k, got ${floor.sentChars}`);
  assert.ok(floor.ratio >= 10, `corpus/sent ${floor.ratio} should be >= 10`);
  assert.ok(forwardedHasAsk(floor, ask), 'last user ask must survive');
  assert.ok(forwardedHasAsk(loose, ask), 'last user ask must survive at keep 16');
  const floorTail = tailOf(floor);
  const looseTail = tailOf(loose);
  assert.ok(pairingValid(floorTail), 'floor pairing must stay valid');
  assert.ok(pairingValid(looseTail), 'keep-16 pairing must stay valid');
  assert.equal(fullToolBodies(floorTail).length, 0);
  const floorTools = floorTail.filter((m) => m.role === 'tool').length;
  const looseTools = looseTail.filter((m) => m.role === 'tool').length;
  assert.ok(floorTools < looseTools, `keep 2 tools ${floorTools} should be < keep 16 tools ${looseTools}`);
  assert.ok(floorTools <= 2 && floorTools >= 1);
  assert.ok(looseTools <= 16);
  assert.ok(looseTools < tools, 'keep 16 must drop older pairs of the 300-tool chain');
});

test('budget stubs fat tool_call JSON, not just result bodies', () => {
  const fat = 'Z'.repeat(8000);
  const msgs = [
    {
      role: 'assistant',
      tool_calls: [{
        id: 'w1',
        function: { name: 'Write', arguments: JSON.stringify({ file_path: '/tmp/x.rs', contents: fat }) },
      }],
    },
    { role: 'tool', tool_call_id: 'w1', content: '[bound, 12 chars]' },
    { role: 'user', content: 'ok continue' },
  ];
  const got = stubBoundFileResults(msgs, { boundFiles: new Set(), budget: 800 });
  const args = got.messages[0].tool_calls[0].function.arguments;
  assert.doesNotMatch(args, /Z{20}/);
  assert.match(args, /\/tmp\/x\.rs/);
  assert.match(args, /\[bound/);
  assert.equal(got.messages[2].content, 'ok continue');
  assert.ok(pairingValid(got.messages));
});

test('300-tool-result un-severable tail under floor knobs is not still ~728k', () => {
  resetAdaptState();
  const { msgs, ask, boundFiles } = liveUnseverableStorm();
  const rawTail = (() => {
    const plan = cutTranscript(msgs, FLOOR_KNOBS);
    return sliceChars(msgs, plan.cut);
  })();
  assert.ok(rawTail > 700_000, `fixture tail should start huge, got ${rawTail}`);
  const got = applySpillCut(msgs, {
    knobs: FLOOR_KNOBS,
    corpusChars: 1_580_000,
    boundFiles,
    adapt: false,
    persist: false,
  });
  assert.ok(got.sentChars < 50_000, `floor knobs forwarded ${got.sentChars}, still in the 728k neighbourhood`);
  assert.ok(got.ratio >= 10, `corpus/sent ${got.ratio} should be >= 10`);
  assert.ok(forwardedHasAsk(got, ask));
  assert.ok(pairingValid(tailOf(got)));
});

/** Live 0.48.76 bug: current 461-byte Read stubbed because it was already bound. */
function currentRound461Fixture() {
  const fatAbs = '/tmp/openzoo-live-corpus.rs';
  const smallAbs = '/tmp/small.rs';
  const ask = 'LAST_USER_ASK please continue from here';
  const smallBody = 'fn small_export() { /* 461_BYTE_MARKER */ }\n'.padEnd(461, 'x');
  assert.equal(smallBody.length, 461);
  assert.ok(smallBody.length < KEEP_TOOL_CHARS);
  const fatBody = 'R'.repeat(20_000);
  const msgs = [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'work through the repo' },
    { role: 'assistant', content: 'I will read the files.' },
    {
      role: 'assistant',
      tool_calls: [{
        id: 'old1',
        type: 'function',
        function: { name: 'Read', arguments: JSON.stringify({ file_path: fatAbs }) },
      }],
    },
    { role: 'tool', tool_call_id: 'old1', content: fatBody },
    {
      role: 'assistant',
      tool_calls: [{
        id: 'old2',
        type: 'function',
        function: { name: 'Read', arguments: JSON.stringify({ file_path: fatAbs }) },
      }],
    },
    { role: 'tool', tool_call_id: 'old2', content: fatBody },
    {
      role: 'assistant',
      tool_calls: [{
        id: 'cur',
        type: 'function',
        function: { name: 'Read', arguments: JSON.stringify({ file_path: smallAbs }) },
      }],
    },
    { role: 'tool', tool_call_id: 'cur', content: smallBody },
    { role: 'user', content: ask },
  ];
  return {
    msgs,
    ask,
    smallBody,
    fatAbs,
    boundFiles: new Set([`${fatAbs}:1`, `${smallAbs}:1`]),
  };
}

test('cut+stub keeps a 461-byte current Read visible; older fat bound Reads may stub', () => {
  resetAdaptState();
  const { msgs, ask, smallBody, boundFiles } = currentRound461Fixture();
  const stubbed = stubBoundFileResults(msgs, { boundFiles, budget: 800 });
  assert.equal(stubbed.messages.find((m) => m.tool_call_id === 'cur')?.content, smallBody);
  assert.match(stubbed.messages.find((m) => m.tool_call_id === 'old1')?.content, /\[bound/);
  assert.match(stubbed.messages.find((m) => m.tool_call_id === 'old2')?.content, /\[bound/);
  assert.doesNotMatch(smallBody, /\[bound/);
  assert.ok(pairingValid(stubbed.messages));

  const got = applySpillCut(msgs, {
    knobs: FLOOR_KNOBS,
    corpusChars: 250_000,
    boundFiles,
    adapt: false,
    persist: false,
  });
  const tail = tailOf(got);
  assert.ok(forwardedHasAsk(got, ask), 'last user ask must stay');
  assert.ok(pairingValid(tail), 'pairing must stay valid');
  const current = tail.find((m) => m.role === 'tool' && m.tool_call_id === 'cur');
  assert.ok(current, 'current Read tool_result must stay in the forwarded tail');
  assert.equal(current.content, smallBody);
  assert.doesNotMatch(current.content, /\[bound/);
  const tools = tail.filter((m) => m.role === 'tool');
  const older = tools.filter((m) => m.tool_call_id !== 'cur');
  assert.ok(older.length === 0 || older.every((m) => /\[bound/.test(m.content)),
    'older fat Reads in the tail may be stubbed');
});

test('in-flight WebSearch/Bash survive even if large; older ones may stub', () => {
  const older = 'W'.repeat(8000);
  const search = `CURRENT_SEARCH_EYES ${'S'.repeat(8000)}`;
  const bash = `CURRENT_BASH_EYES ${'B'.repeat(8000)}`;
  const msgs = [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'look around' },
    { role: 'assistant', content: 'searching' },
    {
      role: 'assistant',
      tool_calls: [{ id: 'oldw', function: { name: 'WebSearch', arguments: '{"query":"old"}' } }],
    },
    { role: 'tool', tool_call_id: 'oldw', content: older },
    { role: 'user', content: 'search again and run the tests' },
    {
      role: 'assistant',
      tool_calls: [
        { id: 'w1', function: { name: 'WebSearch', arguments: '{"query":"now"}' } },
        { id: 'b1', function: { name: 'Bash', arguments: '{"command":"npm test"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'w1', content: search },
    { role: 'tool', tool_call_id: 'b1', content: bash },
  ];
  const got = stubBoundFileResults(msgs, {
    boundFiles: new Set(),
    aggressive: true,
    budget: 800,
    fromIndex: 0,
  });
  assert.ok(pairingValid(got.messages));
  assert.equal(got.messages[4].content.includes('CURRENT_SEARCH_EYES'), false);
  assert.match(got.messages[4].content, /\[bound/);
  assert.equal(got.messages[7].content, search);
  assert.equal(got.messages[8].content, bash);
  assert.doesNotMatch(got.messages[7].content, /\[bound/);
  assert.doesNotMatch(got.messages[8].content, /\[bound/);
});

/**
 * Live 0.48.77 continue / ultracode shape: last user ask is early, then
 * several tool rounds. 77 treated the whole post-ask pile as "current".
 * 0.48.78 protects only the latest assistant batch.
 */
function continueTurnAfterAskFixture({
  latest = 'read461',
  olderRounds = 1,
  ask = 'LAST_USER_ASK please continue from here',
} = {}) {
  const fatAbs = '/tmp/openzoo-live-corpus.rs';
  const smallAbs = '/tmp/small.rs';
  const smallBody = 'fn small_export() { /* 461_BYTE_MARKER */ }\n'.padEnd(461, 'x');
  assert.equal(smallBody.length, 461);
  const fatBody = 'R'.repeat(20_000);
  const searchBody = `CURRENT_SEARCH_EYES ${'S'.repeat(8000)}`;
  const msgs = [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'work through the repo' },
    { role: 'assistant', content: 'I will read the files.' },
  ];
  for (let i = 0; i < 20; i++) {
    msgs.push(i % 2 === 0
      ? { role: 'user', content: `prefix turn ${i}` }
      : { role: 'assistant', content: `prefix reply ${i}` });
  }
  msgs.push({ role: 'user', content: ask });
  for (let i = 0; i < olderRounds; i++) {
    msgs.push({
      role: 'assistant',
      tool_calls: [{
        id: `A${i}`,
        type: 'function',
        function: { name: 'Read', arguments: JSON.stringify({ file_path: fatAbs }) },
      }],
    });
    msgs.push({ role: 'tool', tool_call_id: `A${i}`, content: fatBody });
  }
  if (latest === 'websearch') {
    msgs.push({
      role: 'assistant',
      tool_calls: [{
        id: 'B',
        type: 'function',
        function: { name: 'WebSearch', arguments: JSON.stringify({ query: 'now' }) },
      }],
    });
    msgs.push({ role: 'tool', tool_call_id: 'B', content: searchBody });
  } else {
    msgs.push({
      role: 'assistant',
      tool_calls: [{
        id: 'B',
        type: 'function',
        function: { name: 'Read', arguments: JSON.stringify({ file_path: smallAbs }) },
      }],
    });
    msgs.push({ role: 'tool', tool_call_id: 'B', content: smallBody });
  }
  return {
    msgs,
    ask,
    smallBody,
    searchBody,
    fatAbs,
    boundFiles: new Set([`${fatAbs}:1`, `${smallAbs}:1`]),
  };
}

test('continue turn: latest 461-byte Read stays; older fat Read after the ask is stubbed', () => {
  resetAdaptState();
  const { msgs, ask, smallBody, boundFiles } = continueTurnAfterAskFixture();
  const lastUser = msgs.findIndex((m) => m.content === ask);
  const round = currentToolRound(msgs, { lastUser });
  assert.equal(round.inFlight, true);
  assert.deepEqual([...round.ids], ['B']);
  assert.equal(round.ids.has('A0'), false);

  const stubbed = stubBoundFileResults(msgs, { boundFiles, budget: 6000, keepTail: 8 });
  assert.equal(stubbed.messages.find((m) => m.tool_call_id === 'B')?.content, smallBody);
  assert.match(stubbed.messages.find((m) => m.tool_call_id === 'A0')?.content, /\[bound/);
  assert.doesNotMatch(smallBody, /\[bound/);
  assert.ok(pairingValid(stubbed.messages));
  assert.equal(stubbed.messages.find((m) => m.content === ask)?.content, ask);

  const got = applySpillCut(msgs, {
    knobs: START_KNOBS,
    corpusChars: 250_000,
    boundFiles,
    adapt: false,
    persist: false,
  });
  const tail = tailOf(got);
  assert.ok(forwardedHasAsk(got, ask), 'last user ask must stay');
  assert.ok(pairingValid(tail), 'pairing must stay valid');
  const current = tail.find((m) => m.role === 'tool' && m.tool_call_id === 'B');
  assert.ok(current, 'latest 461-byte Read must stay in the forwarded tail');
  assert.equal(current.content, smallBody);
  assert.doesNotMatch(current.content, /\[bound/);
  const older = tail.filter((m) => m.role === 'tool' && m.tool_call_id !== 'B');
  assert.ok(older.length === 1, 'older post-ask round stays so its body can be stubbed');
  assert.match(older[0].content, /\[bound/);
  assert.doesNotMatch(older[0].content, /R{20}/);
});

test('continue turn: latest fat WebSearch stays; older fat Read after the ask is stubbed', () => {
  resetAdaptState();
  const { msgs, ask, searchBody, boundFiles } = continueTurnAfterAskFixture({ latest: 'websearch' });
  const stubbed = stubBoundFileResults(msgs, {
    boundFiles,
    aggressive: true,
    budget: 6000,
    keepTail: 8,
  });
  assert.equal(stubbed.messages.find((m) => m.tool_call_id === 'B')?.content, searchBody);
  assert.match(stubbed.messages.find((m) => m.tool_call_id === 'A0')?.content, /\[bound/);
  assert.doesNotMatch(stubbed.messages.find((m) => m.tool_call_id === 'B')?.content, /\[bound/);
  assert.ok(pairingValid(stubbed.messages));

  const got = applySpillCut(msgs, {
    knobs: { keepTail: 16, minTurns: 2, budget: 24000, stubMore: false },
    corpusChars: 250_000,
    boundFiles,
    adapt: false,
    persist: false,
  });
  const tail = tailOf(got);
  assert.ok(forwardedHasAsk(got, ask), 'last user ask must stay');
  assert.ok(pairingValid(tail), 'pairing must stay valid');
  const current = tail.find((m) => m.role === 'tool' && m.tool_call_id === 'B');
  assert.ok(current, 'latest WebSearch must stay in the forwarded tail');
  assert.equal(current.content, searchBody);
  const older = tail.filter((m) => m.role === 'tool' && m.tool_call_id !== 'B');
  assert.ok(older.length >= 1 && older.every((m) => /\[bound/.test(m.content)),
    'older fat Read after the ask must be stubbed');
});

test('continue turn: keepTail trims older post-ask rounds so lastSend cannot grow to 259', () => {
  resetAdaptState();
  const { msgs, ask, smallBody, boundFiles } = continueTurnAfterAskFixture({ olderRounds: 80 });
  const got = applySpillCut(msgs, {
    knobs: { keepTail: 16, minTurns: 2, budget: 24000, stubMore: false },
    corpusChars: 1_000_000,
    boundFiles,
    adapt: false,
    persist: false,
  });
  const tail = tailOf(got);
  assert.ok(forwardedHasAsk(got, ask), 'last user ask must stay');
  assert.ok(pairingValid(tail), 'pairing must stay valid');
  const tools = tail.filter((m) => m.role === 'tool');
  assert.ok(tools.length <= 16, `keepTail 16 must cap post-ask rounds, got ${tools.length}`);
  assert.ok(tail.length < 40, `forwarded tail must not grow with the 80-round pile, got ${tail.length}`);
  const current = tools.find((m) => m.tool_call_id === 'B');
  assert.ok(current, 'latest 461-byte Read must stay');
  assert.equal(current.content, smallBody);
  const older = tools.filter((m) => m.tool_call_id !== 'B');
  assert.ok(older.every((m) => /\[bound/.test(m.content)), 'kept older post-ask bodies must be stubbed');
  assert.ok(got.sentChars < 80 * 20_000 * 0.1, `sent ${got.sentChars} still looks like the growing pile`);
  assert.ok(got.ratio >= 10, `corpus/sent ${got.ratio} should rise or hold, not decay`);
});

test('in-flight Anthropic tool_result after the ask is not stubbed', () => {
  const abs = '/tmp/small.rs';
  const body = 'fn live() { /* 461_BYTE_ANTHROPIC */ }\n'.padEnd(461, 'y');
  const anthropic = {
    messages: [
      { role: 'user', content: 'read small.rs please' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: abs } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: body }] },
    ],
  };
  const translated = anthropicToOpenAI(anthropic).messages;
  const got = stubBoundFileResults(translated, {
    boundFiles: new Set([`${abs}:1`]),
    budget: 800,
  });
  const tool = got.messages.find((m) => m.role === 'tool');
  assert.ok(tool, 'translated tool_result must exist');
  assert.equal(tool.content, body);
  assert.doesNotMatch(tool.content, /\[bound/);
});
