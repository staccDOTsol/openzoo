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
      parseRun, looksLikeMcpAsBash, stripThinkTags, takeThink, safeResolveIn, inDir,
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
    const folded = takeThink(leaked);
    assert.equal(folded.text, clean);
    assert.match(folded.thinking, /secret plan/);
    assert.match(folded.thinking, /nope/);
    assert.equal(takeThink('plain answer').thinking, undefined);

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

test('AUTO keeps going after RUN and race-fail; DONE and pendingRun park', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-auto-keep-'));
  const script = path.join(dir, 'run.mjs');
  const uiPort = 23000 + Math.floor(Math.random() * 2000);
  writeFileSync(script, `
    process.env.HOME = ${JSON.stringify(dir)};
    process.env.OZ_WORKSPACE_DIR = ${JSON.stringify(dir)};
    process.env.OZ_GROKUI_PORT = ${JSON.stringify(String(uiPort))};
    process.env.OZ_AGENT_PORTS = '0';
    process.env.OZ_AUTO_MAX_STEPS = '8';
    process.env.OZ_AUTO_EMPTY_RETRIES = '0';
    const assert = (await import('node:assert/strict')).default;
    const { RACE_EVERY_FAILED } = await import(${JSON.stringify(path.join(root, 'lib/livestatus.js'))});
    const {
      newThread, runTurn, setBrainAskForTest, setRunTurnForTest,
      handleSlash, AUTO_RACE_RETRY, AUTO_EMPTY_RETRY, shouldKeepAuto,
      isDoneReply, isTransientModelFail, isEmptyToolResult,
      isPaymentFailed, isEmptyWalletPayment,
    } = await import(${JSON.stringify(path.join(root, 'lib/grokui.mjs'))});

    async function drain(pred) {
      const start = Date.now();
      while (Date.now() - start < 4000) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 15));
      }
    }

    assert.equal(isDoneReply('DONE: shipped'), true);
    assert.equal(isTransientModelFail(RACE_EVERY_FAILED), true);
    assert.equal(isTransientModelFail('error: fetch failed'), true);
    assert.equal(isTransientModelFail('listed files'), false);

    const auto = newThread('auto-keep', null);
    auto.runMode = 'auto';
    assert.equal(shouldKeepAuto(auto, RACE_EVERY_FAILED), true);
    assert.equal(shouldKeepAuto(auto, 'DONE: shipped'), false);
    assert.equal(isEmptyWalletPayment('(payment required — HTTP 402, the wallet is empty.)'), true);
    assert.equal(isEmptyWalletPayment('openzoo wallet underfunded: this call needs more'), true);
    assert.equal(isEmptyWalletPayment('(payment failed — HTTP 402 after 3 retries, though the wallet holds 12 USDC)'), false);
    assert.equal(isPaymentFailed('(payment failed — HTTP 402 after 3 retries, though the wallet holds 12 USDC)'), true);
    assert.equal(shouldKeepAuto(auto, '(payment required — HTTP 402, the wallet is empty.)'), false);
    assert.equal(isEmptyToolResult('(command output)\\n(no output)'), true);
    assert.equal(shouldKeepAuto(auto, 'DONE: shipped', '(command output)\\n(no output)'), true);
    auto.pendingRun = { runId: 'x', command: 'echo', cwd: ${JSON.stringify(dir)} };
    assert.equal(shouldKeepAuto(auto, 'RUN: ls'), false);
    delete auto.pendingRun;

    const hops = [];
    setBrainAskForTest(({ userText }) => {
      hops.push(String(userText || ''));
      if (hops.length === 1) return 'RUN: echo oz-auto-keep';
      if (/^\\(command output\\)/.test(userText)) return RACE_EVERY_FAILED;
      return 'DONE: after race fail';
    });
    await runTurn(auto.id, 'build it');
    await drain(() => hops.length >= 3 && auto.status === 'idle');
    assert.ok(hops.length >= 3, 'RUN then race-fail must kick again, got ' + hops.length + ' ' + JSON.stringify(hops));
    assert.match(hops[1], /\\(command output\\)/);
    assert.equal(hops[2], AUTO_RACE_RETRY);

    const doneBot = newThread('done-keep', null);
    doneBot.runMode = 'auto';
    const doneHops = [];
    setBrainAskForTest(({ userText }) => {
      doneHops.push(String(userText || ''));
      return 'DONE: finished';
    });
    await runTurn(doneBot.id, 'wrap up');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(doneHops.length, 1, 'DONE: must not kick');
    assert.equal(doneBot.status, 'idle');

    const askBot = newThread('ask-keep', null);
    askBot.runMode = 'ask';
    const askHops = [];
    setBrainAskForTest(({ userText }) => {
      askHops.push(String(userText || ''));
      return 'RUN: mkdir -p should-wait';
    });
    await runTurn(askBot.id, 'please mkdir');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(askHops.length, 1, 'pendingRun must not kick');
    assert.ok(askBot.pendingRun);
    assert.equal(shouldKeepAuto(askBot, 'listed files'), false);

    const parent = newThread('tetris-auto', null);
    parent.runMode = 'auto';
    const kid = newThread('game-builder', parent.id);
    kid.runMode = 'auto';
    const wakes = [];
    setRunTurnForTest((threadId, userText) => {
      wakes.push({ threadId, userText });
      return Promise.resolve();
    });
    const ping = await handleSlash('/ping', parent);
    assert.match(ping, /tetris-auto.*pinged, working/);
    assert.match(ping, /game-builder: pinged, working/);
    assert.ok(wakes.some((w) => w.threadId === parent.id), 'auto /ping wakes the parent');
    assert.ok(wakes.some((w) => w.threadId === kid.id), 'auto /ping still wakes kids');

    wakes.length = 0;
    const all = await handleSlash('/all keep going', parent);
    assert.match(all, /Sent down/);
    assert.ok(wakes.some((w) => w.threadId === parent.id), 'auto /all wakes the parent');
    assert.ok(wakes.some((w) => w.threadId === kid.id), 'auto /all still sends to kids');

    console.log(JSON.stringify({
      ok: true, hops: hops.length, doneHops: doneHops.length, askHops: askHops.length,
      pingParent: true,
    }));
    process.exit(0);
  `);
  const out = await runChild(script);
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, 'child printed a JSON result: ' + out);
  const r = JSON.parse(line);
  assert.equal(r.ok, true);
  assert.ok(r.hops >= 3);
  assert.equal(r.doneHops, 1);
  assert.equal(r.askHops, 1);
});

