import os from 'node:os';
import path from 'node:path';
import { fetchHeaders } from './fetch.js';

export const config = {
  port: Number(process.env.OPENZOO_PORT || 8402),
  apiBase: (process.env.OPENZOO_API_BASE || 'https://x402-tokens.fly.dev').replace(/\/+$/, ''),
  // Default to fluxrpc (free public endpoint) — api.mainnet-beta.solana.com
  // rate-limits hard under any real load (429s during demos). OPENZOO_RPC
  // overrides for anyone who wants their own.
  rpcUrl: process.env.OPENZOO_RPC || 'https://eu.fluxrpc.com?key=ab9278e1-6430-41ab-aee0-ac6b759a1fe4',
  // Which accepts[] row to prefer, by extra.symbol (internal rail selector).
  // TOKEN is the default so a wallet holding it spends it. The picker walks
  // best-first and takes the first AFFORDABLE row, so wallets without TOKEN
  // fall through to USDC. This named the wTOKENx3 twin until the gateway went
  // native — a symbol no row carries any more, which silently disabled the
  // preference rather than erroring. OPENZOO_TOKEN overrides.
  token: process.env.OPENZOO_TOKEN || 'TOKEN',
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
 * Assets a user can fund the burner wallet with. All three are first-class and
 * these are the EXACT mints the 402 quotes — fund one, spend it, no conversion
 * step. Never mention one of these without the others.
 */
export const FUNDING_ASSETS = [
  { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { symbol: 'TOKEN', mint: 'EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump' },
  // LEOS is NINE decimals, and a LEGACY SPL mint rather than Token-2022 —
  // balance reads must not assume either, so nothing here hardcodes them;
  // decimals come off the mint on chain.
  { symbol: 'LEOS', mint: '5xgsnby6P9zqGK71J7H4yJLxzqPvNbC7rDZxNzjHmj7e' },
];

export const USDC_MINT = FUNDING_ASSETS[0].mint;
export const TOKEN_MINT = FUNDING_ASSETS[1].mint;
export const LEOS_MINT = FUNDING_ASSETS[2].mint;

/**
 * EVM-side balances `openzoo balance` reports, grouped by rail. `usd` is a
 * known price (stables); null means "no honest price here" and the CLI prints
 * `?` rather than inventing one.
 *
 * ONLY LIST WHAT THE 402 ACCEPTS. The Robinhood memecoins (ODDBALLER / IOU /
 * ROBINHOODS) were removed 2026-08-24 along with every wrapped rail: they were
 * only ever payable through X402Wrapper twins the payer had to mint first, and
 * the gateway no longer offers them. Reporting a balance the user cannot spend
 * reads as "you have funds" and then fails at payment.
 */
export const EVM_FUNDING_ASSETS = {
  base: [
    { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, usd: 1 },
  ],
  robinhood: [
    // Canonical Paxos USDG, pinned by ADDRESS: six impersonators on this chain
    // answer symbol() == "USDG" with 41k-111k holders each.
    { symbol: 'USDG', address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6, usd: 1 },
  ],
  arbitrum: [
    { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, usd: 1 },
  ],
  optimism: [
    { symbol: 'USDC', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6, usd: 1 },
  ],
  world: [
    { symbol: 'USDC', address: '0x79A02482A880bCE3F13e09Da970dC34db4CD24d1', decimals: 6, usd: 1 },
  ],
};

/** RPC endpoint for an EVM rail name. */
export function evmRpcFor(rail) {
  // A rail with no RPC here reports NO balance at all — silently. Every entry
  // in EVM_FUNDING_ASSETS needs a row, or `openzoo balance` just omits the
  // chain and the user concludes they hold nothing there.
  if (rail === 'base') return config.baseRpcUrl;
  if (rail === 'robinhood') return config.rhRpcUrl;
  if (rail === 'arbitrum') return process.env.OPENZOO_ARBITRUM_RPC || 'https://arb1.arbitrum.io/rpc';
  if (rail === 'optimism') return process.env.OPENZOO_OPTIMISM_RPC || 'https://mainnet.optimism.io';
  if (rail === 'world') return process.env.OPENZOO_WORLD_RPC || 'https://worldchain-mainnet.gateway.tenderly.co';
  return null;
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
 * What a user funds each rail with. Every rail is quoted in the mint the user
 * funds — fund it, spend it, nothing in between. This list used to distinguish
 * "underlying" from the settlement mint because the 402 named Token-2022 and
 * ERC-4626 twins the shim minted at payment time; that distinction is gone
 * along with the twins, and the two are now the same asset on every rail.
 */
export const RAIL_FUNDING = {
  solana: { label: 'Solana', assets: ['USDC', 'TOKEN', 'LEOS'] },
  base: { label: 'Base', assets: ['USDC'] },
  robinhood: { label: 'Robinhood Chain', assets: ['USDG'] },
  arbitrum: { label: 'Arbitrum', assets: ['USDC'] },
  optimism: { label: 'Optimism', assets: ['USDC'] },
  world: { label: 'World Chain', assets: ['USDC'] },
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
 */
export async function liveRails() {
  const r = await fetchHeaders(`${config.apiBase}/v1/chat/completions`, {
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
