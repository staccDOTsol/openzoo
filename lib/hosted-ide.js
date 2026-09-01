/**
 * Cloud IDE door for grokui Desktop Agent.
 *
 * Site origin: https://zoo.openzoo.fun
 *   POST /api/ide/session
 *   GET  /api/ide/session
 *   Authorization: Bearer <OpenZoo subscription key>
 *   → { url, password?, id }
 *   Not /ide/session (door moved).
 *
 * 401 if no / invalid key. Never ANTHROPIC_API_KEY. Never an open URL.
 * Never log the subscription key or the code-server password.
 *
 * Password (if the door returns one) is applied as a query param or HTTP
 * basic, matching whatever the site PR documents (`auth` / `passwordMethod`).
 */
import { BILLING_ORIGIN, loadSubscription } from './subscription.js';

export const IDE_PUBLIC_ORIGIN = BILLING_ORIGIN;
export const IDE_SESSION_PATH = '/api/ide/session';

export function ideOrigin(env = process.env) {
  const pinned = String(env.OPENZOO_IDE_ORIGIN || env.OPENZOO_IDE_BASE_URL || '').trim();
  if (pinned) return pinned.replace(/\/+$/, '');
  return IDE_PUBLIC_ORIGIN;
}

export function ideSessionEndpoint(origin = ideOrigin()) {
  return `${String(origin || '').replace(/\/+$/, '')}${IDE_SESSION_PATH}`;
}

function asKey(v) {
  return String(v || '').trim();
}

/**
 * Turn a door `{ url, password? }` into an iframe src.
 * Never invents a host. Empty / non-http(s) → ''.
 */
export function ideFrameSrc(url, password, extra = {}) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  let u;
  try { u = new URL(raw); } catch { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  const pass = asKey(password || extra.password);
  if (!pass) return u.href;
  if (u.password || u.searchParams.has('password')) return u.href;
  const method = String(extra.auth || extra.passwordMethod || 'query').toLowerCase();
  if (method === 'basic') {
    if (!u.username) u.username = String(extra.username || 'coder');
    u.password = pass;
    return u.href;
  }
  u.searchParams.set('password', pass);
  return u.href;
}

/** Renderer / HTTP body — never the subscription key, never a raw password field. */
export function publicIdeSession(sess) {
  if (!sess?.ok || !asKey(sess.url)) {
    return {
      ok: false,
      status: Number(sess?.status) || 401,
      error: sess?.error || 'unauthorized',
    };
  }
  return { ok: true, url: sess.url, id: sess.id || null };
}

/**
 * POST or GET /api/ide/session with the OpenZoo subscription Bearer.
 * Missing key → 401 locally (no network). Door 401 → 401. No URL → fail closed.
 */
export async function createIdeSession({
  key,
  fetchImpl = fetch,
  origin,
  env = process.env,
  auth,
  username,
  method = 'POST',
} = {}) {
  const token = asKey(key);
  if (!token || token.length < 8) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  const door = ideSessionEndpoint(origin || ideOrigin(env));
  const verb = String(method || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
  let http = 0;
  let body = {};
  try {
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    };
    const init = { method: verb, headers };
    if (verb === 'POST') {
      headers['content-type'] = 'application/json';
      init.body = '{}';
    }
    const r = await fetchImpl(door, init);
    http = r.status;
    body = await r.json().catch(() => ({}));
  } catch {
    return { ok: false, status: 503, error: 'ide unavailable' };
  }
  if (http === 401 || http === 403) {
    return { ok: false, status: 401, error: asKey(body?.error || body?.message) || 'unauthorized' };
  }
  if (http >= 500) return { ok: false, status: 503, error: 'ide unavailable' };
  if (http < 200 || http >= 300) {
    return { ok: false, status: 401, error: asKey(body?.error || body?.message) || 'unauthorized' };
  }
  const frame = ideFrameSrc(body?.url, body?.password, {
    auth: body?.auth || body?.passwordMethod || auth,
    username: body?.username || username,
    password: body?.password,
  });
  if (!frame) {
    return { ok: false, status: 502, error: 'ide returned no url' };
  }
  return {
    ok: true,
    status: 200,
    url: frame,
    id: body.id || body.sessionId || null,
  };
}

export async function openStoredIdeSession(opts = {}) {
  const sub = opts.sub !== undefined ? opts.sub : loadSubscription(opts.file);
  return createIdeSession({ ...opts, key: sub?.key });
}
