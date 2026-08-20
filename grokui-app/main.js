const { app, BrowserWindow, dialog, ipcMain, shell, clipboard, Menu } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { sidecarIsAttachable } = require('./sidecar-version');

// One source of truth: the live UI is repo lib/grokui.mjs. A packaged build
// copies that file next to this script; a checkout prefers the repo copy so
// grokui-app/lib can never drift again.
function grokuiScript() {
  const repo = path.join(__dirname, '..', 'lib', 'grokui.mjs');
  const bundled = path.join(__dirname, 'lib', 'grokui.mjs');
  return fs.existsSync(repo) ? repo : bundled;
}

ipcMain.handle('pick-directory', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// Click-to-copy and the Edit menu both need the OS clipboard. navigator.clipboard
// is undefined or permission-denied in enough Electron/http cases that the
// wallet addresses silently failed to copy.
ipcMain.handle('copy-text', (_event, text) => {
  clipboard.writeText(String(text ?? ''));
  return true;
});

// On Windows/Linux, Ctrl+C/V/X/A do nothing in inputs unless Menu items with
// these roles exist. macOS needs the same roles for Cmd+C in a packaged .app.
function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const PORT = process.env.OZ_GROKUI_PORT || 4173;
let serverProc, proxyProc;
let serverLog = '';
let serverExit = null;

function startServer() {
  // ELECTRON_RUN_AS_NODE makes the packaged Electron binary behave as plain
  // Node when spawned as a subprocess — without it, a packaged .app would try
  // to launch a second Electron GUI instance instead of running the script.
  // Pipe stdout/stderr so a MODULE_NOT_FOUND (or any listen failure) can be
  // shown in the window instead of leaving "starting…" up forever.
  serverLog = '';
  serverExit = null;
  serverProc = spawn(process.execPath, [grokuiScript()], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
  });
  const take = (buf) => {
    const s = String(buf);
    serverLog += s;
    if (serverLog.length > 8000) serverLog = serverLog.slice(-8000);
    try { process.stderr.write(s); } catch { /* ignore */ }
  };
  if (serverProc.stdout) serverProc.stdout.on('data', take);
  if (serverProc.stderr) serverProc.stderr.on('data', take);
  serverProc.on('error', (e) => {
    serverLog += (e && e.stack) ? e.stack : String(e);
    serverExit = { error: e };
  });
  serverProc.on('exit', (code, signal) => {
    serverExit = { code, signal };
  });
}

function pingUrl(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(Boolean(res.statusCode && res.statusCode < 500));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// Fetch GET /v1/session JSON. Occupied ≠ healthy: timeout / 5xx / error is
// null (wedged). A <500 body with no parseable version is still "healthy"
// but older than expected (0.49.3 answers this ping with no version field).
function fetchSessionJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 1500 }, (res) => {
      if (!res.statusCode || res.statusCode >= 500) {
        res.resume();
        resolve(null);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve({}); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// The openzoo version this grokui-app shipped with — checkout package.json
// when name === 'openzoo', else the packaged node_modules copy. Not the npm range.
function expectedOpenzooVersion() {
  const candidates = [
    path.join(__dirname, '..', 'package.json'),
    path.join(__dirname, 'node_modules', 'openzoo', 'package.json'),
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (pkg.name === 'openzoo' && pkg.version) return String(pkg.version);
    } catch { /* try next */ }
  }
  return null;
}

function listenPidsOn(port) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 3000 });
      const pids = new Set();
      const re = new RegExp(`:${port}(?:\\s|$)`);
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTEN/i.test(line) || !re.test(line)) continue;
        const pid = Number(line.trim().split(/\s+/).pop());
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
      }
      return [...pids];
    }
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    return [...new Set(out.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid))];
  } catch {
    return [];
  }
}

async function displaceStaleListener(port) {
  const pids = listenPidsOn(port);
  if (!pids.length) return false;
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  for (let i = 0; i < 50; i++) {
    if (!(await portOccupied(port))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !(await portOccupied(port));
}

function portOccupied(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
}

function waitFor(url, retries, intervalMs, died) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const attempt = (n) => {
      if (done) return;
      if (died && died()) { finish(false); return; }
      pingUrl(url).then((ok) => {
        if (ok) finish(true);
        else if (n <= 0) finish(false);
        else setTimeout(() => attempt(n - 1), intervalMs);
      });
    };
    attempt(retries);
  });
}

