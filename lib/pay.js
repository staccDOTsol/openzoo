import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { config, fundingLine, evmRpcFor } from './config.js';
import { loadOrCreateWallet } from './wallet.js';
import {
  parse402, orderAccepts, railOf, buildPaymentOnline, tokenBalance,
  receiptLine, decodeSettleHeader,
} from './x402.js';
import { buildEvmPayment, evmTokenBalance } from './evm.js';
import { acquireWrappedIfNeeded } from './evmwrap.js';
import { privateKeyToAccount } from 'viem/accounts';
import { withNamespace } from './namespace.js';
import {
  resolvePool, poolState, depositForShares, buildWrapInstructions, sendWrap,
} from './wrap.js';

export class QuoteTooHighError extends Error {
  constructor(billedUsd, quote) {
    super(`openzoo: quote $${billedUsd} exceeds local cap $${config.maxUsdPerCall}. Raise OPENZOO_MAX_USD_PER_CALL to allow.`);
    this.billedUsd = billedUsd;
    this.quote = quote;
  }
}

export class UnderfundedError extends Error {
  constructor(accept, usdcUi, address, { line } = {}) {
    const usd = Number(accept?.extra?.billedUsd);
    const needs = Number.isFinite(usd) ? `this call needs ≈$${usd.toFixed(6)}` : 'this call needs more than the wallet holds';
    const holds = usdcUi != null ? ` — the wallet holds $${Number(usdcUi).toFixed(2)} USDC` : '';
    super(line
      ? `openzoo wallet underfunded: ${needs}. ${line}`
      : `openzoo wallet underfunded: ${needs}${holds}. ${fundingLine(address).replace(/^s/, 'S')}.`);
    this.accept = accept;
    this.usdcUi = usdcUi;
    this.address = address;
  }
}

/**
 * Shared x402-paying HTTP client — the single place payment happens.
 * The proxy, the demo, and the MCP server all go through PayClient.fetch:
 * request → 402 → pick rail (Solana first) → sign → retry with X-PAYMENT.
 */
/**
 * Which offered asset last paid, and which are known underfunded — see the
 * comment at the call site in fetch(). Process-lifetime with a TTL so a wallet
 * that gets funded mid-session recovers on its own.
 */
/**
 * BALANCE CACHE — checked semi-frequently in the background, not per call.
 *
 * MEASURED: a per-request balance probe put a mainnet round trip (and, when the
 * row came back short, a full top-up probe: resolvePool + poolState + rent) on
 * the critical path of EVERY inference — 4.52s of the 7s a one-line completion
 * took. Balances do not move at request rate; a wallet spending $0.00004 a call
 * has the same balance it had a minute ago.
 *
 * Stale-while-revalidate: a cached value is returned IMMEDIATELY and a refresh is
 * kicked off in the background when it is older than the TTL, so no request ever
 * waits on the network for it. Only a cold cache (first call of the process)
 * blocks. A payment decrements the cached figure locally so a burst of calls
 * cannot overdraw between refreshes.
 */
const BALANCE_TTL_MS = Number(process.env.OPENZOO_BALANCE_TTL_MS || 60_000);
const balanceCache = new Map();   // key -> { raw, ui, at, refreshing }

const balKey = (owner, mint) => `${owner}|${mint}`;

async function cachedTokenBalance(connection, owner, mint, { force = false } = {}) {
  const key = balKey(owner.toBase58 ? owner.toBase58() : String(owner), mint);
  const hit = balanceCache.get(key);
  const fresh = hit && !force && (Date.now() - hit.at) < BALANCE_TTL_MS;
  if (hit && !force) {
    if (!fresh && !hit.refreshing) {
      // SEMI-FREQUENT REFRESH: fire and forget, so the caller is never blocked.
      hit.refreshing = true;
      tokenBalance(connection, owner, mint)
        .then((b) => balanceCache.set(key, { raw: b.raw, ui: b.ui, at: Date.now(), refreshing: false }))
        .catch(() => { hit.refreshing = false; });   // keep the last good value
    }
    return { raw: hit.raw, ui: hit.ui, cached: true, ageMs: Date.now() - hit.at };
  }
  const b = await tokenBalance(connection, owner, mint);
  balanceCache.set(key, { raw: b.raw, ui: b.ui, at: Date.now(), refreshing: false });
  return { ...b, cached: false, ageMs: 0 };
}

