const { BrowserWindow, screen, ipcMain, clipboard, shell } = require('electron');
const path = require('node:path');
const { watchChatVisibility } = require('./chat-visibility.cjs');
let pill, revealPill;
function showSavings(port = Number(process.env.OPENZOO_SAVINGS_PORT) || 8402) {
  if (pill && !pill.isDestroyed()) { revealPill?.(); return pill; }
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  pill = new BrowserWindow({ width: 420, height: 270, x: x + width - 440, y: y + height - 290,
    show: false, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'savings-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  pill.setAlwaysOnTop(true, 'floating');
  pill.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  pill.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  pill.webContents.on('will-navigate', e => e.preventDefault());
  pill.loadFile(path.join(__dirname, 'savings.html'));
  const window = pill;
  const visibilityControl = new BrowserWindow({ width: 136, height: 40,
    x: x + 16, y: y + height - 100,
    show: false, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'savings-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  visibilityControl.setAlwaysOnTop(true, 'floating');
  visibilityControl.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  visibilityControl.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  visibilityControl.webContents.on('will-navigate', e => e.preventDefault());
  visibilityControl.loadFile(path.join(__dirname, 'savings-toggle.html'));
  let chatActive = false, userVisible = true;
  const applyVisibility = () => {
    if (window.isDestroyed() || visibilityControl.isDestroyed()) return;
    if (chatActive) {
      if (!visibilityControl.isVisible()) visibilityControl.showInactive();
      if (userVisible && !window.isVisible()) window.showInactive();
      if (!userVisible && window.isVisible()) window.hide();
    } else {
      window.hide();
      visibilityControl.hide();
    }
  };
  revealPill = () => { userVisible = true; applyVisibility(); syncVisibility(); };
  const syncVisibility = () => {
    if (!visibilityControl.isDestroyed()) visibilityControl.webContents.send('pill-visibility', userVisible);
  };
  const toggleVisibility = event => {
    if (event.sender !== visibilityControl.webContents || window.isDestroyed()) return;
    userVisible = !userVisible;
    applyVisibility();
    syncVisibility();
  };
  ipcMain.on('toggle-savings-visibility', toggleVisibility);
  window.on('show', syncVisibility);
  window.on('hide', syncVisibility);
  visibilityControl.webContents.on('did-finish-load', syncVisibility);
  const stopVisibility = watchChatVisibility(active => { chatActive = active; applyVisibility(); });
  let busy = false, last = null, wallet = null, expandedHeight = 270;
  const resize = height => {
    const b = window.getBounds(), area = screen.getDisplayMatching(b).workArea;
    window.setBounds({ ...b, height: Math.min(height, area.height), y: Math.max(area.y, Math.min(b.y, area.y + area.height - height)) });
  };
  const deposit = async event => {
    if (event.sender !== window.webContents) return;
    expandedHeight = 620;
    resize(expandedHeight);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/wallet`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw Error("Unavailable");
      wallet = await r.json();
      if (!window.isDestroyed()) window.webContents.send("deposit-wallet", { solana: wallet.solana, evm: wallet.evm });
    } catch { if (!window.isDestroyed()) window.webContents.send("deposit-wallet", { error: "Couldn’t load your wallet. Try again." }); }
  };
  const copy = (event, chain) => {
    if (event.sender !== window.webContents || !["solana", "evm"].includes(chain) || !wallet?.[chain]) return;
    clipboard.writeText(wallet[chain]);
    window.webContents.send("deposit-copied", chain);
  };
  const card = event => { if (event.sender === window.webContents) shell.openExternal("https://whop.com/staccoverflow/openzoo"); };
  const back = event => { if (event.sender === window.webContents) { expandedHeight = 270; resize(expandedHeight); } };
  const collapse = (event, collapsed) => {
    if (event.sender === window.webContents && typeof collapsed === "boolean") resize(collapsed ? 68 : expandedHeight);
  };
  ipcMain.on("collapse-savings", collapse);
  ipcMain.on("open-deposit", deposit);
  ipcMain.on("copy-deposit", copy);
  ipcMain.on("deposit-card", card);
  ipcMain.on("close-deposit", back);
  const poll = async () => {
    if (busy || window.isDestroyed()) return;
    busy = true;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/info`, { signal: AbortSignal.timeout(2500) });
      const d = await r.json();
      if (!r.ok || d.youAreTalkingTo !== 'openzoo proxy') throw Error('Unavailable');
      last = d;
      if (wallet && d.solana && typeof d.evm === 'string' && (wallet.solana !== d.solana || wallet.evm !== d.evm)) {
        wallet = { solana: d.solana, evm: d.evm };
        if (!window.isDestroyed()) window.webContents.send('deposit-wallet', wallet);
      }
      if (!window.isDestroyed()) window.webContents.send('savings', { ...d, online: true });
    } catch { if (!window.isDestroyed()) window.webContents.send('savings', { ...last, online: false }); }
    finally { busy = false; }
  };
  window.webContents.on('did-finish-load', () => {
    poll();
    if (process.env.OPENZOO_SAVINGS_READY) {
      try { require('node:fs').writeFileSync(process.env.OPENZOO_SAVINGS_READY, 'ready'); } catch {}
    }
  });
  const timer = setInterval(poll, 3000);
  const close = event => { if (event.sender === window.webContents) { userVisible = false; applyVisibility(); syncVisibility(); } };
  ipcMain.on('close-savings', close);
  window.on('closed', () => { stopVisibility(); revealPill = null; ipcMain.removeListener('toggle-savings-visibility', toggleVisibility); if (!visibilityControl.isDestroyed()) visibilityControl.destroy(); clearInterval(timer); for (const [name, fn] of [["collapse-savings",collapse],["open-deposit",deposit],["copy-deposit",copy],["deposit-card",card],["close-deposit",back]]) ipcMain.removeListener(name,fn); ipcMain.removeListener('close-savings', close); if (pill === window) pill = null; });
  return pill;
}
module.exports = { showSavings };
