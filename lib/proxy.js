import http from 'node:http';
import { Readable } from 'node:stream';
import {
  config, FUNDING_ASSETS, fundingLine, liveRails, railFundingHint, unfundableRails, RAIL_FUNDING,
} from './config.js';
import { PayClient, QuoteTooHighError, UnderfundedError } from './pay.js';
import { tokenBalance } from './x402.js';
import { bindCorpus, contextCacheDisabled, BIND_MIN_CHARS } from './hrr.js';
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
export async function startProxy({ silent = false, requireToken = null, sessionMaxUsd = null } = {}) {
  const client = new PayClient();
  const log = silent ? () => {} : (...a) => console.log(...a);
  let sessionSpent = 0;

  const server = http.createServer(async (req, res) => {
    const url = `${config.apiBase}${req.url}`;
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
    let bodyBuf;
    try {
      bodyBuf = await readBody(req);
    } catch {
      jsonErr(res, 400, 'bad request body');
      return;
    }
    const init = { method: req.method, headers: upstreamHeaders(req) };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = bodyBuf;

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
        if (receipt.ok && typeof receipt.billedUsd === 'number') sessionSpent += receipt.billedUsd;
        const line = receipt.ok ? receipt.line : `paid retry -> HTTP ${receipt.status}`;
        // In tunnel mode the running total is the thing you actually want to
        // watch, so it rides on every receipt.
        log(requireToken ? `${line}  ·  session $${sessionSpent.toFixed(6)}` : line);
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
      const bals = await Promise.all(
        FUNDING_ASSETS.map((a) => tokenBalance(client.connection, client.keypair.publicKey, a.mint)),
      );
      const parts = FUNDING_ASSETS.map((a, i) => `${bals[i].ui ?? 0} ${a.symbol}`);
      console.log(`balance: ${parts.join('  ·  ')}`);
      if (!bals.some((b) => b.raw)) {
        console.log(`fund it: ${fundingLine('the address above')} — a few cents goes a long way.`);
      }
    } catch { /* RPC hiccup: balance is advisory */ }
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
  return { server, client, spent: () => sessionSpent };
}
