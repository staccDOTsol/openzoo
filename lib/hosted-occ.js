/**
 * Hosted OCC HTTP API for OpenZoo mobile (iOS Agent).
 *
 * Phones cannot run packed openzoo-claude + node-pty. Desktop grokui Agent
 * is a local PTY; mobile talks to this door. Public origin the iOS app
 * already uses: https://zoo.openzoo.fun (same as /api/billing/tiers).
 *
 * Every /occ route requires Authorization: Bearer <OpenZoo subscription key>.
 * Missing / invalid / expired → 401. No PTY, no upload, no session.
 * Never ANTHROPIC_API_KEY. Never the raw token in logs or query strings.
 * Sessions and uploads are isolated per key fingerprint.
 *
 * iOS www/js/occ.js paths (do not rename):
 *   POST /occ/sessions
 *   POST /occ/sessions/:id/messages   (SSE when stream:true)
 *   POST /occ/sessions/:id/files
 *   POST /occ/sessions/:id/stop
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { claudeInteractiveArgs, claudeModelArg } from './claudecode.js';
import { claudeZooEnv, resolveOpenzooClaude } from './launch.js';
import {
  findPackedNodePty, loadNodePtyFrom, resolvePackedOpenzooClaude,
} from './packed-runtime.js';
import {
  BILLING_ORIGIN,
  bearerFromAuthorization,
  subscriptionPublicView,
  verifySubscriptionKey,
} from './subscription.js';

export const OCC_PUBLIC_ORIGIN = BILLING_ORIGIN;
export const DEFAULT_OCC_PORT = 8410;
export const DEFAULT_UPLOAD_MAX = 8 * 1024 * 1024;
const PTY_BUF_CAP = 512 * 1024;
const VERIFY_TTL_MS = 45_000;

const CR = String.fromCharCode(13);
const ESC = String.fromCharCode(27);

export function fingerprintKey(key) {
  return crypto.createHash('sha256').update(String(key || ''), 'utf8').digest('hex');
}

export function occRoot(env = process.env) {
  return env.OPENZOO_OCC_ROOT
    || path.join(env.HOME || env.USERPROFILE || homedir(), '.openzoo', 'occ-sessions');
}

export function occCompletionsUrl(env = process.env) {
  const pinned = String(env.OPENZOO_OCC_BASE_URL || '').trim();
  if (pinned) return pinned.replace(/\/+$/, '');
  if (env.OPENZOO_OCC_SIDECAR === '1') {
    return `http://127.0.0.1:${env.OPENZOO_PORT || config.port}/v1`;
  }
  return `${config.apiBase}/v1`;
}

export function occZooEnv(baseEnv, { token, base } = {}) {
  const env = claudeZooEnv({
    ...baseEnv,
    ANTHROPIC_AUTH_TOKEN: token,
    OPENZOO_SUBSCRIPTION_KEY: token,
  }, { base: base || occCompletionsUrl(baseEnv) });
  delete env.ANTHROPIC_API_KEY;
  env.ANTHROPIC_AUTH_TOKEN = token;
  return env;
}

export function occSpawnSpec({
  env = process.env, execPath = process.execPath, token, model, base,
} = {}) {
  const resolved = resolvePackedOpenzooClaude({ env, execPath }) || resolveOpenzooClaude(env);
  if (!resolved) return null;
  const ptyEnv = occZooEnv(env, { token, base });
  if (resolved.via === 'packed') ptyEnv.ELECTRON_RUN_AS_NODE = '1';
  ptyEnv.TERM = 'xterm-256color';
  ptyEnv.COLORTERM = 'truecolor';
  ptyEnv.FORCE_COLOR = '3';
  if (!ptyEnv.LANG || !/utf-8/i.test(ptyEnv.LANG)) ptyEnv.LANG = 'C.UTF-8';
  if (!ptyEnv.LC_ALL || !/utf-8/i.test(ptyEnv.LC_ALL)) ptyEnv.LC_ALL = ptyEnv.LANG;
  const home = ptyEnv.HOME || ptyEnv.USERPROFILE || homedir();
  ptyEnv.CLAUDE_CONFIG_DIR = ptyEnv.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  delete ptyEnv.ANTHROPIC_API_KEY;
  return {
    command: resolved.command,
    args: [...resolved.prefixArgs, ...claudeInteractiveArgs({
      model: claudeModelArg(model),
      system: '',
    })],
    via: resolved.via,
    env: ptyEnv,
  };
}

function loadOccNodePty() {
  return loadNodePtyFrom(findPackedNodePty())
    || loadNodePtyFrom(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'node_modules', 'node-pty'));
}

export function defaultSpawnOccPty(spec, { cwd, cols, rows } = {}) {
  const pty = loadOccNodePty();
  if (!pty?.spawn) {
    const err = new Error('node-pty missing');
    err.code = 'PTY_PENDING';
    throw err;
  }
  const proc = pty.spawn(spec.command, spec.args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd || process.cwd(),
    env: spec.env,
  });
  return {
    write: (s) => { try { proc.write(s); } catch { /* closed */ } },
    resize: (c, r) => { try { proc.resize(c, r); } catch { /* closed */ } },
    onData: (fn) => {
      proc.onData((d) => fn(Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8')));
    },
    onExit: (fn) => { proc.onExit(({ exitCode }) => fn(exitCode ?? 0)); },
    kill: () => { try { proc.kill(); } catch { /* gone */ } },
    pid: proc.pid,
  };
}

