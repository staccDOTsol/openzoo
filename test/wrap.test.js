import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import {
  confirmSignatureByPolling,
  buildWrapInstructions,
  WRAP_PROGRAM_ID,
  WRAP_IX_ACCOUNT_COUNT,
  WRAP_ACQUIRE_STEPS,
  WRAP_TOO_FEW_ACCOUNTS,
  rewriteWrapClientError,
} from '../lib/wrap.js';

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

function fakePool() {
  return {
    wrapped: Keypair.generate().publicKey,
    wrappedProgram: TOKEN_2022_PROGRAM_ID,
    programId: WRAP_PROGRAM_ID,
    authority: Keypair.generate().publicKey,
    bump: 255,
    escrow: Keypair.generate().publicKey,
    underlying: Keypair.generate().publicKey,
    underlyingProgram: TOKEN_PROGRAM_ID,
    underlyingDecimals: 6,
  };
}

test('buildWrapInstructions emits a 9-account Wrap and no TransferChecked after it', () => {
  const owner = Keypair.generate().publicKey;
  const ixs = buildWrapInstructions({ pool: fakePool(), owner, depositRaw: 1000n });
  const wrapIx = ixs.find((ix) => ix.programId.equals(WRAP_PROGRAM_ID));
  assert.ok(wrapIx, 'missing Wrap ix');
  assert.equal(wrapIx.keys.length, WRAP_IX_ACCOUNT_COUNT);
  assert.equal(wrapIx.keys.length, 9);
  assert.ok(wrapIx.keys[5], 'account 5 depositor underlying ATA missing');
  assert.equal(wrapIx.keys[5].isWritable, true);
  assert.ok(wrapIx.keys[6], 'account 6 depositor signer missing');
  assert.equal(wrapIx.keys[6].isSigner, true);
  assert.ok(wrapIx.keys[6].pubkey.equals(owner));
  assert.ok(wrapIx.keys[7], 'account 7 unwrapped mint missing');
  assert.ok(wrapIx.keys[8], 'account 8 unwrapped token program missing');
  assert.ok(wrapIx.keys[8].pubkey.equals(TOKEN_PROGRAM_ID));
  assert.ok(wrapIx.keys[4].pubkey.equals(TOKEN_2022_PROGRAM_ID));
  assert.notEqual(wrapIx.keys[4].pubkey.toBase58(), wrapIx.keys[8].pubkey.toBase58());
  assert.equal(wrapIx.data[0], 1);
  const wrapAt = ixs.indexOf(wrapIx);
  const after = ixs.slice(wrapAt + 1);
  for (const ix of after) {
    const tokenProg = ix.programId.equals(TOKEN_PROGRAM_ID) || ix.programId.equals(TOKEN_2022_PROGRAM_ID);
    assert.ok(!(tokenProg && ix.data[0] === 12), 'TransferChecked must not follow Wrap');
  }
  assert.equal(ixs.length, 2, 'only ATA-create + Wrap');
  assert.equal(WRAP_ACQUIRE_STEPS.accounts.length, 9);
});

test('rewriteWrapClientError turns 0x6a simulation logs into short client copy', () => {
  const raw = `openzoo proxy error: Simulation failed.
Program ATokenGPvbdGVxr1b2hvZsiqW5xWHZ5efTNsLJA8knL invoke CreateIdempotent success
Program FrSERTNCPvTtaDS9AvQp9u1nYGzXDb3kC9MdL8Xxn2NE failed: custom program error: 0x6a
consumed 109 of 594144 compute units`;
  assert.equal(rewriteWrapClientError(raw), WRAP_TOO_FEW_ACCOUNTS);
  assert.equal(rewriteWrapClientError('custom program error: 106 NotEnoughAccounts'), WRAP_TOO_FEW_ACCOUNTS);
  assert.match(rewriteWrapClientError('TokenProgramMismatch 0x70'), /account 8/);
  assert.equal(rewriteWrapClientError('plain fetch failed'), 'plain fetch failed');
});
