/**
 * Impersonate api2.cursor.sh so a PLAN-LESS editor still routes to the zoo.
 *
 * THE PROBLEM THIS SOLVES. The editor decides client-side whether a model may be
 * used, from an answer its own backend gives. On an entitled account the custom
 * OpenAI endpoint works (measured: real Solana settlements). On a free account the
 * editor refuses before a request exists — "NOT ROUTING, 0 requests" — and nothing
 * we write to its database reaches that decision. The only way to change the
 * decision is to be the thing that answers it.
 *
 * WHY NO CERT INSTALL. Impersonating an HTTPS host normally needs a CA the editor
 * trusts, and no real user installs one — the correct objection that killed the
 * mkcert approach. But WE spawn the editor binary, so we pass Chromium's
 * `--ignore-certificate-errors`, and a plain self-signed cert is accepted with
 * zero prompts and zero trust-store changes. Verified from the bundle that the
 * editor does NOT pin certs (no certificatePinning / pinnedPublicKey /
 * checkServerIdentity), so the flag is honoured.
 *
 * WHAT WE ANSWER. Only `AvailableModels` needs a real body — the catalog, with
 * every gate (supports_max_mode, etc.) set true so nothing is refused. Every other
 * startup call (GetServerConfig, CheckUsage, GetTeams, GetUserPrivacyMode, …) gets
 * an EMPTY protobuf message, which decodes as all-defaults and is valid for ANY
 * message type — so we do not need each method's schema, only the one that matters.
 *
 * WIRE FORMAT. The editor uses Connect-RPC and gRPC-web. We detect the request's
 * content-type and answer in kind: bare message for connect unary proto, enveloped
 * + trailers for grpc-web. Both are handled below.
 */
import http2 from 'node:http2';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { encodeAvailableModels, encodeForMethod } from './cursorapi.js';

const TLS_DIR = path.join(os.homedir(), '.openzoo', 'cursor-tls');
const CURSOR_HOSTS = ['api2.cursor.sh', 'api3.cursor.sh', 'api4.cursor.sh', 'repo42.cursor.sh'];
// THE CERT MUST COVER ANTHROPIC TOO. This server impersonates api.anthropic.com
// for `claude --desktop`, but the SAN only ever listed the cursor hosts, so the
// client got a cert valid for a name it never asked for and killed the
// handshake before ALPN — logged as `HANDSHAKE FAILED ECONNRESET alpn=?`, with
// no request ever reaching us. Same cert, one more pair of names.
const ANTHROPIC_TLS_HOSTS = ['api.anthropic.com', 'api-staging.anthropic.com'];
const TLS_HOSTS = [...CURSOR_HOSTS, ...ANTHROPIC_TLS_HOSTS];

/** Generate (once) a self-signed cert covering every host we impersonate. openssl
 *  is on every mac/linux; this is the only external tool and it is not a trust op. */
export function ensureCert(log = () => {}) {
  const cert = path.join(TLS_DIR, 'cert.pem');
  const key = path.join(TLS_DIR, 'key.pem');
  // STALE-CERT INVALIDATION. A plain existence check meant anyone who had ever
  // run an older build kept their cursor-only cert forever and never got the
  // anthropic names — the fix would ship and appear to do nothing. Record the
  // SAN set the cert was minted for and re-mint whenever that set changes.
  const stamp = path.join(TLS_DIR, 'san.txt');
  const want = TLS_HOSTS.join(',');
  try {
    fs.accessSync(cert); fs.accessSync(key);
    if (fs.readFileSync(stamp, 'utf8').trim() === want) return { cert, key };
    log('cursor-tls: cert predates the current host list — re-minting');
  } catch { /* make it */ }
  fs.mkdirSync(TLS_DIR, { recursive: true });
  const san = `subjectAltName=${TLS_HOSTS.map((h) => `DNS:${h}`).join(',')}`;
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '3650',
    '-subj', '/CN=api2.cursor.sh', '-addext', san,
  ], { stdio: 'ignore' });
  fs.writeFileSync(stamp, want);
  log(`cursor-tls: self-signed cert minted at ${TLS_DIR} covering ${TLS_HOSTS.length} hosts (no CA, no trust prompt)`);
  return { cert, key };
}

