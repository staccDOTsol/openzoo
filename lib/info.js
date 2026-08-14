import { Connection } from '@solana/web3.js';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from './config.js';
import { loadOrCreateWallet } from './wallet.js';
import { tokenBalance } from './x402.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export function printAddress() {
  const { keypair, evmPrivateKey, created, path } = loadOrCreateWallet();
  if (created) console.log(`new burner wallet created at ${path} (chmod 600)`);
  console.log(keypair.publicKey.toBase58());
  console.log(`(evm, for Base/RH rails — untested: ${privateKeyToAccount(evmPrivateKey).address})`);
}

export async function printBalance() {
  const { keypair } = loadOrCreateWallet();
  const connection = new Connection(config.rpcUrl, 'confirmed');
  const [usdc, lamports] = await Promise.all([
    tokenBalance(connection, keypair.publicKey, USDC),
    connection.getBalance(keypair.publicKey),
  ]);
  const usdcUi = usdc.ui ?? 0;
  console.log(`wallet : ${keypair.publicKey.toBase58()}`);
  console.log(`USDC   : ${usdcUi}`);
  console.log(`SOL    : ${lamports / 1e9}`);
  console.log(`value  : ≈ $${usdcUi.toFixed(2)}`);
  if (!usdc.raw) {
    console.log(`fund   : send a few cents of USDC to ${keypair.publicKey.toBase58()}`);
  }
}
