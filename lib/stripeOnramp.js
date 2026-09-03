/**
 * Stripe-hosted fiat→USDC onramp (crypto.link.com) for the x402 402 path.
 *
 * Secret is NEVER in the repo: STRIPE_SECRET_KEY, else STRIPE_SECRET_FILE,
 * else ~/stripey.key. Onramp sessions lock the destination to the local
 * Solana burner so a card checkout lands USDC where PayClient spends.
 *
 * Solana-only: Stripe 400s `wallet_addresses[base]` (parameter_unknown),
 * which silently dropped the hosted URL from live Grok 402 replies.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';


const STRIPE_VERSION = '2026-06-24.dahlia';
const TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // key -> { url, at }

function stripeSecret() {
  const env = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (env) return env;
  const file = process.env.STRIPE_SECRET_FILE || path.join(os.homedir(), 'stripey.key');
  return fs.readFileSync(file, 'utf8').trim();
}

function dollars(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.max(5, Math.ceil(n));
}

/** Test seam. */
export function resetOnrampCache() { cache.clear(); }

/**
 * Mint (or reuse) a Stripe-hosted onramp URL that sends USDC to `solana`.
 * Returns null if the key is missing or Stripe refuses — caller keeps the
 * existing send-to-address copy. `evm` is ignored: Stripe does not accept
 * `wallet_addresses[base]` on this API.
 */
export async function stripeUsdcOnrampLink({ solana, usd } = {}) {
  const addr = String(solana || '').trim();
  if (!addr) return null;
  const amt = dollars(usd);
  const key = `${addr}|${amt}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS && hit.url) return hit.url;
  let secret;
  try { secret = stripeSecret(); } catch { return null; }
  if (!secret) return null;
  const body = new URLSearchParams();
  body.set('destination_currency', 'usdc');
  body.set('destination_network', 'solana');
  body.append('destination_currencies[]', 'usdc');
  body.append('destination_networks[]', 'solana');
  body.set('source_currency', 'usd');
  body.set('source_amount', String(amt));
  body.set('lock_wallet_address', 'true');
  body.set('wallet_addresses[solana]', addr);
  try {
    const r = await fetch('https://api.stripe.com/v1/crypto/onramp_sessions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/x-www-form-urlencoded',
        'Stripe-Version': STRIPE_VERSION,
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json();
    const url = data?.redirect_url;
    if (!r.ok || !url) {
      const err = data?.error;
      console.error(`openzoo onramp: stripe ${r.status} ${err?.code || err?.type || 'no-url'} ${(err?.message || '').slice(0, 160)}`);
      return null;
    }
    cache.set(key, { url, at: Date.now() });
    return url;
  } catch (e) {
    console.error(`openzoo onramp: ${e.message}`);
    return null;
  }
}

const DEFAULT_WHOP_CHECKOUT = 'https://whop.com/staccoverflow/openzoo';

/** Whop product / checkout. OPENZOO_WHOP_CHECKOUT overrides the default product URL. */
export function whopBuyUrl() {
  return String(process.env.OPENZOO_WHOP_CHECKOUT || process.env.OPENZOO_WHOP_URL || DEFAULT_WHOP_CHECKOUT).trim();
}

export function whopFundBlurb(solana) {
  const addr = String(solana || '').trim();
  if (!addr) return '';
  const url = whopBuyUrl();
  return [
    `Hey — buy this: ${url}`,
    '',
    'Copy-paste THIS Solana address into "what is your Solana address?" so it ties to your account:',
    addr,
  ].join('\n');
}

/**
 * Genuine empty-wallet / fund-me copy. A post-pay settle failure
 * ("payment did not settle" with a gateway reason and no underfunded
 * wording) is NOT this — those wallets are often funded; the 402 is
 * the facilitator or upstream.
 */
export function isFundInstruction(text, extra = {}) {
  const code = extra.code ?? extra.advice?.code;
  if (String(code || '') === 'insufficient_funds') return true;
  const s = String(text || '');
  if (!s) return false;
  if (/\b(?:wallet underfunded|empty wallet|wallet is empty|needs more than the wallet holds|insufficient[_\s]funds)\b/i.test(s)) return true;
  if (/\bunderfunded\b/i.test(s)) return true;
  if (/\bsend (?:usdc|a few cents)\b/i.test(s)) return true;
  if (/\bno offered payment row is affordable/i.test(s)) return true;
  return false;
}

function gatewayReason(q402) {
  if (!q402 || typeof q402 !== 'object') return '';
  const err = q402.error;
  const advice = q402.advice;
  if (typeof err?.message === 'string' && err.message.trim()) return err.message.trim();
  if (typeof err === 'string' && err.trim()) return err.trim();
  if (typeof advice?.message === 'string' && advice.message.trim()) return advice.message.trim();
  if (typeof advice === 'string' && advice.trim()) return advice.trim();
  if (advice && typeof advice === 'object') {
    const bits = [advice.code, advice.reason, advice.detail].filter((x) => typeof x === 'string' && x.trim());
    if (bits.length) return bits.join(': ');
  }
  return '';
}

/**
 * Copy for a 402 AFTER PayClient already signed and retried (paid:true).
 * Never "wallet underfunded" — that string is reserved for preflight
 * empty-wallet errors. Prefix stays greppable as "payment did not settle".
 */
export function settleFailCopy(q402) {
  const reason = gatewayReason(q402);
  const code = q402?.advice?.code || q402?.error?.code || '';
  const fund = isFundInstruction(reason, { code, advice: q402?.advice });
  const message = reason
    ? `openzoo payment did not settle: ${reason}`
    : 'openzoo payment did not settle';
  const upstreamish = /upstream|facilitator|internal(?: server)? error|settle(?:ment)? (?:failed|error)/i.test(reason) && !fund;
  return { message, status: upstreamish ? 502 : 402, fund, reason, code: String(code || '') };
}

export async function withOnrampLink(text, dest) {
  const body = String(text || '').trim();
  if (!isFundInstruction(body, dest)) return body;
  const blurb = whopFundBlurb(dest?.solana);
  if (!blurb) return body;
  if (/ties to your account/i.test(body) && body.includes(String(dest.solana))) return body;
  return `${blurb}\n\n${body}`;
}
