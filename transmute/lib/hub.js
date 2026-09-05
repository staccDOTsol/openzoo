// The hosted explorer: one process, any number of transmuted sites.
//
// `openzoo-transmute serve` fronts ONE program on localhost. The hub fronts
// EVERY program on a cluster from one public host, read-only:
//
//   GET /s/<programId>            pin that site (cookie) and go to its /
//   GET /s/<programId>/<path>     one page of it, absolute
//   GET /<path>                   the pinned site's <path> (so a site's own
//                                 root-relative links — /app.js, /api/x — work)
//   GET /.hub                     the landing page (paste a program id)
//   GET /.hub/leave               unpin
//   GET /.hub/sites.json          what this hub has served lately
//
// Reads are free simulations, exactly like the local gateway. Writes need a
// signer, and a public host must never sign with a shared wallet, so they
// answer 402 with the same message the local gateway gives — the seam where
// x402 pays per request later. Everything a site is comes from the chain:
// the manifest at /.zoo/manifest.json, the assets, the program; the hub only
// caches.
import http from 'node:http';
import { PublicKey } from '@solana/web3.js';
import { makeState, normalizeManifest, handleRequest, safeResponseHeaders, PACKET_DATA_SIZE, BODY_LIMIT } from './gateway.js';
import { connect, readManifest, getSiteInfo } from './solana.js';
import { rpcUrl } from './wallet.js';
import { MANIFEST_PATH } from './wire.js';

export const HUB_PREFIX = '/.hub';
export const SITE_PREFIX = '/s/';
export const COOKIE = 'zoo_site';
export const DEFAULT_HUB_PORT = 8080;

const JSON_CT = 'application/json; charset=utf-8';
const HTML_CT = 'text/html; charset=utf-8';

function isProgramId(s) {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try { new PublicKey(s); return true; } catch { return false; }
}

function cookieOf(req) {
  const raw = req.headers?.cookie || '';
  for (const part of String(raw).split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) { const id = decodeURIComponent(v.join('=')); return isProgramId(id) ? id : null; }
  }
  return null;
}

