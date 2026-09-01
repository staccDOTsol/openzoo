import assert from 'node:assert/strict';
import test from 'node:test';
import { signMoonPayUrl, moonpayUsdcOnrampLink, moonpayKeys } from '../lib/moonpayOnramp.js';
import { withOnrampLink } from '../lib/stripeOnramp.js';

test('MoonPay docs signing vector', () => {
  const unsigned = 'https://buy-sandbox.moonpay.com/?apiKey=pk_test_DocsVector00&currencyCode=eth&walletAddress=0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe';
  const signed = signMoonPayUrl(unsigned, 'sk_test_DocsVector00');
  assert.equal(
    signed,
    `${unsigned}&signature=${encodeURIComponent('oIJxSghyzll/BLhUFdQZhkxf7DAS8REFaWr/ibO+K8Q=')}`,
  );
});

test('moonpayUsdcOnrampLink is null without keys', () => {
  const prev = {
    pk: process.env.MOONPAY_PUBLISHABLE_KEY,
    sk: process.env.MOONPAY_SECRET_KEY,
    file: process.env.MOONPAY_KEY_FILE,
    pkf: process.env.MOONPAY_PK_FILE,
    skf: process.env.MOONPAY_SECRET_FILE,
  };
  process.env.MOONPAY_PUBLISHABLE_KEY = '';
  process.env.MOONPAY_SECRET_KEY = '';
  process.env.MOONPAY_KEY_FILE = '/tmp/openzoo-no-moonpay.json';
  process.env.MOONPAY_PK_FILE = '/tmp/openzoo-no-moonpay.pk';
  process.env.MOONPAY_SECRET_FILE = '/tmp/openzoo-no-moonpay.key';
  try {
    assert.equal(moonpayKeys(), null);
    assert.equal(moonpayUsdcOnrampLink({ solana: 'Abc', usd: 30 }), null);
  } finally {
    for (const [k, v] of Object.entries({
      MOONPAY_PUBLISHABLE_KEY: prev.pk,
      MOONPAY_SECRET_KEY: prev.sk,
      MOONPAY_KEY_FILE: prev.file,
      MOONPAY_PK_FILE: prev.pkf,
      MOONPAY_SECRET_FILE: prev.skf,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('withOnrampLink no longer prepends MoonPay', async () => {
  process.env.MOONPAY_PUBLISHABLE_KEY = 'pk_live_testonly';
  process.env.MOONPAY_SECRET_KEY = 'sk_live_testonly';
  process.env.OPENZOO_WHOP_CHECKOUT = 'https://whop.com/checkout/plan_test';
  try {
    const out = await withOnrampLink('openzoo wallet underfunded.', {
      solana: 'CBnJMDJeso1anaaddr111111111111111111oTTy',
      usd: 0.07,
    });
    assert.match(out, /Hey — buy this:/);
    assert.ok(!/moonpay\.com/.test(out));
    assert.ok(!/crypto\.link\.com/.test(out));
  } finally {
    delete process.env.MOONPAY_PUBLISHABLE_KEY;
    delete process.env.MOONPAY_SECRET_KEY;
    delete process.env.OPENZOO_WHOP_CHECKOUT;
  }
});