/** Debit what we just spent so a burst cannot overdraw a cached figure. */
function debitCachedBalance(owner, mint, amount) {
  const key = balKey(owner.toBase58 ? owner.toBase58() : String(owner), mint);
  const hit = balanceCache.get(key);
  if (hit) hit.raw = hit.raw > amount ? hit.raw - amount : 0n;
}

/** Test seam. */
export function resetBalanceCache() { balanceCache.clear(); }

const RAIL_MEMO_MS = Number(process.env.OPENZOO_RAIL_MEMO_MS || 120_000);
const underfundedUntil = new Map();   // asset -> epoch ms after which to re-try it
let lastGoodAsset = null;

const memoKey = (a) => `${a?.network || ''}|${a?.asset || ''}`;

/** lastGood first, known-underfunded last (never dropped — only deprioritised). */
export function orderCandidatesByMemory(cands, now = Date.now()) {
  const skip = (c) => (underfundedUntil.get(memoKey(c)) ?? 0) > now;
  const good = (c) => lastGoodAsset && memoKey(c) === lastGoodAsset;
  // Stable partition: proven payer, then untried, then recently-underfunded. The
  // last group is KEPT so a wallet funded seconds ago is still reachable in the
  // same call if nothing else works.
  return [...cands].sort((a, b) => (good(b) - good(a)) || (skip(a) - skip(b)));
}

/** Test seam: forget everything the rail memory learned. */
export function resetRailMemory() {
  underfundedUntil.clear();
  lastGoodAsset = null;
}

export class PayClient {
  constructor() {
    const w = loadOrCreateWallet();
    this.keypair = w.keypair;
    this.evmPrivateKey = w.evmPrivateKey;
    this.walletCreated = w.created;
    this.walletPath = w.path;
    this.connection = new Connection(config.rpcUrl, 'confirmed');
    this.receipts = []; // last paid calls, newest last
    this.allowRH = process.env.OPENZOO_ENABLE_RH === '1';
  }

  get address() { return this.keypair.publicKey.toBase58(); }

  /** The EVM address the Base / Robinhood rails pay from — same wallet file. */
  get evmAddress() {
    if (!this.evmPrivateKey) return null;
    try { return privateKeyToAccount(this.evmPrivateKey).address; } catch { return null; }
  }

  /** Raw balance this wallet holds of the asset a 402 row asks for. */
  async balanceForAccept(accept) {
    const rail = railOf(accept);
    if (rail === 'solana') {
      const b = await tokenBalance(this.connection, this.keypair.publicKey, accept.asset);
      return BigInt(b.raw || 0);
    }
    const raw = await evmTokenBalance({
      rpcUrl: evmRpcFor(rail), token: accept.asset, owner: this.evmAddress,
    });
    return BigInt(raw || 0);
  }

