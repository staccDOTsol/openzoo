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
import zlib from 'node:zlib';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { encodeAvailableModels, encodeForMethod, encodeEnsureSandBox, encodeGetGrokBotSendStatus, decodeProtoFields, unwrapConnect } from './cursorapi.js';
import {
  accountPodPath, accountAgentsPath, rosterForAccount, rosterForEvent,
  readHouseRoster, houseAgentsPath, shapeAgent, agentBrief, briefFromName,
  preferNamedAgent, looksLikeAgentId,
  readWakeups, writeWakeups, shapeWakeup, parseWakeupEvery, wantsWakeupCron,
  DEFAULT_WAKEUP_PROMPT, addDeletedIds, filterDeleted,
} from './grokbotAccount.js';
import { formatSpendFooter, mergeTurnProof } from './spendProof.js';
import { zooModelIds } from './models.js';
import { prefixVisitorRichText } from './grokbotweb.js';
import {
  ingestUpload, lookupUpload, readUploadChunk, readUploadImage, readUploadText,
} from './grokbotUploads.js';
import {
  desktopAction, displayBounds, imageSize, noteShotMeta, resolveAppName,
} from './grokbotDesktop.js';
import { startHostMcps, hostMcpTools, hostMcpHas, callHostMcp, hostMcpServers, chromeStatus } from './mcpbridge.js';
import * as ship from './ship.js';

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
 * THE TRIGGER. Cursor's chat inference is ChatService/StreamUnifiedChat to the
 * agent host (now impersonated). Whatever the user typed into Grok Bot's UI is
 * in this request — pull it out and hand it to OUR box (OZ_BOX_AGENT, set by
 * grokbot.js to the box's :1337 podagent). The box's own openzoo brain drives
 * the local-exec loop against the daemon running on this Mac (approval-gated),
 * and its DONE: answer is what streams back into the UI. If no box is wired
 * (OZ_BOX_AGENT unset — e.g. running the backend standalone), fall back to a
 * plain one-shot zoo call so the app still gets a reply.
 */
async function handleStreamChat(req, res, body, log) {
  const ct = String(req.headers['content-type'] || '');
  const isGrpcWeb = ct.includes('grpc-web');
  const prompt = extractPromptText(body) || 'hello';
  log(`cursor-backend:      >> StreamUnifiedChat prompt: ${JSON.stringify(prompt.slice(0, 80))}`);
  let text = '';
  const boxAgent = process.env.OZ_BOX_AGENT;
  try {
    if (boxAgent) {
      const drive = await fetch(`${boxAgent}/drive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: prompt }),
        // worst case: MAX_STEPS(10) x 60s exec waits + brain latency headroom
        signal: AbortSignal.timeout(11 * 60_000),
      });
      const data = await drive.json();
      text = data.text || '(box returned nothing)';
      log(`cursor-backend:      << box drove task -> ${text.length} chars`);
    } else {
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
      log(`cursor-backend:      << zoo replied ${text.length} chars (paid x402, no box wired)`);
    }
  } catch (e) { text = `openzoo error: ${e.message}`; log(`cursor-backend:      drive call failed: ${e.message}`); }

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

const SNIFF_FILE = path.join(os.homedir(), '.openzoo', 'grokbot-sniff.jsonl');
const POD_FILE = path.join(os.homedir(), '.openzoo', 'grokbot-pod.json');
const AGENTS_FILE = path.join(os.homedir(), '.openzoo', 'grokbot-agents.json');
const HOME = os.homedir();

function readJsonFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function writeJsonFile(p, v) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(v));
  } catch { /* */ }
}

let activeAccountId = null;

function migrateLegacyPod(accountId) {
  if (!accountId) return;
  const dest = accountPodPath(HOME, accountId);
  const destA = accountAgentsPath(HOME, accountId);
  if (!dest) return;
  const legacy = readJsonFile(POD_FILE);
  if (legacy?.agent && (!legacy.accountId || legacy.accountId === accountId) && !readJsonFile(dest)) {
    writeJsonFile(dest, legacy);
  }
  if (legacy?.accountId === accountId && !readJsonFile(destA)) {
    const agents = readJsonFile(AGENTS_FILE);
    if (Array.isArray(agents) && agents.length) writeJsonFile(destA, agents);
  }
}

function loadPod() {
  const legacy = readJsonFile(POD_FILE);
  const id = legacy?.accountId || activeAccountId;
  if (id) {
    migrateLegacyPod(id);
    const scoped = readJsonFile(accountPodPath(HOME, id));
    if (scoped?.agent) return scoped;
  }
  return legacy?.agent ? legacy : null;
}
function savePod(p) {
  if (!p?.agent) return;
  writeJsonFile(POD_FILE, p); // last-used pointer for same-user relaunch
  if (p.accountId) writeJsonFile(accountPodPath(HOME, p.accountId), p);
}
let realPod = loadPod();
activeAccountId = realPod?.accountId || null;
if (activeAccountId) migrateLegacyPod(activeAccountId);

function agentsPath() {
  if (!activeAccountId) return houseAgentsPath(HOME);
  return accountAgentsPath(HOME, activeAccountId) || houseAgentsPath(HOME);
}
/** Cafe/web hijack: one house tray for every visitor. Electron sniff still
 *  talks to the live 1340 so a second Cursor login stays isolated. */
function useHouseRoster() {
  return Boolean(process.env.OZ_HIJACK_POD) && !sniffOn();
}
function loadAgents() {
  const house = filterDeleted(readHouseRoster(HOME, activeAccountId) || [], HOME);
  const shaped = house.map(shapeAgent);
  const dirty = shaped.some((a, i) => {
    const prev = house[i] || {};
    return (a.brief && a.brief !== String(prev.brief || prev.description || ''))
      || (a.name && a.name !== String(prev.name || prev.title || ''))
      || looksLikeAgentId(prev.name, prev.id);
  });
  if (dirty && shaped.length) {
    writeJsonFile(houseAgentsPath(HOME), shaped);
    if (activeAccountId) {
      const p = accountAgentsPath(HOME, activeAccountId);
      if (p) writeJsonFile(p, shaped);
    }
  }
  for (const a of shaped) seedBriefOnCanvas(a);
  return shaped;
}
function saveAgents(a) {
  if (!Array.isArray(a)) return;
  // Persist [] too — otherwise delete-all is a no-op and the 65 land back.
  writeJsonFile(houseAgentsPath(HOME), a);
  if (activeAccountId) {
    const p = accountAgentsPath(HOME, activeAccountId);
    if (p) writeJsonFile(p, a);
  }
}
function cachedAgentList() {
  const a = loadAgents();
  return a.length ? a : null;
}

function sniffOn() { return process.env.OPENZOO_SNIFF === '1'; }
function sniffSelf() { return process.env.OZ_SNIFF_SELF || 'https://127.0.0.1:8443'; }
/** CURSOR_API_BASE_URL=https://127.0.0.1:8443 makes Host 127.0.0.1 — public DNS
 *  of that name is ENOTFOUND (measured sniff #3 /events, #4 listAgents). */
function cursorUpstream(host) {
  const h = String(host || '').replace(/:\d+$/, '');
  if (/cursor\.sh$/.test(h) || /anthropic\.com$/.test(h) || /cursorvm\.com$/.test(h)) return h;
  return 'api2.cursor.sh';
}
function sniffDump(rec) {
  if (!sniffOn()) return;
  try {
    fs.mkdirSync(path.dirname(SNIFF_FILE), { recursive: true, mode: 0o700 });
    fs.appendFileSync(SNIFF_FILE, JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n');
  } catch { /* dump must never break the proxy */ }
}
function jsonish(buf, limit = 12000) {
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
  try { return JSON.parse(s); } catch { return s.slice(0, limit); }
}
function copyReqHeaders(req, host) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.startsWith(':') || HOP_BY_HOP.has(k)) continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  if (host) headers.host = host;
  delete headers['content-length'];
  // Electron POSTs Expect: 100-continue. cursorvm 1340 answers 417 and the
  // splash never leaves "Setting up Grok Bot's computer" (measured 2026-08-29).
  delete headers.expect;
  delete headers.Expect;
  return headers;
}
function lookupPinned(ip) {
  return (h, o, cb) => (o && o.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4));
}
function inflateBody(buf, headers) {
  const enc = String(headers?.['content-encoding'] || '').toLowerCase();
  try {
    if (enc.includes('gzip')) return zlib.gunzipSync(buf);
    if (enc.includes('deflate')) return zlib.inflateSync(buf);
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
  } catch { /* fall through */ }
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { return zlib.gunzipSync(buf); } catch { /* */ }
  }
  return buf;
}
function writeCaptured(res, status, respHeaders, buf) {
  const h = {};
  for (const [k, v] of Object.entries(respHeaders || {})) {
    if (RESP_DROP.has(k.toLowerCase())) continue;
    h[k] = v;
  }
  res.writeHead(status, h);
  res.end(buf);
}

async function upstreamUnary({ host, path: pth, method, headers, body, timeoutMs = 20000 }) {
  const ip = await resolveRealAnthropic(host);
  return new Promise((resolve, reject) => {
    const up = https.request({
      hostname: host, servername: host, port: 443, path: pth,
      method, headers, lookup: lookupPinned(ip),
    }, (r) => {
      const chunks = [];
      r.on('data', (d) => chunks.push(d));
      r.on('end', () => resolve({
        status: r.statusCode, respHeaders: r.headers, buf: Buffer.concat(chunks),
      }));
      r.on('error', reject);
    });
    up.on('error', reject);
    if (timeoutMs) {
      up.setTimeout(timeoutMs, () => {
        reject(new Error('upstream timeout'));
        try { up.destroy(); } catch { /* */ }
      });
    }
    if (method !== 'GET' && method !== 'HEAD' && body && body.length) up.write(body);
    up.end();
  });
}

async function passthroughToRealAnthropic(req, res, body, host, full, log) {
  try {
    host = cursorUpstream(host);
    const streaming = /Watch|Stream|Subscribe/i.test(full);
    if (streaming) {
      await passthroughPipe(req, res, body, host, full, log);
      return;
    }
    const headers = copyReqHeaders(req, host);
    const cap = await upstreamUnary({
      host, path: full, method: req.method, headers, body, timeoutMs: 20000,
    });
    if (process.env.OPENZOO_DUMP === '1' && cap.buf.length) {
      try {
        const dir = '/tmp/openzoo-sniff';
        fs.mkdirSync(dir, { recursive: true });
        const safe = full.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 80);
        fs.writeFileSync(`${dir}/${Date.now()}_${safe}.bin`, cap.buf);
      } catch { /* dumping must never break the proxy */ }
    }
    writeCaptured(res, cap.status, cap.respHeaders, cap.buf);
    log(`cursor-backend:      ${req.method} ${full} -> REAL ${host} (${cap.status}, ${cap.buf.length}b)`);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `passthrough failed: ${e.message}` } }));
    log(`cursor-backend:      passthrough ${full} FAILED: ${e.message}`);
  }
}

async function passthroughPipe(req, res, body, host, full, log) {
  host = cursorUpstream(host);
  const ip = await resolveRealAnthropic(host);
  const headers = copyReqHeaders(req, host);
  await new Promise((resolve, reject) => {
    const up = https.request({
      hostname: host, servername: host, port: 443, path: full,
      method: req.method, headers, lookup: lookupPinned(ip),
    }, (r) => {
      const h = {};
      for (const [k, v] of Object.entries(r.headers || {})) {
        if (RESP_DROP.has(k.toLowerCase())) continue;
        h[k] = v;
      }
      res.writeHead(r.statusCode, h);
      r.pipe(res);
      r.on('end', resolve);
      r.on('error', reject);
    });
    up.on('error', reject);
    req.on('close', () => { try { up.destroy(); } catch { /* */ } });
    if (req.method !== 'GET' && req.method !== 'HEAD' && body && body.length) up.write(body);
    up.end();
  });
  log(`cursor-backend:      -> PIPE ${full} -> REAL ${host}`);
}

function rememberPod(fields, log) {
  if (!fields || !fields[6]) return null;
  const execDaemon = String(fields[6] || '');
  const gateway = String(fields[10] || fields[6] || '');
  const accountId = String(fields[2] || '');
  if (activeAccountId && accountId && accountId !== activeAccountId) {
    log(`cursor-backend:      account ${activeAccountId} -> ${accountId} (drop previous tray)`);
    cacheFallbackOk = true;
  }
  activeAccountId = accountId || activeAccountId;
  if (activeAccountId) migrateLegacyPod(activeAccountId);
  realPod = {
    execDaemon,
    agent: gateway, // /api/sendPrompt lives on gateway_url (1340), not exec_daemon (1337)
    vnc: fields[7] ? String(fields[7]).split('/vnc.html')[0] : gateway,
    vncPath: fields[7] ? String(fields[7]) : undefined,
    token: String(fields[4] || ''),
    accessToken: String(fields[11] || ''),
    p1340: gateway,
    p6081: fields[12] ? String(fields[12]) : undefined,
    region: String(fields[1] || 'us1'),
    accountId,
    podId: String(fields[3] || ''),
  };
  sniffDump({ kind: 'pod', fields, realPod });
  savePod(realPod);
  podStale = false;
  log(`cursor-backend:      SNIFF real pod account=${accountId || '?'} ${realPod.agent}`);
  return realPod;
}

function rewrittenBox({ confirmed = true } = {}) {
  const self = sniffSelf();
  const p = (confirmed && realPod) ? realPod : {};
  return encodeEnsureSandBox({
    region: p.region || 'us1',
    accountId: p.accountId || 'openzoo',
    podId: p.podId || 'openzoo-sniff',
    token: p.token || 'openzoo',
    accessToken: p.accessToken || p.token || 'openzoo',
    agent: self,
    vnc: self,
    p1340: self,
    p6081: self,
  });
}

function replyEnsureBox(req, res, payload, full = '') {
  const ct = String(req.headers['content-type'] || '');
  if (/WatchSandBoxMigration/.test(full) || ct.includes('connect+proto')) {
    res.writeHead(200, {
      'content-type': 'application/connect+proto',
      'grpc-status': '0',
      ...CORS,
    });
    const end = Buffer.from('{}');
    const h = Buffer.alloc(5); h.writeUInt8(0x02, 0); h.writeUInt32BE(end.length, 1);
    res.end(Buffer.concat([envelope(payload), h, end]));
  } else if (ct.includes('grpc-web')) {
    res.writeHead(200, {
      'content-type': ct.includes('text') ? 'application/grpc-web-text+proto' : 'application/grpc-web+proto',
      'grpc-status': '0', ...CORS,
    });
    res.end(Buffer.concat([envelope(payload), grpcWebTrailer()]));
  } else {
    res.writeHead(200, { 'content-type': 'application/proto', ...CORS });
    res.end(payload);
  }
}

const discover = { promise: null, at: 0, ok: false };
let lastBoxReq = null;
let podStale = false;
let lastOauthAt = 0;
// Same-user relaunch may fall back to the last pod if api2 times out.
// A second login is detected by EnsureSandBox accountId, not by rotating Bearer.
let cacheFallbackOk = true;

function boxDiscoverHeaders(req) {
  const headers = copyReqHeaders(req, 'api2.cursor.sh');
  headers['content-type'] = 'application/proto';
  headers.accept = 'application/proto';
  delete headers['connect-protocol-version'];
  delete headers['connect-timeout-ms'];
  delete headers['grpc-timeout'];
  delete headers.te;
  return headers;
}

async function fetchEnsureSandBox(req, body, log) {
  const upstream = 'api2.cursor.sh';
  const headers = boxDiscoverHeaders(req);
  const cap = await upstreamUnary({
    host: upstream,
    path: '/aiserver.v1.GrokBotService/EnsureSandBox',
    method: 'POST',
    headers,
    body: body && body.length ? body : Buffer.alloc(0),
    timeoutMs: 60000,
  });
  const raw = inflateBody(cap.buf, cap.respHeaders);
  const proto = unwrapConnect(raw);
  const fields = decodeProtoFields(proto);
  if (!fields?.[6]) {
    throw new Error(`EnsureSandBox empty (${cap.status}, ${cap.buf.length}b)`);
  }
  rememberPod(fields, log);
  try {
    const remote = await podJson('/api/listAgents', {}, log);
    if (Array.isArray(remote) && remote.length) {
      const merged = rosterForEvent(mergeAgentLists(remote), agentActivity);
      saveAgents(merged);
      const active = focusedAgentId || merged[0]?.id;
      ssePush('agents', { agents: merged, activeAgentId: active });
      log(`cursor-backend:      discovered roster n=${merged.length} account=${realPod.accountId}`);
    }
  } catch (e) {
    log(`cursor-backend:      discover roster ${e.message}`);
  }
  return realPod;
}

function ensureDiscover(req, body, log) {
  lastBoxReq = { headers: { ...req.headers }, body: Buffer.from(body || []) };
  if (discover.promise) return discover.promise;
  const oauthFresh = lastOauthAt > discover.at;
  if (discover.ok && realPod?.agent && !podStale && !oauthFresh) {
    return Promise.resolve(realPod);
  }
  discover.at = Date.now();
  const fakeReq = { headers: lastBoxReq.headers };
  discover.promise = fetchEnsureSandBox(fakeReq, Buffer.alloc(0), log)
    .then((p) => {
      discover.ok = !!p?.agent;
      discover.promise = null;
      return p;
    })
    .catch((e) => {
      discover.ok = false;
      discover.promise = null;
      log(`cursor-backend:      EnsureSandBox discover failed (${e.message})`);
      return null;
    });
  return discover.promise;
}

async function waitForAccountPod(log, ms = 45000) {
  if (realPod?.agent && !podStale && discover.ok) return realPod;
  if (!discover.promise && lastBoxReq) {
    ensureDiscover({ headers: lastBoxReq.headers }, lastBoxReq.body, log);
  }
  if (!discover.promise) return realPod && !podStale ? realPod : null;
  try {
    const got = await Promise.race([
      discover.promise,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), ms)),
    ]);
    if (got === 'timeout') {
      log('cursor-backend:      listAgents waited on discover — still going');
      return realPod && !podStale && cacheFallbackOk ? realPod : null;
    }
    return got && !podStale ? got : (realPod && !podStale && cacheFallbackOk ? realPod : null);
  } catch {
    return realPod && !podStale && cacheFallbackOk ? realPod : null;
  }
}

async function sniffEnsureSandBox(req, res, body, host, full, log) {
  const upstream = cursorUpstream(host);
  const headers = copyReqHeaders(req, upstream);
  const cap = await upstreamUnary({
    host: upstream, path: full, method: req.method, headers, body, timeoutMs: 60000,
  });
  const raw = inflateBody(cap.buf, cap.respHeaders);
  const proto = unwrapConnect(raw);
  const fields = decodeProtoFields(proto);
  rememberPod(fields, log);
  sniffDump({
    kind: 'EnsureSandBox',
    status: cap.status,
    bytes: cap.buf.length,
    inflated: raw.length,
    encoding: cap.respHeaders?.['content-encoding'] || '',
    head: Buffer.from(raw.subarray(0, 24)).toString('hex'),
    fields,
    rewrittenTo: sniffSelf(),
  });
  const payload = realPod ? rewrittenBox() : proto;
  const ct = String(req.headers['content-type'] || cap.respHeaders?.['content-type'] || '');
  if (/WatchSandBoxMigration/.test(full) || ct.includes('connect+proto')) {
    res.writeHead(200, {
      'content-type': 'application/connect+proto',
      'grpc-status': '0',
      ...CORS,
    });
    const end = Buffer.from('{}');
    const h = Buffer.alloc(5); h.writeUInt8(0x02, 0); h.writeUInt32BE(end.length, 1);
    res.end(Buffer.concat([envelope(payload), h, end]));
  } else if (ct.includes('grpc-web')) {
    res.writeHead(200, {
      'content-type': ct.includes('text') ? 'application/grpc-web-text+proto' : 'application/grpc-web+proto',
      'grpc-status': '0', ...CORS,
    });
    res.end(Buffer.concat([envelope(payload), grpcWebTrailer()]));
  } else {
    res.writeHead(200, { 'content-type': 'application/proto', ...CORS });
    res.end(payload);
  }
  log(`cursor-backend:      SNIFF EnsureSandBox -> rewrite ${sniffSelf()} (${cap.status}, real ${cap.buf.length}b)`);
}

async function proxyPodHttp(req, res, full, body, log) {
  if (podStale || !realPod?.agent) return false;
  const agent = new URL(realPod.agent);
  const headers = copyReqHeaders(req, agent.host);
  // Incoming Authorization is Grok Bot oauth to api2. 1340 wants EnsureSandBox
  // field 11. Leaving oauth in place 401s listAgents (measured: tails via
  // podJson with field-11 worked, roster proxy with copied oauth 401ed).
  delete headers.authorization;
  delete headers.Authorization;
  if (realPod.accessToken) headers.authorization = `Bearer ${realPod.accessToken}`;
  if (realPod.token) headers['x-anyrun-network-token'] = realPod.token;
  if (!headers['x-sand-slim-avatars']) headers['x-sand-slim-avatars'] = '1';
  const path0 = (full || '').split('?')[0];
  const interesting = /sendPrompt|Transcript|listAgents|promptAcceptance|openAgentTail|createAgent/i.test(path0);
  if (path0 === '/events') {
    const ip = await resolveRealAnthropic(agent.hostname);
    await new Promise((resolve, reject) => {
      const up = https.request({
        hostname: agent.hostname, servername: agent.hostname, port: 443, path: full,
        method: req.method, headers, lookup: lookupPinned(ip),
      }, (r) => {
        const h = { ...CORS };
        for (const [k, v] of Object.entries(r.headers || {})) {
          if (RESP_DROP.has(k.toLowerCase())) continue;
          h[k] = v;
        }
        res.writeHead(r.statusCode, h);
        const chunks = [];
        r.on('data', (d) => {
          res.write(d);
          if (chunks.length < 40) chunks.push(d);
        });
        r.on('end', () => {
          sniffDump({ kind: 'sse', path: full, sample: Buffer.concat(chunks).toString('utf8').slice(0, 8000) });
          try { res.end(); } catch { /* */ }
          resolve();
        });
        r.on('error', reject);
      });
      up.on('error', reject);
      req.on('close', () => { try { up.destroy(); } catch { /* */ } });
      up.end();
    });
    log('cursor-backend:      SNIFF /events -> real pod (piped)');
    return true;
  }
  try {
    const cap = await upstreamUnary({
      host: agent.hostname,
      path: full,
      method: req.method,
      headers,
      body,
      timeoutMs: path0 === '/health' ? 8000 : 120000,
    });
    if (cap.status === 417 || cap.status === 404) {
      podStale = true;
      log(`cursor-backend:      1340 ${cap.status} ${path0} — pod stale, local`);
      if (path0 === '/api/listAgents') {
        if (useHouseRoster()) {
          jsonSend(res, rosterForEvent(loadAgents(), agentActivity));
          return true;
        }
        const cached = rosterForAccount({
          liveAccountId: activeAccountId,
          cachedAccountId: activeAccountId,
          cached: loadAgents(),
          fallback: loadAgents(),
        });
        if (cached.length) {
          jsonSend(res, rosterForEvent(mergeAgentLists(cached), agentActivity));
          return true;
        }
      }
      return false;
    }
    if (path0 === '/api/listAgents' && cap.status === 200) {
      if (useHouseRoster()) {
        jsonSend(res, rosterForEvent(loadAgents(), agentActivity));
        return true;
      }
      try {
        const parsed = JSON.parse(String(inflateBody(cap.buf, cap.respHeaders)));
        if (Array.isArray(parsed)) {
          const merged = rosterForEvent(mergeAgentLists(parsed), agentActivity);
          saveAgents(merged);
          jsonSend(res, merged);
          log(`cursor-backend:      listAgents 200 merged n=${merged.length} account=${activeAccountId || '?'}`);
          return true;
        }
      } catch { /* */ }
    }
    if (cap.status !== 200 && path0 === '/api/listAgents') {
      const cached = rosterForAccount({
        liveAccountId: activeAccountId,
        cachedAccountId: activeAccountId,
        cached: loadAgents(),
        fallback: loadAgents(),
      });
      if (cached.length || useHouseRoster()) {
        jsonSend(res, rosterForEvent(mergeAgentLists(cached), agentActivity));
        log(`cursor-backend:      listAgents ${cap.status} — cached ${cached.length} named agents account=${activeAccountId}`);
        return true;
      }
    }
    writeCaptured(res, cap.status, cap.respHeaders, cap.buf);
    const rec = {
      kind: 'pod-http',
      method: req.method,
      path: path0,
      status: cap.status,
      reqBytes: body?.length || 0,
      resBytes: cap.buf.length,
      req: jsonish(body, 4000),
      res: jsonish(inflateBody(cap.buf, cap.respHeaders), 16000),
    };
    sniffDump(rec);
    if (interesting) {
      log(`cursor-backend:      SNIFF ${path0} ${cap.status} req=${JSON.stringify(rec.req).slice(0, 220)} res=${JSON.stringify(rec.res).slice(0, 500)}`);
    } else {
      log(`cursor-backend:      SNIFF ${path0} -> real pod (${cap.status}, ${cap.buf.length}b)`);
    }
    return true;
  } catch (e) {
    log(`cursor-backend:      SNIFF ${path0} FAILED ${e.message}`);
    return false;
  }
}

/** JSON for the in-pod agent HTTP API. Hijack points field-6 at THIS
 *  server, so GET /health and POST /api/* land here — empty protobuf on
 *  those is "unhealthy" and Grok Bot retries EnsureSandBox forever
 *  (measured: /health empty-ok then EnsureSandBox #1945+). */
function jsonSend(res, obj) {
  res.writeHead(200, { 'content-type': 'application/json', ...CORS });
  res.end(JSON.stringify(obj));
}
/** Box HTTP API envelope. Client parse (CVr) returns null unless both
 *  status==="ok" AND "value" in n — our unwrapped {ok:true}/{entries} was
 *  dropped, so Grok Bot never painted the zoo reply (measured: << zoo 200 91c
 *  then tail polls with Failed to send). */
function jsonApi(res, value) {
  jsonSend(res, { status: 'ok', value });
}

const sseClients = new Set();
/** Gateway SSE parser (asar dispatchEventBlock) only reads `data:` lines and
 *  requires `{channel, payload}`. `event:` names are ignored. */
function ssePush(channel, payload) {
  const chunk = `data: ${JSON.stringify({ channel, payload })}\n\n`;
  for (const c of sseClients) {
    try { c.write(chunk); } catch { sseClients.delete(c); }
  }
}

let focusedAgentId = null;
const agentActivity = new Map(); // id -> { updatedAt, unreadCount, hasUnread, preview }
function noteFocus(id) {
  if (!id) return;
  focusedAgentId = id;
  const a = agentActivity.get(id) || {};
  a.hasUnread = false;
  a.unreadCount = 0;
  agentActivity.set(id, a);
}
function topConversationId(list) {
  const arr = Array.isArray(list) ? list : [];
  return focusedAgentId && arr.some((a) => a.id === focusedAgentId)
    ? focusedAgentId
    : (arr[0]?.id || null);
}

function stampActivity(agent) {
  const a = agentActivity.get(agent.id) || {};
  const updatedAt = a.updatedAt || agent.updatedAt || agent.createdAt || 0;
  return {
    ...agent,
    updatedAt,
    hasUnread: !!a.hasUnread,
    unreadCount: a.unreadCount || 0,
  };
}
function sortAgentsByActivity(list) {
  return [...list].sort((x, y) => {
    const ax = agentActivity.get(x.id)?.updatedAt || x.updatedAt || x.createdAt || 0;
    const ay = agentActivity.get(y.id)?.updatedAt || y.updatedAt || y.createdAt || 0;
    return ay - ax;
  });
}
function bumpAgent(id, { preview = '', notify = true } = {}) {
  const now = Date.now();
  const a = agentActivity.get(id) || { unreadCount: 0 };
  a.updatedAt = now;
  if (preview) a.preview = String(preview).slice(0, 120);
  const other = notify && focusedAgentId && focusedAgentId !== id;
  if (other) {
    a.hasUnread = true;
    a.unreadCount = (a.unreadCount || 0) + 1;
  }
  agentActivity.set(id, a);
  const list = cachedAgentList() || [];
  const idx = list.findIndex((x) => x.id === id);
  const base = idx >= 0 ? list[idx] : { id, name: 'chat' };
  const agent = shapeAgent(stampActivity({ ...base, updatedAt: now }));
  if (idx >= 0) list[idx] = agent;
  else list.unshift(agent);
  saveAgents(sortAgentsByActivity(list.map(shapeAgent)));
  pushCreatedAgent(agent);
}

/** asar ingestAgentsEvent does Ae.agents.map — `{action:"created"}` has no
 *  agents[] so the picker/tray throws and looks empty. ingestAgentUpserted
 *  needs {agent, activeAgentId}. Same payload bumpAgent already sends. */
function pushCreatedAgent(agent, { select = true } = {}) {
  if (!agent || !agent.id) return;
  if (select) focusedAgentId = agent.id;
  const active = focusedAgentId || agent.id;
  const list = rosterForEvent(cachedAgentList() || [], agentActivity);
  ssePush('agent-upserted', { agent, activeAgentId: active });
  ssePush('agents', { agents: list, activeAgentId: active });
}

/** Grok Bot Helper daemon: GET /local-exec/requests is SSE, POST /local-exec/responses
 *  is `{providerId, frames}`. We used to JSON-[] the GET which is "disconnected"
 *  (measured: Grok Bot "can't see files on your local computer"). */
const localExecSse = new Set();
const localExecWaiters = new Map();
let localExecHello = null;
function localExecPush(frame) {
  const chunk = `data: ${JSON.stringify(frame)}\n\n`;
  for (const c of localExecSse) {
    try { c.write(chunk); } catch { localExecSse.delete(c); }
  }
}
function handleLocalExecFrames(frames, log) {
  for (const f of frames || []) {
    if (!f || typeof f !== 'object') continue;
    if (f.kind === 'hello') {
      localExecHello = f;
      log(`cursor-backend:      local-exec hello computer=${f.computerId || f.label || '?'} root=${f.localRoot || '?'}`);
    }
    const w = f.requestId && localExecWaiters.get(f.requestId);
    if (!w) continue;
    if (f.kind === 'file') {
      const buf = Buffer.from(f.bytesBase64 || '', 'base64');
      w.resolve({ kind: 'file', bytes: buf, text: buf.toString('utf8') });
      localExecWaiters.delete(f.requestId);
    } else if (f.kind === 'file-error' || f.kind === 'messages-error') {
      w.reject(new Error(f.error || 'local-exec error'));
      localExecWaiters.delete(f.requestId);
    } else if (f.kind === 'client' || f.kind === 'control' || f.kind === 'result' || f.kind === 'exec-result') {
      w.resolve({
        kind: f.kind,
        message: f.message || f.text || f.stdout || JSON.stringify(f),
        stdout: f.stdout,
        stderr: f.stderr,
        exitCode: f.exitCode,
      });
      localExecWaiters.delete(f.requestId);
    }
  }
}
function localExecAsk(frame, timeoutMs = 45000) {
  const requestId = frame.requestId || randomUUID();
  const job = { ...frame, requestId };
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      localExecWaiters.delete(requestId);
      reject(new Error('local-exec timeout — is Grok Bot Helper connected?'));
    }, timeoutMs);
    localExecWaiters.set(requestId, {
      resolve: (v) => { clearTimeout(t); resolve(v); },
      reject: (e) => { clearTimeout(t); reject(e); },
    });
    localExecPush(job);
  });
}
async function handleLocalExecHttp(req, res, path0, body, log) {
  if (!/^\/local-exec\//.test(path0)) return false;
  if (req.method === 'GET' && /\/requests$/.test(path0)) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      ...CORS,
    });
    localExecSse.add(res);
    // Daemon parser (asar CNt) ignores unknown welcome; a comment ping is enough
    // to keep the stream alive until it POSTs hello to /responses.
    res.write(': openzoo local-exec\n\n');
    const iv = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(iv); localExecSse.delete(res); }
    }, 10000);
    req.on('close', () => { clearInterval(iv); localExecSse.delete(res); log('cursor-backend:      local-exec sse closed'); });
    log(`cursor-backend:      -> local-exec /requests sse n=${localExecSse.size}`);
    return true;
  }
  if (/\/responses$/.test(path0)) {
    let parsed = {};
    try { parsed = JSON.parse(String(body || '{}')); } catch { parsed = {}; }
    handleLocalExecFrames(parsed.frames, log);
    jsonSend(res, { ok: true });
    log(`cursor-backend:      -> local-exec /responses n=${(parsed.frames || []).length} kinds=${(parsed.frames || []).map((f) => f?.kind).join(',')}`);
    return true;
  }
  jsonSend(res, { ok: true });
  return true;
}
function extractLocalPaths(text) {
  const out = [];
  const re = /(?:~\/|\/Users\/)[^\s,;:!?()[\]{}"'`]+/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    out.push(m[0].replace(/[.,;:]+$/, ''));
  }
  return [...new Set(out)];
}
function expandUserPath(p) {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Per-agent transcript. sendPrompt is async: accept immediately, zooComplete
 *  fills this, getAgentTranscriptTail is what the UI actually polls.
 *
 *  Gateway `isValidTranscriptEntry` (asar Fgi/RC) DROPS anything that is not
 *  `{id, kind:"message", content}` / `{id, kind:"send-message", message}` —
 *  proto wrappers with entryKind/body were counted n=2/2 here and painted
 *  as zero on the client, so overlay timed out → "Failed to send". */
const transcripts = new Map();
const tailedAgents = new Set();
let lastSendEchoId = `oz-${Date.now()}`;
const TX_FILE = path.join(os.homedir(), '.openzoo', 'grokbot-transcripts.json');
function loadTranscripts() {
  try {
    const o = JSON.parse(fs.readFileSync(TX_FILE, 'utf8'));
    for (const [id, t] of Object.entries(o || {})) {
      transcripts.set(id, {
        seq: Number(t.seq) || (t.entries || []).length,
        entries: Array.isArray(t.entries) ? t.entries : [],
        pulledRemote: false,
      });
    }
  } catch { /* first run */ }
}
function saveTranscriptsNow() {
  try {
    const o = {};
    for (const [id, t] of transcripts) {
      o[id] = { seq: t.seq, entries: t.entries.slice(-200) };
    }
    fs.mkdirSync(path.dirname(TX_FILE), { recursive: true });
    fs.writeFileSync(TX_FILE, JSON.stringify(o));
  } catch { /* */ }
}
let saveTxTimer;
function saveTranscripts() {
  clearTimeout(saveTxTimer);
  saveTxTimer = setTimeout(saveTranscriptsNow, 250);
}
function flushTranscripts() {
  clearTimeout(saveTxTimer);
  saveTranscriptsNow();
}
process.once('beforeExit', flushTranscripts);
loadTranscripts();
function agentTranscript(id) {
  let t = transcripts.get(id);
  if (!t) { t = { seq: 0, entries: [], pulledRemote: false }; transcripts.set(id, t); }
  return t;
}
function appendLine(agentId, role, text, extra = {}) {
  const t = agentTranscript(agentId);
  t.seq += 1;
  const nonce = extra.clientNonce ? String(extra.clientNonce) : undefined;
  const ts = Date.now();
  const requestId = extra.requestId || nonce || `oz-req-${t.seq}`;
  let e;
  if (role === 'user') {
    // Live cursorvm getAgentTranscriptTail (2026-08-29): user echo is
    // kind:"message" + role:"user" + clientNonce. Assistant is kind:"send-message".
    e = {
      seq: t.seq,
      kind: 'message',
      id: extra.id || `t${t.seq}u`,
      role: 'user',
      content: String(text || ''),
      richText: extra.richText || JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: String(text || '') }] }] }),
      isStreaming: false,
      timestampMs: ts,
      ...(nonce ? { clientNonce: nonce } : {}),
      requestId,
      ...(extra.promptRaw != null ? { promptRaw: String(extra.promptRaw) } : {}),
    };
  } else {
    e = {
      seq: t.seq,
      kind: 'send-message',
      id: extra.id || `t${t.seq}s0`,
      message: { type: 'text', content: String(text || '') },
      timestampMs: ts,
      requestId,
      ...(extra.author && typeof extra.author === 'object' ? { author: extra.author } : {}),
      ...(extra.ephemeral ? { ephemeral: true } : {}),
    };
  }
  t.entries.push(e);
  saveTranscripts();
  return e;
}

