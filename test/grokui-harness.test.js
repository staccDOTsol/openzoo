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
      parseRun, looksLikeMcpAsBash, looksLikeDirectiveAsBash, isFailedExecOutput,
      stripThinkTags, takeThink, safeResolveIn, inDir,
      tryDirective, newThread, enqueueAutoHop, shouldKeepAuto, setRunTurnForTest,
      NUDGE, AUTO_CONTINUE,
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
    assert.equal(parseRun('RUN: WRITE:5d_chess.py'), null, 'WRITE: as RUN body is not bash');
    assert.equal(parseRun('RUN: WRITE: 5d_chess.py | print(1)'), null);
    assert.equal(looksLikeDirectiveAsBash('WRITE:5d_chess.py'), true);
    assert.equal(isFailedExecOutput('WRITE:5d_chess.py: command not found\\n(exit 127)'), true);
    assert.equal(isFailedExecOutput('SyntaxError: unexpected EOF while parsing'), true);
    const failT = newThread('fail-run', null);
    failT.runMode = 'auto';
    failT.lastRunFailed = true;
    const hops = [];
    setRunTurnForTest((id, text) => { hops.push(text); return Promise.resolve(); });
    assert.equal(shouldKeepAuto(failT, '$ python -c x\\nSyntaxError: bad'), false);
    assert.equal(enqueueAutoHop(failT, failT.id, NUDGE), false);
    assert.equal(enqueueAutoHop(failT, failT.id, AUTO_CONTINUE), false);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(hops.length, 0, 'failed RUN must not inject NUDGE/AUTO_CONTINUE as a user turn');
    setRunTurnForTest(null);
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

