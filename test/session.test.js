import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSessionSpend, saveSessionSpend, sessionSpendFile } from '../lib/session.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oz-session-')), 'session.json');
}

test('session spend file lives under ~/.openzoo', () => {
  assert.match(sessionSpendFile('/home/you'), /\/\.openzoo\/session\.json$/);
});

test('missing or corrupt session spend is a cold zero, not a throw', () => {
  const missing = loadSessionSpend(path.join(os.tmpdir(), 'oz-no-such-session.json'));
  assert.equal(missing.ok, false);
  assert.equal(missing.spentUsd, 0);
  assert.equal(missing.paidCalls, 0);

  const file = tmpFile();
  fs.writeFileSync(file, '{not json');
  const corrupt = loadSessionSpend(file);
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.reason, 'corrupt');
  assert.equal(corrupt.directUsd, 0);
});

test('session spend survives a rewrite the way a proxy restart must', () => {
  const file = tmpFile();
  assert.equal(saveSessionSpend({
    spentUsd: 11.0042,
    cogsUsd: 3.668,
    directUsd: 48.2,
    paidCalls: 143,
  }, file), true);
  const loaded = loadSessionSpend(file);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.spentUsd, 11.0042);
  assert.equal(loaded.cogsUsd, 3.668);
  assert.equal(loaded.directUsd, 48.2);
  assert.equal(loaded.paidCalls, 143);
});

test('negative or garbage counters do not poison the HUD', () => {
  const file = tmpFile();
  saveSessionSpend({ spentUsd: -4, cogsUsd: 'nope', directUsd: null, paidCalls: 2.9 }, file);
  const loaded = loadSessionSpend(file);
  assert.equal(loaded.spentUsd, 0);
  assert.equal(loaded.cogsUsd, 0);
  assert.equal(loaded.directUsd, 0);
  assert.equal(loaded.paidCalls, 2);
});
