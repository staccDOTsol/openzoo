#!/usr/bin/env node
// Tiny front on :8080 for the OpenZoo box.
//
// code-server owns the IDE but only exposes /healthz. Existing waitBoxHttp
// probes GET /health on the RunPod public port (8080). This process:
//   GET /health  → 200 only when upstream /healthz is alive
//   everything else, including WebSocket upgrades → code-server
//
// Bind this to 0.0.0.0:8080 and code-server to 127.0.0.1:8081.

import http from 'node:http';
import net from 'node:net';

const bind = process.env.BOX_FRONT_BIND || '0.0.0.0';
const port = Number(process.env.BOX_FRONT_PORT || 8080);
const [upHost, upPort] = String(process.env.BOX_UPSTREAM || '127.0.0.1:8081').split(':');
const upstream = { host: upHost || '127.0.0.1', port: Number(upPort || 8081) };

function pathOf(url) {
  return String(url || '/').split('?')[0];
}

function probeHealthz() {
  return new Promise((resolve) => {
    const req = http.request({
      host: upstream.host,
      port: upstream.port,
      path: '/healthz',
      method: 'GET',
      timeout: 2000,
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function proxyHttp(req, res) {
  const headers = { ...req.headers };
  const p = http.request({
    host: upstream.host,
    port: upstream.port,
    path: req.url,
    method: req.method,
    headers,
  }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  p.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('bad gateway\n');
  });
  req.pipe(p);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && pathOf(req.url) === '/health') {
    const ok = await probeHealthz();
    res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.end(ok ? 'ok\n' : 'not ready\n');
    return;
  }
  proxyHttp(req, res);
});

server.on('upgrade', (req, socket, head) => {
  const dest = net.connect(upstream.port, upstream.host, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null) continue;
      lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    }
    dest.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) dest.write(head);
    dest.pipe(socket);
    socket.pipe(dest);
  });
  dest.on('error', () => socket.destroy());
  socket.on('error', () => dest.destroy());
});

server.listen(port, bind, () => {
  console.log(`[box-front] :${port} → ${upstream.host}:${upstream.port} (/health → upstream /healthz)`);
});
