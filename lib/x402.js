import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  unpackMint,
} from '@solana/spl-token';

/**
 * x402 protocol client for openzoo.fun (x402Version 1, Solana "exact" scheme).
 *
 * Captured live 402 shape (test/fixtures/live-402.json):
 *   { x402Version: 1,
 *     accepts: [ { scheme: "exact",
 *                  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
 *                  asset: "<mint>", maxAmountRequired: "<raw units, string>",
 *                  payTo: "<wallet>", resource, description, maxTimeoutSeconds,
 *                  extra: { facilitator, feePayer, symbol, billedUsd, tokenUsd,
 *                           pricedAt, pricing: "markup"|"counterfactual",
 *                           markup? , directUsd?, savesVsDirect? } } ],
 *     error: "payment required", help: "..." }
 *
 * Payment: ONE Token-2022 TransferChecked (payer ATA -> payTo ATA) for exactly
 * maxAmountRequired, feePayer = extra.feePayer (the gateway pays SOL fees),
 * partial-signed by the payer, serialized requireAllSignatures=false, base64.
 * X-PAYMENT header = base64 of
 *   {"x402Version":1,"scheme":"exact","network":"<network>","payload":{"transaction":"<b64 tx>"}}
 *
 * NOTE: decimals are NOT in the 402 payload and the site's pasted prompt
 * hardcoding "decimals = 6" is a known bug. We always read decimals from the
 * mint account on-chain (see getMintInfo) — never hardcode.
 */

export function parse402(body) {
  if (!body || body.x402Version !== 1 || !Array.isArray(body.accepts) || body.accepts.length === 0) {
    throw new Error('not an x402 v1 payment-required body');
  }
  return body;
}

const EVM_NAME_CHAINS = { base: 8453, 'base-sepolia': 84532 };

/** Which rail an accepts[] row settles on: 'solana' | 'base' | 'robinhood' | 'evm' | null. */
export function railOf(accept) {
  const net = accept?.network || '';
  if (net.startsWith('solana:')) return 'solana';
  const m = /^eip155:(\d+)$/.exec(net);
  const chainId = m ? Number(m[1]) : EVM_NAME_CHAINS[net];
  if (chainId === 8453 || chainId === 84532) return 'base';
  if (chainId === 4663) return 'robinhood';
  if (chainId) return 'evm';
  return null;
}

export function evmChainId(network) {
  const m = /^eip155:(\d+)$/.exec(network || '');
  return m ? Number(m[1]) : EVM_NAME_CHAINS[network] ?? null;
}

/**
 * Choose the accepts[] row to pay with.
 *
 * `forceRail` (env OPENZOO_RAIL=solana|base|robinhood) pins the selection to
 * one rail and errors clearly when the live 402 does not offer it — forcing is
 * explicit intent, so it also bypasses the allowRH gate.
 *
 * Default order: Solana first (preferring extra.symbol === preferredSymbol),
 * then Base, then other EVM chains. Robinhood Chain (eip155:4663) is last and
 * only when allowRH: all three rails have settled real payments (2026-08-14),
 * but RH stays opt-in for DEFAULT selection because its settlement asset has
 * no auto-conversion path here.
 */
/**
 * ALL payable rows from a 402, best-first. The wallet pays with whatever it
 * HOLDS — the caller walks this list and takes the first affordable row, so
 * a wallet rich in TOKEN but short of USDC pays the TOKEN row instead of
 * erroring on the USDC one. Preference order within the list: the preferred
 * symbol, then the rest of Solana (sponsored fees), then Base, then Robinhood
 * (gated — paying there costs the wallet its own gas).
 */
export function orderAccepts(body, preferredSymbol, { allowRH = false, forceRail = null } = {}) {
  const rows = parse402(body).accepts.filter((a) => a?.scheme === 'exact');
  const bySym = (list) => [
    ...list.filter((a) => a?.extra?.symbol === preferredSymbol),
    ...list.filter((a) => a?.extra?.symbol !== preferredSymbol),
  ];
  if (forceRail) {
    const want = String(forceRail).toLowerCase();
    if (!['solana', 'base', 'robinhood', 'evm'].includes(want)) {
      throw new Error(`OPENZOO_RAIL=${forceRail} is not a rail — use solana, base or robinhood`);
    }
    const match = rows.filter((a) => railOf(a) === want);
    if (!match.length) {
      const offered = [...new Set(rows.map(railOf).filter(Boolean))];
      throw new Error(
        `OPENZOO_RAIL=${want} but the live 402 offers no ${want} rail (offered: ${offered.join(', ') || 'none'})`,
      );
    }
    return bySym(match);
  }
  const out = [
    ...bySym(rows.filter((a) => railOf(a) === 'solana')),
    ...rows.filter((a) => railOf(a) === 'base'),
    ...rows.filter((a) => railOf(a) === 'evm'),
    ...(allowRH ? rows.filter((a) => railOf(a) === 'robinhood') : []),
  ];
  if (!out.length) {
    throw new Error(rows.some((a) => railOf(a) === 'robinhood')
      ? 'only Robinhood Chain rails offered — set OPENZOO_ENABLE_RH=1 or OPENZOO_RAIL=robinhood to use them (the rail settles; you must hold its settlement asset, see https://x402.accrue.fund/start)'
      : 'no payable rail in 402 accepts[]');
  }
  return out;
}

export function pickAccept(body, preferredSymbol, opts = {}) {
  return orderAccepts(body, preferredSymbol, opts)[0];
}

const mintCache = new Map();

