import http from 'node:http';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import {
  config, FUNDING_ASSETS, EVM_FUNDING_ASSETS, evmRpcFor, fundingLine, liveRails, railFundingHint, railFundingAddresses, unfundableRails, RAIL_FUNDING,
} from './config.js';
import { PayClient, QuoteTooHighError, UnderfundedError } from './pay.js';
import { tokenBalance } from './x402.js';
import { evmTokenBalance } from './evm.js';
import { bindCorpus, contextCacheDisabled, BIND_MIN_CHARS } from './hrr.js';
import { maybeRewriteModel, rewritablePath, augmentModelList, ALIAS_IDS } from './models.js';
import { forgetContext } from './contexts.js';

const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'content-length',
  // The harness's api key (sk-openzoo or anything) is accepted and dropped:
  // the zoo takes payment, not keys.
  'authorization',
]);

function upstreamHeaders(req) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

/** Pipe an upstream fetch Response to the client, unbuffered (SSE-safe). */
function relay(res, upstream) {
  const headers = {};
  upstream.headers.forEach((v, k) => {
    if (!['transfer-encoding', 'connection', 'content-encoding', 'content-length'].includes(k)) headers[k] = v;
  });
  res.writeHead(upstream.status, headers);
  if (!upstream.body) { res.end(); return Promise.resolve(); }
  return new Promise((resolve) => {
    const body = Readable.fromWeb(upstream.body);
    body.on('error', () => res.destroy());
    res.on('close', () => body.destroy());
    body.on('end', resolve);
    body.pipe(res);
  });
}

function jsonErr(res, status, message, extraFields = {}) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message }, ...extraFields }));
}

const mb = (n) => (n / 1048576).toFixed(1);

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
 * The zoo answers chat completions as ONE JSON object (it settles payment
 * before serving — there is nothing to stream until generation is done).
 * Harnesses that sent `stream: true` expect SSE and treat a JSON body as a
 * dead connection: Cursor shows "Reconnecting…", RETRIES, and every retry is
 * a fresh payment. So the proxy honours the contract itself — the finished
 * completion is re-emitted as spec-shaped chat.completion.chunk events.
 */
