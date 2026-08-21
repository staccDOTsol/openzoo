const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  readText: () => ipcRenderer.invoke('read-text'),
  healSidecar: () => ipcRenderer.invoke('heal-sidecar'),
  onFindInThread: (cb) => {
    ipcRenderer.removeAllListeners('find-in-thread');
    ipcRenderer.on('find-in-thread', () => { cb(); });
  },
});