/** One zooComplete per agent. A new sendPrompt (or Stop) aborts the previous
 *  loop so "try again" does not stack 32-step exec storms with an empty canvas. */
export function createZooTurnQueue() {
  const inflight = new Map();
  return {
    begin(agentId, nonce) {
      const id = String(agentId || '');
      const prev = inflight.get(id);
      if (prev && prev.nonce !== nonce) {
        try { prev.abort.abort(new Error('superseded')); } catch { /* */ }
      }
      const abort = new AbortController();
      inflight.set(id, { nonce, abort });
      return abort;
    },
    isCurrent(agentId, nonce) {
      return inflight.get(String(agentId || ''))?.nonce === nonce;
    },
    end(agentId, nonce) {
      const id = String(agentId || '');
      const cur = inflight.get(id);
      if (cur && cur.nonce === nonce) inflight.delete(id);
    },
    abort(agentId) {
      const id = String(agentId || '');
      const prev = inflight.get(id);
      if (!prev) return 0;
      try { prev.abort.abort(new Error('interrupted')); } catch { /* */ }
      inflight.delete(id);
      return 1;
    },
    busy(agentId) {
      return inflight.has(String(agentId || ''));
    },
  };
}
const zooTurns = createZooTurnQueue();

const wakeupTimers = new Map();
let wakeupLog = () => {};
let wakeupsRestored = false;

