import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.OZ_AGENT_PORTS = '0';

const { brainRace } = await import('../lib/podagent.mjs');
const {
  receiptUsedCogs, receiptDirectUsd, meterRaceReceipt, capRaceByCredit, doorAcceptsRace,
  resetGatewayRaceProbe, RACE_NO_CREDIT, recutRaceByHud, sessionDollarX,
  RACE_HUD_TARGET, receiptSettledBilled, pairActualBilled, isQuoteReserveBilled,
  SAVINGS_SHARE,
} = await import('../lib/racesettle.js');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Scripted streamer: each model emits chunks then resolves after `at` ms. */
function scriptedStream(spec) {
  return async function stream(_messages, onDelta, _ctx, model) {
    const s = spec[model];
    if (!s) throw new Error('unexpected model ' + model);
    if (s.err) {
      await sleep(s.at || 0);
      throw s.err;
    }
    const chunks = s.chunks || (s.text ? [s.text] : []);
    const start = Date.now();
    const tokenAt = s.tokenAt != null ? s.tokenAt : Math.max(0, (s.at || 0) - 20);
    await sleep(tokenAt);
    for (const c of chunks) onDelta(c);
    const left = Math.max(0, (s.at || 0) - (Date.now() - start));
    await sleep(left);
    return s.empty ? '' : (s.text ?? chunks.join(''));
  };
}

test('race forwards onDelta before a winner exists', async () => {
  let resolved = false;
  const deltas = [];
  const p = brainRace(
    [{ role: 'user', content: 'q' }],
    (d) => { if (!resolved && d) deltas.push(d); },
    null,
    ['fast', 'slow'],
    2,
    undefined,
    () => {},
    {
      stream: scriptedStream({
        fast: { chunks: ['Hel', 'lo'], text: 'Hello', at: 40, tokenAt: 5 },
        slow: { chunks: ['Bye'], text: 'Bye', at: 80, tokenAt: 60 },
      }),
      classify: async (_m, c) => (c.model === 'slow' ? 9 : 3),
    },
  );
  await sleep(20);
  assert.ok(deltas.length > 0, 'tokens must land before both racers finish');
  assert.ok(deltas.join('').includes('Hel'));
  const text = await p;
  resolved = true;
  assert.equal(text, 'Bye');
});

test('onRace paints a Y-cell grid, abandons the rest after X, then judges', async () => {
  const snaps = [];
  await brainRace(
    [{ role: 'user', content: 'q' }],
    () => {},
    null,
    ['a', 'b', 'c', 'd'],
    2,
    undefined,
    () => {},
    {
      stream: scriptedStream({
        a: { text: 'one', at: 15 },
        b: { text: 'two', at: 35 },
        c: { chunks: ['late'], text: 'three', at: 200, tokenAt: 80 },
        d: { text: 'four', at: 220 },
      }),
      classify: async (_m, c) => (c.model === 'b' ? 9 : 7),
      onRace: (s) => snaps.push(s),
    },
  );
  assert.ok(snaps[0].racers.length === 4);
  assert.ok(snaps[0].racers.every((r) => r.status === 'waiting'));
  assert.ok(snaps.some((s) => s.phase === 'judging'));
  const judged = snaps.find((s) => s.phase === 'judging');
  assert.equal(judged.racers.filter((r) => r.status === 'back').length, 2);
  assert.equal(judged.racers.filter((r) => r.status === 'abandoned').length, 2);
  const won = snaps.find((s) => s.phase === 'winner');
  assert.equal(won.winner, 'b');
  assert.equal(won.racers.length, 4);
});

test('status updates as racers finish: racing n/X back…', async () => {
  const statuses = [];
  await brainRace(
    [{ role: 'user', content: 'q' }],
    () => {},
    null,
    ['a', 'b', 'c'],
    2,
    undefined,
    (s) => statuses.push(s),
    {
      stream: scriptedStream({
        a: { text: 'one', at: 15 },
        b: { text: 'two', at: 35 },
        c: { text: 'three', at: 200 },
      }),
      classify: async (_m, c) => (c.model === 'b' ? 9 : 7),
    },
  );
  assert.ok(statuses.includes('racing 0/2 back…'));
  assert.ok(statuses.includes('racing 1/2 back…'));
  assert.ok(statuses.includes('racing 2/2 back…'));
  assert.equal(statuses.filter((s) => s === 'racing 3/2 back…').length, 0);
});

