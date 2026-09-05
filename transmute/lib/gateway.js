// The local gateway: an HTTP front for one transmuted site program.
//
// It plays the part Vercel's edge plays for a deployment — static files
// first (from asset PDAs, cached in memory), `config.routes` rewrites with
// `handle: 'filesystem'` precedence, cleanUrls fallbacks, then the function
// routes by pattern. A function hit becomes one bridge Invoke event:
// GET/HEAD/OPTIONS are simulated (free, no signature), everything else is a
// signed transaction paid by the gateway keypair. Without a keypair a
// mutating request answers 402 — that is the seam where openzoo's x402
// payment flow takes over later.
//
// `handleRequest(state, req)` is the whole gateway minus sockets so it can
// be unit-tested with a fake `invoke`; `startGateway()` wraps it in
// `node:http`.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import { FORWARDED_HEADERS, MANIFEST_PATH, assetPda, decodeAsset, encodeInvoke } from './wire.js';
import { connect, invoke as chainInvoke, readManifest, getProgramInfo, DEFAULT_CU, DEFAULT_HEAP } from './solana.js';
import { rpcUrl } from './wallet.js';

export const DEFAULT_PORT = 4402;
/** Coarse cap on the request body (checked while the body streams in, before any RPC). */
export const BODY_LIMIT = 900;
/** A serialized Solana transaction may not exceed this many bytes. */
export const PACKET_DATA_SIZE = 1232;
/** Bytes `invoke` appends for the `x-zoo-nonce:<hex>\n` header on mutating requests. */
export const NONCE_HEADER_BYTES = 32;
/** Methods that never mutate: served by `simulateTransaction`, no signer needed. */
export const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];
export const ALL_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];
export const ZOO_PREFIX = '/.zoo';

const JSON_CT = 'application/json; charset=utf-8';
const HTML_CT = 'text/html; charset=utf-8';

// ---------------------------------------------------------------- state

/**
 * Build the gateway state. Everything `handleRequest` needs lives here so
 * tests can construct one with a fake `invoke` and no connection.
 *
 * @param {{programId:string|PublicKey, cluster?:string, connection?:object, keypair?:object,
 *   manifest?:object, invoke?:Function, cacheTtlMs?:number, port?:number, log?:Function}} o
 */
export function makeState(o) {
  const programId = new PublicKey(o.programId);
  const cluster = o.cluster || process.env.OPENZOO_CLUSTER || 'localnet';
  const state = {
    programId,
    programIdStr: programId.toBase58(),
    cluster,
    rpc: o.connection?.rpcEndpoint || safeRpcUrl(cluster),
    connection: o.connection ?? null,
    keypair: o.keypair ?? null,
    manifest: normalizeManifest(o.manifest),
    manifestAt: o.manifest ? Date.now() : 0,
    invoke: o.invoke ?? ((args) => chainInvoke(state.connection, args)),
    assets: new Map(),           // path -> { contentType, data, etag, at } | { missing:true, at } | { incomplete:true, at }
    cacheTtlMs: o.cacheTtlMs ?? 30_000,
    bodyLimit: o.bodyLimit ?? BODY_LIMIT,
    port: o.port ?? null,
    startedAt: Date.now(),
    readPayer: null,             // PublicKey used as fee payer for simulations when there is no keypair
    log: o.log ?? (() => {}),
    stats: { requests: 0, invokes: 0, simulated: 0, signed: 0, staticHits: 0 },
  };
  return state;
}

function safeRpcUrl(cluster) { try { return rpcUrl(cluster); } catch { return null; } }

/** Fill in the optional manifest fields so routing never has to null-check. */
export function normalizeManifest(m) {
  if (!m) return { version: 1, framework: null, routes: [], static: null, env: [], config: { routes: [] }, missing: true };
  return {
    ...m,
    routes: Array.isArray(m.routes) ? m.routes : [],
    static: Array.isArray(m.static) ? m.static : null,
    env: Array.isArray(m.env) ? m.env : [],
    config: { ...(m.config || {}), routes: Array.isArray(m.config?.routes) ? m.config.routes : [] },
  };
}

// ---------------------------------------------------------------- responses

function json(status, obj, headers = {}) {
  return { status, headers: { 'content-type': JSON_CT, ...headers }, body: Buffer.from(JSON.stringify(obj, null, 2)) };
}
function html(status, text, headers = {}) {
  return { status, headers: { 'content-type': HTML_CT, ...headers }, body: Buffer.from(text) };
}
function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function etagOf(data) { return '"' + createHash('sha256').update(data).digest('hex').slice(0, 32) + '"'; }