function persistWakeups(map) {
  try { writeWakeups(HOME, map); } catch (e) {
    wakeupLog(`cursor-backend:      wakeups save failed: ${e.message}`);
  }
}

export function listAgentWakeups() {
  return readWakeups(HOME);
}

export function cancelAgentWakeup(agentId) {
  const id = String(agentId || '');
  const t = wakeupTimers.get(id);
  if (t) {
    clearTimeout(t);
    wakeupTimers.delete(id);
  }
  const map = readWakeups(HOME);
  if (!map[id]) return { ok: true, cancelled: false };
  delete map[id];
  persistWakeups(map);
  return { ok: true, cancelled: true, id };
}

function armWakeup(rec) {
  const id = rec.agentId;
  const prev = wakeupTimers.get(id);
  if (prev) clearTimeout(prev);
  const delay = Math.max(1000, Number(rec.nextAt) - Date.now());
  const t = setTimeout(() => {
    fireAgentWakeup(id).catch((e) => wakeupLog(`cursor-backend:      wakeup fire ${id}: ${e.message}`));
  }, delay);
  wakeupTimers.set(id, t);
}

export function scheduleAgentWakeup(agentId, opts = {}) {
  const id = String(agentId || '').trim();
  if (!id) return { ok: false, error: 'no agent' };
  const now = Date.now();
  const every = opts.every ?? opts.everySec;
  const rec = shapeWakeup(id, {
    every,
    prompt: opts.prompt,
    lastAt: 0,
    nextAt: now + parseWakeupEvery(every) * 1000,
  }, now);
  const map = readWakeups(HOME);
  map[id] = rec;
  persistWakeups(map);
  armWakeup(rec);
  wakeupLog(`cursor-backend:      wakeup every ${rec.everySec}s agent=${id}`);
  return { ok: true, ...rec };
}

async function fireAgentWakeup(agentId) {
  const id = String(agentId || '');
  const map = readWakeups(HOME);
  const rec = map[id];
  if (!rec) {
    wakeupTimers.delete(id);
    return;
  }
  rec.lastAt = Date.now();
  rec.nextAt = rec.lastAt + rec.everySec * 1000;
  persistWakeups(map);
  armWakeup(rec);
  if (zooTurns.busy(id)) {
    wakeupLog(`cursor-backend:      wakeup skip busy agent=${id}`);
    return;
  }
  if (focusedAgentId && String(focusedAgentId) === id) {
    wakeupLog(`cursor-backend:      wakeup skip focused agent=${id}`);
    return;
  }
  const nonce = `oz-wakeup-${id}-${rec.lastAt}`;
  const prompt = rec.prompt || DEFAULT_WAKEUP_PROMPT;
  const turn = zooTurns.begin(id, nonce);
  const userLine = fanoutLine(id, 'user', `[wakeup]\n${prompt}`, { clientNonce: nonce, requestId: nonce });
  ssePush('transcript', { ...gatewayEntry(userLine), agentId: id });
  bumpAgent(id, { preview: '[wakeup]', notify: false });
  wakeupLog(`cursor-backend:      wakeup start agent=${id}`);
  try {
    const z = await zooComplete(prompt, wakeupLog, id, {}, {
      signal: turn.signal,
      onProgress: (note) => {
        if (!zooTurns.isCurrent(id, nonce)) return;
        paintChatUpdate(id, note, { clientNonce: nonce, requestId: nonce });
      },
    });
    if (!zooTurns.isCurrent(id, nonce)) return;
    const line = fanoutLine(id, 'assistant', z.text, { clientNonce: nonce, requestId: nonce });
    ssePush('transcript', { ...gatewayEntry(line), agentId: id });
    bumpAgent(id, { preview: z.text, notify: true });
    wakeupLog(`cursor-backend:      wakeup done agent=${id} seq=${line.seq}`);
  } catch (e) {
    if (!isSupersededError(e)) wakeupLog(`cursor-backend:      wakeup failed agent=${id}: ${e.message}`);
  } finally {
    zooTurns.end(id, nonce);
  }
}

export function restoreAgentWakeups(log = () => {}) {
  wakeupLog = log;
  if (wakeupsRestored) return 0;
  wakeupsRestored = true;
  const map = readWakeups(HOME);
  const ids = Object.keys(map);
  const now = Date.now();
  ids.forEach((id, i) => {
    // Do not fire during Grok Bot boot. 10 parallel zoo turns + CDP on the
    // spinner page left the window on a white disc. First tick is +90s.
    map[id].nextAt = now + 90_000 + i * 4000;
  });
  if (ids.length) persistWakeups(map);
  for (const id of ids) armWakeup(map[id]);
  if (ids.length) log(`cursor-backend:      wakeups restored ${ids.length}`);
  return ids.length;
}

export function formatZooProgress({ step, maxSteps, names, command } = {}) {
  const tools = Array.isArray(names) ? names.filter(Boolean).join(', ') : String(names || 'tools');
  const cmd = command ? ` ${JSON.stringify(String(command).slice(0, 80))}` : '';
  return `Working on your Mac (step ${Number(step) + 1}/${maxSteps || '?'}): ${tools}${cmd}`;
}

/** One canvas line per tool. Asar ingest is append-only — mutating a working
 *  bubble is still silence. Keep it short; the model history skips ephemeral. */
export function formatZooToolLine({ name, args = {}, result } = {}) {
  const detail = args.command || args.path || args.name || args.window
    || args.query || args.url || args.key || args.app || args.every
    || (args.x != null && args.y != null ? `${args.x},${args.y}` : '')
    || (args.text != null ? String(args.text).slice(0, 80) : '');
  const head = detail
    ? `${name} ${JSON.stringify(String(detail).slice(0, 90))}`
    : String(name || 'tool');
  let tail = String(result || '').replace(/\s+/g, ' ').trim();
  if (tail.startsWith('{')) {
    try {
      const o = JSON.parse(String(result));
      if (o && typeof o === 'object') {
        tail = [o.path, o.id, o.name, o.bytes != null ? `${o.bytes}b` : '', o.ok === true ? 'ok' : '']
          .filter(Boolean).join(' ') || tail;
      }
    } catch { /* raw */ }
  }
  tail = tail.slice(0, 160);
  return `→ ${head}${tail ? `\n${tail}` : ''}`;
}

export function combinedAbortSignal(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const c = new AbortController();
  const on = () => { try { c.abort(); } catch { /* */ } };
  if (a.aborted || b.aborted) { on(); return c.signal; }
  a.addEventListener('abort', on, { once: true });
  b.addEventListener('abort', on, { once: true });
  return c.signal;
}

export function isSupersededError(e) {
  const m = String(e?.message || e || '');
  return /superseded|interrupted/i.test(m);
}

function paintChatUpdate(agentId, note, extra = {}) {
  const line = fanoutLine(agentId, 'assistant', note, { ...extra, ephemeral: true });
  ssePush('transcript', { ...gatewayEntry(line), agentId });
  bumpAgent(agentId, { preview: note, notify: false });
  return line;
}
function fanoutLine(primaryId, role, text, extra = {}) {
  // Only the addressed agent. Writing to every tailedAgents id mixed canvases
  // so a new/empty chat showed someone else's thread.
  return appendLine(primaryId, role, text, extra);
}
function mintLocalAgent(parsed = {}) {
  const id = String(parsed.id || randomUUID());
  const prev = (cachedAgentList() || []).find((a) => a.id === id) || {};
  const agent = shapeAgent({
    ...prev,
    ...parsed,
    id,
    createdAt: prev.createdAt || parsed.createdAt || Date.now(),
    updatedAt: Date.now(),
  });
  const list = cachedAgentList() || [];
  if (!list.some((a) => a.id === id)) list.unshift(agent);
  else {
    const i = list.findIndex((a) => a.id === id);
    list[i] = { ...list[i], ...agent };
  }
  saveAgents(list.map(shapeAgent));
  agentTranscript(id);
  seedBriefOnCanvas(agent);
  return agent;
}

function entryKickText(e) {
  if (!e || typeof e !== 'object') return '';
  if (e.kind === 'send-message') return String(e.message?.content || '');
  return String(e.content || '');
}

const briefKicked = new Set();
function needsJobKick(agent) {
  if (!agent?.id || !String(agent.brief || '').trim()) return false;
  if (briefKicked.has(agent.id)) return false;
  const entries = agentTranscript(agent.id).entries || [];
  if (!entries.length) return true;
  if (entries.length > 4) return false;
  const blob = entries.map(entryKickText).join('\n');
  if (/\[brief\]/i.test(blob) && entries.length <= 3) {
    if (/Working from this brief/i.test(blob)) return true;
    if (entries.length === 1) return true;
  }
  return false;
}

function kickBriefedAgent(agent, log = () => {}) {
  if (!needsJobKick(agent)) return false;
  briefKicked.add(agent.id);
  const nonce = `oz-kick-${agent.id}`;
  log(`cursor-backend:      brief-kick start ${agent.id} ${JSON.stringify(agent.name)}`);
  setImmediate(async () => {
    try {
      const z = await zooComplete(
        'Your brief is in this thread. Start that job now. Use tools. Do real work. Do not wait for another human message. Do not only say understood.',
        log,
        agent.id,
        {},
      );
      const line = fanoutLine(agent.id, 'assistant', z.text, { clientNonce: nonce, requestId: nonce });
      ssePush('transcript', { ...gatewayEntry(line), agentId: agent.id });
      bumpAgent(agent.id, { preview: z.text, notify: true });
      log(`cursor-backend:      brief-kick done ${agent.id} seq=${line.seq}`);
    } catch (e) {
      briefKicked.delete(agent.id);
      log(`cursor-backend:      brief-kick failed ${agent.id}: ${e.message}`);
    }
  });
  return true;
}

function seedBriefOnCanvas(agent, log) {
  if (!agent?.id || !String(agent.brief || '').trim()) return false;
  const t = agentTranscript(agent.id);
  if (!(t.entries || []).length) {
    const nonce = `oz-brief-${agent.id}`;
    const userLine = fanoutLine(agent.id, 'user', `[brief]\n${agent.brief}`, { clientNonce: nonce, requestId: nonce });
    ssePush('transcript', { ...gatewayEntry(userLine), agentId: agent.id });
  }
  return kickBriefedAgent(agent, log || ((m) => console.error(m)));
}
/** Overlay prompts ITS user: no factory yet -> paint how to start one. Once per process. */
export function shipNudgeText() {
  return [
    '[grok ship] No software factory on this Mac yet.',
    'Tell me: set up Grok Ship for ~/path/to/repo',
    'I will create Firstmate (the one bot you talk to) and a crewmate for that repo. Then give Firstmate ship tasks: it runs a worker on a branch, a fresh review of the diff, and opens the PR only when the review is clean. You merge.',
  ].join('\n');
}
let shipNudged = false;
function seedShipNudge(list, activeId) {
  if (shipNudged || !activeId) return false;
  const roster = Array.isArray(list) ? list : [];
  if (roster.some((a) => /^firstmate$/i.test(String(a?.name || '')))) { shipNudged = true; return false; }
  const t = agentTranscript(activeId);
  if ((t.entries || []).some((e) => /\[grok ship\]/.test(String(e?.content || e?.message?.content || '')))) { shipNudged = true; return false; }
  shipNudged = true;
  const nonce = `oz-ship-nudge-${activeId}`;
  const line = fanoutLine(activeId, 'assistant', shipNudgeText(), { clientNonce: nonce, requestId: nonce });
  ssePush('transcript', { ...gatewayEntry(line), agentId: activeId });
  return true;
}
function groupMemberIds(agentId) {
  const a = (cachedAgentList() || []).find((x) => x.id === agentId);
  if (!a?.isGroup) return [];
  return (a.memberIds || []).map(String).filter(Boolean);
}
function groupMemberRecords(agentId) {
  const roster = cachedAgentList() || [];
  return groupMemberIds(agentId).map((mid) => {
    const m = roster.find((x) => x.id === mid);
    return { id: mid, name: String(m?.name || mid) };
  });
}

