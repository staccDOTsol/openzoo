import { Connection } from '@solana/web3.js';
import { privateKeyToAccount } from 'viem/accounts';
import { config, FUNDING_ASSETS, EVM_FUNDING_ASSETS, evmRpcFor, fundingLine } from './config.js';
import { loadOrCreateWallet } from './wallet.js';
import { tokenBalance } from './x402.js';
import { evmTokenBalance, evmNativeBalance } from './evm.js';

export function printAddress() {
  const { keypair, evmPrivateKey, created, path } = loadOrCreateWallet();
  if (created) console.log(`new burner wallet created at ${path} (chmod 600)`);
  console.log(`solana                    : ${keypair.publicKey.toBase58()}`);
  console.log(`evm (Base · Robinhood)    : ${privateKeyToAccount(evmPrivateKey).address}`);
}

const CHAIN_LABEL = { base: 'Base', robinhood: 'Robinhood Chain' };

function fmtUi(raw, decimals) {
  return Number(raw) / 10 ** decimals;
}

/**
 * Balance across every rail: Solana (USDC + TOKEN + SOL) and each EVM chain
 * (stables, the RH memecoins, native gas). USD value is shown only where a
 * price is known ($1 stables); everything else gets an honest `?`.
 * A chain whose RPC does not answer prints as unreachable — never as zero.
 */
/**
 * USD per whole token, by SYMBOL, straight from the 402 quote.
 *
 * The quote already carries `extra.tokenUsd` for every asset it settles in —
 * the very "priced at the 402" this file kept promising in a footnote while
 * printing `$?`. So a wallet holding 845,486 TOKEN summed to "≈ $0.11 known".
 * Symbols come back wrapped (wTOKENx, wLEOSx, wUSDGx); strip the wrapper so a
 * row for the plain token the user actually holds finds its price.
 */
