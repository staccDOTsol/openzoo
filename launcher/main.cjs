const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { resolveCLI, run } = require('./runtime.cjs');
let window, busy = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(() => {
    window = new BrowserWindow({ width: 740, height: 660, backgroundColor: '#101110', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.loadFile(path.join(__dirname, 'index.html'));
    ipcMain.handle('launch', async (event, command) => {
      if (event.sender !== window.webContents || !['chatgpt', 'bot'].includes(command) || busy) throw new Error('Launch unavailable');
      busy = true;
      const log = message => { if (!window.isDestroyed()) window.webContents.send('log', message); };
      try {
        const bundle = app.isPackaged ? path.join(process.resourcesPath, 'bundle') : path.join(__dirname, 'bundle');
        const { node, cli } = await resolveCLI(bundle, app.getPath('userData'), log);
        await run(node, [cli, command, ...(command === 'bot' ? ['--daemon'] : [])], log);
        log('\nLaunched. You can close this window.\n');
      } catch (e) { log(`\n${e.message}\n`); throw e; }
      finally { busy = false; }
    });
  });
  app.on('window-all-closed', () => app.quit());
}