test('AUTO is Claude Code once; ask still parks pendingRun; ping wakes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-auto-keep-'));
  const script = path.join(dir, 'run.mjs');
  const uiPort = 23000 + Math.floor(Math.random() * 2000);
  writeFileSync(script, `
    process.env.HOME = ${JSON.stringify(dir)};
    process.env.OZ_WORKSPACE_DIR = ${JSON.stringify(dir)};
    process.env.OZ_GROKUI_PORT = ${JSON.stringify(String(uiPort))};
    process.env.OZ_AGENT_PORTS = '0';
    const assert = (await import('node:assert/strict')).default;
    const { writeFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { RACE_EVERY_FAILED } = await import(${JSON.stringify(path.join(root, 'lib/livestatus.js'))});
    const {
      newThread, runTurn, setBrainAskForTest, setRunTurnForTest, setClaudeRunnerForTest,
      handleSlash, isGrokuiOwnedSlash, shouldKeepAuto,
      isDoneReply, isTransientModelFail, isEmptyToolResult,
      isPaymentFailed, isEmptyWalletPayment,
    } = await import(${JSON.stringify(path.join(root, 'lib/grokui.mjs'))});

    assert.equal(isGrokuiOwnedSlash('/mode auto', 'auto'), true);
    assert.equal(isGrokuiOwnedSlash('/tier cheap', 'auto'), true);
    assert.equal(isGrokuiOwnedSlash('/help', 'auto'), true);
    assert.equal(isGrokuiOwnedSlash('/dir /tmp', 'auto'), true);
    assert.equal(isGrokuiOwnedSlash('/agents', 'auto'), false);
    assert.equal(isGrokuiOwnedSlash('/tasks', 'auto'), false);
    assert.equal(isGrokuiOwnedSlash('/context', 'auto'), false);
    assert.equal(isGrokuiOwnedSlash('/model opus', 'auto'), false);
    assert.equal(isGrokuiOwnedSlash('/model opus', 'ask'), true);
    assert.equal(isGrokuiOwnedSlash('/cost', 'auto'), true);

    assert.equal(isDoneReply('DONE: shipped'), true);
    assert.equal(isTransientModelFail(RACE_EVERY_FAILED), true);
    assert.equal(isEmptyWalletPayment('(payment required — HTTP 402, the wallet is empty.)'), true);
    assert.equal(isEmptyWalletPayment('openzoo wallet underfunded: this call needs more'), true);
    assert.equal(isPaymentFailed('(payment failed — HTTP 402 after 3 retries, though the wallet holds 12 USDC)'), true);
    assert.equal(shouldKeepAuto({ runMode: 'auto' }, '(payment required — HTTP 402, the wallet is empty.)'), false);
    assert.equal(shouldKeepAuto({ runMode: 'auto' }, 'upstream HTTP 500'), false);
    assert.equal(shouldKeepAuto({ runMode: 'auto' }, '(upstream error — HTTP 500, try again)'), false);
    assert.equal(shouldKeepAuto({ runMode: 'auto' }, ''), false);
    assert.equal(shouldKeepAuto({ runMode: 'auto' }, '(no response)'), false);
    assert.equal(shouldKeepAuto({ runMode: 'auto' }, '(payment failed — HTTP 402 after 3 retries, though the wallet holds 12 USDC)'), false);
    assert.equal(isEmptyToolResult('(command output)\\n(no output)'), true);

    const auto = newThread('auto-keep', null);
    auto.runMode = 'auto';
    const claudeCalls = [];
    const painted = [];
    setBrainAskForTest(() => { throw new Error('Auto must not call chat/completions'); });
    setClaudeRunnerForTest(async ({ prompt, cwd, onEvent }) => {
      claudeCalls.push({ prompt, cwd });
      writeFileSync(path.join(cwd, 'hello.txt'), 'from claude write');
      onEvent?.({ kind: 'init', sessionId: 'sess-auto', model: 'openzoo-claude' });
      onEvent?.({
        kind: 'assistant',
        sessionId: 'sess-auto',
        thinking: 'I will write the file',
        text: 'Writing hello.txt',
        tools: [{ name: 'Write', input: { file_path: 'hello.txt', content: 'from claude write' } }],
      });
      return { text: 'Wrote hello.txt', sessionId: 'sess-auto', error: false, paymentFailed: '' };
    });
    await runTurn(auto.id, 'create hello.txt', (ev) => painted.push(ev));
    assert.equal(claudeCalls.length, 1, 'Claude Code is the loop — one spawn, not RUN hops');
    assert.equal(auto.status, 'idle');
    assert.equal(auto.claudeSessionId, 'sess-auto');
    assert.match(auto.history.map((h) => h.text).join('\\n'), /Wrote hello.txt/);
    assert.ok(painted.some((e) => e.type === 'think'), 'thinking… row must paint while Claude is alive');
    assert.match(painted.filter((e) => e.type === 'think').map((e) => e.delta).join(''), /I will write/);
    assert.ok(painted.some((e) => e.type === 'tool' && /Write hello\\.txt/.test(e.detail)));
    assert.ok(!painted.some((e) => e.type === 'status' && /Write hello/.test(e.detail || '')));
    assert.doesNotMatch(auto.history.map((h) => h.text).join('\\n'), /file_path|tool_use|system-reminder/);
    assert.doesNotMatch(painted.map((e) => e.text || e.detail || '').join('\\n'), /chat\\/completions/);
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(path.join(${JSON.stringify(dir)}, 'hello.txt'), 'utf8'), 'from claude write');

    const payBot = newThread('pay-keep', null);
    payBot.runMode = 'auto';
    setClaudeRunnerForTest(async () => ({
      text: 'API Error',
      sessionId: 'sess-pay',
      error: true,
      paymentFailed: '(payment required — HTTP 402, the wallet is empty.)',
    }));
    await runTurn(payBot.id, 'do work');
    assert.match(payBot.history[payBot.history.length - 1].text, /wallet is empty/);
    assert.equal(payBot.status, 'idle');

    const errBot = newThread('err-400', null);
    errBot.runMode = 'auto';
    const errPainted = [];
    setClaudeRunnerForTest(async ({ onEvent }) => {
      onEvent?.({ kind: 'init', sessionId: 'sess-400', model: 'openzoo-claude' });
      onEvent?.({ kind: 'think', text: '' });
      onEvent?.({ kind: 'tool', name: 'Read', input: { file_path: 'secret.bin' } });
      onEvent?.({ kind: 'partial' });
      return {
        text: 'API Error: 400 ' + '\\uFFFD'.repeat(20) + 'gzip-body',
        sessionId: 'sess-400',
        error: true,
        paymentFailed: '',
      };
    });
    await runTurn(errBot.id, 'do work', (ev) => errPainted.push(ev));
    assert.equal(errBot.history[errBot.history.length - 1].text, 'upstream HTTP 400');
    assert.doesNotMatch(errBot.history.map((h) => h.text).join('\\n'), /gzip-body|API Error|\\uFFFD/);
    assert.ok(errPainted.some((e) => e.type === 'think'));
    assert.ok(errPainted.some((e) => e.type === 'tool' && /Read secret\\.bin/.test(e.detail)));
    assert.match(errBot.history[errBot.history.length - 1].thinking || '', /Read secret\\.bin/);
    assert.equal(errBot.status, 'idle');

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
      ok: true, claudeCalls: claudeCalls.length, askHops: askHops.length,
      pingParent: true,
    }));
    process.exit(0);
  `);
  const out = await runChild(script);
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, 'child printed a JSON result: ' + out);
  const r = JSON.parse(line);
  assert.equal(r.ok, true);
  assert.equal(r.claudeCalls, 1);
  assert.equal(r.askHops, 1);
});