test('first two non-empty back are the only ones classified; a slow 3rd does not enter', async () => {
  const classified = [];
  let cStarted = false;
  const t0 = Date.now();
  const text = await brainRace(
    [{ role: 'user', content: 'q' }],
    () => {},
    null,
    ['empty', 'a', 'b', 'c'],
    2,
    undefined,
    () => {},
    {
      stream: async (messages, onDelta, ctx, model) => {
        if (model === 'empty') {
          await sleep(5);
          return '';
        }
        if (model === 'a') {
          await sleep(15);
          onDelta('first');
          return 'first';
        }
        if (model === 'b') {
          await sleep(30);
          onDelta('second');
          return 'second';
        }
        cStarted = true;
        await sleep(250);
        onDelta('third');
        return 'third-should-not-win';
      },
      classify: async (_m, c) => {
        classified.push(c.model);
        return c.model === 'b' ? 9 : 8;
      },
    },
  );
  assert.deepEqual(classified.slice().sort(), ['a', 'b']);
  assert.equal(text, 'second');
  assert.ok(cStarted, 'the 3rd is still paid for / launched');
  assert.ok(Date.now() - t0 < 150, 'must ship when X are in, not wait for N');
});

test('a low-score first-back does not win just by being fast', async () => {
  const text = await brainRace(
    [{ role: 'user', content: 'q' }],
    () => {},
    null,
    ['fast', 'good'],
    2,
    undefined,
    () => {},
    {
      stream: scriptedStream({
        fast: { text: 'meh', at: 10 },
        good: { text: 'solid', at: 25 },
      }),
      classify: async (_m, c) => (c.model === 'fast' ? 2 : 9),
    },
  );
  assert.equal(text, 'solid');
});

test('zero-pass classifier still ships the last of the X', async () => {
  const classified = [];
  const text = await brainRace(
    [{ role: 'user', content: 'q' }],
    () => {},
    null,
    ['a', 'b', 'c'],
    2,
    undefined,
    () => {},
    {
      stream: scriptedStream({
        a: { text: 'first-back', at: 10 },
        b: { text: 'last-of-x', at: 25 },
        c: { text: 'late-high', at: 200 },
      }),
      classify: async (_m, c) => {
        classified.push(c.text);
        return 1;
      },
      minScore: 6,
    },
  );
  assert.deepEqual(classified.slice().sort(), ['first-back', 'last-of-x']);
  assert.equal(text, 'last-of-x');
});

test('if X never fills, one race-level error — not the last model name', async () => {
  const deltas = [];
  const text = await brainRace(
    [{ role: 'user', content: 'q' }],
    (d, meta) => deltas.push({ d, meta }),
    null,
    ['boom', 'blank', 'last'],
    2,
    undefined,
    () => {},
    {
      stream: scriptedStream({
        boom: { err: new Error('HTTP 502'), at: 5 },
        blank: { empty: true, text: '', at: 15 },
        last: { text: '(upstream error — HTTP 503, try again)', at: 30 },
      }),
      classify: async () => { throw new Error('classify must not run when X never fills'); },
    },
  );
  assert.equal(text, '(race: every model failed — no reply)');
  assert.doesNotMatch(text, /boom|blank|last failed|HTTP 503/);
  assert.ok(deltas.some((x) => String(x.d).includes('every model failed')));
});

test('if everyone errors with no text, surface a race-level error — do not hang or return blank', async () => {
  const t0 = Date.now();
  const deltas = [];
  const text = await brainRace(
    [{ role: 'user', content: 'q' }],
    (d) => { if (d) deltas.push(d); },
    null,
    ['a', 'b'],
    2,
    undefined,
    () => {},
    {
      stream: scriptedStream({
        a: { err: new Error('5xx'), at: 8 },
        b: { empty: true, text: '', at: 20 },
      }),
    },
  );
  assert.ok(Date.now() - t0 < 100, 'must not wait for a K that will never come');
  assert.equal(text, '(race: every model failed — no reply)');
  assert.ok(deltas.some((d) => /every model failed/i.test(d)));
});

