/**
 * The local voice endpoint — what the browser extension talks to.
 *
 * WHY A LOCAL SERVER AND NOT A DIRECT CALL FROM THE EXTENSION: the rewrite
 * needs the wallet (x402 settles from ~/.openzoo/wallet.json), the local
 * leCore daemon (scored recall over your bound turns), and the style card
 * on disk. None of those belong in a browser extension — shipping a
 * keypair into an extension's storage is how you lose it. The extension
 * stays dumb: it POSTs text to 127.0.0.1 and gets text back.
 *
 * Bound to loopback only, and CORS is restricted to the X origins. The
 * threat model is "a random page in your browser can't spend your wallet",
 * which loopback + origin allowlist covers.
 */

import http from 'node:http';
import { voiceText } from './voice.js';

const ALLOWED_ORIGINS = new Set([
  'https://x.com',
  'https://twitter.com',
  'https://mobile.x.com',
  'https://mobile.twitter.com',
  ...(process.env.OPENZOO_VOICE_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
]);

export const VOICE_PORT = Number(process.env.OPENZOO_VOICE_PORT || 8403);

function cors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
    return true;
  }
  return false;
}

export async function runVoiceServe(args = []) {
  const port = Number(args[0]) || VOICE_PORT;
  const log = (m) => console.error(`  ${m}`);

  const server = http.createServer(async (req, res) => {
    const ok = cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(ok ? 204 : 403).end(); return; }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'openzoo voice' }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/voice') { res.writeHead(404).end(); return; }
    // An unlisted origin is refused BEFORE the wallet is touched: a rewrite
    // is a paid call, so an open endpoint is an open tab away from spending
    // your money on someone else's page.
    if (!ok && req.headers.origin) { res.writeHead(403).end('origin not allowed'); return; }

    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 100_000) req.destroy(); });
    req.on('end', async () => {
      try {
        const { text, kind } = JSON.parse(body || '{}');
        if (!text || typeof text !== 'string') { res.writeHead(400).end('no text'); return; }
        const started = Date.now();
        const r = await voiceText(text, { kind });
        log(`${kind || 'post'}: ${text.length} → ${r.text.length} chars · ${((Date.now() - started) / 1000).toFixed(1)}s · ${r.receipt}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: r.text, receipt: r.receipt, stage: r.stage }));
      } catch (e) {
        // NEVER block a post on our failure: the extension falls back to
        // sending the draft as typed when this errors.
        log(`voice failed: ${e.message?.slice(0, 160)}`);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  console.error(`openzoo voice serve: http://127.0.0.1:${port}/voice (loopback only)`);
  console.error('  load the extension from the openzoo checkout: extension/  (chrome://extensions → Load unpacked)');
  console.error('  then post on x.com as usual — drafts are revised before they publish');
  await new Promise(() => {});
}
