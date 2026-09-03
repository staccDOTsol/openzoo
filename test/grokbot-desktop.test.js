import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveAppName, mapImageClick, noteShotMeta, lastShot,
} from '../lib/grokbotDesktop.js';

test('resolveAppName maps aliases and passes through real titles', () => {
  assert.equal(resolveAppName('brave'), 'Brave Browser');
  assert.equal(resolveAppName('Grok'), 'Grok Bot');
  assert.equal(resolveAppName('chrome'), 'Google Chrome');
  assert.equal(resolveAppName('safari'), 'Safari');
  assert.equal(resolveAppName('finder'), 'Finder');
  assert.equal(resolveAppName(''), '');
  assert.equal(resolveAppName('  '), '');
  assert.equal(resolveAppName('Brave Browser'), 'Brave Browser');
  assert.equal(resolveAppName('Terminal'), 'Terminal');
});

test('mapImageClick scales screenshot pixels onto screen points', () => {
  const meta = { image: { width: 200, height: 100 }, screen: { width: 1000, height: 500 } };
  assert.deepEqual(mapImageClick(20, 10, meta), { x: 100, y: 50 });
  assert.equal(mapImageClick(20, 10, null), null);
  assert.equal(mapImageClick(20, 10, { image: { width: 0 }, screen: { width: 1, height: 1 } }), null);
  assert.equal(mapImageClick(20, 10, { image: { width: 10, height: 10 } }), null);
});

test('noteShotMeta remembers the last screenshot for image_x clicks', () => {
  assert.equal(noteShotMeta(null), null);
  const meta = { image: { width: 10, height: 10 }, screen: { width: 20, height: 20 } };
  assert.equal(noteShotMeta(meta), meta);
  assert.equal(lastShot(), meta);
  noteShotMeta('nope');
  assert.equal(lastShot(), null);
});