test('1.5.74 regression: fetch-failed racer is dropped; two real answers still classify', async () => {
  // Would have failed on 1.5.74: TypeError `fetch failed` (and/or empty+error)
  // was shipped as `(mistral-large-2512 failed: fetch failed)` / `(seed-2.0-code
  // failed: fetch failed)` instead of waiting for countable answers.
  const classified = [];
  const text = await brainRace(
    [{ role: 'user', content: 'q' }],
    () => {},
    null,
    [
      'mistralai/mistral-large-2512',
      'bytedance-seed/seed-2.0-code',
      'deepseek/deepseek-v4-pro-0813',
      'z-ai/glm-4.7',
    ],
    2,
    undefined,
    () => {},
    {
      stream: scriptedStream({
        'mistralai/mistral-large-2512': {
          err: Object.assign(new TypeError('fetch failed'), { name: 'TypeError' }),
          at: 5,
        },
        'bytedance-seed/seed-2.0-code': { text: 'real-seed-answer', at: 25 },
        'deepseek/deepseek-v4-pro-0813': { text: 'real-deepseek-answer', at: 40 },
        'z-ai/glm-4.7': { text: 'late-should-not-enter', at: 200 },
      }),
      classify: async (_m, c) => {
        classified.push(c.text);
        return c.text === 'real-deepseek-answer' ? 9 : 7;
      },
    },
  );
  assert.equal(text, 'real-deepseek-answer');
  assert.doesNotMatch(text, /failed: fetch failed/);
  assert.doesNotMatch(text, /mistral-large-2512|seed-2.0-code failed/);
  assert.deepEqual(classified.slice().sort(), ['real-deepseek-answer', 'real-seed-answer']);
});

test('1.5.74 regression: resolved fetch-failed text is not countable toward X', async () => {
  // 1.5.74 isRaceCountable treated the raw string "fetch failed" as a real
  // answer, so two fast failures filled X and abandoned the live racers.
  const classified = [];
  const text = await brainRace(
    [{ role: 'user', content: 'q' }],
    () => {},
    null,
    [
      'mistralai/mistral-large-2512',
      'bytedance-seed/seed-2.0-code',
      'deepseek/deepseek-v4-pro-0813',
      'z-ai/glm-4.7',
    ],
    2,
    undefined,
    () => {},
    {
      stream: scriptedStream({
        'mistralai/mistral-large-2512': { text: 'fetch failed', at: 5 },
        'bytedance-seed/seed-2.0-code': { empty: true, text: '', at: 8 },
        'deepseek/deepseek-v4-pro-0813': { text: 'ok-one', at: 25 },
        'z-ai/glm-4.7': { text: 'ok-two', at: 40 },
      }),
      classify: async (_m, c) => {
        classified.push(c.text);
        return c.text === 'ok-two' ? 9 : 7;
      },
    },
  );
  assert.equal(text, 'ok-two');
  assert.doesNotMatch(text, /failed: fetch failed|fetch failed/);
  assert.deepEqual(classified.slice().sort(), ['ok-one', 'ok-two']);
});

test('1.5.74 regression: every racer fetch-failed → race-level failure, not a model name', async () => {
  const text = await brainRace(
    [{ role: 'user', content: 'q' }],
    () => {},
    null,
    [
      'mistralai/mistral-large-2512',
      'bytedance-seed/seed-2.0-code',
      'deepseek/deepseek-v4-pro-0813',
      'z-ai/glm-4.7',
    ],
    2,
    undefined,
    () => {},
    {
      stream: scriptedStream({
        'mistralai/mistral-large-2512': { err: new TypeError('fetch failed'), at: 4 },
        'bytedance-seed/seed-2.0-code': { err: new TypeError('fetch failed'), at: 8 },
        'deepseek/deepseek-v4-pro-0813': { err: new TypeError('fetch failed'), at: 12 },
        'z-ai/glm-4.7': { err: new TypeError('fetch failed'), at: 16 },
      }),
      classify: async () => { throw new Error('classify must not run when every racer failed'); },
    },
  );
  assert.equal(text, '(race: every model failed — no reply)');
  assert.doesNotMatch(text, /mistral-large-2512|seed-2.0-code|deepseek|glm-4\.7/);
  assert.doesNotMatch(text, /failed: fetch failed/);
});

test('malformed judge / equally bad scores ship the last finished candidate', async () => {
  const text = await brainRace(
    [{ role: 'user', content: 'q' }],
    () => {},
    null,
    ['a', 'b'],
    2,
    undefined,
    () => {},
    {
      stream: scriptedStream({
        a: { text: 'first', at: 10 },
        b: { text: 'last-finished', at: 25 },
      }),
      classify: async () => 8,
      pairwise: async () => ({ text: '' }),
    },
  );
  assert.equal(text, 'last-finished');
});

