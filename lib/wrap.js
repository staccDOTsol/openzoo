/**
 * Internal funding plumbing for Solana 402 rails.
 *
 * The zoo's Solana quotes settle in a NAV-wrapped Token-2022 mint issued by
 * the wrap-nav program (FrSER…). Users only ever hold and send plain USDC or
 * TOKEN (EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump) —
 * this module converts the exact amount needed, at payment time, inside the
 * shim. Nothing here is user-facing; never surface wrapped tickers or mints
 * in messages that reach the user.
 *
 * Verified against the deployed program's own e2e (solana-token-wrap/e2e/e2e.mjs)
 * and live mainnet wrap transactions:
 *   wrap ix: data = [1][amount u64 LE][authority bump]
 *            keys = [escrow(w), wrappedMint(w), userWrappedAta(w),
 *                    authorityPDA, wrappedTokenProgram]
 *   shares minted = floor(amount * supply / reserves), reserves read at ix
 *   execution — so the wrap ix is placed BEFORE the deposit TransferChecked.
 *   First deposit is 1:1 minus MINIMUM_LIQUIDITY (1000) locked forever.
 *   authority = PDA(['mint_authority', wrappedMint]); escrow = ATA(underlying,
 *   authority); registry = PDA(['backpointer', wrappedMint]) when present.
 */
import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from '@solana/spl-token';

export const WRAP_PROGRAM_ID = new PublicKey('FrSERTNCPvTtaDS9AvQp9u1nYGzXDb3kC9MdL8Xxn2NE');
const AUTHORITY_SEED = Buffer.from('mint_authority');
const BACKPOINTER_SEED = Buffer.from('backpointer');
export const MINIMUM_LIQUIDITY = 1000n;

// Machine-readable per-asset acquire directory published by the facilitator.
// Consulted first so newly listed twins work with zero code changes; on-chain
// derivation below is the fallback when the endpoint is unreachable.
const SUPPORTED_URL = process.env.OPENZOO_SUPPORTED_URL || 'https://x402.accrue.fund/supported';
let directoryCache = { at: 0, kinds: null };

async function acquireDirectory() {
  if (directoryCache.kinds && Date.now() - directoryCache.at < 300000) return directoryCache.kinds;
  try {
    const r = await fetch(SUPPORTED_URL, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    if (Array.isArray(body?.kinds)) directoryCache = { at: Date.now(), kinds: body.kinds };
  } catch { /* endpoint down — fall back to chain derivation */ }
  return directoryCache.kinds;
}

/** /supported entry for a quoted Solana mint, or null. */
async function directoryEntryFor(wrappedMintStr) {
  const kinds = await acquireDirectory();
  if (!kinds) return null;
  const row = kinds.find((k) => k?.network?.startsWith?.('solana:') && k?.extra?.asset === wrappedMintStr);
  const acq = row?.extra?.acquire;
  return acq?.method === 'spl-token-wrap' && acq.underlying?.address && acq.escrow ? acq : null;
}

function u64le(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }

/**
 * Resolve the pool behind a quoted mint. Returns null when the mint is not a
 * wrap-nav twin (then there is nothing this module can do for it).
 * Generic over whatever mint the 402 quotes — nothing hardcoded per twin.
 */
export async function resolvePool(connection, wrappedMintStr) {
  const wrapped = new PublicKey(wrappedMintStr);
  const info = await connection.getAccountInfo(wrapped);
  if (!info) return null;
  const wrappedProgram = info.owner;
  let mint;
  try { mint = unpackMint(wrapped, info, wrappedProgram); } catch { return null; }

  // Preferred source: the facilitator's own /supported directory.
  const acq = await directoryEntryFor(wrappedMintStr);
  if (acq) {
    const programId = new PublicKey(acq.program || WRAP_PROGRAM_ID);
    const authority = new PublicKey(acq.mintAuthority);
    let bump = acq.authorityBump;
    if (bump == null) {
      const [derived, derivedBump] = PublicKey.findProgramAddressSync(
        [AUTHORITY_SEED, wrapped.toBuffer()], programId,
      );
      if (derived.equals(authority)) bump = derivedBump;
    }
    if (bump != null && mint.mintAuthority?.equals(authority)) {
      return {
        wrapped,
        wrappedProgram,
        programId,
        authority,
        bump,
        escrow: new PublicKey(acq.escrow),
        underlying: new PublicKey(acq.underlying.address),
        underlyingProgram: new PublicKey(acq.underlying.tokenProgram || TOKEN_PROGRAM_ID),
        underlyingDecimals: acq.underlying.decimals ?? 6,
      };
    }
  }

  // Fallback: derive everything from chain state.
  const [authority, bump] = PublicKey.findProgramAddressSync(
    [AUTHORITY_SEED, wrapped.toBuffer()], WRAP_PROGRAM_ID,
  );
  if (!mint.mintAuthority || !mint.mintAuthority.equals(authority)) return null;

  // Prefer the on-chain backpointer registry; fall back to the authority's
  // token accounts (older pools were created before registration existed).
  let underlying; let escrow; let underlyingProgram;
  const [backpointer] = PublicKey.findProgramAddressSync(
    [BACKPOINTER_SEED, wrapped.toBuffer()], WRAP_PROGRAM_ID,
  );
  const bp = await connection.getAccountInfo(backpointer);
  if (bp && bp.owner.equals(WRAP_PROGRAM_ID) && bp.data.length >= 96) {
    underlying = new PublicKey(bp.data.subarray(0, 32));
    escrow = new PublicKey(bp.data.subarray(32, 64));
    underlyingProgram = new PublicKey(bp.data.subarray(64, 96));
  } else {
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const res = await connection.getTokenAccountsByOwner(authority, { programId });
      if (res.value.length) {
        const first = res.value[0];
        const acc = unpackAccount(first.pubkey, first.account, programId);
        escrow = first.pubkey;
        underlying = acc.mint;
        underlyingProgram = programId;
        break;
      }
    }
    if (!escrow) return null;
  }

  const uInfo = await connection.getAccountInfo(underlying);
  if (!uInfo) return null;
  const uMint = unpackMint(underlying, uInfo, underlyingProgram);
  return {
    wrapped,
    wrappedProgram,
    programId: WRAP_PROGRAM_ID,
    authority,
    bump,
    escrow,
    underlying,
    underlyingProgram,
    underlyingDecimals: uMint.decimals,
  };
}

