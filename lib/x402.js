import crypto from 'node:crypto';
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  unpackMint,
} from '@solana/spl-token';

/**
 * x402 protocol client (x402Version 1 and 2, "exact" scheme).
 *
 * Captured live 402 shape (test/fixtures/live-402.json):
 *   { x402Version: 1,
 *     accepts: [ { scheme: "exact",
 *                  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
 *                  asset: "<mint>", maxAmountRequired: "<raw units, string>",
 *                  payTo: "<wallet>", resource, description, maxTimeoutSeconds,
 *                  extra: { facilitator, feePayer, symbol, billedUsd, tokenUsd,
 *                           pricedAt, pricing: "markup"|"counterfactual",
 *                           billedUsd, directUsd?, savedUsd?, savesVsDirect? } } ],
 *     error: "payment required" }
 *
 * `asset` is the RAW NATIVE MINT — canonical Circle USDC, or the project token
 * as its own mint. It was briefly a NAV-wrapped Token-2022 twin the payer had
 * to mint first, and the shim converted at payment time; the gateway dropped
 * that because a stock x402 client will not run an approve+deposit into an
 * unaudited vault to buy one API call. Nothing here converts anything: the
 * wallet either holds the quoted mint or the row is unaffordable.
 *
 * Payment is a fixed four-instruction message — see buildPayment, where the
 * order is the protocol. feePayer = extra.feePayer (the gateway pays SOL fees),
 * partial-signed by the payer, serialized requireAllSignatures=false, base64.
 *
 * Both PAYMENT-SIGNATURE and X-PAYMENT carry base64 of paymentEnvelope().
 *
 * NOTE: decimals are NOT in the 402 payload and the site's pasted prompt
 * hardcoding "decimals = 6" is a known bug. We always read decimals from the
 * mint account on-chain (see getMintInfo) — never hardcode.
 */

/**
 * BOTH VERSIONS, OR A v2 CHALLENGE FAILS CLOSED.
 *
 * Pinning to `=== 1` threw before a single field was read, so an upstream that
 * has moved to v2 — every CDP-facilitated one has — was indistinguishable from
 * a malformed body. The version selects the ENVELOPE shape (see
 * paymentEnvelope); it is not an admission test.
 */
export function parse402(body) {
  const v = Number(body?.x402Version);
  if (!body || (v !== 1 && v !== 2) || !Array.isArray(body.accepts) || body.accepts.length === 0) {
    throw new Error('not an x402 v1/v2 payment-required body');
  }
  return body;
}

/**
 * The network the VERIFIER enforces, which is not always the one accepts[]
 * advertised.
 *
 * MEASURED 2026-08-25: surplusintelligence advertises `eip155:8453` and then
 * rejects that exact string with `invalid_exact_evm_network_mismatch`, wanting
 * "base". The payment had already LANDED ON CHAIN when the claim was refused —
 * $0.004172 gone. When the challenge carries a top-level `x402` summary whose
 * `.network` disagrees with the row, the summary is what gets enforced.
 */
export function verifyNetworkFor(body, accept) {
  const advertised = String(accept?.network || '');
  const summary = body?.x402;
  const enforced = summary && typeof summary === 'object' ? String(summary.network || '') : '';
  return enforced && enforced !== advertised ? enforced : advertised;
}

/**
 * The payment envelope both rails send, base64 of this JSON.
 *
 * `resource` and `accepted` are the two fields a CDP facilitator validates the
 * payload's SHAPE against: without them it answers "'paymentPayload' is
 * invalid: must match one of [x402V2Pay…]" and never looks at the money.
 * `accepted` is the accepts[] row VERBATIM — providers compare fields we do not
 * model, so a normalised reconstruction is not the same document.
 *
 * The version is echoed rather than pinned to 2: the openzoo gateway still
 * issues v1 challenges and a v1 verifier is entitled to reject a v2 envelope.
 * The two extra fields are inert to a v1 verifier, so echoing is safe in the
 * direction that costs money.
 */
export function paymentEnvelope(body, accept, payload) {
  return {
    x402Version: Number(body?.x402Version) === 1 ? 1 : 2,
    resource: body?.resource,          // undefined drops out of JSON.stringify
    accepted: accept,
    scheme: accept?.scheme,
    network: verifyNetworkFor(body, accept),
    payload,
  };
}

/** base64 of the envelope — the value of BOTH payment headers. */
export function encodeEnvelope(envelope) {
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
}

/**
 * BOTH HEADER NAMES, ALWAYS.
 *
 * PAYMENT-SIGNATURE is what the spec names; X-PAYMENT is what a large share of
 * live implementations actually read. Sending one and guessing wrong is a 402
 * loop against a server that would have served us.
 */