export function stripPtyLineTail(s) {
  let out = String(s ?? '');
  while (out.length) {
    const c = out.charCodeAt(out.length - 1);
    if (c !== 13 && c !== 10) break;
    out = out.slice(0, -1);
  }
  return out;
}

export function ptyLooksReady(sess) {
  if (!sess || sess.dead) return false;
  const raw = Buffer.isBuffer(sess.buf) ? sess.buf.toString('utf8') : String(sess.buf || '');
  if (!raw) return false;
  const visible = stripAnsi(raw).replace(/\r/g, '');
  const lines = visible.split('\n');
  let last = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].replace(/[ \t]+$/g, '');
    if (t) { last = t; break; }
  }
  return /(?:^|[ \t])>\s*$/.test(last);
}

export function stripAnsi(s) {
  return String(s || '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b./g, '');
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitPtyReadyAfterGrowth(sess, startLen, timeoutMs = 2500) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (sess.dead) return false;
    const len = sess.buf && sess.buf.length ? sess.buf.length : 0;
    if (len > startLen && ptyLooksReady(sess)) return true;
    await sleepMs(20);
  }
  return false;
}

/** Same write protocol as grokui writeAgentPtyLine. /goal is a message string. */
export async function writeOccPtyLine(sess, line) {
  if (!sess || sess.dead || typeof sess.write !== 'function') return false;
  const text = stripPtyLineTail(line);
  if (/^\/goal\b/i.test(text)) sess.goalSet = true;
  if (text.charAt(0) === '/') {
    if (ptyLooksReady(sess)) {
      sess.write(text + CR);
      sess.didWriteLine = true;
      return true;
    }
    const startLen = sess.buf && sess.buf.length ? sess.buf.length : 0;
    sess.write(ESC);
    await waitPtyReadyAfterGrowth(sess, startLen, 2500);
    if (sess.dead) return false;
    sess.write(text + CR);
    sess.didWriteLine = true;
    return true;
  }
  if (!sess.didWriteLine) {
    sess.write(text + CR);
    sess.didWriteLine = true;
    return true;
  }
  sess.write(ESC);
  await sleepMs(80);
  if (sess.dead) return false;
  sess.write(text + CR);
  return true;
}