// ---------------------------------------------------------------- assets

/** Look an asset up in the in-memory cache, refreshing from chain after the TTL. */
export async function getAsset(state, path) {
  const now = Date.now();
  const cached = state.assets.get(path);
  if (cached && now - cached.at < state.cacheTtlMs) return cached;
  if (!state.connection) return cached ?? { missing: true, at: now };
  const [pda] = assetPda(state.programId, path);
  let entry;
  try {
    const info = await state.connection.getAccountInfo(pda);
    const a = info ? decodeAsset(info.data) : null;
    if (!a) entry = { missing: true, at: now };
    else if (!a.complete) entry = { incomplete: true, total: a.total, have: a.data.length, at: now };
    else {
      const data = Buffer.from(a.data);
      entry = { contentType: a.contentType || staticEntry(state, path)?.contentType || 'application/octet-stream', data, etag: etagOf(data), pda: pda.toBase58(), at: now };
    }
  } catch (e) {
    // RPC hiccup: keep serving what we have.
    if (cached) return cached;
    entry = { error: String(e?.message || e), at: now - state.cacheTtlMs + 2000 };
  }
  state.assets.set(path, entry);
  return entry;
}

function staticEntry(state, path) {
  const list = state.manifest.static;
  if (!list) return null;
  if (!state._staticIndex || state._staticIndexOf !== list) {
    state._staticIndex = new Map(list.map((s) => [s.path, s]));
    state._staticIndexOf = list;
  }
  return state._staticIndex.get(path) || null;
}

/** Is `path` a static file of this deployment? Without a manifest list, ask the chain. */
async function staticExists(state, path) {
  if (state.manifest.static) return !!staticEntry(state, path);
  const a = await getAsset(state, path);
  return !a.missing && !a.error;
}

/** Vercel cleanUrls semantics: '/' → /index.html, '/foo' → /foo, /foo.html, /foo/index.html. */
export function staticCandidates(pathname) {
  const out = [];
  if (pathname === '/' || pathname === '') return ['/index.html'];
  if (pathname.endsWith('/')) {
    out.push(pathname + 'index.html', pathname.slice(0, -1) + '.html', pathname.slice(0, -1));
  } else {
    out.push(pathname, pathname + '.html', pathname + '/index.html');
  }
  return out;
}

async function lookupStatic(state, pathname) {
  for (const cand of staticCandidates(pathname)) {
    if (await staticExists(state, cand)) return cand;
  }
  return null;
}

async function serveStatic(state, path, req, extraHeaders = {}) {
  const a = await getAsset(state, path);
  if (a.missing) return null;
  if (a.error) return json(503, { error: 'asset unavailable', path, message: a.error });
  if (a.incomplete) return json(503, { error: 'asset upload incomplete', path, have: a.have, total: a.total, hint: 'the deploy did not finish writing this file; run deploy again' }, { 'retry-after': '5' });
  state.stats.staticHits++;
  const headers = {
    'content-type': a.contentType,
    'etag': a.etag,
    'cache-control': 'public, max-age=0, must-revalidate',
    'x-zoo-asset': a.pda || '',
    ...extraHeaders,
  };
  const inm = req.headers?.['if-none-match'];
  if (inm && inm.split(',').map((s) => s.trim()).includes(a.etag)) return { status: 304, headers, body: Buffer.alloc(0) };
  if (req.method === 'OPTIONS') return { status: 204, headers: { ...headers, allow: 'GET, HEAD, OPTIONS' }, body: Buffer.alloc(0) };
  return { status: 200, headers, body: a.data };
}

// ---------------------------------------------------------------- routing

function routeRegex(src, caseSensitive) {
  try { return new RegExp(src, caseSensitive ? '' : 'i'); } catch { return null; }
}

/** `$1` / `$name` substitution in a `dest`, like @vercel/routing-utils. */
export function resolveDest(dest, match) {
  return dest
    .replace(/\$(\d+)/g, (_, i) => match[Number(i)] ?? '')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, n) => match.groups?.[n] ?? '');
}

/** Match `route` (a Build Output API route object) against a request; null when it does not apply. */
function matchRoute(route, pathname, method) {
  if (!route.src) return null;
  if (route.methods && !methodAllowed(route, method)) return null;
  const re = routeRegex(route.src, route.caseSensitive);
  if (!re) return null;
  return re.exec(pathname);
}

