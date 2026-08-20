import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clipStatusArg, peekDirectiveStatus, formatModelWait, formatPayStatus,
  startModelWait, readWithIdleTimeout, STREAM_IDLE_MS, STALE_THINKING_MS,
} from '../lib/livestatus.js';

test('model wait stays mute-free and gains seconds after 2s', () => {
  assert.equal(formatModelWait(0), 'waiting on model…');
  assert.equal(formatModelWait(1999), 'waiting on model…');
  assert.equal(formatModelWait(2000), 'waiting on model… 2s');
  assert.equal(formatModelWait(8000), 'waiting on model… 8s');
  assert.equal(formatModelWait(12000), 'waiting on model… 12s');
});

test('402 retry copy distinguishes first pay from later x402 waits', () => {
  assert.equal(formatPayStatus(0), 'paying…');
  assert.equal(formatPayStatus(1), 'waiting on x402…');
  assert.equal(formatPayStatus(2), 'waiting on x402…');
});

test('directive trail is current tool + short arg, not the whole body', () => {
  assert.equal(peekDirectiveStatus('READ: src/app.js'), 'READ: src/app.js');
  assert.equal(peekDirectiveStatus('SPAWN: seeker-ui | build the settings panel'), 'SPAWN: seeker-ui | build the settings panel');
  assert.equal(peekDirectiveStatus('', 'npm install express'), 'RUN: npm install express');
  assert.equal(peekDirectiveStatus('LS: src'), 'GLOB: src');
  const long = peekDirectiveStatus(`RUN: ${'x'.repeat(80)}`);
  assert.ok(long.startsWith('RUN: '));
  assert.ok(long.endsWith('…'));
  assert.ok(long.length < 60);
});

test('clipStatusArg collapses whitespace and ellipsizes', () => {
  assert.equal(clipStatusArg('  foo   bar  '), 'foo bar');
  assert.equal(clipStatusArg('abcdefghij', 6), 'abcde…');
});

test('startModelWait mutates one line and stop() ends ticks', async () => {
  const seen = [];
  let t = 0;
  const stop = startModelWait((s) => seen.push(s), () => t);
  assert.deepEqual(seen, ['waiting on model…']);
  t = 8000;
  await new Promise((r) => setTimeout(r, 1100));
  stop();
  const n = seen.length;
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(seen.length, n);
  assert.ok(seen.some((s) => s.includes('8s')));
});

test('a quiet reader fails STREAM_IDLE so the UI cannot sit on … forever', async () => {
  const reader = { read: () => new Promise(() => {}) };
  await assert.rejects(
    () => readWithIdleTimeout(reader, 30),
    (e) => e.code === 'STREAM_IDLE',
  );
});

test('idle / stale windows stay in the hang-timeout band', () => {
  assert.ok(STREAM_IDLE_MS >= 45_000 && STREAM_IDLE_MS <= 60_000);
  assert.ok(STALE_THINKING_MS >= STREAM_IDLE_MS);
});
