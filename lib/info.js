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
export async function printBalance() {
  const { keypair, evmPrivateKey } = loadOrCreateWallet();
  const evmAddress = privateKeyToAccount(evmPrivateKey).address;
  const connection = new Connection(config.rpcUrl, 'confirmed');

  // Solana ------------------------------------------------------------------
  const [balances, lamports] = await Promise.all([
    Promise.all(FUNDING_ASSETS.map((a) => tokenBalance(connection, keypair.publicKey, a.mint))),
    connection.getBalance(keypair.publicKey),
  ]);
  const usdcUi = balances[0].ui ?? 0;
  let knownUsd = usdcUi;
  let anyFunds = balances.some((b) => b.raw);

  console.log(`Solana — ${keypair.publicKey.toBase58()}`);
  FUNDING_ASSETS.forEach((a, i) => {
    const usd = a.symbol === 'USDC' ? ` ($${(balances[i].ui ?? 0).toFixed(2)})` : ' ($?, valued at the 402)';
    console.log(`  ${a.symbol.padEnd(11)}: ${balances[i].ui ?? 0}${usd}`);
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
        if (a.usd != null) knownUsd += ui * a.usd;
        const usd = a.usd != null ? ` ($${(ui * a.usd).toFixed(2)})` : ' ($?)';
        console.log(`  ${a.symbol.padEnd(11)}: ${ui}${usd}`);
      });
      console.log(`  ${'ETH'.padEnd(11)}: ${fmtUi(native, 18)} (gas — optional, payments are sponsored)`);
    } catch {
      console.log('  (rpc unreachable — balances not checked, funds unaffected)');
    }
  }

  console.log(`value : ≈ $${knownUsd.toFixed(2)} known (stable legs; TOKEN and the RH memecoins are priced at the 402, shown as $?)`);
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
export async function topUp(usdArg) {
  const usd = Number(usdArg);
  if (!Number.isFinite(usd) || usd < 1 || usd > 500) {
    throw new Error('usage: openzoo topup <usd>   (1-500)');
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