/** Split `config.routes` into the phases Vercel evaluates them in. */
export function routePhases(routes) {
  const phases = { pre: [], post: [], hit: [], error: [] };
  let cur = 'pre';
  for (const r of routes) {
    if (r && typeof r.handle === 'string') {
      cur = r.handle === 'filesystem' || r.handle === 'miss' || r.handle === 'rewrite' || r.handle === 'resource' ? 'post' : r.handle === 'hit' ? 'hit' : r.handle === 'error' ? 'error' : cur;
      continue;
    }
    if (r && r.src) phases[cur].push(r);
  }
  return phases;
}

/** Find the function whose route pattern matches; returns {route, params, allowed}. */
export function matchFunction(state, pathname, method) {
  let methodMiss = null;
  for (const r of state.manifest.routes) {
    if (!r || typeof r.index !== 'number') continue;
    const re = r.pattern ? routeRegex(r.pattern, true) : null;
    const m = re ? re.exec(pathname) : (r.routePath === pathname ? [pathname] : null);
    if (!m) continue;
    const params = {};
    (r.params || []).forEach((name, i) => { if (m[i + 1] != null) params[name] = decodeURIComponentSafe(m[i + 1]); });
    if (m.groups) for (const [k, v] of Object.entries(m.groups)) if (v != null) params[k] = decodeURIComponentSafe(v);
    if (!methodAllowed(r, method)) { methodMiss = methodMiss || { route: r, params, allowed: false }; continue; }
    return { route: r, params, allowed: true };
  }
  return methodMiss;
}

function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }

export function methodAllowed(route, method) {
  if (!route.methods || !route.methods.length) return true;
  const ms = route.methods.map((m) => m.toUpperCase());
  if (ms.includes(method)) return true;
  if (method === 'HEAD' && ms.includes('GET')) return true;
  return false;
}

/** Exact `dest` → function lookup: `dest` is the function's routePath (e.g. "/api/users/[id]"). */
function functionByRoutePath(state, dest) {
  return state.manifest.routes.find((r) => r && typeof r.index === 'number' && r.routePath === dest) || null;
}

function parseUrl(url) {
  const raw = String(url || '/');
  const q = raw.indexOf('?');
  let pathname = q >= 0 ? raw.slice(0, q) : raw;
  const query = q >= 0 ? raw.slice(q + 1) : '';
  if (!pathname.startsWith('/')) pathname = '/' + pathname;
  // Collapse duplicate slashes and resolve dot segments so "/a/../b" cannot escape a namespace.
  pathname = pathname.replace(/\/{2,}/g, '/');
  const segs = [];
  for (const s of pathname.split('/')) {
    if (s === '..') segs.pop(); else if (s !== '.') segs.push(s);
  }
  pathname = segs.join('/') || '/';
  if (!pathname.startsWith('/')) pathname = '/' + pathname;
  return { pathname, query };
}

function mergeQuery(a, b) { return [a, b].filter(Boolean).join('&'); }

// ---------------------------------------------------------------- tx budget

const overheadByKv = new Map();
/**
 * Bytes of a serialized invoke transaction that are not instruction data:
 * signature, message header, the payer/system/compute-budget/program keys,
 * `kvCount` KV accounts, blockhash, and the heap + CU instructions `invoke`
 * always adds. Measured by serializing the same shape once per `kvCount`
 * (252 B for no KV accounts, +33 B per account).
 */
export function invokeTxOverhead(kvCount = 0) {
  kvCount = Math.max(0, kvCount | 0);
  if (overheadByKv.has(kvCount)) return overheadByKv.get(kvCount);
  const key = (i) => new PublicKey(Buffer.alloc(32, i + 1));
  const keys = [{ pubkey: key(0), isSigner: true, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }];
  for (let i = 0; i < kvCount; i++) keys.push({ pubkey: key(2 + i), isSigner: false, isWritable: true });
  const tx = new Transaction();
  if (DEFAULT_HEAP) tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: DEFAULT_HEAP }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_CU }));
  const probe = 128; // ≥128 so the compact-u16 data length takes its 2-byte form, as it will for any real request
  tx.add(new TransactionInstruction({ programId: key(1), keys, data: Buffer.alloc(probe) }));
  tx.feePayer = key(0);
  tx.recentBlockhash = '11111111111111111111111111111111';
  const n = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length - probe;
  overheadByKv.set(kvCount, n);
  return n;
}

/** Instruction-data bytes (path + query + headers + body + framing) one invoke may carry. */
export function invokeBudget(kvCount = 0, mutate = false) {
  return PACKET_DATA_SIZE - invokeTxOverhead(kvCount) - (mutate ? NONCE_HEADER_BYTES : 0);
}

