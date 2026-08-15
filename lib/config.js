import os from 'node:os';
import path from 'node:path';

export const config = {
  port: Number(process.env.OPENZOO_PORT || 8402),
  apiBase: (process.env.OPENZOO_API_BASE || 'https://x402-tokens.fly.dev').replace(/\/+$/, ''),
  // Default to fluxrpc (free public endpoint) — api.mainnet-beta.solana.com
  // rate-limits hard under any real load (429s during demos). OPENZOO_RPC
  // overrides for anyone who wants their own.
  rpcUrl: process.env.OPENZOO_RPC || 'https://eu.fluxrpc.com?key=ab9278e1-6430-41ab-aee0-ac6b759a1fe4',
  // Which accepts[] row to pay with, by extra.symbol (internal rail selector).
  token: process.env.OPENZOO_TOKEN || 'yUSDCx',
  // Force a rail: 'solana' | 'base' | 'robinhood'. Unset -> Solana-first order.
  // pickAccept errors clearly when the live 402 does not offer the forced rail.
  rail: (process.env.OPENZOO_RAIL || '').toLowerCase() || null,
  // EVM RPCs for balance reads / preflight checks on the Base and RH rails.
  baseRpcUrl: process.env.OPENZOO_BASE_RPC || 'https://mainnet.base.org',
  rhRpcUrl: process.env.OPENZOO_RH_RPC || 'https://rpc.mainnet.chain.robinhood.com',
  walletPath: process.env.OPENZOO_WALLET || path.join(os.homedir(), '.openzoo', 'wallet.json'),
  // Refuse to auto-pay any single 402 quote above this many USD (extra.billedUsd).
  // UNCAPPED by default (user directive: no maximums — a giant bound-corpus
  // call is a legitimate call). Set OPENZOO_MAX_USD_PER_CALL to add a ceiling.
  maxUsdPerCall: process.env.OPENZOO_MAX_USD_PER_CALL ? Number(process.env.OPENZOO_MAX_USD_PER_CALL) : Infinity,
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
 * EVM-side balances `openzoo balance` reports, grouped by rail. `usd` is a
 * known price (stables); null means "no honest price here" and the CLI prints
 * `?` rather than inventing one. The memecoins are Robinhood Chain ERC-20s
 * (18 decimals, verified on-chain 2026-08-14); their wrapped x402 twins are
 * in-deploy and will appear in the 402 itself when live.
 */
export const EVM_FUNDING_ASSETS = {
  base: [
    { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, usd: 1 },
  ],
  robinhood: [
    { symbol: 'USDG', address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6, usd: 1 },
    { symbol: 'ODDBALLER', address: '0x923eb7BD5B84a1a114CB57212cE2F2e87AE60E2A', decimals: 18, usd: null },
    // note rides into the banner CA block: IOU is accepted by design, but its
    // 402 row fails closed whenever DexScreener has no pool to price it from.
    { symbol: 'IOU', address: '0xf391999FACbEE613D4024191Dd31060540BF0bEd', decimals: 18, usd: null, note: 'accepted — quoting paused while its price feed is down' },
    { symbol: 'ROBINHOODS', address: '0xC42cF61C16aaC797b991cf9C1ac8Ae70bA74A286', decimals: 18, usd: null },
  ],
};

/** RPC endpoint for an EVM rail name. */
export function evmRpcFor(rail) {
  return rail === 'base' ? config.baseRpcUrl : rail === 'robinhood' ? config.rhRpcUrl : null;
}

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
 * Robinhood: the rail settles (real payments 2026-08-14) and the shim
 *   auto-converts at payment time (lib/evmwrap.js: approve + deposit into the
 *   quoted vault, discovered on-chain via asset() — never hardcoded). Fund
 *   with the PLAIN tokens; the two conversion txs are the wallet's own, so a
 *   sliver of RH ETH for gas is also needed — the `note` rides the hint.
 */
export const RAIL_FUNDING = {
  solana: { label: 'Solana', assets: ['USDC', 'TOKEN'] },
  base: { label: 'Base', assets: ['USDC'] },
  robinhood: {
    label: 'Robinhood Chain',
    assets: ['USDG', 'ODDBALLER', 'IOU', 'ROBINHOODS'],
    note: 'plus a sliver of RH ETH for the conversion gas',
  },
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
    .map((spec) => `${spec.assets.join(' or ')} on ${spec.label}${spec.note ? ` (${spec.note})` : ''}`)
    .join(' · ');
}

/**
 * The contract addresses behind the funding hint, one row per live rail —
 * "fund with USDC" is useless without the CA when every chain has a dozen
 * impersonator mints named USDC. Same catalogs the balance command reads
 * (FUNDING_ASSETS / EVM_FUNDING_ASSETS), so hint and addresses cannot drift.
 */
export function railFundingAddresses(liveRailNames) {
  const rows = [];
  for (const rail of liveRailNames || []) {
    const spec = RAIL_FUNDING[rail];
    if (!spec?.assets.length) continue;
    const catalog = rail === 'solana'
      ? FUNDING_ASSETS.map((a) => ({ symbol: a.symbol, address: a.mint }))
      : (EVM_FUNDING_ASSETS[rail] || []);
    const assets = spec.assets
      .map((sym) => catalog.find((a) => a.symbol === sym))
      .filter(Boolean)
      .map((a) => ({ symbol: a.symbol, address: a.address, note: a.note }));
    if (assets.length) rows.push({ label: spec.label, assets });
  }
  return rows;
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
