import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BILLING_ORIGIN, SUBSCRIPTIONS_PAGE, subscriptionFile,
  saveSubscription, loadSubscription, clearSubscription,
  subscriptionPublicView, parseSubscriptionPaste,
  applySubscriptionHeaders, stripAuthorization,
  ingestBillingKeyResponse, billingTiers, fetchBillingKey,
  bearerFromAuthorization, verifySubscriptionKey,
} from '../lib/subscription.js';

function tmpSub() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oz-sub-')), 'subscription.json');
}

test('subscription file lives under ~/.openzoo', () => {
  assert.match(subscriptionFile('/home/you'), /\/\.openzoo\/subscription\.json$/);
});

test('parse paste accepts a key, a done URL, or session_id', () => {
  assert.deepEqual(parseSubscriptionPaste('  oz_live_abcDEF12  '), { key: 'oz_live_abcDEF12' });
  assert.deepEqual(
    parseSubscriptionPaste('https://zoo.openzoo.fun/billing/done?session=cs_live_abc'),
    { session: 'cs_live_abc' },
  );
  assert.deepEqual(
    parseSubscriptionPaste('https://zoo.openzoo.fun/billing/done?session_id=cs_live_xyz'),
    { session: 'cs_live_xyz' },
  );
  assert.equal(parseSubscriptionPaste('').error, 'empty');
  assert.equal(parseSubscriptionPaste('https://zoo.openzoo.fun/subscriptions').error, 'no session in URL');
  assert.equal(parseSubscriptionPaste('too short').error, 'not a key');
});

test('save/load never puts the secret on the public view', () => {
  const file = tmpSub();
  const prev = process.env.OPENZOO_SUBSCRIPTION_KEY;
  delete process.env.OPENZOO_SUBSCRIPTION_KEY;
  try {
    saveSubscription({ key: 'oz_secret_do_not_echo', tier: 'pro' }, file);
    const rec = loadSubscription(file);
    assert.equal(rec.key, 'oz_secret_do_not_echo');
    assert.equal(rec.tier, 'pro');
    const pub = subscriptionPublicView(rec);
    assert.equal(pub.active, true);
    assert.equal(pub.tier, 'pro');
    assert.equal(pub.label, 'Pro · no x402');
    assert.equal(JSON.stringify(pub).includes('oz_secret'), false);
    const ingested = ingestBillingKeyResponse({ key: 'oz_from_stripe', name: 'Ultra' }, { sessionId: 'cs_x' }, file);
    assert.equal(ingested.saved, true);
    assert.equal(ingested.active, true);
    assert.equal(JSON.stringify(ingested).includes('oz_from_stripe'), false);
    assert.equal(loadSubscription(file).key, 'oz_from_stripe');
    clearSubscription(file);
    assert.equal(loadSubscription(file), null);
    assert.equal(subscriptionPublicView(null).active, false);
  } finally {
    if (prev != null) process.env.OPENZOO_SUBSCRIPTION_KEY = prev;
    else delete process.env.OPENZOO_SUBSCRIPTION_KEY;
  }
});

test('pending key poll does not invent a saved key', () => {
  const file = tmpSub();
  const out = ingestBillingKeyResponse({ ok: true, pending: true, paymentStatus: 'unpaid' }, {}, file);
  assert.equal(out.pending, true);
  assert.equal(out.saved, false);
  assert.equal(loadSubscription(file), null);
});

test('subscription headers are a Bearer and strip cleanly for x402 retry', () => {
  const withKey = applySubscriptionHeaders({ 'content-type': 'application/json' }, { key: 'oz_k' });
  assert.equal(withKey.authorization, 'Bearer oz_k');
  assert.equal(applySubscriptionHeaders({}, null).authorization, undefined);
  const stripped = stripAuthorization({ authorization: 'Bearer oz_k', 'X-PAYMENT': 'p' });
  assert.equal(stripped.authorization, undefined);
  assert.equal(stripped['X-PAYMENT'], 'p');
});

test('env OPENZOO_SUBSCRIPTION_KEY wins over a missing file', () => {
  const prev = process.env.OPENZOO_SUBSCRIPTION_KEY;
  process.env.OPENZOO_SUBSCRIPTION_KEY = 'oz_env_key';
  process.env.OPENZOO_SUBSCRIPTION_TIER = 'basic';
  try {
    const rec = loadSubscription(path.join(os.tmpdir(), 'oz-no-such-sub.json'));
    assert.equal(rec.key, 'oz_env_key');
    assert.equal(rec.tier, 'basic');
    assert.equal(rec.source, 'env');
  } finally {
    if (prev != null) process.env.OPENZOO_SUBSCRIPTION_KEY = prev;
    else delete process.env.OPENZOO_SUBSCRIPTION_KEY;
    delete process.env.OPENZOO_SUBSCRIPTION_TIER;
  }
});

test('empty session does not hit the network', async () => {
  const body = await fetchBillingKey('');
  assert.equal(body.ok, false);
  assert.equal(body.error, 'session required');
});

test('Bearer is taken from Authorization only', () => {
  assert.equal(bearerFromAuthorization({ authorization: 'Bearer oz_live_abc' }), 'oz_live_abc');
  assert.equal(bearerFromAuthorization({ Authorization: 'bearer oz_x' }), 'oz_x');
  assert.equal(bearerFromAuthorization({}), '');
  assert.equal(bearerFromAuthorization({ authorization: 'Basic x' }), '');
});

test('verifySubscriptionKey fails closed on empty, 401, expired', async () => {
  assert.equal((await verifySubscriptionKey('')).ok, false);
  const fake = {
    status: 401,
    json: async () => ({ ok: false, error: 'unauthorized' }),
  };
  const bad = await verifySubscriptionKey('oz_live_not_real_xxxxxx', {
    fetchImpl: async () => fake,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);
  const expired = await verifySubscriptionKey('oz_live_old_key_xxxxxx', {
    fetchImpl: async () => ({ status: 200, json: async () => ({ ok: false, error: 'expired' }) }),
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.status, 401);
  const good = await verifySubscriptionKey('oz_live_good_key_xxxxxx', {
    fetchImpl: async (url, init) => {
      assert.match(url, /\/api\/billing\/verify$/);
      assert.equal(init.method, 'POST');
      assert.match(init.headers.authorization, /^Bearer oz_live_good/);
      return { status: 200, json: async () => ({ ok: true, tier: 'pro', tierName: 'Pro' }) };
    },
  });
  assert.equal(good.ok, true);
  assert.equal(good.tier, 'pro');
});

test('live POST /api/billing/verify refuses a fake key', async () => {
  const r = await verifySubscriptionKey('oz_live_this_is_not_a_real_key_xxxxxx');
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test('live GET /api/billing/tiers is the price source of truth', async () => {
  const body = await billingTiers();
  assert.equal(body.ok, true);
  const ids = body.tiers.map((t) => t.id);
  assert.deepEqual(ids, ['basic', 'pro', 'ultra']);
  for (const t of body.tiers) {
    assert.ok(Number(t.monthlyCents) > 0, `${t.id} must have a live price`);
    assert.ok(t.name);
  }
  assert.match(BILLING_ORIGIN, /zoo\.openzoo\.fun/);
  assert.match(SUBSCRIPTIONS_PAGE, /\/subscriptions$/);
});