/** Read the whole request body. */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

/** grpc-web trailers frame: an enveloped block of "grpc-status:0\r\n". */
function grpcWebTrailer() {
  const t = Buffer.from('grpc-status:0\r\ngrpc-message:\r\n', 'utf8');
  const head = Buffer.alloc(5);
  head.writeUInt8(0x80, 0);                 // trailer flag
  head.writeUInt32BE(t.length, 1);
  return Buffer.concat([head, t]);
}

/** Envelope a message for grpc-web / connect-streaming (5-byte prefix). */
function envelope(payload) {
  const head = Buffer.alloc(5);
  head.writeUInt8(0, 0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

/** CORS headers — the editor's renderer is a browser; without these the
 *  preflight fails and the REAL request (e.g. full_stripe_profile) never fires. */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS,PUT,DELETE',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': '*',
  'access-control-allow-credentials': 'true',
};

/**
 * An ENTITLED stripe profile. `#4 OPTIONS /auth/full_stripe_profile` in the log
 * is THE plan gate — this is what tells the editor whether it may use models.
 * Empty (my first stub) reads as free, hence "upgrade". These fields report an
 * active, unlimited membership so nothing is gated.
 */
function stripeProfile() {
  // MUST MATCH the membershipType written into the applicationUser blob — Cursor
  // refreshes the blob FROM this profile on launch, so a hardcoded 'pro' here
  // overwrote our 'ultra' and the free-plan gate ("free plans can only use Auto")
  // fired anyway. Same env var, one source of truth.
  const m = process.env.OPENZOO_MEMBERSHIP || 'pro';
  return JSON.stringify({
    membershipType: m,
    individualMembershipType: m,
    teamMembershipType: null,
    subscriptionStatus: 'active',
    verifiedStudent: false,
    trialEligible: false,
    daysRemainingOnTrial: 0,
    isOnStudentPlan: false,
    hardLimit: null,
    hardLimitPerUser: null,
    usageBasedPricingEnabled: true,
    monthlyUsageBasedLimit: 1000000,
  });
}

/**
 * Pull the user's prompt out of a StreamUnifiedChatRequest without the full
 * schema: walk the protobuf, collect plausible UTF-8 string fields, take the
 * longest natural-language one (the new user turn). The captured .bin refines it.
 */
function extractPromptText(buf) {
  const strings = [];
  const walk = (b, depth) => {
    let i = 0;
    while (i < b.length) {
      let key = 0, shift = 0, byte;
      do { if (i >= b.length) return; byte = b[i++]; key |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
      const wire = key & 7;
      if (wire === 2) {
        let len = 0; shift = 0;
        do { if (i >= b.length) return; byte = b[i++]; len |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
        const sub = b.subarray(i, i + len); i += len;
        const txt = sub.toString('utf8');
        if (len > 1 && /[a-zA-Z]/.test(txt) && !/[\x00-\x08\x0e-\x1f]/.test(txt)) strings.push(txt);
        else if (depth < 6) walk(sub, depth + 1);
      } else if (wire === 0) { while (i < b.length && (b[i++] & 0x80)) { /* skip */ } }
      else if (wire === 5) { i += 4; } else if (wire === 1) { i += 8; } else { return; }
    }
  };
  try { walk(buf, 0); } catch { /* best effort */ }
  const cand = strings.filter((x) => /\s/.test(x.trim()) || x.length > 12);
  return ((cand.length ? cand : strings).sort((a, b) => b.length - a.length)[0] || '').trim();
}

/** StreamUnifiedChatResponse{1: text}. */
function encodeChatResponse(text) {
  const t = Buffer.from(text, 'utf8');
  const head = [0x0a];
  let n = t.length; do { let x = n & 0x7f; n = Math.floor(n / 128); if (n) x |= 0x80; head.push(x); } while (n);
  return Buffer.concat([Buffer.from(head), t]);
}

/**
 * ROUTE AUTO THROUGH THE ZOO. Cursor's chat inference is ChatService/
 * StreamUnifiedChat to the agent host (now impersonated). Parse the prompt, pay
 * the zoo via the local proxy, stream the answer back as StreamUnifiedChatResponse
 * frames. Legitimate: Auto is free-allowed; we redirect the operator's OWN
 * inference to their OWN paid proxy.
 */
async function handleStreamChat(req, res, body, log) {
  const ct = String(req.headers['content-type'] || '');
  const isGrpcWeb = ct.includes('grpc-web');
  const prompt = extractPromptText(body) || 'hello';
  log(`cursor-backend:      >> StreamUnifiedChat prompt: ${JSON.stringify(prompt.slice(0, 80))}`);
  let text = '';
  try {
    const zoo = await fetch('http://127.0.0.1:8402/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-openzoo' },
      body: JSON.stringify({
        model: process.env.OPENZOO_DEFAULT_MODEL || 'anthropic/claude-opus-5',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: Number(process.env.OPENZOO_ASK_MAX_TOKENS || 2048),
      }),
    });
    const data = await zoo.json();
    text = data.choices?.[0]?.message?.content || '(no content)';
    log(`cursor-backend:      << zoo replied ${text.length} chars (paid x402)`);
  } catch (e) { text = `openzoo error: ${e.message}`; log(`cursor-backend:      zoo call failed: ${e.message}`); }

  res.writeHead(200, {
    'content-type': isGrpcWeb ? 'application/grpc-web+proto' : 'application/connect+proto',
    'grpc-status': '0', ...CORS,
  });
  res.write(envelope(encodeChatResponse(text)));
  if (isGrpcWeb) { res.end(grpcWebTrailer()); }
  else { const end = Buffer.from('{}'); const h = Buffer.alloc(5); h.writeUInt8(0x02, 0); h.writeUInt32BE(end.length, 1); res.end(Buffer.concat([h, end])); }
}

/** Headers that are illegal to copy onto an HTTP/2 response (RFC 7540 §8.1.2.2),
 *  plus the length/encoding fields that no longer describe our re-buffered body. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'upgrade', 'proxy-connection',
  'transfer-encoding', 'te', 'trailer', 'proxy-authenticate',
  'proxy-authorization', 'content-encoding', 'content-length',
]);

/**
 * FORWARD A NON-INFERENCE REQUEST TO THE REAL ANTHROPIC API.
 *
 * We hijack api.anthropic.com at the DNS level, which catches far more than
 * inference: the desktop app is OAuth/subscription-bound and boots by calling
 * /api/organizations, /api/bootstrap, /api/account on the SAME host. Those are
 * not ours to answer — the local proxy 404s them, the app cannot establish a
 * session, and it hangs until macOS offers Force Quit.
 *
 * So for anything that is not inference we act as a plain reverse proxy to the
 * genuine API, preserving the client's auth headers verbatim so the app's own
 * OAuth session keeps working untouched.
 *
 * WE CANNOT RESOLVE THE NAME NORMALLY — /etc/hosts points it at us, so a plain
 * fetch would loop straight back into this server. Resolve against public DNS
 * over UDP (which ignores /etc/hosts entirely), cache it, and dial the address
 * with the Host/SNI still set to the real hostname so TLS and routing succeed.
 */
// KEYED BY HOST. A single shared slot meant whichever of api/api-staging
// resolved first pinned its address for the other one too.
const realIpCache = new Map();
async function resolveRealAnthropic(host) {
  const hit = realIpCache.get(host);
  if (hit) return hit;
  const { Resolver } = await import('node:dns/promises');
  const r = new Resolver();
  r.setServers(['1.1.1.1', '8.8.8.8']);
  const [ip] = await r.resolve4(host);
  realIpCache.set(host, ip);
  return ip;
}

/**
 * Headers we must NOT copy back from the upstream response.
 *
 * DELIBERATELY NARROWER THAN HOP_BY_HOP: `content-encoding` is absent here on
 * purpose. Unlike fetch(), node:https hands us the body EXACTLY as it arrived —
 * still gzip/brotli compressed. Stripping the encoding header while forwarding
 * compressed bytes tells the app "this is plain JSON" over binary garbage, and
 * it fails to parse the bootstrap payload. Forward body and label together.
 * `content-length` still goes, because we set it from the buffer we actually
 * have, and the h2 layer rejects the connection-specific ones outright.
 */
const RESP_DROP = new Set([
  'connection', 'keep-alive', 'upgrade', 'proxy-connection',
  'transfer-encoding', 'te', 'trailer', 'content-length',
]);

async function passthroughToRealAnthropic(req, res, body, host, full, log) {
  try {
    const ip = await resolveRealAnthropic(host);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.startsWith(':') || HOP_BY_HOP.has(k)) continue;
      headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    headers.host = host;

    // DIAL THE ADDRESS, BUT SPEAK THE NAME. fetch(`https://${ip}/...`) cannot do
    // this: undici derives SNI from the URL, so the server saw a bare IP, had no
    // certificate to offer for it, and killed the handshake
    // (ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE). node:https lets the two be set
    // independently — a custom `lookup` pins the connection to the public-DNS
    // address (bypassing our own /etc/hosts entry, which would otherwise loop
    // this request straight back into this very server), while `servername` and
    // the Host header keep presenting the real hostname so the cert validates.
    const lookup = (h, o, cb) => (o && o.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4));
    const { status, respHeaders, buf } = await new Promise((resolve, reject) => {
      const up = https.request({
        hostname: host, servername: host, port: 443, path: full,
        method: req.method, headers, lookup,
      }, (r) => {
        const chunks = [];
        r.on('data', (d) => chunks.push(d));
        r.on('end', () => resolve({
          status: r.statusCode, respHeaders: r.headers, buf: Buffer.concat(chunks),
        }));
        r.on('error', reject);
      });
      up.on('error', reject);
      up.setTimeout(20000, () => up.destroy(new Error('upstream timeout')));
      if (req.method !== 'GET' && req.method !== 'HEAD' && body && body.length) up.write(body);
      up.end();
    });

    const h = {};
    for (const [k, v] of Object.entries(respHeaders)) {
      if (RESP_DROP.has(k.toLowerCase())) continue;
      h[k] = v;
    }
    res.writeHead(status, h);
    res.end(buf);
    log(`cursor-backend:      ${req.method} ${full} -> REAL anthropic (${status}, ${buf.length}b)`);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `passthrough failed: ${e.message}` } }));
    log(`cursor-backend:      passthrough ${full} FAILED: ${e.message}`);
  }
}