// ---------------------------------------------------------------- functions

function normalizeIp(a) { return typeof a === 'string' ? a.replace(/^::ffff:/i, '') : null; }

function forwardedHeaders(req, params) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    const name = k.toLowerCase();
    if (name.startsWith('x-zoo-param-')) continue; // never trust client-supplied params
    if (FORWARDED_HEADERS.includes(name) || name.startsWith('x-')) out[name] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  // The client cannot pick its own address: `x-real-ip` is always the socket
  // peer, and a client-supplied `x-forwarded-for` gets the peer appended the
  // way any proxy does (so the last hop is the trustworthy one).
  const peer = normalizeIp(req.remoteAddress);
  if (peer) {
    out['x-real-ip'] = peer;
    if (out['x-forwarded-for']) out['x-forwarded-for'] = `${out['x-forwarded-for']}, ${peer}`;
  }
  for (const [k, v] of Object.entries(params)) out['x-zoo-param-' + k.toLowerCase().replace(/[^a-z0-9]+/g, '-')] = v;
  return out;
}

async function readPayerFor(state) {
  if (state.keypair) return state.keypair;
  if (state.readPayer) return state.readPayer;
  // Simulations still need a fee payer that exists and holds lamports; the
  // program's upgrade authority is the best guess when the gateway is unsigned.
  if (state.connection) {
    try {
      const info = await getProgramInfo(state.connection, state.programId);
      if (info.authority) { state.readPayer = info.authority; return info.authority; }
    } catch { /* fall through */ }
  }
  state.readPayer = state.programId;
  return state.readPayer;
}

async function serveFunction(state, hit, req, pathname, query, extraHeaders = {}) {
  const { route, params } = hit;
  const method = req.method;
  const body = req.body == null ? Buffer.alloc(0) : Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body));
  // Coarse cut first: nothing above a whole packet can ever fit. Anything
  // smaller gets the exact budget below, which also tells the caller how much
  // body DOES fit next to its own headers (maxBody).
  if (body.length > PACKET_DATA_SIZE) {
    return json(413, {
      error: 'payload too large',
      limit: state.bodyLimit,
      received: body.length,
      message: `request bodies travel inside a Solana transaction (${PACKET_DATA_SIZE} bytes total, at most ${state.bodyLimit} for the body); send less, or put large payloads in an asset and reference it`,
    }, { 'x-zoo-program': state.programIdStr });
  }
  const mutate = !READ_METHODS.includes(method);
  const headers = forwardedHeaders(req, params);
  const event = { route: route.index, method, path: pathname, query, headers, body };
  // The exact check: the whole event (framing, path, query, forwarded headers,
  // body) plus the KV accounts the route declares must fit in one transaction.
  const data = encodeInvoke(event);
  const kvCount = Array.isArray(route.kv) ? route.kv.length : 0;
  const budget = invokeBudget(kvCount, mutate);
  if (data.length > budget) {
    const envelope = data.length - body.length;
    const maxBody = Math.max(0, Math.min(state.bodyLimit, budget - envelope));
    return json(413, {
      error: 'payload too large',
      limit: state.bodyLimit,
      maxBody,
      received: body.length,
      envelope,
      budget,
      message: `the request must fit in one ${PACKET_DATA_SIZE}-byte Solana transaction: path, query and forwarded headers take ${envelope} bytes and ${kvCount} KV account(s) are reserved, leaving ${maxBody} for the body (got ${body.length}); send fewer/shorter headers or a smaller body`,
    }, { 'x-zoo-program': state.programIdStr });
  }
  if (mutate && !state.keypair) {
    return json(402, {
      error: 'payment required',
      message: `${method} ${pathname} mutates on-chain state and must be sent as a signed transaction; this gateway has no wallet. Start it with --keypair <path>, or pay per request via x402.`,
      method, path: pathname, programId: state.programIdStr, cluster: state.cluster,
      x402: { scheme: 'solana', network: state.cluster, resource: pathname, payTo: null },
    }, { 'x-zoo-program': state.programIdStr, 'x-zoo-needs-signer': 'true' });
  }
  const payer = await readPayerFor(state);
  state.stats.invokes++;
  let r;
  try {
    r = await state.invoke({ programId: state.programId, payer, event, mutate });
  } catch (e) {
    const msg = String(e?.message || e);
    if (/signing keypair is required/i.test(msg)) return json(402, { error: 'payment required', message: msg, method, path: pathname }, { 'x-zoo-program': state.programIdStr });
    // The handler touched more KV accounts than the manifest declared and the tx outgrew the packet: still the client's payload, not the chain.
    if (/transaction too large/i.test(msg)) return json(413, { error: 'payload too large', limit: state.bodyLimit, received: body.length, message: `${msg.split('\n')[0]}; the handler needs more accounts than the manifest declares, send a smaller body or fewer headers` }, { 'x-zoo-program': state.programIdStr });
    state.log(`invoke ${method} ${pathname} failed: ${msg.split('\n')[0]}`);
    return json(502, { error: 'invoke failed', message: msg.split('\n')[0], route: route.routePath, logs: (e?.logs || []).slice(-25) }, { 'x-zoo-program': state.programIdStr });
  }
  if (r.simulated === false) state.stats.signed++; else state.stats.simulated++;
  const outHeaders = { ...extraHeaders };
  for (const [k, v] of Object.entries(r.headers || {})) outHeaders[k.toLowerCase()] = v;
  outHeaders['x-zoo-program'] = state.programIdStr;
  outHeaders['x-zoo-route'] = String(route.index);
  outHeaders['x-zoo-simulated'] = r.simulated === false ? 'false' : 'true';
  if (r.signature) outHeaders['x-zoo-signature'] = r.signature;
  if (r.unitsConsumed != null) outHeaders['x-zoo-cu'] = String(r.unitsConsumed);
  const out = r.body == null ? Buffer.alloc(0) : Buffer.isBuffer(r.body) ? r.body : Buffer.from(String(r.body));
  // The wire status is a u16; anything HTTP cannot express is the program's bug, not a valid reply.
  const status = r.status == null ? 200 : Number.isInteger(r.status) && r.status >= 100 && r.status <= 599 ? r.status : 502;
  if (status === 502 && r.status !== 502) outHeaders['x-zoo-bad-status'] = String(r.status);
  return { status, headers: outHeaders, body: out };
}