const setCookie = (id) => `${COOKIE}=${id}; Path=/; Max-Age=2592000; SameSite=Lax`;
const clearCookie = () => `${COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;

function json(status, body, headers = {}) {
  return { status, headers: { 'content-type': JSON_CT, ...headers }, body: Buffer.from(JSON.stringify(body, null, 2)) };
}
function html(status, body, headers = {}) {
  return { status, headers: { 'content-type': HTML_CT, ...headers }, body: Buffer.from(body) };
}
function redirect(location, headers = {}) {
  return { status: 302, headers: { location, 'content-type': 'text/plain; charset=utf-8', ...headers }, body: Buffer.from(`→ ${location}\n`) };
}
const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Hub state: the cluster connection plus an LRU of per-site gateway states.
 * `o.makeSite(programId)` can be injected for tests.
 */
export function makeHub(o = {}) {
  const cluster = o.cluster || process.env.OPENZOO_CLUSTER || 'mainnet';
  const rpc = o.connection?.rpcEndpoint || rpcUrl(cluster);
  const hub = {
    cluster,
    rpc,
    connection: o.connection ?? connect(rpc),
    keypair: o.keypair ?? null,
    sites: new Map(),                    // programId -> { state, at, lastSeen, hits }
    maxSites: o.maxSites ?? 64,
    manifestTtlMs: o.manifestTtlMs ?? 60_000,
    log: o.log ?? (() => {}),
    makeSite: o.makeSite ?? null,
    startedAt: Date.now(),
    stats: { requests: 0, sitesLoaded: 0, writes: 0, writesRefused: 0, spentLamports: 0 },
    publicUrl: o.publicUrl || null,
    // The shared runtime program on this cluster: ids that are site accounts
    // under it are served as shared sites; anything else as a compiled program.
    runtime: o.runtime || process.env.OPENZOO_VM_PROGRAM || null,
    // write governor: per-IP token bucket + a daily lamport budget for the signer
    writesPerMin: o.writesPerMin ?? Number(process.env.OPENZOO_HUB_WRITES_PER_MIN || 3),
    budgetLamports: Math.round((o.writeBudgetSol ?? Number(process.env.OPENZOO_HUB_WRITE_BUDGET_SOL || 0.05)) * 1e9),
    ipHits: new Map(),
    dayStart: Date.now(),
  };
  return hub;
}

const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/** Allow a signed write? Refills per minute per IP; budget resets daily. */
export function allowWrite(hub, ip, now = Date.now()) {
  if (!hub.keypair) return { ok: false, reason: 'no signer' };
  if (now - hub.dayStart > 86_400_000) { hub.dayStart = now; hub.stats.spentLamports = 0; }
  if (hub.stats.spentLamports >= hub.budgetLamports) return { ok: false, reason: 'daily write budget spent' };
  const key = ip || 'unknown';
  const win = hub.ipHits.get(key) || { t: now, n: 0 };
  if (now - win.t > 60_000) { win.t = now; win.n = 0; }
  if (win.n >= hub.writesPerMin) return { ok: false, reason: `rate limit: ${hub.writesPerMin} writes/min` };
  win.n++; hub.ipHits.set(key, win);
  if (hub.ipHits.size > 10_000) hub.ipHits.clear();
  return { ok: true };
}

async function siteFor(hub, programId) {
  const hit = hub.sites.get(programId);
  if (hit) {
    hit.lastSeen = Date.now(); hit.hits++;
    hub.sites.delete(programId); hub.sites.set(programId, hit); // LRU order
    return hit;
  }
  let state;
  if (hub.makeSite) state = await hub.makeSite(programId);
  else {
    let shared = false;
    if (hub.runtime) {
      try { shared = (await getSiteInfo(hub.connection, hub.runtime, programId)).exists; } catch { /* fall through to program mode */ }
    }
    state = shared
      ? makeState({ programId: hub.runtime, site: programId, cluster: hub.cluster, connection: hub.connection, keypair: hub.keypair, log: hub.log, cacheTtlMs: hub.manifestTtlMs })
      : makeState({ programId, cluster: hub.cluster, connection: hub.connection, keypair: hub.keypair, log: hub.log, cacheTtlMs: hub.manifestTtlMs });
    try {
      const m = await readManifest(hub.connection, state.programId, state.site);
      if (m) { state.manifest = normalizeManifest(m); state.manifestAt = Date.now(); }
      else state.noManifest = true;
    } catch (e) { state.manifestError = String(e?.message || e); }
  }
  const entry = { state, at: Date.now(), lastSeen: Date.now(), hits: 1 };
  // An RPC failure is not a fact about the site: answer it, but do not cache it.
  if (state.manifestError) return entry;
  hub.sites.set(programId, entry);
  hub.stats.sitesLoaded++;
  while (hub.sites.size > hub.maxSites) hub.sites.delete(hub.sites.keys().next().value);
  return entry;
}

function siteSummary(id, entry) {
  const m = entry.state.manifest || {};
  return {
    programId: id,
    mode: entry.state.site ? 'shared' : 'program',
    name: m.name || null,
    framework: m.framework || null,
    routes: (m.routes || []).length,
    assets: (m.static || []).length,
    deployedAt: m.deployedAt || null,
    manifest: entry.state.noManifest ? 'missing' : entry.state.manifestError ? `error: ${entry.state.manifestError}` : 'ok',
    hits: entry.hits,
    lastSeen: new Date(entry.lastSeen).toISOString(),
  };
}

export function landingHtml(hub, pinned = null) {
  const rows = [...hub.sites.entries()].reverse().map(([id, e]) => {
    const s = siteSummary(id, e);
    return `<tr><td><a href="/s/${escape(id)}">${escape(s.name || id.slice(0, 8) + '…')}</a></td><td><code>${escape(id)}</code></td><td>${s.routes}</td><td>${s.assets}</td><td>${escape(s.manifest)}</td></tr>`;
  }).join('\n');
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>openzoo sites · ${escape(hub.cluster)}</title>
<style>
  :root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}
  body{max-width:56rem;margin:2rem auto;padding:0 1rem;line-height:1.45}
  h1{font-size:1.5rem;margin:.2rem 0} .muted{opacity:.7} code{font-size:.9em}
  form{display:flex;gap:.5rem;margin:1rem 0} input{flex:1;padding:.55rem .7rem;font:inherit;border:1px solid #8884;border-radius:.4rem;background:transparent;color:inherit}
  button{padding:.55rem 1rem;font:inherit;border:1px solid #8886;border-radius:.4rem;background:#3b82f6;color:#fff;cursor:pointer}
  table{border-collapse:collapse;width:100%;font-size:.92rem} td,th{padding:.35rem .5rem;border-bottom:1px solid #8883;text-align:left;vertical-align:top}
  pre{background:#8881;padding:.7rem;border-radius:.4rem;overflow:auto;font-size:.85rem}
  .pin{padding:.6rem .8rem;border:1px solid #3b82f6;border-radius:.4rem;margin:1rem 0}
</style>
<h1>openzoo sites</h1>
<p class="muted">Vercel apps transmuted onto Solana <b>${escape(hub.cluster)}</b>: the frontend lives in asset accounts, the <code>/api/*</code> Lambdas run as a Pinocchio program. This host reads them straight off the chain. Reads are free simulations; writes need a signer, so they answer 402 here — run <code>npx openzoo serve &lt;programId&gt;</code> locally to write with your own wallet.</p>
${pinned ? `<div class="pin">Pinned site: <code>${escape(pinned)}</code> — <a href="/">open</a> · <a href="/.zoo/">explorer</a> · <a href="/.hub/leave">unpin</a></div>` : ''}
<form action="/.hub/go" method="get"><input name="program" placeholder="program id (base58)" autocomplete="off" required pattern="[1-9A-HJ-NP-Za-km-z]{32,44}"><button type="submit">open</button></form>
<h2 style="font-size:1.1rem">recently served</h2>
${rows ? `<table><tr><th>site</th><th>program</th><th>routes</th><th>assets</th><th>manifest</th></tr>${rows}</table>` : '<p class="muted">nothing yet — paste a program id above.</p>'}
<h2 style="font-size:1.1rem">put your app here</h2>
<pre>npx openzoo inspect .            # your Next.js / Vite app, in Vercel terms + eligibility
npx openzoo build .              # → Pinocchio Rust program + asset plan (cargo build-sbf)
npx openzoo deploy . --cluster ${escape(hub.cluster)} --yes   # rent is quoted first; paid by ~/.openzoo/wallet.json
# then:  ${escape(hub.publicUrl || 'https://<this host>')}/s/&lt;programId&gt;</pre>
<p class="muted">Each site's <code>/.zoo/manifest.json</code> and <code>/.zoo/status</code> are public; <code>/.hub/sites.json</code> lists what this hub has served.</p>
`;
}

