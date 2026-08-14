import http from 'node:http';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { PayClient, QuoteTooHighError, UnderfundedError } from './pay.js';
import { tokenBalance } from './x402.js';

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

export async function startProxy({ silent = false } = {}) {
  const client = new PayClient();
  const log = silent ? () => {} : (...a) => console.log(...a);

  const server = http.createServer(async (req, res) => {
    const url = `${config.apiBase}${req.url}`;
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
      const { response, paid, receipt } = await client.fetch(url, init);
      if (paid && receipt) log(receipt.ok ? receipt.line : `paid retry -> HTTP ${receipt.status}`);
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
    console.log(`wallet (fund me): ${client.address}`);
    try {
      // yUSDCx — the $1-stable rail this proxy pays with by default.
      const yusdcx = '6ZjjxcoicqM4nniddkuPVwew4PDwY3swbfHsGbCuLuTv';
      const bal = await tokenBalance(client.connection, client.keypair.publicKey, yusdcx);
      console.log(`balance: ${bal.ui ?? 0} yUSDCx (mint ${yusdcx})`);
      if (!bal.raw) {
        console.log('fund it with yUSDCx (wrap USDC at https://x402.accrue.fund/start) — a few cents goes a long way.');
      }
    } catch { /* RPC hiccup: balance is advisory */ }
    console.log('');
    console.log('point any OpenAI-compatible harness at:');
    console.log(`  base_url = http://localhost:${config.port}/v1`);
    console.log('  api_key  = sk-openzoo   (any value works; the zoo takes payment, not keys)');
  }
  return { server, client };
}
