const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('node:path');
let pill;
function showSavings(port = 8402) {
  if (pill && !pill.isDestroyed()) { pill.show(); return pill; }
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  pill = new BrowserWindow({ width: 420, height: 270, x: x + width - 440, y: y + height - 290,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'savings-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  pill.setAlwaysOnTop(true, 'floating');
  pill.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  pill.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  pill.webContents.on('will-navigate', e => e.preventDefault());
  pill.loadFile(path.join(__dirname, 'savings.html'));
  const window = pill;
  let busy = false, last = null;
  const poll = async () => {
    if (busy || window.isDestroyed()) return;
    busy = true;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/info`, { signal: AbortSignal.timeout(2500) });
      const d = await r.json();
      if (!r.ok || d.youAreTalkingTo !== 'openzoo proxy') throw Error('Unavailable');
      last = d;
      if (!window.isDestroyed()) window.webContents.send('savings', { ...d, online: true });
    } catch { if (!window.isDestroyed()) window.webContents.send('savings', { ...last, online: false }); }
    finally { busy = false; }
  };
  window.webContents.on('did-finish-load', poll);
  const timer = setInterval(poll, 3000);
  const close = event => { if (event.sender === window.webContents) window.close(); };
  ipcMain.on('close-savings', close);
  window.on('closed', () => { clearInterval(timer); ipcMain.removeListener('close-savings', close); if (pill === window) pill = null; });
  return pill;
}
module.exports = { showSavings };
