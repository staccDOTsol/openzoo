import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import {
  config, FUNDING_ASSETS, EVM_FUNDING_ASSETS, evmRpcFor, fundingLine, liveRails, railFundingHint, railFundingAddresses, unfundableRails, RAIL_FUNDING,
} from './config.js';
import { execSync } from 'node:child_process';
import { PayClient, QuoteTooHighError, UnderfundedError } from './pay.js';
import { withOnrampLink } from './stripeOnramp.js';
import { tokenBalance } from './x402.js';
import { evmTokenBalance } from './evm.js';
import { autoContext } from './autobind.js';
import { modelsListForRequest, isHarnessAliasId, resolveModel, quoteableRows } from './models.js';

/**
 * Quoteable catalog ids, cached 5 minutes, for the fuzzy /v1/models/<id> probe.
 * Free read, but harnesses probe on every /model keystroke confirmation —
 * without a cache each probe is an upstream round trip.
 */
let catalogIdsMemo = { at: 0, ids: [] };
async function catalogIdsCached(modelsUrl, headers) {
  if (Date.now() - catalogIdsMemo.at < 5 * 60_000 && catalogIdsMemo.ids.length) return catalogIdsMemo.ids;
  const r = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`catalog ${r.status}`);
  const payload = await r.json();
  const ids = quoteableRows(payload?.data).map((m) => m.id);
  if (ids.length) catalogIdsMemo = { at: Date.now(), ids };
  return ids;
}
import { withNamespace } from './namespace.js';
import { loadSessionSpend, saveSessionSpend } from './session.js';
import { creditBalance, quotedPrices } from './info.js';
import { priceHoldings } from './livestatus.js';
import { receiptUsedCogs, receiptDirectUsd, pairActualBilled } from './racesettle.js';
import { fetchHeaders } from './fetch.js';
import { attachX402Proof } from './spendProof.js';

/** Kill whatever is LISTEN on this port except this process. */
export function killListen(port, run = execSync) {
  try {
    const pids = run(`lsof -nP -iTCP:${Number(port)} -sTCP:LISTEN -t`, {
      encoding: 'utf8', timeout: 2000,
    }).trim().split('\n').map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) {
      try { run(`kill ${pid}`, { stdio: 'ignore', timeout: 2000 }); } catch { /* already gone */ }
    }
    return pids;
  } catch {
    return [];
  }
}

// THE SHIM IS A FACILITATOR, NOT A MIDDLEBOX.
//
// Everything that used to rewrite the request on the way through — model-id
// rewriting, the tiny-classify pin, the reasoning max_tokens floor, transcript
// spilling / corpus binding, brief injection, system-message hoisting,
// Anthropic /v1/messages and Responses translation, AUTO routing — now lives
// on the backend. This proxy does exactly three jobs:
//   1. x402: answer the gateway's 402 with a signed payment (PayClient),
//   2. tunnel: publish + gate the public URL,
//   3. meter: read receipts so the operator can see spend vs direct.
// The request body is forwarded byte-for-byte. If a body looks wrong upstream,
// the fix belongs on the backend, never here.

const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'content-length',
  // `Expect: 100-continue` is sent by curl and most HTTP libraries once a body
  // passes ~1KB. undici REFUSES it outright ("expect header not supported"),
  // so forwarding it made every LARGE-body request fail while small ones
  // worked — i.e. it broke exactly the corpus calls this proxy exists for.
  'expect',
  // The harness's api key (sk-openzoo or anything) is accepted and dropped:
  // the zoo takes payment, not keys.
  'authorization',
]);

/**
 * Be forgiving about the path, the same way we are about model ids.
 * Harnesses are configured with a base_url that ALREADY ends in /v1, so an
 * agent building "{base}/v1/hrr/bind" sends /v1/v1/hrr/bind and gets a 404 it
 * cannot diagnose. Collapse repeated /v1 and add a missing one.
 */
function normalizePath(url) {
  const [path, query] = (url || '/').split(/(?=\?)/);
  let p = path.replace(/^(?:\/v1)+(?=\/v1\/)/, '');       // /v1/v1/x -> /v1/x
  if (!/^\/v1(\/|$)/.test(p) && /^\/(hrr|chat|models|completions|embeddings|usage|responses|messages)/.test(p)) p = `/v1${p}`;
  return p === path ? url : `${p}${query || ''}`;
}

function upstreamHeaders(req) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  // ATTACH THE AUTO-BOUND CWD, if there is one and the caller did not name a
  // context itself. Claude Code has no idea x402 or leCore exist and will never
  // send this header, so without an injection here a background bind is dead
  // weight — bound, paid for, never referenced. That is the state that produced
  // `spilled 0/12 calls` and a sub-1.0 savings multiple.
  //
  // An explicit x-hrr-context ALWAYS wins: a caller naming a corpus is stating
  // intent, and silently retargeting it at the cwd would answer from the wrong
  // corpus — the exact failure REPLAY_KEY_HEADERS exists to keep apart.
  if (!Object.keys(out).some((k) => k.toLowerCase() === 'x-hrr-context')) {
    const ctx = autoContext();
    if (ctx) out['x-hrr-context'] = ctx;
  }
  // EVERY forwarded request carries this wallet's context namespace — binds
  // and the chats that reference them must land in the same tenant.
  return withNamespace(out);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

/** Pipe an upstream fetch Response to the client, unbuffered (SSE-safe).
 *
 *  `onReceipt` is called with the gateway's x402 block when it arrives. On a
 *  STREAMED call there is no JSON body to carry that block, so the gateway
 *  emits it as an SSE COMMENT (`: x402 {...}`) after the last frame — comments
 *  are discarded by every compliant client, so nothing downstream sees it, but
 *  without reading it here every spend and savings figure on the status line
 *  would silently read zero the moment real streaming was switched on.
 *
 *  Sniffing NEVER delays a byte: each chunk is written to the client first and
 *  only then scanned. */
