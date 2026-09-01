/**
 * A managed x402 burner per X account, DERIVED not stored.
 *
 * @openzoobot's paid lane needs the ASKER to pay, and an X reply is a terrible
 * place to ask someone to install a wallet. So each X account id gets a burner
 * the zoo drives on their behalf, funded by them and auto-topped-up, holding
 * only a working balance — the same shape as the local burner `npx openzoo`
 * already creates, one per account instead of one per machine.
 *
 * DERIVED, NOT STORED, and that is the whole security argument:
 *   seed(user) = HMAC-SHA512(master, "openzoo-xbot-v1:" + userId)
 * There is exactly ONE secret on disk no matter how many accounts ever mention
 * the bot. A per-user keyfile store would mean thousands of secrets, a backup
 * problem, a deletion problem, and a breach that scales with adoption. Here the
 * blast radius is one file that already had to be protected, and a burner can
 * be re-derived on any machine from that file alone — nothing to lose, nothing
 * to migrate, no keypair that exists only on whichever laptop ran the poller.
 *
 * The tradeoff, stated plainly: the master file CAN derive every burner, so it
 * is as sensitive as all of them combined. That is why it is 0600, never
 * logged, never sent anywhere, and why balances are kept at working size by
 * auto top-up rather than being allowed to accumulate.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Keypair } from '@solana/web3.js';

const MASTER_FILE = process.env.OPENZOO_XBOT_MASTER
  || path.join(os.homedir(), '.openzoo', 'xbot-master.key');

/** Bump if the derivation ever changes — old burners must keep deriving. */
const DERIVATION = 'openzoo-xbot-v1';

export function loadOrCreateMaster(file = MASTER_FILE) {
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    const buf = Buffer.from(hex, 'hex');
    if (buf.length === 32) return buf;
    throw new Error('bad length');
  } catch {
    const buf = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // wx: never clobber an existing master. Overwriting it would orphan every
    // burner ever handed out — funds still on-chain, key unrecoverable.
    try {
      fs.writeFileSync(file, buf.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    } catch {
      return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
    }
    return buf;
  }
}

/**
 * Deterministic burner for an X user id.
 * Keyed on the numeric id, never the handle: handles are reassignable, and a
 * burner that follows a renamed handle would hand a new owner the old wallet.
 */
export function deriveBurner(xUserId, master = loadOrCreateMaster()) {
  if (!xUserId) throw new Error('deriveBurner needs an X user id');
  const mac = crypto.createHmac('sha512', master)
    .update(`${DERIVATION}:${String(xUserId)}`)
    .digest();
  const keypair = Keypair.fromSeed(Uint8Array.from(mac.subarray(0, 32)));
  const evmPrivateKey = `0x${mac.subarray(32, 64).toString('hex')}`;
  return {
    keypair,
    evmPrivateKey,
    address: keypair.publicKey.toBase58(),
    xUserId: String(xUserId),
  };
}

/** Address only — for a reply that tells someone where to send funds. */
export function burnerAddress(xUserId, master) {
  return deriveBurner(xUserId, master).address;
}
