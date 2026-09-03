const { app, BrowserWindow, ipcMain, clipboard, Menu, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

ipcMain.handle('copy-text', (_event, text) => {
  clipboard.writeText(String(text ?? ''));
  return true;
});

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' },
      ],
    }] : []),
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, isMac ? { role: 'front' } : { role: 'close' }] },
  ]));
}

function openzooRoot() {
  const repo = path.join(__dirname, '..');
  if (fs.existsSync(path.join(repo, 'bin', 'openzoo.js'))) return repo;
  return path.join(__dirname, 'node_modules', 'openzoo');
}

function openzooJs() {
  return path.join(openzooRoot(), 'bin', 'openzoo.js');
}

let botProc = null;
let quitting = false;
let botLog = '';
let shimFile = null;
let lastStatus = {
  proxy: 'starting…',
  proxyOk: false,
  bot: 'starting…',
  botOk: false,
  shim: '—',
  log: 'starting…',
};

function takeLog(buf) {
  const s = String(buf);
  botLog += s;
  if (botLog.length > 12000) botLog = botLog.slice(-12000);
  try { process.stderr.write(s); } catch { /* ignore */ }
  broadcast();
}

function pingSession() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:8402/v1/session', { timeout: 1500 }, (res) => {
      res.resume();
      resolve(Boolean(res.statusCode && res.statusCode < 500));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function snapshot() {
  const proxyOk = lastStatus.proxyOk;
  return {
    ...lastStatus,
    shim: shimFile || lastStatus.shim,
    log: (botLog.trim() || lastStatus.log).slice(-8000),
    proxyOk,
  };
}

function broadcast() {
  lastStatus.log = botLog.trim() || lastStatus.log;
  const s = snapshot();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('bot-status', s);
  }
}

ipcMain.handle('bot-status', async () => {
  lastStatus.proxyOk = await pingSession();
  lastStatus.proxy = lastStatus.proxyOk ? 'up :8402' : 'waiting for :8402';
  lastStatus.botOk = Boolean(botProc && botProc.exitCode == null);
  lastStatus.bot = lastStatus.botOk ? 'sidecar running' : (botProc ? 'sidecar exited' : 'starting…');
  lastStatus.shim = shimFile || '—';
  lastStatus.log = botLog.trim() || lastStatus.log;
  return snapshot();
});

function startBot() {
  if (botProc) return;
  const bin = openzooJs();
  if (!fs.existsSync(bin)) {
    botLog += `openzoo.js missing at ${bin}\n`;
    lastStatus.bot = 'openzoo.js missing';
    broadcast();
    return;
  }
  botProc = spawn(process.execPath, [bin, 'bot'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
  });
  if (botProc.stdout) botProc.stdout.on('data', takeLog);
  if (botProc.stderr) botProc.stderr.on('data', takeLog);
  botProc.on('error', (e) => {
    botLog += (e && e.stack) ? e.stack : String(e);
    broadcast();
  });
  botProc.on('exit', (code, signal) => {
    lastStatus.botOk = false;
    lastStatus.bot = code == null ? `exited ${signal}` : `exited ${code}`;
    botProc = null;
    broadcast();
    if (quitting) return;
    setTimeout(() => { if (!quitting && !botProc) startBot(); }, 1500);
  });
}

async function installShim() {
  if (!app.isPackaged) return null;
  const shimJs = path.join(openzooRoot(), 'lib', 'openzooPathShim.js');
  const { writeOpenzooShim } = await import(pathToFileURL(shimJs).href);
  return writeOpenzooShim({ execPath: process.execPath, openzooJs: openzooJs() });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 720,
    height: 520,
    minWidth: 480,
    minHeight: 360,
    backgroundColor: '#000000',
    titleBarStyle: 'hiddenInset',
    title: 'OpenZoo Bot',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadFile(path.join(__dirname, 'status.html'));
}

app.whenReady().then(async () => {
  buildAppMenu();
  try { shimFile = await installShim(); } catch (e) {
    botLog += `path shim: ${e.message}\n`;
  }
  createWindow();
  startBot();
  setInterval(() => {
    pingSession().then((ok) => {
      lastStatus.proxyOk = ok;
      lastStatus.proxy = ok ? 'up :8402' : 'waiting for :8402';
      lastStatus.botOk = Boolean(botProc && botProc.exitCode == null);
      lastStatus.bot = lastStatus.botOk ? 'sidecar running' : lastStatus.bot;
      broadcast();
    });
  }, 2000);
  app.on('activate', () => {
    if (quitting) return;
    if (!botProc) startBot();
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  if (botProc) { botProc.kill(); botProc = null; }
});