// ---------------------------------------------------------------- /.zoo/*

async function serveZoo(state, pathname, req) {
  if (pathname === `${ZOO_PREFIX}/manifest.json` || pathname === MANIFEST_PATH) {
    await maybeRefreshManifest(state, true);
    return json(200, { ...state.manifest, programId: state.manifest.programId || state.programIdStr }, { 'x-zoo-program': state.programIdStr });
  }
  if (pathname === `${ZOO_PREFIX}/status`) return json(200, await statusOf(state), { 'x-zoo-program': state.programIdStr });
  if (pathname === ZOO_PREFIX || pathname === `${ZOO_PREFIX}/`) return html(200, explorerHtml(state), { 'x-zoo-program': state.programIdStr });
  return null;
}

export async function statusOf(state) {
  let chain = null;
  if (state.connection) {
    try {
      const [info, slot] = await Promise.all([getProgramInfo(state.connection, state.programId), state.connection.getSlot('confirmed')]);
      chain = {
        slot,
        program: { exists: info.exists, executable: info.executable ?? null, authority: info.authority ? info.authority.toBase58() : null, deploySlot: info.slot, maxDataLen: info.maxDataLen, programData: info.programData.toBase58() },
      };
    } catch (e) { chain = { error: String(e?.message || e) }; }
  }
  return {
    ok: true,
    programId: state.programIdStr,
    cluster: state.cluster,
    rpc: state.rpc,
    signer: state.keypair ? state.keypair.publicKey.toBase58() : null,
    bodyLimit: state.bodyLimit,
    uptimeMs: Date.now() - state.startedAt,
    stats: state.stats,
    manifest: { present: !state.manifest.missing, version: state.manifest.version ?? null, framework: state.manifest.framework ?? null, routes: state.manifest.routes.length, static: state.manifest.static ? state.manifest.static.length : null, deployedAt: state.manifest.deployedAt ?? null },
    cache: { assets: state.assets.size, ttlMs: state.cacheTtlMs },
    ...(chain || {}),
  };
}

