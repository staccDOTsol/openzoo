/**
 * Stripe subscription keys for the zoo API — the other pay lane next to
 * wallet/x402. The live billing API is zoo.openzoo.fun; this file does not
 * invent a second backend.
 *
 * After checkout the site lands on /billing/done?session=<cs_…> and polls
 * GET /api/billing/key?session=… until Stripe confirms. That response is how
 * a desktop client receives the key (no Stripe cookie on Electron). A user
 * who already subscribed can paste the same key, or that success URL.
 *
 * Use: Authorization: Bearer <key> against x402-tokens.fly.dev — no 402
 * signing. Wallet/x402 stays if no key is stored.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BILLING_ORIGIN = 'https://zoo.openzoo.fun';
export const SUBSCRIPTIONS_PAGE = 'https://zoo.openzoo.fun/subscriptions';

export function subscriptionFile(home = os.homedir()) {
  return process.env.OPENZOO_SUBSCRIPTION_PATH
    || path.join(home, '.openzoo', 'subscription.json');
}

function titleCase(id) {
  const s = String(id || '').trim();
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function asKey(v) {
  return String(v || '').trim();
}

/** Persist a subscription key (chmod 600). Never log the value. */
export function saveSubscription(rec, file = subscriptionFile()) {
  const key = asKey(rec?.key);
  if (!key) return null;
  const payload = {
    key,
    tier: rec.tier ? String(rec.tier) : null,
    tierName: rec.tierName ? String(rec.tierName) : (rec.tier ? titleCase(rec.tier) : null),
    sessionId: rec.sessionId ? String(rec.sessionId) : null,
    savedAt: Date.now(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
  fs.renameSync(tmp, file);
  cached = { file, mtime: fs.statSync(file).mtimeMs, data: payload };
  return payload;
}

export function clearSubscription(file = subscriptionFile()) {
  try { fs.unlinkSync(file); } catch { /* already gone */ }
  if (cached.file === file) cached = { file: '', mtime: 0, data: null };
}

let cached = { file: '', mtime: 0, data: null };

export function loadSubscription(file = subscriptionFile()) {
  const envKey = asKey(process.env.OPENZOO_SUBSCRIPTION_KEY);
  if (envKey) {
    return {
      key: envKey,
      tier: process.env.OPENZOO_SUBSCRIPTION_TIER || null,
      tierName: process.env.OPENZOO_SUBSCRIPTION_TIER
        ? titleCase(process.env.OPENZOO_SUBSCRIPTION_TIER)
        : null,
      sessionId: null,
      source: 'env',
    };
  }
  try {
    const st = fs.statSync(file);
    if (cached.file === file && cached.mtime === st.mtimeMs && cached.data) return cached.data;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!asKey(data?.key)) {
      cached = { file, mtime: st.mtimeMs, data: null };
      return null;
    }
    const rec = {
      key: asKey(data.key),
      tier: data.tier || null,
      tierName: data.tierName || (data.tier ? titleCase(data.tier) : null),
      sessionId: data.sessionId || null,
      source: 'file',
    };
    cached = { file, mtime: st.mtimeMs, data: rec };
    return rec;
  } catch {
    return null;
  }
}

/** Public HUD/wallet view — never includes the secret. */
export function subscriptionPublicView(sub = loadSubscription()) {
  if (!asKey(sub?.key)) return { active: false };
  const name = String(sub.tierName || titleCase(sub.tier) || '').trim();
  return {
    active: true,
    tier: sub.tier || null,
    tierName: name || null,
    label: name ? `${name} · no x402` : 'Subscription key · no x402',
  };
}

/**
 * A paste is either the bearer key itself, or the site's success URL
 * (`/billing/done?session=cs_…`). session_id is accepted too — Stripe's
 * default query name — but the live page uses `session`.
 */
export function parseSubscriptionPaste(text) {
  const raw = String(text || '').trim();
  if (!raw) return { error: 'empty' };
  let session = '';
  try {
    if (/^https?:\/\//i.test(raw) || raw.includes('session=')) {
      const url = new URL(raw, BILLING_ORIGIN);
      session = url.searchParams.get('session') || url.searchParams.get('session_id') || '';
    }
  } catch { /* not a URL */ }
  if (!session) {
    const m = /(?:session_id|session)=([A-Za-z0-9_]+)/.exec(raw);
    if (m) session = m[1];
  }
  if (session) return { session };
  if (/^https?:\/\//i.test(raw)) return { error: 'no session in URL' };
  if (raw.length < 8 || /\s/.test(raw)) return { error: 'not a key' };
  return { key: raw };
}

export function applySubscriptionHeaders(headers = {}, sub = loadSubscription()) {
  const key = asKey(sub?.key);
  if (!key) return headers;
  return { ...headers, authorization: `Bearer ${key}` };
}

export function stripAuthorization(headers = {}) {
  const out = { ...headers };
  delete out.authorization;
  delete out.Authorization;
  return out;
}

async function billingJson(url, init) {
  const r = await fetch(url, init);
  const body = await r.json().catch(() => ({}));
  return { http: r.status, body };
}

export async function billingTiers() {
  const { http, body } = await billingJson(`${BILLING_ORIGIN}/api/billing/tiers`);
  if (!body?.ok || !Array.isArray(body.tiers)) {
    throw new Error(body?.error || `tiers HTTP ${http}`);
  }
  return body;
}

export async function billingCheckout(tier) {
  const id = String(tier || '').trim();
  if (!id) throw new Error('tier required');
  const { http, body } = await billingJson(`${BILLING_ORIGIN}/api/billing/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tier: id }),
  });
  if (!body?.ok || !body.url) {
    throw new Error(body?.error || `checkout HTTP ${http}`);
  }
  return { ok: true, url: body.url, sessionId: body.sessionId || null, tier: id };
}

/** Poll the same endpoint the public /billing/done page uses. */
export async function fetchBillingKey(session) {
  const sid = String(session || '').trim();
  if (!sid) return { ok: false, error: 'session required' };
  const { body } = await billingJson(
    `${BILLING_ORIGIN}/api/billing/key?session=${encodeURIComponent(sid)}`,
  );
  return body && typeof body === 'object' ? body : { ok: false, error: 'empty key response' };
}

/**
 * If the live key endpoint returned a key, persist it and return a public
 * view (the secret stays on disk). Pending/error bodies pass through.
 */
export function ingestBillingKeyResponse(body, extra = {}, file = subscriptionFile()) {
  const key = asKey(body?.key);
  if (!key) {
    if (body?.pending) return { ok: true, pending: true, saved: false };
    return {
      ok: false,
      pending: false,
      saved: false,
      error: body?.error || 'no key yet',
    };
  }
  const rec = saveSubscription({
    key,
    tier: body.tier || extra.tier || null,
    tierName: body.tierName || body.name || extra.tierName || null,
    sessionId: extra.sessionId || extra.session || null,
  }, file);
  return { ok: true, pending: false, saved: true, ...subscriptionPublicView(rec) };
}
