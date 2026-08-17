const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

ipcMain.handle('pick-directory', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

const PORT = process.env.OZ_GROKUI_PORT || 4173;
let serverProc, proxyProc;

function startServer() {
  // ELECTRON_RUN_AS_NODE makes the packaged Electron binary behave as plain
  // Node when spawned as a subprocess — without it, a packaged .app would try
  // to launch a second Electron GUI instance instead of running the script.
  serverProc = spawn(process.execPath, [path.join(__dirname, 'lib', 'grokui.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
}

function pingUrl(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => { res.resume(); resolve(true); }).on('error', () => resolve(false));
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
  if (await pingUrl('http://127.0.0.1:8402/v1/session')) return; // already running
  const shell = process.env.SHELL || '/bin/zsh';
  proxyProc = spawn(shell, ['-ilc', 'npx -y openzoo@latest'], { stdio: 'inherit' });
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

app.whenReady().then(() => {
  startServer();
  createWindow();
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
