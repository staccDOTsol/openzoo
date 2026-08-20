/**
 * Pipe an upstream fetch Response to the client.
 *
 * Fly (and other CDNs) gzip error bodies. Node fetch does not always inflate
 * those — MEASURED: a 400 from x402-tokens.fly.dev arrived still gzip-wrapped
 * with `Content-Encoding: gzip`. The old relay stripped that header and
 * `Content-Length`, then piped `response.body` RAW. Claude Code printed
 * `API Error: 400` plus diamond/binary mojibake.
 *
 * Contract: never emit a compressed body without Content-Encoding. Prefer
 * decompressing so the client sees application/json or text (Claude CLI can
 * parse the error). Unknown encodings keep the header and the bytes together.
 */
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { Readable, PassThrough } from 'node:stream';

const gunzipAsync = promisify(zlib.gunzip);
const inflateAsync = promisify(zlib.inflate);
const inflateRawAsync = promisify(zlib.inflateRaw);
const brotliAsync = promisify(zlib.brotliDecompress);

const HOP = new Set(['transfer-encoding', 'connection', 'content-length']);

export function looksGzip(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

function headerEncoding(headers) {
  return String(headers?.get?.('content-encoding') || '').trim();
}

/** Single known codec, or null if identity / absent / unknown / stacked. */
export function knownCodec(encoding) {
  const parts = String(encoding || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s !== 'identity');
  if (parts.length !== 1) return null;
  if (parts[0] === 'gzip' || parts[0] === 'x-gzip') return 'gzip';
  if (parts[0] === 'deflate') return 'deflate';
  if (parts[0] === 'br') return 'br';
  return null;
}

export async function inflateEncoded(buf, encoding) {
  const codec = knownCodec(encoding) || (looksGzip(buf) ? 'gzip' : null);
  if (!codec) return buf;
  // Leftover Content-Encoding after fetch already inflated: do not gunzip JSON.
  if (codec === 'gzip' && !looksGzip(buf)) return buf;
  try {
    if (codec === 'gzip') return await gunzipAsync(buf);
    if (codec === 'br') return await brotliAsync(buf);
    try {
      return await inflateAsync(buf);
    } catch {
      return await inflateRawAsync(buf);
    }
  } catch (err) {
    if (!looksBinary(buf)) return buf;
    throw err;
  }
}

function looksBinary(buf) {
  if (!buf || !buf.length) return false;
  if (looksGzip(buf)) return true;
  const n = Math.min(buf.length, 256);
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0 || c < 8 || (c > 13 && c < 32)) ctrl += 1;
  }
  return ctrl >= 4;
}

function copyHeaders(upstream, { decoded }) {
  const headers = {};
  upstream.headers.forEach((v, k) => {
    const key = String(k).toLowerCase();
    if (HOP.has(key)) return;
    // Drop Content-Encoding only when the bytes we send are already inflated.
    if (decoded && key === 'content-encoding') return;
    headers[k] = v;
  });
  return headers;
}

function preferReadableType(headers, buf) {
  const ct = String(headers['content-type'] || '');
  if (ct && !/octet-stream|(?:x-)?gzip|br\b/i.test(ct)) return;
  const c = buf[0];
  headers['content-type'] = (c === 0x7b || c === 0x5b)
    ? 'application/json; charset=utf-8'
    : 'text/plain; charset=utf-8';
}

function jsonUpstreamErr(res, status) {
  res.writeHead(status || 502, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `upstream HTTP ${status || 502}` } }));
}

async function readBody(upstream) {
  if (!upstream.body) return Buffer.alloc(0);
  const chunks = [];
  for await (const c of Readable.fromWeb(upstream.body)) chunks.push(c);
  return Buffer.concat(chunks);
}

/**
 * Non-OK: buffer, inflate gzip/br/deflate (or gzip-magic with no header),
 * send uncompressed JSON/text. Never forward gzip bytes with the encoding
 * header stripped. Un-decodable compressed bodies become a short JSON error
 * so Claude / grokui do not paint diamond mojibake — the canvas fold to
 * `upstream HTTP 400` lives in #65; we just refuse to emit the binary.
 */
