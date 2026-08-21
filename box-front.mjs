#!/usr/bin/env node
// Tiny 8080 front door for the OpenZoo box.
//
// Product: mobile-first Cline Agent. waitBoxHttp hits GET /health. code-server
// stays password-gated on loopback; this process answers /health, serves
// /__oz/mobile.*, optionally wraps phones in a full-bleed iframe shell, and
// injects viewport + CSS into code-server HTML so the workbench cannot pan.
import http from 'node:http';
import net from 'node:net';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const listenHost = process.env.OZ_BOX_FRONT_BIND || '0.0.0.0';
const listenPort = Number(process.env.OZ_BOX_FRONT_PORT || 8080);
const upstreamHost = process.env.OZ_CODE_SERVER_HOST || '127.0.0.1';
const upstreamPort = Number(process.env.OZ_CODE_SERVER_PORT || 8081);
const readyUrl = process.env.OZ_CODE_SERVER_READY_URL
  || `http://${upstreamHost}:${upstreamPort}/healthz`;
const ASSET_DIR = process.env.OZ_MOBILE_DIR || '/opt/code-server';
export const VIEWPORT = 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content';
const INJECT_MARK = 'data-oz-mobile="1"';

export function isHealth(req) {
  const path = String(req.url || '/').split('?')[0];
  return req.method === 'GET' && (path === '/health' || path === '/healthz');
}

export function requestPath(req) {
  return String(req.url || '/').split('?')[0];
}

export function requestQuery(req) {
  const q = String(req.url || '').split('?')[1] || '';
  return new URLSearchParams(q);
}

export function isMobileUA(ua) {
  return /Android|iPhone|iPad|iPod|webOS|Mobile|Silk|IEMobile|Opera Mini/i.test(String(ua || ''));
}

export function wantsMobileShell(req) {
  if (req.method !== 'GET') return false;
  const path = requestPath(req);
  if (path !== '/' && path !== '/index.html') return false;
  if (requestQuery(req).get('oz-workbench') === '1') return false;
  return isMobileUA(req.headers && req.headers['user-agent']);
}

export function mobileShellHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="${VIEWPORT}">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <title>OpenZoo</title>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; height: 100dvh; overflow: hidden; background: #1e1e1e; }
    iframe { border: 0; width: 100%; height: 100%; height: 100dvh; display: block; }
  </style>
</head>
<body>
  <iframe src="/?oz-workbench=1" title="Cline" allow="clipboard-read; clipboard-write"></iframe>
</body>
</html>
`;
}

export function injectMobileHtml(html) {
  if (!html || html.includes(INJECT_MARK)) return html;
  const tags = [
    `<meta name="viewport" content="${VIEWPORT}" ${INJECT_MARK}>`,
    `<link rel="stylesheet" href="/__oz/mobile.css" ${INJECT_MARK}>`,
    `<script src="/__oz/mobile.js" defer ${INJECT_MARK}></script>`,
  ].join('\n');
  let out = html.replace(/<meta[^>]*name=["']viewport["'][^>]*>/i, '');
  if (/<head[^>]*>/i.test(out)) return out.replace(/<head[^>]*>/i, (m) => `${m}\n${tags}`);
  if (/<html[^>]*>/i.test(out)) return out.replace(/<html[^>]*>/i, (m) => `${m}\n${tags}`);
  return `${tags}\n${out}`;
}

function readAsset(name, fallbackType) {
  const candidates = [
    join(ASSET_DIR, name),
    join(ASSET_DIR, `box-${name}`),
    join(process.cwd(), name),
    join(process.cwd(), `box-${name}`),
  ];
  const here = candidates.find((p) => existsSync(p));
  if (!here) return null;
  return { body: readFileSync(here), type: fallbackType };
}

function serveAsset(res, name, type) {
  const asset = readAsset(name, type);
  if (!asset) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('missing mobile asset\n');
    return;
  }
  res.writeHead(200, {
    'content-type': asset.type,
    'cache-control': 'no-store',
    'content-length': asset.body.length,
  });
  res.end(asset.body);
}

async function codeServerReady() {
  try {
    const r = await fetch(readyUrl, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function writeHealth(res) {
  const ok = await codeServerReady();
  const body = JSON.stringify({
    ok,
    service: 'code-server',
    product: 'cline-mobile',
    upstream: `${upstreamHost}:${upstreamPort}`,
  }) + '\n';
  res.writeHead(ok ? 200 : 503, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function proxyHeaders(req) {
  const headers = { ...req.headers };
  headers.host = `${upstreamHost}:${upstreamPort}`;
  headers['x-forwarded-host'] = req.headers.host || headers.host;
  headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || 'https';
  headers['accept-encoding'] = 'identity';
  return headers;
}

function isHtmlHeaders(headers) {
  return /text\/html/i.test(String(headers['content-type'] || ''));
}

function proxyHttp(req, res) {
  const preq = http.request({
    hostname: upstreamHost,
    port: upstreamPort,
    path: req.url,
    method: req.method,
    headers: proxyHeaders(req),
  }, (pres) => {
    if (req.method !== 'GET' || !isHtmlHeaders(pres.headers)) {
      res.writeHead(pres.statusCode || 502, pres.headers);
      pres.pipe(res);
      return;
    }
    const chunks = [];
    pres.on('data', (c) => chunks.push(c));
    pres.on('end', () => {
      const html = injectMobileHtml(Buffer.concat(chunks).toString('utf8'));
      const out = Buffer.from(html, 'utf8');
      const headers = { ...pres.headers };
      delete headers['content-length'];
      delete headers['content-encoding'];
      headers['content-length'] = String(out.length);
      res.writeHead(pres.statusCode || 200, headers);
      res.end(out);
    });
  });
  preq.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('upstream code-server unavailable\n');
  });
  req.pipe(preq);
}

function proxyUpgrade(req, socket, head) {
  const dest = net.connect(upstreamPort, upstreamHost, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    const headers = proxyHeaders(req);
    for (const [k, v] of Object.entries(headers)) {
      if (v == null) continue;
      if (Array.isArray(v)) {
        for (const item of v) lines.push(`${k}: ${item}`);
      } else {
        lines.push(`${k}: ${v}`);
      }
    }
    dest.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head && head.length) dest.write(head);
    dest.pipe(socket);
    socket.pipe(dest);
  });
  dest.on('error', () => socket.destroy());
  socket.on('error', () => dest.destroy());
}

function handle(req, res) {
  const path = requestPath(req);
  if (isHealth(req)) {
    writeHealth(res);
    return;
  }
  if (req.method === 'GET' && path === '/__oz/mobile.css') {
    serveAsset(res, 'mobile.css', 'text/css; charset=utf-8');
    return;
  }
  if (req.method === 'GET' && path === '/__oz/mobile.js') {
    serveAsset(res, 'mobile.js', 'text/javascript; charset=utf-8');
    return;
  }
  if (wantsMobileShell(req)) {
    const body = mobileShellHtml();
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }
  proxyHttp(req, res);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = http.createServer(handle);
  server.on('upgrade', proxyUpgrade);
  server.listen(listenPort, listenHost, () => {
    process.stdout.write(`[box-front] :${listenPort} → ${upstreamHost}:${upstreamPort} (GET /health, mobile Cline)\n`);
  });
}

export { handle, proxyUpgrade };
