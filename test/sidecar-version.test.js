import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { cmpSemver, sidecarIsAttachable } = require(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'grokui-app', 'sidecar-version.js'),
);

test('cmpSemver compares major.minor.patch', () => {
  assert.equal(cmpSemver('0.49.5', '0.49.5'), 0);
  assert.equal(cmpSemver('0.49.5', '0.49.3'), 1);
  assert.equal(cmpSemver('0.49.3', '0.49.5'), -1);
  assert.equal(cmpSemver('1.0.0', '0.49.5'), 1);
  assert.equal(cmpSemver('not-a-version', '0.49.5'), null);
  assert.equal(cmpSemver(undefined, '0.49.5'), null);
});

test('sidecarIsAttachable reuses same-or-newer and refuses older or missing', () => {
  assert.equal(sidecarIsAttachable({ listenerVersion: '0.49.5', expectedVersion: '0.49.5' }), true);
  assert.equal(sidecarIsAttachable({ listenerVersion: '0.49.6', expectedVersion: '0.49.5' }), true);
  assert.equal(sidecarIsAttachable({ listenerVersion: '0.50.0', expectedVersion: '0.49.5' }), true);
  assert.equal(sidecarIsAttachable({ listenerVersion: '0.49.3', expectedVersion: '0.49.5' }), false);
  assert.equal(sidecarIsAttachable({ listenerVersion: undefined, expectedVersion: '0.49.5' }), false);
  assert.equal(sidecarIsAttachable({ listenerVersion: '', expectedVersion: '0.49.5' }), false);
  assert.equal(sidecarIsAttachable({ expectedVersion: '0.49.5' }), false);
});
