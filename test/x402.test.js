import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  parse402, pickAccept, railOf, buildPayment, receiptLine, decodeSettleHeader,
} from '../lib/x402.js';
import { buildEvmPayment } from '../lib/evm.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Captured live from x402-tokens.fly.dev on 2026-08-14 (unfunded POST /v1/chat/completions).
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'live-402.json'), 'utf8'));

test('parse402 accepts the captured live body', () => {
  const q = parse402(fixture);
  assert.equal(q.x402Version, 1);
  assert.ok(q.accepts.length >= 2);
});

test('parse402 rejects non-402 bodies', () => {
  assert.throws(() => parse402({ error: 'nope' }));
  assert.throws(() => parse402({ x402Version: 1, accepts: [] }));
});

test('pickAccept prefers the yUSDCx solana rail', () => {
  const a = pickAccept(fixture, 'yUSDCx');
  assert.equal(a.extra.symbol, 'yUSDCx');
  assert.equal(a.asset, '6ZjjxcoicqM4nniddkuPVwew4PDwY3swbfHsGbCuLuTv');
  assert.equal(railOf(a), 'solana');
});

test('pickAccept falls back to the first solana row for unknown symbols', () => {
  const a = pickAccept(fixture, 'NOPE');
  assert.equal(railOf(a), 'solana');
});

test('pickAccept prefers solana over EVM rows, and gates robinhood', () => {
  const evmRow = {
    scheme: 'exact', network: 'eip155:8453', asset: '0x' + '11'.repeat(20),
    maxAmountRequired: '100', payTo: '0x' + '22'.repeat(20), extra: {},
  };
  const rhRow = { ...evmRow, network: 'eip155:4663' };
  const solRow = fixture.accepts[0];

  const mixed = { x402Version: 1, accepts: [evmRow, solRow] };
  assert.equal(railOf(pickAccept(mixed, 'yUSDCx')), 'solana');

  const evmOnly = { x402Version: 1, accepts: [evmRow] };
  assert.equal(railOf(pickAccept(evmOnly, 'yUSDCx')), 'base');

  const rhOnly = { x402Version: 1, accepts: [rhRow] };
  assert.throws(() => pickAccept(rhOnly, 'yUSDCx'), /OPENZOO_ENABLE_RH/);
  assert.equal(railOf(pickAccept(rhOnly, 'yUSDCx', { allowRH: true })), 'robinhood');
});

test('forceRail (OPENZOO_RAIL) pins selection to the named rail', () => {
  const baseRow = {
    scheme: 'exact', network: 'eip155:8453', asset: '0x' + '11'.repeat(20),
    maxAmountRequired: '100', payTo: '0x' + '22'.repeat(20), extra: {},
  };
  const rhRow = { ...baseRow, network: 'eip155:4663' };
  const solRow = fixture.accepts[0];
  const mixed = { x402Version: 1, accepts: [solRow, baseRow, rhRow] };

  // Forced rail present: picked even though Solana rows exist.
  assert.equal(railOf(pickAccept(mixed, 'yUSDCx', { forceRail: 'base' })), 'base');
  assert.equal(railOf(pickAccept(mixed, 'yUSDCx', { forceRail: 'solana' })), 'solana');
  // Forcing robinhood is explicit intent — no allowRH needed.
  assert.equal(railOf(pickAccept(mixed, 'yUSDCx', { forceRail: 'robinhood' })), 'robinhood');
  // Symbol preference still applies within the forced rail.
  assert.equal(pickAccept(mixed, 'yUSDCx', { forceRail: 'solana' }).extra.symbol, 'yUSDCx');
});

test('forceRail errors clearly when the live 402 does not offer that rail', () => {
  const solOnly = { x402Version: 1, accepts: [fixture.accepts[0]] };
  assert.throws(
    () => pickAccept(solOnly, 'yUSDCx', { forceRail: 'base' }),
    /OPENZOO_RAIL=base but the live 402 offers no base rail \(offered: solana\)/,
  );
  assert.throws(
    () => pickAccept(solOnly, 'yUSDCx', { forceRail: 'plasma' }),
    /not a rail — use solana, base or robinhood/,
  );
});

