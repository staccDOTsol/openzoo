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
  // Windows has neither /bin/zsh nor `-ilc`, so the POSIX form threw
  // `Error: spawn /bin/zsh ENOENT` out of the main process and killed the app
  // on launch with "A JavaScript error occurred in the main process" — every
  // Windows build was dead on arrival. cmd.exe needs no login-shell trick
  // because Windows GUI apps DO inherit the user PATH.
  if (process.platform === 'win32') {
    proxyProc = spawn(process.env.COMSPEC || 'cmd.exe', ['/c', 'npx -y openzoo@latest'],
      { stdio: 'inherit', windowsHide: true });
  } else {
    const shell = process.env.SHELL || '/bin/zsh';
    proxyProc = spawn(shell, ['-ilc', 'npx -y openzoo@latest'], { stdio: 'inherit' });
  }
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