async function readBody(req, max) {
  return new Promise((resolve) => {
    const chunks = []; let length = 0, truncated = false;
    req.on('data', (c) => { length += c.length; if (length > max) { truncated = true; req.destroy?.(); return; } chunks.push(c); });
    req.on('end', () => resolve({ body: Buffer.concat(chunks), truncated, length }));
    req.on('error', () => resolve({ body: Buffer.concat(chunks), truncated, length }));
    req.on('close', () => resolve({ body: Buffer.concat(chunks), truncated, length }));
  });
}

/** Route one request. `req` = { method, url, headers, body, remoteAddress }. */
export async function handleHub(hub, req) {
  hub.stats.requests++;
  const method = String(req.method || 'GET').toUpperCase();
  const url = new URL(req.url || '/', 'http://hub.local');
  const pathname = url.pathname;
  const pinned = cookieOf(req);

  // ---- hub pages
  if (pathname === HUB_PREFIX || pathname === `${HUB_PREFIX}/`) return html(200, landingHtml(hub, pinned));
  if (pathname === `${HUB_PREFIX}/go`) {
    const id = (url.searchParams.get('program') || '').trim();
    if (!isProgramId(id)) return json(400, { error: 'not a program id', program: id });
    return redirect(`${SITE_PREFIX}${id}`);
  }
  if (pathname === `${HUB_PREFIX}/leave`) return redirect(HUB_PREFIX, { 'set-cookie': clearCookie() });
  if (pathname === `${HUB_PREFIX}/sites.json`) {
    return json(200, { cluster: hub.cluster, rpc: hub.rpc.replace(/\?.*$/, ''), sites: [...hub.sites.entries()].map(([id, e]) => siteSummary(id, e)), uptimeS: Math.round((Date.now() - hub.startedAt) / 1000), stats: hub.stats });
  }
  if (pathname === `${HUB_PREFIX}/health`) return json(200, { ok: true, sites: hub.sites.size, cluster: hub.cluster });

  // ---- /s/<programId>[/<path>]
  let target = null, rest = null, pin = false;
  if (pathname.startsWith(SITE_PREFIX)) {
    const after = pathname.slice(SITE_PREFIX.length);
    const slash = after.indexOf('/');
    const id = slash < 0 ? after : after.slice(0, slash);
    if (!isProgramId(id)) return json(400, { error: 'not a program id', program: id });
    target = id; pin = true;
    rest = slash < 0 ? null : after.slice(slash) || '/';
    if (rest === null) return redirect('/', { 'set-cookie': setCookie(id) }); // pin, then the site's own /
  } else if (pinned) {
    target = pinned; rest = pathname;
  } else {
    if (pathname === '/') return html(200, landingHtml(hub, null));
    return json(404, { error: 'no site pinned', hint: `open /s/<programId> first, or /.hub` });
  }

  const entry = await siteFor(hub, target);
  const state = entry.state;
  if (state.manifestError) {
    return json(502, { error: 'rpc error', message: state.manifestError, cluster: hub.cluster, rpc: hub.rpc.replace(/\?.*$/, ''), program: target }, pin ? { 'set-cookie': setCookie(target) } : {});
  }
  if (state.noManifest && (rest === '/' || rest === MANIFEST_PATH)) {
    return json(404, { error: 'no site at this program id', program: target, hint: `no manifest at ${MANIFEST_PATH}; is this an openzoo-transmute deployment on ${hub.cluster}?` }, pin ? { 'set-cookie': setCookie(target) } : {});
  }
  if (!READ_METHODS.includes(method) && hub.keypair) {
    const gate = allowWrite(hub, req.remoteAddress || req.headers?.['fly-client-ip'] || req.headers?.['x-forwarded-for']);
    if (!gate.ok) { hub.stats.writesRefused++; return json(429, { error: 'write refused', reason: gate.reason, hint: 'run `npx openzoo serve <programId>` locally to write with your own wallet' }, { 'x-zoo-site': target }); }
  }
  const before = hub.keypair && !READ_METHODS.includes(method) ? await hub.connection.getBalance(hub.keypair.publicKey).catch(() => null) : null;
  const r = await handleRequest(state, { ...req, method, url: rest + (url.search || '') });
  if (before != null) {
    hub.stats.writes++;
    const after = await hub.connection.getBalance(hub.keypair.publicKey).catch(() => before);
    hub.stats.spentLamports += Math.max(0, before - after);
  }
  const headers = { ...(r.headers || {}), 'x-zoo-site': target };
  if (pin) headers['set-cookie'] = setCookie(target);
  return { ...r, headers };
}