function serveAsSse(res, data, upstream) {
  const headers = {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
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
    // calls themselves dropped strands the harness mid-turn (observed: Cursor
    // agent hangs). Streaming spec: tool_calls ride the delta with an index,
    // arguments as a string chunk — one full chunk per call is valid SSE.
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
 * Window is deliberately short: a genuinely new turn always differs (harnesses
 * resend the whole conversation), so only true retries can hit.
 */
const REPLAY_TTL_MS = 30_000;
const replayCache = new Map(); // sha256(body) -> { at, data, settle }
function replayKey(bodyBuf) {
  return crypto.createHash('sha256').update(bodyBuf).digest('hex');
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
 * "The body never ships twice" at the proxy. A chat body whose LAST message
 * carries a huge pasted corpus gets split at its last blank line — corpus vs
 * ask — so the corpus can be bound ONCE on the zoo and every later call ships
 * only the ask plus X-HRR-Context. The split point is deterministic, which is
 * what makes the sha256 manifest hit on run 2 even when the question changed.
 *
 * Conservative on purpose: only a single big STRING content on the final
 * message, only when a blank-line boundary exists, and any failure falls back
 * to sending the original body untouched — caching must never break a call.
 * Returns null (send as-is) or { body, contextId, hash, corpus, reused, savedBytes }.
 */
async function maybeCacheCorpus(req, bodyBuf, log) {
  if (contextCacheDisabled()) return null;
  if (req.method !== 'POST' || !(req.url || '').includes('/chat/completions')) return null;
  if (req.headers['x-hrr-context']) return null; // harness manages its own context
  if (bodyBuf.length <= BIND_MIN_CHARS) return null;
  let body;
  try { body = JSON.parse(bodyBuf.toString('utf8')); } catch { return null; }
  const msgs = Array.isArray(body?.messages) ? body.messages : null;
  if (!msgs?.length) return null;
  const last = msgs[msgs.length - 1];
  if (typeof last?.content !== 'string' || last.content.length <= BIND_MIN_CHARS) return null;
  const cut = last.content.lastIndexOf('\n\n');
  if (cut < BIND_MIN_CHARS) return null;
  const corpus = last.content.slice(0, cut);
  const ask = last.content.slice(cut + 2).trim();
  if (!ask || ask.length > 8000) return null;

  const bind = await bindCorpus(corpus, {
    onStage: (stage, info) => {
      if (stage === 'binding') log(`binding ${mb(info.bytes)}MB corpus to holographic memory (one-time)...`);
    },
  });
  if (bind.reused) {
    log(`corpus already bound (${bind.hash.slice(0, 12)}… → ${bind.contextId}) — skipped ${mb(bind.bytes)}MB upload`);
  } else {
    log(`corpus bound once (${mb(bind.bytes)}MB → ${bind.contextId}) — repeats of this body are near-free`);
  }
  const rewritten = { ...body, messages: [...msgs.slice(0, -1), { ...last, content: ask }] };
  return {
    body: Buffer.from(JSON.stringify(rewritten)),
    contextId: bind.contextId,
    hash: bind.hash,
    corpus,
    reused: bind.reused,
    savedBytes: bind.bytes,
  };
}

/**
 * `requireToken` / `sessionMaxUsd` are TUNNEL MODE (see lib/tunnel.js): once the
 * proxy is reachable from the internet, the api key stops being decorative and
 * becomes the only thing between a stranger and your wallet. Both are off by
 * default, so localhost behaviour is unchanged.
 */
export async function startProxy({ silent = false, requireToken = null, sessionMaxUsd = null, autoTunnel = false } = {}) {
  const client = new PayClient();
  const log = silent ? () => {} : (...a) => console.log(...a);
  let sessionSpent = 0;
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

  const server = http.createServer(async (req, res) => {
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
    if (viaTunnel) {
      const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      if (got !== tunnelGate.token) {
        log(`public url: 401 ${req.method} ${req.url}`);
        jsonErr(res, 401, 'unauthorized: this openzoo public URL requires the api key printed at startup');
        return;
      }
      if (tunnelSpent >= tunnelGate.sessionMaxUsd) {
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
    // Harness model ids ("gpt-5.6-sol", "claude-…") are rewritten onto the
    // NEAREST zoo model BEFORE anything else sees the body — any POST that
    // carries a model field, not just chat/completions, so /completions,
    // /responses and future shapes all work. Never silent.
    let wantsStream = false;
    if (rewritablePath(req.method, req.url)) {
      const rw = await maybeRewriteModel(bodyBuf);
      if (rw) {
        log(`model "${rw.from}" is not on the zoo — nearest match ${rw.to} (OPENZOO_DEFAULT_MODEL overrides)`);
        bodyBuf = rw.body;
      }
      try { wantsStream = JSON.parse(bodyBuf.toString('utf8'))?.stream === true; } catch { /* not JSON */ }
    }

    // Retry of a body we answered seconds ago? Serve the cached completion —
    // never pay twice for a harness's reconnect loop.
    const isChat = req.method === 'POST' && (req.url || '').includes('/chat/completions');
    const rKey = isChat ? replayKey(bodyBuf) : null;
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
    const init = { method: req.method, headers: upstreamHeaders(req) };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = bodyBuf;

    // Harnesses validate their configured model BEFORE ever POSTing — some
    // list /v1/models, some probe /v1/models/<id>. Both must succeed for the
    // ids we know how to rewrite, or the harness refuses upfront and the
    // rewrite never gets its chance.
    const path = (req.url || '').split('?')[0];
    if (req.method === 'GET' && path === '/v1/models') {
      try {
        const { response } = await client.fetch(url, init);
        const payload = await response.json();
        res.writeHead(response.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response.ok ? augmentModelList(payload) : payload));
        return;
      } catch { /* fall through to the plain relay below */ }
    }
    const probe = req.method === 'GET' && /^\/v1\/models\/(.+)$/.exec(path);
    if (probe && ALIAS_IDS.includes(decodeURIComponent(probe[1]))) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: decodeURIComponent(probe[1]), object: 'model', owned_by: 'openzoo-alias' }));
      return;
    }

    try {
      let cached = null;
      try {
        cached = await maybeCacheCorpus(req, bodyBuf, log);
      } catch (err) {
        log(`context cache skipped for this call: ${err.message}`);
      }
      const send = (buf, ctxId) => client.fetch(url, {
        ...init,
        body: buf,
        headers: ctxId ? { ...init.headers, 'x-hrr-context': ctxId } : init.headers,
      });
      let result;
      if (cached) {
        result = await send(cached.body, cached.contextId);
        // Sidecar wiped between runs: the gateway 404s BEFORE the 402 (nothing
        // paid). Never fail on a stale manifest — re-bind once and retry.
        if (result.response.status === 404) {
          const text = await result.response.text();
          if (/context_not_found/.test(text)) {
            log('bound context is gone on the zoo — re-binding once...');
            forgetContext(config.apiBase, cached.hash);
            const rebound = await bindCorpus(cached.corpus, { force: true });
            result = await send(cached.body, rebound.contextId);
          } else {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(text);
            return;
          }
        }
      } else {
        result = await client.fetch(url, init);
      }
      const { response, paid, receipt } = result;
      if (paid && receipt) {
        if (receipt.ok && typeof receipt.billedUsd === 'number') {
          sessionSpent += receipt.billedUsd;
          // The public-URL ceiling meters only public-origin spend — your own
          // local calls never eat into it.
          if (viaTunnel) tunnelSpent += receipt.billedUsd;
        }
        const line = receipt.ok ? receipt.line : `paid retry -> HTTP ${receipt.status}`;
        // Wherever a running total is the thing to watch, it rides the receipt.
        if (requireToken) log(`${line}  ·  session $${sessionSpent.toFixed(6)}`);
        else if (viaTunnel) log(`${line}  ·  public-url session $${tunnelSpent.toFixed(6)}`);
        else log(line);
        scheduleRefresh(4000); // settlement lands on-chain in a few seconds
      }
      // Chat completions come back as one JSON object (settle-before-serve).
      // Cache it against retries, and if the harness asked to stream, honour
      // that contract ourselves. An upstream that someday truly streams (SSE
      // content-type) passes straight through the relay below, untouched.
      const upCt = response.headers.get('content-type') || '';
      if (isChat && response.ok && upCt.includes('application/json')) {
        let data = null;
        try { data = await response.clone().json(); } catch { /* not JSON after all */ }
        if (data?.object === 'chat.completion') {
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
      await relay(res, response);
    } catch (err) {
      if (err instanceof QuoteTooHighError) {
        log(err.message);
        jsonErr(res, 402, err.message, { quote: err.quote });
      } else if (err instanceof UnderfundedError) {
        log(err.message);
        jsonErr(res, 402, err.message);
      } else {
        jsonErr(res, 502, `openzoo proxy error: ${err.message}`);
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(config.port, '127.0.0.1', resolve);
  });

  if (!silent) {
    console.log(`openzoo proxy  ->  ${config.apiBase}`);
    console.log(`listening on   http://localhost:${config.port}/v1`);
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
    // LIVE REFRESH: the startup line goes stale the moment a call settles or
    // the user funds mid-session. Poll on an interval (and shortly after each
    // paid call), print ONLY on change, and call out arrivals explicitly so
    // "did my top-up land?" answers itself in the running log.
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
        // Funding advice is derived from those rails, never hardcoded — the
        // zoo can add a chain without this package shipping again.
        const hint = railFundingHint(rails.live);
        if (hint) console.log(`fund with:      ${hint}`);
        // The exact contracts those symbols mean — every chain has impersonator
        // mints, so a symbol without its CA is an invitation to fund the wrong one.
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
        tunnelGate = { token, sessionMaxUsd: cap };
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
        log(`public URL unavailable (${err.message}) — localhost still works; OPENZOO_NO_TUNNEL=1 hides this line`);
      }
    })();
  }
  return { server, client, spent: () => sessionSpent };
}