test('empty/5xx do not count toward X', async () => {
  const classified = [];
  const text = await brainRace(
    [{ role: 'user', content: 'q' }],
    () => {},
    null,
    ['boom', 'blank', 'real1', 'real2'],
    2,
    undefined,
    () => {},
    {
      stream: scriptedStream({
        boom: { err: new Error('5xx'), at: 5 },
        blank: { empty: true, text: '', at: 8 },
        real1: { text: 'ok-one', at: 20 },
        real2: { text: 'ok-two', at: 35 },
      }),
      classify: async (_m, c) => {
        classified.push(c.text);
        return c.text === 'ok-two' ? 9 : 7;
      },
    },
  );
  assert.deepEqual(classified.slice().sort(), ['ok-one', 'ok-two']);
  assert.equal(text, 'ok-two');
});

test('fetch-failed racer is retried once and can still fill X', async () => {
  const tries = {};
  const classified = [];
  const text = await brainRace(
    [{ role: 'user', content: 'q' }],
    () => {},
    null,
    ['flaky', 'good'],
    2,
    undefined,
    () => {},
    {
      stream: async (_messages, onDelta, _ctx, model) => {
        tries[model] = (tries[model] || 0) + 1;
        if (model === 'flaky' && tries[model] === 1) {
          await sleep(5);
          throw new TypeError('fetch failed');
        }
        await sleep(10);
        onDelta(model + '-ok');
        return model + '-ok';
      },
      classify: async (_m, c) => {
        classified.push(c.model);
        return c.model === 'flaky' ? 9 : 7;
      },
    },
  );
  assert.equal(tries.flaky, 2);
  assert.equal(tries.good, 1);
  assert.equal(text, 'flaky-ok');
  assert.deepEqual(classified.slice().sort(), ['flaky', 'good']);
});

test('race_unused is not a user refund; HUD cogs stay house cost', () => {
  const receipt = { billedUsd: 1.44, cogsUsd: 2.20, race_unused: { billedUsd: 0.50, cogsUsd: 0.90 } };
  assert.equal(receiptUsedCogs(receipt), 2.20);
  const meter = meterRaceReceipt(receipt);
  assert.equal(meter.spentUsd, 1.44);
  assert.equal(meter.cogsUsd, 2.20);
  assert.ok(meter.cogsUsd > meter.spentUsd, 'house losing → HUD embers');
  // Already-net receipt: billed is what they paid; do not invent a grant-back
  assert.equal(receiptUsedCogs({ billedUsd: 1.00, cogsUsd: 0.70 }), 0.70);
  const failed = { billedUsd: 0.40, cogsUsd: 0.40, race_unused: { billedUsd: 0.40, refundUsd: 0.40, cogsUsd: 0.40 } };
  const failedMeter = meterRaceReceipt(failed);
  assert.equal(failedMeter.spentUsd, 0.40);
  assert.equal(failedMeter.cogsUsd, 0.40);
  // No 3× fallback: billed is the OpenRouter price, not billed/3
  assert.equal(receiptUsedCogs({ billedUsd: 0.90 }), 0.90);
  assert.equal(receiptUsedCogs({ billedUsd: 0.90, markup: 3 }), 0.90);
  assert.equal(receiptDirectUsd({ billedUsd: 1.00, savedUsd: 2.00 }), 3.00);
  assert.equal(receiptDirectUsd({ billedUsd: 1.00, directUsd: 4.00, savedUsd: 2.00 }), 4.00);
  const atCost = meterRaceReceipt({ billedUsd: 0.90, directUsd: 0.90, savedUsd: 0 });
  assert.equal(atCost.spentUsd, 0.90);
  assert.equal(atCost.cogsUsd, 0.90);
  assert.equal(atCost.directUsd, 0.90);
});

// MEASURED 2026-08-19: quote reserved 32,000 output tokens at $0.9858;
// OpenRouter usage.cost was $0.007962 (124× smaller). Pairing the reserve
// with the metered cost made HUD markupX lie.
const RESERVE_QUOTE = 0.9858;
const USAGE_COST = 0.007962;

test('reserved quote ≠ settled: billedWithActual uses post-completion billed', () => {
  const x = { billedUsd: RESERVE_QUOTE, directUsd: RESERVE_QUOTE, savedUsd: 0 };
  const usage = { cost: USAGE_COST, prompt_tokens: 40, completion_tokens: 8 };
  assert.equal(isQuoteReserveBilled(RESERVE_QUOTE, USAGE_COST, x), true);
  const settled = receiptSettledBilled(x, usage);
  assert.equal(settled, USAGE_COST);
  assert.ok(settled !== RESERVE_QUOTE, 'must not add the quote-time reserve');
  const pair = pairActualBilled(x, usage);
  assert.equal(pair.upstreamUsd, USAGE_COST);
  assert.equal(pair.billedUsd, USAGE_COST);
  const markupX = Number((pair.billedUsd / pair.upstreamUsd).toFixed(2));
  assert.equal(markupX, 1);
  assert.ok(markupX < 2, 'markupX is not 124× on a ~1× call');
  assert.ok(RESERVE_QUOTE / USAGE_COST > 100, 'fixture is the measured 124× lie');
});

