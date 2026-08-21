#!/usr/bin/env node
// Public :8080 door in front of code-server.
//
// code-server itself has /healthz (no auth) but waitBoxHttp curls /health.
// This process binds 0.0.0.0:8080, 200s /health when the editor is up, and
// reverse-proxies everything else — including websockets — to code-server
// (password auth). It is not an open door: /health is liveness only.

import http from 'node:http';
import net from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
]);

export function parseUpstream(spec = '127.0.0.1:8081') {
  const s = String(spec || '').trim() || '127.0.0.1:8081';
  const i = s.lastIndexOf(':');
  if (i <= 0) return { host: s, port: 8081 };
  return { host: s.slice(0, i), port: Number(s.slice(i + 1)) || 8081 };
}

export function isHealthPath(url = '/') {
  const path = String(url).split('?')[0];
  return path === '/health' || path === '/health/' || path === '/healthz' || path === '/healthz/';
}

export function probeUpstream(upstream, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: upstream.host, port: upstream.port });
    const done = (ok) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    const t = setTimeout(() => done(false), timeoutMs);
    sock.once('connect', () => { clearTimeout(t); done(true); });
    sock.once('error', () => { clearTimeout(t); done(false); });
  });
}

function copyHeaders(src) {
  const out = {};
  for (const [k, v] of Object.entries(src || {})) {
    if (v == null || HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function proxyRequest(req, res, upstream) {
  const headers = copyHeaders(req.headers);
  if (!headers['x-forwarded-for']) headers['x-forwarded-for'] = req.socket.remoteAddress || '';
  if (!headers['x-forwarded-proto']) headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || 'http';
  const p = http.request({
    host: upstream.host,
    port: upstream.port,
    path: req.url,
    method: req.method,
    headers,
  }, (pr) => {
    res.writeHead(pr.statusCode || 502, pr.headers);
    pr.pipe(res);
  });
  p.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('upstream down\n');
  });
  req.pipe(p);
}

function proxyUpgrade(req, socket, head, upstream) {
  const p = net.connect(upstream.port, upstream.host, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null) continue;
      lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    }
    p.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head && head.length) p.write(head);
    p.pipe(socket);
    socket.pipe(p);
  });
  p.on('error', () => socket.destroy());
  socket.on('error', () => p.destroy());
}

export function createBoxDoor({ upstream = { host: '127.0.0.1', port: 8081 } } = {}) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && isHealthPath(req.url)) {
      const up = await probeUpstream(upstream);
      if (!up) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('code-server down\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok\n');
      return;
    }
    proxyRequest(req, res, upstream);
  });
  server.on('upgrade', (req, socket, head) => proxyUpgrade(req, socket, head, upstream));
  return server;
}

export function listenBoxDoor({
  bind = process.env.OZ_DOOR_BIND || '0.0.0.0',
  port = Number(process.env.OZ_DOOR_PORT || 8080),
  upstream = parseUpstream(process.env.OZ_CODE_SERVER_UPSTREAM || '127.0.0.1:8081'),
} = {}) {
  const server = createBoxDoor({ upstream });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => resolve(server));
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  listenBoxDoor().then((server) => {
    const addr = server.address();
    console.log(`[box-8080-door] ${addr.address}:${addr.port} → ${process.env.OZ_CODE_SERVER_UPSTREAM || '127.0.0.1:8081'}`);
  }).catch((err) => {
    console.error(`[box-8080-door] ${err.message}`);
    process.exit(1);
  });
}