/**
 * Answer one Connect/gRPC-web call. `method` is the trailing method name,
 * `models` the catalog to publish. Non-catalog methods get an empty-OK body.
 */
function respond(req, res, method, models) {
  // CORS preflight: answer 204 with the headers, so the real call proceeds.
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  const url = req.url || '';
  const ct = String(req.headers['content-type'] || '');
  const isGrpcWeb = ct.includes('grpc-web');
  const isJson = ct.includes('json') || url.startsWith('/auth/');

  // THE ENTITLEMENT ENDPOINT. /auth/full_stripe_profile (and any /auth/*stripe*)
  // must report an active membership or the editor gates every model.
  if (/full_stripe_profile|stripe|membership|subscription/i.test(url)) {
    res.writeHead(200, { 'content-type': 'application/json', ...CORS });
    res.end(stripeProfile());
    return;
  }

  const bodyProto = encodeForMethod(method, models) || Buffer.alloc(0);

  if (isJson) {
    // Connect unary JSON. AvailableModels as JSON; everything else an empty object.
    const json = method === 'AvailableModels'
      ? JSON.stringify({ modelNames: models.map((m) => m.name), models: models.map((m) => ({
          name: m.name, defaultOn: true, supportsAgent: true, supportsMaxMode: true,
          supportsNonMaxMode: true, supportsThinking: true, supportsImages: true,
          clientDisplayName: m.label ?? m.name, serverModelName: m.name, supportsPlanMode: true,
        })) })
      : '{}';
    res.writeHead(200, { 'content-type': 'application/json', ...CORS });
    res.end(json);
    return;
  }

  if (isGrpcWeb) {
    res.writeHead(200, {
      'content-type': ct.includes('text') ? 'application/grpc-web-text+proto' : 'application/grpc-web+proto',
      'grpc-status': '0', ...CORS,
    });
    res.end(Buffer.concat([envelope(bodyProto), grpcWebTrailer()]));
    return;
  }

  // Connect unary proto: bare message, status in headers.
  res.writeHead(200, { 'content-type': 'application/proto', ...CORS });
  res.end(bodyProto);
}

