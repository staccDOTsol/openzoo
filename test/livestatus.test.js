import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clipStatusArg, peekDirectiveStatus, formatModelWait, formatPayStatus,
  formatRaceStatus, parseClassifyScore, pickRaceWinner, createRaceFeed,
  isRaceCountable, raceLastShip, RACE_EVERY_FAILED,
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

test('race status counts completions toward X, not mute waiting', () => {
  assert.equal(formatRaceStatus(0, 2), 'racing 0/2 back…');
  assert.equal(formatRaceStatus(1, 2), 'racing 1/2 back…');
  assert.equal(formatRaceStatus(2, 2), 'racing 2/2 back…');
  assert.equal(formatRaceStatus(1, 4), 'racing 1/4 back…');
});

test('parseClassifyScore prefers SCORE n and stays in 0–10', () => {
  assert.equal(parseClassifyScore('SCORE 8'), 8);
  assert.equal(parseClassifyScore('SCORE: 3'), 3);
  assert.equal(parseClassifyScore('The score is SCORE 10.'), 10);
  assert.equal(parseClassifyScore('7/10'), 7);
  assert.equal(parseClassifyScore('no number here'), 0);
  assert.equal(parseClassifyScore('SCORE 99'), 10);
});

test('pickRaceWinner: highest passing score wins; zero-pass ships last of X', () => {
  const a = { model: 'fast', text: 'weak', score: 3 };
  const b = { model: 'better', text: 'strong', score: 9 };
  assert.equal(pickRaceWinner([a, b], 6).winner.model, 'better');
  assert.equal(pickRaceWinner([a, b], 6).reason, 'score');

  const low1 = { model: 'a', text: 'first', score: 2 };
  const low2 = { model: 'b', text: 'second', score: 4 };
  const fb = pickRaceWinner([low1, low2], 6);
  assert.equal(fb.reason, 'fallback-last');
  assert.equal(fb.winner.text, 'second');

  const tie = pickRaceWinner([
    { model: 'a', text: 'A', score: 8 },
    { model: 'b', text: 'B', score: 8 },
  ], 6);
  assert.equal(tie.reason, 'tie');
  assert.equal(tie.tied.length, 2);
  assert.equal(tie.winner, null);
});

test('empty, HTTP/pay/timeout, fetch failed, and last.error do not count toward X', () => {
  assert.equal(isRaceCountable(''), false);
  assert.equal(isRaceCountable('   '), false);
  assert.equal(isRaceCountable('(upstream error — HTTP 502, try again)'), false);
  assert.equal(isRaceCountable('(payment failed — HTTP 402 after 3 retries. Run `npx openzoo` to check wallet balances.)'), false);
  assert.equal(isRaceCountable('(stream timed out — no tokens arrived)'), false);
  assert.equal(isRaceCountable('(stream stalled — showing what arrived before the timeout)'), false);
  assert.equal(isRaceCountable('fetch failed'), false);
  assert.equal(isRaceCountable('TypeError: fetch failed'), false);
  assert.equal(isRaceCountable('(mistral-large-2512 failed: fetch failed)'), false);
  assert.equal(isRaceCountable('(seed-2.0-code failed: fetch failed)'), false);
  assert.equal(isRaceCountable({ text: '', error: 'fetch failed' }), false);
  assert.equal(isRaceCountable({ text: 'DONE: built it', error: 'fetch failed' }), false);
  assert.equal(isRaceCountable('DONE: built it'), true);
  assert.equal(isRaceCountable('here is a real answer mentioning HTTP 500 in passing'), true);
  assert.equal(isRaceCountable('a real answer that mentions fetch failed in passing'), true);
});

test('raceLastShip is race-level when nobody countable — never a single model name', () => {
  assert.equal(raceLastShip([]).text, RACE_EVERY_FAILED);
  assert.equal(raceLastShip([{ model: 'x-ai/grok', text: '', error: 'boom' }]).text, RACE_EVERY_FAILED);
  assert.equal(raceLastShip([
    { model: 'mistralai/mistral-large-2512', text: '', error: 'fetch failed' },
    { model: 'bytedance-seed/seed-2.0-code', text: '', error: 'fetch failed' },
  ]).text, RACE_EVERY_FAILED);
  assert.doesNotMatch(raceLastShip([
    { model: 'mistralai/mistral-large-2512', text: '', error: 'fetch failed' },
  ]).text, /mistral-large-2512|seed-2.0-code/);
  assert.equal(raceLastShip([
    { model: 'a', text: '', error: '5xx' },
    { model: 'b', text: '(upstream error — HTTP 502, try again)' },
  ]).text, RACE_EVERY_FAILED);
  // A countable answer in the pile still wins over error arrivals.
  assert.equal(raceLastShip([
    { model: 'mistralai/mistral-large-2512', text: '', error: 'fetch failed' },
    { model: 'z-ai/glm-4.7', text: 'the real one' },
  ]).text, 'the real one');
});

test('createRaceFeed forwards the fastest alive and replaces on a different winner', () => {
  const deltas = [];
  const statuses = [];
  const feed = createRaceFeed((t, meta) => deltas.push({ t, meta }), (s) => statuses.push(s), 2);
  feed.start();
  feed.onToken('fast', 'Hel');
  feed.onToken('slow', 'xxx');
  feed.onToken('fast', 'lo');
  feed.onBack();
  feed.onBack();
  feed.settle({ model: 'slow', text: 'the winner' });
  assert.deepEqual(deltas.map((d) => d.t), ['Hel', 'lo', 'the winner']);
  assert.equal(deltas[2].meta.replace, true);
  assert.ok(statuses.includes('racing 0/2 back…'));
  assert.ok(statuses.includes('racing 1/2 back…'));
  assert.ok(statuses.includes('racing 2/2 back…'));
  feed.onToken('fast', 'ignored after settle');
  assert.equal(deltas.length, 3);
});

test('createRaceFeed paints a real error when settling a no-text race', () => {
  const deltas = [];
  const feed = createRaceFeed((t, meta) => deltas.push({ t, meta }), () => {}, 2);
  feed.start();
  feed.settle({ model: 'x', text: '(x failed: 5xx)', error: true });
  assert.equal(deltas.at(-1).t, '(x failed: 5xx)');
  assert.equal(deltas.at(-1).meta.replace, true);
});

test('idle / stale windows stay in the hang-timeout band', () => {
  assert.ok(STREAM_IDLE_MS >= 45_000 && STREAM_IDLE_MS <= 60_000);
  assert.ok(STALE_THINKING_MS >= STREAM_IDLE_MS);
});
