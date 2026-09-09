import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatGptSpendState, chatGptSpendSource, isChatGptRenderer, readChatGptDebugPort, watchChatGptSpend, claimSpendWatcher } from '../lib/chatgpt-spend.js';
import { setupChatGpt } from '../lib/chatgpt.js';

const temp = t => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-pill-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; };
const info = (spendUsd, directUsd) => ({ youAreTalkingTo: 'openzoo proxy', spendUsd, directUsd });

test('savings use actual spend and counterfactual, including negative savings', () => {
  assert.equal(chatGptSpendState(info(2, 8)).saved, 6);
  assert.equal(chatGptSpendState(info(2, 8)).pct, 75);
  assert.equal(chatGptSpendState({ ...info(8, 2), savedUsd: 0 }).saved, -6);
  assert.equal(chatGptSpendState(info(2, null)).saved, null);
  assert.equal(chatGptSpendState(info(2, 0)).would, null);
  assert.equal(chatGptSpendState(info(null, 1)).spent, null);
  assert.equal(chatGptSpendState(info(0, 0)).saved, 0);
  assert.throws(() => chatGptSpendState({}), /not an OpenZoo/);
});

test('renderer payload parses and cannot terminate a script with snapshot data', () => {
  const source = chatGptSpendSource({ ...chatGptSpendState(info(1, 2)), scope: '</script>' });
  assert.doesNotThrow(() => new Function(source));
  assert.ok(!source.includes('</script>'));
});

test('only local desktop page targets on the selected debug port are eligible', () => {
  const page = { type: 'page', url: 'file:///app/webview/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1' };
  assert.ok(isChatGptRenderer(page, 9222));
  assert.ok(!isChatGptRenderer({ ...page, url: 'https://chatgpt.com/' }, 9222));
  assert.ok(!isChatGptRenderer({ ...page, type: 'worker' }, 9222));
  assert.ok(!isChatGptRenderer(page, 9223));
  assert.ok(!isChatGptRenderer({ ...page, webSocketDebuggerUrl: 'ws://example.com:9222/x' }, 9222));
});

test('watcher uses host-side stats and one connection, survives proxy failure and reconnects after reload errors', async (t) => {
  const profile = temp(t);
  fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), '9222\n/devtools/browser/x');
  assert.equal(readChatGptDebugPort(profile), 9222);
  let tick = 0, connected = 0, closed = 0;
  const snapshots = [];
  await watchChatGptSpend({ profile, proxyPort: 8402, stopped: () => tick >= 3, sleep: async () => { tick++; }, log: () => {},
    fetchImpl: async url => {
      if (url.includes('/json')) return { ok: true, json: async () => [{ type: 'page', url: 'file:///app/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/x' }] };
      if (tick === 1) throw new Error('offline');
      return { ok: true, json: async () => info(2 + tick, 8) };
    },
    connect: async (_url, options) => {
      connected++; assert.equal(options.sendOrigin, false);
      return { close: () => { closed++; }, send: async (method, { expression }) => {
        assert.equal(method, 'Runtime.evaluate');
        snapshots.push(expression);
        return {};
      } };
    },
  });
  assert.equal(connected, 1); assert.equal(closed, 1);
  assert.match(snapshots[1], /"online":false/);
  assert.match(snapshots[2], /"spent":4/);
});

test('watcher stops when the desktop closes', async (t) => {
  let slept = 0;
  await watchChatGptSpend({ profile: temp(t), proxyPort: 8402, sleep: async () => { slept++; }, log: () => {}, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(slept, 20);
});

test('watcher lock prevents duplicate injectors and releases cleanly', t => {
  const p = temp(t), release = claimSpendWatcher(p);
  assert.equal(typeof release, 'function');
  assert.equal(claimSpendWatcher(p), null);
  release();
  const again = claimSpendWatcher(p); assert.equal(typeof again, 'function'); again();
});

test('chatgpt launch enables a loopback debug port and overlay, --no-pill opts out', async t => {
  let launched, overlays = 0;
  const deps = { home: temp(t), env: {}, resolve: () => '/fake/app',
    launch: async (_app, args) => { launched = args; }, overlay: async () => { overlays++; } };
  await setupChatGpt(['--no-proxy'], deps);
  assert.ok(launched.includes('--remote-debugging-port=0'));
  assert.ok(launched.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(!launched.some(a => /ignore-certificate|remote-allow-origins/.test(a)));
  assert.equal(overlays, 1);
  await setupChatGpt(['--no-proxy', '--no-pill'], deps);
  assert.deepEqual(launched, []); assert.equal(overlays, 1);
});