export function groupReplyIsPass(text) {
  const s = stripSpendFooter(String(text || '')).replace(/^\s*[A-Za-z0-9 _.-]{1,40}:\s*/, '').trim();
  if (!s) return true;
  if (/^PASS\b/i.test(s)) return true;
  if (s.length < 20) return true;
  return /\b(nothing (more|else) to add|i('m| am) done|that('s| is) (all|my last word)|we (are|'re) (agreed|aligned|done)|i'?ll (stop|leave it)|no further|conversation is over|natural conclusion|i pass)\b/i.test(s);
}

const GROUP_MAX_ROUNDS = Math.min(12, Math.max(2, Number(process.env.OZ_GROUP_MAX_ROUNDS || 8)));
const GROUP_MAX_CALLS = Math.min(24, Math.max(4, Number(process.env.OZ_GROUP_MAX_CALLS || 16)));

/** Members speak, then keep peek/ponging until they PASS or hit the cap. */
async function runGroupQueue({ agentId, humanPrompt, parsed, nonce, log }) {
  const named = groupMemberRecords(agentId);
  if (!named.length) return false;
  const names = named.map((m) => m.name);
  let calls = 0;

  const oneTurn = async (m, phase) => {
    const others = names.filter((n) => n !== m.name).join(', ') || 'the group';
    const persona = phase === 'peek'
      ? `You are ${m.name} in a group with ${others}. Continue ping/pong with the other members using the prior turns. Do not speak as the human. Do not prefix with visitor shortnames. If the exchange has reached a natural conclusion or you have nothing to add, reply with exactly PASS and nothing else. Otherwise one short in-character turn.`
      : `You are ${m.name} in a group with ${others}. Answer the human as yourself and leave a hook the others can ping. Do not speak as the human. Do not prefix with visitor shortnames. A few sentences.\n\nThe human said: ${humanPrompt}`;
    let bit = '';
    try {
      bit = (await zooComplete(persona, log, agentId, parsed)).text;
    } catch (e) {
      bit = `openzoo error (${m.name}): ${e.message}`;
      log(`cursor-backend:      group ${phase} ${m.id} failed: ${e.message}`);
    }
    calls += 1;
    const pass = groupReplyIsPass(bit);
    if (!pass) {
      const line = fanoutLine(agentId, 'assistant', bit, {
        clientNonce: nonce,
        requestId: nonce,
        author: { kind: 'agent', id: m.id, name: m.name },
      });
      ssePush('transcript', { ...gatewayEntry(line), agentId });
      bumpAgent(agentId, { preview: bit, notify: true });
      log(`cursor-backend:      group ${phase} ${m.name} seq=${line.seq}`);
    } else {
      log(`cursor-backend:      group ${phase} ${m.name} PASS`);
    }
    return pass;
  };

  for (const m of named) {
    if (calls >= GROUP_MAX_CALLS) break;
    await oneTurn(m, 'speak');
  }
  if (named.length < 2) return true;

  let round = 0;
  while (round < GROUP_MAX_ROUNDS && calls < GROUP_MAX_CALLS) {
    round += 1;
    let passes = 0;
    for (const m of named) {
      if (calls >= GROUP_MAX_CALLS) break;
      if (await oneTurn(m, 'peek')) passes += 1;
    }
    if (passes >= named.length) {
      log(`cursor-backend:      group concluded round=${round} calls=${calls}`);
      break;
    }
  }
  log(`cursor-backend:      group queue done rounds=${round} calls=${calls}`);
  return true;
}
function mergeAgentLists(remote) {
  const local = cachedAgentList() || [];
  const seen = new Map();
  const out = [];
  for (const a of [...local, ...(Array.isArray(remote) ? remote : [])]) {
    if (!a?.id) continue;
    const idx = seen.get(a.id);
    if (idx == null) {
      seen.set(a.id, out.length);
      out.push(stampActivity(a));
      continue;
    }
    out[idx] = stampActivity(preferNamedAgent(out[idx], a));
  }
  return sortAgentsByActivity(filterDeleted(out, HOME));
}
function gatewayEntry(e) {
  const { seq, pulledRemote, promptRaw, ephemeral, ...rest } = e;
  return rest;
}

function stripSpendFooter(s) {
  return String(s || '')
    .replace(/\n{2,}::oz-spend::[\s\S]*$/i, '')
    .replace(/\n{2,}this call \$[\d.]+[\s\S]*$/i, '')
    .trimEnd();
}

function entryPlainText(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(entryPlainText).filter(Boolean).join('\n');
  if (typeof v === 'object') {
    return entryPlainText(v.content ?? v.text ?? v.message ?? v.prompt ?? v.value ?? '');
  }
  return '';
}

/** Prior turns for zooComplete. sendPrompt used to POST only the latest user
 *  line, so the model said each thread starts blank while the UI still showed
 *  the canvas. Skip the last user echo of `currentPrompt` (already appended). */
function historyMessages(agentId, currentPrompt) {
  const entries = agentTranscript(agentId).entries || [];
  const cur = String(currentPrompt || '').trim();
  const out = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    let role = null;
    let text = '';
    if (e.ephemeral) continue;
    if (e.kind === 'send-message' || e.role === 'assistant' || e.kind === 'assistant') {
      text = entryPlainText(e.message ?? e.content ?? e.text);
      role = 'assistant';
      text = stripSpendFooter(text);
      const who = e.author && e.author.name ? String(e.author.name).trim() : '';
      if (who && text && !text.toLowerCase().startsWith(`${who.toLowerCase()}:`)) {
        text = `${who}: ${text}`;
      }
    } else if (e.kind === 'message' || e.role === 'user' || e.kind === 'user') {
      // Keep `shortname: ` on the turn the model sees -- stripping it made every
      // visitor look like one anonymous "you" (rex asked "am I still rex").
      text = entryPlainText(e.content ?? e.message ?? e.text ?? e.prompt);
      if (!String(text || '').trim() && e.promptRaw != null) text = String(e.promptRaw);
      role = 'user';
    }
    text = String(text || '').trim();
    if (!role || !text) continue;
    out.push({ role, content: text });
  }
  const curBare = stripVisitorLabel(cur).trim();
  while (out.length && out[out.length - 1].role === 'user') {
    const last = String(out[out.length - 1].content).trim();
    if (last === cur || stripVisitorLabel(last).trim() === curBare) out.pop();
    else break;
  }
  let chars = 0;
  const kept = [];
  for (let i = out.length - 1; i >= 0; i--) {
    chars += String(out[i].content).length;
    if (chars > 120_000 && kept.length) break;
    kept.push(out[i]);
  }
  kept.reverse();
  return kept;
}

