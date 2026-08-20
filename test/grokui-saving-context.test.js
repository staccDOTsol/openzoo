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
      reject(new Error('saving-context child timed out: ' + buf));
    }, 25000);
    child.on('exit', (code) => {
      clearTimeout(t);
      if (code !== 0) reject(new Error('saving-context child exited ' + code + ': ' + buf));
      else resolve(buf);
    });
  });
}

test('formatSavingLabel prefers spilled x and labels spilled vs session', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-saving-label-'));
  const script = path.join(dir, 'run.mjs');
  const uiPort = 23000 + Math.floor(Math.random() * 2000);
  writeFileSync(script, `
    process.env.HOME = ${JSON.stringify(dir)};
    process.env.OZ_GROKUI_PORT = ${JSON.stringify(String(uiPort))};
    process.env.OZ_AGENT_PORTS = '0';
    const assert = (await import('node:assert/strict')).default;
    const { formatSavingLabel } = await import(${JSON.stringify(path.join(root, 'lib/grokui.mjs'))});

    const none = formatSavingLabel({ spentUsd: 0, directUsd: 2 });
    assert.equal(none.text, '—');
    assert.equal(none.mult, null);

    const session = formatSavingLabel({ spentUsd: 1, directUsd: 2.1 });
    assert.equal(session.spilled, false);
    assert.equal(session.text, '2.10x session');
    assert.ok(session.mult > 2 && session.mult < 2.2);

    const spilled = formatSavingLabel({
      spentUsd: 1, directUsd: 2.1, spilled: { savingX: 8.5 },
    });
    assert.equal(spilled.spilled, true);
    assert.equal(spilled.text, '8.50x spilled');
    assert.equal(spilled.mult, 8.5);

    const ignoredZero = formatSavingLabel({
      spentUsd: 1, directUsd: 2.1, spilled: { savingX: 0 },
    });
    assert.equal(ignoredZero.text, '2.10x session');

    const ignoredNan = formatSavingLabel({
      spentUsd: 1, directUsd: 2.1, spilled: { savingX: 'nope' },
    });
    assert.equal(ignoredNan.text, '2.10x session');

    const big = formatSavingLabel({ spentUsd: 1, directUsd: 150, spilled: { savingX: 150 } });
    assert.equal(big.text, '150x spilled');

    const mid = formatSavingLabel({ spentUsd: 1, directUsd: 12.34 });
    assert.equal(mid.text, '12.3x session');

    const under = formatSavingLabel({ spentUsd: 2, directUsd: 1 });
    assert.equal(under.text, '0.50x session');
    assert.ok(under.mult < 1);

    console.log(JSON.stringify({ ok: true }));
    process.exit(0);
  `);
  const out = await runChild(script);
  assert.match(out, /"ok":true/);
});

test('/cost prefers spilled x and labels spilled vs session', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-cost-label-'));
  const script = path.join(dir, 'run.mjs');
  const uiPort = 23200 + Math.floor(Math.random() * 2000);
  writeFileSync(script, `
    process.env.HOME = ${JSON.stringify(dir)};
    process.env.OZ_GROKUI_PORT = ${JSON.stringify(String(uiPort))};
    process.env.OZ_AGENT_PORTS = '0';
    const assert = (await import('node:assert/strict')).default;
    const { handleSlash, newThread } = await import(${JSON.stringify(path.join(root, 'lib/grokui.mjs'))});

    const orig = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/session')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            spentUsd: 1, cogsUsd: 0.4, directUsd: 2.1, paidCalls: 3,
            spilled: { savingX: 8.5 },
          }),
        };
      }
      return orig(url);
    };
    const t = newThread('cost-bot', null);
    const spilled = await handleSlash('/cost', t);
    assert.match(spilled, /8\\.50x spilled/);
    assert.doesNotMatch(spilled, /2\\.10x session/);

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/session')) {
        return {
          ok: true, status: 200,
          json: async () => ({ spentUsd: 1, cogsUsd: 0.4, directUsd: 2.1, paidCalls: 3 }),
        };
      }
      if (u.includes('/info')) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return orig(url);
    };
    const session = await handleSlash('/cost', t);
    assert.match(session, /2\\.10x session/);
    assert.doesNotMatch(session, /spilled/);

    console.log(JSON.stringify({ ok: true }));
    process.exit(0);
  `);
  const out = await runChild(script);
  assert.match(out, /"ok":true/);
});