export function explorerHtml(state) {
  const m = state.manifest;
  const rows = m.routes.map((r) => {
    const methods = r.methods && r.methods.length ? r.methods.join(', ') : 'any';
    const kv = Array.isArray(r.kv) && r.kv.length ? r.kv.join(', ') : '';
    const link = (!r.params || !r.params.length) && (!r.methods || r.methods.some((x) => /^(GET|HEAD)$/i.test(x))) ? `<a href="${escape(r.routePath)}">${escape(r.routePath)}</a>` : escape(r.routePath);
    return `<tr><td>${r.index}</td><td>${link}</td><td><code>${escape(methods)}</code></td><td>${escape(r.style || '')}</td><td>${escape(r.name || '')}</td><td>${escape(kv)}</td></tr>`;
  }).join('\n');
  const assets = (m.static || []).map((s) => `<tr><td><a href="${escape(s.path)}">${escape(s.path)}</a></td><td>${escape(s.contentType || '')}</td><td style="text-align:right">${escape(s.size ?? '')}</td></tr>`).join('\n');
  return `<!doctype html>
<meta charset="utf-8">
<title>openzoo-transmute · ${escape(m.name || state.programIdStr)}</title>
<style>
body{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:2rem auto;max-width:72rem;padding:0 1rem;color:#222;background:#fafafa}
h1{font-size:1.2rem}h2{font-size:1rem;margin-top:2rem}table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #ddd;padding:.3rem .5rem;text-align:left;vertical-align:top}th{background:#eee}
code{background:#eee;padding:0 .2rem}a{color:#0645ad}.muted{color:#777}
</style>
<h1>openzoo-transmute explorer</h1>
<p>program <code>${escape(state.programIdStr)}</code> on <code>${escape(state.cluster)}</code>${state.rpc ? ` (<span class="muted">${escape(state.rpc.replace(/\?.*$/, ''))}</span>)` : ''}<br>
signer: <code>${state.keypair ? escape(state.keypair.publicKey.toBase58()) : 'none — mutating requests answer 402'}</code><br>
framework: <code>${escape(m.framework || 'unknown')}</code>${m.deployedAt ? ` · deployed ${escape(m.deployedAt)}` : ''}${m.missing ? ' · <b>no manifest on chain</b>' : ''}</p>
<p><a href="${ZOO_PREFIX}/manifest.json">manifest.json</a> · <a href="${ZOO_PREFIX}/status">status</a></p>
<h2>functions (${m.routes.length})</h2>
<table><tr><th>#</th><th>route</th><th>methods</th><th>style</th><th>source</th><th>kv</th></tr>
${rows || '<tr><td colspan="6" class="muted">none</td></tr>'}
</table>
<h2>static assets (${m.static ? m.static.length : '?'})</h2>
<table><tr><th>path</th><th>content-type</th><th>bytes</th></tr>
${assets || `<tr><td colspan="3" class="muted">${m.static ? 'none' : 'no list in manifest; assets are looked up on chain per request'}</td></tr>`}
</table>
${m.env.length ? `<h2>environment</h2><p><code>${m.env.map(escape).join('</code> <code>')}</code></p>` : ''}
<p class="muted">reads are simulated transactions; writes are signed by the gateway wallet. Bodies are capped at ${state.bodyLimit} bytes.</p>
`;
}

async function maybeRefreshManifest(state, force = false) {
  if (!state.connection) return;
  if (!force && Date.now() - state.manifestAt < state.cacheTtlMs) return;
  if (state._refreshing) return state._refreshing;
  state._refreshing = (async () => {
    try {
      const m = await readManifest(state.connection, state.programId);
      if (m) state.manifest = normalizeManifest(m);
      state.manifestAt = Date.now();
    } catch (e) {
      state.log(`manifest refresh failed: ${e?.message || e}`);
      state.manifestAt = Date.now() - state.cacheTtlMs + 5000;
    } finally { state._refreshing = null; }
  })();
  return force ? state._refreshing : undefined;
}

// ---------------------------------------------------------------- the request loop

/**
 * Route one request. `req` is `{method, url, headers, body, remoteAddress?}` (body: Buffer|string|null).
 * Returns `{status, headers, body}`; the http wrapper writes it out.
 */
