import { Connection } from '@solana/web3.js';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from './config.js';
import { loadOrCreateWallet } from './wallet.js';
import { tokenBalance } from './x402.js';

const YUSDCX = '6ZjjxcoicqM4nniddkuPVwew4PDwY3swbfHsGbCuLuTv';
const WTOKENX = 'Bo7xBF7SY8EyUBPUxRP66SFafxoPf2n5uqiLjbxEebx9';

export function printAddress() {
  const { keypair, evmPrivateKey, created, path } = loadOrCreateWallet();
  if (created) console.log(`new burner wallet created at ${path} (chmod 600)`);
  console.log(keypair.publicKey.toBase58());
  console.log(`(evm, for Base/RH rails — untested: ${privateKeyToAccount(evmPrivateKey).address})`);
}

export async function printBalance() {
  const { keypair } = loadOrCreateWallet();
  const connection = new Connection(config.rpcUrl, 'confirmed');
  const [y, w] = await Promise.all([
    tokenBalance(connection, keypair.publicKey, YUSDCX),
    tokenBalance(connection, keypair.publicKey, WTOKENX),
  ]);
  console.log(`wallet : ${keypair.publicKey.toBase58()}`);
  console.log(`yUSDCx : ${y.ui ?? 0}   (mint ${YUSDCX})`);
  console.log(`wTOKENx: ${w.ui ?? 0}   (mint ${WTOKENX})`);
  if (!y.raw && !w.raw) {
    console.log('unfunded — wrap USDC into yUSDCx at https://x402.accrue.fund/start and send it here.');
  }
}