test('/pay and /hud echo short lines, not wallet JSON', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-pay-hud-echo-'));
  const script = path.join(dir, 'run.mjs');
  const uiPort = 23600 + Math.floor(Math.random() * 2000);
  writeFileSync(script, `
    process.env.HOME = ${JSON.stringify(dir)};
    process.env.OZ_GROKUI_PORT = ${JSON.stringify(String(uiPort))};
    process.env.OZ_AGENT_PORTS = '0';
    const assert = (await import('node:assert/strict')).default;
    const { handleSlash, newThread } = await import(${JSON.stringify(path.join(root, 'lib/grokui.mjs'))});

    const orig = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/session')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            spentUsd: 1.25, cogsUsd: 0.4, directUsd: 2.5, paidCalls: 4,
            spilled: { savingX: 3.5 },
          }),
        };
      }
      return orig(url);
    };
    const t = newThread('echo-bot', null);
    t.runMode = 'ask';
    t.tier = 'cheap';
    const pay = await handleSlash('/pay', t);
    assert.match(pay, /Pay — card checkout/);
    assert.doesNotMatch(pay, /solana/i);
    assert.doesNotMatch(pay, /\\{/);

    const hud = await handleSlash('/hud', t);
    assert.match(hud, /Sitrep — mode ask · cheap/);
    assert.match(hud, /paid \\$1\\.25/);
    assert.match(hud, /3\\.50x spilled/);
    assert.match(hud, /4 calls/);
    assert.doesNotMatch(hud, /\\{/);
    assert.doesNotMatch(hud, /spentUsd/);

    console.log(JSON.stringify({ ok: true }));
    process.exit(0);
  `);
  const out = await runChild(script);
  assert.match(out, /"ok":true/);
});