async function relayError(res, upstream) {
  const encoding = headerEncoding(upstream.headers);
  const codec = knownCodec(encoding);
  let buf;
  try {
    buf = await readBody(upstream);
  } catch {
    jsonUpstreamErr(res, upstream.status);
    return;
  }

  if (codec || looksGzip(buf)) {
    try {
      buf = await inflateEncoded(buf, encoding);
    } catch {
      jsonUpstreamErr(res, upstream.status);
      return;
    }
    if (looksBinary(buf)) {
      jsonUpstreamErr(res, upstream.status);
      return;
    }
    const headers = copyHeaders(upstream, { decoded: true });
    preferReadableType(headers, buf);
    res.writeHead(upstream.status, headers);
    res.end(buf);
    return;
  }

  if (encoding && !codec) {
    // Unknown / stacked coding: keep the label with the bytes.
    res.writeHead(upstream.status, copyHeaders(upstream, { decoded: false }));
    res.end(buf);
    return;
  }

  if (looksBinary(buf)) {
    jsonUpstreamErr(res, upstream.status);
    return;
  }
  const headers = copyHeaders(upstream, { decoded: true });
  preferReadableType(headers, buf);
  res.writeHead(upstream.status, headers);
  res.end(buf);
}

function createDecoder(codec) {
  if (codec === 'gzip') return zlib.createGunzip();
  if (codec === 'deflate') return zlib.createInflate();
  if (codec === 'br') return zlib.createBrotliDecompress();
  return null;
}

function prependChunk(chunk, rest) {
  const out = new PassThrough();
  out.write(chunk);
  rest.pipe(out);
  return out;
}

function attachBody(res, body, onReceipt, sse, resolve) {
  body.on('error', () => res.destroy());
  res.on('close', () => body.destroy());
  if (!sse || typeof onReceipt !== 'function') {
    body.pipe(res);
    body.on('end', resolve);
    return;
  }
  let pending = '';
  body.on('data', (c) => {
    res.write(c);
    pending += c.toString('utf8');
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith(': x402 ')) continue;
      try { onReceipt(JSON.parse(line.slice(7))); } catch { /* not our frame */ }
    }
  });
  body.on('end', () => { res.end(); resolve(); });
}

/**
 * 2xx stream. Uncompressed (the cheap Fly 200) is the old pipe. Encoded
 * bodies are inflated when we know the codec, otherwise the encoding
 * header stays with the bytes.
 */
function relayOk(res, upstream, onReceipt) {
  const encoding = headerEncoding(upstream.headers);
  const codec = knownCodec(encoding);
  const sse = (upstream.headers.get('content-type') || '').includes('text/event-stream');

  return new Promise((resolve) => {
    const raw = Readable.fromWeb(upstream.body);
    raw.on('error', () => res.destroy());
    res.on('close', () => raw.destroy());

    if (!encoding) {
      res.writeHead(upstream.status, copyHeaders(upstream, { decoded: true }));
      attachBody(res, raw, onReceipt, sse, resolve);
      return;
    }

    // Peek so a leftover Content-Encoding on already-plain bytes is stripped,
    // and a real gzip body is never sent naked.
    let decided = false;
    raw.once('data', (chunk) => {
      if (decided) return;
      decided = true;
      const head = Buffer.from(chunk);
      const gzip = looksGzip(head);
      if (gzip || (codec && codec !== 'gzip')) {
        const dec = codec ? createDecoder(codec) : zlib.createGunzip();
        if (!dec) {
          res.writeHead(upstream.status, copyHeaders(upstream, { decoded: false }));
          attachBody(res, prependChunk(head, raw), onReceipt, sse, resolve);
          return;
        }
        dec.write(head);
        raw.pipe(dec);
        res.writeHead(upstream.status, copyHeaders(upstream, { decoded: true }));
        attachBody(res, dec, onReceipt, sse, resolve);
        return;
      }
      // Header leftover on plain JSON/SSE — drop encoding, replay the peek.
      res.writeHead(upstream.status, copyHeaders(upstream, { decoded: true }));
      attachBody(res, prependChunk(head, raw), onReceipt, sse, resolve);
    });
    raw.once('end', () => {
      if (decided) return;
      decided = true;
      res.writeHead(upstream.status, copyHeaders(upstream, { decoded: true }));
      res.end();
      resolve();
    });
  });
}

/** Pipe an upstream fetch Response to the client, unbuffered (SSE-safe).
 *
 *  `onReceipt` is called with the gateway's x402 block when it arrives. On a
 *  STREAMED call there is no JSON body to carry that block, so the gateway
 *  emits it as an SSE COMMENT (`: x402 {...}`) after the last frame —
 *  comments are discarded by every compliant client, so nothing downstream
 *  sees it, but without reading it here every spend and savings figure on
 *  the status line would silently read zero the moment real streaming was
 *  switched on.
 *
 *  Sniffing NEVER delays a byte: each chunk is written to the client first
 *  and only then scanned. */
export function relay(res, upstream, onReceipt) {
  if (!upstream.body) {
    res.writeHead(upstream.status, copyHeaders(upstream, { decoded: true }));
    res.end();
    return Promise.resolve();
  }
  if (!upstream.ok) return relayError(res, upstream);
  return relayOk(res, upstream, onReceipt);
}
