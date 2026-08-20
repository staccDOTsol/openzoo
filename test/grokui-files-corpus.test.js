import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const grokuiSrc = readFileSync(path.join(root, 'lib', 'grokui.mjs'), 'utf8');
const podSrc = readFileSync(path.join(root, 'lib', 'podagent.mjs'), 'utf8');

function runChild(script, envExtra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, OZ_AGENT_PORTS: '0', ...envExtra },
    });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.stderr.on('data', (d) => { buf += d; });
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('files-corpus child timed out: ' + buf));
    }, 25000);
    child.on('exit', (code) => {
      clearTimeout(t);
      if (code !== 0) reject(new Error('files-corpus child exited ' + code + ': ' + buf));
      else resolve(buf);
    });
  });
}

test('grokui wires READ/WRITE/EDIT/MULTIEDIT/NOTEBOOK/RUN through filesForCorpus', () => {
  assert.match(grokuiSrc, /function filesForCorpus\(/);
  assert.match(grokuiSrc, /from '\.\/spill\.js'/);
  assert.match(grokuiSrc, /BIND_MIN_CHARS/);
  assert.match(grokuiSrc, /noteFileForCorpus\(originId, full\)/);
  assert.equal((grokuiSrc.match(/noteFileForCorpus\(originId, full\)/g) || []).length >= 5, true,
    'READ/WRITE/EDIT/MULTIEDIT/NOTEBOOK must each record the file');
  assert.match(grokuiSrc, /noteRunForCorpus\(t\.id, command/);
  assert.match(grokuiSrc, /\$\{PROXY\}\/hrr\/bind/);
  assert.match(grokuiSrc, /context_id: ctx/);
  assert.match(podSrc, /Do NOT attach x-hrr-context/);
  assert.doesNotMatch(podSrc, /['"]x-hrr-context['"]\s*:/);
});

test('READ records file; path:mtime dedup; mtime rebind; 400KB cap; background append', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-files-corpus-'));
  const ws = path.join(dir, 'workspace');
  mkdirSync(ws);
  const script = path.join(dir, 'run.mjs');
  const uiPort = 22000 + Math.floor(Math.random() * 2000);
  writeFileSync(script, `
    process.env.HOME = ${JSON.stringify(dir)};
    process.env.OZ_WORKSPACE_DIR = ${JSON.stringify(ws)};
    process.env.OZ_GROKUI_PORT = ${JSON.stringify(String(uiPort))};
    process.env.OZ_AGENT_PORTS = '0';
    const assert = (await import('node:assert/strict')).default;
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { BIND_MIN_CHARS: HRR_MIN } = await import(${JSON.stringify(path.join(root, 'lib/hrr.js'))});
    const {
      tryDirective, newThread, filesForCorpus, noteFileForCorpus, noteRunForCorpus,
      resetFilesForCorpus, filesForCorpusKeys, inFlightChars, BIND_MIN_CHARS, KEEP_MAX,
    } = await import(${JSON.stringify(path.join(root, 'lib/grokui.mjs'))});

    const binds = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes('/hrr/bind')) {
        binds.push({ url: String(url), body: JSON.parse(opts.body) });
        return {
          ok: true, status: 200,
          json: async () => ({ context_id: JSON.parse(opts.body).context_id || 'ctx-files', bound: 1 }),
          text: async () => '{}',
        };
      }
      return origFetch(url, opts);
    };
    const flush = async () => {
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 15));
    };

    assert.equal(BIND_MIN_CHARS, HRR_MIN);
    assert.equal(KEEP_MAX, 400000);

    const notes = path.join(${JSON.stringify(ws)}, 'notes.txt');
    fs.writeFileSync(notes, 'FILE_BODY_UNIQUE_xyz');

    resetFilesForCorpus();
    const first = filesForCorpus(notes, { cwd: ${JSON.stringify(ws)} });
    assert.ok(first.pending.some((p) => p.abs === notes && p.kind === 'file'),
      'READ-shaped path must be pending in filesForCorpus');
    assert.ok([...filesForCorpusKeys()].some((k) => k.startsWith(notes + ':')));

    const sameMtime = filesForCorpus(notes, { cwd: ${JSON.stringify(ws)} });
    assert.equal(sameMtime.pending.length, 0, 'same path:mtime must not re-bind');

    const later = new Date(Date.now() + 5000);
    fs.utimesSync(notes, later, later);
    const changed = filesForCorpus(notes, { cwd: ${JSON.stringify(ws)} });
    assert.ok(changed.pending.some((p) => p.abs === notes), 'changed mtime must re-bind');

    const fat = path.join(${JSON.stringify(ws)}, 'fat.bin');
    fs.writeFileSync(fat, 'Y'.repeat(400_001));
    const over = filesForCorpus(fat, { cwd: ${JSON.stringify(ws)}, cap: 400000 });
    assert.equal(over.pending.length, 0, 'over 400KB must be capped (not pending)');
    assert.equal(over.cap, 1);

    resetFilesForCorpus();
    const t = newThread('CorpusBot', null);
    t.dir = ${JSON.stringify(ws)};
    t.contextId = 'existing-ctx';
    t.messages = [
      { role: 'system', content: 'short' },
      { role: 'user', content: 'hi' },
    ];
    assert.ok(inFlightChars(t) < BIND_MIN_CHARS, 'fixture messages must be below BIND_MIN_CHARS');

    const ack = await tryDirective('READ: notes.txt', t.id);
    assert.match(ack, /FILE_BODY_UNIQUE_xyz/);
    assert.ok([...filesForCorpusKeys()].some((k) => k.startsWith(notes + ':')));

    const afterRead = filesForCorpus(notes, { cwd: ${JSON.stringify(ws)} });
    assert.equal(afterRead.pending.length, 0, 'READ must have recorded path:mtime');

    const job = noteFileForCorpus(t.id, notes, {
      defer: false,
      fetchImpl: globalThis.fetch,
      sentChars: 12,
    });
    // already bound at this mtime — no second POST from noteFile
    assert.equal(job, null);

    fs.writeFileSync(notes, 'FILE_BODY_UNIQUE_xyz\\nsecond-edition');
    const rebound = noteFileForCorpus(t.id, notes, {
      defer: false,
      fetchImpl: globalThis.fetch,
      sentChars: 12,
    });
    assert.ok(rebound, 'mtime change after WRITE-equivalent must schedule bind');
    assert.equal(rebound.background, true, 'below BIND_MIN_CHARS must background-append');
    assert.equal(rebound.append, true);
    await rebound.promise;
    assert.ok(binds.length >= 1, 'mock /hrr/bind must be called');
    const payload = binds.find((b) => (b.body.corpus || '').includes('FILE_BODY_UNIQUE_xyz'))
      || binds[binds.length - 1];
    assert.match(payload.url, /hrr\\/bind/);
    assert.equal(payload.body.context_id, 'existing-ctx');
    assert.match(payload.body.corpus, /FILE_BODY_UNIQUE_xyz/);
    assert.match(payload.body.corpus, /notes\\.txt|FILE /);

    resetFilesForCorpus();
    binds.length = 0;
    const wrote = await tryDirective('WRITE: other.txt | OTHER_BODY_UNIQUE', t.id);
    assert.match(wrote, /Wrote other\\.txt/);
    await flush();
    assert.ok(binds.some((b) => /OTHER_BODY_UNIQUE/.test(b.body.corpus || '')),
      'WRITE must bind path + contents');
    assert.ok(binds.some((b) => b.body.context_id === 'existing-ctx'));

    resetFilesForCorpus();
    binds.length = 0;
    const cat = noteRunForCorpus(t.id, 'cat notes.txt', {
      cwd: ${JSON.stringify(ws)},
      defer: false,
      fetchImpl: globalThis.fetch,
      sentChars: 8,
    });
    assert.ok(cat, 'RUN cat must go through filesForCorpus');
    assert.equal(cat.background, true);
    await cat.promise;
    assert.ok(binds.some((b) => /FILE_BODY_UNIQUE_xyz/.test(b.body.corpus || '')));

    const npm = noteRunForCorpus(t.id, 'npm test', { cwd: ${JSON.stringify(ws)}, defer: false });
    assert.equal(npm, null, 'non-file RUN must not bind');

    console.log(JSON.stringify({
      ok: true,
      binds: binds.length,
      readAck: /FILE_BODY_UNIQUE_xyz/.test(ack),
    }));
    process.exit(0);
  `);
  const out = await runChild(script);
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, 'child printed a JSON result: ' + out);
  const r = JSON.parse(line);
  assert.equal(r.ok, true);
  assert.equal(r.readAck, true);
});
