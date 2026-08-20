const { app, BrowserWindow, dialog, ipcMain, shell, clipboard, Menu } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

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

function startServer() {
  // ELECTRON_RUN_AS_NODE makes the packaged Electron binary behave as plain
  // Node when spawned as a subprocess — without it, a packaged .app would try
  // to launch a second Electron GUI instance instead of running the script.
  serverProc = spawn(process.execPath, [grokuiScript()], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
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

function portOccupied(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
}

function waitFor(url, retries, intervalMs) {
  return new Promise((resolve) => {
    const attempt = (n) => {
      pingUrl(url).then((ok) => {
        if (ok) resolve(true);
        else if (n <= 0) resolve(false);
        else setTimeout(() => attempt(n - 1), intervalMs);
      });
    };
    attempt(retries);
  });
}

// The chat backend needs openzoo's local proxy on :8402 — launch it too, so
// the app is self-contained. A GUI app launched from Finder/Dock does not
// inherit ~/.zshrc PATH, and a clean machine may have no Node at all, so
// we never shell out to a package runner. The bundled openzoo binary runs
// under Electron's own node.
async function ensureProxy(onStatus) {
  // Reuse only a healthy :8402. Starting a second bundled proxy resets
  // session counters and can race the one that already paid — but a process
  // that LISTENs and does not answer GET /v1/session is wedged. Treating
  // "port occupied" as reuse is worse than a crash (completions then throw
  // undici `fetch failed` forever). Ping must time out; occupied ≠ healthy.
  if (await pingUrl('http://127.0.0.1:8402/v1/session')) return;
  if (await portOccupied(8402)) {
    console.error('[openzoo] :8402 is listening but /v1/session did not answer — not reusing a wedged proxy');
    return;
  }
  // Run the BUNDLED openzoo with Electron's OWN node. The packaged app must
  // ship the same sidecar version as this repo — a stale nested copy is how
  // a clean Mac sat on a black window while a leftover local listen "worked".
  const bin = path.join(__dirname, 'node_modules', 'openzoo', 'bin', 'openzoo.js');
  proxyProc = spawn(process.execPath, [bin], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
  });
  proxyProc.on('error', (e) => console.error('[openzoo] proxy failed to start:', e.message));
  if (typeof onStatus === 'function') onStatus('starting sidecar…');
  // First-run wallet + cold ESM load can sit here a while. The window is
  // already up on boot.html — do not bounce a healthy /v1/session.
  await waitFor('http://127.0.0.1:8402/v1/session', 60, 500);
}

function isBootPage(win) {
  try {
    const url = win.webContents.getURL();
    return url.startsWith('file:') && /boot\.html(?:[?#]|$)/.test(url);
  } catch {
    return false;
  }
}

function attachBootStatus(win) {
  win._bootStatus = 'starting…';
  const flush = () => {
    if (win.isDestroyed() || !isBootPage(win)) return;
    const js = `void (window.setBootStatus && window.setBootStatus(${JSON.stringify(win._bootStatus)}))`;
    win.webContents.executeJavaScript(js).catch(() => {});
  };
  win.webContents.on('did-finish-load', flush);
  return (text) => {
    win._bootStatus = String(text || 'starting…');
    flush();
  };
}

function createWindow() {
  // Paint immediately. Waiting on ensureProxy / /threads here is what left
  // people staring at a dead black rectangle on a clean Silicon Mac.
  const win = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#000000',
    show: true,
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
  win.loadFile(path.join(__dirname, 'boot.html'));
  win.show();
  return win;
}

async function revealChat(win, setStatus) {
  if (typeof setStatus === 'function') setStatus('starting…');
  const url = `http://localhost:${PORT}/threads`;
  const started = Date.now();
  for (;;) {
    if (win.isDestroyed()) return;
    if (await pingUrl(url)) break;
    const elapsed = Date.now() - started;
    if (elapsed > 8000 && typeof setStatus === 'function') setStatus('still starting…');
    if (elapsed > 45000) {
      if (typeof setStatus === 'function') setStatus('could not start — try restarting');
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (win.isDestroyed()) return;
  if (typeof setStatus === 'function') setStatus('opening…');
  await win.loadURL(`http://localhost:${PORT}`);
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
  const win = createWindow();
  const setStatus = attachBootStatus(win);
  ensureProxy(setStatus);
  revealChat(win, setStatus);
  checkForUpdates();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (!serverProc || serverProc.killed) startServer();
      const w = createWindow();
      const s = attachBootStatus(w);
      ensureProxy(s);
      revealChat(w, s);
    }
  });
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
