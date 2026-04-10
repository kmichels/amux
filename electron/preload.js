const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('amux', {
  connect: (url) => ipcRenderer.send('connect', url),
  removeConnection: (url) => ipcRenderer.send('remove-connection', url),
  disconnect: () => ipcRenderer.send('disconnect'),
  onConfig: (callback) => ipcRenderer.on('init-config', (event, config) => callback(config)),
});
