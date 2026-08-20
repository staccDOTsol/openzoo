import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clipStatusArg, peekDirectiveStatus, formatModelWait, formatPayStatus,
  formatRaceStatus, parseClassifyScore, pickRaceWinner, createRaceFeed,
  raceSavingsCutPct, raceChoiceLabel, formatSitrep,
  isRaceCountable, raceLastShip, RACE_EVERY_FAILED, shouldRetryRaceArrival,
  summarizeRaceFailures, raceFailKind, shortModelName, clipRacePreview,
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
  // launched-count must never paint as "racing 4/2 back…"
  assert.equal(formatRaceStatus(4, 2), 'racing 2/2 back…');
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
  feed.onBack();
  feed.onBack();
  assert.equal(statuses.filter((s) => s === 'racing 3/2 back…').length, 0);
  assert.equal(statuses.filter((s) => s === 'racing 4/2 back…').length, 0);
});

test('createRaceFeed paints a real error when settling a no-text race', () => {
  const deltas = [];
  const feed = createRaceFeed((t, meta) => deltas.push({ t, meta }), () => {}, 2);
  feed.start();
  feed.settle({ model: 'x', text: '(x failed: 5xx)', error: true });
  assert.equal(deltas.at(-1).t, '(x failed: 5xx)');
  assert.equal(deltas.at(-1).meta.replace, true);
});

test('idle / stale windows outlast the 120s first-byte budget', () => {
  assert.ok(STREAM_IDLE_MS >= 120_000);
  assert.ok(STALE_THINKING_MS >= STREAM_IDLE_MS);
});

test('onBack after settle cannot paint racing 4/2 onto an idle thread', () => {
  const statuses = [];
  const feed = createRaceFeed(() => {}, (s) => statuses.push(s), 2);
  feed.start();
  feed.onBack();
  feed.onBack();
  feed.settle({ model: 'a', text: 'done' });
  feed.onBack();
  feed.onBack();
  assert.deepEqual(statuses, ['racing 0/2 back…', 'racing 1/2 back…', 'racing 2/2 back…']);
});

test('race savings cut is Y-based: 1→0%, 2→50%, 4→75%', () => {
  assert.equal(raceSavingsCutPct(1), 0);
  assert.equal(raceSavingsCutPct(2), 50);
  assert.equal(raceSavingsCutPct(3), 67);
  assert.equal(raceSavingsCutPct(4), 75);
  assert.equal(raceChoiceLabel(1), '1 model  0%');
  assert.equal(raceChoiceLabel(2, 1), 'race 2  −50%');
  assert.equal(raceChoiceLabel(4, 2), 'best 2 of 4  −75%');
});

test('formatSitrep is compact, 1-model 0%, prepaid yes/no, no keys', () => {
  const text = formatSitrep({
    race: 0, raceNeed: 1, tier: 'medium', runMode: 'auto',
    dir: '/workspace', status: 'idle',
    spentUsd: 6.57, cogsUsd: 6.26, directUsd: 13.70, paidCalls: 451, creditUsd: 4.2,
  });
  assert.match(text, /^Sitrep/);
  assert.match(text, /1 model  0%/);
  assert.match(text, /band        medium/);
  assert.match(text, /mode        auto/);
  assert.match(text, /cwd         \/workspace/);
  assert.match(text, /in flight   idle/);
  assert.match(text, /paid        \$6\.57/);
  assert.match(text, /saved       2\.09x/);
  assert.match(text, /paid calls  451/);
  assert.match(text, /prepaid     yes/);
  assert.doesNotMatch(text, /sk-|npmrc|subscription key|wallet\.json/i);
  const empty = formatSitrep({ creditUsd: 0 });
  assert.match(empty, /prepaid     no/);
  const racing = formatSitrep({
    race: 4, raceNeed: 2, status: 'thinking', liveRace: { phase: 'judging' },
  });
  assert.match(racing, /best 2 of 4  −75%/);
  assert.match(racing, /in flight   classifier judging/);
});

test('shortModelName drops the org prefix; clipRacePreview keeps an opening, not the whole answer', () => {
  assert.equal(shortModelName('z-ai/glm-4.7'), 'glm-4.7');
  assert.equal(shortModelName('deepseek/deepseek-v4-flash'), 'deepseek-v4-flash');
  assert.equal(shortModelName('glm-4.7'), 'glm-4.7');
  const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const clip = clipRacePreview(long);
  assert.ok(clip.includes('line 0'));
  assert.ok(!clip.includes('line 19'));
  assert.ok(clip.endsWith('…'));
});

