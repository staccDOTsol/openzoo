import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { looksGzip, knownCodec, inflateEncoded, relay } from '../lib/relay.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(String(err?.stack || err));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    try { server.closeAllConnections?.(); } catch { /* already */ }
    server.close(() => resolve());
    setTimeout(resolve, 400).unref?.();
  });
}

/** Raw HTTP so the test client cannot hide a leftover Content-Encoding. */
function rawGet(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    }).on('error', reject);
  });
}

async function viaRelay(upstream) {
  const server = await listen((_req, res) => relay(res, upstream));
  try {
    return await rawGet(server.address().port);
  } finally {
    await closeServer(server);
  }
}

/** Fetch-Response-shaped, but the body is the raw bytes (no undici inflate). */
function mockUpstream(status, headers, buf) {
  const body = buf && buf.length
    ? Readable.toWeb(Readable.from([Buffer.from(buf)]))
    : null;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    body,
  };
}

function gzipResponse(status, json, extraHeaders = {}) {
  const plain = Buffer.from(typeof json === 'string' ? json : JSON.stringify(json));
  const gz = gzipSync(plain);
  return {
    plain,
    gz,
    upstream: mockUpstream(status, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': String(gz.length),
      ...extraHeaders,
    }, gz),
  };
}

describe('relay() encoding', () => {
  test('proxy.js relays through lib/relay.js and no longer strips encoding blindly', () => {
    const proxy = readFileSync(path.join(root, 'lib/proxy.js'), 'utf8');
    assert.match(proxy, /import \{ relay \} from '\.\/relay\.js'/);
    assert.doesNotMatch(proxy, /content-encoding', 'content-length'\]\.includes\(k\)/);
    const src = readFileSync(path.join(root, 'lib/relay.js'), 'utf8');
    assert.match(src, /never emit a compressed body without Content-Encoding/i);
    assert.match(src, /decoded && key === 'content-encoding'/);
  });

  test('looksGzip / knownCodec', () => {
    assert.equal(looksGzip(gzipSync(Buffer.from('x'))), true);
    assert.equal(looksGzip(Buffer.from('{"e":1}')), false);
    assert.equal(knownCodec('gzip'), 'gzip');
    assert.equal(knownCodec('x-gzip'), 'gzip');
    assert.equal(knownCodec('br'), 'br');
    assert.equal(knownCodec('deflate'), 'deflate');
    assert.equal(knownCodec('identity'), null);
    assert.equal(knownCodec('zstd'), null);
    assert.equal(knownCodec('gzip, br'), null);
  });

  test('inflateEncoded gunzips a Fly-shaped 400', async () => {
    const json = '{"error":{"message":"bad openrouter price"}}';
    const out = await inflateEncoded(gzipSync(Buffer.from(json)), 'gzip');
    assert.equal(out.toString('utf8'), json);
  });

  test('gzip 400 is forwarded uncompressed without Content-Encoding', async () => {
    const json = '{"error":{"message":"invalid skill","type":"invalid_request_error"}}';
    const { gz, upstream } = gzipResponse(400, json);
    assert.equal(looksGzip(gz), true);
    assert.equal(upstream.headers.get('content-encoding'), 'gzip');

    const got = await viaRelay(upstream);
    assert.equal(got.status, 400);
    assert.equal(got.headers['content-encoding'], undefined);
    assert.equal(looksGzip(got.body), false);
    assert.equal(got.body[0], 0x7b);
    assert.equal(got.body.toString('utf8'), json);
    assert.match(got.headers['content-type'] || '', /json/i);
    JSON.parse(got.body.toString('utf8'));
  });

  test('gzip 400 with encoding already stripped is still inflated', async () => {
    const json = '{"error":{"message":"fly 400"}}';
    const gz = gzipSync(Buffer.from(json));
    const upstream = mockUpstream(400, { 'content-type': 'application/json' }, gz);
    const got = await viaRelay(upstream);
    assert.equal(got.status, 400);
    assert.equal(got.headers['content-encoding'], undefined);
    assert.equal(looksGzip(got.body), false);
    assert.equal(got.body.toString('utf8'), json);
  });

  test('leftover Content-Encoding on already-plain JSON 400 is stripped', async () => {
    const json = '{"error":{"message":"already inflated"}}';
    const upstream = mockUpstream(400, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    }, Buffer.from(json));
    const got = await viaRelay(upstream);
    assert.equal(got.status, 400);
    assert.equal(got.headers['content-encoding'], undefined);
    assert.equal(got.body.toString('utf8'), json);
  });

  test('corrupt gzip 400 becomes readable JSON, not binary', async () => {
    const upstream = mockUpstream(400, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    }, Buffer.from([0x1f, 0x8b, 0x00, 0xff, 0xfe]));
    const got = await viaRelay(upstream);
    assert.equal(got.status, 400);
    assert.equal(got.headers['content-encoding'], undefined);
    assert.equal(looksGzip(got.body), false);
    const parsed = JSON.parse(got.body.toString('utf8'));
    assert.match(parsed.error.message, /upstream HTTP 400/);
  });

  test('plain JSON 400 is unchanged', async () => {
    const json = '{"error":{"message":"openzoo jsonErr"}}';
    const upstream = mockUpstream(400, { 'content-type': 'application/json' }, Buffer.from(json));
    const got = await viaRelay(upstream);
    assert.equal(got.status, 400);
    assert.equal(got.body.toString('utf8'), json);
    assert.equal(got.headers['content-encoding'], undefined);
  });

  test('brotli 400 is inflated', async () => {
    const json = '{"error":{"message":"br"}}';
    const br = brotliCompressSync(Buffer.from(json));
    const upstream = mockUpstream(400, {
      'content-type': 'application/json',
      'content-encoding': 'br',
    }, br);
    const got = await viaRelay(upstream);
    assert.equal(got.status, 400);
    assert.equal(got.headers['content-encoding'], undefined);
    assert.equal(got.body.toString('utf8'), json);
  });

  test('unknown encoding keeps Content-Encoding with the bytes', async () => {
    const raw = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01]);
    const upstream = mockUpstream(400, {
      'content-type': 'application/octet-stream',
      'content-encoding': 'zstd',
    }, raw);
    const got = await viaRelay(upstream);
    assert.equal(got.status, 400);
    assert.equal(got.headers['content-encoding'], 'zstd');
    assert.deepEqual(got.body, raw);
  });

  test('uncompressed 200 SSE still pipes and sniffs the x402 comment', async () => {
    const frames = [
      'data: {"ok":true}\n\n',
      ': x402 {"billedUsd":0.01}\n',
      'data: [DONE]\n\n',
    ].join('');
    const upstream = mockUpstream(200, { 'content-type': 'text/event-stream' }, Buffer.from(frames));
    const receipts = [];
    const server = await listen((_req, res) => relay(res, upstream, (x) => receipts.push(x)));
    try {
      const got = await rawGet(server.address().port);
      assert.equal(got.status, 200);
      assert.equal(got.headers['content-encoding'], undefined);
      assert.match(got.body.toString('utf8'), /data: \{"ok":true\}/);
      assert.deepEqual(receipts, [{ billedUsd: 0.01 }]);
    } finally {
      await closeServer(server);
    }
  });

  test('gzip 200 is inflated and Content-Encoding is stripped', async () => {
    const json = '{"id":"ok","object":"chat.completion"}';
    const { upstream } = gzipResponse(200, json);
    const got = await viaRelay(upstream);
    assert.equal(got.status, 200);
    assert.equal(got.headers['content-encoding'], undefined);
    assert.equal(looksGzip(got.body), false);
    assert.equal(got.body.toString('utf8'), json);
  });
});
