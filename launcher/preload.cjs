const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('openzoo', {
  launch: command => ipcRenderer.invoke('launch', command),
  onLog: callback => ipcRenderer.on('log', (_event, message) => callback(message))
});
