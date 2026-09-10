const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { resolveCLI, run } = require('./runtime.cjs');
const { showSavings } = require('./savings.cjs');
const savingsOnly = process.argv.includes('--savings-only');
let window, busy = false;

// npm's standalone overlay uses the default openzoo-launcher profile. It has no
// bundled runtime and must never own the packaged launcher's instance lock.
if (app.isPackaged) {
  const userData = path.join(app.getPath('appData'), 'openzoo-launcher-desktop');
  fs.mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
}

function showLauncher() {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return window;
  }
  window = new BrowserWindow({ width: 740, height: 660, backgroundColor: '#101110', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('closed', () => { window = undefined; });
  window.loadFile(path.join(__dirname, 'index.html'));
  return window;
}

if (!app.requestSingleInstanceLock({ savingsReady: process.env.OPENZOO_SAVINGS_READY })) app.quit();
else {
  ipcMain.handle('launch', async (event, command) => {
    if (!window || window.isDestroyed() || event.sender !== window.webContents || command !== 'chatgpt' || busy) throw new Error('Launch unavailable');
    busy = true;
    const launchWindow = window;
    const log = message => { if (!launchWindow.isDestroyed()) launchWindow.webContents.send('log', message); };
    try {
      const bundle = app.isPackaged ? path.join(process.resourcesPath, 'bundle') : path.join(__dirname, 'bundle');
      const { node, cli } = await resolveCLI(bundle, app.getPath('userData'), log);
      showSavings();
      await run(node, [cli, 'chatgpt', '--no-pill'], log);
      log('\nLaunched. You can close this window.\n');
    } catch (e) { log(`\n${e.message}\n`); throw e; }
    finally { busy = false; }
  });
  app.on('second-instance', (_event, argv, _cwd, data) => {
    app.whenReady().then(() => {
      if (argv.includes('--savings-only')) {
        const pill = showSavings();
        const ready = () => { if (data?.savingsReady) { try { fs.writeFileSync(data.savingsReady, 'ready'); } catch {} } };
        if (pill.webContents.isLoading()) pill.webContents.once('did-finish-load', ready); else ready();
      } else showLauncher();
    });
  });
  app.whenReady().then(() => {
    if (savingsOnly) showSavings();
    else showLauncher();
  });
  app.on('activate', () => {
    if (app.isReady() && (app.isPackaged || !savingsOnly)) showLauncher();
  });
  app.on('window-all-closed', () => app.quit());
}
