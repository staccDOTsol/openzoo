import { Connection } from '@solana/web3.js';
import { config } from './config.js';
import { loadOrCreateWallet } from './wallet.js';
import {
  parse402, pickAccept, railOf, buildPaymentOnline, tokenBalance,
  receiptLine, decodeSettleHeader,
} from './x402.js';
import { buildEvmPayment } from './evm.js';

export class QuoteTooHighError extends Error {
  constructor(billedUsd, quote) {
    super(`openzoo: quote $${billedUsd} exceeds local cap $${config.maxUsdPerCall}. Raise OPENZOO_MAX_USD_PER_CALL to allow.`);
    this.billedUsd = billedUsd;
    this.quote = quote;
  }
}

export class UnderfundedError extends Error {
  constructor(accept, have, address) {
    super(`openzoo wallet underfunded: need ${accept.maxAmountRequired} raw ${accept.extra?.symbol || ''} (mint ${accept.asset}), have ${have}. Fund ${address}`);
    this.accept = accept;
    this.have = have;
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

  async buildPaymentFor(accept) {
    const rail = railOf(accept);
    if (rail === 'solana') {
      const bal = await tokenBalance(this.connection, this.keypair.publicKey, accept.asset);
      if (bal.raw < BigInt(accept.maxAmountRequired)) {
        throw new UnderfundedError(accept, bal.raw, this.address);
      }
      return buildPaymentOnline(this.connection, this.keypair, accept);
    }
    if (rail === 'base' || rail === 'evm' || (rail === 'robinhood' && this.allowRH)) {
      return buildEvmPayment({ accept, evmPrivateKey: this.evmPrivateKey });
    }
    throw new Error(`no payment builder for rail ${rail} (network ${accept.network})`);
  }

  /**
   * fetch that transparently pays a 402 once.
   * Returns { response, paid, accept?, settle?, receipt? }.
   * Throws QuoteTooHighError / UnderfundedError before any value moves.
   */
  async fetch(url, init = {}) {
    const first = await fetch(url, init);
    if (first.status !== 402) return { response: first, paid: false };

    const quote = parse402(await first.json());
    const accept = pickAccept(quote, config.token, { allowRH: this.allowRH });
    const billedUsd = Number(accept?.extra?.billedUsd ?? NaN);
    if (Number.isFinite(billedUsd) && billedUsd > config.maxUsdPerCall) {
      throw new QuoteTooHighError(billedUsd, quote);
    }

    const payment = await this.buildPaymentFor(accept);
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
  async chat(bodyObj) {
    const { response, receipt } = await this.fetch(`${config.apiBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bodyObj),
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 500);
      throw new Error(`zoo returned HTTP ${response.status}: ${text}`);
    }
    return { data: await response.json(), receipt };
  }
}
