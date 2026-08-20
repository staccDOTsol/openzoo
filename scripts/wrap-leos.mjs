/**
 * Seed the wLEOSx pool: wrap LEOS from ~/jjj.json into the twin.
 *
 *   node scripts/wrap-leos.mjs                 # dry run — prints, sends nothing
 *   node scripts/wrap-leos.mjs --confirm       # sends it
 *   node scripts/wrap-leos.mjs --amount 50000 --confirm
 *
 * Why this exists: the twin minted fine, the gateway quotes it and the
 * facilitator serves it — but the escrow holds ZERO, so wLEOSx has no reserves,
 * no supply and no holders. fragged.app/api/wrap-markets lists 12 markets and
 * omits this one for exactly that reason: there is nothing to index yet. The
 * first deposit is what makes the rail real.
 *
 * LEOS is the odd one out on this program, in two ways that are easy to get
 * wrong and impossible to undo:
 *   - NINE decimals, not six. Amounts here are converted with the mint's own
 *     decimals, read on chain, never a constant.
 *   - LEGACY SPL, not Token-2022. The escrow ATA lives under TokenkegQ..., so
 *     Wrap account 8 is TokenkegQ and account 4 is Token-2022. They are not
 *     interchangeable. An ATA derived under the wrong program is a DIFFERENT
 *     ADDRESS — funds sent there are not recoverable by this script. The
 *     program CPIs the deposit; do not append a separate TransferChecked.
 *
 * Dry run by default on purpose: this moves real value, so sending requires
 * saying so explicitly.
 */
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getMint, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { readFileSync } from 'node:fs';
import { resolvePool, poolState, buildWrapInstructions } from '../lib/wrap.js';

const WRAPPED = new PublicKey('3FViQRMqtG6dUDFxZyyVvpM9xTHsKdX7uqZ5jvL8NZ35'); // wLEOSx
const LEOS = new PublicKey('5xgsnby6P9zqGK71J7H4yJLxzqPvNbC7rDZxNzjHmj7e');

const argv = process.argv.slice(2);
const confirm = argv.includes('--confirm');
const amountArg = argv[argv.indexOf('--amount') + 1];

const owner = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(process.env.HOME + '/jjj.json', 'utf8'))),
);
const conn = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');

// Decimals off the mint, never assumed — this is the 9dp asset.
const mint = await getMint(conn, LEOS, 'confirmed', TOKEN_PROGRAM_ID);
const ata = getAssociatedTokenAddressSync(LEOS, owner.publicKey, false, TOKEN_PROGRAM_ID);
const bal = await conn.getTokenAccountBalance(ata).catch(() => null);
if (!bal) {
  console.log('  no LEOS token account on this key — nothing to wrap');
  process.exit(1);
}
const held = BigInt(bal.value.amount);

// Default to a tenth of the balance: enough to make the market real without
// committing the whole bag on a first deposit.
const depositRaw = amountArg
  ? BigInt(Math.round(Number(amountArg) * 10 ** mint.decimals))
  : held / 10n;

const ui = (raw) => (Number(raw) / 10 ** mint.decimals).toLocaleString(undefined, { maximumFractionDigits: 4 });

const pool = await resolvePool(conn, WRAPPED.toBase58());
const { reserves, supply } = await poolState(conn, pool);

console.log('\nwrap LEOS -> wLEOSx');
console.log('  owner        ', owner.publicKey.toBase58());
console.log('  LEOS held    ', ui(held), `(${mint.decimals} decimals, program ${TOKEN_PROGRAM_ID.toBase58().slice(0, 8)}…)`);
console.log('  depositing   ', ui(depositRaw));
console.log('  escrow now   ', ui(reserves), '| wLEOSx supply', ui(supply));
console.log('  escrow       ', pool.escrow.toBase58());

if (depositRaw <= 0n) { console.log('\n  nothing to deposit'); process.exit(1); }
if (depositRaw > held) { console.log('\n  deposit exceeds balance'); process.exit(1); }

if (!confirm) {
  console.log('\n  DRY RUN — nothing sent. Re-run with --confirm to send it.\n');
  process.exit(0);
}

const tx = new Transaction().add(
  ...buildWrapInstructions({ pool, owner: owner.publicKey, depositRaw }),
);
try {
  const sig = await sendAndConfirmTransaction(conn, tx, [owner]);
  const after = await poolState(conn, pool);
  console.log('\n  sent', sig);
  console.log('  escrow now   ', ui(after.reserves), '| wLEOSx supply', ui(after.supply), '\n');
} catch (e) {
  console.log('\n  FAILED:', String(e.message).slice(0, 300));
  (e.logs ?? []).slice(-6).forEach((l) => console.log('   ', l));
  process.exit(1);
}
