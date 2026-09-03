const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  getStatus: () => ipcRenderer.invoke('bot-status'),
  onStatus: (cb) => {
    ipcRenderer.removeAllListeners('bot-status');
    ipcRenderer.on('bot-status', (_e, s) => { cb(s); });
  },
});