/**
 * Start the impersonation server. Binds `port` (default 8443 — a privileged
 * 443->port redirect is installed alongside the /etc/hosts entry, so this stays
 * unprivileged). Returns { server, port }.
 */
export function startCursorBackend({ port = 8443, models, log = () => {} } = {}) {
  const { cert, key } = ensureCert(log);
  let conns = 0;
  // SERVE BOTH h2 AND h1. An earlier build forced h1-only after concluding the
  // editor's h2 connections reset — but that log was the STALE 8443 backend the
  // pf redirect was still intercepting, not this server, so the conclusion was
  // contaminated. Measured cleanly now: some editor connections offer ONLY h2
  // (ERR_SSL_NO_APPLICATION_PROTOCOL when we advertise just h1), so we must
  // negotiate both. allowHTTP1 keeps the h1 fetch() calls (stripe/updates)
  // working; ALPN h2 first satisfies the Connect gRPC client.
  const server = http2.createSecureServer(
    {
      cert: fs.readFileSync(cert),
      key: fs.readFileSync(key),
      allowHTTP1: true,
      ALPNProtocols: ['h2', 'http/1.1'],
      SNICallback: (servername, cb) => { log(`cursor-tls: <- ClientHello SNI=${servername}`); cb(null); },
    },
    async (req, res) => {
      conns += 1;
      const full = req.url || '';
      const method = full.split('/').filter(Boolean).pop() || '';
      const ct = req.headers['content-type'] || '?';
      const body = await readBody(req);
      // CLAUDE DESKTOP: api.anthropic.com speaks the JSON Messages API our proxy
      // already handles. If this is an Anthropic host / messages call, forward it
      // verbatim to the local paying proxy and relay the response — reusing the
      // whole translate+x402 path. (SNI is checked because the Host header may be
      // absent on h2.)
      // STRIP THE PORT BEFORE MATCHING. :authority / Host carry `host:port`
      // whenever the client dials a non-default port, so an anchored
      // /anthropic\.com$/ silently failed to match and the request fell through
      // to the gRPC branch, which answered empty-OK. The desktop app then saw a
      // 200 with no body for its session bootstrap — indistinguishable from the
      // 404 it used to get, and it wedged the same way.
      const rawHost = String(req.headers[':authority'] || req.headers.host || req.socket?.servername || '');
      const host = rawHost.replace(/:\d+$/, '');
      const isAnthropic = /(^|\.)anthropic\.com$/.test(host);
      // INTERCEPT INFERENCE ONLY. Matching the whole HOST sent every request the
      // desktop app makes to the local proxy — including the session bootstrap
      // (/api/organizations, /api/bootstrap, /api/account), which the proxy does
      // not implement and answered 404. The app is OAuth/subscription-bound, so
      // a 404 on bootstrap means it can never establish a session: it wedges and
      // macOS offers Force Quit. Only /v1/messages (and /v1/complete) are ours;
      // everything else on this host MUST reach the real Anthropic API.
      const isInference = /\/v1\/(messages|complete)\b/.test(full);
      if (isAnthropic && !isInference) {
        await passthroughToRealAnthropic(req, res, body, host, full, log);
        return;
      }
      if (isAnthropic || isInference) {
        try {
          const up = await fetch(`http://127.0.0.1:8402${full}`, {
            method: req.method,
            headers: { 'content-type': req.headers['content-type'] || 'application/json' },
            body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : body,
          });
          const buf = Buffer.from(await up.arrayBuffer());
          const h = { ...CORS };
          // STRIP EVERY CONNECTION-SPECIFIC HEADER, NOT JUST `connection`.
          // RFC 7540 §8.1.2.2 bans all of these on HTTP/2, and Node enforces it
          // by THROWING ERR_HTTP2_INVALID_CONNECTION_HEADERS out of writeHead.
          // The local proxy answers with `keep-alive`, which sailed past a
          // denylist that only knew about `connection` — so the very first
          // desktop request killed the whole backend process (uncaught, since
          // this is inside the async handler), and every later attempt got
          // ECONNRESET with nothing listening. Content-length goes too: the
          // body was re-buffered, so let Node recompute it. (Shared set above.)
          up.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k.toLowerCase())) h[k] = v; });
          res.writeHead(up.status, h);
          res.end(buf);
          log(`cursor-backend: #${conns} ${req.method} ${full}  ANTHROPIC -> proxy (${up.status}, ${buf.length}b)`);
        } catch (e) {
          res.writeHead(502, { 'content-type': 'application/json', ...CORS });
          res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `openzoo forward failed: ${e.message}` } }));
          log(`cursor-backend: anthropic forward failed: ${e.message}`);
        }
        return;
      }
      log(`cursor-backend: #${conns} ${req.method} ${full}  ct=${ct}  body=${body.length}b`);
      // CAPTURE the chat inference request so its schema can be decoded from
      // REAL bytes (Auto's StreamUnifiedChat). Written once; inspect then build.
      if (/StreamUnifiedChat/.test(full)) {
        await handleStreamChat(req, res, body, log);
        return;
      }
      try {
        respond(req, res, method, models);
        const populated = ['GetPlanInfo', 'GetMe', 'GetDefaultModel', 'IsOnNewPricing'];
        const what = /stripe|membership|subscription/i.test(full) ? 'ENTITLED stripe profile'
          : method === 'AvailableModels' ? `AvailableModels (${models.length} models, gates open)`
          : populated.includes(method) ? `${method} (PRO/entitled)`
          : req.method === 'OPTIONS' ? 'CORS preflight 204'
          : 'empty-ok';
        log(`cursor-backend:      -> ${what}`);
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/proto', 'grpc-status': '0' });
        res.end(Buffer.alloc(0));
        log(`cursor-backend:      -> empty-ok (err ${e.message})`);
      }
    },
  );
  server.on('secureConnection', (sock) => { log(`cursor-tls: connected alpn=${sock.alpnProtocol || 'none'} sni=${sock.servername || '?'}`); });
  // NEVER swallow this — a rejected handshake is exactly the failure to see.
  server.on('tlsClientError', (e, sock) => {
    log(`cursor-tls: HANDSHAKE FAILED ${e.code || e.message} alpn=${sock?.alpnProtocol || '?'}`);
  });
  // BIND BOTH LOOPBACK FAMILIES. lib/hosts.js now pins each host to 127.0.0.1
  // AND ::1 (a v4-only entry let dual-stack clients take the AAAA route straight
  // to the real backend). Listening on v4 alone would turn that bypass into a
  // v6 blackhole — connection refused instead of a wrong answer. Binding the
  // unspecified address '::' with ipv6Only off accepts both on one socket; if
  // the platform refuses (v6 disabled), fall back to v4 so we still work.
  server.on('error', (e) => log(`cursor-backend: server error ${e.code || e.message}`));
  const onUp = (what) => log(`cursor-backend: listening on ${what}:${port} as ${CURSOR_HOSTS[0]}`);
  try {
    server.listen({ port, host: '::', ipv6Only: false }, () => onUp('[::]+127.0.0.1'));
  } catch {
    server.listen(port, '127.0.0.1', () => onUp('127.0.0.1'));
  }
  return { server, port };
}
