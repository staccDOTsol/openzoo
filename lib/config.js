import os from 'node:os';
import path from 'node:path';

export const config = {
  port: Number(process.env.OPENZOO_PORT || 8402),
  apiBase: (process.env.OPENZOO_API_BASE || 'https://x402-tokens.fly.dev').replace(/\/+$/, ''),
  rpcUrl: process.env.OPENZOO_RPC || 'https://api.mainnet-beta.solana.com',
  // Which accepts[] row to pay with, by extra.symbol (internal rail selector).
  token: process.env.OPENZOO_TOKEN || 'yUSDCx',
  walletPath: process.env.OPENZOO_WALLET || path.join(os.homedir(), '.openzoo', 'wallet.json'),
  // Refuse to auto-pay any single 402 quote above this many USD (extra.billedUsd).
  maxUsdPerCall: Number(process.env.OPENZOO_MAX_USD_PER_CALL || 0.5),
  // Demo will only actually pay if the quote is at or below this.
  demoMaxUsd: Number(process.env.OPENZOO_DEMO_MAX_USD || 0.01),
};

/**
 * Assets a user can fund the burner wallet with. Both are first-class: each is
 * the underlying of a live Solana rail the zoo quotes (USDC -> yUSDCx,
 * TOKEN -> wTOKENx), and the shim wraps whichever one it needs at payment time,
 * for exactly the amount needed. Never mention one of these without the other.
 */
export const FUNDING_ASSETS = [
  { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { symbol: 'TOKEN', mint: 'EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump' },
];

export const USDC_MINT = FUNDING_ASSETS[0].mint;
export const TOKEN_MINT = FUNDING_ASSETS[1].mint;

/**
 * The one canonical way to tell a user how to fund the SOLANA rail. Callers
 * pass the Solana address; the rail is named explicitly because the wallet
 * also has an EVM address for the Base / Robinhood rails.
 */
export function fundingLine(address) {
  return `send a few cents of USDC (${USDC_MINT}) or TOKEN (${TOKEN_MINT}) on Solana to ${address}`;
}

/**
 * What a user funds each rail with — UNDERLYING assets only, and only assets
 * this shim can actually spend from. The settlement mints the 402 quotes are
 * internal plumbing and never appear in user-facing copy.
 *
 * Solana: quoted in settlement mints, converted from plain USDC / TOKEN at
 *   payment time (lib/wrap.js).
 * Base:   quoted in native USDC — funded and spent as-is, no conversion.
 * Robinhood: quoted in a settlement asset with no conversion path on EVM
 *   (wrapping is Solana-only), so there is no plain balance a user can fund
 *   and have the shim pay from — hence no assets, and no funding line.
 */
export const RAIL_FUNDING = {
  solana: { label: 'Solana', assets: ['USDC', 'TOKEN'] },
  base: { label: 'Base', assets: ['USDC'] },
  robinhood: { label: 'Robinhood Chain', assets: [] },
};

/**
 * "USDC or TOKEN on Solana · USDC on Base" — the funding hint for exactly the
 * rails a live 402 is offering, derived from liveRails().live. Rails with no
 * fundable underlying, and networks we have no funding copy for (an
 * unrecognised chain the zoo starts quoting), are left out rather than guessed
 * at. Returns '' when nothing is fundable.
 */
export function railFundingHint(liveRailNames) {
  return (liveRailNames || [])
    .map((rail) => RAIL_FUNDING[rail])
    .filter((spec) => spec?.assets.length)
    .map((spec) => `${spec.assets.join(' or ')} on ${spec.label}`)
    .join(' · ');
}

/**
 * Rails the zoo is quoting right now that this shim cannot pay from a plain
 * funded balance — named so a live rail never silently disappears from the
 * funding advice.
 */
export function unfundableRails(liveRailNames) {
  return (liveRailNames || [])
    .filter((rail) => RAIL_FUNDING[rail] && !RAIL_FUNDING[rail].assets.length)
    .map((rail) => RAIL_FUNDING[rail].label);
}

/**
 * What the resource will actually settle, right now, read off a live 402 —
 * never a hardcoded claim. Rails the code implements but the zoo is not
 * currently offering are reported separately so nobody funds a dead lane.
 * Underlying assets only: the wrapped settlement mints are internal plumbing.
 */
export async function liveRails() {
  const r = await fetch(`${config.apiBase}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'nvidia/nemotron-3.5-lightning', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
  });
  if (r.status !== 402) { await r.text().catch(() => {}); return null; }
  const body = await r.json();
  const rows = Array.isArray(body?.accepts) ? body.accepts : [];
  const live = new Set();
  for (const a of rows) {
    const net = a?.network || '';
    if (net.startsWith('solana:')) live.add('solana');
    else if (/^eip155:8453$/.test(net)) live.add('base');
    else if (/^eip155:4663$/.test(net)) live.add('robinhood');
    else if (net) live.add(net);
  }
  const implemented = ['solana', 'base', 'robinhood'];
  return { live: [...live], dark: implemented.filter((x) => !live.has(x)) };
}