export function safeResolveIn(base, rel) {
  const root = path.resolve(String(base || '.'));
  const raw = String(rel ?? '').trim() || '.';
  if (raw.includes('\0')) throw new Error('path escapes this session workspace');
  if (path.isAbsolute(raw) || raw.startsWith('~')) {
    throw new Error('path escapes this session workspace');
  }
  const posix = raw.replace(/\\/g, '/');
  if (posix.split('/').includes('..')) {
    throw new Error('path escapes this session workspace');
  }
  const full = path.resolve(root, posix);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('path escapes this session workspace');
  }
  return full;
}

export function sanitizeUploadName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  if (!base || base === '.' || base === '..') return 'file';
  return base.replace(/[^\w.+@ ()-]/g, '_').slice(0, 180) || 'file';
}

function json(res, status, body, extraHeaders = {}) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...corsHeaders(),
    ...extraHeaders,
  });
  res.end(payload);
}

function corsHeaders(req) {
  const origin = req?.headers?.origin;
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-headers': 'Authorization, Content-Type, X-Filename',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '600',
  };
}

function occPath(url) {
  const p = String(url || '/').split('?')[0];
  if (p === '/occ' || p.startsWith('/occ/')) return p;
  return null;
}

function queryHasSecret(url) {
  const q = String(url || '');
  return /[?&](?:token|key|auth|authorization|bearer)=/i.test(q);
}

export function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  if (!m) return null;
  const boundary = `--${(m[1] || m[2]).trim()}`;
  const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const sep = Buffer.from(`\r\n${boundary}`);
  const start = raw.indexOf(Buffer.from(boundary));
  if (start < 0) return null;
  const fields = {};
  let files = [];
  let cursor = start + boundary.length;
  if (raw[cursor] === 13 && raw[cursor + 1] === 10) cursor += 2;
  while (cursor < raw.length) {
    if (raw[cursor] === 45 && raw[cursor + 1] === 45) break;
    const headEnd = raw.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headEnd < 0) break;
    const header = raw.subarray(cursor, headEnd).toString('utf8');
    const next = raw.indexOf(sep, headEnd + 4);
    const end = next < 0 ? raw.length : next;
    let body = raw.subarray(headEnd + 4, end);
    if (body.length >= 2 && body[body.length - 2] === 13 && body[body.length - 1] === 10) {
      body = body.subarray(0, body.length - 2);
    }
    const nameM = /name="([^"]+)"/i.exec(header);
    const fileM = /filename="([^"]*)"/i.exec(header);
    const name = nameM ? nameM[1] : '';
    if (fileM) {
      files.push({ field: name || 'file', name: fileM[1] || 'file', data: body });
    } else if (name) {
      fields[name] = body.toString('utf8');
    }
    if (next < 0) break;
    cursor = next + sep.length;
    if (raw[cursor] === 13 && raw[cursor + 1] === 10) cursor += 2;
  }
  return { fields, files };
}

