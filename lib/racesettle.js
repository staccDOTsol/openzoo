/**
 * Fly gateway race: one POST { race, race_need, tier }.
 * User pays for every entrant we actually launched. Failures still cost us
 * (OpenRouter was paid). race_unused on a receipt is informational — do not
 * treat it as a user refund or shrink HUD cogs to hide a house loss.
 * HUD embers when cogs > spent.
 */

export const FLY_GATEWAY_HOST = 'x402-tokens.fly.dev';
export const RACE_NO_CREDIT = '(race: not enough prepaid credit — shrink N or top up, rather than fire on $0)';

const FLY_RE = /x402-tokens\.fly\.dev/i;

/** Completions door is the Fly gateway (sidecar → x402-tokens.fly.dev). */
export function isFlyGatewayUpstream(upstream) {
  return FLY_RE.test(String(upstream || ''));
}

/**
 * Whether this completions door will honor `race:` on POST /chat/completions.
 * Fly (and a test mock that advertises it) → true. Old sidecar / local mock → false.
 */
export function doorAcceptsRace(info) {
  if (!info || typeof info !== 'object') return false;
  if (info.race === true || info.gatewayRace === true) return true;
  if (info.race === false || info.gatewayRace === false) return false;
  const features = info.features || info.caps || info.capabilities;
  if (Array.isArray(features) && features.some((f) => String(f).toLowerCase() === 'race')) return true;
  if (features && typeof features === 'object' && (features.race === true || features.gatewayRace === true)) {
    return true;
  }
  return isFlyGatewayUpstream(info.upstream || info.apiBase || info.gateway);
}

let probeCache = { at: 0, ok: null, proxy: '' };

export function resetGatewayRaceProbe() {
  probeCache = { at: 0, ok: null, proxy: '' };
}

function proxyOrigin(proxy) {
  const raw = String(proxy || '').replace(/\/+$/, '');
  return raw.replace(/\/v1$/i, '');
}

/**
 * Probe the sidecar / mock once. GET /v1/info (and /info) — never a paid
 * completions call. Cached briefly so a race of 4 does not fan out probes.
 */
export async function probeGatewayRace(proxy, fetchFn = fetch, ttlMs = 60_000) {
  const key = String(proxy || '');
  if (probeCache.ok != null && probeCache.proxy === key && Date.now() - probeCache.at < ttlMs) {
    return probeCache.ok;
  }
  const origin = proxyOrigin(key);
  if (!origin) {
    probeCache = { at: Date.now(), ok: false, proxy: key };
    return false;
  }
  const paths = ['/v1/info', '/info'];
  for (const p of paths) {
    try {
      const r = await fetchFn(`${origin}${p}`, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) continue;
      const j = await r.json().catch(() => null);
      const ok = doorAcceptsRace(j);
      probeCache = { at: Date.now(), ok, proxy: key };
      return ok;
    } catch { /* try next */ }
  }
  probeCache = { at: Date.now(), ok: false, proxy: key };
  return false;
}

/**
 * If prepaid credit is known and `n × quote > credit`, shrink n (or 0 = refuse)
 * rather than fire 4 groks on $0 credit. Unknown credit/quote → leave n alone.
 */
export function capRaceByCredit(n, { creditUsd, quoteUsd } = {}) {
  const want = Math.max(0, Math.floor(Number(n) || 0));
  if (creditUsd == null || !Number.isFinite(Number(creditUsd))) {
    return { n: want, reason: null };
  }
  const credit = Number(creditUsd);
  if (credit <= 0) return { n: 0, reason: 'no-credit' };
  const quote = Number(quoteUsd);
  if (!Number.isFinite(quote) || quote <= 0) {
    // Credit is known and positive but we have no per-entrant quote — do not
    // invent one. A $0 balance already refused above.
    return { n: want, reason: null };
  }
  if (want * quote <= credit) return { n: want, reason: null };
  const maxN = Math.floor(credit / quote);
  if (maxN < 1) return { n: 0, reason: 'no-credit' };
  return { n: Math.min(want, maxN), reason: 'shrunk' };
}

/**
 * House cost from the receipt. Do not subtract race_unused — unused
 * grant-back is not a user refund, and shrinking cogs would hide house loss.
 * Does not clamp to billed — HUD embers when cogs exceed what was paid.
 */
export function receiptUsedCogs(x, markup = 3) {
  if (!x || typeof x !== 'object') return 0;
  const billedRaw = Number(x.billedUsd);
  const billedOk = Number.isFinite(billedRaw) && billedRaw >= 0;
  if (typeof x.cogsUsd === 'number' && Number.isFinite(x.cogsUsd)) return x.cogsUsd;
  return billedOk ? billedRaw / markup : 0;
}

/**
 * Session meter. spent/direct are the receipt totals as billed — never a
 * first-call rewrite, never a race_unused user refund.
 * cogs is the house cost on that receipt (HUD embers when cogs > spent).
 */
export function meterRaceReceipt(x, markup = 3) {
  const billed = Number(x?.billedUsd);
  const spentUsd = Number.isFinite(billed) ? billed : 0;
  const usedCogs = receiptUsedCogs(x, markup);
  const direct = typeof x?.directUsd === 'number' ? x.directUsd : spentUsd;
  return { spentUsd, cogsUsd: usedCogs, directUsd: direct };
}

export function inferRaceTier(models, fallback = 'medium') {
  const list = Array.isArray(models) ? models : [];
  const grok = list.filter((m) => /^x-ai\/grok/i.test(String(m)));
  if (list.length && grok.length === list.length) return 'grok4.6';
  return fallback;
}
