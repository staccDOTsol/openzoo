import test from 'node:test';
import assert from 'node:assert/strict';
import { priceHoldings, formatHoldingMoney } from '../lib/livestatus.js';

test('USDC counts as on-chain dollars without a quote', () => {
  const { chainUsd, holdings } = priceHoldings([
    { symbol: 'USDC', ui: 2.5, chain: 'solana' },
    { symbol: 'TOKEN', ui: 18584, chain: 'solana' },
  ]);
  assert.equal(chainUsd, 2.5);
  assert.equal(holdings[0].usd, 2.5);
  assert.equal(holdings[1].usd, null);
  assert.equal(formatHoldingMoney(holdings[0]), '2.5 USDC  ($2.50)');
  assert.equal(formatHoldingMoney(holdings[1]), '18584 TOKEN');
});

test('402 tokenUsd turns a TOKEN pile into money', () => {
  const { chainUsd, holdings } = priceHoldings(
    [{ symbol: 'TOKEN', ui: 18584, chain: 'solana' }],
    { TOKEN: 0.00022906 },
  );
  assert.ok(Math.abs(chainUsd - 18584 * 0.00022906) < 1e-9);
  assert.match(formatHoldingMoney(holdings[0]), /TOKEN\s+\(\$4\.26\)/);
});