function readBody(req, { max = DEFAULT_UPLOAD_MAX } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (d) => {
      n += d.length;
      if (n > max) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function listFiles(root, rel = '.', out = [], cap = 400) {
  if (out.length >= cap) return out;
  const dir = safeResolveIn(root, rel);
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= cap) break;
    if (e.name === '.' || e.name === '..') continue;
    const child = rel === '.' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) listFiles(root, child, out, cap);
    else {
      let st;
      try { st = statSync(path.join(dir, e.name)); } catch { continue; }
      out.push({ name: e.name, path: child, size: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}

export function createHostedOcc(opts = {}) {
  const env = opts.env || process.env;
  const root = opts.root || occRoot(env);
  const uploadMax = Number(opts.uploadMax || env.OPENZOO_OCC_UPLOAD_MAX || DEFAULT_UPLOAD_MAX);
  const completionsUrl = opts.completionsUrl || occCompletionsUrl(env);
  const verify = opts.verify || ((key) => verifySubscriptionKey(key));
  const spawnOcc = opts.spawn || defaultSpawnOccPty;
  const now = opts.now || (() => Date.now());
  const log = opts.log || ((line) => {
    try { console.error(String(line)); } catch { /* ignore */ }
  });

  const sessions = new Map();
  const byThread = new Map();
  const secrets = new Map();
  const verifyCache = new Map();
  const listeners = new Map();

  mkdirSync(root, { recursive: true, mode: 0o700 });

  function redact(s) {
    return String(s || '').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  }

  function emit(id, ev) {
    const set = listeners.get(id);
    if (!set?.size) return;
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of set) {
      try { res.write(line); } catch { set.delete(res); }
    }
  }

  function addListener(id, res) {
    if (!listeners.has(id)) listeners.set(id, new Set());
    listeners.get(id).add(res);
  }

  function dropListener(id, res) {
    listeners.get(id)?.delete(res);
    if (!listeners.get(id)?.size) listeners.delete(id);
  }

  async function authorize(req) {
    if (queryHasSecret(req.url)) {
      return { ok: false, status: 401, error: 'unauthorized' };
    }
    const token = bearerFromAuthorization(req.headers || {});
    if (!token) return { ok: false, status: 401, error: 'unauthorized' };
    const fp = fingerprintKey(token);
    const hit = verifyCache.get(fp);
    if (hit && hit.exp > now()) return { ...hit.value, token, fingerprint: fp };
    const result = await verify(token);
    const value = result?.ok
      ? { ok: true, status: 200, tier: result.tier || null, tierName: result.tierName || null }
      : { ok: false, status: result?.status === 503 ? 503 : 401, error: result?.error || 'unauthorized' };
    verifyCache.set(fp, { exp: now() + VERIFY_TTL_MS, value });
    if (!value.ok) return value;
    return { ...value, token, fingerprint: fp };
  }

  function sessionOwned(id, fingerprint) {
    const sess = sessions.get(id);
    if (!sess || sess.fingerprint !== fingerprint) return null;
    return sess;
  }

  function attachPty(sess, handle) {
    sess.dead = false;
    sess.write = (s) => handle.write(s);
    sess.kill = () => handle.kill();
    sess.resize = (c, r) => handle.resize?.(c, r);
    handle.onData((chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      sess.buf = Buffer.concat([sess.buf || Buffer.alloc(0), buf]);
      if (sess.buf.length > PTY_BUF_CAP) {
        sess.buf = sess.buf.subarray(sess.buf.length - PTY_BUF_CAP);
      }
      const visible = stripAnsi(buf.toString('utf8'));
      if (visible) {
        emit(sess.id, { type: 'delta', text: visible, sessionId: sess.id });
      }
    });
    handle.onExit(() => {
      sess.dead = true;
      emit(sess.id, { type: 'status', status: 'exited', sessionId: sess.id });
    });
  }

  function ensurePty(sess) {
    if (sess.write && !sess.dead) return sess;
    const token = secrets.get(sess.id);
    if (!token) return null;
    const spec = occSpawnSpec({
      env,
      token,
      model: sess.model,
      base: completionsUrl,
    });
    if (!spec) return null;
    let handle;
    try {
      handle = spawnOcc(spec, { cwd: sess.cwd, cols: 80, rows: 24 });
    } catch {
      return null;
    }
    if (spec.env) {
      delete spec.env.ANTHROPIC_API_KEY;
      if (spec.env.ANTHROPIC_AUTH_TOKEN && spec.env.ANTHROPIC_AUTH_TOKEN !== token) {
        spec.env.ANTHROPIC_AUTH_TOKEN = token;
      }
    }
    sess.via = spec.via;
    sess.buf = sess.buf || Buffer.alloc(0);
    attachPty(sess, handle);
    return sess;
  }

  function publicSession(sess) {
    return {
      ok: true,
      id: sess.id,
      session_id: sess.id,
      sessionId: sess.id,
      threadId: sess.threadId || null,
      name: sess.name || null,
      goalSet: Boolean(sess.goalSet),
      live: Boolean(sess.write && !sess.dead),
    };
  }

  function createOrResume(auth, body) {
    const threadId = body?.threadId != null ? String(body.threadId).trim() : '';
    const name = body?.name != null ? String(body.name) : '';
    const wantId = String(body?.id || body?.session_id || body?.sessionId || '').trim();
    if (wantId) {
      const existing = sessionOwned(wantId, auth.fingerprint);
      if (existing) {
        secrets.set(existing.id, auth.token);
        ensurePty(existing);
        return existing;
      }
    }
    if (threadId) {
      const mapped = byThread.get(`${auth.fingerprint}:${threadId}`);
      if (mapped && sessionOwned(mapped, auth.fingerprint)) {
        const existing = sessions.get(mapped);
        secrets.set(existing.id, auth.token);
        ensurePty(existing);
        return existing;
      }
    }
    const id = crypto.randomUUID();
    const cwd = path.join(root, auth.fingerprint.slice(0, 32), id);
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const sess = {
      id,
      fingerprint: auth.fingerprint,
      threadId: threadId || null,
      name: name || null,
      cwd,
      createdAt: now(),
      goalSet: false,
      dead: true,
      buf: Buffer.alloc(0),
      didWriteLine: false,
      model: body?.model || null,
    };
    sessions.set(id, sess);
    secrets.set(id, auth.token);
    if (threadId) byThread.set(`${auth.fingerprint}:${threadId}`, id);
    writeFileSync(path.join(cwd, '.occ-meta.json'), JSON.stringify({
      id, threadId: sess.threadId, name: sess.name, createdAt: sess.createdAt,
    }), { mode: 0o600 });
    ensurePty(sess);
    return sess;
  }

  async function handle(req, res) {
    const method = req.method || 'GET';
    const rawUrl = req.url || '/';
    if (method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return true;
    }
    if ((rawUrl.split('?')[0] === '/healthz' || rawUrl.split('?')[0] === '/health') && method === 'GET') {
      json(res, 200, { ok: true, service: 'hosted-occ' }, corsHeaders(req));
      return true;
    }

    const p = occPath(rawUrl);
    if (!p) return false;

    let auth;
    try { auth = await authorize(req); } catch {
      json(res, 401, { ok: false, error: 'unauthorized' }, corsHeaders(req));
      return true;
    }
    if (!auth.ok) {
      log(`occ ${auth.status} ${method} ${p.split('?')[0]}`);
      json(res, auth.status, { ok: false, error: auth.error || 'unauthorized' }, corsHeaders(req));
      return true;
    }

    if (method === 'GET' && (p === '/occ' || p === '/occ/auth')) {
      json(res, 200, {
        ok: true,
        service: 'hosted-occ',
        origin: OCC_PUBLIC_ORIGIN,
        ...subscriptionPublicView({ key: 'x', tier: auth.tier, tierName: auth.tierName }),
      }, corsHeaders(req));
      return true;
    }

    if (method === 'POST' && p === '/occ/sessions') {
      let body = {};
      try { body = JSON.parse((await readBody(req, { max: 64 * 1024 })).toString('utf8') || '{}'); } catch { body = {}; }
      const sess = createOrResume(auth, body && typeof body === 'object' ? body : {});
      json(res, 200, publicSession(sess), corsHeaders(req));
      return true;
    }

    const msg = /^\/occ\/sessions\/([^/]+)\/messages$/.exec(p);
    if (method === 'POST' && msg) {
      const sess = sessionOwned(decodeURIComponent(msg[1]), auth.fingerprint);
      if (!sess) {
        json(res, 404, { ok: false, error: 'session not found' }, corsHeaders(req));
        return true;
      }
      secrets.set(sess.id, auth.token);
      let body = {};
      const raw = await readBody(req, { max: 1024 * 1024 });
      const ctype = String(req.headers['content-type'] || '');
      if (ctype.includes('application/json') || raw[0] === 0x7b) {
        try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { body = {}; }
      } else {
        body = { text: raw.toString('utf8') };
      }
      const text = stripPtyLineTail(body.text ?? body.message ?? body.task ?? '');
      const stream = body.stream !== false;
      const live = ensurePty(sess);
      if (stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          ...corsHeaders(req),
        });
        res.write(': open\n\n');
        res.write(`data: ${JSON.stringify({ type: 'status', status: live ? 'running' : 'starting', sessionId: sess.id })}\n\n`);
        addListener(sess.id, res);
        const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* gone */ } }, 20000);
        req.on('close', () => {
          clearInterval(ka);
          dropListener(sess.id, res);
        });
        if (!live) {
          res.write(`data: ${JSON.stringify({ type: 'error', error: 'OCC runtime unavailable', sessionId: sess.id })}\n\n`);
          res.write('data: {"type":"done"}\n\n');
          clearInterval(ka);
          dropListener(sess.id, res);
          res.end();
          return true;
        }
        const startLen = sess.buf?.length || 0;
        void writeOccPtyLine(sess, text).then(async () => {
          const t0 = now();
          while (now() - t0 < 120000) {
            if (sess.dead) break;
            if ((sess.buf?.length || 0) > startLen && ptyLooksReady(sess) && sess.didWriteLine) break;
            await sleepMs(40);
          }
          try {
            res.write(`data: ${JSON.stringify({ type: 'done', sessionId: sess.id })}\n\n`);
            res.write('data: [DONE]\n\n');
          } catch { /* closed */ }
          clearInterval(ka);
          dropListener(sess.id, res);
          try { res.end(); } catch { /* gone */ }
        }).catch((e) => {
          try {
            res.write(`data: ${JSON.stringify({ type: 'error', error: redact(e.message || 'write failed'), sessionId: sess.id })}\n\n`);
            res.write('data: {"type":"done"}\n\n');
            res.end();
          } catch { /* gone */ }
          clearInterval(ka);
          dropListener(sess.id, res);
        });
        return true;
      }
      if (!live) {
        json(res, 503, { ok: false, error: 'OCC runtime unavailable', id: sess.id }, corsHeaders(req));
        return true;
      }
      await writeOccPtyLine(sess, text);
      json(res, 200, { ok: true, id: sess.id, session_id: sess.id }, corsHeaders(req));
      return true;
    }

    const filesPost = /^\/occ\/sessions\/([^/]+)\/files$/.exec(p);
    if (method === 'POST' && filesPost) {
      const sess = sessionOwned(decodeURIComponent(filesPost[1]), auth.fingerprint);
      if (!sess) {
        json(res, 404, { ok: false, error: 'session not found' }, corsHeaders(req));
        return true;
      }
      const cl = Number(req.headers['content-length'] || 0);
      if (cl > uploadMax) {
        json(res, 413, { ok: false, error: 'upload too large' }, corsHeaders(req));
        return true;
      }
      const raw = await readBody(req, { max: uploadMax });
      const ctype = String(req.headers['content-type'] || '');
      let name = String(req.headers['x-filename'] || req.headers['x-openzoo-filename'] || '');
      let data = raw;
      if (ctype.includes('multipart/form-data')) {
        const parts = parseMultipart(raw, ctype);
        const file = parts?.files?.[0];
        if (file) {
          name = name || file.name || parts.fields?.name || 'file';
          data = file.data;
        } else if (parts?.fields?.content) {
          name = name || parts.fields.name || 'file';
          data = Buffer.from(parts.fields.content, parts.fields.encoding === 'base64' ? 'base64' : 'utf8');
        } else {
          json(res, 400, { ok: false, error: 'file required' }, corsHeaders(req));
          return true;
        }
      } else if (ctype.includes('application/json') || raw[0] === 0x7b) {
        let body = {};
        try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch {
          json(res, 400, { ok: false, error: 'invalid json' }, corsHeaders(req));
          return true;
        }
        name = name || body.name || body.path || 'file';
        const enc = String(body.encoding || 'utf8').toLowerCase();
        data = Buffer.from(String(body.content || ''), enc === 'base64' ? 'base64' : 'utf8');
      }
      if (data.length > uploadMax) {
        json(res, 413, { ok: false, error: 'upload too large' }, corsHeaders(req));
        return true;
      }
      const safeName = sanitizeUploadName(name);
      let dest;
      try { dest = safeResolveIn(sess.cwd, safeName); } catch {
        json(res, 400, { ok: false, error: 'path escapes this session workspace' }, corsHeaders(req));
        return true;
      }
      mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      writeFileSync(dest, data);
      json(res, 200, {
        ok: true,
        name: safeName,
        path: safeName,
        bytes: data.length,
        sessionId: sess.id,
        id: sess.id,
      }, corsHeaders(req));
      return true;
    }

    const filesGet = /^\/occ\/sessions\/([^/]+)\/files$/.exec(p);
    if (method === 'GET' && filesGet) {
      const sess = sessionOwned(decodeURIComponent(filesGet[1]), auth.fingerprint);
      if (!sess) {
        json(res, 404, { ok: false, error: 'session not found' }, corsHeaders(req));
        return true;
      }
      const files = listFiles(sess.cwd).filter((f) => f.name !== '.occ-meta.json');
      json(res, 200, { ok: true, id: sess.id, files }, corsHeaders(req));
      return true;
    }

    const stop = /^\/occ\/sessions\/([^/]+)\/stop$/.exec(p);
    if (method === 'POST' && stop) {
      const sess = sessionOwned(decodeURIComponent(stop[1]), auth.fingerprint);
      if (!sess) {
        json(res, 404, { ok: false, error: 'session not found' }, corsHeaders(req));
        return true;
      }
      await readBody(req, { max: 16 * 1024 }).catch(() => Buffer.alloc(0));
      if (sess.write && !sess.dead) {
        try { sess.write(ESC); } catch { /* closed */ }
      }
      emit(sess.id, { type: 'status', status: 'interrupted', sessionId: sess.id });
      json(res, 200, { ok: true, id: sess.id, session_id: sess.id }, corsHeaders(req));
      return true;
    }

    const one = /^\/occ\/sessions\/([^/]+)$/.exec(p);
    if (method === 'GET' && one) {
      const sess = sessionOwned(decodeURIComponent(one[1]), auth.fingerprint);
      if (!sess) {
        json(res, 404, { ok: false, error: 'session not found' }, corsHeaders(req));
        return true;
      }
      json(res, 200, publicSession(sess), corsHeaders(req));
      return true;
    }

    json(res, 404, { ok: false, error: 'not found' }, corsHeaders(req));
    return true;
  }

  function close() {
    for (const sess of sessions.values()) {
      try { sess.kill?.(); } catch { /* gone */ }
    }
    sessions.clear();
    secrets.clear();
  }

  return {
    handle,
    close,
    sessions,
    root,
    uploadMax,
    completionsUrl,
    writeOccPtyLine,
  };
}

export function startHostedOcc(opts = {}) {
  const api = createHostedOcc(opts);
  const env = opts.env || process.env;
  const port = Number(opts.port ?? env.OPENZOO_OCC_PORT ?? env.PORT ?? DEFAULT_OCC_PORT);
  const bind = opts.bind || env.OPENZOO_OCC_BIND || env.OPENZOO_BIND || '127.0.0.1';
  const server = http.createServer(async (req, res) => {
    try {
      const hit = await api.handle(req, res);
      if (!hit && !res.writableEnded) {
        json(res, 404, { ok: false, error: 'not found' }, corsHeaders(req));
      }
    } catch (err) {
      if (!res.writableEnded) {
        const status = err.status || 500;
        json(res, status, { ok: false, error: status === 413 ? 'upload too large' : 'hosted occ error' }, corsHeaders(req));
      }
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, bind, () => {
      const addr = server.address();
      resolve({
        ...api,
        server,
        port: addr.port,
        bind,
        url: `http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${addr.port}`,
      });
    });
  });
}

