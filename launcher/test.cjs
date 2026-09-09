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