function relay(res, upstream, onReceipt) {
  const headers = {};
  upstream.headers.forEach((v, k) => {
    if (!['transfer-encoding', 'connection', 'content-encoding', 'content-length'].includes(k)) headers[k] = v;
  });
  res.writeHead(upstream.status, headers);
  if (!upstream.body) { res.end(); return Promise.resolve(); }
  const sse = (upstream.headers.get('content-type') || '').includes('text/event-stream');
  return new Promise((resolve) => {
    const body = Readable.fromWeb(upstream.body);
    body.on('error', () => res.destroy());
    res.on('close', () => body.destroy());
    body.on('end', resolve);
    if (!sse || typeof onReceipt !== 'function') { body.pipe(res); return; }
    let pending = '';
    body.on('data', (c) => {
      res.write(c);
      pending += c.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';   // a comment can straddle two chunks
      for (const line of lines) {
        if (!line.startsWith(': x402 ')) continue;
        try { onReceipt(JSON.parse(line.slice(7))); } catch { /* not our frame */ }
      }
    });
    body.on('end', () => res.end());
  });
}

function jsonErr(res, status, message, extraFields = {}) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message }, ...extraFields }));
}

/**
 * Every fundable balance across all three chains, for the startup line and
 * the live refresh. Each read is independent and advisory — one lagging RPC
 * drops its entry rather than blanking the whole line.
 */
async function snapshotBalances(client) {
  const out = [];
  try {
    const bals = await Promise.all(
      FUNDING_ASSETS.map((a) => tokenBalance(client.connection, client.keypair.publicKey, a.mint)),
    );
    FUNDING_ASSETS.forEach((a, i) => out.push({ symbol: a.symbol, ui: Number(bals[i].ui ?? 0), chain: 'solana' }));
  } catch { /* Solana RPC hiccup — EVM entries still report */ }
  const owner = client.evmAddress;
  if (owner) {
    await Promise.all(Object.entries(EVM_FUNDING_ASSETS).flatMap(([rail, assets]) => assets.map(async (a) => {
      try {
        const raw = await evmTokenBalance({ rpcUrl: evmRpcFor(rail), token: a.address, owner });
        out.push({ symbol: a.symbol, ui: Number(raw) / 10 ** a.decimals, chain: rail });
      } catch { /* advisory */ }
    })));
  }
  // Parallel reads land in racy order; sort so the printed line is stable
  // and diffs against the previous snapshot read cleanly.
  const rank = { solana: 0, base: 1, robinhood: 2 };
  return out.sort((a, b) => (rank[a.chain] ?? 9) - (rank[b.chain] ?? 9) || a.symbol.localeCompare(b.symbol));
}

/** Solana entries always show; EVM entries only once they hold something. */
function balanceLine(snap) {
  return snap
    .filter((b) => b.chain === 'solana' || b.ui > 0)
    .map((b) => `${b.ui} ${b.symbol}${b.chain !== 'solana' ? ` (${b.chain})` : ''}`)
    .join('  ·  ');
}

/**
 * When the zoo answers a chat completion as ONE JSON object but the harness
 * sent `stream: true`, honour the streaming contract ourselves — a JSON body
 * on an expected SSE socket reads as a dead connection (Cursor shows
 * "Reconnecting…", RETRIES, and every retry is a fresh payment). An upstream
 * that truly streams passes straight through relay(), untouched.
 */
