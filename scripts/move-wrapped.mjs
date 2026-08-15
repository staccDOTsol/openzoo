#!/usr/bin/env node
/**
 * Move WRAPPED twins (wTOKENx / yUSDCx) from the treasury to any address.
 *
 *   node scripts/move-wrapped.mjs                 # dry run, shows everything
 *   node scripts/move-wrapped.mjs --confirm       # actually sends
 *
 * Defaults: from the treasury keypair (~/jjj.json = WzMaL78…ngqpb) to the
 * local burner wallet (~/.openzoo/wallet.json). Override with --from/--to/--mint/--amount.
 *
 * NOTE ON FEES: these are Token-2022 mints carrying a 20bps transfer fee, so
 * the recipient receives slightly LESS than the amount sent — the withheld
 * part is harvested later by CrankFees and raises NAV for every holder. The
 * dry run prints the exact expected delivery, computed from the mint's own
 * TransferFeeConfig rather than assumed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, getMint, getTransferFeeConfig,
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  calculateEpochFee, getAccount,
} from '@solana/spl-token';

const TWINS = {
  wTOKENx: 'Bo7xBF7SY8EyUBPUxRP66SFafxoPf2n5uqiLjbxEebx9',
  yUSDCx: '6ZjjxcoicqM4nniddkuPVwew4PDwY3swbfHsGbCuLuTv',
};

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const CONFIRM = process.argv.includes('--confirm');

function loadKeypair(p) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, 'utf8'))));
}

function defaultDestination() {
  const w = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.openzoo', 'wallet.json'), 'utf8'));
  const sol = w.solana;
  // wallet.json stores the burner's 64-byte secret; derive its address.
  return Keypair.fromSecretKey(Uint8Array.from(Array.isArray(sol) ? sol : JSON.parse(sol))).publicKey;
}

const ui = (raw, dec) => Number(raw) / 10 ** dec;

async function main() {
  const rpc = process.env.OPENZOO_RPC || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpc, 'confirmed');
  const payer = loadKeypair(arg('from', path.join(os.homedir(), 'jjj.json')));
  const to = new PublicKey(arg('to', defaultDestination().toBase58()));
  const only = arg('mint', null);

  console.log(`from: ${payer.publicKey.toBase58()}`);
  console.log(`to:   ${to.toBase58()}`);
  console.log(`mode: ${CONFIRM ? 'SEND (--confirm given)' : 'DRY RUN — add --confirm to send'}\n`);

  for (const [symbol, mintStr] of Object.entries(TWINS)) {
    if (only && only !== symbol && only !== mintStr) continue;
    const mint = new PublicKey(mintStr);
    const info = await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
    const src = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);

    let held = 0n;
    try { held = (await getAccount(connection, src, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount; } catch { /* no ATA */ }
    if (held === 0n) { console.log(`${symbol}: nothing held, skipping`); continue; }

    const amountArg = arg('amount', 'all');
    const amount = amountArg === 'all' ? held : BigInt(Math.round(Number(amountArg) * 10 ** info.decimals));
    if (amount > held) throw new Error(`${symbol}: asked to send ${amountArg} but only ${ui(held, info.decimals)} held`);

    // Fee comes from the mint itself — never hardcode 20bps. Token-2022 keeps
    // an older AND a newer fee and picks by EPOCH, so ask calculateEpochFee
    // with the live epoch: reading newerTransferFee directly gives the wrong
    // number whenever a fee change has not activated yet.
    const cfg = getTransferFeeConfig(info);
    const { epoch } = await connection.getEpochInfo();
    const fee = cfg ? calculateEpochFee(cfg, BigInt(epoch), amount) : 0n;
    const bps = cfg ? cfg.newerTransferFee.transferFeeBasisPoints : 0;

    console.log(`${symbol}: sending ${ui(amount, info.decimals)} — fee ${bps}bps = ${ui(fee, info.decimals)}, `
      + `recipient receives ${ui(amount - fee, info.decimals)}`);

    if (!CONFIRM) continue;

    const dst = getAssociatedTokenAddressSync(mint, to, false, TOKEN_2022_PROGRAM_ID);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, dst, to, mint, TOKEN_2022_PROGRAM_ID),
      // Plain TransferChecked, NOT TransferCheckedWithFee: the fee-bearing
      // extension deducts the fee itself, whereas the WithFee variant asserts
      // the client's number and fails with 0x20 ("Calculated fee does not
      // match expected fee") on any disagreement. The fee above is for the
      // human-readable preview only.
      createTransferCheckedInstruction(
        src, mint, dst, payer.publicKey, amount, info.decimals, [], TOKEN_2022_PROGRAM_ID,
      ),
    );
    const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
    console.log(`  sent — tx ${sig}`);
  }

  if (!CONFIRM) console.log('\nnothing was sent. re-run with --confirm to execute.');
}

main().catch((e) => { console.error('failed:', e.message); process.exit(1); });
