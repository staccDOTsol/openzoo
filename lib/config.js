import os from 'node:os';
import path from 'node:path';

export const config = {
  port: Number(process.env.OPENZOO_PORT || 8402),
  apiBase: (process.env.OPENZOO_API_BASE || 'https://x402-tokens.fly.dev').replace(/\/+$/, ''),
  rpcUrl: process.env.OPENZOO_RPC || 'https://api.mainnet-beta.solana.com',
  // Which accepts[] row to pay with, by extra.symbol (internal rail selector).
  token: process.env.OPENZOO_TOKEN || 'yUSDCx',
  walletPath: process.env.OPENZOO_WALLET || path.join(os.homedir(), '.openzoo', 'wallet.json'),
  // Refuse to auto-pay any single 402 quote above this many USD (extra.billedUsd).
  maxUsdPerCall: Number(process.env.OPENZOO_MAX_USD_PER_CALL || 0.5),
  // Demo will only actually pay if the quote is at or below this.
  demoMaxUsd: Number(process.env.OPENZOO_DEMO_MAX_USD || 0.01),
};
