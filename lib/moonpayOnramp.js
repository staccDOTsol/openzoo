/**
 * MoonPay-hosted fiat→USDC onramp for the x402 402 path.
 *
 * Unlike Stripe, there is no session POST: we build
 * https://buy.moonpay.com/?apiKey=pk_…&currencyCode=usdc_sol&walletAddress=…
 * and HMAC-SHA256 sign the query string with the secret. The dest is locked
 * because walletAddress + currencyCode + signature are required together —
 * the widget does not prompt for another address.
 *
 * Keys are NEVER in the repo: MOONPAY_PUBLISHABLE_KEY + MOONPAY_SECRET_KEY,
 * else ~/moonpay.json `{publishableKey,secretKey}`, else ~/moonpay.pk +
 * ~/moonpay.key. No keys → caller keeps the send-to-address copy.
 *
 * Do NOT set allowedIpAddress. Live IP matching would bind the URL to the
 * shim/gateway IP; the 402 is opened on the user's machine (or phone).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();

function readTrim(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; }
}

export function moonpayKeys() {
  const jsonPath = process.env.MOONPAY_KEY_FILE || path.join(HOME, 'moonpay.json');
  let filePk = '';
  let fileSk = '';
  try {
    const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    filePk = String(j.publishableKey || j.pk || j.apiKey || '').trim();
    fileSk = String(j.secretKey || j.sk || j.secret || '').trim();
  } catch { /* no json */ }
  const pk = String(process.env.MOONPAY_PUBLISHABLE_KEY || process.env.MOONPAY_API_KEY || '').trim()
    || filePk
    || readTrim(process.env.MOONPAY_PK_FILE || path.join(HOME, 'moonpay.pk'));
  const sk = String(process.env.MOONPAY_SECRET_KEY || '').trim()
    || fileSk
    || readTrim(process.env.MOONPAY_SECRET_FILE || path.join(HOME, 'moonpay.key'));
  if (!pk || !sk) return null;
  return { pk, sk };
}

function dollars(usd) {
  const n = Number(usd);
  // MoonPay USDC min is typically ~$20–30, not Stripe's $5.
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.max(30, Math.ceil(n));
}

/** HMAC-SHA256 of `url.search` (includes leading `?`), then URL-encode. */
export function signMoonPayUrl(unsignedUrl, secret) {
  const u = new URL(unsignedUrl);
  const signature = crypto.createHmac('sha256', secret).update(u.search).digest('base64');
  return `${unsignedUrl}${u.search ? '&' : '?'}signature=${encodeURIComponent(signature)}`;
}

/**
 * Signed widget URL that buys USDC on Solana into `solana`. Sync — no network.
 * Returns null if keys are missing.
 */
export function moonpayUsdcOnrampLink({ solana, usd } = {}) {
  const addr = String(solana || '').trim();
  if (!addr) return null;
  const keys = moonpayKeys();
  if (!keys) return null;
  const live = keys.pk.startsWith('pk_live_');
  const host = live ? 'https://buy.moonpay.com' : 'https://buy-sandbox.moonpay.com';
  const params = new URLSearchParams();
  params.set('apiKey', keys.pk);
  params.set('currencyCode', 'usdc_sol');
  params.set('walletAddress', addr);
  params.set('baseCurrencyCode', 'usd');
  params.set('baseCurrencyAmount', String(dollars(usd)));
  const unsigned = `${host}/?${params.toString()}`;
  return signMoonPayUrl(unsigned, keys.sk);
}