test('createRaceFeed spectator snapshot: Y cells, abandon after X, then judging/winner', () => {
  const snaps = [];
  const feed = createRaceFeed(() => {}, () => {}, 2, (s) => snaps.push(s));
  feed.start(['z-ai/glm-4.7', 'deepseek/deepseek-v4-flash', 'qwen/qwen3', 'mistralai/mistral-large'], { recut: 'savings' });
  assert.equal(snaps[0].launched, 4);
  assert.equal(snaps[0].need, 2);
  assert.equal(snaps[0].phase, 'racing');
  assert.deepEqual(snaps[0].racers.map((r) => r.short), ['glm-4.7', 'deepseek-v4-flash', 'qwen3', 'mistral-large']);
  assert.ok(snaps[0].racers.every((r) => r.status === 'waiting'));

  feed.onToken('z-ai/glm-4.7', 'Hello from glm\nmore\n');
  feed.onToken('deepseek/deepseek-v4-flash', 'Hello from deepseek');
  feed.onToken('qwen/qwen3', 'still going');
  const streaming = snaps.at(-1);
  assert.equal(streaming.racers.find((r) => r.model === 'z-ai/glm-4.7').status, 'streaming');
  assert.ok(streaming.racers.find((r) => r.model === 'z-ai/glm-4.7').preview.includes('Hello from glm'));

  feed.onBack('z-ai/glm-4.7');
  feed.onBack('deepseek/deepseek-v4-flash');
  const afterX = snaps.at(-1);
  assert.equal(afterX.back, 2);
  assert.equal(afterX.racers.find((r) => r.model === 'qwen/qwen3').status, 'abandoned');
  assert.equal(afterX.racers.find((r) => r.model === 'mistralai/mistral-large').status, 'abandoned');
  assert.equal(afterX.racers.find((r) => r.model === 'z-ai/glm-4.7').status, 'back');
  assert.equal(afterX.racers.find((r) => r.model === 'deepseek/deepseek-v4-flash').status, 'back');

  feed.onToken('qwen/qwen3', 'should not keep racing');
  const frozen = snaps.at(-1);
  assert.equal(frozen.racers.find((r) => r.model === 'qwen/qwen3').status, 'abandoned');
  assert.ok(!String(frozen.racers.find((r) => r.model === 'qwen/qwen3').preview).includes('should not keep racing'));

  feed.judge();
  assert.equal(snaps.at(-1).phase, 'judging');
  assert.equal(snaps[0].recut, 'savings');
  feed.settle({ model: 'deepseek/deepseek-v4-flash', text: 'the winner' });
  const won = snaps.at(-1);
  assert.equal(won.phase, 'winner');
  assert.equal(won.winner, 'deepseek/deepseek-v4-flash');
  assert.equal(won.racers.length, 4);
});

test('failed racer snapshot is a fail kind, not a dumped 502 body', () => {
  const snaps = [];
  const feed = createRaceFeed(() => {}, () => {}, 2, (s) => snaps.push(s));
  feed.start(['fast', 'boom']);
  feed.onFail('boom', { model: 'boom', text: '(upstream error — HTTP 502, try again)', error: 'HTTP 502' });
  const boom = snaps.at(-1).racers.find((r) => r.model === 'boom');
  assert.equal(boom.status, 'failed');
  assert.equal(boom.fail, 'HTTP 502');
  assert.equal(boom.preview, '');
  assert.doesNotMatch(JSON.stringify(boom), /upstream error/);
});

test('fetch-failed / empty / 5xx are retried; pay is not', () => {
  assert.equal(shouldRetryRaceArrival({ text: '', error: 'fetch failed' }), true);
  assert.equal(shouldRetryRaceArrival({ text: 'fetch failed' }), true);
  assert.equal(shouldRetryRaceArrival({ text: '' }), true);
  assert.equal(shouldRetryRaceArrival({ text: '(upstream error — HTTP 502, try again)' }), true);
  assert.equal(shouldRetryRaceArrival({ text: '(payment failed — HTTP 402 after 3 retries)' }), false);
  assert.equal(shouldRetryRaceArrival({ text: 'DONE: ok' }), false);
  assert.equal(raceFailKind({ text: '', error: 'fetch failed' }), 'fetch failed');
  assert.deepEqual(summarizeRaceFailures([
    { text: '', error: 'fetch failed' },
    { text: '', error: 'fetch failed' },
    { text: '' },
  ]), { 'fetch failed': 2, 'empty body': 1 });
});
