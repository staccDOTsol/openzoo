import { Connection } from '@solana/web3.js';
import { config, fundingLine, evmRpcFor } from './config.js';
import { loadOrCreateWallet } from './wallet.js';
import {
  parse402, orderAccepts, railOf, buildPaymentOnline, tokenBalance,
  receiptLine, decodeSettleHeader, paymentEnvelope, encodeEnvelope, paymentHeaders,
} from './x402.js';
import { buildEvmPayment, evmTokenBalance } from './evm.js';
import { privateKeyToAccount } from 'viem/accounts';
import { withNamespace } from './namespace.js';
import { fetchHeaders } from './fetch.js';

/** Drop any inherited bearer — see the call site: x402 is the only pay lane. */
function stripAuthorization(headers = {}) {
  const out = { ...headers };
  delete out.authorization;
  delete out.Authorization;
  return out;
}

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
 * request → 402 → pick rail (Solana first) → sign → retry with the payment
 * headers. x402 is the ONLY pay lane here; there is no bearer that skips it.
 */
/**
 * Which offered asset last paid, and which are known underfunded — see the
 * comment at the call site in fetch(). Process-lifetime with a TTL so a wallet
 * that gets funded mid-session recovers on its own.
 */
/**
 * BALANCE CACHE — checked semi-frequently in the background, not per call.
 *
 * MEASURED: a per-request balance probe put a mainnet round trip on the critical
 * path of EVERY inference — 4.52s of the 7s a one-line completion took, most of
 * it the since-deleted conversion probe a short row triggered. Balances do not
 * move at request rate; a wallet spending $0.00004 a call has the same balance
 * it had a minute ago.
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
  /**
   * This machine's ~/.openzoo/wallet.json, OR a derived burner passed in.
   *
   * The override was removed once with the note "that bot is gone and nothing
   * else ever passed one" — THE BOT WAS NOT GONE. xbot.js kept calling
   * `new PayClient(burner)`, the argument was silently swallowed, and every
   * "asker pays" answer settled from the OPERATOR's shared wallet instead:
   * measured live 2026-08-27 as gateway `paid_200 payer:0x640944…` (the
   * machine EVM key) for calls the log attributed to a per-asker burner. The
   * paid lane's entire economics ran backwards and nothing errored.
   *
   * A burner carries BOTH keys (Solana + EVM from one HMAC), so an override
   * must never fall back to the machine wallet for either rail — an
   * underfunded burner is the FUNDING REPLY path, not "bill the operator".
   */
  constructor(wallet) {
    const w = wallet?.keypair ? wallet : loadOrCreateWallet();
    this.keypair = w.keypair;
    // ?? null, NOT || machine key: a burner without an EVM key must fail
    // underfunded on EVM rails rather than quietly spending the operator's.
    this.evmPrivateKey = w.evmPrivateKey ?? null;
    this.walletCreated = w.created ?? false;
    this.walletPath = w.path ?? (w.xUserId ? `derived burner for X user ${w.xUserId}` : 'passed-in wallet');
    this.connection = new Connection(config.rpcUrl, 'confirmed');
    this.receipts = []; // last paid calls, newest last
    // EVERY OFFERED RAIL IS A FALLBACK, INCLUDING ROBINHOOD.
    //
    // This was opt-IN (`=== '1'`), which silently deleted every Robinhood row
    // from the candidate list. A wallet holding USDG on Robinhood Chain and
    // nothing else therefore failed with "no payable rail" while sitting on the
    // funds to pay — the exact failure the best-first loop below exists to
    // prevent, reintroduced one layer above it.
    //
    // Robinhood is still ORDERED LAST in orderAccepts(), so this changes only
    // what happens when the rails ahead of it cannot pay. Opt out with
    // OPENZOO_ENABLE_RH=0.
    this.allowRH = process.env.OPENZOO_ENABLE_RH !== '0';
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
   * What this wallet can PAY with on this rail, in whole-dollar units.
   *
   * This used to add a second term: the plain token behind the quoted WRAPPER,
   * because every row named a twin (yUSDCx / wTOKENx / the RH vault) and a
   * wallet holding 845,486 plain TOKEN read as "$3.14 covered" — the sliver
   * already wrapped. The gateway now quotes the raw native mint on every rail,
   * so the balance the row asks about is the balance the wallet holds and the
   * second term would double-count it. Advisory only: it feeds a display and a
   * funding hint, never a settlement.
   */
  async spendableUsdForAccept(accept) {
    const perUsd = BigInt(accept.maxAmountRequired || '0');
    if (perUsd <= 0n) return 0;
    const raw = await this.balanceForAccept(accept).catch(() => 0n);
    return Number(raw * 1000n / perUsd) / 1000;
  }

  /**
   * `challenge` is the whole 402 body, not decoration: the envelope echoes its
   * `resource` block and its `x402` summary decides which network string the
   * verifier will accept. Both rails build their payload here and the envelope
   * is assembled once, so neither can drift into the v1 shape on its own.
   */
  async buildPaymentFor(accept, onStage, challenge) {
    const rail = railOf(accept);
    if (rail === 'solana') {
      const need = BigInt(accept.maxAmountRequired);
      let bal = await cachedTokenBalance(this.connection, this.keypair.publicKey, accept.asset);
      // Never declare a wallet short on a STALE read — the expensive top-up path
      // and the underfunded error both deserve a live number.
      if (bal.raw < need && bal.cached) {
        bal = await cachedTokenBalance(this.connection, this.keypair.publicKey, accept.asset, { force: true });
      }
      // SHORT IS SHORT. The 402 quotes the raw native mint, so there is nothing
      // to convert and no pool to walk: the wallet either holds the asset or it
      // does not. This branch used to run resolvePool + poolState + a wrap
      // (~4.5s) to mint a Token-2022 twin the gateway no longer accepts.
      if (bal.raw < need) throw new UnderfundedError(accept, bal.ui, this.address);
      const built = await buildPaymentOnline(this.connection, this.keypair, accept);
      return { ...built, header: encodeEnvelope(paymentEnvelope(challenge, accept, built.payload)) };
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
          // Robinhood used to quote an ERC-4626 vault twin here and the shim
          // ran approve+deposit to mint it. The gateway now quotes canonical
          // Paxos USDG, which implements EIP-3009 directly, so the only
          // question left on every EVM rail is whether the wallet holds enough.
          const sym = accept?.extra?.symbol || 'the quoted asset';
          const where = rail === 'robinhood' ? 'Robinhood Chain' : rail === 'base' ? 'Base' : accept.network;
          throw new UnderfundedError(accept, null, owner, {
            line: `Send a few cents of ${sym} on ${where} to ${owner}.`,
          });
        }
      }
      return buildEvmPayment({ accept, evmPrivateKey: this.evmPrivateKey, challenge });
    }
    throw new Error(`no payment builder for rail ${rail} (network ${accept.network})`);
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
    init = { ...init, headers: withNamespace(init.headers || {}, { keypair: this.keypair }) };
    // THE WALLET IS THE ONLY PAY LANE. A stored bearer used to short-circuit
    // everything below it, which meant an inherited Authorization header could
    // buy inference this wallet never paid for. The gateway is pay-per-request
    // only, so any bearer the caller carried in is dropped here.
    init = { ...init, headers: stripAuthorization(init.headers || {}) };
    // ASK FOR THE RECEIPT-BEARING ROW.
    //
    // The gateway offers an AtomicSettle row on Base only to callers that say
    // they understand it, because it changes WHICH typed message the payer must
    // sign (ReceiveWithAuthorization, `to` = the contract) and a client that
    // signed the standard one would produce a payment that reverts on chain.
    // buildEvmPayment honours `extra.eip3009`, so this client does understand
    // it — and what it gets in return is a settlement whose on-chain leaf binds
    // the hash of the response it was served and the upstream's own COGS
    // transaction, instead of a bare debit.
    //
    // Opt out with OPENZOO_ATOMIC=0 if a gateway ever offers the row and gets
    // it wrong; the plain rows are always still there.
    if (process.env.OPENZOO_ATOMIC !== '0') {
      init = { ...init, headers: { ...(init.headers || {}), 'x-402-atomic': '1' } };
    }
    const first = await fetchHeaders(url, init);
    if (first.status !== 402) {
      return { response: first, paid: false };
    }

    const quote = parse402(await first.json());
    // config.rail (OPENZOO_RAIL) steers every front — proxy, demo, MCP — since
    // they all pay through this one call site. The wallet pays with whatever
    // it HOLDS: every offered row is tried best-first, and only when NONE is
    // affordable does the call fail — never because the first-choice asset
    // alone ran dry while another funded one sat in the wallet.
    const ordered = orderAccepts(quote, config.token, { allowRH: this.allowRH, forceRail: config.rail });
    // RAIL MEMORY. Remember which asset just paid and try it first, and skip
    // assets known underfunded within the TTL, so a wallet with three offered
    // rows does not re-probe the two it cannot pay on every single call.
    // Bounded and self-healing — the memo expires, a funded wallet is re-tried
    // automatically, and if every row is memoized we fall back to the full list
    // rather than manufacturing a dead end.
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
        payment = await this.buildPaymentFor(cand, onStage, quote);
        accept = cand;
        lastGoodAsset = memoKey(cand);
        underfundedUntil.delete(memoKey(cand));
        if (railOf(cand) === 'solana') {
          try { debitCachedBalance(this.keypair.publicKey, cand.asset, BigInt(cand.maxAmountRequired)); } catch { /* advisory */ }
        }
        break;
      } catch (e) {
        if (!(e instanceof UnderfundedError)) throw e;
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
    const response = await fetchHeaders(url, {
      ...init,
      headers: { ...stripAuthorization(init.headers || {}), ...paymentHeaders(payment.header) },
    });
    // NEVER PRESENT OUR OWN SIGNATURE AS THE TRANSACTION.
    //
    // This fell back to `{ signature: payment.ownerSignature }`, and on Solana
    // that signature CANNOT EXIST ON CHAIN: the facilitator is fee payer, so it
    // re-signs the payload before submitting and the resulting transaction has
    // a different signature entirely. MEASURED 2026-08-25 — the receipt printed
    // `tx 4wJ42z5dtnt2h7NZpKM5…`, which getTransaction reports as NOT FOUND,
    // for a payment that really settled as `2YgJg97DnK4cuvhE1jhCiwYS…`
    // (slot 441794097, 0.147837 TOKEN moved). The gateway's chat path did not
    // send `x-payment-response` at the time, so this fired on EVERY call: every
    // Solana receipt a customer could check came back "not found", which reads
    // as "I was never charged" when they were.
    //
    // No settle header now means no tx line, not a plausible-looking wrong one.
    // An absent id is honest; an unverifiable id is worse than useless.
    const settle = decodeSettleHeader(response.headers.get('x-payment-response')) || null;
    const receipt = {
      at: new Date().toISOString(),
      line: receiptLine(accept, settle),
      // The settle SIGNATURE as its own field, not only baked into `line`.
      // The xbot printed a burner ADDRESS prefix in its PAID log and the
      // operator spent an evening searching Solscan for it as a tx hash —
      // an id a machine can log must be one a human can look up.
      tx: settle?.transaction || settle?.txHash || settle?.signature || null,
      rail: railOf(accept),
      billedUsd: accept.extra?.billedUsd,
      directUsd: accept.extra?.directUsd,
      savedUsd: accept.extra?.savedUsd,
      cogsUsd: accept.extra?.cogsUsd,
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
