import assert from 'node:assert/strict';
import test from 'node:test';
import { withOnrampLink, stripeUsdcOnrampLink, resetOnrampCache } from '../lib/stripeOnramp.js';

function restoreEnv(prev, prevF) {
  if (prev === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = prev;
  if (prevF === undefined) delete process.env.STRIPE_SECRET_FILE;
  else process.env.STRIPE_SECRET_FILE = prevF;
}

test('withOnrampLink is a no-op when there is no solana dest', async () => {
  const s = 'openzoo wallet underfunded. send USDC to Abc.';
  assert.equal(await withOnrampLink(s, { solana: '', usd: 1 }), s);
  assert.equal(await stripeUsdcOnrampLink({ solana: '' }), null);
});

test('withOnrampLink is Whop copy-paste, no Stripe URL', async () => {
  process.env.OPENZOO_WHOP_CHECKOUT = 'https://whop.com/checkout/plan_test';
  try {
    const s = 'openzoo wallet underfunded — payment did not settle. This call needs ≈$0.0736. Fund it.';
    const out = await withOnrampLink(s, {
      solana: 'CBnJMDJeso1anaaddr111111111111111111oTTy',
      usd: 0.0736,
    });
    assert.match(out, /^Hey — buy this: https:\/\/whop\.com\/checkout\/plan_test/);
    assert.match(out, /Copy-paste THIS Solana address into "what is your Solana address\?" so it ties to your account:/);
    assert.match(out, /CBnJMDJeso1anaaddr111111111111111111oTTy/);
    assert.match(out, /underfunded/);
    assert.ok(!/crypto\.link\.com/.test(out));
    assert.ok(!/moonpay\.com/.test(out));
  } finally {
    delete process.env.OPENZOO_WHOP_CHECKOUT;
  }
});

test('withOnrampLink defaults to the OpenZoo Whop product URL', async () => {
  const prev = process.env.OPENZOO_WHOP_CHECKOUT;
  const prevU = process.env.OPENZOO_WHOP_URL;
  delete process.env.OPENZOO_WHOP_CHECKOUT;
  delete process.env.OPENZOO_WHOP_URL;
  try {
    const out = await withOnrampLink('underfunded', {
      solana: 'CBnJMDJeso1anaaddr111111111111111111oTTy',
    });
    assert.match(out, /^Hey — buy this: https:\/\/whop\.com\/staccoverflow\/openzoo/);
  } finally {
    if (prev === undefined) delete process.env.OPENZOO_WHOP_CHECKOUT;
    else process.env.OPENZOO_WHOP_CHECKOUT = prev;
    if (prevU === undefined) delete process.env.OPENZOO_WHOP_URL;
    else process.env.OPENZOO_WHOP_URL = prevU;
  }
});

test('stripe 400 does not swallow into a URL-less success', async () => {
  const prev = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  resetOnrampCache();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { type: 'invalid_request_error', code: 'parameter_unknown', message: 'Received unknown parameter: wallet_addresses[base]' } }),
  });
  const err = console.error;
  const logs = [];
  console.error = (...a) => logs.push(a.join(' '));
  try {
    assert.equal(await stripeUsdcOnrampLink({ solana: 'Abc', usd: 5 }), null);
    assert.match(logs.join('\n'), /parameter_unknown/);
  } finally {
    globalThis.fetch = orig;
    console.error = err;
    restoreEnv(prev, process.env.STRIPE_SECRET_FILE);
    resetOnrampCache();
  }
});
