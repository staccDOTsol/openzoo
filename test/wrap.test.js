import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmSignatureByPolling } from '../lib/wrap.js';

const SIG = '5'.repeat(87);

/** Fake connection whose getSignatureStatuses walks a scripted sequence. */
function scriptedConnection(script) {
  let i = 0;
  return {
    calls: 0,
    getSignatureStatuses(sigs) {
      this.calls++;
      assert.deepEqual(sigs, [SIG]);
      const step = script[Math.min(i++, script.length - 1)];
      if (step instanceof Error) throw step;
      return Promise.resolve({ value: [step] });
    },
  };
}

test('confirmSignatureByPolling resolves once the status reaches confirmed', async () => {
  const conn = scriptedConnection([null, { confirmationStatus: 'processed', err: null }, { confirmationStatus: 'confirmed', err: null }]);
  const sig = await confirmSignatureByPolling(conn, SIG, { pollMs: 1 });
  assert.equal(sig, SIG);
  assert.equal(conn.calls, 3);
});

test('confirmSignatureByPolling accepts finalized when asked for confirmed', async () => {
  const conn = scriptedConnection([{ confirmationStatus: 'finalized', err: null }]);
  assert.equal(await confirmSignatureByPolling(conn, SIG, { pollMs: 1 }), SIG);
});

test('confirmSignatureByPolling throws on an on-chain error status', async () => {
  const conn = scriptedConnection([{ confirmationStatus: 'confirmed', err: { InstructionError: [1, 'Custom'] } }]);
  await assert.rejects(
    confirmSignatureByPolling(conn, SIG, { pollMs: 1 }),
    /failed on-chain/,
  );
});

test('confirmSignatureByPolling survives transient RPC throws, then confirms', async () => {
  const conn = scriptedConnection([new Error('fetch failed'), { confirmationStatus: 'confirmed', err: null }]);
  assert.equal(await confirmSignatureByPolling(conn, SIG, { pollMs: 1 }), SIG);
});

test('confirmSignatureByPolling times out when the signature never lands', async () => {
  const conn = scriptedConnection([null]);
  await assert.rejects(
    confirmSignatureByPolling(conn, SIG, { pollMs: 5, timeoutMs: 25 }),
    /timed out/,
  );
});
