/**
 * Fly gateway race: one POST { race, race_need, tier }.
 * User pays for every entrant we actually launched. Failures still cost us
 * (OpenRouter was paid). race_unused on a receipt is informational — do not
 * treat it as a user refund or shrink HUD cogs to hide a house loss.
 * HUD embers when cogs > spent.
 */

export const FLY_GATEWAY_HOST = 'x402-tokens.fly.dev';
export const RACE_NO_CREDIT = '(race: not enough prepaid credit — shrink N or top up, rather than fire on $0)';
/** Low end of the pitched 5–10× vs frontier. Session green HUD below this recuts Y. */
export const RACE_HUD_TARGET = 5;

const TIER_DOWN = {
  'grok4.6': 'medium',
  grok46: 'medium',
  expensive: 'medium',
  medium: 'cheap',
  cheap: 'cheap',
};

export function cheaperRaceTier(tier) {
  const t = String(tier || 'medium');
  return TIER_DOWN[t] || 'cheap';
}

/** Same number the HUD green `x` uses: direct/spent. */
export function sessionDollarX({ dollarX, spentUsd, directUsd } = {}) {
  const given = Number(dollarX);
  if (Number.isFinite(given) && given > 0) return given;
  const spent = Number(spentUsd);
  const direct = Number(directUsd);
  if (spent > 0 && Number.isFinite(direct)) return direct / spent;
  return null;
}

/**
 * Recut launched Y (and maybe drop a band) when session green HUD is thin.
 * Assumes the current multiple already includes this Y tax, so implied
 * single-model x ≈ dollarX × y. Need (X) scales with Y. No user refunds.
 *
 * 2.09x on a 4-racer → implied ~8.4x single → Y=1 (back in the 5–10× band).
 */