test('explicit settled billed wins over the quote reserve', () => {
  const x = { billedUsd: RESERVE_QUOTE, billedActual: 0.0106 };
  const pair = pairActualBilled(x, { cost: USAGE_COST });
  assert.equal(pair.upstreamUsd, USAGE_COST);
  assert.equal(pair.billedUsd, 0.0106);
  const markupX = Number((pair.billedUsd / pair.upstreamUsd).toFixed(2));
  assert.ok(markupX > 1 && markupX < 2);
});

test('stream actualUsd pairs with settled billed, not x.billedUsd reserve', () => {
  const x = { billedUsd: RESERVE_QUOTE, actualUsd: USAGE_COST, savedUsd: 0 };
  const pair = pairActualBilled(x, undefined);
  assert.equal(pair.upstreamUsd, USAGE_COST);
  assert.equal(pair.billedUsd, USAGE_COST);
});

test('settled cogs + real savings keep 33% share; reserve cogs do not', () => {
  const cost = 0.01;
  const saved = 0.90;
  const honest = cost + SAVINGS_SHARE * saved;
  const settled = receiptSettledBilled(
    { billedUsd: honest, cogsUsd: cost, savedUsd: saved, directUsd: cost + saved },
    { cost },
  );
  assert.equal(settled, honest);
  assert.ok(settled / cost > 2, 'honest 33% of large savings can exceed 2×');

  const reserved = receiptSettledBilled(
    { billedUsd: RESERVE_QUOTE, cogsUsd: RESERVE_QUOTE, savedUsd: 0 },
    { cost: USAGE_COST },
  );
  assert.equal(reserved, USAGE_COST);
});

test('tokens used × unit prices replace a reserved billedUsd', () => {
  const x = {
    billedUsd: RESERVE_QUOTE,
    promptPriceUsd: 0.00001,
    completionPriceUsd: 0.00003,
  };
  const usage = { cost: USAGE_COST, prompt_tokens: 100, completion_tokens: 20 };
  assert.equal(receiptSettledBilled(x, usage), 100 * 0.00001 + 20 * 0.00003);
});

test('pairActualBilled is null when no real upstream cost was learned', () => {
  assert.equal(pairActualBilled({ billedUsd: RESERVE_QUOTE }, {}), null);
  assert.equal(pairActualBilled(undefined, undefined), null);
});

test('sessionDollarX is the HUD green x (direct/spent)', () => {
  assert.equal(sessionDollarX({ spentUsd: 6.57, directUsd: 13.70 }).toFixed(2), '2.09');
  assert.equal(sessionDollarX({ dollarX: 2.09 }), 2.09);
  assert.equal(sessionDollarX({}), null);
});

test('recutRaceByHud: 2.09x on 4 racers drops to 1 — the 4-racer tax', () => {
  assert.equal(RACE_HUD_TARGET, 5);
  const thin = recutRaceByHud({ y: 4, need: 2, dollarX: 2.09, tier: 'medium' });
  assert.equal(thin.y, 1);
  assert.equal(thin.need, 1);
  assert.equal(thin.tier, 'medium');
  assert.equal(thin.recut, true);
  assert.equal(thin.reason, 'savings');

  const ok = recutRaceByHud({ y: 4, need: 2, dollarX: 6.0, tier: 'medium' });
  assert.equal(ok.recut, false);
  assert.equal(ok.y, 4);
  assert.equal(ok.need, 2);

  const mid = recutRaceByHud({ y: 4, need: 2, dollarX: 4.0, tier: 'medium' });
  assert.equal(mid.y, 3);
  assert.equal(mid.need, 2);
  assert.equal(mid.recut, true);

  const worse = recutRaceByHud({ y: 4, need: 2, dollarX: 1.1, tier: 'expensive' });
  assert.equal(worse.y, 1);
  assert.equal(worse.tier, 'medium');
  assert.equal(worse.recut, true);

  assert.equal(recutRaceByHud({ y: 4, need: 2 }).recut, false);
});

