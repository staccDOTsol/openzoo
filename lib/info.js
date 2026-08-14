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