export function recutRaceByHud({
  y, need = 1, dollarX, tier = 'medium', target = RACE_HUD_TARGET,
} = {}) {
  const launched = Math.max(1, Math.floor(Number(y) || 1));
  const k = Math.max(1, Math.min(Math.floor(Number(need) || 1), launched));
  const x = Number(dollarX);
  const band = String(tier || 'medium');
  if (!Number.isFinite(x) || x <= 0 || x >= target) {
    return { y: launched, need: k, tier: band, recut: false, reason: null };
  }
  const impliedSingle = x * launched;
  const maxY = Math.max(1, Math.min(launched, Math.floor(impliedSingle / target)));
  const nextTier = impliedSingle < target ? cheaperRaceTier(band) : band;
  const nextNeed = Math.max(1, Math.min(k, maxY));
  const recut = maxY < launched || nextTier !== band;
  return {
    y: maxY,
    need: nextNeed,
    tier: nextTier,
    recut,
    reason: recut ? 'savings' : null,
  };
}

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
 *
 * Wallet path: there is no 3× markup. Prefer the gateway's cogsUsd; otherwise
 * billedUsd (OpenRouter price, plus zoo's 33% of savings when the 402 has any).
 */
export function receiptUsedCogs(x) {
  if (!x || typeof x !== 'object') return 0;
  if (typeof x.cogsUsd === 'number' && Number.isFinite(x.cogsUsd)) return x.cogsUsd;
  const billedRaw = Number(x.billedUsd);
  return Number.isFinite(billedRaw) && billedRaw >= 0 ? billedRaw : 0;
}

/** Counterfactual from the 402: extra.directUsd, else billed + savedUsd. */
export function receiptDirectUsd(x) {
  if (typeof x?.directUsd === 'number' && Number.isFinite(x.directUsd)) return x.directUsd;
  const billed = Number(x?.billedUsd);
  const billedOk = Number.isFinite(billed) && billed >= 0;
  if (typeof x?.savedUsd === 'number' && Number.isFinite(x.savedUsd) && billedOk) {
    return billed + x.savedUsd;
  }
  if (typeof x?.savesVsDirect === 'number' && Number.isFinite(x.savesVsDirect) && billedOk) {
    return x.savesVsDirect * billed;
  }
  return billedOk ? billed : 0;
}

/** Zoo's share of (direct − OpenRouter) when the 402 has real savings. */
export const SAVINGS_SHARE = 0.33;
/**
 * billed / usage.cost above this, without settled house cogs, is the
 * max_tokens quote reserve — not the charge after completion.
 * MEASURED 2026-08-19: $0.9858 reserved / $0.007962 usage.cost ≈ 124× on a ~1× call.
 */
export const QUOTE_RESERVE_X = 2;

function money(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function closeRatio(a, b, rel = 0.25) {
  const den = Math.max(b, 1e-12);
  return Math.abs(a - b) / den <= rel;
}

/**
 * After-completion billed fields the gateway may already put on x402 / usage.
 * Read only if present — do not invent them on the wire.
 */
function explicitSettledBilled(x, usage) {
  const bags = [x, usage, x?.used, x?.settled, x?.receipt, usage?.used, usage?.settled]
    .filter((o) => o && typeof o === 'object' && !Array.isArray(o));
  const keys = [
    'billedActual', 'billedActualUsd', 'settledUsd', 'settledBilledUsd',
    'chargedUsd', 'usedUsd', 'actualBilledUsd',
  ];
  for (const bag of bags) {
    for (const k of keys) {
      const n = money(bag[k]);
      if (n != null) return n;
    }
  }
  return null;
}

/** tokens actually used × unit prices, only when both sides are already on the object. */
function billedFromUsedTokens(x, usage) {
  const prompt = money(usage?.prompt_tokens ?? usage?.promptTokens ?? x?.prompt_tokens);
  const completion = money(usage?.completion_tokens ?? usage?.completionTokens ?? x?.completion_tokens);
  const inPrice = money(x?.promptPriceUsd ?? x?.inputPriceUsd ?? x?.priceInUsd);
  const outPrice = money(x?.completionPriceUsd ?? x?.outputPriceUsd ?? x?.priceOutUsd);
  if (prompt != null && completion != null && inPrice != null && outPrice != null) {
    return prompt * inPrice + completion * outPrice;
  }
  return null;
}

/**
 * True when `billed` is the quote-time max_tokens ceiling, not the settled charge.
 * A large billed/cost is honest when cogs already matches usage.cost (33% of
 * real savings). The 124× lie is billed >> cost with at-cost / reserved cogs.
 */
export function isQuoteReserveBilled(billed, cost, x = {}) {
  if (money(billed) == null || money(cost) == null) return false;
  if (cost === 0) return billed > 0;
  if (billed <= cost * QUOTE_RESERVE_X) return false;
  const cogs = money(x?.cogsUsd);
  if (cogs != null && closeRatio(cogs, cost)) return false;
  const saved = money(x?.savedUsd);
  if (saved == null || saved <= cost * 0.5) return true;
  if (cogs != null && cogs > cost * QUOTE_RESERVE_X) return true;
  return true;
}

/**
 * Post-completion billed USD to pair with usage.cost / x.actualUsd.
 * `x.billedUsd` is often the quote reserve (max_tokens × catalog), which made
 * HUD markupX read 124× on a ~1× call. Prefer a settled field; otherwise
 * reconstruct from tokens used × price or from usage.cost (+ 33% of settled
 * savings). Never return the reserve when we learned the real upstream cost.
 */
export function receiptSettledBilled(x, usage) {
  // The gateway now sets `usage.billedUsd` explicitly, and it is exactly the
  // settled figure this function spends the rest of its body reconstructing
  // from tokens and prices. Take it when it is there; the reconstruction below
  // stays for older gateways and for the race path, which has no single
  // billed number of its own.
  const direct = money(usage?.billedUsd);
  if (direct != null) return direct;
  // See pairActualBilled: `usage.cost` is our price now, not upstream's.
  const cost = money(usage?.cost_details?.upstream_inference_cost)
    ?? money(usage?.cost) ?? money(x?.actualUsd) ?? money(usage?.actualUsd);
  const explicit = explicitSettledBilled(x, usage);
  if (explicit != null) return explicit;

  const fromTokens = billedFromUsedTokens(x, usage);
  if (fromTokens != null) {
    const billed = money(x?.billedUsd);
    if (billed == null || isQuoteReserveBilled(billed, fromTokens, x)
        || (cost != null && isQuoteReserveBilled(billed, cost, x))) {
      return fromTokens;
    }
    return billed;
  }

  const billed = money(x?.billedUsd);
  if (billed != null && (cost == null || !isQuoteReserveBilled(billed, cost, x))) {
    return billed;
  }
  if (cost != null) {
    const saved = settledSavedUsd(x, cost);
    return cost + SAVINGS_SHARE * saved;
  }
  return billed ?? 0;
}

function settledSavedUsd(x, cost) {
  const saved = money(x?.savedUsd);
  if (saved == null || saved <= 0) return 0;
  const cogs = money(x?.cogsUsd);
  // Quote-time savedUsd rides the same max_tokens reserve. Only keep it when
  // house cost already matches the metered upstream (settled cogs).
  if (cogs != null && closeRatio(cogs, cost)) return saved;
  return 0;
}

/**
 * Pair the HUD denominator (real upstream) with the post-completion billed
 * twin. Null when this call did not report a real cost — do not mix populations.
 */
export function pairActualBilled(x402, usage) {
  // `usage.cost` IS NO LONGER THE UPSTREAM FIGURE. The gateway now reports OUR
  // price there, because that is the field every generic OpenAI-compatible
  // client reads and they were all showing what OpenRouter charged us instead
  // of what the caller was charged. The upstream number moved to
  // `cost_details.upstream_inference_cost`, which is where OpenRouter itself
  // publishes it.
  //
  // This is the HUD's DENOMINATOR, so reading the new `usage.cost` here would
  // divide billed by billed and print 1× on every call regardless of markup.
  // Prefer the explicit upstream field; fall back to `usage.cost` only for
  // responses from a gateway old enough to predate the move.
  const fromUpstream = money(usage?.cost_details?.upstream_inference_cost);
  const fromUsage = fromUpstream ?? money(usage?.cost);
  const fromX = money(x402?.actualUsd) ?? money(x402?.usage?.cost);
  const upstreamUsd = fromUsage ?? fromX;
  if (upstreamUsd == null) return null;
  const bag = x402 && typeof x402 === 'object' ? x402 : {};
  const usageBag = usage && typeof usage === 'object' ? usage : {};
  return {
    upstreamUsd,
    billedUsd: receiptSettledBilled(bag, { ...usageBag, cost: upstreamUsd }),
  };
}

/**
 * Session meter. spent/direct are the receipt totals as billed — never a
 * first-call rewrite, never a race_unused user refund.
 * cogs is the house cost on that receipt (HUD embers when cogs > spent).
 */
export function meterRaceReceipt(x) {
  const billed = Number(x?.billedUsd);
  const spentUsd = Number.isFinite(billed) ? billed : 0;
  return { spentUsd, cogsUsd: receiptUsedCogs(x), directUsd: receiptDirectUsd(x) };
}

export function inferRaceTier(models, fallback = 'medium') {
  const list = Array.isArray(models) ? models : [];
  const grok = list.filter((m) => /^x-ai\/grok/i.test(String(m)));
  if (list.length && grok.length === list.length) return 'grok4.6';
  return fallback;
}