test('AUTO does not mkdir-and-Done or curl chat/completions', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-auto-empty-'));
  const script = path.join(dir, 'run.mjs');
  const uiPort = 25000 + Math.floor(Math.random() * 2000);
  writeFileSync(script, `
    process.env.HOME = ${JSON.stringify(dir)};
    process.env.OZ_WORKSPACE_DIR = ${JSON.stringify(dir)};
    process.env.OZ_GROKUI_PORT = ${JSON.stringify(String(uiPort))};
    process.env.OZ_AGENT_PORTS = '0';
    const assert = (await import('node:assert/strict')).default;
    const { writeFileSync } = await import('node:fs');
    const path = await import('node:path');
    const {
      newThread, runTurn, setBrainAskForTest, setClaudeRunnerForTest,
    } = await import(${JSON.stringify(path.join(root, 'lib/grokui.mjs'))});

    const bot = newThread('auto-write', null);
    bot.runMode = 'auto';
    let brainCalls = 0;
    setBrainAskForTest(() => { brainCalls += 1; return 'RUN: mkdir -p oz-auto-empty\\nDONE:'; });
    const calls = [];
    setClaudeRunnerForTest(async ({ prompt, cwd }) => {
      calls.push(prompt);
      writeFileSync(path.join(cwd, 'app.js'), 'console.log("hi")');
      return { text: 'Created app.js', sessionId: 'sess-w', error: false, paymentFailed: '' };
    });
    await runTurn(bot.id, 'write a tiny app');
    assert.equal(brainCalls, 0, 'Auto must not hit chat/completions');
    assert.equal(calls.length, 1);
    assert.match(bot.history[bot.history.length - 1].text, /Created app\\.js/);
    assert.doesNotMatch(bot.history.map((h) => h.text).join('\\n'), /\\$ mkdir/);
    assert.doesNotMatch(bot.history.map((h) => h.text).join('\\n'), /DONE:/);
    const { readFileSync, existsSync } = await import('node:fs');
    assert.equal(existsSync(path.join(${JSON.stringify(dir)}, 'app.js')), true);
    assert.match(readFileSync(path.join(${JSON.stringify(dir)}, 'app.js'), 'utf8'), /console\\.log/);
    assert.equal(bot.status, 'idle');

    console.log(JSON.stringify({ ok: true, calls: calls.length, brainCalls }));
    process.exit(0);
  `);
  const out = await runChild(script);
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, 'child printed a JSON result: ' + out);
  const r = JSON.parse(line);
  assert.equal(r.ok, true);
  assert.equal(r.calls, 1);
  assert.equal(r.brainCalls, 0);
});

