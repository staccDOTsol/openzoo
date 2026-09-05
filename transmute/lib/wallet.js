// Signer discovery. Order: --keypair / OPENZOO_KEYPAIR path → the openzoo
// burner wallet (~/.openzoo/wallet.json, {solana:[64 bytes]} or a bare
// solana-keygen array) → the Solana CLI keypair (~/.config/solana/id.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';

export function keypairFromFile(p) {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const bytes = Array.isArray(raw) ? raw : raw.solana;
  if (!bytes) throw new Error(`${p}: not a keypair file`);
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

export function loadWallet({ keypair } = {}) {
  const candidates = [
    keypair,
    process.env.OPENZOO_KEYPAIR,
    process.env.OPENZOO_WALLET || path.join(os.homedir(), '.openzoo', 'wallet.json'),
    path.join(os.homedir(), '.config', 'solana', 'id.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return { keypair: keypairFromFile(p), path: p };
  }
  throw new Error(`no wallet found (tried ${candidates.join(', ')}); run \`npx openzoo address\` to create the burner wallet or pass --keypair`);
}

export function rpcUrl(cluster) {
  const c = cluster || process.env.OPENZOO_CLUSTER || 'mainnet';
  if (/^https?:\/\//.test(c)) return c;
  switch (c) {
    case 'localnet': case 'localhost': case 'local': return 'http://127.0.0.1:8899';
    case 'devnet': return 'https://api.devnet.solana.com';
    case 'testnet': return 'https://api.testnet.solana.com';
    case 'mainnet': case 'mainnet-beta':
      // Same default as the openzoo proxy (public mainnet RPC rate-limits hard).
      return process.env.OPENZOO_RPC || 'https://eu.fluxrpc.com?key=ab9278e1-6430-41ab-aee0-ac6b759a1fe4';
    default: throw new Error(`unknown cluster ${c}`);
  }
}