/**
 * Underlying deposit required so that floor(deposit * supply / reserves)
 * covers `sharesNeeded`. A small margin absorbs NAV drift between the read
 * and the landing slot (donations/burns only ever reduce shares-per-asset).
 */
export function depositForShares(sharesNeeded, reserves, supply) {
  if (supply === 0n || reserves === 0n) return sharesNeeded + MINIMUM_LIQUIDITY;
  const exact = (sharesNeeded * reserves + supply - 1n) / supply; // ceil
  return exact + exact / 200n + 2n; // +0.5% + 2 raw units of drift margin
}

/** Current pool state: escrow reserves and wrapped supply, both raw bigint. */
export async function poolState(connection, pool) {
  const [esc, sup] = await Promise.all([
    connection.getTokenAccountBalance(pool.escrow).then((r) => BigInt(r.value.amount)).catch(() => 0n),
    connection.getTokenSupply(pool.wrapped).then((r) => BigInt(r.value.amount)),
  ]);
  return { reserves: esc, supply: sup };
}

/**
 * The three instructions of a conversion, in the mainnet-proven order:
 * ensure the wrapped ATA, mint shares (program reads pre-deposit reserves),
 * then move the deposit into escrow. `rentPayer` funds ATA creation (defaults
 * to the owner; the gateway feePayer when riding inside a payment tx).
 */
export function buildWrapInstructions({ pool, owner, depositRaw, rentPayer = owner }) {
  const userWrapped = getAssociatedTokenAddressSync(pool.wrapped, owner, false, pool.wrappedProgram);
  const userUnderlying = getAssociatedTokenAddressSync(pool.underlying, owner, false, pool.underlyingProgram);
  const wrapIx = new TransactionInstruction({
    programId: pool.programId || WRAP_PROGRAM_ID,
    keys: [
      { pubkey: pool.escrow, isSigner: false, isWritable: true },
      { pubkey: pool.wrapped, isSigner: false, isWritable: true },
      { pubkey: userWrapped, isSigner: false, isWritable: true },
      { pubkey: pool.authority, isSigner: false, isWritable: false },
      { pubkey: pool.wrappedProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([1]), u64le(depositRaw), Buffer.from([pool.bump])]),
  });
  return [
    createAssociatedTokenAccountIdempotentInstruction(rentPayer, userWrapped, owner, pool.wrapped, pool.wrappedProgram),
    wrapIx,
    createTransferCheckedInstruction(
      userUnderlying, pool.underlying, pool.escrow, owner,
      depositRaw, pool.underlyingDecimals, [], pool.underlyingProgram,
    ),
  ];
}

/**
 * Confirm a signature by polling getSignatureStatuses over HTTP. Deliberately
 * avoids connection.confirmTransaction: that path opens a websocket
 * signatureSubscribe, and some RPC providers (fluxrpc) send a notification
 * shape web3.js's schema rejects — the StructError fires inside the ws
 * callback where no caller can catch it and takes down the whole process.
 */
export async function confirmSignatureByPolling(connection, signature, {
  commitment = 'confirmed',
  timeoutMs = 90000,
  pollMs = 1500,
} = {}) {
  const accept = commitment === 'finalized' ? ['finalized'] : ['confirmed', 'finalized'];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let status = null;
    try {
      const res = await connection.getSignatureStatuses([signature]);
      status = res?.value?.[0] ?? null;
    } catch { /* transient RPC hiccup — keep polling until the deadline */ }
    if (status) {
      if (status.err) throw new Error(`transaction ${signature} failed on-chain: ${JSON.stringify(status.err)}`);
      if (accept.includes(status.confirmationStatus)) return signature;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for confirmation of ${signature}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Send a self-paid conversion tx and wait for confirmation. Returns the signature. */
export async function sendWrap(connection, keypair, pool, depositRaw) {
  const ixs = buildWrapInstructions({ pool, owner: keypair.publicKey, depositRaw });
  const tx = new Transaction().add(...ixs);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = keypair.publicKey;
  tx.sign(keypair);
  const sig = await connection.sendRawTransaction(tx.serialize());
  return confirmSignatureByPolling(connection, sig, { commitment: 'confirmed' });
}
