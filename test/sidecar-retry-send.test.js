import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('after sidecar is back, chat retries the same send instead of parking', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-retry-send-'));
  const script = path.join(dir, 'run.mjs');
  const uiPort = 25000 + Math.floor(Math.random() * 2000);
  writeFileSync(script, `
    process.env.HOME = ${JSON.stringify(dir)};
    process.env.OZ_WORKSPACE_DIR = ${JSON.stringify(dir)};
    process.env.OZ_GROKUI_PORT = ${JSON.stringify(String(uiPort))};
    process.env.OZ_AGENT_PORTS = '0';
    const assert = (await import('node:assert/strict')).default;
    const {
      newThread, runTurn, setBrainAskForTest, SIDECAR_STARTING,
    } = await import(${JSON.stringify(path.join(root, 'lib/grokui.mjs'))});
    const t = newThread('retry-send', null);
    t.runMode = 'chat';
    let n = 0;
    setBrainAskForTest(() => {
      n += 1;
      if (n === 1) throw Object.assign(new TypeError('fetch failed'), { name: 'TypeError' });
      return 'recovered after sidecar';
    });
    await runTurn(t.id, 'hello again');
    assert.equal(n, 2, 'same send must be retried after sidecar returns');
    const bot = t.history.filter((h) => h.who === 'bot').pop();
    assert.ok(bot);
    assert.match(bot.text, /recovered after sidecar/);
    assert.doesNotMatch(bot.text, new RegExp(SIDECAR_STARTING.replace(/[…]/g, '.')));
  `);
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