async function ensureTranscriptHydrated(agentId, log) {
  const t = agentTranscript(agentId);
  if (t.pulledRemote || !realPod?.agent) return;
  try {
    const remote = await podJson('/api/getAgentTranscriptTail', {
      id: agentId, agentId, limit: 200,
    }, log);
    const entries = remote?.entries || remote?.value?.entries || remote?.lines || [];
    const n = ingestRemoteEntries(agentId, entries);
    if (n) log(`cursor-backend:      zooComplete hydrate ${agentId} +${n} from 1340`);
  } catch (e) {
    log(`cursor-backend:      zooComplete hydrate failed: ${e.message}`);
  }
  t.pulledRemote = true;
}
async function podJson(path0, bodyObj, log) {
  if (!realPod?.agent) return null;
  let agent;
  try { agent = new URL(realPod.agent); } catch { return null; }
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${realPod.accessToken || realPod.token || ''}`,
    'x-anyrun-network-token': realPod.token || '',
    'x-sand-slim-avatars': '1',
  };
  try {
    const cap = await upstreamUnary({
      host: agent.hostname,
      path: path0,
      method: 'POST',
      headers,
      body: Buffer.from(JSON.stringify(bodyObj || {})),
      timeoutMs: 20000,
    });
    if (cap.status !== 200) {
      log(`cursor-backend:      podJson ${path0} ${cap.status}`);
      return null;
    }
    const raw = inflateBody(cap.buf, cap.respHeaders);
    return JSON.parse(String(raw));
  } catch (e) {
    log(`cursor-backend:      podJson ${path0} ${e.message}`);
    return null;
  }
}
function ingestRemoteEntries(agentId, entries) {
  if (!Array.isArray(entries) || !entries.length) return 0;
  const t = agentTranscript(agentId);
  const have = new Set(t.entries.map((e) => e.id || e.clientNonce || '').filter(Boolean));
  const incoming = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const k = e.id || e.clientNonce || '';
    if (k && have.has(k)) continue;
    incoming.push(e);
  }
  if (!incoming.length) return 0;
  const local = t.entries;
  t.entries = [];
  t.seq = 0;
  for (const e of [...incoming, ...local]) {
    t.seq += 1;
    const { seq: _s, ...rest } = e;
    t.entries.push({ ...rest, seq: t.seq });
  }
  saveTranscripts();
  return incoming.length;
}

function visitorFromSend(parsed) {
  const v = parsed && parsed.visitor;
  if (!v || typeof v !== 'object') return null;
  const id = String(v.id || '').trim();
  const shortname = String(v.shortname || v.name || '').trim().toLowerCase();
  const color = String(v.color || '').trim();
  if (!id || !/^[a-z][a-z0-9]{1,15}$/.test(shortname)) return null;
  return { id, shortname, color };
}

/** UI stores `shortname: prompt`; zooComplete / history must see the raw line. */
function stripVisitorLabel(text) {
  const s = String(text || '');
  const m = s.match(/^([a-z][a-z0-9]{1,15}):\s+/);
  if (!m) return s;
  if (/^(https?|ftp|mailto|file|data)$/i.test(m[1])) return s;
  return s.slice(m[0].length);
}

function labeledVisitorPrompt(visitor, prompt) {
  const p = String(prompt || '');
  if (!visitor?.shortname) return p;
  const prefix = `${visitor.shortname}: `;
  if (p.startsWith(prefix)) return p;
  return prefix + p;
}

function promptFromSendBody(raw) {
  let obj = raw;
  if (Buffer.isBuffer(raw) || typeof raw === 'string') {
    try { obj = JSON.parse(String(raw)); } catch { return String(raw || ''); }
  }
  if (!obj || typeof obj !== 'object') return '';
  const pick = (v) => (typeof v === 'string' && v.trim() ? v : '');
  let fromMsgs = '';
  if (Array.isArray(obj.messages)) {
    for (let i = obj.messages.length - 1; i >= 0; i--) {
      const m = obj.messages[i];
      fromMsgs = pick(m?.content) || pick(m?.text) || pick(m?.prompt);
      if (fromMsgs) break;
    }
  }
  return pick(obj.prompt) || pick(obj.text) || pick(obj.message)
    || pick(obj.content) || pick(obj.input)
    || pick(obj.message?.content) || pick(obj.message?.text)
    || fromMsgs
    || '';
}

let walletUsdCache = { usd: null, at: 0 };
async function walletUsdCached() {
  if (walletUsdCache.usd != null && Date.now() - walletUsdCache.at < 8_000) return walletUsdCache.usd;
  try {
    const { affordableUsd } = await import('./info.js');
    const n = await Promise.race([
      affordableUsd(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('balance timeout')), 4000)),
    ]);
    if (Number.isFinite(n)) {
      walletUsdCache = { usd: Number(n), at: Date.now() };
      return walletUsdCache.usd;
    }
  } catch { /* keep last */ }
  return walletUsdCache.usd;
}

async function zooSpendOverlay(data) {
  const x = data?.x402 || {};
  let info = {};
  try {
    const r = await fetch('http://127.0.0.1:8402/v1/info', { signal: AbortSignal.timeout(1500) });
    if (r.ok) info = await r.json();
  } catch { /* */ }
  let session = {};
  try {
    session = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.openzoo', 'session.json'), 'utf8'));
  } catch { /* */ }
  const spent = Number(info.spendUsd ?? session.spentUsd ?? x.billedUsd ?? 0);
  const would = Number(info.directUsd ?? session.directUsd ?? x.directUsd ?? 0);
  const saved = Number(info.savedUsd ?? Math.max(0, would - spent));
  const pct = would > 0 ? (100 * saved / would) : 0;
  const credit = Number(info.creditUsd);
  const wallet = await walletUsdCached();
  const bal = Number.isFinite(wallet) && wallet > 0.004
    ? wallet
    : (Number.isFinite(credit) && credit > 0.004 ? credit : null);
  return formatSpendFooter({
    billedUsd: x.billedUsd,
    directUsd: x.directUsd,
    spent,
    would,
    saved,
    pct,
    balance: bal,
    x402: x,
  });
}

const MODELS_PATH = path.join(os.homedir(), '.openzoo', 'grokbot-models.json');
function loadAgentModels() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(MODELS_PATH, 'utf8'))));
  } catch { return new Map(); }
}
function saveAgentModels() {
  try {
    fs.mkdirSync(path.dirname(MODELS_PATH), { recursive: true });
    fs.writeFileSync(MODELS_PATH, JSON.stringify(Object.fromEntries(agentModels)));
  } catch { /* */ }
}
const agentModels = loadAgentModels();
const MODEL_ALIASES = {
  fable: 'anthropic/claude-fable-5',
  'fable-5': 'anthropic/claude-fable-5',
  'claude-fable-5': 'anthropic/claude-fable-5',
  opus: 'anthropic/claude-opus-5',
  'opus-5': 'anthropic/claude-opus-5',
  sonnet: 'anthropic/claude-sonnet-5',
  grok: 'x-ai/grok-4.6',
  'grok-4': 'x-ai/grok-4.6',
  'grok-4.6': 'x-ai/grok-4.6',
  glm: 'zai-org/glm-5.3-flash',
  'glm-5': 'zai-org/glm-5.3-flash',
  'glm-5.3': 'zai-org/glm-5.3-flash',
  'glm-5.3-flash': 'zai-org/glm-5.3-flash',
  flash: 'zai-org/glm-5.3-flash',
  abliterated: 'abliterated-model-large-v2',
  ablit: 'abliterated-model-large-v2',
  'abliterated-large': 'abliterated-model-large-v2',
  'abliterated-small': 'abliterated-model',
};
async function resolveModelId(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const lower = s.toLowerCase().replace(/^\/+/, '');
  if (MODEL_ALIASES[lower]) return MODEL_ALIASES[lower];
  if (s.includes('/')) return s;
  // No vendor prefix and no alias: the LIVE catalog decides, not this file.
  // The zoo serves ids with no slash at all (abliterated-model*), and a
  // hardcoded "must contain /" rule rejected every one of them.
  try {
    const ids = await zooModelIds();
    return ids.find((id) => id === s) || ids.find((id) => id.toLowerCase() === lower) || null;
  } catch { return null; }
}
function currentModel(agentId) {
  return agentModels.get(agentId)
    || process.env.OPENZOO_DEFAULT_MODEL
    || 'x-ai/grok-4.6';
}

const execFileAsync = promisify(execFile);
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|svg)$/i;
const IMAGE_MAGIC = [
  [Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png'],
  [Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'],
  [Buffer.from('GIF8'), 'image/gif'],
  [Buffer.from('RIFF'), 'image/webp'],
];
function mimeFromBytes(buf, p = '') {
  if (IMAGE_EXT.test(p)) {
    const ext = path.extname(p).toLowerCase();
    return { 'png': 'image/png', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.heic': 'image/heic', '.svg': 'image/svg+xml' }[ext] || 'image/png';
  }
  for (const [magic, mime] of IMAGE_MAGIC) {
    if (buf.length >= magic.length && buf.subarray(0, magic.length).equals(magic)) return mime;
  }
  return null;
}
function dataUrlsFromRichText(rt) {
  const s = String(rt || '');
  const out = [];
  const re = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/]+=*/g;
  let m;
  while ((m = re.exec(s))) out.push(m[0]);
  return out;
}
function attachmentList(parsed, prompt) {
  const out = [];
  const seen = new Set();
  const add = (raw, name) => {
    if (!raw || seen.has(raw)) return;
    seen.add(raw);
    out.push({ raw, name });
  };
  const paths = parsed?.attachmentPaths;
  const names = parsed?.attachmentNames;
  if (Array.isArray(paths)) {
    for (let i = 0; i < paths.length; i++) add(String(paths[i]), names?.[i]);
  }
  for (const p of extractLocalPaths(prompt)) {
    if (/[*?]/.test(p)) continue;
    add(p);
  }
  const rt = String(parsed?.richText || '');
  const srcRe = /(?:src|path|filePath|url)"?\s*[:=]\s*"((?:file:\/\/|\/(?:var|tmp|private|Users)|~\/)[^"]+\.(?:png|jpe?g|gif|webp|bmp|heic))"/gi;
  let sm;
  while ((sm = srcRe.exec(rt))) {
    add(sm[1].replace(/^file:\/\//, ''));
  }
  return out;
}

async function readLocalBytes(abs, log) {
  if (localExecSse.size > 0) {
    log(`cursor-backend:      local-exec download ${abs}`);
    const got = await localExecAsk({ kind: 'download', path: abs });
    return got.bytes || Buffer.from(got.text || '', 'utf8');
  }
  return fs.readFileSync(abs);
}
async function writeLocalBytes(abs, bytes, log) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ''), 'utf8');
  if (localExecSse.size > 0) {
    log(`cursor-backend:      local-exec upload ${abs} ${buf.length}b`);
    await localExecAsk({
      kind: 'upload',
      path: abs,
      bytesBase64: buf.toString('base64'),
    });
    return `wrote ${abs} (${buf.length} bytes) via local-exec`;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  return `wrote ${abs} (${buf.length} bytes)`;
}
async function execLocal(command, cwd, log) {
  let dir = cwd ? expandUserPath(cwd) : os.homedir();
  try {
    if (!fs.statSync(dir).isDirectory()) dir = os.homedir();
  } catch {
    // Node reports spawn /bin/zsh ENOENT when cwd is missing — not a missing shell.
    try { fs.mkdirSync(dir, { recursive: true }); } catch { dir = os.homedir(); }
  }
  if (localExecSse.size > 0) {
    log(`cursor-backend:      local-exec exec ${JSON.stringify(command).slice(0, 80)}`);
    const got = await localExecAsk({
      kind: 'exec',
      serverMessage: { command, cwd: dir, workingDirectory: dir },
    }, 60000);
    const out = got.stdout || got.message || '';
    const err = got.stderr ? `\nstderr:\n${got.stderr}` : '';
    return `${out}${err}`.trim() || `(exit ${got.exitCode ?? 0})`;
  }
  log(`cursor-backend:      exec cwd=${dir} ${JSON.stringify(String(command).slice(0, 80))}`);
  const execMs = Math.min(180000, Math.max(15000, Number(process.env.OPENZOO_EXEC_TIMEOUT_MS || 90000)));
  const { stdout, stderr } = await execFileAsync('/bin/zsh', ['-lc', command], {
    cwd: dir,
    timeout: execMs,
    maxBuffer: 2 * 1024 * 1024,
    env: process.env,
  });
  return `${stdout || ''}${stderr ? `\nstderr:\n${stderr}` : ''}`.trim() || '(no output)';
}

const LOCAL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file on the user\'s Mac. Use this for any local path.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a file on the user\'s Mac. Put HTML/games/code on disk — do not dump huge files in chat.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'exec',
      description: 'Run a shell command on the user\'s Mac (zsh -lc). Use for npm, curl, ls, git, installing MCP, etc.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' }, cwd: { type: 'string' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List a directory on the user\'s Mac.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description: 'Capture the Mac display and attach the image. Returns screen.width/height in POINTS for click x,y. Screenshot first, then click/type, then screenshot again to confirm. Do not guess at a form you have not seen this turn.',
      parameters: {
        type: 'object',
        properties: {
          window: { type: 'string', description: 'Optional window title substring; default is the full display.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Click the Mac UI. Prefer query (AX title/button text like "Submit" or "Complete form"). Or x,y in SCREEN POINTS from screenshot.screen (not image pixels). Use image_x/image_y if you measured the attached screenshot. This is how you fill and submit browser forms.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          image_x: { type: 'number', description: 'X in the attached screenshot pixels; mapped via last screenshot.' },
          image_y: { type: 'number' },
          query: { type: 'string', description: 'Visible name: Submit, Complete form, Compose, …' },
          app: { type: 'string', description: 'Brave Browser, Brave, Grok Bot, …' },
          button: { type: 'string', enum: ['left', 'right'] },
          double: { type: 'boolean' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description: 'Type into the focused field. Click the field first. Long text is pasted. Use this to fill form inputs.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          paste: { type: 'boolean' },
          app: { type: 'string' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'key',
      description: 'Press a key. enter/return submits, tab moves fields, escape cancels. cmd+l focuses the URL bar.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'enter, tab, escape, space, a letter, or a named key' },
          cmd: { type: 'boolean' },
          alt: { type: 'boolean' },
          shift: { type: 'boolean' },
          ctrl: { type: 'boolean' },
          app: { type: 'string' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ui_tree',
      description: 'Dump clickable AX controls of the front window (or app) with screen x,y. Use to find Submit/text fields when the screenshot is ambiguous.',
      parameters: {
        type: 'object',
        properties: {
          app: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'focus_app',
      description: 'Bring an app to the front. Use "Brave Browser" before clicking Gmail/Stripe.',
      parameters: {
        type: 'object',
        properties: { app: { type: 'string' } },
        required: ['app'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Open an http(s) URL in Brave (or app). Prefer this over guessing at the address bar.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          app: { type: 'string' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_agent',
      description: 'Mint another Grok Bot in the sidebar. Pass brief so they keep their job across restarts.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Sidebar label for the new bot.' },
          brief: { type: 'string', description: 'Standing job. Persisted. Injected as their system brief on every turn.' },
          select: { type: 'boolean', description: 'If true (default), switch the UI to the new bot.' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_brief',
      description: 'Save a standing brief on a sidebar bot (this one if agent omitted). Survives hijack restart.',
      parameters: {
        type: 'object',
        properties: {
          brief: { type: 'string' },
          agent: { type: 'string', description: 'Name or id. Default: the current bot.' },
        },
        required: ['brief'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_agents',
      description: 'List sidebar bots with id, name, brief. Use before message_agent.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'message_agent',
      description: 'Send text to another sidebar bot by name or id, wait for their reply, paint it on their canvas. One hop — do not chain.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Name or id of the other bot.' },
          text: { type: 'string' },
        },
        required: ['to', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_wakeup',
      description: 'Host timer that keeps this bot working with no human message. "never stop" / cron. Default every 5m. Min 60s. Does not spawn bots.',
      parameters: {
        type: 'object',
        properties: {
          every: { type: 'string', description: '5m, 1h, 90s. Default 5m. Floor 60s.' },
          prompt: { type: 'string', description: 'What to do on each tick.' },
          agent: { type: 'string', description: 'Name or id. Default: this bot.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_wakeup',
      description: 'Stop the host wakeup timer for this bot (or agent).',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ship_crew',
      description: 'Grok Ship: set up the factory for a repo. Creates Firstmate (once) and one crewmate bot for this repo with standing briefs, detects the forge (gh/glab). Call when the user asks for a software factory / Grok Ship / crew for a repo.',
      parameters: {
        type: 'object',
        properties: { cwd: { type: 'string', description: 'Repo path on this Mac.' } },
        required: ['cwd'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ship_forge',
      description: 'Grok Ship: detect the source-control forge for a repo (github/gitlab/bitbucket/origin) and which CLI is authenticated (gh/glab). Do not assume GitHub.',
      parameters: { type: 'object', properties: { cwd: { type: 'string' } }, required: ['cwd'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ship_launch_worker',
      description: 'Grok Ship: start a coding worker (claude-zoo, paid via x402) in a fresh git worktree on a new branch. Returns a task id. Pass the same task id again to send review findings back to the same branch. Never opens a PR.',
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Repo path.' },
          title: { type: 'string' },
          prompt: { type: 'string', description: 'Goal, acceptance criteria, constraints. Or the review findings on a follow-up.' },
          base: { type: 'string', description: 'Base branch. Default: origin HEAD.' },
          task: { type: 'string', description: 'Existing task id to resume on its branch.' },
        },
        required: ['cwd', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ship_status',
      description: 'Grok Ship: is the worker alive, did it push, what did it commit, log tail. Poll this (with schedule_wakeup) instead of guessing.',
      parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ship_review',
      description: 'Grok Ship: FRESH adversarial review of the pushed branch (one-shot, no chat history, only the diff). Returns findings + gate. Run after every push, before any PR.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          cwd: { type: 'string', description: 'Without a task: repo path.' },
          branch: { type: 'string' },
          base: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ship_open_pr',
      description: 'Grok Ship: open the PR/MR for a task. Refuses unless the last ship_review gate is clean and the branch is on origin. Never merges.',
      parameters: {
        type: 'object',
        properties: { task: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } },
        required: ['task'],
      },
    },
  },
];

export const LOCAL_TOOL_NAMES = LOCAL_TOOLS.map((t) => t.function.name);

function liveTools() {
  const extra = hostMcpTools();
  return extra.length ? [...LOCAL_TOOLS, ...extra] : LOCAL_TOOLS;
}

async function captureScreenshot(log) {
  const dir = path.join(os.tmpdir(), 'openzoo-screens');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now();
  const raw = path.join(dir, `oz-${stamp}.png`);
  const jpg = path.join(dir, `oz-${stamp}.jpg`);
  await execFileAsync('screencapture', ['-x', '-C', raw], { timeout: 15000 });
  if (!fs.existsSync(raw) || fs.statSync(raw).size < 80) {
    throw new Error('screencapture wrote nothing — Screen Recording permission may be off for Grok Bot / Terminal');
  }
  let screen = { width: 0, height: 0 };
  try { screen = await displayBounds(); } catch (e) {
    log(`cursor-backend:      displayBounds failed: ${e.message}`);
  }
  let out = { path: raw, mime: 'image/png', buf: fs.readFileSync(raw) };
  try {
    await execFileAsync('sips', [
      '-Z', '1400', '-s', 'format', 'jpeg', '-s', 'formatOptions', '70',
      raw, '--out', jpg,
    ], { timeout: 15000 });
    if (fs.existsSync(jpg) && fs.statSync(jpg).size > 80) {
      out = { path: jpg, mime: 'image/jpeg', buf: fs.readFileSync(jpg) };
    }
  } catch (e) {
    log(`cursor-backend:      sips screenshot resize failed: ${e.message}`);
  }
  let image = { width: 0, height: 0 };
  try { image = await imageSize(out.path); } catch (e) {
    log(`cursor-backend:      imageSize failed: ${e.message}`);
  }
  const meta = { path: out.path, mime: out.mime, buf: out.buf, screen, image };
  noteShotMeta({ screen, image, path: out.path });
  return meta;
}

function findAgent(q) {
  const list = cachedAgentList() || [];
  const s = String(q || '').trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  return list.find((a) => a.id === s)
    || list.find((a) => String(a.name || '').toLowerCase() === lower)
    || list.find((a) => String(a.name || '').toLowerCase().includes(lower))
    || null;
}

let messageAgentDepth = 0;
async function deliverAgentMessage({ fromId, to, text, parsed = {}, log }) {
  const dest = findAgent(to);
  if (!dest) return `ERROR no bot named ${JSON.stringify(to)}. list_agents first.`;
  if (fromId && dest.id === String(fromId)) return 'ERROR cannot message_agent yourself';
  const msg = String(text || '').trim();
  if (!msg) return 'ERROR empty message';
  if (messageAgentDepth >= 1) return 'ERROR message_agent is one hop — reply in chat instead of chaining';
  const from = findAgent(fromId);
  const fromName = from?.name || 'another bot';
  const nonce = `oz-msg-${Date.now()}`;
  const prompt = `[message from ${fromName}]\n${msg}`;
  messageAgentDepth += 1;
  try {
    const userLine = fanoutLine(dest.id, 'user', prompt, { clientNonce: nonce, requestId: nonce });
    ssePush('transcript', { ...gatewayEntry(userLine), agentId: dest.id });
    bumpAgent(dest.id, { preview: msg, notify: true });
    const z = await zooComplete(prompt, log, dest.id, { ...parsed, visitor: undefined });
    const reply = String(z.text || '');
    const line = fanoutLine(dest.id, 'assistant', reply, { clientNonce: nonce, requestId: nonce });
    ssePush('transcript', { ...gatewayEntry(line), agentId: dest.id });
    bumpAgent(dest.id, { preview: reply, notify: true });
    return JSON.stringify({
      ok: true,
      to: { id: dest.id, name: dest.name },
      reply: stripSpendFooter(reply).slice(0, 4000),
    });
  } finally {
    messageAgentDepth -= 1;
  }
}

async function runLocalTool(name, args, log, ctx = {}) {
  try {
    if (name === 'read_file') {
      const buf = await readLocalBytes(expandUserPath(args.path), log);
      if (buf.length > 180000) return `file ${args.path} is ${buf.length} bytes; first 180000:\n${buf.subarray(0, 180000).toString('utf8')}`;
      return buf.toString('utf8');
    }
    if (name === 'write_file') {
      return await writeLocalBytes(expandUserPath(args.path), args.content ?? '', log);
    }
    if (name === 'list_dir') {
      const abs = expandUserPath(args.path || os.homedir());
      if (localExecSse.size > 0) {
        const got = await localExecAsk({ kind: 'exec', serverMessage: { command: `ls -la ${JSON.stringify(abs)}`, cwd: os.homedir() } });
        return got.stdout || got.message || '';
      }
      return fs.readdirSync(abs, { withFileTypes: true })
        .map((e) => `${e.isDirectory() ? 'd' : '-'} ${e.name}`)
        .join('\n');
    }
    if (name === 'exec') {
      return await execLocal(String(args.command || ''), args.cwd, log);
    }
    if (name === 'screenshot') {
      const shot = await captureScreenshot(log);
      return JSON.stringify({
        ok: true,
        path: shot.path,
        mime: shot.mime,
        bytes: shot.buf.length,
        screen: shot.screen,
        image: shot.image,
        click: 'x,y are SCREEN points (screenshot.screen). Or pass image_x,image_y from this image. Prefer click query="Submit".',
        dataUrl: `data:${shot.mime};base64,${shot.buf.toString('base64')}`,
      });
    }
    if (name === 'click') {
      const got = await desktopAction('click', args, log);
      return JSON.stringify(got);
    }
    if (name === 'type_text') {
      const got = await desktopAction('type', args, log);
      return JSON.stringify(got);
    }
    if (name === 'key') {
      const got = await desktopAction('key', args, log);
      return JSON.stringify(got);
    }
    if (name === 'ui_tree') {
      const got = await desktopAction('tree', args, log);
      return JSON.stringify(got);
    }
    if (name === 'focus_app') {
      const got = await desktopAction('focus', { app: resolveAppName(args.app) }, log);
      return JSON.stringify(got);
    }
    if (name === 'open_url') {
      const got = await desktopAction('open_url', args, log);
      return JSON.stringify(got);
    }
    if (name === 'create_agent') {
      const name = String(args.name || args.title || 'New Bot').slice(0, 80);
      const brief = String(args.brief || args.instructions || '').trim() || briefFromName(name);
      const agent = mintLocalAgent({ name, brief });
      pushCreatedAgent(agent, { select: args.select !== false });
      seedBriefOnCanvas(agent);
      const n = (cachedAgentList() || []).length;
      log(`cursor-backend:      create_agent tool id=${agent.id} name=${JSON.stringify(agent.name)} brief=${brief ? brief.length : 0}c`);
      const warning = n >= 8
        ? `Mac already has ${n} bots. Prefer schedule_wakeup over spawning. Only mint a NEW named role.`
        : undefined;
      return JSON.stringify({ ok: true, id: agent.id, name: agent.name, brief: agent.brief || '', warning });
    }
    if (name === 'set_brief') {
      const who = findAgent(args.agent || args.id || args.name) || findAgent(ctx.agentId);
      if (!who) return 'ERROR no such agent';
      const agent = mintLocalAgent({ id: who.id, name: who.name, brief: String(args.brief || '') });
      return JSON.stringify({ ok: true, id: agent.id, name: agent.name, brief: agent.brief || '' });
    }
    if (name === 'list_agents') {
      const list = cachedAgentList() || [];
      const wakes = readWakeups(HOME);
      return JSON.stringify(list.map((a) => ({
        id: a.id,
        name: a.name,
        brief: String(a.brief || '').slice(0, 120),
        wakeup: wakes[a.id] ? { everySec: wakes[a.id].everySec, nextAt: wakes[a.id].nextAt } : null,
      })));
    }
    if (name === 'message_agent') {
      return await deliverAgentMessage({
        fromId: ctx.agentId,
        to: args.to || args.agent,
        text: args.text || args.message || args.prompt,
        parsed: ctx.parsed,
        log,
      });
    }
    if (name === 'schedule_wakeup') {
      const who = findAgent(args.agent || args.id || args.name) || findAgent(ctx.agentId);
      if (!who) return 'ERROR no such agent';
      const got = scheduleAgentWakeup(who.id, { every: args.every, prompt: args.prompt });
      return JSON.stringify(got);
    }
    if (name === 'cancel_wakeup') {
      const who = findAgent(args.agent || args.id || args.name) || findAgent(ctx.agentId);
      if (!who) return 'ERROR no such agent';
      return JSON.stringify(cancelAgentWakeup(who.id));
    }
    if (name.startsWith('ship_')) {
      return await runShipTool(name, args, log, ctx);
    }
    if (hostMcpHas(name)) {
      return await callHostMcp(name, args);
    }
    return `unknown tool ${name}`;
  } catch (e) {
    return `ERROR ${e.message}`;
  }
}

/** Grok Ship tools. `run` is execLocal so workers/PRs use the same shell the bot does. */
async function runShipTool(name, args, log, ctx = {}) {
  const run = (command, cwd) => execLocal(command, cwd, log);
  const home = HOME;
  if (name === 'ship_forge') {
    const cwd = expandUserPath(String(args.cwd || ''));
    return JSON.stringify(await ship.probeForge(cwd, run));
  }
  if (name === 'ship_crew') {
    const cwd = expandUserPath(String(args.cwd || ''));
    const forge = await ship.probeForge(cwd, run);
    const list = cachedAgentList() || [];
    let firstmate = list.find((a) => /^firstmate$/i.test(String(a.name || '')));
    if (!firstmate) {
      firstmate = mintLocalAgent({ name: 'Firstmate', brief: ship.firstmateBrief() });
      pushCreatedAgent(firstmate, { select: false });
      seedBriefOnCanvas(firstmate, log);
    }
    const repoName = path.basename(cwd);
    let crew = list.find((a) => String(a.brief || '').includes(`crewmate for the repo at ${cwd}`));
    if (!crew) {
      crew = mintLocalAgent({ name: `Crew · ${repoName}`, brief: ship.crewmateBrief({ repo: cwd, forge: forge.forge }) });
      pushCreatedAgent(crew, { select: false });
      seedBriefOnCanvas(crew, log);
    }
    log(`cursor-backend:      ship_crew repo=${cwd} forge=${forge.forge} cli=${forge.cli} firstmate=${firstmate.id} crew=${crew.id}`);
    return JSON.stringify({
      ok: true,
      forge,
      firstmate: { id: firstmate.id, name: firstmate.name },
      crewmate: { id: crew.id, name: crew.name },
      next: forge.cli ? 'Talk to Firstmate. It hands ship tasks to the crewmate.' : `No authenticated forge CLI (${forge.forge}); run gh auth login / glab auth login on this Mac before ship_open_pr.`,
    });
  }
  if (name === 'ship_launch_worker') {
    const cwd = expandUserPath(String(args.cwd || ''));
    const task = await ship.launchWorker({
      cwd, title: args.title, prompt: args.prompt, base: args.base, taskId: args.task, home, run, log,
    });
    return JSON.stringify({ ok: true, task: task.id, branch: task.branch, base: task.base, worktree: task.worktree, log: task.log, pid: task.pid, attempts: task.attempts });
  }
  if (name === 'ship_status') {
    return JSON.stringify(await ship.taskStatus({ taskId: String(args.task || ''), home, run }));
  }
  if (name === 'ship_review') {
    const got = await ship.reviewBranch({
      taskId: args.task ? String(args.task) : undefined,
      cwd: args.cwd ? expandUserPath(String(args.cwd)) : undefined,
      branch: args.branch, base: args.base,
      model: currentModel(ctx.agentId), home, run, log,
    });
    return JSON.stringify(got);
  }
  if (name === 'ship_open_pr') {
    return JSON.stringify(await ship.openPr({ taskId: String(args.task || ''), title: args.title, body: args.body, home, run, log }));
  }
  return `unknown tool ${name}`;
}

/** Model parked instead of writing files. Host keeps the tool loop going. */
export function looksStoppedReply(s) {
  return /stopped on research|no (?:new )?app files written|nothing (?:extra )?to open yet|say go again|next message i['’]?ll write|stopped — no new/i.test(String(s || ''));
}

function zooTextFromMessage(msg, data) {
  let c = msg?.content;
  if (Array.isArray(c)) {
    c = c.map((p) => (typeof p === 'string' ? p : (p?.text || p?.content || ''))).join('');
  }
  if (typeof c === 'string' && c.trim()) return c;
  if (typeof data?.error?.message === 'string' && data.error.message) return data.error.message;
  return '';
}

async function zooComplete(prompt, log, agentId, parsed = {}, opts = {}) {
  const model = currentModel(agentId);
  const helper = localExecSse.size > 0;
  const visitor = visitorFromSend(parsed);
  const chatOnly = Boolean(visitor);
  const spoken = visitor && !/^You are /.test(String(prompt || ''))
    ? labeledVisitorPrompt(visitor, prompt)
    : prompt;
  const throwIfAborted = () => {
    if (opts.signal?.aborted) throw new Error('superseded');
  };
  await ensureTranscriptHydrated(agentId, log);
  log(`cursor-backend:      zoo POST :8402 model=${model} helper=${helper ? localExecSse.size : 0} hist=${historyMessages(agentId, spoken).length}${chatOnly ? ` visitor=${visitor.shortname} chat-only` : ''} ${JSON.stringify((spoken || '').slice(0, 60))}`);
  if (typeof opts.onProgress === 'function') opts.onProgress('Working on your Mac…');

  const images = [];
  const textFiles = [];
  for (const { raw, name } of attachmentList(parsed, prompt)) {
    const uploaded = lookupUpload(raw);
    if (uploaded) {
      if (uploaded.mime && uploaded.mime.startsWith('image/')) {
        images.push({
          path: raw,
          mime: uploaded.mime,
          dataUrl: `data:${uploaded.mime};base64,${uploaded.buf.toString('base64')}`,
        });
        log(`cursor-backend:      attached image ${raw} ${uploaded.mime} ${uploaded.bytes}b`);
      } else {
        textFiles.push({ path: raw, abs: uploaded.abs, text: uploaded.buf.toString('utf8') });
      }
      continue;
    }
    // Public visitors must not trigger local file reads on this Mac.
    // Uploads above are bytes they posted to us, not a host path.
    if (chatOnly) continue;
    const abs = expandUserPath(raw);
    try {
      const buf = await readLocalBytes(abs, log);
      const mime = mimeFromBytes(buf, name || raw);
      if (mime) {
        images.push({ path: raw, mime, dataUrl: `data:${mime};base64,${buf.toString('base64')}` });
        log(`cursor-backend:      attached image ${raw} ${mime} ${buf.length}b`);
      } else {
        textFiles.push({ path: raw, abs, text: buf.toString('utf8') });
      }
    } catch (e) {
      textFiles.push({ path: raw, abs, error: e.message });
    }
  }
  for (const url of dataUrlsFromRichText(parsed.richText)) {
    images.push({ path: '(richText)', mime: 'image', dataUrl: url });
  }

  const via = helper ? 'Grok Bot Helper local-exec SSE' : 'this Mac (hijack process; Helper SSE not connected yet)';
  const messages = [
    {
      role: 'system',
      content: chatOnly
        ? [
          `You are ${model} served through openzoo inside Grok Bot.`,
          'This is a public visitor chat. You do not have filesystem, shell, or local-exec access on the host Mac.',
          'Reply in chat only. Do not claim you will write files, run commands, or use local tools.',
          'Each human line is prefixed with that visitor\'s shortname and a colon, like "rex: hello". Different shortnames are different people. Address them by that name.',
          'A spend footer is appended after your reply by the host -- ignore it.',
          'Prior turns of THIS Grok Bot chat are in the messages below. Do not claim the thread starts blank or that earlier questions did not arrive.',
        ].join(' ')
        : [
          `You are ${model} served through openzoo inside Grok Bot.`,
          (() => {
            const me = (cachedAgentList() || []).find((a) => a.id === agentId);
            const brief = me ? agentBrief(me) : '';
            const who = me?.name ? `You are "${me.name}" in this Grok Bot sidebar.` : '';
            return brief ? `${who} Standing brief (persisted): ${brief}` : who;
          })(),
          `You HAVE local tools on the user's computer via ${via}.`,
          'Tools: read_file, write_file, exec, list_dir, screenshot, click, type_text, key, ui_tree, focus_app, open_url, create_agent, set_brief, list_agents, message_agent, schedule_wakeup, cancel_wakeup, ship_crew, ship_forge, ship_launch_worker, ship_status, ship_review, ship_open_pr.',
          'If no sidebar bot is named Firstmate and the human brings code or repo work, ask ONE question: which repo path to set up Grok Ship for. Then call ship_crew with that cwd. Do not start coding outside the factory.',
          'Grok Ship (software factory): ship_crew sets up Firstmate + a crewmate per repo. A crewmate ships with ship_launch_worker -> ship_status until pushed -> ship_review (fresh, diff-only) -> ship_open_pr only when gate.clean. Never merge; the human does.',
          (() => {
            const extra = hostMcpTools();
            const names = extra.map((t) => t.function.name);
            const servers = hostMcpServers();
            if (!names.length) {
              return 'Host MCP servers (Claude/Grok chrome-devtools, brave, …) are connecting. When chrome-devtools__* tools appear, use them for web pages.';
            }
            const chrome = names.filter((n) => /chrome|devtools|browser/i.test(n));
            return [
              `Host MCP tools from the user's local Claude/Grok config are attached (${servers.join(', ') || 'mcp'}): ${names.slice(0, 36).join(', ')}${names.length > 36 ? '…' : ''}.`,
              chrome.length
                ? `For any web page or HTML form, use chrome-devtools tools (navigate_page / take_snapshot / fill / click). Do NOT use osascript, Quartz, Python Foundation, or AppleScript to read Brave. screenshot/click/type_text are for native Mac UI only. Browser mode: ${chromeStatus().mode}.${chromeStatus().hint ? ` If the human needs their logged-in browser, tell them once: ${chromeStatus().hint}` : ' This is the human\'s real logged-in browser; do not log out or change its settings.'}`
                : 'Use matching MCP tools instead of inventing shell one-liners.',
            ].join(' ');
          })(),
          'create_agent mints a sidebar bot. ALWAYS pass brief so they keep the job across restart. set_brief updates it. list_agents + message_agent talk to other bots (one hop). Do not tell the human to copy-paste between canvases.',
          'NEVER STOP / cron / keep working between human messages: call schedule_wakeup every="5m". That is a host timer. There is no crontab. Do not spawn more bots for persistence. Do not re-read SITREP-NOW.md or STANDING-ORDERS.md every turn — do the next file or click. exec sysctl/uptime is not the job. If the tray already has named workers, answer "no" to spawning more.',
          'You CAN click the Mac and fill/submit browser forms. That is required when the user asks. Do not write a markdown briefing instead of clicking. Do not tell the user to click.',
          'Form loop: if chrome-devtools MCP tools exist, navigate_page + take_snapshot + fill the fields + click the submit button. Else fallback: focus_app Brave Browser → screenshot → click the field → type_text → screenshot → click Submit.',
          'screenshot captures the display and attaches the image. For any on-screen form, dashboard, or click target, screenshot first this turn. Do not guess at UI you have not seen.',
          'Pasted images arrive as attachments — you can see them when present. Do not claim you cannot see images if they are in this turn.',
          'Never claim you lack filesystem access or local-exec. If a tool errors, report the error.',
          'After using tools you MUST still write a normal chat reply: what you did, file paths written, and what to open. Empty content is a bug. A new user message cancels this turn — leave a visible reply before that happens.',
          'Do not stop mid-task. Do not write "Stopped on research", "nothing to open yet", "no app files written this turn", or "say go again". Keep using tools until the files the user asked for exist on disk THIS turn. Summarize only after those writes succeed.',
          'A spend footer is appended after your reply by the host — ignore it.',
          'The operator wallet pays every zoo call via x402 (TOKEN/USDC on Solana; SOL gas is sponsored). If this thread has a spend footer or solscan/basescan tx, the call WAS paid. Do not say you have no money, cannot afford tools, or need the human to fund you. A 402/underfunded tool error is a host retry — continue the job.',
          'Prior turns of THIS Grok Bot chat are in the messages below. Do not claim the thread starts blank or that earlier questions did not arrive.',
        ].join(' '),
    },
  ];
  for (const m of historyMessages(agentId, spoken)) messages.push(m);
  if (textFiles.length) {
    const bits = textFiles.map((a) => (
      a.error
        ? `FILE ${a.path} ERROR: ${a.error}`
        : `FILE ${a.path} (${a.abs})\n${String(a.text).slice(0, 180000)}`
    ));
    messages.push({ role: 'user', content: bits.join('\n\n') });
  }

  const userContent = [];
  for (const img of images) {
    userContent.push({ type: 'image_url', image_url: { url: img.dataUrl } });
  }
  userContent.push({ type: 'text', text: spoken || (images.length ? '(see attached image)' : 'hello') });
  messages.push({
    role: 'user',
    content: userContent.length === 1 && userContent[0].type === 'text'
      ? userContent[0].text
      : userContent,
  });

  const maxTok = Number(process.env.OPENZOO_ASK_MAX_TOKENS || 8192);
  const maxSteps = Math.min(64, Math.max(8, Number(process.env.OPENZOO_ASK_TOOL_STEPS || 32)));
  let lastData = {};
  let turnX402 = {};
  let text = '';
  const usedTools = [];
  const KEEP_GOING = 'Do not stop. Do not wait for another message. Write the files to disk now with write_file / exec. Keep going until the requested paths exist. A summary is only allowed after the files are written.';
  const zooPost = async (payload) => {
    throwIfAborted();
    const ms = Number(process.env.OPENZOO_ASK_TIMEOUT_MS || 10 * 60_000);
    const post = () => fetch('http://127.0.0.1:8402/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-openzoo' },
      body: JSON.stringify(payload),
      signal: combinedAbortSignal(opts.signal, AbortSignal.timeout(ms)),
    });
    let r;
    let lastErr;
    const tries = 5;
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        r = await post();
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        log(`cursor-backend:      zoo POST attempt=${attempt} ${e.message}`);
        if (attempt === tries) throw e;
        const abortish = /abort|timeout/i.test(String(e?.name || '') + String(e?.message || ''));
        await new Promise((ok) => setTimeout(ok, (abortish ? 2000 : 800) * attempt));
      }
    }
    if (!r) throw lastErr || new Error('zoo POST failed');
    if (r.status === 402) {
      for (let i = 0; i < 4 && r && r.status === 402; i++) {
        log(`cursor-backend:      x402 402 — dwell/retry ${i + 1}/4`);
        await new Promise((ok) => setTimeout(ok, 1500 * (i + 1)));
        try { r = await post(); } catch (e) { log(`cursor-backend:      zoo POST after 402 ${e.message}`); }
      }
    }
    const data = await r.json().catch(() => ({}));
    if (r.status === 402) {
      const raw = zooTextFromMessage(data?.choices?.[0]?.message, data)
        || data?.error?.message
        || 'openzoo wallet underfunded.';
      try {
        const { withOnrampLink } = await import('./stripeOnramp.js');
        const { loadOrCreateWallet } = await import('./wallet.js');
        const w = loadOrCreateWallet();
        const usd = Number(String(raw).match(/≈\$([0-9.]+)/)?.[1]);
        data.error = data.error || {};
        data.error.message = await withOnrampLink(raw, {
          solana: w.keypair.publicKey.toBase58(),
          usd,
        });
      } catch { /* keep proxy copy */ }
    }
    return { r, data };
  };
  let keepGoingNudge = 0;
  const pendingVision = [];
  for (let step = 0; step < maxSteps; step++) {
    throwIfAborted();
    const payload = { model, messages, max_tokens: maxTok };
    if (!chatOnly) {
      payload.tools = liveTools();
      payload.tool_choice = 'auto';
    }
    const { r, data } = await zooPost(payload);
    lastData = data;
    turnX402 = mergeTurnProof(turnX402, data);
    const msg = data.choices?.[0]?.message || {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (calls.length) {
      if (chatOnly) {
        log(`cursor-backend:      visitor chat-only ignored ${calls.length} tool calls`);
        messages.push(msg);
        for (const c of calls) {
          messages.push({
            role: 'tool',
            tool_call_id: c.id,
            content: 'local tools are not available to web visitors',
          });
        }
        continue;
      }
      const names = calls.map((c) => c.function?.name || c.name);
      log(`cursor-backend:      zoo tools step=${step} n=${calls.length} ${names.join(',')}`);
      messages.push(msg);
      for (const c of calls) {
        throwIfAborted();
        let args = {};
        try { args = JSON.parse(c.function?.arguments || c.arguments || '{}'); } catch { args = {}; }
        const name = c.function?.name || c.name || '';
        let result = await runLocalTool(name, args, log, { agentId, parsed });
        if (name === 'screenshot') {
          try {
            const shot = JSON.parse(result);
            if (shot?.dataUrl) {
              pendingVision.push({ path: shot.path, dataUrl: shot.dataUrl });
              result = `screenshot ${shot.path} ${shot.bytes}b — image attached, look at it before acting`;
            }
          } catch { /* keep raw */ }
        }
        usedTools.push({
          name,
          path: args.path,
          command: args.command ? String(args.command).slice(0, 120) : undefined,
          note: String(result).slice(0, 200),
        });
        if (typeof opts.onProgress === 'function') {
          opts.onProgress(formatZooToolLine({ name, args, result }));
        }
        messages.push({
          role: 'tool',
          tool_call_id: c.id,
          content: String(result).slice(0, 120000),
        });
      }
      if (pendingVision.length) {
        messages.push({
          role: 'user',
          content: [
            ...pendingVision.map((img) => ({ type: 'image_url', image_url: { url: img.dataUrl } })),
            { type: 'text', text: pendingVision.map((img) => `screenshot: ${img.path}`).join('\n') },
          ],
        });
        pendingVision.length = 0;
      }
      continue;
    }
    text = zooTextFromMessage(msg, data);
    const finish = data.choices?.[0]?.finish_reason || '?';
    log(`cursor-backend:      << zoo ${r.status} ${text.length}c model=${data.model || model} finish=${finish}`);
    // Model likes to park after research ("Stopped on research", "say go again")
    // instead of writing files. Measured 2026-08-30 on volume track00r.
    if (!chatOnly && /wallet underfunded|payment did not settle|needs more than the wallet holds/i.test(text) && keepGoingNudge < 6) {
      keepGoingNudge += 1;
      log(`cursor-backend:      underfunded-nudge=${keepGoingNudge} — not painting broke`);
      messages.push(msg);
      messages.push({
        role: 'user',
        content: 'That 402 is a host retry, not an empty wallet. The operator pays x402. Continue the job with tools. Do not discuss funding or ask the human for money.',
      });
      continue;
    }
    if (!chatOnly && (finish === 'length' || looksStoppedReply(text)) && keepGoingNudge < 6) {
      keepGoingNudge += 1;
      log(`cursor-backend:      keep-going nudge=${keepGoingNudge} finish=${finish}`);
      messages.push(msg);
      messages.push({ role: 'user', content: KEEP_GOING });
      continue;
    }
    break;
  }
  if (usedTools.length && !String(text || '').trim()) {
    const wrote = usedTools.some((t) => t.name === 'write_file');
    messages.push({
      role: 'user',
      content: wrote
        ? 'Write a short chat reply: files written (full paths), commands that mattered, and what the user should open. No empty message.'
        : KEEP_GOING,
    });
    const { r, data } = await zooPost({
      model,
      messages,
      max_tokens: Math.max(800, Math.min(maxTok, 2048)),
    });
    lastData = data;
    turnX402 = mergeTurnProof(turnX402, data);
    text = zooTextFromMessage(data.choices?.[0]?.message, data);
    log(`cursor-backend:      << zoo summary ${r.status} ${text.length}c`);
  }
  if (!String(text || '').trim()) {
    if (usedTools.length) {
      const writes = usedTools.filter((t) => t.name === 'write_file' && t.path).map((t) => t.path);
      const execs = usedTools.filter((t) => t.name === 'exec' && t.command).map((t) => t.command);
      const lines = ['Did local work (no model chat text came back):'];
      if (writes.length) lines.push(`wrote: ${[...new Set(writes)].join(', ')}`);
      if (execs.length) lines.push(`ran: ${execs.slice(-6).join(' · ')}`);
      if (lines.length === 1) lines.push(`${usedTools.length} tool calls.`);
      text = lines.join('\n');
    } else {
      text = '(empty zoo reply)';
    }
  }
  if (lastData && typeof lastData === 'object') {
    lastData.x402 = mergeTurnProof(turnX402, lastData);
  }
  try { text += await zooSpendOverlay(lastData); } catch { /* overlay must never eat the reply */ }
  return { text, data: lastData };
}