export async function startHub({ cluster, port = DEFAULT_HUB_PORT, host = '0.0.0.0', keypair = null, connection, log = console.log, quiet = false, publicUrl, maxSites } = {}) {
  const hub = makeHub({ cluster, connection, keypair, log: quiet ? () => {} : log, publicUrl, maxSites });
  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    try {
      const { body, truncated, length } = await readBody(req, PACKET_DATA_SIZE);
      const r = truncated
        ? json(413, { error: 'payload too large', limit: BODY_LIMIT, received: length })
        : await handleHub(hub, { method: req.method, url: req.url, headers: req.headers, body, remoteAddress: req.socket?.remoteAddress });
      const out = Buffer.isBuffer(r.body) ? r.body : Buffer.from(String(r.body ?? ''));
      const headers = safeResponseHeaders(r.headers);
      headers['content-length'] = String(out.length);
      res.writeHead(r.status, headers);
      res.end(req.method === 'HEAD' ? undefined : out);
      if (!quiet) log(`${req.method} ${req.url} → ${r.status} ${out.length}B ${Date.now() - t0}ms${headers['x-zoo-site'] ? ' site=' + headers['x-zoo-site'].slice(0, 8) : ''}`);
    } catch (e) {
      if (!quiet) log(`${req.method} ${req.url} → 500 ${e?.stack || e}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': JSON_CT });
      res.end(JSON.stringify({ error: 'hub error', message: String(e?.message || e) }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
  const actualPort = server.address().port;
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`;
  return { hub, server, port: actualPort, url, close: () => new Promise((r) => server.close(() => r())) };
}
