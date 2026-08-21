const { app, BrowserWindow, dialog, ipcMain, shell, clipboard, Menu } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { sidecarIsAttachable } = require('./sidecar-version');
const { createSidecarHealer, copyPackedRuntimeToHome } = require('./sidecar-heal');

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

ipcMain.handle('read-text', () => clipboard.readText());

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
        { type: 'separator' },
        {
          label: 'Find',
          accelerator: 'CmdOrCtrl+F',
          click: (_item, focusedWindow) => {
            const win = focusedWindow || BrowserWindow.getFocusedWindow();
            if (win && !win.isDestroyed()) win.webContents.send('find-in-thread');
          },
        },
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
const LIVE_URL = `http://localhost:${PORT}`;
let serverProc;
let serverLog = '';
let serverExit = null;
let quitting = false;
let healer;

function startServer() {
  // ELECTRON_RUN_AS_NODE makes the packaged Electron binary behave as plain
  // Node when spawned as a subprocess — without it, a packaged .app would try
  // to launch a second Electron GUI instance instead of running the script.
  // Pipe stdout/stderr so a MODULE_NOT_FOUND (or any listen failure) can be
  // shown in the window instead of leaving "starting…" up forever.
  if (serverProc) return;
  serverLog = '';
  serverExit = null;
  serverProc = spawn(process.execPath, [grokuiScript()], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      OZ_PACKED_RESOURCES: process.resourcesPath || path.join(__dirname),
    },
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
    serverProc = null;
    if (quitting) return;
    // Window destroy / renderer abort must not leave :4173 dead. Respawn
    // and put every open window back on the live UI once /threads answers.
    setTimeout(() => {
      if (quitting || serverProc) return;
      startServer();
      void reloadOpenWindows();
    }, 250);
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
      // Empty-wallet 402 still means the sidecar is up. Do not treat it as
      // dead and spawn over a live proxy that is asking to Pay.
      if (res.statusCode === 402) {
        res.resume();
        resolve({ paymentRequired: true });
        return;
      }
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

// The chat backend needs openzoo's local proxy on :8402. Prefer a real host
// Node (nvm / homebrew / ~/.local/bin) running the packed bin so the sidecar
// is not the .app binary and survives window close / Cmd+Q. Electron-as-node
// is fallback when no host Node exists, then `openzoo` on PATH. Never npx.
// Do not reload or pkill the grokui window to heal — only this sidecar.
// Window paints even if :8402 is coming up.
function getHealer() {
  if (!healer) {
    healer = createSidecarHealer({
      spawn,
      execPath: process.execPath,
      binPath: path.join(__dirname, 'node_modules', 'openzoo', 'bin', 'openzoo.js'),
      fetchSession: () => fetchSessionJson('http://127.0.0.1:8402/v1/session'),
      portOccupied: () => portOccupied(8402),
      displaceStale: () => displaceStaleListener(8402),
      sidecarIsAttachable,
      expectedVersion: expectedOpenzooVersion,
      waitForSession: (died) => waitFor('http://127.0.0.1:8402/v1/session', 60, 500, died),
      env: {
        ...process.env,
        OZ_PACKED_RESOURCES: process.resourcesPath || path.join(__dirname),
      },
    });
  }
  return healer;
}

async function ensureProxy() {
  if (quitting) return;
  await getHealer().ensure();
}

ipcMain.handle('heal-sidecar', async () => {
  void ensureProxy();
  return true;
});

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
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
    },
  });
  // links in chat bubbles (target="_blank") open in the real browser, not a
  // second app window — Electron blocks window.open by default without this
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  attachRendererGuards(win);
  win.loadURL(startingPage());
  void loadAppWhenReady(win);
}

function attachRendererGuards(win) {
  let reloading = false;
  const reloadLive = () => {
    if (win.isDestroyed() || quitting || reloading) return;
    reloading = true;
    if (!serverProc) startServer();
    win.loadURL(startingPage());
    void loadAppWhenReady(win).finally(() => { reloading = false; });
  };
  // Measured: Helper (Renderer) EXC_BREAKPOINT / SIGTRAP in V8 GC. The
  // BrowserWindow stays up with backgroundColor #000 and no UI. Reload the
  // live grokui URL — do not sit on a black frame.
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[openzoo] renderer gone', details && details.reason, details && details.exitCode);
    reloadLive();
  });
  win.webContents.on('unresponsive', () => {
    console.error('[openzoo] renderer unresponsive');
    reloadLive();
  });
}

async function loadLiveOrFailed(win) {
  const ok = await waitFor(`${LIVE_URL}/threads`, 80, 250, () => Boolean(serverExit));
  if (win.isDestroyed()) return;
  if (ok) win.loadURL(LIVE_URL);
  else win.loadURL(failedPage(serverFailDetail()));
}

async function reloadOpenWindows() {
  const ok = await waitFor(`${LIVE_URL}/threads`, 80, 250, () => Boolean(serverExit));
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    if (ok) win.loadURL(LIVE_URL);
    else win.loadURL(failedPage(serverFailDetail()));
  }
}

async function loadAppWhenReady(win) {
  // First chrome is grokui itself (/threads). Do not block on the sidecar
  // session or a paid handshake — a bad x402 used to leave the window on
  // starting… forever. ensureProxy still runs (reuse a healthy sidecar,
  // spawn if none) but must not gate loadURL. Chat pays later, after paint.
  void ensureProxy();
  await loadLiveOrFailed(win);
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
  // First-boot copy of packed node-pty + openzoo-claude before Auto.
  // extraResources live at resources/node-pty on NSIS; copy into
  // ~/.openzoo/packed so loadNodePty finds them without a host Node.
  try {
    copyPackedRuntimeToHome({
      resourcesPath: process.resourcesPath,
      appDir: __dirname,
    });
  } catch (e) {
    console.error('[openzoo] packed runtime copy:', e && e.message);
  }
  // Kick :8402 immediately so it is already spawning before the window
  // paints. Do not await — sitting on black "starting…" looks hung.
  void ensureProxy();
  startServer();
  createWindow();
  checkForUpdates();
  app.on('activate', () => {
    if (quitting) return;
    // Always heal, even when a window already exists — :8402 may have
    // died or wedged while the GUI stayed up.
    void ensureProxy();
    if (!serverProc) startServer();
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // macOS: do not kill grokui or the sidecar. A renderer/GPU abort can
  // destroy the BrowserWindow; killing :4173/:8402 here left a black
  // leftover frame that could not reload. Dock re-activate createWindow().
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  // stop() drops health timers only — it must not SIGTERM a healthy
  // detached :8402. Leave the sidecar listening after Cmd+Q.
  if (healer) healer.stop();
  if (serverProc) { serverProc.kill(); serverProc = null; }
});
