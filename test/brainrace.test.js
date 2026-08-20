import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.OZ_AGENT_PORTS = '0';

const { brainRace } = await import('../lib/podagent.mjs');
const {
  receiptUsedCogs, capRaceByCredit, doorAcceptsRace, resetGatewayRaceProbe,
  RACE_NO_CREDIT,
} from '../lib/racesettle.js';

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

test('receipt cogs is used racers after unused refund — never N+judge ceiling', () => {
  const ceiling = { billedUsd: 1.44, cogsUsd: 2.20, race_unused: { cogsUsd: 0.90 } };
  const used = receiptUsedCogs(ceiling);
  assert.equal(used, 1.30);
  assert.ok(used <= ceiling.billedUsd, 'cogs ≤ billed after unused refund');
  // Already-net receipt: unused informational billed must not double-subtract spent
  assert.equal(receiptUsedCogs({ billedUsd: 1.00, cogsUsd: 0.70 }), 0.70);
  assert.ok(receiptUsedCogs({ billedUsd: 1.00, cogsUsd: 0.70 }) <= 1.00);
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