export async function quotedPrices() {
  const out = {};
  try {
    // Imported here, not at module scope, matching affordableUsd below — this
    // file is loaded by `openzoo address`, which must work with no network.
    // PRICE OFF THE CHAT 402, NOT THE CREDIT 402.
    //
    // /v1/credits/topup sells a USD-denominated product, so every rail in its
    // challenge quotes tokenUsd = 1 — a dollar of credit costs a dollar,
    // whichever asset pays for it. Reading unit prices from there valued every
    // holding at $1: MEASURED, a wallet of 776,302 TOKEN (actually worth ~$178 at the
    // chat 402's 0.00022906) printed "$776302.53", and 1,985 ROBINHOODS worth
    // ~$0.01 printed "$1985.78". Total "≈ $778288.41" for roughly $180 of
    // assets — and `openzoo topup all` then tried to buy $758,819 of credit off
    // that number.
    //
    // The chat challenge prices each asset at its real spot (DexScreener), and
    // needs no namespace signature, so it is both correct and simpler.
    const r = await fetch(`${config.apiBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.defaultModel || 'anthropic/claude-sonnet-5', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }),
    });
    if (r.status !== 402) return out;
    const ch = await r.json().catch(() => ({}));
    for (const row of ch.accepts || []) {
      const usd = Number(row?.extra?.tokenUsd);
      const sym = String(row?.extra?.symbol || '');
      if (!sym || !Number.isFinite(usd)) continue;
      // wTOKENx -> TOKEN, wUSDGx -> USDG, yUSDCx -> USDC
      const plain = sym.replace(/^[wy]/, '').replace(/x$/, '').toUpperCase();
      out[sym.toUpperCase()] = usd;
      if (!(plain in out)) out[plain] = usd;
    }
  } catch { /* offline: fall back to printing what we know */ }
  return out;
}

export async function printBalance() {
  const { keypair, evmPrivateKey } = loadOrCreateWallet();
  const px = await quotedPrices();
  const priceOf = (sym) => px[String(sym).toUpperCase()];
  const show = (sym, ui) => {
    const p = priceOf(sym);
    if (p == null) return ' ($?)';
    const v = ui * p;
    // Sub-cent holdings read as "$0.00", which is indistinguishable from
    // worthless; show enough digits that a real balance is visible.
    return ` ($${v >= 0.01 || v === 0 ? v.toFixed(2) : v.toFixed(6)})`;
  };
  const evmAddress = privateKeyToAccount(evmPrivateKey).address;
  const connection = new Connection(config.rpcUrl, 'confirmed');

  // Solana ------------------------------------------------------------------
  const [balances, lamports] = await Promise.all([
    Promise.all(FUNDING_ASSETS.map((a) => tokenBalance(connection, keypair.publicKey, a.mint))),
    connection.getBalance(keypair.publicKey),
  ]);
  // Seeded at zero: every asset is priced from the quote below, so seeding
  // with USDC would count it twice.
  let knownUsd = 0;
  let anyFunds = balances.some((b) => b.raw);

  console.log(`Solana — ${keypair.publicKey.toBase58()}`);
  FUNDING_ASSETS.forEach((a, i) => {
    const ui = balances[i].ui ?? 0;
    const p = priceOf(a.symbol);
    if (p != null) knownUsd += ui * p;
    console.log(`  ${a.symbol.padEnd(11)}: ${ui}${show(a.symbol, ui)}`);
  });
  console.log(`  ${'SOL'.padEnd(11)}: ${lamports / 1e9} (gas — optional, payments are sponsored)`);

  // EVM chains --------------------------------------------------------------
  for (const [rail, assets] of Object.entries(EVM_FUNDING_ASSETS)) {
    const rpcUrl = evmRpcFor(rail);
    console.log(`${CHAIN_LABEL[rail] ?? rail} — ${evmAddress}`);
    try {
      const [native, ...raws] = await Promise.all([
        evmNativeBalance({ rpcUrl, owner: evmAddress }),
        ...assets.map((a) => evmTokenBalance({ rpcUrl, token: a.address, owner: evmAddress })),
      ]);
      assets.forEach((a, i) => {
        const ui = fmtUi(raws[i], a.decimals);
        if (raws[i] > 0n) anyFunds = true;
        const p = priceOf(a.symbol) ?? a.usd;
        if (p != null) knownUsd += ui * p;
        console.log(`  ${a.symbol.padEnd(11)}: ${ui}${p != null ? show(a.symbol, ui) : ' ($?)'}`);
      });
      console.log(`  ${'ETH'.padEnd(11)}: ${fmtUi(native, 18)} (gas — optional, payments are sponsored)`);
    } catch {
      console.log('  (rpc unreachable — balances not checked, funds unaffected)');
    }
  }

  console.log(`value : ≈ $${knownUsd.toFixed(2)}${Object.keys(px).length ? ' (every asset priced at the 402)' : ' known (402 unreachable — unpriced assets shown as $?)'}`);
  if (!anyFunds) {
    console.log(`fund  : ${fundingLine(keypair.publicKey.toBase58())}`);
    console.log(`        or USDC on Base to ${evmAddress}`);
  }
}

/**
 * PREPAY. Buys gateway credit in ONE settlement so later calls skip the
 * per-call payment round trip entirely.
 *
 * That round trip is where the latency lives, not the model: MEASURED against
 * the live gateway, a 402 challenge comes back in 0.12s while a full paid call
 * takes 9-37s end to end. The gateway already applies credit automatically
 * whenever a balance covers the quote — nothing could BUY it until now.
 *
 * Credit is keyed by the signed namespace, so it belongs to this wallet and
 * cannot be spent by anyone else.
 */
/**
 * How much credit this wallet can actually afford, in USD.
 *
 * Derived from a LIVE quote rather than our own price table: ask the gateway
 * to price $1 of credit, read what each rail wants in raw units, and divide
 * our balance by it. That way TOKEN (whose USD price we do not carry) is
 * valued exactly as the gateway values it at settlement time.
 */
export async function affordableUsd() {
  const { PayClient } = await import('./pay.js');
  const { withNamespace } = await import('./namespace.js');
  const client = new PayClient();
  const r = await fetch(`${config.apiBase}/v1/credits/topup`, {
    method: 'POST',
    headers: withNamespace({ 'content-type': 'application/json' }),
    body: JSON.stringify({ usd: 1 }),
  });
  if (r.status !== 402) return 0;
  const ch = await r.json().catch(() => ({}));
  let best = 0;
  for (const row of ch.accepts || []) {
    const perUsd = BigInt(row.maxAmountRequired || '0');
    if (perUsd <= 0n) continue;
    try {
      // SPENDABLE, not merely wrapped. Every quote names the WRAPPER, and the
      // plain token is converted at payment time (topUpQuotedAsset /
      // acquireWrappedIfNeeded) — so counting only pre-wrapped balance told a
      // user holding 14,847 TOKEN that their wallet "covers only $1.0230" and
      // sent them off to fund an account that was already funded.
      let usd;
      if (client.spendableUsdForAccept) {
        usd = await client.spendableUsdForAccept(row);
      } else {
        const bal = await client.balanceForAccept?.(row);
        const raw = typeof bal === 'bigint' ? bal : BigInt(bal?.raw ?? 0);
        usd = Number(raw * 1000n / perUsd) / 1000;
      }
      if (Number.isFinite(usd) && usd > best) best = usd;
    } catch { /* a rail we cannot read is simply not a candidate */ }
  }
  return best;
}

export async function topUp(usdArg) {
  // "all" spends everything the wallet can cover, minus a small margin so a
  // price tick between quote and settle does not fail the payment outright.
  // A BARE `openzoo topup` IS NOT `all`.
  //
  // It used to be, and the result was alarming: with a TOKEN-heavy wallet the
  // no-arg form printed "wallet covers ~$782288.39 — buying $758819.73" and only
  // THEN hit the 1-500 clamp and threw. Nothing was ever spent, but a user
  // reading their terminal has every reason to think a three-quarter-million
  // dollar purchase just started. A command with no argument prints usage and
  // touches no wallet.
  if (usdArg === undefined || usdArg === null || String(usdArg).trim() === '') {
    throw new Error('usage: openzoo topup <usd|all>   (1-500)');
  }
  const MAX_TOPUP = 500;
  let usd = Number(usdArg);
  if (String(usdArg).toLowerCase() === 'all') {
    const max = await affordableUsd();
    // CLAMP TO THE CEILING THE VALIDATOR ENFORCES. Without this, "all" on any
    // wallet worth more than ~$515 computes a number the very next line
    // rejects, so the feature was unusable for exactly the wallets it was for.
    usd = Math.min(Math.floor(max * 0.97 * 100) / 100, MAX_TOPUP);
    if (!(usd >= 1)) throw new Error(`wallet covers only $${max.toFixed(4)} of credit — fund it first (openzoo balance)`);
    console.log(max > MAX_TOPUP
      ? `wallet covers ~$${max.toFixed(2)} — buying $${usd.toFixed(2)} (per-topup max is $${MAX_TOPUP}; run it again for more)`
      : `wallet covers ~$${max.toFixed(2)} — buying $${usd.toFixed(2)}`);
  }
  if (!Number.isFinite(usd) || usd < 1 || usd > MAX_TOPUP) {
    throw new Error(`usage: openzoo topup <usd|all>   (1-${MAX_TOPUP})`);
  }
  const { PayClient } = await import('./pay.js');
  const client = new PayClient();
  const url = `${config.apiBase}/v1/credits/topup`;

  const before = await creditBalance();
  console.log(`credit before: $${before.toFixed(6)}`);
  console.log(`buying $${usd.toFixed(2)} of credit — one on-chain settlement...`);

  const { response, paid } = await client.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ usd }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`topup failed (HTTP ${response.status}): ${body.error || body.detail || 'unknown'}`);
  }
  console.log('');
  console.log(`credited:  $${Number(body.creditedUsd ?? usd).toFixed(2)}${paid ? '' : ' (from existing credit)'}`);
  console.log(`balance:   $${Number(body.balanceUsd ?? 0).toFixed(6)}`);
  if (body.tx) console.log(`tx:        ${body.tx}`);
  console.log('');
  console.log('calls now settle against this balance instead of paying on-chain each time.');
}

export { priceHoldings, formatHoldingMoney } from './livestatus.js';

/** Current prepaid credit for this wallet's namespace. */
export async function creditBalance() {
  const { withNamespace } = await import('./namespace.js');
  try {
    const r = await fetch(`${config.apiBase}/v1/credits`, { headers: withNamespace({}) });
    const j = await r.json();
    return Number(j.balanceUsd) || 0;
  } catch {
    return 0;
  }
}
