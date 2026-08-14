import { Connection } from '@solana/web3.js';
import { privateKeyToAccount } from 'viem/accounts';
import { config, FUNDING_ASSETS, fundingLine } from './config.js';
import { loadOrCreateWallet } from './wallet.js';
import { tokenBalance } from './x402.js';

export function printAddress() {
  const { keypair, evmPrivateKey, created, path } = loadOrCreateWallet();
  if (created) console.log(`new burner wallet created at ${path} (chmod 600)`);
  console.log(keypair.publicKey.toBase58());
  console.log(`(evm, for the Base / Robinhood rails: ${privateKeyToAccount(evmPrivateKey).address})`);
}

export async function printBalance() {
  const { keypair } = loadOrCreateWallet();
  const connection = new Connection(config.rpcUrl, 'confirmed');
  const [balances, lamports] = await Promise.all([
    Promise.all(FUNDING_ASSETS.map((a) => tokenBalance(connection, keypair.publicKey, a.mint))),
    connection.getBalance(keypair.publicKey),
  ]);
  const usdcUi = balances[0].ui ?? 0;
  console.log(`wallet : ${keypair.publicKey.toBase58()}`);
  FUNDING_ASSETS.forEach((a, i) => {
    console.log(`${a.symbol.padEnd(7)}: ${balances[i].ui ?? 0}`);
  });
  console.log(`SOL    : ${lamports / 1e9}`);
  console.log(`value  : ≈ $${usdcUi.toFixed(2)} (USDC leg; TOKEN valued at the 402)`);
  if (!balances.some((b) => b.raw)) {
    console.log(`fund   : ${fundingLine(keypair.publicKey.toBase58())}`);
  }
}