export async function handleRequest(state, req) {
  state.stats.requests++;
  const method = String(req.method || 'GET').toUpperCase();
  req = { ...req, method, headers: lowerKeys(req.headers) };
  if (!ALL_METHODS.includes(method)) return json(405, { error: 'method not allowed', method }, { allow: ALL_METHODS.join(', ') });
  const { pathname, query } = parseUrl(req.url);

  if (pathname === ZOO_PREFIX || pathname.startsWith(ZOO_PREFIX + '/') || pathname === MANIFEST_PATH) {
    const r = await serveZoo(state, pathname, req);
    if (r) return r;
    return json(404, { error: 'not found', path: pathname });
  }
  void maybeRefreshManifest(state);

  const phases = routePhases(state.manifest.config.routes);
  let p = pathname, q = query;
  const extraHeaders = {};
  let lastMatch = null;

  // Phase 1: routes before `handle: filesystem` (redirects, header rules, early rewrites).
  const pre = applyPhase(phases.pre, p, q, method, extraHeaders);
  if (pre.response) return pre.response;
  p = pre.pathname; q = pre.query; lastMatch = pre.match || lastMatch;

  // Phase 2: the filesystem — static files, then functions by exact output path.
  let hit = await resolveFilesystem(state, p, method, lastMatch, pathname);
  if (!hit) {
    // Phase 3: routes after the filesystem marker (dynamic function routes, SPA fallbacks).
    const post = applyPhase(phases.post, p, q, method, extraHeaders);
    if (post.response) return post.response;
    if (post.rewritten) {
      p = post.pathname; q = post.query; lastMatch = post.match || lastMatch;
      hit = await resolveFilesystem(state, p, method, lastMatch, pathname);
    }
  }
  if (!hit) {
    // Manifests without a `config.routes` list still route by function pattern.
    const fn = matchFunction(state, p, method);
    if (fn) hit = { kind: 'function', ...fn };
  }
  if (hit?.kind === 'static') {
    const res = await serveStatic(state, hit.path, req, extraHeaders);
    if (res) return res;
    // Listed in the manifest but not on chain (partial deploy): say so instead of falling through.
    return json(404, { error: 'asset missing on chain', path: hit.path, hint: 'the manifest lists this file but its account is absent; run deploy again' }, { 'x-zoo-program': state.programIdStr });
  }
  if (hit?.kind === 'function') {
    if (!hit.allowed) {
      const allow = (hit.route.methods || []).map((m) => m.toUpperCase());
      if (allow.includes('GET') && !allow.includes('HEAD')) allow.push('HEAD');
      return json(405, { error: 'method not allowed', method, path: pathname, allow }, { allow: allow.join(', '), 'x-zoo-program': state.programIdStr });
    }
    return serveFunction(state, hit, req, p, q, extraHeaders);
  }

  // Phase 4: error routes (custom 404 pages).
  for (const r of phases.error) {
    const m = matchRoute(r, p, method);
    if (!m || !r.dest) continue;
    const dest = resolveDest(r.dest, m).split('?')[0];
    const res = await serveStatic(state, dest, req, extraHeaders);
    if (res) return { ...res, status: res.status === 200 ? (r.status || 404) : res.status };
  }
  return json(404, { error: 'not found', path: pathname, method, hint: `no static file or function matched; see ${ZOO_PREFIX}/ for what this program serves` }, { 'x-zoo-program': state.programIdStr });
}

function lowerKeys(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) out[k.toLowerCase()] = v;
  return out;
}

/** Run one phase of `src`/`dest` routes against the current path. */
function applyPhase(routes, pathname, query, method, extraHeaders) {
  let p = pathname, q = query, rewritten = false, match = null;
  for (const r of routes) {
    const m = matchRoute(r, p, method);
    if (!m) continue;
    if (r.headers) for (const [k, v] of Object.entries(r.headers)) extraHeaders[k.toLowerCase()] = resolveDest(String(v), m);
    if (r.status && !r.dest) {
      const loc = extraHeaders['location'];
      return { response: { status: r.status, headers: { ...extraHeaders, 'content-type': JSON_CT }, body: Buffer.from(JSON.stringify(loc ? { redirect: loc } : { status: r.status })) } };
    }
    if (r.dest) {
      const dest = resolveDest(r.dest, m);
      if (/^https?:\/\//i.test(dest)) {
        if (r.status && r.status >= 300 && r.status < 400) return { response: { status: r.status, headers: { ...extraHeaders, location: dest }, body: Buffer.alloc(0) } };
        return { response: json(501, { error: 'external rewrite not supported', dest, hint: 'the on-chain program cannot proxy to other hosts' }) };
      }
      const qi = dest.indexOf('?');
      p = qi >= 0 ? dest.slice(0, qi) : dest;
      if (qi >= 0) q = mergeQuery(q, dest.slice(qi + 1));
      if (r.status && r.status >= 300 && r.status < 400) return { response: { status: r.status, headers: { ...extraHeaders, location: p + (q ? '?' + q : '') }, body: Buffer.alloc(0) } };
      rewritten = true; match = m;
    }
    if (!r.continue) break;
  }
  return { pathname: p, query: q, rewritten, match };
}

