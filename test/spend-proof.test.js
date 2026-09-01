import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  explorerUrl,
  decodeMemo,
  formatSpendFooter,
  spendChipLabel,
  attachX402Proof,
  collectTxs,
} from '../lib/spendProof.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const SOL_SIG = '2YgJg97DnK4cuvhE1jhCiwYSfakeSettleSigSpendProofxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const BASE_SIG = '0x' + 'ab'.repeat(32);

test('solscan link for a solana settle sig', () => {
  const url = explorerUrl(SOL_SIG, { rail: 'solana' });
  assert.equal(url, `https://solscan.io/tx/${SOL_SIG}`);
  const footer = formatSpendFooter({
    billedUsd: 0.001,
    directUsd: 0.003,
    spent: 0.001,
    would: 0.003,
    saved: 0.002,
    pct: 66.6,
    x402: { tx: SOL_SIG, rail: 'solana' },
  });
  assert.match(footer, new RegExp(`tx https://solscan.io/tx/${SOL_SIG}`));
});

test('basescan link for a base settle sig', () => {
  const url = explorerUrl(BASE_SIG, { rail: 'base' });
  assert.equal(url, `https://basescan.org/tx/${BASE_SIG}`);
  const footer = formatSpendFooter({
    spent: 0,
    would: 0,
    saved: 0,
    pct: 0,
    tx: BASE_SIG,
    rail: 'base',
  });
  assert.match(footer, new RegExp(`tx https://basescan.org/tx/${BASE_SIG}`));
  assert.doesNotMatch(footer, /solscan/i);
});

test('no explorer link when tx is missing', () => {
  assert.equal(explorerUrl(null, { rail: 'solana' }), null);
  assert.equal(explorerUrl('', { rail: 'solana' }), null);
  assert.equal(explorerUrl('   ', { rail: 'solana' }), null);
  const footer = formatSpendFooter({
    billedUsd: 0.01,
    directUsd: 0.01,
    spent: 0.01,
    would: 0.01,
    saved: 0,
    pct: 0,
    x402: { billedUsd: 0.01, ownerSignature: 'not-a-settle-sig' },
  });
  assert.doesNotMatch(footer, /^tx /m);
  assert.doesNotMatch(footer, /solscan|basescan/i);
  assert.doesNotMatch(footer, /not-a-settle-sig/);
});

test('x402 offer-set memo decodes who/asset/amount/resource/network', () => {
  const memo = 'x402:1/exact/solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/AuthPdaPayTo11111111111111111111111111111/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/10000/https://x402-tokens.fly.dev/v1/chat/completions/60/PoolQuote11111111111111111111111111111111';
  const d = decodeMemo(memo);
  assert.equal(d.kind, 'offer_set');
  assert.match(d.decoded, /10000/);
  assert.match(d.decoded, /AuthPdaPayTo/);
  assert.match(d.decoded, /EPjFWdd5Aufq/);
  assert.match(d.decoded, /chat\/completions/);
  assert.match(d.decoded, /solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/);
  assert.match(d.proves, /paid to AuthPdaPayTo/i);
  assert.match(d.proves, /10000 units/i);
  assert.doesNotMatch(d.proves, /leaf of a merkle tree/i);
});

test('hex nonce (32 hex chars) is uniqueness, not a merkle proof', () => {
  const nonce = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const d = decodeMemo(nonce);
  assert.equal(d.kind, 'nonce');
  assert.match(d.decoded, /uniqueness nonce a1b2c3d4e5f60718293a4b5c6d7e8f90/);
  assert.match(d.proves, /uniqueness nonce/i);
  assert.match(d.proves, /distinct transactions/i);
  assert.match(d.proves, /not a merkle membership proof/i);
  assert.doesNotMatch(d.proves, /leaf of a merkle tree/i);
  assert.doesNotMatch(d.proves, /verify inclusion/i);
});

test('random hex does not get a false merkle claim', () => {
  const d32 = decodeMemo('deadbeef'.repeat(4));
  assert.equal(d32.kind, 'nonce');
  assert.doesNotMatch(d32.decoded + d32.proves, /leaf of a merkle tree/i);
  assert.doesNotMatch(d32.proves, /anyone with the tree can verify inclusion/i);

  const d64 = decodeMemo('ab'.repeat(32));
  assert.equal(d64.kind, 'leaf');
  assert.match(d64.decoded, /x402 leaf ababab/);
  assert.match(d64.proves, /sha256\(JSON\.stringify\(\[v, model, promptHash, gross, asset, resource\]\)\)/);
  assert.match(d64.proves, /quoted deal/i);
  assert.match(d64.proves, /does not include the model output|did not exist at quote time/i);
  assert.match(d64.proves, /not a merkle-tree membership proof/i);
  assert.doesNotMatch(d64.proves, /leaf of a merkle tree/i);
  assert.doesNotMatch(d64.proves, /verify inclusion/i);
  assert.match(d64.proves, /\/v1\/receipts\/proof\?leaf=abab/);
});

test('JSON merkle leaf/proof/root is the only merkle claim', () => {
  const d = decodeMemo(JSON.stringify({
    leaf: 'aa'.repeat(32),
    proof: ['bb'.repeat(32)],
    root: 'cc'.repeat(32),
  }));
  assert.equal(d.kind, 'merkle');
  assert.match(d.proves, /leaf of a merkle tree/i);
  assert.match(d.proves, /verify inclusion/i);
});