test('new chat does not reuse another root contextId; SPAWN kids still share', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-newchat-ctx-'));
  const ws = path.join(dir, 'workspace');
  mkdirSync(ws);
  const script = path.join(dir, 'run.mjs');
  const uiPort = 23400 + Math.floor(Math.random() * 2000);
  writeFileSync(script, `
    process.env.HOME = ${JSON.stringify(dir)};
    process.env.OZ_WORKSPACE_DIR = ${JSON.stringify(ws)};
    process.env.OZ_GROKUI_PORT = ${JSON.stringify(String(uiPort))};
    process.env.OZ_AGENT_PORTS = '0';
    const assert = (await import('node:assert/strict')).default;
    const fs = await import('node:fs');
    const path = await import('node:path');
    const {
      newThread, holobrainOf, scheduleFilesForCorpus, filesForCorpus,
      resetFilesForCorpus, noteFileForCorpus,
    } = await import(${JSON.stringify(path.join(root, 'lib/grokui.mjs'))});

    const proj = newThread('openzoo', null);
    proj.contextId = 'ctx-proj';
    proj.boundItems = 40;
    assert.equal(holobrainOf(proj).id, proj.id);
    assert.equal(holobrainOf(proj).contextId, 'ctx-proj');

    const chat = newThread('fresh-chat', null);
    assert.equal(chat.parent, null);
    assert.equal(chat.contextId, undefined);
    assert.equal(chat.boundItems, undefined);
    assert.equal(holobrainOf(chat).id, chat.id);
    assert.notEqual(holobrainOf(chat).contextId, 'ctx-proj');
    assert.equal(holobrainOf(chat).boundItems, undefined);

    const kid = newThread('spawn-kid', proj.id);
    assert.equal(kid.contextId, undefined, 'new SPAWN kid is not pre-copied');
    assert.equal(holobrainOf(kid).id, proj.id);
    assert.equal(holobrainOf(kid).contextId, 'ctx-proj');
    assert.equal(holobrainOf(kid).boundItems, 40);
    assert.equal(proj.contextId, 'ctx-proj', 'existing bind must stay');
    assert.equal(proj.boundItems, 40);

    resetFilesForCorpus();
    const notes = path.join(${JSON.stringify(ws)}, 'notes.txt');
    fs.writeFileSync(notes, 'NEWCHAT_CORPUS');
    chat.dir = ${JSON.stringify(ws)};
    const collected = filesForCorpus(notes, { cwd: ${JSON.stringify(ws)} });
    const binds = [];
    const job = scheduleFilesForCorpus(chat, collected, {
      defer: false,
      sentChars: 12,
      fetchImpl: async (url, opts) => {
        binds.push(JSON.parse(opts.body));
        return {
          ok: true, status: 200,
          json: async () => ({ context_id: 'ctx-fresh', bound: 1 }),
        };
      },
    });
    assert.ok(job);
    await job.promise;
    assert.equal(binds[0].context_id, undefined, 'new chat must not send the project contextId');
    assert.equal(chat.contextId, 'ctx-fresh');
    assert.equal(proj.contextId, 'ctx-proj');
    assert.equal(proj.boundItems, 40);

    resetFilesForCorpus();
    const collected2 = filesForCorpus(notes, { cwd: ${JSON.stringify(ws)} });
    const kidBinds = [];
    kid.dir = ${JSON.stringify(ws)};
    const kidJob = scheduleFilesForCorpus(kid, collected2, {
      defer: false,
      sentChars: 12,
      fetchImpl: async (url, opts) => {
        kidBinds.push(JSON.parse(opts.body));
        return {
          ok: true, status: 200,
          json: async () => ({ context_id: 'ctx-proj', bound: 2 }),
        };
      },
    });
    assert.ok(kidJob);
    await kidJob.promise;
    assert.equal(kidBinds[0].context_id, 'ctx-proj', 'SPAWN kid still shares the parent holobrain');
    assert.equal(proj.contextId, 'ctx-proj');

    console.log(JSON.stringify({ ok: true, chatId: chat.id, projId: proj.id }));
    process.exit(0);
  `);
  const out = await runChild(script);
  assert.match(out, /"ok":true/);
});

test('looksLikeProxyShell bans :8402 / local completions, not site curls', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-proxy-shell-'));
  const script = path.join(dir, 'run.mjs');
  const uiPort = 23600 + Math.floor(Math.random() * 2000);
  writeFileSync(script, `
    process.env.HOME = ${JSON.stringify(dir)};
    process.env.OZ_GROKUI_PORT = ${JSON.stringify(String(uiPort))};
    process.env.OZ_AGENT_PORTS = '0';
    const assert = (await import('node:assert/strict')).default;
    const { looksLikeProxyShell, CHAT_NOT_PROXY, PROXY_SHELL_REFUSE } = await import(${JSON.stringify(path.join(root, 'lib/grokui.mjs'))});

    assert.match(CHAT_NOT_PROXY, /already ARE the chat/);
    assert.match(PROXY_SHELL_REFUSE, /already ARE the chat/);

    assert.equal(looksLikeProxyShell('curl http://localhost:8402/v1/chat/completions'), true);
    assert.equal(looksLikeProxyShell('curl -s http://127.0.0.1:8402/v1/models'), true);
    assert.equal(looksLikeProxyShell('wget http://localhost:8402/v1/chat/completions -O -'), true);
    assert.equal(looksLikeProxyShell("fetch('http://localhost:8402/v1/chat/completions')"), true);
    assert.equal(looksLikeProxyShell('curl -s localhost:8080/site/ | head -20'), false);
    assert.equal(looksLikeProxyShell('curl -s http://127.0.0.1:8080/'), false);
    assert.equal(looksLikeProxyShell('ls -la'), false);
    assert.equal(looksLikeProxyShell('mkdir -p src/components'), false);

    console.log(JSON.stringify({ ok: true }));
    process.exit(0);
  `);
  const out = await runChild(script);
  assert.match(out, /"ok":true/);
});
