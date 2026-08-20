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
    assert.doesNotMatch(refused, /\\(exit \\d+\\)/);
    assert.doesNotMatch(refused, /^\\$ /);

    const mcpKeep = await tryDirective('MCP: not-a-url', t.id);
    assert.doesNotMatch(mcpKeep, /not a shell command/);
    assert.match(mcpKeep, /MCP/);

    console.log(JSON.stringify({ ok: true, listedHasReadme: /readme\\.txt/.test(listed), refusedMcp: /MCP: <url>/.test(refused) }));
    process.exit(0);
  `);
  const out = await runChild(script);
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, 'child printed a JSON result: ' + out);
  const r = JSON.parse(line);
  assert.equal(r.ok, true);
  assert.equal(r.listedHasReadme, true);
  assert.equal(r.refusedMcp, true);
});

test('/ping and PING: name wake idle descendants; PEEK stays a read', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-ping-'));
  const script = path.join(dir, 'run.mjs');
  const uiPort = 21000 + Math.floor(Math.random() * 2000);
  writeFileSync(script, `
    process.env.HOME = ${JSON.stringify(dir)};
    process.env.OZ_GROKUI_PORT = ${JSON.stringify(String(uiPort))};
    process.env.OZ_AGENT_PORTS = '0';
    const assert = (await import('node:assert/strict')).default;
    const {
      handleSlash, tryDirective, newThread, setRunTurnForTest, AUTO_CONTINUE, pingWakeText,
      childKickoff,
    } = await import(${JSON.stringify(path.join(root, 'lib/grokui.mjs'))});

    assert.equal(pingWakeText(''), AUTO_CONTINUE);
    assert.equal(pingWakeText('   '), AUTO_CONTINUE);
    assert.notEqual(String(pingWakeText('')).trim(), '');
    assert.doesNotMatch(AUTO_CONTINUE, /CONTEXT REFRESH/);
    assert.doesNotMatch(AUTO_CONTINUE, /ROOT ASK/);
    assert.doesNotMatch(AUTO_CONTINUE, /your specific job/);

    const parent = newThread('tetris', null);
    const idle = newThread('game-builder', parent.id);
    const idle2 = newThread('kid', parent.id);
    const thinking = newThread('shipcheck', parent.id);
    thinking.status = 'thinking';
    const blocked = newThread('mcp-analyst', parent.id);
    blocked.pendingRun = { runId: 'x', command: 'echo hi', cwd: ${JSON.stringify(dir)} };
    idle.history.push({ who: 'bot', text: 'old last line that used to be dumped as if I acted' });

    const wakes = [];
    setRunTurnForTest((threadId, userText) => {
      wakes.push({ threadId, userText });
      return Promise.resolve();
    });

    const slash = await handleSlash('/ping', parent);
    assert.match(slash, /game-builder: pinged, working/);
    assert.match(slash, /kid: pinged, working/);
    assert.match(slash, /shipcheck: working/);
    assert.match(slash, /mcp-analyst: BLOCKED/);
    assert.equal(wakes.length, 2);
    assert.deepEqual(wakes.map((w) => w.threadId).sort(), [idle.id, idle2.id].sort());
    assert.ok(wakes.every((w) => w.userText === AUTO_CONTINUE));

    wakes.length = 0;
    const named = await tryDirective('PING: game-builder', parent.id);
    assert.equal(named, 'game-builder: pinged, working');
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].threadId, idle.id);
    assert.equal(wakes[0].userText, AUTO_CONTINUE);

    wakes.length = 0;
    const star = await tryDirective('PING: *', parent.id);
    assert.match(star, /game-builder: pinged, working/);
    assert.match(star, /kid: pinged, working/);
    assert.match(star, /shipcheck: still working/);
    assert.match(star, /mcp-analyst: BLOCKED/);
    assert.equal(wakes.length, 2);

    wakes.length = 0;
    const peek = await tryDirective('PEEK: game-builder', parent.id);
    assert.match(peek, /old last line/);
    assert.equal(wakes.length, 0, 'PEEK must stay read-only');

    wakes.length = 0;
    const emptyPing = await handleSlash('/ping', parent);
    assert.match(emptyPing, /pinged, working/);
    assert.equal(wakes.length, 2, 'empty /ping is a wake, not a cancel');
    assert.ok(wakes.every((w) => w.userText === AUTO_CONTINUE));
    assert.ok(wakes.every((w) => !/CONTEXT REFRESH|ROOT ASK|your specific job/.test(w.userText)));

    const refresh = childKickoff(parent, 'game-builder', 'keep building the game', { fresh: false });
    assert.match(refresh, /CONTEXT REFRESH/);
    assert.equal(pingWakeText(refresh), AUTO_CONTINUE);

    wakes.length = 0;
    const respawn = await tryDirective('SPAWN: game-builder | keep building the game', parent.id);
    assert.match(respawn, /already exists/);
    assert.match(respawn, /woke it to keep working/);
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].threadId, idle.id);
    assert.equal(wakes[0].userText, AUTO_CONTINUE);
    assert.doesNotMatch(wakes[0].userText, /CONTEXT REFRESH/);

    console.log(JSON.stringify({ ok: true, slashWakes: 2, peekWakes: 0 }));
    process.exit(0);
  `);
  const out = await runChild(script);
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, 'child printed a JSON result: ' + out);
  const r = JSON.parse(line);
  assert.equal(r.ok, true);
  assert.equal(r.peekWakes, 0);
});

test('/tier grok 4.6 pins the grok4.6 band and spawn inherits it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-tier-'));
  const script = path.join(dir, 'run.mjs');
  const uiPort = 22000 + Math.floor(Math.random() * 2000);
  writeFileSync(script, `
    process.env.HOME = ${JSON.stringify(dir)};
    process.env.OZ_GROKUI_PORT = ${JSON.stringify(String(uiPort))};
    process.env.OZ_AGENT_PORTS = '0';
    const assert = (await import('node:assert/strict')).default;
    const { handleSlash, newThread, childKickoff } = await import(${JSON.stringify(path.join(root, 'lib/grokui.mjs'))});
    const { TIER_NAMES } = await import(${JSON.stringify(path.join(root, 'lib/podagent.mjs'))});

    assert.deepEqual(TIER_NAMES, ['cheap', 'medium', 'expensive', 'grok4.6']);

    const parent = newThread('tier-parent', null);
    assert.equal(parent.tier, undefined);

    const spaced = await handleSlash('/tier grok 4.6', parent);
    assert.equal(parent.tier, 'grok4.6');
    assert.match(spaced, /grok4\\.6/);
    assert.doesNotMatch(spaced, /Unknown tier/);

    parent.tier = 'medium';
    const compact = await handleSlash('/tier grok4.6', parent);
    assert.equal(parent.tier, 'grok4.6');
    assert.match(compact, /grok4\\.6/);

    const hyphen = await handleSlash('/tier grok-4.6', parent);
    assert.equal(parent.tier, 'grok4.6');
    assert.match(hyphen, /x-ai\\/grok-4\\.6/);

    parent.tier = 'medium';
    const bare = await handleSlash('/tier grok', parent);
    assert.equal(parent.tier, 'grok4.6');
    assert.match(bare, /grok4\\.6/);

    const unknown = await handleSlash('/tier opus', parent);
    assert.equal(parent.tier, 'grok4.6');
    assert.match(unknown, /Unknown tier/);

    parent.race = 4;
    parent.raceNeed = 2;
    const child = newThread('tier-child', parent.id);
    assert.equal(child.tier, 'grok4.6');
    assert.equal(child.race, 4);
    assert.equal(child.raceNeed, 2);
    const brief = childKickoff(parent, 'tier-child', 'do the work');
    assert.match(brief, /tier: grok4\\.6/);

    console.log(JSON.stringify({ ok: true, tier: parent.tier, childTier: child.tier }));
    process.exit(0);
  `);
  const out = await runChild(script);
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, 'child printed a JSON result: ' + out);
  const r = JSON.parse(line);
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'grok4.6');
  assert.equal(r.childTier, 'grok4.6');
});