test('spendChipLabel is spent · saved · %/multiplier', () => {
  assert.equal(
    spendChipLabel({ spent: 10.681, would: 11.3706, saved: 0.6896, pct: 6 }),
    '$10.68 · saved $0.69 · 6%/1.06×',
  );
  assert.equal(
    spendChipLabel({ billedUsd: 0.00115, directUsd: 0.002874 }),
    '$0.0011 · saved $0.0017 · 60%/2.50×',
  );
});

test('formatSpendFooter shape: spend lines then tx, memo, proves', () => {
  const nonce = '0123456789abcdef0123456789abcdef';
  const footer = formatSpendFooter({
    billedUsd: 0.012345,
    directUsd: 0.04,
    spent: 0.1,
    would: 0.4,
    saved: 0.3,
    pct: 75,
    balance: 12.5,
    x402: { tx: SOL_SIG, rail: 'solana', memo: nonce },
  });
  const lines = footer.split('\n');
  assert.equal(lines[0], '');
  assert.equal(lines[1], '');
  assert.equal(lines[2], '::oz-spend::$0.10 · saved $0.30 · 75%/4.00×');
  assert.equal(lines[3], 'this call $0.012345 · OpenRouter $0.040000');
  assert.equal(lines[4], 'spent $0.1000 · balance $12.50 · OpenRouter would $0.4000 · saved $0.3000 (75%)');
  assert.equal(lines[5], `tx https://solscan.io/tx/${SOL_SIG}`);
  assert.equal(lines[6], `memo uniqueness nonce ${nonce}`);
  assert.match(lines[7], /^proves This is a uniqueness nonce/);
});

test('formatSpendFooter lists the last settle, not the whole tool-loop wall', () => {
  const txs = Array.from({ length: 12 }, (_, i) => `0x${String(i).padStart(64, 'a')}`);
  const footer = formatSpendFooter({
    billedUsd: 0.02,
    directUsd: 0.06,
    spent: 1,
    would: 3,
    saved: 2,
    pct: 66,
    x402: { txs, tx: txs[txs.length - 1], rail: 'base' },
  });
  const txLines = footer.split('\n').filter((l) => /^tx /.test(l));
  assert.equal(txLines.length, 1);
  assert.match(txLines[0], /\(\+11 earlier\)/);
  assert.equal((footer.match(/basescan\.org\/tx/g) || []).length, 1);
});

test('attachX402Proof copies settle tx + memo onto data.x402', () => {
  const data = { object: 'chat.completion', x402: { billedUsd: 0.01 } };
  attachX402Proof(data, { tx: SOL_SIG, memo: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', rail: 'solana' });
  assert.equal(data.x402.tx, SOL_SIG);
  assert.deepEqual(data.x402.txs, [SOL_SIG]);
  assert.equal(data.x402.memo, 'a1b2c3d4e5f60718293a4b5c6d7e8f90');
  assert.equal(data.x402.rail, 'solana');
  assert.equal(data.x402.billedUsd, 0.01);
});

test('attachX402Proof does not invent a sig when receipt.tx is empty', () => {
  const data = { object: 'chat.completion', x402: { billedUsd: 0.01 } };
  attachX402Proof(data, { tx: null, memo: null });
  assert.equal(data.x402.tx, undefined);
  assert.equal(collectTxs(data.x402).length, 0);
});

test('spend chip tag uses session spent when this-call billed is zero', () => {
  const footer = formatSpendFooter({
    billedUsd: 0,
    directUsd: 0,
    spent: 2.152,
    would: 6.8,
    saved: 4.648,
    pct: 68,
  });
  assert.match(footer, /^\n\n::oz-spend::\$2\.15 · saved \$4\.65 · 68%\/3\.16×\n/);
  assert.match(footer, /this call \$0\.000000/);
  assert.match(footer, /spent \$2\.1520/);
});

test('formatSpendFooter never throws', () => {
  assert.doesNotThrow(() => formatSpendFooter(undefined));
  assert.doesNotThrow(() => formatSpendFooter({ x402: { tx: { nope: true }, memo: 1n } }));
  const s = formatSpendFooter();
  assert.match(s, /^\n\n::oz-spend::/);
  assert.match(s, /spent \$0\.0000/);
});

test('proxy JSON path and overlay are wired to spendProof', () => {
  const proxy = readFileSync(path.join(root, 'lib', 'proxy.js'), 'utf8');
  assert.match(proxy, /attachX402Proof/);
  assert.match(proxy, /receipt\.tx/);
  const overlay = readFileSync(path.join(root, 'lib', 'cursorbackend.js'), 'utf8');
  assert.match(overlay, /formatSpendFooter/);
  assert.match(overlay, /mergeTurnProof/);
  const pay = readFileSync(path.join(root, 'lib', 'pay.js'), 'utf8');
  assert.match(pay, /memo: payment\?\.memo \|\| accept\?\.extra\?\.memo/);
  assert.doesNotMatch(pay, /tx:\s*payment\.ownerSignature/);
});
