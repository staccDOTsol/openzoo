import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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
      reject(new Error('harness child timed out: ' + buf));
    }, 20000);
    child.on('exit', (code) => {
      clearTimeout(t);
      if (code !== 0) reject(new Error('harness child exited ' + code + ': ' + buf));
      else resolve(buf);
    });
  });
}

test('parseRun, think-tag strip, inDir, MCP-as-bash refuse', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-harness-'));
  const ws = path.join(dir, 'workspace');
  mkdirSync(ws);
  writeFileSync(path.join(ws, 'readme.txt'), 'hello');
  const script = path.join(dir, 'run.mjs');
  const uiPort = 19000 + Math.floor(Math.random() * 2000);
  writeFileSync(script, `
    process.env.HOME = ${JSON.stringify(dir)};
    process.env.OZ_WORKSPACE_DIR = ${JSON.stringify(ws)};
    process.env.OZ_GROKUI_PORT = ${JSON.stringify(String(uiPort))};
    process.env.OZ_AGENT_PORTS = '0';
    const assert = (await import('node:assert/strict')).default;
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const path = await import('node:path');
    const {
      parseRun, looksLikeMcpAsBash, stripThinkTags, safeResolveIn, inDir,
      tryDirective,
    } = await import(${JSON.stringify(path.join(root, 'lib/grokui.mjs'))});

    assert.equal(parseRun('RUN: ls -la'), 'ls -la');
    assert.equal(parseRun('sure\\nRUN: pwd'), 'pwd');
    assert.equal(parseRun('RUN: ls\\nRUN: pwd'), 'ls\\npwd');
    assert.equal(parseRun('RUN: ls -la\\nMCP: http://127.0.0.1:9 | get_skill | {}'), 'ls -la');
    assert.equal(parseRun('RUN: get_skill'), null);
    assert.equal(parseRun('RUN: get_skill\\nproofnetwork-contract'), null);
    assert.equal(parseRun('RUN: proofnetwork-play\\nMCP: http://x'), null);
    assert.equal(parseRun('RUN: publish-update'), null);
    assert.equal(parseRun('RUN: MCP: http://127.0.0.1:9 | get_skill | {}'), null);
    assert.equal(parseRun('RUN:\\nget_skill\\nproofnetwork-contract\\npublish-update'), null);
    assert.equal(looksLikeMcpAsBash('get_skill'), true);
    assert.equal(looksLikeMcpAsBash('proofnetwork-contract'), true);
    assert.equal(looksLikeMcpAsBash('MCP: http://x | get_skill | {}'), true);
    assert.equal(looksLikeMcpAsBash('echo hello'), false);
    assert.equal(looksLikeMcpAsBash('ls -la'), false);

    const leaked = 'visible\\n<think>secret plan</think>\\nmore\\n<thinking>nope</thinking>\\n</think>';
    const clean = stripThinkTags(leaked);
    assert.equal(clean.includes('<think'), false);
    assert.equal(clean.includes('</think>'), false);
    assert.equal(clean.includes('secret plan'), false);
    assert.equal(clean.includes('nope'), false);
    assert.match(clean, /visible/);
    assert.match(clean, /more/);
    assert.equal(stripThinkTags('<thinking>unclosed'), '');

    const doubled = safeResolveIn(${JSON.stringify(ws)}, ${JSON.stringify(ws + '/')});
    assert.equal(doubled, path.resolve(${JSON.stringify(ws)}));
    assert.equal(inDir(${JSON.stringify(ws)}, ${JSON.stringify(ws)}), path.resolve(${JSON.stringify(ws)}));
    assert.equal(inDir(${JSON.stringify(ws)}, 'readme.txt'), path.join(path.resolve(${JSON.stringify(ws)}), 'readme.txt'));
    assert.throws(() => inDir(${JSON.stringify(ws)}, '/etc/passwd'));

    let ready = false;
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch('http://127.0.0.1:' + ${uiPort} + '/threads');
        if (r.ok) { ready = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!ready) { console.error('grokui did not start'); process.exit(1); }
    const t = await (await fetch('http://127.0.0.1:' + ${uiPort} + '/threads', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'HarnessBot' }),
    })).json();
    await fetch('http://127.0.0.1:' + ${uiPort} + '/drive', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: t.id, task: '/dir ' + ${JSON.stringify(ws)} }),
    });

    const listed = await tryDirective('LIST: ' + ${JSON.stringify(ws + '/')}, t.id);
    assert.doesNotMatch(listed, /Couldn't list/);
    assert.doesNotMatch(listed, /Users\\/.+\\/Users\\//);
    assert.match(listed, /readme\\.txt/);

    const readAbs = await tryDirective('READ: ' + ${JSON.stringify(path.join(ws, 'readme.txt'))}, t.id);
    assert.match(readAbs, /hello/);

    const refused = await tryDirective('RUN: get_skill\\nproofnetwork-contract\\nMCP: http://127.0.0.1:9', t.id);
    assert.match(refused, /MCP: <url>/);
    assert.match(refused, /get_skill/);
    assert.doesNotMatch(refused, /command not found/);

    const mcpKeep = await tryDirective('MCP: not-a-url', t.id);
    assert.doesNotMatch(mcpKeep, /not a shell command/);
    assert.match(mcpKeep, /MCP/);

    console.log(JSON.stringify({ ok: true, listed, refused: refused.slice(0, 80) }));
    process.exit(0);
  `);
  const out = await runChild(script);
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, 'child printed a JSON result: ' + out);
  const r = JSON.parse(line);
  assert.equal(r.ok, true);
  assert.match(r.listed, /readme\.txt/);
  assert.match(r.refused, /MCP:/);
});
