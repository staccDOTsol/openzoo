import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { config, fundingLine } from './config.js';
import { loadOrCreateWallet } from './wallet.js';
import {
  parse402, pickAccept, railOf, buildPaymentOnline, tokenBalance,
  receiptLine, decodeSettleHeader,
} from './x402.js';
import { buildEvmPayment, evmTokenBalance } from './evm.js';
import { privateKeyToAccount } from 'viem/accounts';
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

  async buildPaymentFor(accept, onStage) {
    const rail = railOf(accept);
    if (rail === 'solana') {
      const need = BigInt(accept.maxAmountRequired);
      const bal = await tokenBalance(this.connection, this.keypair.publicKey, accept.asset);
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
          const line = rail === 'base'
            ? `Send a few cents of USDC on Base to ${owner}.`
            : `The wallet must hold the Robinhood Chain settlement asset — deposit USDG at https://x402.accrue.fund/start (wallet: ${owner}).`;
          throw new UnderfundedError(accept, null, owner, { line });
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
    const first = await fetch(url, init);
    if (first.status !== 402) return { response: first, paid: false };

    const quote = parse402(await first.json());
    // config.rail (OPENZOO_RAIL) steers every front — proxy, demo, MCP — since
    // they all pay through this one call site.
    const accept = pickAccept(quote, config.token, { allowRH: this.allowRH, forceRail: config.rail });
    const billedUsd = Number(accept?.extra?.billedUsd ?? NaN);
    if (Number.isFinite(billedUsd) && billedUsd > config.maxUsdPerCall) {
      throw new QuoteTooHighError(billedUsd, quote);
    }

    onStage?.('quoted');
    const payment = await this.buildPaymentFor(accept, onStage);
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
