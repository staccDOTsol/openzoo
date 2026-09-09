const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('savings', {
  listen: fn => ipcRenderer.on('savings', (_event, value) => fn(value)),
  deposit: () => ipcRenderer.send("open-deposit"),
  back: () => ipcRenderer.send("close-deposit"),
  copy: chain => ipcRenderer.send("copy-deposit", chain),
  card: () => ipcRenderer.send("deposit-card"),
  wallet: fn => ipcRenderer.on("deposit-wallet", (_event, value) => fn(value)),
  copied: fn => ipcRenderer.on("deposit-copied", (_event, value) => fn(value)),
  collapse: collapsed => ipcRenderer.send("collapse-savings", collapsed),
  toggleVisibility: () => ipcRenderer.send("toggle-savings-visibility"),
  visibility: fn => ipcRenderer.on("pill-visibility", (_event, visible) => fn(visible)),
  close: () => ipcRenderer.send('close-savings'),
});
