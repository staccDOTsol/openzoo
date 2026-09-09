/** Read-only savings overlay for the OpenZoo ChatGPT profile. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cdpSession, listCdpPages } from './ozSpendChip.js';

export function chatGptSpendState(info) {
  if (info?.youAreTalkingTo !== 'openzoo proxy') throw new Error('not an OpenZoo proxy');
  const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const spent = amount(info.spendUsd), would = amount(info.directUsd);
  const comparable = spent !== null && would !== null && (would > 0 || spent === 0);
  // Do not use savedUsd: older proxies clamp negative savings to zero.
  const saved = comparable ? would - spent : null;
  return { spent, would: comparable ? would : null, saved,
    pct: comparable && would > 0 ? 100 * saved / would : null,
    scope: 'All-time · shared OpenZoo proxy', updatedAt: Date.now(), online: true };
}

/** Self-contained renderer. Only owns its shadow-root overlay, never chat content. */
export function renderChatGptSpend(state) {
  let host = document.getElementById('openzoo-chatgpt-spend');
  if (!document.body) return false;
  if (!host) {
    host = document.createElement('div');
    host.id = 'openzoo-chatgpt-spend';
    host.style.cssText = 'position:fixed;right:20px;bottom:90px;z-index:2147483646;max-width:calc(100vw - 24px);-webkit-app-region:no-drag';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host{font:12px/1.5 system-ui,sans-serif;color:#fafafa;color-scheme:dark}
      details{max-width:min(470px,calc(100vw - 24px))}
      summary{list-style:none;cursor:grab;touch-action:none;border-radius:999px;background:#e85d1c;color:white;padding:8px 14px;box-shadow:0 4px 18px #0006;font-weight:650;overflow-wrap:anywhere}
      summary::-webkit-details-marker{display:none}summary:focus-visible{outline:2px solid white;outline-offset:3px}
      section{margin-top:8px;padding:12px 14px;border:1px solid #ffffff24;border-radius:14px;background:#18181bef;box-shadow:0 4px 18px #0005}
      dl{display:grid;grid-template-columns:1fr auto;gap:5px 24px;margin:10px 0}dd{margin:0;font-variant-numeric:tabular-nums}
      small{display:block;color:#bfbfc7}p{margin:8px 0 0;color:#bfbfc7}button{margin-top:10px;border:1px solid #ffffff30;border-radius:8px;background:transparent;color:inherit;padding:4px 10px;cursor:pointer}
    </style><details><summary role="button" aria-expanded="false" aria-label="OpenZoo costs and savings"></summary><section>
      <small data-scope></small><dl><dt>Spent</dt><dd data-spent></dd><dt>Would’ve cost · estimate</dt><dd data-would></dd><dt data-saving-label>Saved</dt><dd data-saved></dd></dl>
      <small data-status role="status"></small><p>Direct cost is the proxy’s counterfactual estimate. Totals include other apps using this proxy. Ordinary ChatGPT chats are not included.</p>
      <button type="button">Reset position</button></section></details>`;
    const summary = root.querySelector('summary');
    let drag = null, moved = false;
    const place = (left, top) => {
      const r = host.getBoundingClientRect();
      host.style.left = Math.max(8, Math.min(left, innerWidth - r.width - 8)) + 'px';
      host.style.top = Math.max(8, Math.min(top, innerHeight - r.height - 8)) + 'px';
      host.style.right = host.style.bottom = 'auto';
    };
    document.body.appendChild(host);
    try { const p = JSON.parse(localStorage.getItem('openzoo-chatgpt-spend-position')); if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) place(p.x, p.y); } catch { /* storage unavailable */ }
    summary.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const r = host.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top }; moved = false;
      summary.setPointerCapture(e.pointerId);
    });
    summary.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (moved) place(drag.left + dx, drag.top + dy);
    });
    summary.addEventListener('pointerup', () => {
      if (drag && moved) { const r = host.getBoundingClientRect(); try { localStorage.setItem('openzoo-chatgpt-spend-position', JSON.stringify({ x: r.left, y: r.top })); } catch {} }
      drag = null;
    });
    summary.addEventListener('pointercancel', () => { drag = null; });
    summary.addEventListener('click', e => { if (moved) { e.preventDefault(); moved = false; } });
    root.querySelector('button').addEventListener('click', () => {
      try { localStorage.removeItem('openzoo-chatgpt-spend-position'); } catch {}
      host.style.left = host.style.top = 'auto'; host.style.right = '20px'; host.style.bottom = '90px';
    });
    root.querySelector('details').addEventListener('toggle', () => { summary.setAttribute('aria-expanded', String(root.querySelector('details').open)); if (host.style.left !== 'auto' && host.style.left) { const r = host.getBoundingClientRect(); place(r.left, r.top); } });
    addEventListener('resize', () => { if (host.isConnected && host.style.left !== 'auto' && host.style.left) { const r = host.getBoundingClientRect(); place(r.left, r.top); } });
    // A dead bridge must not leave apparently live numbers indefinitely.
    const timer = setInterval(() => {
      if (!host.isConnected) { clearInterval(timer); return; }
      if (Date.now() - (host.__ozUpdate || 0) > 12000) {
        root.querySelector('[data-status]').textContent = 'Disconnected · last known totals';
        root.querySelector('summary').textContent = 'OpenZoo · disconnected';
      }
    }, 3000);
  }
  const root = host.shadowRoot;
  if (!root) return false;
  const usd = n => n === null || !Number.isFinite(n) ? '—' : '$' + Math.abs(n).toFixed(Math.abs(n) < 0.01 ? 4 : 2);
  const more = state.saved !== null && state.saved < 0;
  const savings = state.saved === null ? 'Savings —' : `${more ? 'Extra cost' : 'Saved'} ${usd(state.saved)}`;
  root.querySelector('summary').textContent = state.online ? `OpenZoo · ${usd(state.spent)} spent · ${savings}` : 'OpenZoo · disconnected';
  root.querySelector('[data-spent]').textContent = usd(state.spent);
  root.querySelector('[data-would]').textContent = usd(state.would);
  root.querySelector('[data-saving-label]').textContent = more ? 'Extra cost' : 'Saved';
  root.querySelector('[data-saved]').textContent = usd(state.saved) + (state.pct === null ? '' : ` (${Math.abs(state.pct).toFixed(1)}%)`);
  root.querySelector('[data-scope]').textContent = state.scope;
  root.querySelector('[data-status]').textContent = state.online ? 'Updated ' + new Date(state.updatedAt).toLocaleTimeString() : 'Proxy unavailable · last known totals';
  host.__ozUpdate = Date.now();
  return true;
}

export function chatGptSpendSource(state) {
  return `(${renderChatGptSpend.toString()})(${JSON.stringify(state).replace(/</g, '\\u003c')})`;
}

export function readChatGptDebugPort(profile) {
  try {
    const n = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
  } catch { return null; }
}

export function isChatGptRenderer(target, port) {
  try {
    const ws = new URL(target.webSocketDebuggerUrl);
    if (ws.protocol !== 'ws:' || ws.hostname !== '127.0.0.1' && ws.hostname !== 'localhost' || Number(ws.port) !== port) return false;
    const url = new URL(target.url);
    return target.type === 'page' && (url.protocol === 'file:' && /\/index\.html$/.test(url.pathname) || url.protocol === 'app:' && /codex|chatgpt/.test(url.hostname));
  } catch { return false; }
}

/** Host-side polling avoids changing the signed app or relaxing renderer CSP. */
export async function watchChatGptSpend({ profile, proxyPort, fetchImpl = fetch, connect = cdpSession,
  sleep = ms => new Promise(r => setTimeout(r, ms)), stopped = () => false, log = console.error } = {}) {
  const sessions = new Map();
  let misses = 0;
  let state = { spent: null, would: null, saved: null, pct: null, scope: 'All-time · shared OpenZoo proxy', online: false, updatedAt: 0 };
  try {
    while (!stopped() && misses < 20) {
      const port = readChatGptDebugPort(profile);
      const pages = port ? (await listCdpPages(port, fetchImpl)).filter(t => isChatGptRenderer(t, port)) : [];
      misses = pages.length ? 0 : misses + 1;
      const live = new Set(pages.map(t => t.webSocketDebuggerUrl));
      for (const [id, session] of sessions) if (!live.has(id)) { session.close(); sessions.delete(id); }
      try {
        const r = await fetchImpl(`http://127.0.0.1:${proxyPort}/v1/info`, { signal: AbortSignal.timeout(2000) });
        if (!r.ok) throw new Error(`proxy HTTP ${r.status}`);
        state = chatGptSpendState(await r.json());
      } catch { state = { ...state, online: false }; }
      for (const page of pages) {
        const id = page.webSocketDebuggerUrl;
        try {
          if (!sessions.has(id)) sessions.set(id, await connect(id, { timeoutMs: 2500, sendOrigin: false }));
          const result = await sessions.get(id).send('Runtime.evaluate', { expression: chatGptSpendSource(state), returnByValue: true });
          if (result.exceptionDetails) throw new Error('savings pill renderer evaluation failed');
        } catch (e) { sessions.get(id)?.close(); sessions.delete(id); log(`openzoo: savings pill: ${e.message}`); }
      }
      await sleep(3000);
    }
    if (misses >= 20) log('openzoo: savings pill stopped: no ChatGPT renderer found for 60s');
  } finally { for (const session of sessions.values()) session.close(); }
}

/** A current launcher supplies a native pill even when the chat app disables debugging. */
export function nativeSavingsLauncher({ platform = process.platform, home = os.homedir(), env = process.env, exists = fs.existsSync } = {}) {
  const roots = platform === 'darwin'
    ? ['/Applications/OpenZoo Launcher.app/Contents', path.join(home, 'Applications/OpenZoo Launcher.app/Contents')]
    : platform === 'win32' ? [path.join(env.LOCALAPPDATA || home, 'Programs/openzoo-launcher'), path.join(env.LOCALAPPDATA || home, 'Programs/OpenZoo Launcher')] : [];
  for (const root of roots) {
    const resources = path.join(root, platform === 'darwin' ? 'Resources' : 'resources');
    const executable = platform === 'darwin' ? path.join(root, 'MacOS/OpenZoo Launcher') : path.join(root, 'OpenZoo Launcher.exe');
    if (exists(path.join(resources, 'openzoo-overlay.json')) && exists(executable)) return executable;
  }
  return null;
}

export async function startChatGptSpend({ profile, proxyPort, spawnImpl = spawn } = {}) {
  const native = nativeSavingsLauncher();
  if (native && proxyPort === 8402) {
    const child = spawnImpl(native, ['--savings-only'], { detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return;
  }
  fs.mkdirSync(profile, { recursive: true });
  const fd = fs.openSync(path.join(profile, 'openzoo-savings.log'), 'a', 0o600);
  try {
    const child = spawnImpl(process.execPath, [fileURLToPath(import.meta.url), '--watch', profile, String(proxyPort)], { detached: true, stdio: ['ignore', fd, fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { fs.closeSync(fd); }
}

/** One watcher per profile, including concurrent launcher invocations. */
export function claimSpendWatcher(profile) {
  const lock = path.join(profile, 'openzoo-savings.lock');
  try {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return null; } catch (e) { if (e.code !== 'ESRCH') return null; }
    } else if (Date.now() - fs.statSync(lock).mtimeMs < 60000) return null;
    fs.unlinkSync(lock);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') return null; throw e; }
  fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
  return () => { try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); } catch {} };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--watch') {
  const release = claimSpendWatcher(process.argv[3]);
  if (release) {
    process.once('exit', release);
    watchChatGptSpend({ profile: process.argv[3], proxyPort: Number(process.argv[4]) })
      .catch(e => { console.error(e.message); process.exitCode = 1; }).finally(release);
  }
}