function serveAsSse(res, data, upstream) {
  const headers = {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    // Tell any proxy in front of us (cloudflare quick tunnel, nginx) NOT to
    // buffer the stream — buffering reorders/merges tool_call frames an agent
    // parses incrementally.
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  };
  const settle = upstream?.headers?.get?.('x-payment-response');
  if (settle) headers['x-payment-response'] = settle;
  res.writeHead(200, headers);
  const base = {
    id: data.id, object: 'chat.completion.chunk', created: data.created, model: data.model,
  };
  const ev = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  for (const c of data.choices || []) {
    ev({ ...base, choices: [{ index: c.index ?? 0, delta: { role: 'assistant' }, finish_reason: null }] });
    if (c.message?.content) {
      ev({ ...base, choices: [{ index: c.index ?? 0, delta: { content: c.message.content }, finish_reason: null }] });
    }
    // Agent mode lives or dies here: a finish_reason of "tool_calls" with the
    // calls themselves dropped strands the harness mid-turn. Streaming spec:
    // tool_calls ride the delta with an index, arguments as a string chunk.
    if (Array.isArray(c.message?.tool_calls) && c.message.tool_calls.length) {
      ev({
        ...base,
        choices: [{
          index: c.index ?? 0,
          delta: {
            tool_calls: c.message.tool_calls.map((t, i) => ({
              index: i,
              id: t.id,
              type: t.type || 'function',
              function: { name: t.function?.name, arguments: t.function?.arguments ?? '' },
            })),
          },
          finish_reason: null,
        }],
      });
    }
    ev({ ...base, choices: [{ index: c.index ?? 0, delta: {}, finish_reason: c.finish_reason ?? 'stop' }], ...(data.usage ? { usage: data.usage } : {}) });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * Replay guard — a harness that cannot consume a response retries the SAME
 * body within seconds, and each retry used to be a fresh payment (observed:
 * six identical $0.06 settles for one Cursor message). An identical POST body
 * arriving within the window is served the cached completion, not re-paid.
 * Window is deliberately short: a genuinely new turn always differs.
 */
const REPLAY_TTL_MS = 30_000;
const replayCache = new Map(); // sha256(body+headers) -> { at, data, settle }
/**
 * The key MUST include the routing headers, not just the body: N shards asking
 * the SAME question of N DIFFERENT bound corpora send byte-identical bodies and
 * differ only in X-HRR-Context. Wrong answers attributed to the wrong corpus is
 * a far worse failure than the double-billing this cache exists to prevent.
 */
const REPLAY_KEY_HEADERS = ['x-hrr-context', 'x-hrr-top-k', 'x-hrr-gate', 'x-openzoo-namespace'];

function replayKey(bodyBuf, headers = {}) {
  const h = crypto.createHash('sha256').update(bodyBuf);
  for (const name of REPLAY_KEY_HEADERS) {
    const v = headers[name];
    if (v) h.update(`\n${name}:${v}`);
  }
  return h.digest('hex');
}
function replayGet(key) {
  const hit = replayCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > REPLAY_TTL_MS) { replayCache.delete(key); return null; }
  return hit;
}
function replayPut(key, data, settle) {
  replayCache.set(key, { at: Date.now(), data, settle });
  if (replayCache.size > 50) {
    const oldest = [...replayCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) replayCache.delete(oldest[0]);
  }
}

/**
 * `requireToken` / `sessionMaxUsd` are TUNNEL MODE (see lib/tunnel.js): once the
 * proxy is reachable from the internet, the api key stops being decorative and
 * becomes the only thing between a stranger and your wallet. Both are off by
 * default, so localhost behaviour is unchanged.
 */
export async function startProxy({ silent = false, requireToken = null, sessionMaxUsd = null, autoTunnel = false } = {}) {
  const client = new PayClient();
  // HOUSE OUTAGE GATE. Measured 2026-09-01: TOKEN payments settled on chain
  // (tx 3rwy5z…) and the gateway still answered 402 because ITS upstream
  // (OpenRouter) was out of credits. Paying again buys nothing, and the
  // "wallet underfunded" copy blamed the user's burner. When the paid 402 says
  // upstream credits, stop paying for a minute and say what is actually wrong.
  // Keyed by model: an OpenRouter outage must not gate a door-only id like
  // bare grok-4.6 that never touches OpenRouter.
  const upstreamOutage_ = new Map(); // model -> { until, msg }
  const outageKey = (init) => { try { return String(JSON.parse(String(init?.body || '{}')).model || ''); } catch { return ''; } };
  const upstreamOutage = (body) => {
    const m = String(body?.error?.message || body?.message || '');
    const src = String(body?.error?.metadata?.limit_source || '');
    return /openrouter_credits/i.test(src) || /insufficient credits/i.test(m);
  };
  const log = silent ? () => {} : (...a) => console.log(...a);
  // ALWAYS-ON, BUT NEVER INTO A HARNESS'S TERMINAL. `silent` means another
  // process (openzoo claude, the editor launcher) owns stdio — printing request
  // lines / payment receipts there corrupts that program's output. When silent,
  // route this channel to a log file instead; only print when we own the console.
  const restored = loadSessionSpend();
  let paidCalls = restored.paidCalls;
  let sayFile = null;
  if (silent) {
    try {
      sayFile = path.join(os.homedir(), '.openzoo', 'proxy.log');
      mkdirSync(path.dirname(sayFile), { recursive: true });
    } catch { sayFile = null; }
  }
  const say = (...a) => {
    const line = a.join(' ');
    if (sayFile) { try { appendFileSync(sayFile, line + '\n'); return; } catch { /* fall through */ } }
    console.log(line);
  };
  let sessionSpent = restored.spentUsd;
  let lastQuoteUsd = null;
  let sessionCogs = restored.cogsUsd;
  let sessionDirect = restored.directUsd;
  const rememberSpend = () => {
    saveSessionSpend({ spentUsd: sessionSpent, cogsUsd: sessionCogs, directUsd: sessionDirect, paidCalls });
  };
  if (restored.ok && (sessionSpent > 0 || paidCalls > 0)) {
    say(`session restored: $${sessionSpent.toFixed(6)} · ${paidCalls} paid call${paidCalls === 1 ? '' : 's'}`);
  }
  process.on('exit', rememberSpend);
  const noteQuote = (x) => {
    const billed = Number(x?.billedUsd);
    if (!Number.isFinite(billed) || billed < 0) return;
    const n = Number(x?.race || x?.race_n || 1);
    lastQuoteUsd = n > 1 ? billed / n : billed;
  };
  let tunnelSpent = 0;
  // Live balance refresh state — the real implementation is assigned in the
  // banner section below; the handler only ever calls scheduleRefresh().
  let lastSnap = null;
  let refreshBalances = async () => {};
  let refreshPending = false;
  const scheduleRefresh = (ms) => {
    if (silent || refreshPending) return;
    refreshPending = true;
    const t = setTimeout(async () => { refreshPending = false; await refreshBalances(); }, ms);
    t.unref?.();
  };
  // Set once cloudflared is up (see below). Gating keys off the REQUEST's
  // origin, not off whether the URL exists yet, so there is no startup window
  // where public traffic slips through ungated.
  let tunnelGate = null;
  // How many chat requests actually ARRIVED. The single number that answers
  // "is the editor really routing through us?"
  let servedRequests = 0;
  // ACTUAL UPSTREAM SPEND, FROM THE PROVIDER — not our estimate of it.
  // OpenRouter returns `usage.cost` on every completion; per-call cost is the
  // only figure attributable to THIS proxy.
  let sessionActual = 0;
  let actualCalls = 0;
  // billed for ONLY those calls whose real cost we learned — the honest
  // numerator for markupX.
  let billedWithActual = 0;
  // CREDIT, CACHED. Refreshed at most every 20s and served stale in between —
  // a status line must never add latency to the thing it is describing.
  let creditUsd = null;
  let creditAt = 0;
  let creditInflight = null;
  let lastPrices = {};
  let pricesAt = 0;
  const refreshCredit = async (force = false) => {
    if (!force && Date.now() - creditAt < 20000 && creditUsd != null) return creditUsd;
    if (creditInflight) return creditInflight;
    creditInflight = (async () => {
      try {
        creditUsd = await creditBalance();
        creditAt = Date.now();
      } catch { /* keep last known */ }
      creditInflight = null;
      return creditUsd;
    })();
    return creditInflight;
  };
  const refreshPrices = async () => {
    if (Date.now() - pricesAt < 60000 && Object.keys(lastPrices).length) return lastPrices;
    try {
      lastPrices = await quotedPrices();
      pricesAt = Date.now();
    } catch { /* keep last */ }
    return lastPrices;
  };
  const walletMoney = () => priceHoldings(lastSnap || [], lastPrices);
  let tunnelError = null;

  const server = http.createServer(async (req, res) => {
    // MCP on the SAME port as the proxy. One `npx openzoo` gives a harness
    // both surfaces: point base_url at /v1, or add /mcp for tools.
    if (req.method === 'GET' && (req.url || '').split('?')[0] === '/v1/session') {
      // NEVER await fly.dev. Serve last-known; refreshCredit() is
      // fire-and-forget so HUD "continue" cannot sit on HTTP 000.
      refreshCredit().catch(() => {});
      refreshPrices();
      const money = walletMoney();
      res.writeHead(200, { 'content-type': 'application/json' });
      const { version } = JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
      );
      res.end(JSON.stringify({
        version,
        spentUsd: sessionSpent, cogsUsd: sessionCogs, directUsd: sessionDirect, paidCalls,
        creditUsd, chainUsd: money.chainUsd, lastQuoteUsd,
      }));
      return;
    }

    // Public addresses only — never the private key. Exists so a caller can
    // print REAL funding instructions inline.
    if (req.method === 'GET' && (req.url || '').split('?')[0] === '/v1/wallet') {
      refreshCredit().catch(() => {});
      refreshPrices();
      const money = walletMoney();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        solana: client.address,
        evm: client.evmAddress,
        funding: fundingLine(client.address),
        balances: balanceLine(lastSnap || []) || null,
        funded: (lastSnap || []).some((b) => b.ui > 0),
        creditUsd,
        chainUsd: money.chainUsd,
        holdings: money.holdings,
      }));
      return;
    }

    if ((req.url || '').split('?')[0] === '/mcp') {
      try {
        const { handleMcpRequest } = await import('./mcphttp.js');
        await handleMcpRequest(req, res);
      } catch (err) {
        jsonErr(res, 500, `openzoo mcp error: ${err.message}`);
      }
      return;
    }

    // THE CUTESY GUI. Local browsers hitting GET / get a little chat app.
    // Tunnel traffic (cf headers) keeps the JSON discovery below.
    {
      const p0 = (req.url || '').split('?')[0];
      const local = !(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
      if (local && req.method === 'GET' && (p0 === '/' || p0 === '/gui')) {
        try {
          const html = readFileSync(new URL('./gui.html', import.meta.url), 'utf8');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        } catch { /* fall through to proxy behavior if the file is missing */ }
      }
    }

    const normalized = normalizePath(req.url);
    if (normalized !== req.url) {
      log(`path ${req.url} -> ${normalized} (base_url already ends in /v1)`);
      req.url = normalized;
    }
    const url = `${config.apiBase}${req.url}`;
    // Requests that arrived over the public quick-tunnel URL carry cloudflared's
    // headers; nothing dialing 127.0.0.1 directly does. That distinction is what
    // lets localhost stay keyless while the SAME port is safely public.
    const viaTunnel = !requireToken && tunnelGate
      && Boolean(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
    // Auth first: refuse before reading a body, forwarding, quoting or paying.
    if (requireToken) {
      const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      if (got !== requireToken) {
        log(`tunnel: 401 ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
        jsonErr(res, 401, 'unauthorized: this openzoo tunnel requires the api key printed at startup');
        return;
      }
      if (sessionMaxUsd != null && sessionSpent >= sessionMaxUsd) {
        jsonErr(res, 402, `openzoo tunnel session cap reached ($${sessionMaxUsd}) — restart the tunnel or raise OPENZOO_TUNNEL_MAX_USD`);
        return;
      }
    }
    // ROUTING TRUTH, SERVED FROM WHATEVER URL YOU REACHED US ON. Free and
    // unauthenticated: discovery must never be the thing that is gated.
    {
      const p0 = (req.url || '').split('?')[0];
      if (req.method === 'GET' && (p0 === '/v1/info' || p0 === '/info')) {
        refreshCredit();
        const self = viaTunnel && tunnelGate?.publicUrl
          ? `${tunnelGate.publicUrl}/v1`
          : `http://localhost:${config.port}/v1`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          youAreTalkingTo: 'openzoo proxy',
          yourEndpoint: self,
          reachedVia: viaTunnel ? 'public tunnel' : 'localhost',
          publicTunnel: tunnelGate?.publicUrl ? `${tunnelGate.publicUrl}/v1` : null,
          servedRequests,
          spendUsd: sessionSpent,
          creditUsd,
          // WHAT THE SAME CALLS WOULD HAVE COST DIRECT. Spend on its own is a
          // bill; spend beside the counterfactual is the product.
          directUsd: sessionDirect,
          savedUsd: Math.max(0, sessionDirect - sessionSpent),
          savingX: sessionSpent > 0 ? Number((sessionDirect / sessionSpent).toFixed(4)) : null,
          paidCalls,
          // WHAT THE INFERENCE ACTUALLY COST, as reported by the provider on
          // each completion (`usage.cost`). `margin` is the honest gross.
          actual: {
            calls: actualCalls,
            upstreamUsd: Number(sessionActual.toFixed(6)),
            billedUsd: Number(billedWithActual.toFixed(6)),
            marginUsd: Number((billedWithActual - sessionActual).toFixed(6)),
            markupX: sessionActual > 0 ? Number((billedWithActual / sessionActual).toFixed(2)) : null,
          },
          mcp: `${self.replace(/\/v1$/, '')}/mcp`,
          upstream: config.apiBase,
          payment: 'x402 per request from the operator\'s local burner wallet - no API key, no account',
          auth: viaTunnel
            ? 'this public URL requires the oz_… bearer for paid endpoints; /v1/models and /v1/hrr/bind are free'
            : 'localhost is keyless',
          shim: 'pure passthrough — request bodies are forwarded byte-for-byte; all message/model handling is on the backend',
          tools: ['zoo_bind', 'zoo_ask', 'zoo_status', 'zoo_models', 'zoo_wallet', 'zoo_contexts'],
          docs: 'https://openzoo.fun',
        }, null, 2));
        return;
      }
    }

    if (viaTunnel) {
      const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      // TRUST ON FIRST USE, so a stale key still works without weakening the
      // tunnel to "any key forever". The printed token always works, and the
      // FIRST other key to present itself claims the tunnel for the session.
      // OPENZOO_TUNNEL_STRICT=1 restores exact-match only.
      const strict = process.env.OPENZOO_TUNNEL_STRICT === '1';
      let authed = got === tunnelGate.token;
      if (!authed && !strict && got.length >= 8) {
        if (!tunnelGate.adopted) {
          tunnelGate.adopted = got;
          log(`public url: adopted the caller's key (first-use) — later keys must match it`);
          authed = true;
        } else {
          authed = got === tunnelGate.adopted;
        }
      }
      const p = (req.url || '').split('?')[0];
      // DISCOVERY IS FREE. Reads that cost nothing and leak nothing go through
      // without the key; money paths stay gated.
      if (!authed) {
        if (req.method === 'GET' && (p === '/' || p === '/v1' || p === '/v1/info')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            name: 'openzoo proxy (public tunnel)',
            what: 'OpenAI-compatible pay-per-call proxy — the operator\'s wallet pays per request via x402; no account, no signup.',
            authentication: 'All POST endpoints require `Authorization: Bearer <api key>`. The key is printed in the operator\'s terminal at proxy startup — ask them for it. It is NOT guessable.',
            endpoints: {
              'GET /v1/models': 'model catalog with pricing + context_length — no key needed',
              'GET /v1/models/{id}': 'single-model probe — no key needed',
              'POST /v1/chat/completions': 'chat (streaming supported) — key required',
            },
            docs: 'https://openzoo.fun · https://www.npmjs.com/package/openzoo',
          }, null, 2));
          return;
        }
        // Binding COSTS NOTHING — no 402, no wallet, no settlement. The money
        // paths below stay gated; the worst a stranger can do here is spend
        // the sidecar's disk.
        const freeRead = req.method === 'GET' && (p === '/v1/models' || p.startsWith('/v1/models/'));
        const freeBind = req.method === 'POST' && p === '/v1/hrr/bind';
        if (freeBind) log(`public url: unauthenticated bind allowed (free endpoint) from ${req.socket.remoteAddress}`);
        if (!freeRead && !freeBind) {
          log(`public url: 401 ${req.method} ${req.url}`);
          jsonErr(res, 401, 'unauthorized: this openzoo public URL requires the api key printed at the operator\'s proxy startup — GET / for discovery, GET /v1/models is open');
          return;
        }
      }
      if (authed && tunnelSpent >= tunnelGate.sessionMaxUsd) {
        jsonErr(res, 402, `openzoo public-URL session cap reached ($${tunnelGate.sessionMaxUsd}) — restart the proxy or raise OPENZOO_TUNNEL_MAX_USD`);
        return;
      }
    }
    let bodyBuf;
    try {
      bodyBuf = await readBody(req);
    } catch {
      jsonErr(res, 400, 'bad request body');
      return;
    }

    const rawPath = (req.url || '').split('?')[0];
    // Paid inference paths: chat completions, Anthropic messages, Responses.
    // The BODY IS NOT TOUCHED — the parse below is read-only, to learn the
    // client's streaming intent for the JSON→SSE compatibility path.
    const isChat = req.method === 'POST' && rawPath.includes('/chat/completions');
    const isPaidPost = req.method === 'POST'
      && /\/(chat\/completions|completions|messages|responses)$/.test(rawPath);
    let wantsStream = false;
    if (isPaidPost) {
      servedRequests += 1;
      say(`\n<- request #${servedRequests} from ${(req.headers['user-agent'] || 'unknown').slice(0, 40)}`);
      try { wantsStream = JSON.parse(bodyBuf.toString('utf8'))?.stream === true; } catch { /* not JSON */ }
    }

    // Retry of a body we answered seconds ago? Serve the cached completion —
    // never pay twice for a harness's reconnect loop. Chat-completions JSON
    // only: it is the one shape we know how to re-emit (including as SSE).
    const rKey = isChat ? replayKey(bodyBuf, req.headers) : null;
    if (rKey) {
      const hit = replayGet(rKey);
      if (hit) {
        log('identical request within 30s — served the cached completion, NOT re-paid');
        if (wantsStream) { serveAsSse(res, hit.data, null); return; }
        const h = { 'content-type': 'application/json' };
        if (hit.settle) h['x-payment-response'] = hit.settle;
        res.writeHead(200, h);
        res.end(JSON.stringify(hit.data));
        return;
      }
    }
    let init = { method: req.method, headers: upstreamHeaders(req) };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = bodyBuf;

    // Harnesses validate their configured model BEFORE ever POSTing — some
    // list /v1/models, some probe /v1/models/<id>. Both must succeed for the
    // alias ids the launchers write into configs.
    const path = (req.url || '').split('?')[0];
    if (req.method === 'GET' && path === '/v1/models') {
      // Catalog is chrome, not a paid call. Paying the list would put a 402
      // round trip and a balance read in front of first paint.
      try {
        const response = await fetchHeaders(url, init);
        if (response.ok) {
          const payload = await response.json();
          // Quoteable catalog only: no :batch twins, no $0 rows, no clones.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(modelsListForRequest(payload, req.headers)));
          return;
        }
        await response.text().catch(() => {});
      } catch { /* gateway 402/down — serve aliases so chrome still paints */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(modelsListForRequest({ object: 'list', data: [] }, req.headers)));
      return;
    }
    const probe = req.method === 'GET' && /^\/v1\/models\/(.+)$/.exec(path);
    if (probe) {
      const wanted = decodeURIComponent(probe[1]);
      if (isHarnessAliasId(wanted)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: wanted, object: 'model', owned_by: 'openzoo-alias' }));
        return;
      }
      // FUZZY, LIKE THE REST OF THE PIPELINE. The gateway already
      // similarity-rewrites whatever model id lands in a POST body — but a
      // harness never gets that far, because it validates the id CLIENT-SIDE
      // with this exact probe first. Answering 200 only for a hand-typed
      // alias list meant `/model deepseek pro` and `/model
      // deepseek-ai/deepseek-v4-pro` were both refused at the door while the
      // backend would have served either happily. The door must be exactly as
      // forgiving as the room behind it.
      try {
        const ids = await catalogIdsCached(url.replace(/\/v1\/models\/.*$/, '/v1/models'), init.headers);
        if (ids.includes(wanted)) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: wanted, object: 'model' }));
          return;
        }
        const resolved = resolveModel(wanted, ids);
        if (resolved) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: wanted, object: 'model', owned_by: 'openzoo-alias', served_by: resolved }));
          return;
        }
      } catch { /* catalog unreachable — fall through to the paid path below */ }
    }

    try {
      // OUTAGE FALLBACK. OpenRouter dry does not have to mean dead bots: the
      // x402 door for bare grok-4.6 settles cogs on chain and never touches
      // OpenRouter. When a model is gated (or comes back "Insufficient
      // credits" below), the same request goes out once more on the fallback.
      const FALLBACK_MODEL = String(process.env.OPENZOO_OUTAGE_FALLBACK || 'grok-4.6');
      const withModel = (i, model) => {
        try { const b = JSON.parse(String(i.body || '{}')); b.model = model; return { ...i, body: JSON.stringify(b) }; } catch { return i; }
      };
      let usedFallback = false;
      {
        const gate = upstreamOutage_.get(outageKey(init));
        if (gate && Date.now() < gate.until) {
          if (FALLBACK_MODEL && outageKey(init) !== FALLBACK_MODEL) {
            log(`upstream outage: ${outageKey(init)} gated -> ${FALLBACK_MODEL}`);
            init = withModel(init, FALLBACK_MODEL);
            usedFallback = true;
          } else {
            log(`upstream outage: not paying (gate) model=${outageKey(init)}`);
            jsonErr(res, 503, gate.msg);
            return;
          }
        }
      }
      let result = await client.fetch(url, init);
      // Paid, then the gateway said its upstream is out of credits: gate this
      // model for 60s and buy the same completion from the door instead.
      if (result.paid && result.response?.status === 402 && !usedFallback && FALLBACK_MODEL && outageKey(init) !== FALLBACK_MODEL) {
        let q402 = null;
        try { q402 = await result.response.clone().json(); } catch { q402 = null; }
        if (upstreamOutage(q402)) {
          const tx = q402?.x402?.settle?.transaction || result.receipt?.tx || '';
          const msg = `openzoo gateway upstream is out of credits (OpenRouter: "Insufficient credits") for ${outageKey(init)}; that payment${tx ? ` (tx ${tx})` : ''} is credited back by the gateway. Routing to ${FALLBACK_MODEL} (x402 door) for 60s.`;
          upstreamOutage_.set(outageKey(init), { until: Date.now() + 60_000, msg });
          log(`upstream outage: ${outageKey(init)} -> ${FALLBACK_MODEL}`);
          init = withModel(init, FALLBACK_MODEL);
          usedFallback = true;
          result = await client.fetch(url, init);
        }
      }
      const { response, paid, receipt, accept } = result;
      if (paid && receipt) {
        if (receipt.ok && typeof receipt.billedUsd === 'number') {
          sessionSpent += receipt.billedUsd;
          sessionCogs += receiptUsedCogs(receipt);
          noteQuote(receipt);
          sessionDirect += receiptDirectUsd(receipt);
          // The public-URL ceiling meters only public-origin spend — your own
          // local calls never eat into it.
          if (viaTunnel) tunnelSpent += receipt.billedUsd;
        }
        const line = receipt.ok ? receipt.line : `paid retry -> HTTP ${receipt.status}`;
        if (requireToken) say(`${line}  ·  session $${sessionSpent.toFixed(6)}`);
        else if (viaTunnel) say(`${line}  ·  public-url session $${tunnelSpent.toFixed(6)}`);
        else say(line);
        // ALWAYS-ON SPEND, TUI-SAFE: running total in the terminal TITLE via
        // an OSC escape, never in a TUI's content.
        if (receipt.ok && typeof receipt.billedUsd === 'number') { paidCalls += 1; }
        if (receipt.ok && typeof receipt.billedUsd === 'number') rememberSpend();
        if (sayFile) {
          try { process.stderr.write(`]0;openzoo ◝ $${sessionSpent.toFixed(4)} · ${paidCalls} call${paidCalls === 1 ? '' : 's'}`); } catch { /* no tty */ }
        }
        scheduleRefresh(4000); // settlement lands on-chain in a few seconds
      }
      const upCt = response.headers.get('content-type') || '';
      if (isPaidPost && response.ok && upCt.includes('application/json')) {
        let data = null;
        try { data = await response.clone().json(); } catch { /* not JSON after all */ }
        // WHAT IT REALLY COST, straight from the provider — rides every
        // completion already; no extra call.
        {
          // PAIR THE NUMERATOR WITH THE DENOMINATOR: usage.cost with the
          // post-completion billed twin, never the quote reserve.
          const pair = pairActualBilled(data?.x402, data?.usage);
          if (pair) {
            sessionActual += pair.upstreamUsd;
            actualCalls += 1;
            billedWithActual += pair.billedUsd;
          }
        }
        // PREPAID CALLS STILL COST MONEY. When prepaid credit covers the quote
        // the gateway serves 200 on the FIRST request — no 402, no payment, no
        // receipt. The receipt still rides the response body, so meter it there.
        if (!paid && data?.x402 && typeof data.x402.billedUsd === 'number') {
          const x = data.x402;
          sessionSpent += x.billedUsd;
          sessionCogs += receiptUsedCogs(x);
          noteQuote(x);
          sessionDirect += receiptDirectUsd(x);
          paidCalls += 1;
          if (viaTunnel) tunnelSpent += x.billedUsd;
          rememberSpend();
          say(`credit -> $${x.billedUsd.toFixed(6)}  ·  session $${sessionSpent.toFixed(6)}`);
        }
        if (data?.object === 'chat.completion') {
          if (paid && receipt) {
            attachX402Proof(data, {
              tx: receipt.tx,
              memo: receipt.memo || accept?.extra?.memo,
              rail: receipt.rail,
            });
          }
          if (rKey) replayPut(rKey, data, response.headers.get('x-payment-response'));
          if (wantsStream) { serveAsSse(res, data, response); return; }
          const h = { 'content-type': 'application/json' };
          const settleHdr = response.headers.get('x-payment-response');
          if (settleHdr) h['x-payment-response'] = settleHdr;
          res.writeHead(200, h);
          res.end(JSON.stringify(data));
          return;
        }
      }
      // A STREAMED call is metered from the gateway's trailing SSE comment —
      // same figures the JSON path reads out of `data.x402`, same counters, so
      // the status line does not care which transport served the answer.
      const meterStreamed = (x) => {
        const pair = pairActualBilled(x, x?.usage);
        if (pair) {
          sessionActual += pair.upstreamUsd;
          actualCalls += 1;
          billedWithActual += pair.billedUsd;
        }
        if (paid || typeof x?.billedUsd !== 'number') return;
        sessionSpent += x.billedUsd;
        sessionCogs += receiptUsedCogs(x);
        noteQuote(x);
        sessionDirect += receiptDirectUsd(x);
        paidCalls += 1;
        if (viaTunnel) tunnelSpent += x.billedUsd;
        rememberSpend();
        say(`credit -> $${x.billedUsd.toFixed(6)}  ·  session $${sessionSpent.toFixed(6)}`);
      };
      // A 402 AFTER we attempted payment is a SETTLEMENT failure, not a quote —
      // the client-side balance check is advisory, so a wallet that looks
      // fundable can still fail on-chain, and the gateway answers the paid
      // retry with a fresh 402. Relaying that raw meant Claude Code printed a
      // half-kilobyte accepts[] blob at the user instead of the one thing they
      // need: the price, what the wallet holds, and where to send funds.
      if (response.status === 402) {
        let quoted = '';
        let usd;
        let q402 = null;
        try { q402 = await response.clone().json(); } catch { q402 = null; }
        if (paid && upstreamOutage(q402)) {
          const settle = q402?.x402?.settle;
          const tx = settle?.transaction || result.receipt?.tx || '';
          const msg = 'openzoo gateway upstream is out of credits (OpenRouter: "Insufficient credits"). '
            + `Your payment settled${tx ? ` (tx ${tx})` : ''} — this is NOT your wallet. `
            + 'The gateway operator must top up OpenRouter or route this model to another upstream. '
            + `Pausing paid retries for ${outageKey(init) || 'this model'} for 60s.`;
          upstreamOutage_.set(outageKey(init), { until: Date.now() + 60_000, msg });
          log(`upstream outage: model=${outageKey(init)} ${msg.slice(0, 100)}`);
          jsonErr(res, 503, msg);
          return;
        }
        try {
          const q = q402;
          usd = Number(q?.accepts?.[0]?.extra?.billedUsd);
          if (Number.isFinite(usd)) quoted = ` This call needs ≈$${usd.toFixed(4)}.`;
        } catch { /* body was not the quote after all */ }
        const msg = await withOnrampLink(
          `openzoo wallet underfunded — payment did not settle.${quoted} `
          + `Fund it and retry: send USDC (or TOKEN/LEOS for half price) to ${client.address} on Solana, `
          + `or USDC to ${client.evmAddress} on Base. Check with: openzoo balance`,
          { solana: client.address, usd },
        );
        log(/ties to your account/i.test(msg) ? 'onramp: whop + copy-paste solana' : 'onramp: no fund blurb');
        jsonErr(res, 402, msg);
        return;
      }
      await relay(res, response, meterStreamed);
    } catch (err) {
      if (err instanceof QuoteTooHighError) {
        log(err.message);
        jsonErr(res, 402, err.message, { quote: err.quote });
      } else if (err instanceof UnderfundedError) {
        const msg = await withOnrampLink(err.message, {
          solana: client.address, usd: Number(err.accept?.extra?.billedUsd),
        });
        log(msg);
        jsonErr(res, 402, msg);
      } else {
        // "fetch failed" alone is undiagnosable — undici hides the real
        // network error in `cause`. Surface it or every transport hiccup looks
        // identical to a payment bug.
        const cause = err.cause?.message || err.cause?.code || err.cause;
        const raw = cause ? `${err.message} (${cause})` : err.message;
        const detail = raw;
        log(`proxy error: ${detail}`);
        if (process.env.OPENZOO_DEBUG) console.error(err.stack);
        jsonErr(res, 502, `openzoo proxy error: ${detail}`);
      }
    }
  });

  // BIND HOST. Default 127.0.0.1 — the keyless localhost path must never be
  // world-reachable on an ordinary machine. A RunPod box sets
  // OPENZOO_BIND=0.0.0.0 AND a tunnel token, so that port stays gated exactly
  // like the public tunnel path.
  const bindHost = process.env.OPENZOO_BIND || '127.0.0.1';
  // SELF-HEAL A TAKEN PORT. Walk up to the next free port instead of dying;
  // the caller reads config.port back out, so every URL printed afterwards is
  // the one we actually bound. A healthy proxy already on the port is KILLED
  // — reusing it left a stale PayClient serving $0 after a TOKEN top-up.
  const wanted = config.port;
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const onErr = (e) => { server.removeListener('error', onErr); reject(e); };
        server.on('error', onErr);
        server.listen(config.port, bindHost, () => { server.removeListener('error', onErr); resolve(); });
      });
      break;
    } catch (e) {
      if (e?.code !== 'EADDRINUSE' || attempt >= 12) throw e;
      if (attempt === 0) {
        const pids = killListen(config.port);
        if (pids.length) {
          say(`openzoo: killed proxy on :${config.port} (pids ${pids.join(',')})`);
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
      }
      config.port += 1;
      say(`openzoo: :${config.port - 1} busy — trying :${config.port}`);
    }
  }
  if (config.port !== wanted) say(`openzoo: listening on :${config.port} (:${wanted} was busy)`);

  // AUTO-PREPAY. Paying on-chain per call is where the latency lives: credit
  // is applied automatically server-side whenever a balance covers the quote,
  // so buying it once makes every later call skip verify+settle entirely.
  // Runs in the background and only when this wallet actually has funds.
  // Opt out with OPENZOO_NO_AUTOTOPUP=1; size it with OPENZOO_AUTOTOPUP_USD.
  if (!process.env.OPENZOO_NO_AUTOTOPUP) {
    const FLOOR = Number(process.env.OPENZOO_AUTOTOPUP_FLOOR || 2);
    const EVERY = Number(process.env.OPENZOO_AUTOTOPUP_EVERY_MS || 60_000);
    let topping = false;
    const tick = async () => {
      if (topping) return;
      topping = true;
      try {
        const { creditBalance, topUp, affordableUsd } = await import('./info.js');
        const have = await creditBalance();
        if (have >= FLOOR) return;
        const can = await affordableUsd();
        if (can < 1) return;             // nothing to convert; stay quiet
        say(`credit $${have.toFixed(4)} below $${FLOOR} — wallet covers ~$${can.toFixed(2)}, topping up`);
        await topUp('all');
      } catch (e) {
        say(`auto top-up skipped: ${String(e.message || e).slice(0, 120)}`);
      } finally {
        topping = false;
      }
    };
    tick();
    const timer = setInterval(tick, EVERY);
    timer.unref?.();   // never hold the process open just for this
  }

  if (!silent) {
    // VERSION IN THE BANNER, deliberately. `npx openzoo` can serve a STALE
    // cached copy; printing the version makes that one glance.
    const { version } = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    console.log(`openzoo v${version}  ->  ${config.apiBase}`);
    console.log(`listening on   http://localhost:${config.port}/v1`);
    // The chat GUI still lives at GET / — but it is never auto-opened.
    console.log('');
    if (client.walletCreated) console.log(`new burner wallet created at ${client.walletPath} (chmod 600)`);
    console.log(`wallet (fund me) · solana: ${client.address}`);
    if (client.evmAddress) console.log(`wallet (fund me) · evm (base / robinhood): ${client.evmAddress}`);
    try {
      lastSnap = await snapshotBalances(client);
      console.log(`balance: ${balanceLine(lastSnap) || '(no RPC reachable — advisory only)'}`);
      if (!lastSnap.some((b) => b.ui > 0)) {
        console.log(`fund it: ${fundingLine('the address above')} — a few cents goes a long way.`);
      }
    } catch { /* RPC hiccup: balance is advisory */ }
    refreshCredit();
    refreshPrices();
    // LIVE REFRESH: poll on an interval (and shortly after each paid call),
    // print ONLY on change, and call out arrivals explicitly.
    refreshBalances = async () => {
      try {
        const snap = await snapshotBalances(client);
        if (!snap.length) return;
        const prev = new Map((lastSnap || []).map((b) => [`${b.chain}:${b.symbol}`, b.ui]));
        const changed = snap.some((b) => Math.abs((prev.get(`${b.chain}:${b.symbol}`) ?? 0) - b.ui) > 1e-9)
          || snap.length !== (lastSnap || []).length;
        if (!changed) return;
        if (lastSnap) {
          for (const b of snap) {
            const gain = b.ui - (prev.get(`${b.chain}:${b.symbol}`) ?? 0);
            if (gain > 1e-9) console.log(`funding arrived: +${gain.toFixed(6)} ${b.symbol}${b.chain !== 'solana' ? ` (${b.chain})` : ''}`);
          }
        }
        lastSnap = snap;
        console.log(`balance: ${balanceLine(snap)}`);
      } catch { /* advisory — never noisy on RPC trouble */ }
    };
    const pollSecs = Number(process.env.OPENZOO_BALANCE_POLL_SECS ?? 45);
    if (pollSecs > 0) {
      const timer = setInterval(refreshBalances, pollSecs * 1000);
      timer.unref?.();
    }
    // Which rails the zoo will actually settle right now, straight off a live
    // 402 — so nobody funds a lane the resource is not currently offering.
    try {
      const rails = await liveRails();
      if (rails) {
        console.log(`rails live now: ${rails.live.join(' · ')}`);
        const hint = railFundingHint(rails.live);
        if (hint) console.log(`fund with:      ${hint}`);
        for (const row of railFundingAddresses(rails.live)) {
          row.assets.forEach((a, i) => {
            const label = i === 0 ? row.label : '';
            console.log(`  ${label.padEnd(16)} ${a.symbol.padEnd(11)} ${a.address}${a.note ? `  (${a.note})` : ''}`);
          });
        }
        const unfundable = unfundableRails(rails.live);
        if (unfundable.length) {
          const fundable = rails.live.filter((r) => RAIL_FUNDING[r]?.assets.length).map((r) => RAIL_FUNDING[r].label);
          const instead = fundable.length ? `pay from ${fundable.join(' or ')} instead` : 'no fundable rail is offered right now';
          console.log(`note:           ${unfundable.join(' / ')} is offered by the zoo but not fundable from a plain balance here — ${instead}.`);
        }
        if (rails.dark.length) {
          const rh = rails.dark.includes('robinhood') ? ' — robinhood also needs OPENZOO_ENABLE_RH=1' : '';
          console.log(`rails implemented but not offered by the zoo right now: ${rails.dark.join(' · ')}${rh}`);
        }
      }
    } catch { /* quote probe is advisory */ }
    console.log('');
    console.log('point any OpenAI-compatible harness at:');
    console.log(`  base_url = http://localhost:${config.port}/v1`);
    console.log('  api_key  = sk-openzoo   (any value works; the zoo takes payment, not keys)');
  }

  // AUTO-TUNNEL: `npx openzoo` must be end-to-end for cloud IDEs too — their
  // servers cannot dial localhost, so the default command also publishes a
  // quick-tunnel URL. It comes up in the background (never delays localhost),
  // failure degrades to local-only, and public traffic is gated above by
  // token + its own spend ceiling. OPENZOO_NO_TUNNEL=1 opts out.
  if (autoTunnel && process.env.OPENZOO_NO_TUNNEL !== '1') {
    (async () => {
      try {
        const { ensureCloudflared, startCloudflared, mintToken } = await import('./tunnel.js');
        const token = mintToken();
        const cap = process.env.OPENZOO_TUNNEL_MAX_USD ? Number(process.env.OPENZOO_TUNNEL_MAX_USD) : Infinity;
        const bin = await ensureCloudflared((m) => log(m));
        const { url, proc } = await startCloudflared(bin, config.port, log);
        tunnelGate = { token, sessionMaxUsd: cap, publicUrl: url };
        const bye = () => { try { proc.kill('SIGTERM'); } catch { /* already gone */ } };
        process.once('SIGINT', () => { bye(); process.exit(0); });
        process.once('SIGTERM', () => { bye(); process.exit(0); });
        process.once('exit', bye);
        log('');
        log('cloud IDE / remote harness? use the public URL (they cannot reach localhost):');
        log(`  base_url = ${url}/v1`);
        log(`  api_key  = ${token}`);
        log(`  (key REQUIRED on the public URL — it spends this wallet; ${Number.isFinite(cap) ? `capped at $${cap.toFixed(2)}/session` : 'NO session cap — OPENZOO_TUNNEL_MAX_USD adds one'},`);
        log('   OPENZOO_NO_TUNNEL=1 for localhost-only)');
      } catch (err) {
        // Record it: a caller polling for publicUrl (openzoo cursor) would
        // otherwise spin the full timeout on a tunnel that already died.
        tunnelError = err.message;
        log(`public URL unavailable (${err.message}) — localhost still works; OPENZOO_NO_TUNNEL=1 hides this line`);
      }
    })();
  }
  // Expose live tunnel details so a caller that starts the proxy in-process
  // (openzoo cursor/vscode) can surface the public URL + key. Getters, because
  // the tunnel resolves ASYNC after this returns.
  return {
    server,
    client,
    spent: () => sessionSpent,
    get publicUrl() { return tunnelGate?.publicUrl ?? null; },
    get tunnelToken() { return tunnelGate?.token ?? null; },
    get tunnelError() { return tunnelError; },
  };
}
