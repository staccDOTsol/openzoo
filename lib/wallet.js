import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { config } from './config.js';

/**
 * Local burner wallet at ~/.openzoo/wallet.json (chmod 600).
 * Format v2: { "solana": [64 secret-key bytes], "evm": "0x<32-byte hex>" }
 * Legacy format (bare 64-byte array, solana-keygen style) is migrated in place.
 * Your keys never leave this machine — the zoo only ever sees signed transfers.
 */
export function loadOrCreateWallet() {
  const p = config.walletPath;
  let solanaBytes;
  let evmKey;
  let created = false;

  if (fs.existsSync(p)) {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(raw)) {
      solanaBytes = Uint8Array.from(raw); // legacy: migrate below by adding an EVM key
    } else {
      solanaBytes = Uint8Array.from(raw.solana);
      evmKey = raw.evm;
    }
  } else {
    solanaBytes = Keypair.generate().secretKey;
    created = true;
  }
  if (!evmKey) {
    evmKey = `0x${crypto.randomBytes(32).toString('hex')}`;
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify({ solana: Array.from(solanaBytes), evm: evmKey }), { mode: 0o600 });
  }
  return {
    keypair: Keypair.fromSecretKey(solanaBytes),
    evmPrivateKey: evmKey,
    created,
    path: p,
  };
}