async function handleHijackedPodHttp(req, res, full, body, log) {
  if (sniffOn()) {
    const waiting = (full || '').split('?')[0];
    const podPath = waiting === '/health' || waiting === '/healthz' || waiting === '/events'
      || waiting.startsWith('/api/') || waiting.startsWith('/webauthn/')
      || waiting.startsWith('/cookie-origin-approval/');
    if (waiting.startsWith('/local-exec/')) return handleLocalExecHttp(req, res, waiting, body, log);
    if (realPod?.agent && podPath) return proxyPodHttp(req, res, full, body, log);
    if (!podPath) return false;
    if (waiting === '/health' || waiting === '/healthz') {
      jsonSend(res, { ok: true, status: 'ok', ready: true });
      return true;
    }
    return false;
  }
  const path0 = (full || '').split('?')[0];
  if (path0 === '/health' || path0 === '/healthz') {
    jsonSend(res, { ok: true, status: 'ok', ready: true });
    log('cursor-backend:      -> pod /health ok');
    return true;
  }
  if (path0 === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      ...CORS,
    });
    res.write('data: {"channel":"ping","payload":{}}\n\n');
    sseClients.add(res);
    try {
      const list = rosterForEvent(loadAgents() || [], agentActivity);
      const active = topConversationId(list);
      if (active) {
        focusedAgentId = focusedAgentId || active;
        res.write(`data: ${JSON.stringify({
          channel: 'agents',
          payload: {
            agents: list.map((a) => ({ ...a, isActive: a.id === active })),
            activeAgentId: active,
          },
        })}\n\n`);
      }
    } catch { /* first paint must not break SSE */ }
    const iv = setInterval(() => {
      try { res.write('data: {"channel":"ping","payload":{}}\n\n'); } catch { clearInterval(iv); sseClients.delete(res); }
    }, 15000);
    req.on('close', () => { clearInterval(iv); sseClients.delete(res); });
    log('cursor-backend:      -> pod /events sse');
    return true;
  }
  if (path0.startsWith('/webauthn/') || path0.startsWith('/cookie-origin-approval/')) {
    if (req.method === 'GET') jsonSend(res, []);
    else jsonSend(res, { ok: true });
    log(`cursor-backend:      -> pod ${path0}`);
    return true;
  }
  if (!path0.startsWith('/api/')) return false;
  const name = path0.slice('/api/'.length);
  if (name === 'getHostStatus') {
    jsonSend(res, { status: 'ready', ready: true, state: 'ready', hostStatus: 'ready' });
    log('cursor-backend:      -> getHostStatus ready');
    return true;
  }
  if (name === 'uploadAttachment' || name === 'readAttachmentImage'
      || name === 'readAttachmentText' || name === 'readAttachmentChunk') {
    let parsed = {};
    try { parsed = JSON.parse(String(body || '{}')); } catch { parsed = {}; }
    if (name === 'uploadAttachment') {
      const got = ingestUpload({
        filename: parsed.filename,
        bytesBase64: parsed.bytesBase64,
      });
      if (!got.ok) {
        jsonSend(res, { status: 'ok', value: null, ok: false, reason: got.reason });
        log(`cursor-backend:      uploadAttachment ${got.reason || 'failed'}`);
        return true;
      }
      // Dual shape: sendPrompt-style raw `.path` AND CVr `{status,value}`.
      jsonSend(res, { status: 'ok', value: { path: got.path }, path: got.path, ok: true });
      log(`cursor-backend:      uploadAttachment ${got.path} ${got.bytes}b ${got.mime}`);
      return true;
    }
    if (name === 'readAttachmentChunk') {
      const chunk = readUploadChunk({
        path: parsed.path,
        offset: parsed.offset,
        length: parsed.length,
      });
      jsonSend(res, chunk
        ? { status: 'ok', value: chunk, ...chunk }
        : { status: 'ok', value: null });
      log(`cursor-backend:      readAttachmentChunk ${parsed.path || ''} ${chunk ? chunk.totalSize : 'miss'}b`);
      return true;
    }
    if (name === 'readAttachmentImage') {
      const img = readUploadImage(parsed.path);
      jsonSend(res, img ? { status: 'ok', value: img, ...img } : { status: 'ok', value: null });
      return true;
    }
    const text = readUploadText(parsed.path);
    jsonSend(res, text ? { status: 'ok', value: text, ...text } : { status: 'ok', value: null });
    return true;
  }
  // Roster/settings come from the REAL 1340 gateway (names, avatars, trays).
  // Chat stays local so inference is zoo. Discovered on EnsureSandBox rewrite.
  const roster = new Set([
    'listAgents', 'countAgents', 'searchAgents', 'getTrays', 'getHostSettings',
    'setHostSettings', 'getAgentChannels', 'getAgentWorkflows', 'skillsCatalog',
    'getSubagents', 'getAsyncTasks', 'getForeverBoxStatus', 'getSharingState',
    'getBotTemplateExportPolicy', 'getTeachRecordingStatus', 'isGlobalSearchEnabled',
    'isEgressTunnelAvailable', 'listBoxMcpServers',
    'setWindowFocused', 'getAgentAutomations',
    'requestDiskSaverAudit',
    'setAgentUnread', 'setAgentHiddenFromSidebar', 'setAgentNotificationsEnabled',
    'setAgentNotifyOnUpdates', 'setAgentAvatarBytes', 'getAgentAvatar',
  ]);
  // create/delete stay LOCAL — 1340 createAgent 401s on a stale cached token
  // and the UI then never grows a sidebar row or clears the canvas.
  if (name === 'createAgent' || name === 'createAgentFromTemplate' || name === 'duplicateAgent') {
    let parsed = {};
    try { parsed = JSON.parse(String(body || '{}')); } catch { parsed = {}; }
    if (name === 'duplicateAgent' && parsed.id) {
      const src = (cachedAgentList() || []).find((a) => a.id === parsed.id) || {};
      parsed = { ...src, id: undefined, name: `${src.name || 'chat'} copy` };
    }
    const agent = mintLocalAgent(parsed);
    jsonSend(res, { agent, id: agent.id, ...agent });
    pushCreatedAgent(agent);
    log(`cursor-backend:      createAgent local id=${agent.id} name=${JSON.stringify(agent.name)}`);
    return true;
  }
  if (name === 'interruptAgentRun') {
    let parsed = {};
    try { parsed = JSON.parse(String(body || '{}')); } catch { parsed = {}; }
    const id = String(parsed.id || parsed.agentId || focusedAgentId || '');
    const n = id ? zooTurns.abort(id) : 0;
    jsonSend(res, { ok: true, interrupted: n, id });
    log(`cursor-backend:      interruptAgentRun id=${id || '?'} n=${n}`);
    return true;
  }
  if (name === 'kickstartAgent') {
    let parsed = {};
    try { parsed = JSON.parse(String(body || '{}')); } catch { parsed = {}; }
    const id = String(parsed.id || parsed.agentId || '');
    jsonSend(res, { id, isIntroductionInFlight: false });
    log(`cursor-backend:      kickstartAgent id=${id || '?'}`);
    return true;
  }
  if (name === 'createGroup') {
    let parsed = {};
    try { parsed = JSON.parse(String(body || '{}')); } catch { parsed = {}; }
    const memberIds = [].concat(parsed.memberAgentIds || parsed.memberIds || []).map(String).filter(Boolean);
    const agent = mintLocalAgent({
      ...parsed,
      isGroup: true,
      memberIds,
      name: parsed.name || parsed.title || 'group',
    });
    jsonSend(res, { agent, id: agent.id, ...agent });
    pushCreatedAgent(agent);
    log(`cursor-backend:      createGroup local id=${agent.id} members=${memberIds.length} name=${JSON.stringify(agent.name)}`);
    return true;
  }
  if (name === 'setGroupMembers') {
    let parsed = {};
    try { parsed = JSON.parse(String(body || '{}')); } catch { parsed = {}; }
    const id = String(parsed.id || parsed.agentId || '');
    const memberIds = [].concat(parsed.memberAgentIds || parsed.memberIds || []).map(String).filter(Boolean);
    const list = cachedAgentList() || [];
    const i = list.findIndex((a) => a.id === id);
    if (!id || i < 0) {
      jsonSend(res, null);
      log(`cursor-backend:      setGroupMembers miss id=${id || '?'}`);
      return true;
    }
    const agent = shapeAgent({ ...list[i], isGroup: true, memberIds, updatedAt: Date.now() });
    list[i] = agent;
    saveAgents(list.map(shapeAgent));
    jsonSend(res, { agent, ...agent });
    ssePush('agent-upserted', { agent, activeAgentId: focusedAgentId || id });
    ssePush('agents', { agents: rosterForEvent(list, agentActivity), activeAgentId: focusedAgentId || id });
    log(`cursor-backend:      setGroupMembers id=${id} n=${memberIds.length}`);
    return true;
  }
  if (name === 'broadcastToAgents') {
    let parsed = {};
    try { parsed = JSON.parse(String(body || '{}')); } catch { parsed = {}; }
    const ids = [].concat(parsed.ids || parsed.agentIds || []).map(String).filter(Boolean);
    const prompt = String(parsed.prompt || parsed.text || parsed.message || '').trim();
    jsonSend(res, { ok: true, accepted: true, ids });
    const target = ids[0] && groupMemberIds(ids[0]).length ? ids[0] : (focusedAgentId || ids[0]);
    if (target && prompt) {
      const nonce = parsed.clientNonce || `oz-bc-${Date.now()}`;
      setImmediate(() => {
        runGroupQueue({
          agentId: target,
          humanPrompt: prompt,
          parsed,
          nonce,
          log,
        }).catch((e) => log(`cursor-backend:      broadcast queue ${e.message}`));
      });
    }
    log(`cursor-backend:      broadcastToAgents ids=${ids.length} target=${target || 'none'}`);
    return true;
  }
  if (name === 'updateAgent') {
    let parsed = {};
    try { parsed = JSON.parse(String(body || '{}')); } catch { parsed = {}; }
    const agent = mintLocalAgent(parsed);
    jsonSend(res, { agent, ...agent });
    pushCreatedAgent(agent, { select: false });
    log(`cursor-backend:      updateAgent local id=${agent.id}`);
    return true;
  }
  if (name === 'setAgentUnread') {
    let parsed = {};
    try { parsed = JSON.parse(String(body || '{}')); } catch { parsed = {}; }
    const id = String(parsed.id || '');
    const unread = parsed.isUnread === true;
    if (id) {
      const a = agentActivity.get(id) || {};
      a.hasUnread = unread;
      a.unreadCount = unread ? Math.max(1, a.unreadCount || 1) : 0;
      agentActivity.set(id, a);
      if (!unread) noteFocus(id);
    }
    jsonSend(res, { ok: true });
    return true;
  }
  if (name === 'deleteAgents') {
    let parsed = {};
    try { parsed = JSON.parse(String(body || '{}')); } catch { parsed = {}; }
    const ids = new Set([].concat(parsed.ids || parsed.id || []).map(String));
    const next = (cachedAgentList() || []).filter((a) => !ids.has(a.id));
    addDeletedIds(HOME, [...ids]);
    saveAgents(next);
    for (const id of ids) {
      transcripts.delete(id);
      try { cancelAgentWakeup(id); } catch { /* */ }
    }
    jsonSend(res, { ok: true, deleted: [...ids] });
    log(`cursor-backend:      deleteAgents n=${ids.size}`);
    return true;
  }
  if (name === 'listAgents' || name === 'getTrays' || name === 'countAgents' || name === 'searchAgents') {
    if (!sniffOn() && !useHouseRoster()) {
      const pod = await waitForAccountPod(log);
      if (pod?.agent) {
        const proxied = await proxyPodHttp(req, res, full, body, log);
        if (proxied) return true;
      }
    }
    if (name === 'getTrays') {
      jsonSend(res, []);
      return true;
    }
    if (name === 'listAgents' || name === 'countAgents' || name === 'searchAgents') {
      const list = rosterForEvent(mergeAgentLists([]), agentActivity);
      if (name === 'countAgents') {
        jsonSend(res, list.length);
        log(`cursor-backend:      countAgents local n=${list.length} account=${activeAccountId || 'none'}`);
        return true;
      }
      if (name === 'searchAgents') {
        let parsed = {};
        try { parsed = JSON.parse(String(body || '{}')); } catch { parsed = {}; }
        const q = String(parsed.query || parsed.q || '').toLowerCase();
        const out = !q ? list : list.filter((a) => String(a?.name || a?.title || a?.id || '').toLowerCase().includes(q));
        jsonSend(res, out);
        log(`cursor-backend:      searchAgents local n=${out.length}/${list.length} account=${activeAccountId || 'none'}`);
        return true;
      }
      const active = topConversationId(list);
      if (active && !focusedAgentId) focusedAgentId = active;
      jsonSend(res, list.map((a) => ({ ...a, isActive: !!(active && a.id === active) })));
      if (active) {
        ssePush('agents', {
          agents: list.map((a) => ({ ...a, isActive: a.id === active })),
          activeAgentId: active,
        });
      }
      if (seedShipNudge(list, active)) log(`cursor-backend:      ship nudge painted on ${active}`);
      log(`cursor-backend:      listAgents local n=${list.length} account=${activeAccountId || 'none'} active=${active || 'none'}`);
      return true;
    }
  }

  if (!sniffOn() && realPod?.agent && roster.has(name)) {
    return proxyPodHttp(req, res, full, body, log);
  }

  // THE ACTUAL CHAT PATH. Grok Bot does not send StreamUnifiedChat on this
  // surface — measured: POST /api/sendPrompt 374b/462b after EnsureSandBox
  // hijack. Stubbing {ok:true} ate the prompt. Forward to the paying proxy.
  if (name === 'sendPrompt') {
    let parsed = {};
    try { parsed = JSON.parse(String(body || '{}')); } catch { parsed = {}; }
    const prompt = stripVisitorLabel(promptFromSendBody(parsed));
    const visitor = visitorFromSend(parsed);
    const agentId = String(parsed.agentId || parsed.id || 'openzoo');
    const nonce = parsed.clientNonce || `oz-${Date.now()}`;
    const attN = Array.isArray(parsed.attachmentPaths) ? parsed.attachmentPaths.length : 0;
    const uiText = visitor ? labeledVisitorPrompt(visitor, prompt) : prompt;
    log(`cursor-backend:      >> sendPrompt agent=${agentId} keys=${Object.keys(parsed).join(',')} attachments=${attN}${visitor ? ` visitor=${visitor.shortname}` : ''} prompt=${JSON.stringify((prompt || '').slice(0, 80))}`);
    lastSendEchoId = String(nonce);
    jsonSend(res, { accepted: true });
    if (!visitor && wantsWakeupCron(prompt)) {
      const cron = scheduleAgentWakeup(agentId, { every: '5m' });
      log(`cursor-backend:      never-stop cron agent=${agentId} every=${cron.everySec}s`);
    }
    const turn = zooTurns.begin(agentId, nonce);
    const userLine = fanoutLine(agentId, 'user', uiText, {
      clientNonce: nonce,
      requestId: nonce,
      richText: visitor ? prefixVisitorRichText(parsed.richText, visitor.shortname, uiText) : parsed.richText,
      promptRaw: prompt,
    });
    noteFocus(agentId);
    bumpAgent(agentId, { preview: prompt, notify: false });
    ssePush('transcript', { ...gatewayEntry(userLine), agentId });
    const modelCmd = /^\s*\/model(?:\s+(\S+))?\s*$/i.exec(prompt || '');
    setImmediate(async () => {
      let text = '';
      let grouped = false;
      const stillCurrent = () => zooTurns.isCurrent(agentId, nonce) && !turn.signal.aborted;
      try {
        if (modelCmd) {
          const want = modelCmd[1];
          if (!want) {
            const cur = currentModel(agentId);
            text = `current model: ${cur}\nset with /model fable | opus | sonnet | grok | glm | provider/id`;
          } else {
            const id = (await resolveModelId(want)) || (want.includes('/') ? want : null);
            if (!id) {
              text = `unknown model "${want}" — not in the zoo's live catalog. try /model fable | opus | sonnet | grok | glm | abliterated, or any id from GET /v1/models`;
            } else {
              agentModels.set(agentId, id);
              saveAgentModels();
              text = `model set to ${id}`;
            }
          }
          try { text += await zooSpendOverlay({}); } catch { /* */ }
        } else {
          const members = groupMemberIds(agentId);
          if (members.length) {
            grouped = true;
            await runGroupQueue({ agentId, humanPrompt: prompt, parsed, nonce, log });
          } else {
            const z = await zooComplete(prompt, log, agentId, parsed, {
              signal: turn.signal,
              onProgress: (note) => {
                if (!stillCurrent()) return;
                paintChatUpdate(agentId, note, { clientNonce: nonce, requestId: nonce });
              },
            });
            text = z.text;
          }
        }
      } catch (e) {
        if (!stillCurrent() || isSupersededError(e)) {
          log(`cursor-backend:      sendPrompt superseded agent=${agentId} nonce=${nonce} ${e.message}`);
          zooTurns.end(agentId, nonce);
          return;
        }
        grouped = false;
        text = `openzoo error: ${e.message}`;
        log(`cursor-backend:      sendPrompt zoo failed: ${e.message}`);
      }
      if (!stillCurrent()) {
        zooTurns.end(agentId, nonce);
        log(`cursor-backend:      sendPrompt dropped stale agent=${agentId} nonce=${nonce}`);
        return;
      }
      if (!grouped) {
        const line = fanoutLine(agentId, 'assistant', text, { clientNonce: nonce, requestId: nonce });
        ssePush('transcript', { ...gatewayEntry(line), agentId });
        bumpAgent(agentId, { preview: text, notify: true });
        log(`cursor-backend:      sendPrompt done agent=${agentId} seq=${line.seq} text=${JSON.stringify(text.slice(0, 220))}`);
      } else {
        log(`cursor-backend:      sendPrompt group done agent=${agentId}`);
      }
      zooTurns.end(agentId, nonce);
    });
    return true;
  }
  if (name === 'getAgentTranscriptTail' || name === 'getAgentTranscriptWindow' || name === 'openAgentTail') {
    let parsed = {};
    try { parsed = JSON.parse(String(body || '{}')); } catch { parsed = {}; }
    const id = String(parsed.id || parsed.agentId || 'openzoo');
    noteFocus(id);
    tailedAgents.add(id);
    const t = agentTranscript(id);
    if (!t.pulledRemote && realPod?.agent && !useHouseRoster()) {
      const remote = await podJson('/api/getAgentTranscriptTail', {
        id, agentId: id, limit: 200, beforeSeq: parsed.beforeSeq,
      }, log);
      const n = ingestRemoteEntries(id, remote?.entries);
      t.pulledRemote = true;
      if (n) log(`cursor-backend:      hydrated ${id} +${n} from 1340`);
    }
    const t2 = agentTranscript(id);
    const limit = Math.min(Number(parsed.limit) || 50, 200);
    const before = parsed.beforeSeq != null ? Number(parsed.beforeSeq) : Infinity;
    const sliced = t2.entries.filter((e) => e.seq < before).slice(-limit);
    const page = { entries: sliced.map(gatewayEntry) };
    if (t2.entries.length > sliced.length && sliced.length) page.nextBeforeSeq = sliced[0].seq;
    jsonSend(res, page);
    log(`cursor-backend:      -> transcript ${id} n=${sliced.length}/${t2.seq}`);
    return true;
  }
  if (name === 'promptAcceptanceStatus') {
    let parsed = {};
    try { parsed = JSON.parse(String(body || '{}')); } catch { parsed = {}; }
    const nonce = String(parsed.clientNonce || lastSendEchoId);
    const agentId = String(parsed.agentId || '');
    jsonSend(res, {
      outcome: 'found',
      record: {
        status: 'accepted',
        acceptedAtMs: Date.now(),
        echoEntryId: nonce,
        clientNonce: nonce,
        agentId,
        inputDigest: '',
      },
    });
    log(`cursor-backend:      -> promptAcceptanceStatus found echo=${nonce}`);
    return true;
  }

  const stubs = {
    getHostStatus: { status: 'ready', ready: true, state: 'ready', hostStatus: 'ready' },
    getHostSettings: { settings: {} },
    setHostSettings: { ok: true },
    setBoxSecrets: { ok: true },
    listAgents: rosterForEvent(cachedAgentList()
      || [...new Set([...transcripts.keys(), ...tailedAgents])].map((id) => ({ id, name: 'chat', status: 'ready' })), agentActivity),
    countAgents: (cachedAgentList() || [...new Set([...transcripts.keys(), ...tailedAgents])]).length,
    searchAgents: rosterForEvent(cachedAgentList() || [], agentActivity),
    getAgentTranscriptTail: { tail: '', lines: [], dropped: false, ok: true },
    getTeachRecordingStatus: { recording: false },
    getTrays: [],
    isGlobalSearchEnabled: { enabled: false },
    isEgressTunnelAvailable: { available: false },
    getSharingState: { sharing: false },
    getBotTemplateExportPolicy: { allowed: true },
    getAgentAutomations: { automations: [] },
    getForeverBoxStatus: { enabled: false },
    getSubagents: { subagents: [] },
    getAsyncTasks: { tasks: [] },
    getAgentWorkflows: { workflows: [] },
    setWindowFocused: { ok: true },
  };
  const payload = stubs[name] !== undefined ? stubs[name] : { ok: true };
  // Live 1340 listAgents is a RAW array, not CVr (measured 104674b 2026-08-29).
  if (name === 'listAgents' || name === 'countAgents' || name === 'searchAgents') jsonSend(res, payload);
  else jsonApi(res, payload);
  log(`cursor-backend:      -> pod /api/${name}`);
  return true;
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
  restoreAgentWakeups(log);
  const { cert, key } = ensureCert(log);
  const certPem = fs.readFileSync(cert);
  const keyPem = fs.readFileSync(key);
  const secureContext = tls.createSecureContext({ cert: certPem, key: keyPem });
  let conns = 0;
  // SERVE BOTH h2 AND h1. An earlier build forced h1-only after concluding the
  // editor's h2 connections reset — but that log was the STALE 8443 backend the
  // pf redirect was still intercepting, not this server, so the conclusion was
  // contaminated. Measured cleanly now: some editor connections offer ONLY h2
  // (ERR_SSL_NO_APPLICATION_PROTOCOL when we advertise just h1), so we must
  // negotiate both. allowHTTP1 keeps the h1 fetch() calls (stripe/updates)
  // working; ALPN h2 first satisfies the Connect gRPC client.
  // SNICallback MUST pass the SecureContext — cb(null) with no ctx is why the
  // Helper daemon's Node fetch never completed GET /local-exec/requests (TLS
  // ECONNRESET, no request log). Chromium --ignore-certificate-errors hid this
  // for the UI process.
  const server = http2.createSecureServer(
    {
      cert: certPem,
      key: keyPem,
      allowHTTP1: true,
      ALPNProtocols: ['h2', 'http/1.1'],
      SNICallback: (servername, cb) => {
        log(`cursor-tls: <- ClientHello SNI=${servername || '?'}`);
        cb(null, secureContext);
      },
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
      // OAUTH MUST HIT THE REAL ISSUER. empty-ok on /oauth/token is the
      // "Reconnecting to your computer" / edge/handler-failed loop: the app
      // retries the same 509b body forever and never reaches AvailableModels
      // or EnsureSandBox. Measured live: #14–#88 POST /oauth/token -> empty-ok.
      // Same for the sandbox RPCs unless we are hijacking the pod.
      {
        const path0 = full.split('?')[0];
        const oauth = /^\/oauth(\/|$)/.test(path0);
        // Coordinator talks to /sand-box/local-exec-daemon-credential. empty-ok
        // here is ControlPortCallError: main-execution-failure: fetch failed.
        const sandBox = /^\/sand-box(\/|$)/.test(path0);
        const grokCred = /IssueGrokBotUserComputerCredential/.test(full);
        const sniffBox = sniffOn() && /GrokBotService\/(EnsureSandBox|WatchSandBoxMigration)/.test(full);
        const needRealPod = /GrokBotService\/EnsureSandBox/.test(full)
          && !process.env.OZ_HIJACK_POD
          && !sniffBox;
        if (sniffBox) {
          if (/WatchSandBoxMigration/.test(full) && realPod) {
            const payload = rewrittenBox();
            res.writeHead(200, {
              'content-type': 'application/connect+proto',
              'grpc-status': '0',
              ...CORS,
            });
            const end = Buffer.from('{}');
            const h = Buffer.alloc(5); h.writeUInt8(0x02, 0); h.writeUInt32BE(end.length, 1);
            res.end(Buffer.concat([envelope(payload), h, end]));
            log('cursor-backend:      SNIFF WatchSandBoxMigration ready (rewritten)');
            return;
          }
          await sniffEnsureSandBox(req, res, body, host, full, log);
          return;
        }
        if (oauth || sandBox || grokCred || needRealPod) {
          const upstream = /cursor\.sh$/.test(host) ? host : 'api2.cursor.sh';
          await passthroughToRealAnthropic(req, res, body, upstream, full, log);
          if (oauth) lastOauthAt = Date.now();
          return;
        }
        if (await handleLocalExecHttp(req, res, path0, body, log)) return;
        if (await handleHijackedPodHttp(req, res, full, body, log)) return;
      }
      // HIJACK EnsureSandBox FIRST — before passthrough, or passthrough eats it.
      // MEASURED: with OPENZOO_PASSTHRU=1 set, EnsureSandBox went `-> REAL
      // anthropic (200, 707b)` every time and the app got a real cursorvm pod,
      // never our box. This method (and ONLY this one) must be answered locally
      // with OUR box so Grok Bot's UI wires to our sandbox; everything else
      // still passes through so the app loads normally.
      if (/GrokBotService\/(EnsureSandBox|WatchSandBoxMigration)/.test(full) && process.env.OZ_HIJACK_POD) {
        // Watch is a connect STREAM. Never await api2 on it — that is the
        // splash hang. Reply immediately, discover THIS caller's 1340 in
        // the background so listAgents can wait for their tray, not the
        // machine-global cache from the last login on this Mac.
        process.env.OZ_SNIFF_SELF = process.env.OZ_SNIFF_SELF || 'https://127.0.0.1:8443';
        const confirmed = discover.ok && realPod?.agent && !podStale;
        if (/WatchSandBoxMigration/.test(full)) {
          replyEnsureBox(req, res, rewrittenBox({ confirmed }), full);
          ensureDiscover(req, Buffer.alloc(0), log);
          log(`cursor-backend:      -> WatchSandBoxMigration ready (${confirmed ? `account ${realPod.accountId}` : 'env box + discover'})`);
          return;
        }
        try {
          const pod = await ensureDiscover(req, body, log);
          replyEnsureBox(req, res, rewrittenBox({ confirmed: !!pod?.agent }), full);
          log(`cursor-backend:      -> HIJACKED EnsureSandBox -> our box (roster from real 1340 account=${pod?.accountId || '?'})`);
          return;
        } catch (e) {
          log(`cursor-backend:      EnsureSandBox discover failed (${e.message}) — ${realPod?.agent && cacheFallbackOk ? 'cached 1340' : 'env box'}`);
        }
        replyEnsureBox(req, res, rewrittenBox({ confirmed: !!(realPod?.agent && cacheFallbackOk) }), full);
        return;
      }
      // CAPTURE the chat inference request so its schema can be decoded from
      // REAL bytes (Auto's StreamUnifiedChat). Written once; inspect then build.
      if (/StreamUnifiedChat/.test(full)) {
        await handleStreamChat(req, res, body, log);
        return;
      }
      // Telegram/"Failed to send": GetGrokBotSendStatus empty proto is
      // UNSPECIFIED. ACCEPTED=2. WatchGrokBotUserComputerRequests is a
      // long-lived stream — empty-ok closes it and the channel looks offline.
      if (/GetGrokBotSendStatus/.test(full)) {
        if (sniffOn()) {
          const fields = decodeProtoFields(body);
          sniffDump({ kind: 'GetGrokBotSendStatus.req', fields });
          const upstream = /cursor\.sh$/.test(host) ? host : 'api2.cursor.sh';
          await passthroughToRealAnthropic(req, res, body, upstream, full, log);
          return;
        }
        const fields = decodeProtoFields(body);
        const echoId = String(fields[2] || lastSendEchoId);
        lastSendEchoId = echoId;
        const payload = encodeGetGrokBotSendStatus(echoId);
        const reqCt = String(req.headers['content-type'] || '');
        if (reqCt.includes('grpc-web')) {
          res.writeHead(200, {
            'content-type': reqCt.includes('text') ? 'application/grpc-web-text+proto' : 'application/grpc-web+proto',
            'grpc-status': '0', ...CORS,
          });
          res.end(Buffer.concat([envelope(payload), grpcWebTrailer()]));
        } else {
          res.writeHead(200, { 'content-type': 'application/proto', ...CORS });
          res.end(payload);
        }
        log(`cursor-backend:      -> GetGrokBotSendStatus ACCEPTED echo=${echoId}`);
        return;
      }
      if (/WatchGrokBotUserComputerRequests/.test(full)) {
        if (sniffOn()) {
          const upstream = /cursor\.sh$/.test(host) ? host : 'api2.cursor.sh';
          await passthroughPipe(req, res, body, upstream, full, log);
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/connect+proto',
          'grpc-status': '0',
          ...CORS,
        });
        req.on('close', () => { try { res.end(); } catch { /* */ } });
        log('cursor-backend:      -> WatchGrokBotUserComputerRequests held');
        return;
      }
      // FULL PASSTHROUGH MODE — observe, do not stub.
      //
      // Stubbing unknown methods with empty protobufs BREAKS Grok Bot: it never
      // gets a sandbox from GrokBotService/EnsureSandBox, so it re-polls
      // WatchSandBoxMigration forever and never reaches the chat stage. That is
      // why an intercepted run showed 40 methods and ZERO StreamChat — absence
      // of evidence created by our own stub, not proof that chat lives
      // elsewhere.
      //
      // In passthrough the app runs NORMALLY against the real backend while
      // every method, size and status is logged here — which is what actually
      // reveals where inference goes.
      if (process.env.OPENZOO_PASSTHRU === '1') {
        await passthroughToRealAnthropic(req, res, body, host, full, log);
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
  startHostMcps({ log }).catch((e) => log(`cursor-backend:      mcp start ${e.message}`));
  try {
    server.listen({ port, host: '::', ipv6Only: false }, () => onUp('[::]+127.0.0.1'));
  } catch {
    server.listen(port, '127.0.0.1', () => onUp('127.0.0.1'));
  }
  return { server, port };
}
