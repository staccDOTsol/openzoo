/**
 * Fly gateway race: one POST { race, race_need, tier }, unused grant-back,
 * and HUD cogs for the racers that actually ran — never the N+judge ceiling.
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

function unusedGrant(x) {
  const u = x?.race_unused ?? x?.raceUnused ?? x?.unused;
  if (u == null) return { billed: 0, cogs: 0 };
  if (typeof u === 'number' && Number.isFinite(u)) return { billed: u, cogs: u };
  if (typeof u !== 'object') return { billed: 0, cogs: 0 };
  const billed = Number(u.billedUsd ?? u.refundUsd ?? u.unusedBilledUsd ?? u.usd ?? 0);
  const cogs = Number(u.cogsUsd ?? u.unusedCogsUsd ?? u.refundCogsUsd ?? billed);
  return {
    billed: Number.isFinite(billed) && billed > 0 ? billed : 0,
    cogs: Number.isFinite(cogs) && cogs > 0 ? cogs : 0,
  };
}

/**
 * Actual used-racer cogs after unused grant-back.
 * Never the N+judge ceiling. Does not clamp to billed — HUD embers when
 * used cogs still exceed what was paid.
 */
export function receiptUsedCogs(x, markup = 3) {
  if (!x || typeof x !== 'object') return 0;
  const billedRaw = Number(x.billedUsd);
  const billedOk = Number.isFinite(billedRaw) && billedRaw >= 0;
  let cogs = typeof x.cogsUsd === 'number' && Number.isFinite(x.cogsUsd)
    ? x.cogsUsd
    : (billedOk ? billedRaw / markup : 0);
  const grant = unusedGrant(x);
  if (grant.cogs > 0) cogs = Math.max(0, cogs - grant.cogs);
  return cogs;
}

/**
 * Session meter. spent/direct are the receipt totals (already net of unused
 * when the gateway refunds into billedUsd) — never a first-call rewrite.
 * cogs is used racers after unused grant-back.
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
