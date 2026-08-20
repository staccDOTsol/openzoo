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
    assert.equal(isEmptyToolResult('(command output)\\n(no output)'), true);

    const skipPty = newThread('skip-pty-first', null);
    skipPty.runMode = 'auto';
    let skipClaude = 0;
    setClaudeRunnerForTest(async () => { skipClaude += 1; return { text: 'pty should skip' }; });
    setBrainAskForTest(() => 'visible from chat');
    await runTurn(skipPty.id, 'hi first');
    assert.equal(skipClaude, 0, 'first Auto send skips PTY until a visible reply exists');
    assert.equal(skipPty.history.filter((h) => h.who === 'bot').pop().text, 'visible from chat');
    assert.equal(skipPty.status, 'idle');

    const auto = newThread('auto-keep', null);
    auto.runMode = 'auto';
    auto.history.push({ who: 'bot', text: 'prior visible reply' });
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
    payBot.history.push({ who: 'bot', text: 'prior visible reply' });
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
    errBot.history.push({ who: 'bot', text: 'prior visible reply' });
    const errPainted = [];
    setBrainAskForTest(() => 'recovered via chat');
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
    const errUsers = errBot.history.filter((h) => h.who === 'user');
    assert.equal(errUsers.length, 1);
    assert.equal(errUsers[0].text, 'do work');
    assert.equal(errBot.history[errBot.history.length - 1].who, 'bot');
    assert.equal(errBot.history[errBot.history.length - 1].text, 'recovered via chat');
    assert.doesNotMatch(errBot.history.map((h) => h.text).join('\\n'), /gzip-body|API Error|\\uFFFD|upstream HTTP|\\(no response\\)/);
    assert.ok(errPainted.some((e) => e.type === 'think'));
    assert.ok(errPainted.some((e) => e.type === 'tool' && /Read secret\\.bin/.test(e.detail)));
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
    bot.history.push({ who: 'bot', text: 'prior visible reply' });
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