test('AUTO empty command output retries and does not idle', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-auto-empty-'));
  const script = path.join(dir, 'run.mjs');
  const uiPort = 25000 + Math.floor(Math.random() * 2000);
  writeFileSync(script, `
    process.env.HOME = ${JSON.stringify(dir)};
    process.env.OZ_WORKSPACE_DIR = ${JSON.stringify(dir)};
    process.env.OZ_GROKUI_PORT = ${JSON.stringify(String(uiPort))};
    process.env.OZ_AGENT_PORTS = '0';
    process.env.OZ_AUTO_MAX_STEPS = '8';
    process.env.OZ_AUTO_EMPTY_RETRIES = '0';
    const assert = (await import('node:assert/strict')).default;
    const {
      newThread, runTurn, setBrainAskForTest,
      AUTO_EMPTY_RETRY, shouldKeepAuto, isEmptyToolResult,
    } = await import(${JSON.stringify(path.join(root, 'lib/grokui.mjs'))});

    async function drain(pred) {
      const start = Date.now();
      while (Date.now() - start < 4000) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 15));
      }
    }

    assert.equal(isEmptyToolResult('(command output)\\n(no output)'), true);
    assert.equal(isEmptyToolResult('(command output)\\n   \\n'), true);
    assert.equal(isEmptyToolResult('(command output) (no output)'), true);
    assert.equal(isEmptyToolResult(''), true);
    assert.equal(isEmptyToolResult('(command output)\\nlisted files'), false);
    assert.equal(isEmptyToolResult(AUTO_EMPTY_RETRY), false);

    const wrap = newThread('empty-wrap', null);
    wrap.runMode = 'auto';
    assert.equal(shouldKeepAuto(wrap, 'DONE: looks empty', '(command output)\\n(no output)'), true);
    const wrapHops = [];
    setBrainAskForTest(({ userText }) => {
      wrapHops.push(String(userText || ''));
      return 'DONE: looks empty';
    });
    await runTurn(wrap.id, '(command output)\\n(no output)');
    await drain(() => wrapHops.length >= 2);
    assert.ok(wrapHops.length >= 2, 'empty wrap must schedule another hop, got ' + wrapHops.length + ' ' + JSON.stringify(wrapHops));
    assert.equal(wrapHops[0], '(command output)\\n(no output)');
    assert.equal(wrapHops[1], AUTO_EMPTY_RETRY);
    await drain(() => wrap.status === 'idle');
    assert.equal(wrapHops.length, 2, 'DONE after AUTO_EMPTY_RETRY may park');
    assert.equal(wrap.status, 'idle');

    const runBot = newThread('empty-run', null);
    runBot.runMode = 'auto';
    const runHops = [];
    setBrainAskForTest(({ userText }) => {
      runHops.push(String(userText || ''));
      if (runHops.length === 1) return 'RUN: mkdir -p oz-auto-empty';
      if (userText === AUTO_EMPTY_RETRY) return 'DONE: after empty mkdir';
      return 'DONE: unexpected ' + userText;
    });
    await runTurn(runBot.id, 'build it');
    await drain(() => runHops.length >= 2 && runBot.status === 'idle');
    assert.ok(runHops.length >= 2, 'empty RUN stdout must kick AUTO_EMPTY_RETRY, got ' + runHops.length + ' ' + JSON.stringify(runHops));
    assert.equal(runHops[1], AUTO_EMPTY_RETRY);
    assert.doesNotMatch(runHops[1], /\\(command output\\)/);

    console.log(JSON.stringify({
      ok: true, wrapHops: wrapHops.length, runHops: runHops.length,
    }));
    process.exit(0);
  `);
  const out = await runChild(script);
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, 'child printed a JSON result: ' + out);
  const r = JSON.parse(line);
  assert.equal(r.ok, true);
  assert.ok(r.wrapHops >= 2);
  assert.ok(r.runHops >= 2);
});