  /**
   * What this wallet can actually PAY with on this rail, in settlement-asset
   * units — wrapped holdings PLUS the plain token it can convert on the fly.
   *
   * balanceForAccept answers a different question: how much of the WRAPPED
   * asset is sitting there right now. Every quote names the wrapper (wTOKENx,
   * the RH vault twins), so a wallet holding 845,486 plain TOKEN read as
   * "$3.14 covered" — only the sliver already wrapped — while `openzoo balance`
   * showed the full holding priced as `$?`. Two different wrong answers about
   * the same wallet, and a user was told to fund an account with $177 in it.
   *
   * buildPaymentFor already wraps what it needs at payment time (topUpQuotedAsset
   * on Solana, acquireWrappedIfNeeded on EVM), so the convertible balance IS
   * spendable and the estimate was simply lying by omission. Advisory only:
   * anything unreadable degrades to the wrapped figure rather than throwing,
   * because this feeds a display and a top-up hint, never a settlement.
   */
  async spendableUsdForAccept(accept) {
    const perUsd = BigInt(accept.maxAmountRequired || '0');
    if (perUsd <= 0n) return 0;
    const wrappedRaw = await this.balanceForAccept(accept).catch(() => 0n);
    let usd = Number(wrappedRaw * 1000n / perUsd) / 1000;

    // Price the PLAIN token with the quote's own tokenUsd, NOT with the pool's
    // supply/reserves ratio. That ratio is share accounting, not a price: the
    // live wTOKENx pool reads supply/reserves ≈ 5659, so treating it as a
    // conversion rate valued 845,486 TOKEN at $1,004,132. The 402 already
    // publishes what a whole token is worth, and the wrapper is a claim on the
    // same asset — so underlying and wrapped are priced identically, which is
    // exactly what `openzoo balance` now shows.
    const px = Number(accept?.extra?.tokenUsd);
    if (!Number.isFinite(px) || px <= 0) return usd;
    const rail = railOf(accept);
    try {
      if (rail === 'solana') {
        const pool = await resolvePool(this.connection, accept.asset);
        if (!pool) return usd;
        const under = await tokenBalance(this.connection, this.keypair.publicKey,
          pool.underlying.toBase58());
        usd += Number(under?.ui || 0) * px;
        return usd;
      }
      // EVM wrappers are ERC-4626; asset() names the plain token behind them.
      const { createPublicClient, http } = await import('viem');
      const pc = createPublicClient({ transport: http(evmRpcFor(rail)) });
      const ABI = [
        { name: 'asset', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
        { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
      ];
      const under = await pc.readContract({ address: accept.asset, abi: ABI, functionName: 'asset', args: [] });
      const raw = await evmTokenBalance({ rpcUrl: evmRpcFor(rail), token: under, owner: this.evmAddress });
      if (!raw || raw <= 0n) return usd;
      const dec = Number(accept?.extra?.decimals ?? 18);
      usd += (Number(raw) / 10 ** dec) * px;
      return usd;
    } catch {
      return usd;          // not a wrapper, or a rail we cannot read
    }
  }

  async buildPaymentFor(accept, onStage) {
    const rail = railOf(accept);
    if (rail === 'solana') {
      const need = BigInt(accept.maxAmountRequired);
      let bal = await cachedTokenBalance(this.connection, this.keypair.publicKey, accept.asset);
      // Never declare a wallet short on a STALE read — the expensive top-up path
      // and the underfunded error both deserve a live number.
      if (bal.raw < need && bal.cached) {
        bal = await cachedTokenBalance(this.connection, this.keypair.publicKey, accept.asset, { force: true });
      }
      if (bal.raw < need) {
        const topUp = await this.topUpQuotedAsset(accept, need, onStage);
        if (topUp.preInstructions) {
          return buildPaymentOnline(this.connection, this.keypair, accept, {
            preInstructions: topUp.preInstructions,
          });
        }
      }
      return buildPaymentOnline(this.connection, this.keypair, accept);
    }
    // OPENZOO_RAIL=robinhood is explicit intent — it opens the RH gate the
    // same way OPENZOO_ENABLE_RH=1 does.
    if (rail === 'base' || rail === 'evm' || (rail === 'robinhood' && (this.allowRH || config.rail === 'robinhood'))) {
      // Preflight: check the settlement-asset balance so an unfundable payment
      // fails HERE with funding instructions instead of at the facilitator.
      // Advisory only — an unreachable RPC never blocks a payment attempt.
      const rpcUrl = rail === 'base' ? config.baseRpcUrl : config.rhRpcUrl;
      const owner = this.evmAddress;
      if (owner) {
        const bal = await evmTokenBalance({ rpcUrl, token: accept.asset, owner }).catch(() => null);
        if (bal !== null && bal < BigInt(accept.maxAmountRequired)) {
          if (rail === 'robinhood') {
            // The RH settlement asset is a vault twin over the plain token the
            // user actually holds. Convert exactly enough at payment time
            // (approve + deposit) — the EVM mirror of the Solana top-up above.
            // Throws NeedsGasError / UnderlyingShortError with exact, plain-
            // token-named instructions when the wallet cannot convert. An RPC
            // hiccup mid-probe falls through to the flat underfunded message.
            let converted = null;
            try {
              converted = await acquireWrappedIfNeeded({
                rpcUrl, accept, evmPrivateKey: this.evmPrivateKey, onStage,
              });
            } catch (e) {
              if (e?.name === 'NeedsGasError' || e?.name === 'UnderlyingShortError' || /openzoo/.test(e?.message || '')) throw e;
              converted = null;
            }
            if (!converted || converted.wrapper === false || (!converted.acquired && converted.wrapper !== null)) {
              const line = `The wallet must hold the token this row is quoted in — fund ${owner} on Robinhood Chain, or see https://x402.accrue.fund/start.`;
              throw new UnderfundedError(accept, null, owner, { line });
            }
          } else {
            throw new UnderfundedError(accept, null, owner, { line: `Send a few cents of USDC on Base to ${owner}.` });
          }
        }
      }
      return buildEvmPayment({ accept, evmPrivateKey: this.evmPrivateKey });
    }
    throw new Error(`no payment builder for rail ${rail} (network ${accept.network})`);
  }

  /**
   * Internal: make sure the wallet holds enough of the exact asset the 402
   * quotes, by converting the user's plain USDC (or whatever underlying the
   * pool takes) at payment time. Users never see or hold the quoted asset.
   *
   * Returns {} when the balance now covers the quote, or
   * { preInstructions } when the wallet cannot pay network fees itself — the
   * conversion then rides inside the gateway-sponsored payment transaction
   * (the 402's feePayer covers fees and any account rent).
   * Throws UnderfundedError when the underlying balance cannot cover it.
   */
  async topUpQuotedAsset(accept, need, onStage) {
    const owner = this.keypair.publicKey;
    const pool = await resolvePool(this.connection, accept.asset).catch(() => null);
    if (!pool) throw new UnderfundedError(accept, null, this.address);

    for (let attempt = 0; attempt < 3; attempt++) {
      const bal = await tokenBalance(this.connection, owner, accept.asset);
      const short = need - bal.raw;
      if (short <= 0n) return {};

      const { reserves, supply } = await poolState(this.connection, pool);
      const deposit = depositForShares(short, reserves, supply);
      const underlyingBal = await tokenBalance(this.connection, owner, pool.underlying.toBase58());
      if (underlyingBal.raw < deposit) {
        throw new UnderfundedError(accept, underlyingBal.ui, this.address);
      }

      onStage?.('funding');
      const wrappedAta = getAssociatedTokenAddressSync(pool.wrapped, owner, false, pool.wrappedProgram);
      const [lamports, ataInfo] = await Promise.all([
        this.connection.getBalance(owner),
        this.connection.getAccountInfo(wrappedAta),
      ]);
      const lamportsNeeded = 10000 + (ataInfo ? 0 : 2400000); // tx fee + possible ATA rent
      if (lamports < lamportsNeeded && accept.extra?.feePayer) {
        // No SOL for a standalone conversion — bundle it into the payment tx.
        const rentPayer = new PublicKey(accept.extra.feePayer);
        return {
          preInstructions: buildWrapInstructions({ pool, owner, depositRaw: deposit, rentPayer }),
        };
      }
      const sig = await sendWrap(this.connection, this.keypair, pool, deposit);
      this.lastTopUpSig = sig; // internal breadcrumb, never printed to users
      if (process.env.OPENZOO_DEBUG) console.error(`[openzoo debug] top-up tx ${sig}`);
    }

    const finalBal = await tokenBalance(this.connection, owner, accept.asset);
    if (finalBal.raw < need) throw new UnderfundedError(accept, null, this.address);
    return {};
  }

  /**
   * fetch that transparently pays a 402 once.
   * Returns { response, paid, accept?, settle?, receipt? }.
   * Throws QuoteTooHighError / UnderfundedError before any value moves.
   */
  async fetch(url, init = {}, { onStage } = {}) {
    onStage?.('request');
    // Contexts are tenanted by this namespace server-side — a request without
    // it cannot see corpora this wallet bound.
    init = { ...init, headers: withNamespace(init.headers || {}) };
    const first = await fetch(url, init);
    if (first.status !== 402) return { response: first, paid: false };

    const quote = parse402(await first.json());
    // config.rail (OPENZOO_RAIL) steers every front — proxy, demo, MCP — since
    // they all pay through this one call site. The wallet pays with whatever
    // it HOLDS: every offered row is tried best-first, and only when NONE is
    // affordable does the call fail — never because the first-choice asset
    // alone ran dry while another funded one sat in the wallet.
    const ordered = orderAccepts(quote, config.token, { allowRH: this.allowRH, forceRail: config.rail });
    // RAIL MEMORY — the single biggest source of per-call latency.
    // MEASURED: the first offered row (yUSDCx) was underfunded, and finding that
    // out costs 4.52s, because an underfunded Solana row attempts a top-up first
    // (resolvePool + poolState + balances + rent-exemption lookups). The row that
    // actually pays (wTOKENx) then builds in 0.36s. That 4.5s was being re-paid on
    // EVERY request to rediscover a fact that had not changed.
    // So: remember which asset just paid and try it first, and skip assets known
    // underfunded within the TTL. Bounded and self-healing — the memo expires, a
    // funded wallet is re-tried automatically, and if every row is memoized we fall
    // back to the full list rather than manufacturing a dead end.
    const candidates = orderCandidatesByMemory(ordered);
    onStage?.('quoted');
    let accept = null;
    let payment = null;
    const fundErrs = [];
    let tooHigh = null;
    for (const cand of candidates) {
      const billedUsd = Number(cand?.extra?.billedUsd ?? NaN);
      if (Number.isFinite(billedUsd) && billedUsd > config.maxUsdPerCall) {
        tooHigh = tooHigh || new QuoteTooHighError(billedUsd, quote);
        continue;
      }
      try {
        payment = await this.buildPaymentFor(cand, onStage);
        accept = cand;
        lastGoodAsset = memoKey(cand);
        underfundedUntil.delete(memoKey(cand));
        if (railOf(cand) === 'solana') {
          try { debitCachedBalance(this.keypair.publicKey, cand.asset, BigInt(cand.maxAmountRequired)); } catch { /* advisory */ }
        }
        break;
      } catch (e) {
        const funding = e instanceof UnderfundedError
          || e?.name === 'UnderlyingShortError' || e?.name === 'NeedsGasError';
        if (!funding) throw e;
        // Remember it so the next call does not re-pay the discovery cost.
        underfundedUntil.set(memoKey(cand), Date.now() + RAIL_MEMO_MS);
        fundErrs.push({ sym: cand?.extra?.symbol || cand?.asset, err: e });
      }
    }
    if (!payment) {
      if (!fundErrs.length && tooHigh) throw tooHigh;
      if (fundErrs.length === 1) throw fundErrs[0].err;
      throw new UnderfundedError(candidates[0], null, this.address, {
        line: `No offered payment row is affordable from this wallet (tried ${fundErrs.length}):\n`
          + fundErrs.map(({ sym, err }) => `  · ${sym}: ${err.message.replace(/^openzoo wallet underfunded: /, '')}`).join('\n'),
      });
    }
    onStage?.('paying');
    const response = await fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), 'X-PAYMENT': payment.header },
    });
    const settle = decodeSettleHeader(response.headers.get('x-payment-response'))
      || { signature: payment.ownerSignature };
    const receipt = {
      at: new Date().toISOString(),
      line: receiptLine(accept, settle),
      rail: railOf(accept),
      billedUsd: accept.extra?.billedUsd,
      savesVsDirect: accept.extra?.savesVsDirect,
      pricing: accept.extra?.pricing,
      symbol: accept.extra?.symbol,
      amountRaw: accept.maxAmountRequired,
      ok: response.ok,
      status: response.status,
    };
    if (response.ok) {
      this.receipts.push(receipt);
      if (this.receipts.length > 20) this.receipts.shift();
    }
    return { response, paid: true, accept, settle, receipt };
  }

  /** POST a chat completion, paying as needed. Returns { data, receipt }. */
  async chat(bodyObj, { onStage, headers } = {}) {
    const { response, receipt } = await this.fetch(`${config.apiBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(headers || {}) },
      body: JSON.stringify(bodyObj),
    }, { onStage });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 500);
      throw new Error(`zoo returned HTTP ${response.status}: ${text}`);
    }
    return { data: await response.json(), receipt };
  }
}