test('user message is on disk before the model call; 500 does not rewrite it as AUTO continue', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-persist-'));
  const script = path.join(dir, 'run.mjs');
  const uiPort = 26000 + Math.floor(Math.random() * 2000);
  writeFileSync(script, `
    process.env.HOME = ${JSON.stringify(dir)};
    process.env.OZ_WORKSPACE_DIR = ${JSON.stringify(dir)};
    process.env.OZ_GROKUI_PORT = ${JSON.stringify(String(uiPort))};
    process.env.OZ_AGENT_PORTS = '0';
    const assert = (await import('node:assert/strict')).default;
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const {
      newThread, runTurn, persistUserTurn, visibleHistory, isHarnessUserText,
      AUTO_RACE_RETRY, AUTO_CONTINUE, setBrainAskForTest, setClaudeRunnerForTest,
      isClaudeFallbackReply,
    } = await import(${JSON.stringify(path.join(root, 'lib/grokui.mjs'))});

    const store = path.join(${JSON.stringify(dir)}, '.openzoo', 'grokui-threads.json');
    const uiPort = ${uiPort};
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch('http://127.0.0.1:' + uiPort + '/threads');
        if (r.ok) { ready = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!ready) { console.error('grokui did not start'); process.exit(1); }

    assert.equal(isHarnessUserText(AUTO_RACE_RETRY), true);
    assert.equal(isHarnessUserText(AUTO_CONTINUE), true);
    assert.equal(isHarnessUserText('ship the tetris contract'), false);
    const hidden = visibleHistory([
      { who: 'user', text: 'keep me' },
      { who: 'user', text: AUTO_RACE_RETRY },
      { who: 'user', text: AUTO_CONTINUE },
      { who: 'bot', text: 'error: upstream HTTP 500' },
    ]);
    assert.deepEqual(hidden.map((h) => h.text), ['keep me', 'error: upstream HTTP 500']);

    const ask = newThread('persist-ask', null);
    persistUserTurn(ask, 'hello from disk');
    const disk1 = JSON.parse(readFileSync(store, 'utf8'));
    const savedAsk = disk1.find((t) => t.id === ask.id);
    assert.equal(savedAsk.history[0].who, 'user');
    assert.equal(savedAsk.history[0].text, 'hello from disk');

    let releaseHang;
    const hung = new Promise((resolve) => { releaseHang = resolve; });
    setBrainAskForTest(() => hung);
    const hanging = newThread('hang-ask', null);
    const turnP = runTurn(hanging.id, 'remember this ask');
    assert.equal(hanging.history[0].text, 'remember this ask');
    const diskHang = JSON.parse(readFileSync(store, 'utf8'));
    const savedHang = diskHang.find((t) => t.id === hanging.id);
    assert.equal(savedHang.history[0].text, 'remember this ask');
    releaseHang('ok from model');
    await turnP;

    setBrainAskForTest(() => 'ok from chat after empty pty');
    setClaudeRunnerForTest(async () => {
      return { text: '', error: 'upstream HTTP 500', paymentFailed: '', sessionId: '' };
    });
    const auto = newThread('persist-auto', null);
    auto.runMode = 'auto';
    auto.history.push({ who: 'bot', text: 'prior visible reply' });
    await runTurn(auto.id, 'do the job even if 500');
    const userTurns = auto.history.filter((h) => h.who === 'user');
    assert.equal(userTurns.length, 1);
    assert.equal(userTurns[0].text, 'do the job even if 500');
    assert.equal(userTurns.some((h) => h.text === AUTO_RACE_RETRY || h.text === AUTO_CONTINUE), false);
    const vis = visibleHistory(auto.history);
    assert.equal(vis.some((h) => h.who === 'user' && h.text === 'do the job even if 500'), true);
    assert.equal(vis.some((h) => isHarnessUserText(h.text)), false);
    assert.ok((auto.messages || []).some((m) => m.role === 'user' && m.content === 'do the job even if 500'));
    assert.equal(auto.history[auto.history.length - 1].who, 'bot');
    assert.equal(auto.history[auto.history.length - 1].text, 'ok from chat after empty pty');
    assert.doesNotMatch(auto.history.map((h) => h.text).join('\\n'), /\\(no response\\)|upstream HTTP/);
    assert.equal(auto.status, 'idle');

    let autoEntered = false;
    let releaseAuto;
    const autoHang = new Promise((resolve) => { releaseAuto = resolve; });
    setClaudeRunnerForTest(() => {
      autoEntered = true;
      const live = JSON.parse(readFileSync(store, 'utf8')).find((x) => x.id === autoHangThread.id);
      const liveUsers = (live.history || []).filter((h) => h.who === 'user');
      assert.equal(liveUsers[0].text, 'keep me through pty spawn');
      assert.ok((live.messages || []).some((m) => m.role === 'user' && String(m.content).includes('keep me through pty spawn')));
      assert.equal(live.history.some((h) => h.text === AUTO_RACE_RETRY || h.text === AUTO_CONTINUE), false);
      return autoHang.then(() => ({ text: 'claude later', sessionId: 'sess-auto' }));
    });
    const autoHangThread = newThread('auto-hang', null);
    autoHangThread.runMode = 'auto';
    autoHangThread.history.push({ who: 'bot', text: 'prior visible reply' });
    const autoP = runTurn(autoHangThread.id, 'keep me through pty spawn');
    await Promise.resolve();
    assert.equal(autoEntered, true);
    assert.ok(autoHangThread.history.some((h) => h.who === 'user' && h.text === 'keep me through pty spawn'));
    const diskAuto = JSON.parse(readFileSync(store, 'utf8')).find((x) => x.id === autoHangThread.id);
    assert.ok(diskAuto.history.some((h) => h.who === 'user' && h.text === 'keep me through pty spawn'));
    releaseAuto();
    await autoP;
    const afterHop = autoHangThread.history.filter((h) => h.who === 'user');
    assert.equal(afterHop.length, 1);
    assert.equal(afterHop[0].text, 'keep me through pty spawn');

    await runTurn(autoHangThread.id, AUTO_CONTINUE);
    const stillUsers = autoHangThread.history.filter((h) => h.who === 'user');
    assert.equal(stillUsers.length, 1);
    assert.equal(stillUsers[0].text, 'keep me through pty spawn');

    const autoPin = newThread('auto-pin', null);
    autoPin.runMode = 'auto';
    autoPin.model = 'openzoo/auto';
    autoPin.history.push({ who: 'bot', text: 'prior visible reply' });
    let seenModel = 'UNSET';
    setClaudeRunnerForTest(async ({ model }) => {
      seenModel = model;
      assert.ok(autoPin.history.some((h) => h.who === 'user' && h.text === 'hello auto picker'));
      assert.ok((autoPin.messages || []).some((m) => m.role === 'user' && m.content === 'hello auto picker'));
      const diskPin = JSON.parse(readFileSync(store, 'utf8')).find((x) => x.id === autoPin.id);
      assert.ok(diskPin.history.some((h) => h.who === 'user' && h.text === 'hello auto picker'));
      return { text: 'ok', sessionId: 'sess-pin' };
    });
    await runTurn(autoPin.id, 'hello auto picker');
    assert.equal(seenModel, undefined, 'never pass openzoo/auto as Claude --model');
    assert.equal(autoPin.history.filter((h) => h.who === 'user').length, 1);

    const listed = await (await fetch('http://127.0.0.1:' + uiPort + '/threads', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'drive-persist' }),
    })).json();
    let releaseDrive;
    setBrainAskForTest(() => new Promise((resolve) => { releaseDrive = resolve; }));
    const driveRes = await fetch('http://127.0.0.1:' + uiPort + '/drive', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: listed.id, task: 'from the composer' }),
    });
    const driveBody = await driveRes.json();
    assert.equal(driveRes.ok, true);
    assert.equal(driveBody.persisted, true);
    const afterDrive = await (await fetch('http://127.0.0.1:' + uiPort + '/threads/' + listed.id)).json();
    assert.equal(afterDrive.history[0].who, 'user');
    assert.equal(afterDrive.history[0].text, 'from the composer');
    const diskDrive = JSON.parse(readFileSync(store, 'utf8'));
    const savedDrive = diskDrive.find((t) => t.id === listed.id);
    assert.equal(savedDrive.history[0].text, 'from the composer');
    releaseDrive('later');

    setBrainAskForTest(() => 'ok');
    const hop = newThread('hop-hidden', null);
    hop.history.push({ who: 'user', text: 'original ask' });
    await runTurn(hop.id, AUTO_RACE_RETRY);
    const hopUsers = hop.history.filter((h) => h.who === 'user');
    assert.equal(hopUsers.length, 1);
    assert.equal(hopUsers[0].text, 'original ask');
    const hopGet = await (await fetch('http://127.0.0.1:' + uiPort + '/threads/' + hop.id)).json();
    assert.equal(hopGet.history.some((h) => h.text === AUTO_RACE_RETRY), false);

    assert.equal(isClaudeFallbackReply(''), true);
    assert.equal(isClaudeFallbackReply('(no response)'), true);
    assert.equal(isClaudeFallbackReply('upstream HTTP 400'), true);
    assert.equal(isClaudeFallbackReply('upstream HTTP 502'), true);
    assert.equal(isClaudeFallbackReply('error: upstream HTTP 500'), true);
    assert.equal(isClaudeFallbackReply('Wrote hello.txt'), false);
    assert.equal(isClaudeFallbackReply('(payment required — HTTP 402, the wallet is empty.)'), false);

    const emptyCases = [
      { text: '', error: false },
      { text: '(no response)', error: false },
      { text: 'upstream HTTP 400', error: true },
      { text: 'API Error: 400 ' + '\\uFFFD'.repeat(12), error: true },
    ];
    for (const [i, ret] of emptyCases.entries()) {
      const asks = [];
      setBrainAskForTest(({ userText }) => {
        asks.push(String(userText || ''));
        return 'hi from ask/auto';
      });
      setClaudeRunnerForTest(async () => ({
        text: ret.text, error: ret.error, paymentFailed: '', sessionId: 'sess-empty-' + i,
      }));
      const quiet = newThread('pty-quiet-' + i, null);
      quiet.runMode = 'auto';
      quiet.model = 'openzoo/auto';
      quiet.history.push({ who: 'bot', text: 'prior visible reply' });
      await runTurn(quiet.id, 'hi');
      assert.equal(asks.length, 1, 'empty Claude must fall through to chat-completions: ' + JSON.stringify(ret));
      assert.equal(asks[0], 'hi');
      const users = quiet.history.filter((h) => h.who === 'user');
      assert.equal(users.length, 1, 'must not idle with two user his');
      assert.equal(users[0].text, 'hi');
      const bots = quiet.history.filter((h) => h.who === 'bot');
      assert.equal(bots[bots.length - 1].text, 'hi from ask/auto');
      assert.doesNotMatch(quiet.history.map((h) => h.text).join('\\n'), /\\(no response\\)|upstream HTTP/);
      assert.equal(quiet.status, 'idle');
    }

    let skipClaude = 0;
    setClaudeRunnerForTest(async () => { skipClaude += 1; return { text: 'pty skipped' }; });
    setBrainAskForTest(() => 'skip pty until visible reply');
    const freshAuto = newThread('skip-pty-persist', null);
    freshAuto.runMode = 'auto';
    await runTurn(freshAuto.id, 'hi');
    assert.equal(skipClaude, 0, 'empty-history Auto skips PTY');
    assert.equal(freshAuto.history.filter((h) => h.who === 'user').length, 1);
    assert.equal(freshAuto.history.filter((h) => h.who === 'bot').pop().text, 'skip pty until visible reply');
    assert.equal(freshAuto.status, 'idle');

    let askClaude = 0;
    setClaudeRunnerForTest(async () => {
      askClaude += 1;
      throw new Error('Ask/Auto must not spawn Claude');
    });
    setBrainAskForTest(() => 'ask stays on chat');
    const askStay = newThread('ask-untouched', null);
    askStay.runMode = 'ask';
    askStay.model = 'openzoo/auto';
    await runTurn(askStay.id, 'hi from ask');
    assert.equal(askClaude, 0);
    assert.equal(askStay.history.filter((h) => h.who === 'user').length, 1);
    assert.equal(askStay.history[askStay.history.length - 1].text, 'ask stays on chat');
    assert.equal(askStay.status, 'idle');

    console.log(JSON.stringify({ ok: true }));
    process.exit(0);
  `);
  const out = await runChild(script);
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, 'child printed a JSON result: ' + out);
  const r = JSON.parse(line);
  assert.equal(r.ok, true);
});