test('buildPayment constructs the exact solana X-PAYMENT the gateway documents', () => {
  const accept = pickAccept(fixture, 'yUSDCx');
  const keypair = Keypair.generate();
  const recentBlockhash = Keypair.generate().publicKey.toBase58(); // any 32-byte b58
  const decimals = 6; // injected for the offline test; live path reads the mint

  const p = buildPayment({
    accept, decimals, programId: TOKEN_2022_PROGRAM_ID, recentBlockhash, keypair,
  });

  // Header envelope: base64 JSON, v1, scheme/network echoed from the 402 row.
  const env = JSON.parse(Buffer.from(p.header, 'base64').toString('utf8'));
  assert.equal(env.x402Version, 1);
  assert.equal(env.scheme, 'exact');
  assert.equal(env.network, accept.network);
  assert.ok(env.payload.transaction);

  // The transaction itself: feePayer = gateway's, one TransferChecked, owner-signed only.
  const tx = Transaction.from(Buffer.from(env.payload.transaction, 'base64'));
  assert.equal(tx.feePayer.toBase58(), accept.extra.feePayer);
  assert.equal(tx.instructions.length, 1);
  const ix = tx.instructions[0];
  assert.ok(ix.programId.equals(TOKEN_2022_PROGRAM_ID));
  // TransferChecked layout: [12, amount u64 LE, decimals u8]
  assert.equal(ix.data[0], 12);
  assert.equal(ix.data.readBigUInt64LE(1), BigInt(accept.maxAmountRequired));
  assert.equal(ix.data[9], decimals);
  // keys: source ATA, mint, dest ATA (payTo's), owner
  const srcAta = getAssociatedTokenAddressSync(new PublicKey(accept.asset), keypair.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const dstAta = getAssociatedTokenAddressSync(new PublicKey(accept.asset), new PublicKey(accept.payTo), true, TOKEN_2022_PROGRAM_ID);
  assert.equal(ix.keys[0].pubkey.toBase58(), srcAta.toBase58());
  assert.equal(ix.keys[1].pubkey.toBase58(), accept.asset);
  assert.equal(ix.keys[2].pubkey.toBase58(), dstAta.toBase58());
  assert.equal(ix.keys[3].pubkey.toBase58(), keypair.publicKey.toBase58());
  // owner signed; feePayer slot empty (facilitator signs at settle)
  const ownerSig = tx.signatures.find((s) => s.publicKey.equals(keypair.publicKey));
  assert.ok(ownerSig.signature);
  const feeSig = tx.signatures.find((s) => s.publicKey.toBase58() === accept.extra.feePayer);
  assert.equal(feeSig.signature, null);
});

test('buildEvmPayment signs an EIP-3009 authorization with raw units (no decimal scaling)', async () => {
  const accept = {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    maxAmountRequired: '250',
    payTo: '0x' + 'ab'.repeat(20),
    maxTimeoutSeconds: 120,
    extra: { name: 'USD Coin', version: '2' },
  };
  const p = await buildEvmPayment({ accept, evmPrivateKey: `0x${'42'.repeat(32)}` });
  const env = JSON.parse(Buffer.from(p.header, 'base64').toString('utf8'));
  assert.equal(env.x402Version, 1);
  assert.equal(env.network, 'eip155:8453');
  assert.match(env.payload.signature, /^0x[0-9a-f]{130}$/);
  assert.equal(env.payload.authorization.value, '250'); // raw, straight from the 402
  assert.equal(env.payload.authorization.from, p.from);
  assert.match(env.payload.authorization.nonce, /^0x[0-9a-f]{64}$/);
});

test('receiptLine covers both pricing bases and names the rail', () => {
  const quote = pickAccept(fixture, 'yUSDCx');
  const line = receiptLine(quote, { transaction: 'SIG123' });
  assert.match(line, /^paid \$0\.0000\d+ \(at OpenRouter price — nothing to compress; bind a corpus to save\) · rail solana · tx SIG123$/);
  assert.doesNotMatch(line, /markup 3/);
  assert.doesNotMatch(line, /3×/);

  const leftoverMarkup = {
    ...quote,
    extra: { ...quote.extra, markup: 3, directUsd: undefined, savedUsd: undefined, savesVsDirect: undefined },
  };
  assert.doesNotMatch(receiptLine(leftoverMarkup, null), /markup 3/);

  const counterfactual = {
    ...quote,
    extra: {
      ...quote.extra,
      pricing: 'counterfactual',
      billedUsd: 0.0021,
      directUsd: 0.0199,
      savedUsd: 0.0178,
      savesVsDirect: 9.48,
    },
  };
  assert.match(receiptLine(counterfactual, null), /9\.5× cheaper than direct/);
});

test('decodeSettleHeader tolerates junk', () => {
  assert.equal(decodeSettleHeader(null), null);
  assert.equal(decodeSettleHeader('%%%'), null);
  const enc = Buffer.from(JSON.stringify({ transaction: 'abc' })).toString('base64');
  assert.deepEqual(decodeSettleHeader(enc), { transaction: 'abc' });
});