/** Read the mint's owner program and decimals from chain. Cached per mint. */
export async function getMintInfo(connection, mintStr) {
  if (mintCache.has(mintStr)) return mintCache.get(mintStr);
  const mint = new PublicKey(mintStr);
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`mint ${mintStr} not found on chain (check OPENZOO_RPC)`);
  const programId = info.owner; // TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID
  const parsed = unpackMint(mint, info, programId);
  const out = { programId, decimals: parsed.decimals };
  mintCache.set(mintStr, out);
  return out;
}

/**
 * Build the partially-signed payment transaction + X-PAYMENT header value.
 * Pure given its inputs (no network) so it can be unit-tested offline.
 */
export function buildPayment({ accept, decimals, programId, recentBlockhash, keypair, preInstructions = [] }) {
  const mint = new PublicKey(accept.asset);
  const payTo = new PublicKey(accept.payTo);
  const feePayer = new PublicKey(accept.extra.feePayer);
  const amount = BigInt(accept.maxAmountRequired);

  const source = getAssociatedTokenAddressSync(mint, keypair.publicKey, false, programId);
  const dest = getAssociatedTokenAddressSync(mint, payTo, true, programId);

  const ix = createTransferCheckedInstruction(
    source, mint, dest, keypair.publicKey, amount, decimals, [], programId,
  );

  const tx = new Transaction({ feePayer, recentBlockhash });
  // UNIQUENESS. Everything else here is a pure function of (amount, accounts,
  // decimals, blockhash), so two calls quoting the same price inside one
  // blockhash window build a BYTE-IDENTICAL transaction — same signature, so
  // the second is a duplicate and the facilitator reports it as
  // `settle {success:false, "Simulation failed ... Logs: []"}`. Concurrent
  // callers hit this constantly (a 10-worker run produced 8 failed_settle in
  // one window) and each failure costs a full retry, which is most of the
  // per-call latency.
  //
  // A random compute-unit LIMIT makes each message distinct at no cost: unlike
  // setComputeUnitPrice it adds no priority fee, and an over-estimate is free
  // — it only caps execution. The range sits far above what a transferChecked
  // plus any funding preInstructions actually consume.
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({
    units: 300_000 + Math.floor(Math.random() * 200_000),
  }));
  for (const pre of preInstructions) tx.add(pre); // internal funding plumbing, if any
  tx.add(ix);
  tx.partialSign(keypair); // owner signs; feePayer slot left empty for the facilitator
  const txBase64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');

  const envelope = {
    x402Version: 1,
    scheme: accept.scheme,
    network: accept.network,
    payload: { transaction: txBase64 },
  };
  const header = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
  const ownerSig = tx.signatures.find((s) => s.publicKey.equals(keypair.publicKey) && s.signature);
  return {
    header,
    txBase64,
    ownerSignature: ownerSig ? base58encode(ownerSig.signature) : null,
    amount,
    source,
    dest,
  };
}

/** Resolve chain state (decimals, blockhash) and build the header. */
export async function buildPaymentOnline(connection, keypair, accept, { preInstructions = [] } = {}) {
  const { programId, decimals } = await getMintInfo(connection, accept.asset);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  return buildPayment({ accept, decimals, programId, recentBlockhash: blockhash, keypair, preInstructions });
}

/** Token balance of our ATA for a mint. Returns { raw: bigint, ui: number|null }. */
export async function tokenBalance(connection, owner, mintStr) {
  try {
    const { programId } = await getMintInfo(connection, mintStr);
    const ata = getAssociatedTokenAddressSync(new PublicKey(mintStr), owner, false, programId);
    const bal = await connection.getTokenAccountBalance(ata);
    return { raw: BigInt(bal.value.amount), ui: bal.value.uiAmount };
  } catch {
    return { raw: 0n, ui: 0 };
  }
}

/** One-line human receipt for a paid call. */
export function receiptLine(accept, settle) {
  const x = accept.extra || {};
  const usd = x.billedUsd != null ? `$${Number(x.billedUsd).toFixed(6)}` : `${accept.maxAmountRequired} raw units`;
  // "1.0× cheaper than direct" is a sentence that means nothing, and a user
  // read it as a bug — rightly. Since the gateway repriced to an OpenRouter
  // CEILING, an uncompressed call bills exactly the direct rate, so the ratio
  // is 1.0 by design rather than by accident. Say what actually happened:
  // below 1.05× there is no saving to report, so report the price instead.
  //
  // The saving comes from leCore forwarding fewer tokens. A short body never
  // reaches the spill threshold, so there is nothing to compress and nothing
  // to save — which is worth saying out loud, because the fix on the caller's
  // side is to BIND a corpus, not to change models.
  const ratio = x.savesVsDirect != null ? Number(x.savesVsDirect) : null;
  const saves = ratio != null
    ? (ratio >= 1.05
        ? ` (${ratio.toFixed(1)}× cheaper than direct)`
        : ' (at direct price — nothing to compress; bind a corpus to save)')
    : (x.markup != null ? ` (markup ${x.markup}×, short body)` : '');
  const tx = settle?.transaction || settle?.txHash || settle?.signature;
  const rail = railOf(accept);
  return `paid ${usd}${saves}${rail ? ` · rail ${rail}` : ''}${tx ? ` · tx ${tx}` : ''}`;
}

/** Decode the server's X-PAYMENT-RESPONSE header (base64 JSON), if present. */
export function decodeSettleHeader(headerValue) {
  if (!headerValue) return null;
  try {
    return JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// Minimal base58 (bitcoin alphabet) — enough to print a signature.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}