export function paymentHeaders(header) {
  return { 'PAYMENT-SIGNATURE': header, 'X-PAYMENT': header };
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
 * but RH stays opt-in for DEFAULT selection because USDG is the one asset that
 * settles there and far fewer wallets are holding it.
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
  // CHEAPEST FIRST, AFTER AN EXPLICIT PREFERENCE.
  //
  // The 402 no longer prices every rail the same. Since 2026-08-26 the gateway
  // bills $TOKEN/$LEOS at 2x its cost and USDC/USDG at 4x, so two rows for the
  // SAME call differ by exactly 2x. This function ordered purely by rail and
  // then by preferredSymbol, so the shim would have paid the stable row and
  // silently thrown away half — a discount our own client could not see.
  //
  // An explicit preferredSymbol still wins: that is the caller saying which
  // asset they intend to spend, and price is not a reason to override intent.
  // Everything after it goes cheapest-first. Rows without a usable billedUsd
  // sort last rather than first, so a missing price can never masquerade as
  // free and jump the queue.
  const priceOf = (a) => {
    const v = Number(a?.extra?.billedUsd);
    return Number.isFinite(v) && v > 0 ? v : Infinity;
  };
  // AT THE SAME PRICE, TAKE THE ROW THAT COMES WITH A RECEIPT.
  //
  // The gateway's AtomicSettle row costs exactly what the plain Base row costs
  // — it is the same quote, settled through a contract instead of the
  // facilitator. What it adds is that the on-chain receipt binds the hash of
  // the response we were served and the upstream's own COGS transaction, so
  // "what we paid for" stops being something we have to take on trust.
  //
  // It is appended last in accepts[], so without this it never wins a tie and
  // the plain row is always taken. Price still dominates: a cheaper row beats
  // an atomic one, because a receipt is not worth paying extra for.
  const atomic = (a) => (a?.extra?.settlement === 'atomic' ? 1 : 0);
  const rank = (x, y) => priceOf(x) - priceOf(y) || atomic(y) - atomic(x);
  const bySym = (list) => [
    ...list.filter((a) => a?.extra?.symbol === preferredSymbol).sort(rank),
    ...list.filter((a) => a?.extra?.symbol !== preferredSymbol).sort(rank),
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
    ...bySym(rows.filter((a) => railOf(a) === 'base')),
    ...bySym(rows.filter((a) => railOf(a) === 'evm')),
    ...(allowRH ? bySym(rows.filter((a) => railOf(a) === 'robinhood')) : []),
  ];
  if (!out.length) {
    throw new Error(rows.some((a) => railOf(a) === 'robinhood')
      ? 'only Robinhood Chain rails offered, and they are disabled by OPENZOO_ENABLE_RH=0 — unset it to let them through (the rail settles; the wallet must hold USDG on Robinhood Chain)'
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

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

/**
 * THE INSTRUCTION LAYOUT IS THE PROTOCOL — specs/schemes/exact/scheme_exact_svm.md.
 * A facilitator checks it before it looks at the money, and the transaction
 * SIMULATES CLEAN either way, so the chain gives no hint that anything is wrong.
 * Required, in this order, 3..6 instructions total:
 *
 *   1. ComputeBudget SetComputeUnitLimit
 *   2. ComputeBudget SetComputeUnitPrice   (<= 5 lamports/CU)
 *   3. SPL TransferChecked                 <- MUST be third
 *   4. Memo                                <- MANDATORY, not optional
 *
 * Every line below was bought by getting it wrong on mainnet 2026-08-25:
 *  - ONE instruction -> "instructions length mismatch: 1 < 3 or 1 > 6"
 *  - no SetComputeUnitPrice -> the same length mismatch, one short
 *  - TransferChecked at #4, pushed down by prepended ATA-create/wrap
 *    preInstructions -> `no_transfer_instruction`. The position is checked, not
 *    searched, which is why funding can no longer ride inside this transaction.
 *  - no Memo -> rejected outright.
 *
 * UNIQUENESS MOVED. It used to live in a randomised compute-unit limit here,
 * because everything else is a pure function of (amount, accounts, decimals,
 * blockhash) and two callers inside one blockhash window built a
 * BYTE-IDENTICAL transaction — same signature, so the facilitator reported the
 * second as `settle {success:false, "Simulation failed ... Logs: []"}` (8 of
 * them in one window under 10 workers). The spec now puts uniqueness in the
 * memo, so the CU limit is a plain constant and the nonce is the memo body.
 */
export function buildPayment({ accept, decimals, programId, recentBlockhash, keypair }) {
  const mint = new PublicKey(accept.asset);
  const payTo = new PublicKey(accept.payTo);
  const feePayer = new PublicKey(accept.extra.feePayer);
  const amount = BigInt(accept.maxAmountRequired);

  const source = getAssociatedTokenAddressSync(mint, keypair.publicKey, false, programId);
  const dest = getAssociatedTokenAddressSync(mint, payTo, true, programId);

  const tx = new Transaction({ feePayer, recentBlockhash });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }));
  tx.add(createTransferCheckedInstruction(
    source, mint, dest, keypair.publicKey, amount, decimals, [], programId,
  ));
  // The seller's memo when they set one — some price it into the settlement —
  // else a random 16-byte hex nonce, which is what makes two concurrent
  // identical payments distinct messages.
  tx.add(new TransactionInstruction({
    keys: [],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(accept.extra?.memo || crypto.randomBytes(16).toString('hex'), 'utf8'),
  }));
  if (tx.instructions.length < 3 || tx.instructions.length > 6) {
    throw new Error(`x402 svm payment has ${tx.instructions.length} instructions, outside the required 3..6`);
  }
  // THE FEE PAYER MUST NOT APPEAR IN ANY INSTRUCTION'S ACCOUNTS. It is the
  // facilitator's gas signer; letting it in means their signature can be made
  // to fund something for us (an ATA create, say), which the spec bans outright.
  for (const [i, ix] of tx.instructions.entries()) {
    if (ix.keys.some((k) => k.pubkey.equals(feePayer))) {
      throw new Error(`instruction ${i} names the facilitator feePayer in its accounts — forbidden by scheme_exact_svm`);
    }
  }

  tx.partialSign(keypair); // owner signs; feePayer slot left empty for the facilitator
  const txBase64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');

  const ownerSig = tx.signatures.find((s) => s.publicKey.equals(keypair.publicKey) && s.signature);
  return {
    txBase64,
    payload: { transaction: txBase64 },
    ownerSignature: ownerSig ? base58encode(ownerSig.signature) : null,
    amount,
    source,
    dest,
  };
}