test('thin green HUD recuts a best-2-of-4 launch so classify never sees 4 bills', async () => {
  let launched = 0;
  const classified = [];
  const statuses = [];
  const text = await brainRace(
    [{ role: 'user', content: 'q' }],
    () => {},
    null,
    ['a', 'b', 'c', 'd'],
    2,
    undefined,
    (s) => statuses.push(s),
    {
      dollarX: 2.09,
      tier: 'medium',
      stream: async (_m, onDelta, _c, model) => {
        launched += 1;
        onDelta(model + '-only');
        return model + '-only';
      },
      classify: async (_m, c) => { classified.push(c.model); return 9; },
    },
  );
  assert.equal(launched, 1);
  assert.equal(classified.length, 0);
  assert.equal(text, 'a-only');
  assert.ok(statuses.some((s) => /recut to 1 — savings/.test(s)));
});

test('capRaceByCredit shrinks or refuses instead of firing 4 groks on $0', () => {
  assert.equal(capRaceByCredit(4, { creditUsd: 0, quoteUsd: 0.30 }).n, 0);
  assert.equal(capRaceByCredit(4, { creditUsd: 0, quoteUsd: 0.30 }).reason, 'no-credit');
  assert.equal(capRaceByCredit(4, { creditUsd: 0.50, quoteUsd: 0.30 }).n, 1);
  assert.equal(capRaceByCredit(4, { creditUsd: 1.50, quoteUsd: 0.30 }).n, 4);
  assert.equal(capRaceByCredit(4, {}).n, 4);
  assert.equal(doorAcceptsRace({ upstream: 'https://x402-tokens.fly.dev' }), true);
  assert.equal(doorAcceptsRace({ race: true }), true);
  assert.equal(doorAcceptsRace({ upstream: 'http://127.0.0.1:9' }), false);
});

test('$0 prepaid credit refuses a race rather than launching N 402s', async () => {
  let streamCalls = 0;
  const text = await brainRace(
    [{ role: 'user', content: 'q' }],
    () => {},
    null,
    ['a', 'b', 'c', 'd'],
    2,
    undefined,
    () => {},
    {
      creditUsd: 0,
      quoteUsd: 0.25,
      stream: async () => { streamCalls += 1; return 'should-not-run'; },
    },
  );
  assert.equal(text, RACE_NO_CREDIT);
  assert.equal(streamCalls, 0);
});

test('brainRace to a mock that accepts race: does ONE post not four', async () => {
  resetGatewayRaceProbe();
  let posts = 0;
  const seen = [];
  const server = await new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      const url = (req.url || '').split('?')[0];
      if (req.method === 'GET' && (url === '/v1/info' || url === '/info')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ upstream: 'https://x402-tokens.fly.dev', race: true }));
        return;
      }
      if (req.method === 'GET' && url === '/v1/session') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ creditUsd: 20, spentUsd: 1.44, cogsUsd: 0.9, directUsd: 8.26 }));
        return;
      }
      if (req.method === 'POST' && url.includes('/chat/completions')) {
        const chunks = [];
        req.on('data', (d) => chunks.push(d));
        req.on('end', () => {
          posts += 1;
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          seen.push(body);
          assert.ok(body.race >= 2, 'gateway race must send race:');
          assert.equal(body.race_need, 2);
          assert.equal(body.tier, 'cheap');
          assert.equal(body.stream, true);
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"id":"r","model":"fast","choices":[{"delta":{"content":"Hello"}}]}\n\n');
          res.write('data: {"id":"r","model":"fast","choices":[{"delta":{"content":" winner"},"finish_reason":"stop"}]}\n\n');
          res.write(': x402 {"billedUsd":1.00,"cogsUsd":1.20,"race_unused":{"cogsUsd":0.40}}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const prev = process.env.OZ_PROXY;
  process.env.OZ_PROXY = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const text = await brainRace(
      [{ role: 'user', content: 'q' }],
      () => {},
      null,
      ['a', 'b', 'c', 'd'],
      2,
      undefined,
      () => {},
      { tier: 'cheap', creditUsd: 20, quoteUsd: 0.1 },
    );
    assert.equal(posts, 1, 'gateway race must be one POST, not four');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].race, 4);
    assert.match(text, /Hello winner/);
  } finally {
    if (prev == null) delete process.env.OZ_PROXY;
    else process.env.OZ_PROXY = prev;
    resetGatewayRaceProbe();
    await new Promise((r) => server.close(r));
  }
});