// The chat backend needs openzoo's local proxy on :8402. Spawn the BUNDLED
// bin with Electron's own node — never npx, never a login-shell PATH hunt.
async function ensureProxy() {
  // Reuse only a healthy :8402. Starting a second bundled proxy resets
  // session counters and can race the one that already paid — but a process
  // that LISTENs and does not answer GET /v1/session is wedged. Treating
  // "port occupied" as reuse is worse than a crash (completions then throw
  // undici `fetch failed` forever). Ping must time out; occupied ≠ healthy.
  // Occupied+healthy is not enough: compare the listener's openzoo version
  // to grokui-app's expected/shipped version. A leftover npx cache of 0.49.3
  // answers GET /v1/session just fine. Do not blindly return on a session ping.
  const session = await fetchSessionJson('http://127.0.0.1:8402/v1/session');
  if (session) {
    const expectedVersion = expectedOpenzooVersion();
    const listenerVersion = session.version;
    if (sidecarIsAttachable({ listenerVersion, expectedVersion })) return;
    console.error(
      `[openzoo] :8402 is a stale sidecar (openzoo ${listenerVersion || 'unknown'} < ${expectedVersion}) — not attaching; grokui will spawn the matching one`,
    );
    const displaced = await displaceStaleListener(8402);
    if (!displaced) {
      console.error('[openzoo] failed to displace stale :8402 — refusing to attach');
      return;
    }
  } else if (await portOccupied(8402)) {
    console.error('[openzoo] :8402 is listening but /v1/session did not answer — not reusing a wedged proxy');
    return;
  }
  // Run the BUNDLED openzoo (whatever `latest` resolved to at pack time) with
  // Electron's OWN node. Never npx: a Finder/Dock launch has no ~/.zshrc PATH,
  // and a clean Windows box has no Node, so npx never starts the proxy.
  const bin = path.join(__dirname, 'node_modules', 'openzoo', 'bin', 'openzoo.js');
  proxyProc = spawn(process.execPath, [bin], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
  });
  proxyProc.on('error', (e) => console.error('[openzoo] proxy failed to start:', e.message));
  await waitFor('http://127.0.0.1:8402/v1/session', 60, 500);
}

// Black "starting…" so the window paints on ready. Do not await the sidecar
// first — a clean Mac used to sit on a black screen for the whole
// ensureProxy / /threads wait (up to ~30s) and look hung.
function startingPage() {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><html><head><meta charset="utf-8"><title>openzoo</title>' +
    '<style>html,body{margin:0;height:100%;background:#000;color:#8a8a8a;' +
    'font:15px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;' +
    'display:flex;align-items:center;justify-content:center}</style></head>' +
    '<body>starting…</body></html>'
  );
}

function failedPage(detail) {
  const msg = String(detail || 'grokui failed to start').slice(0, 4000);
  const escaped = msg.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><html><head><meta charset="utf-8"><title>openzoo</title>' +
    '<style>html,body{margin:0;min-height:100%;background:#000;color:#c8c8c8;' +
    'font:14px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;' +
    'padding:48px 28px}pre{white-space:pre-wrap;word-break:break-word;color:#f0c0c0}</style></head>' +
    '<body><div>openzoo could not start the UI on :' + PORT + '</div>' +
    '<pre>' + escaped + '</pre></body></html>'
  );
}

function serverFailDetail() {
  const parts = [];
  if (serverExit && serverExit.error) parts.push(String(serverExit.error.stack || serverExit.error));
  else if (serverExit) {
    parts.push(serverExit.code == null
      ? `grokui.mjs exited ${serverExit.signal}`
      : `grokui.mjs exited with code ${serverExit.code}`);
  } else {
    parts.push(`grokui never answered http://localhost:${PORT}/threads`);
  }
  if (serverLog.trim()) parts.push(serverLog.trim());
  return parts.join('\n\n');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#000000',
    titleBarStyle: 'hiddenInset',
    title: 'openzoo',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  // links in chat bubbles (target="_blank") open in the real browser, not a
  // second app window — Electron blocks window.open by default without this
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(startingPage());
  void loadAppWhenReady(win);
}

async function loadAppWhenReady(win) {
  // First chrome is grokui itself (/threads). Do not block on the sidecar
  // session or a paid handshake — a bad x402 used to leave the window on
  // starting… forever. ensureProxy still runs (reuse a healthy sidecar,
  // spawn if none) but must not gate loadURL. Chat pays later, after paint.
  void ensureProxy();
  const ok = await waitFor(`http://localhost:${PORT}/threads`, 80, 250, () => Boolean(serverExit));
  if (win.isDestroyed()) return;
  if (ok) win.loadURL(`http://localhost:${PORT}`);
  else win.loadURL(failedPage(serverFailDetail()));
}

// Unsigned builds can't use Electron's full auto-updater (it requires signed
// artifacts to verify updates on macOS) — this is the honest version: check
// GitHub's latest release, ask if there's a newer one, open the releases
// page on "yes". Never blocks startup; silently gives up if offline/rate-limited.
async function checkForUpdates() {
  try {
    const res = await fetch('https://api.github.com/repos/staccDOTsol/openzoo/releases/latest');
    if (!res.ok) return;
    const j = await res.json();
    const latest = (j.tag_name || '').replace(/^grokui-v/, '');
    const current = app.getVersion();
    if (!latest || latest === current) return;
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Get it', 'Later'],
      defaultId: 0,
      title: 'Update available',
      message: `openzoo ${latest} is available — you're on ${current}.`,
      detail: j.name || '',
    });
    if (response === 0) shell.openExternal(j.html_url || 'https://github.com/staccDOTsol/openzoo/releases/latest');
  } catch { /* offline, rate-limited, or GitHub unreachable — not worth blocking on */ }
}

app.whenReady().then(() => {
  buildAppMenu();
  startServer();
  createWindow();
  checkForUpdates();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (serverProc) serverProc.kill();
  if (proxyProc) proxyProc.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProc) serverProc.kill();
  if (proxyProc) proxyProc.kill();
});