/**
 * Resolve chain state (decimals, blockhash) and build the payment payload.
 *
 * FINALIZED, NOT CONFIRMED — WE SIGN HERE AND SOMEONE ELSE SENDS.
 *
 * A blockhash is only useful to the node that ultimately submits the
 * transaction, and that is the FACILITATOR, on its own RPC. `confirmed` gives
 * the freshest hash our RPC knows, which is precisely the problem: if our node
 * is even slightly ahead, that block does not exist yet for theirs, and
 * `isBlockhashValid` returns false for "never seen" exactly as it does for
 * "expired". A finalized hash is known cluster-wide by definition.
 *
 * MEASURED 2026-08-28, once the facilitator was made to report the reason:
 *   blockhash CmHMKGre… valid=false | feePayer 1.167 SOL | ixs 4 | bytes 526
 * Not funding, not size. And the round trip was ~10s against a ~60s window, so
 * it was not aging out either — the hash was simply never recognised. Every
 * settle from one client failed for forty minutes on a wallet holding $111.
 *
 * The cost is ~13s of a ~60s window, which is the right trade when the whole
 * round trip is ~10s: a slightly older hash that always works beats a fresher
 * one that sometimes does not. Override with OPENZOO_BLOCKHASH_COMMITMENT if a
 * future facilitator wants otherwise.
 */
export async function buildPaymentOnline(connection, keypair, accept) {
  const { programId, decimals } = await getMintInfo(connection, accept.asset);
  const commitment = process.env.OPENZOO_BLOCKHASH_COMMITMENT || 'finalized';
  const { blockhash } = await connection.getLatestBlockhash(commitment);
  return buildPayment({ accept, decimals, programId, recentBlockhash: blockhash, keypair });
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
  const billed = Number(x.billedUsd);
  const direct = x.directUsd != null ? Number(x.directUsd) : null;
  const saved = x.savedUsd != null ? Number(x.savedUsd)
    : (Number.isFinite(billed) && Number.isFinite(direct) ? Math.max(0, direct - billed) : null);
  const ratio = x.savesVsDirect != null ? Number(x.savesVsDirect)
    : (Number.isFinite(billed) && billed > 0 && Number.isFinite(direct) ? direct / billed : null);
  // Wallet path: OpenRouter price, plus 33% of savings vs direct when any.
  // Never print extra.markup — that field is leftover 3× and is not the quote.
  const saves = ratio != null
    ? (ratio >= 1.05
        ? ` (${ratio.toFixed(1)}× cheaper than direct)`
        : ' (at OpenRouter price — nothing to compress; bind a corpus to save)')
    : (Number.isFinite(saved) && saved > 0
        ? ` ($${saved.toFixed(4)} saved vs direct)`
        : ' (at OpenRouter price — short body)');
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