async function resolveFilesystem(state, p, method, lastMatch, originalPath) {
  const st = await lookupStatic(state, p);
  if (st) return { kind: 'static', path: st };
  // A rewrite to a function's routePath (e.g. "/api/users/[id]") lands here.
  const byPath = functionByRoutePath(state, p);
  if (byPath) {
    let params = {};
    const re = byPath.pattern ? routeRegex(byPath.pattern, true) : null;
    const m = re ? re.exec(originalPath) : null;
    if (m) (byPath.params || []).forEach((name, i) => { if (m[i + 1] != null) params[name] = decodeURIComponentSafe(m[i + 1]); });
    else if (lastMatch) (byPath.params || []).forEach((name, i) => { if (lastMatch[i + 1] != null) params[name] = decodeURIComponentSafe(lastMatch[i + 1]); });
    return { kind: 'function', route: byPath, params, allowed: methodAllowed(byPath, method) };
  }
  const fn = matchFunction(state, p, method);
  return fn ? { kind: 'function', ...fn } : null;
}

// ---------------------------------------------------------------- http

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Hop-by-hop and framing headers the gateway owns; a handler's values must not reach the socket. */
const OWNED_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'proxy-connection', 'te', 'trailer']);

/** Drop headers a program could use to break HTTP framing or that node would refuse to write. */
export function safeResponseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const name = String(k).toLowerCase();
    if (OWNED_HEADERS.has(name) || !HEADER_NAME.test(name)) continue;
    const val = Array.isArray(v) ? v.map(String).join(', ') : String(v ?? '');
    if (/[\r\n\0]/.test(val)) continue;
    out[name] = val;
  }
  return out;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0, tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return;
      len += c.length;
      if (len > limit + 1) { tooBig = true; chunks.push(c.subarray(0, Math.max(0, limit + 2 - (len - c.length)))); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve({ body: Buffer.concat(chunks), truncated: tooBig, length: len }));
    req.on('error', reject);
  });
}

/**
 * Serve a program over HTTP. Resolves once listening.
 * @returns {Promise<{server:import('node:http').Server, port:number, url:string, state:object, close:()=>Promise<void>}>}
 */
export async function startGateway({ programId, cluster, port = DEFAULT_PORT, host = '127.0.0.1', keypair, manifest, invoke, connection, cacheTtlMs, log = console.log, quiet = false } = {}) {
  const rpc = safeRpcUrl(cluster || process.env.OPENZOO_CLUSTER || 'localnet');
  connection = connection ?? (rpc ? connect(rpc) : null);
  const state = makeState({ programId, cluster, connection, keypair, manifest, invoke, cacheTtlMs, port, log: quiet ? () => {} : log });
  if (!manifest && connection) {
    try {
      const m = await readManifest(connection, state.programId);
      if (m) { state.manifest = normalizeManifest(m); state.manifestAt = Date.now(); }
      else if (!quiet) log(`warning: no manifest at ${MANIFEST_PATH} for ${state.programIdStr}; routing by on-chain lookup only`);
    } catch (e) { if (!quiet) log(`warning: could not read the manifest: ${e?.message || e}`); }
  }
  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    try {
      const { body, truncated, length } = await readBody(req, PACKET_DATA_SIZE);
      const r = truncated
        ? json(413, { error: 'payload too large', limit: state.bodyLimit, received: length, message: `request bodies travel inside a Solana transaction (${PACKET_DATA_SIZE} bytes); at most ${state.bodyLimit} bytes of body` })
        : await handleRequest(state, { method: req.method, url: req.url, headers: req.headers, body, remoteAddress: req.socket?.remoteAddress });
      const out = Buffer.isBuffer(r.body) ? r.body : Buffer.from(String(r.body ?? ''));
      const headers = safeResponseHeaders(r.headers);
      headers['content-length'] = String(out.length);
      res.writeHead(r.status, headers);
      res.end(req.method === 'HEAD' ? undefined : out);
      if (!quiet) log(`${req.method} ${req.url} → ${r.status} ${out.length}B ${Date.now() - t0}ms${headers['x-zoo-signature'] ? ' sig=' + headers['x-zoo-signature'].slice(0, 12) : ''}`);
    } catch (e) {
      if (!quiet) log(`${req.method} ${req.url} → 500 ${e?.stack || e}`);
      if (!res.headersSent) { res.writeHead(500, { 'content-type': JSON_CT }); }
      res.end(JSON.stringify({ error: 'gateway error', message: String(e?.message || e) }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const actualPort = server.address().port;
  state.port = actualPort;
  const url = `http://${host}:${actualPort}`;
  return {
    server, port: actualPort, url, state,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