test('AUTO loop stop: 500/empty/pay do not enqueue AUTO_CONTINUE; same RUN twice stops; empty PTY does not hop', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-loop-stop-'));
  const script = path.join(dir, 'run.mjs');
  const uiPort = 26000 + Math.floor(Math.random() * 2000);
  writeFileSync(script, `
    process.env.HOME = ${JSON.stringify(dir)};
    process.env.OZ_WORKSPACE_DIR = ${JSON.stringify(dir)};
    process.env.OZ_GROKUI_PORT = ${JSON.stringify(String(uiPort))};
    process.env.OZ_AGENT_PORTS = '0';
    const assert = (await import('node:assert/strict')).default;
    const {
      newThread, runTurn, setBrainAskForTest, setRunTurnForTest, setClaudeRunnerForTest,
      shouldKeepAuto, enqueueAutoHop, rememberAutoCommand, identicalCommandCapped,
      isAutoStopReply, persistUserTurn,
      AUTO_CONTINUE, AUTO_RACE_RETRY, AUTO_EMPTY_RETRY, AUTO_EMPTY_PTY_STOP, AUTO_SAME_COMMAND_STOP,
    } = await import(${JSON.stringify(path.join(root, 'lib/grokui.mjs'))});

    assert.equal(isAutoStopReply('upstream HTTP 500'), true);
    assert.equal(isAutoStopReply('(upstream error — HTTP 500, try again)'), true);
    assert.equal(isAutoStopReply(''), true);
    assert.equal(isAutoStopReply('(no response)'), true);
    assert.equal(isAutoStopReply(AUTO_EMPTY_PTY_STOP), true);
    assert.equal(isAutoStopReply('(payment failed — HTTP 402 after 3 retries)'), true);
    assert.equal(isAutoStopReply('(payment required — HTTP 402, the wallet is empty.)'), true);
    assert.equal(shouldKeepAuto({ runMode: 'auto' }, 'upstream HTTP 500'), false);
    assert.equal(shouldKeepAuto({ runMode: 'auto' }, ''), false);
    assert.equal(shouldKeepAuto({ runMode: 'auto' }, AUTO_EMPTY_PTY_STOP), false);

    const hops = [];
    setRunTurnForTest((id, text) => { hops.push(String(text || '')); return Promise.resolve(); });

    const cap = newThread('cmd-cap', null);
    cap.runMode = 'auto';
    rememberAutoCommand(cap, 'ls -la');
    rememberAutoCommand(cap, 'ls -la');
    assert.equal(identicalCommandCapped(cap), true);
    assert.equal(shouldKeepAuto(cap, '$ ls -la\\n(no output)', AUTO_EMPTY_RETRY), false);
    assert.equal(enqueueAutoHop(cap, cap.id, AUTO_EMPTY_RETRY), false);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(hops.length, 0, 'same RUN twice must not enqueue a third');

    const okHop = newThread('ok-hop', null);
    okHop.runMode = 'auto';
    assert.equal(enqueueAutoHop(okHop, okHop.id, AUTO_CONTINUE), true);
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(hops.includes(AUTO_CONTINUE), 'uncapped hop still works');
    hops.length = 0;
    setRunTurnForTest(null);

    const emptyPty = newThread('empty-pty', null);
    emptyPty.runMode = 'auto';
    const claudeEmpty = [];
    setBrainAskForTest(() => { throw new Error('empty PTY must not fall into a hop loop via chat'); });
    setClaudeRunnerForTest(async ({ prompt }) => {
      claudeEmpty.push(String(prompt || ''));
      return { text: '', error: false, paymentFailed: '' };
    });
    await runTurn(emptyPty.id, 'do work');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(claudeEmpty.length, 1, 'empty PTY must not schedule another runTurn');
    assert.ok(!claudeEmpty.some((p) => p.includes('Please continue') || p.includes('AUTO is still on') || p.includes('AUTO_EMPTY')), 'empty PTY must not send AUTO_CONTINUE');
    assert.match(emptyPty.history.map((h) => h.text).join('\\n'), /no output|Not retrying/);
    assert.equal(emptyPty.status, 'idle');
    assert.equal(emptyPty.autoStopped, true);
    assert.ok(emptyPty.messages.some((m) => m.role === 'user' && m.content === 'do work'), 'persist user before hop/stop');
    assert.ok(emptyPty.messages.some((m) => m.role === 'assistant'), 'persist assistant before hop/stop');

    const http500 = newThread('http-500', null);
    http500.runMode = 'auto';
    const claude500 = [];
    setClaudeRunnerForTest(async ({ prompt }) => {
      claude500.push(String(prompt || ''));
      return { text: 'upstream HTTP 500', error: true, paymentFailed: '' };
    });
    await runTurn(http500.id, 'do work');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(claude500.length, 1, '500 must not enqueue AUTO_CONTINUE');
    assert.ok(!claude500.some((p) => /Please continue|AUTO is still on/.test(p)));
    assert.equal(http500.status, 'idle');
    assert.equal(http500.autoStopped, true);

    const pay = newThread('pay-stop', null);
    pay.runMode = 'auto';
    const claudePay = [];
    setClaudeRunnerForTest(async ({ prompt }) => {
      claudePay.push(String(prompt || ''));
      return { text: 'API Error', error: true, paymentFailed: '(payment failed — HTTP 402 after 3 retries, though the wallet holds 12 USDC)' };
    });
    await runTurn(pay.id, 'do work');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(claudePay.length, 1, 'paymentFailed must not enqueue AUTO_CONTINUE');
    assert.match(pay.history[pay.history.length - 1].text, /payment failed|HTTP 402/);
    assert.equal(pay.status, 'idle');

    const persisted = persistUserTurn(emptyPty, 'do work');
    assert.equal(persisted.ok, true);

    console.log(JSON.stringify({
      ok: true, claudeEmpty: claudeEmpty.length, claude500: claude500.length,
      claudePay: claudePay.length, hopsAfterCap: 0,
    }));
    process.exit(0);
  `);
  const out = await runChild(script);
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, 'child printed a JSON result: ' + out);
  const r = JSON.parse(line);
  assert.equal(r.ok, true);
  assert.equal(r.claudeEmpty, 1);
  assert.equal(r.claude500, 1);
  assert.equal(r.claudePay, 1);
  assert.equal(r.hopsAfterCap, 0);
});
