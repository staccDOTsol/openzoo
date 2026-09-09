const { test } = require('node:test');
const assert = require('node:assert/strict');
const { newer, environment } = require('./runtime.cjs');
test('stable updates never downgrade or accept shell-like versions', () => {
  assert.equal(newer('0.52.0', '0.51.7'), true);
  for (const v of ['0.51.7', '0.51.6', '0.51.8-beta.1', 'latest;echo bad']) assert.equal(newer(v, '0.51.7'), false);
});
test('child apps do not inherit Electron Node mode', () => {
  process.env.ELECTRON_RUN_AS_NODE = '1';
  assert.equal(environment('/runtime/node').ELECTRON_RUN_AS_NODE, undefined);
  delete process.env.ELECTRON_RUN_AS_NODE;
});
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveCLI } = require('./runtime.cjs');
test('offline launch selects newest complete cached CLI and skips incomplete updates', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openzoo-launcher-test-'));
  const originalFetch = global.fetch;
  try {
    const bundle = path.join(dir, 'bundle'), data = path.join(dir, 'data');
    for (const [base, version] of [[path.join(bundle, 'sidecar'), '0.51.6'], [path.join(data, 'versions/0.52.0'), '0.52.0']]) {
      await fs.mkdir(path.join(base, 'node_modules/openzoo'), { recursive: true });
      await fs.writeFile(path.join(base, 'node_modules/openzoo/package.json'), JSON.stringify({ version }));
    }
    await fs.mkdir(path.join(data, 'versions/0.99.0'), { recursive: true });
    global.fetch = async () => { throw new Error('offline'); };
    const logs = [];
    const result = await resolveCLI(bundle, data, s => logs.push(s));
    assert.equal(result.cli, path.join(data, 'versions/0.52.0/node_modules/openzoo/bin/openzoo.js'));
    assert.match(logs.join(''), /Update unavailable.*0.52.0/);
  } finally { global.fetch = originalFetch; await fs.rm(dir, { recursive: true, force: true }); }
});
