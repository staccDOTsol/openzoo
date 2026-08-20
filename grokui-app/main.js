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
// the app is self-contained instead of requiring `npx openzoo` run by hand
// first. Via the user's LOGIN shell (-ilc), not a bare spawn: a GUI app
// launched from Finder/Dock doesn't inherit ~/.zshrc's PATH (nvm etc.), so a
// plain spawn('npx', ...) silently can't find node. `npx -y openzoo@latest`
// doubles as install-or-update: it fetches the current published version if
// it's not already cached.
async function ensureProxy() {
  // Reuse a healthy :8402. Starting a second bundled proxy resets in-memory
  // session counters and can race the one that already paid. Ping the
  // session endpoint; if anything is already listening, do not replace it.
  if (await pingUrl('http://127.0.0.1:8402/v1/session')) return;
  if (await portOccupied(8402)) return;
  // Run the BUNDLED openzoo with Electron's OWN node, rather than shelling out
  // to npx. Going through npx assumed the machine had Node installed and on
  // PATH, which is a bad assumption for a desktop app: a clean Windows 11 box
  // has no Node, so `npx` did not exist, the proxy never started, and every
  // message came back "error: fetch failed" while the app itself ran fine
  // (Electron ships its own Node, which is exactly what we use here). It also
  // dodges the macOS problem that a GUI app launched from Finder/Dock does not
  // inherit ~/.zshrc's PATH, and it pins the proxy to a version we actually
  // tested instead of whatever @latest resolves to at runtime.
  const bin = path.join(__dirname, 'node_modules', 'openzoo', 'bin', 'openzoo.js');
  proxyProc = spawn(process.execPath, [bin], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
  });
  proxyProc.on('error', (e) => console.error('[openzoo] proxy failed to start:', e.message));
  await waitFor('http://127.0.0.1:8402/v1/session', 60, 500); // up to ~30s (first-run npx fetch)
}

async function createWindow() {
  await ensureProxy();
  await waitFor(`http://localhost:${PORT}/threads`, 40, 150);
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
  win.loadURL(`http://localhost:${PORT}`);
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
