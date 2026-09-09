const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('savings', {
  listen: fn => ipcRenderer.on('savings', (_event, value) => fn(value)),
  close: () => ipcRenderer.send('close-savings'),
});
