'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spike', {
  envInfo: () => ipcRenderer.invoke('env:info'),
  spawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
  input: (id, data) => ipcRenderer.send('pty:input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  kill: (id) => ipcRenderer.send('pty:kill', { id }),
  onData: (cb) => ipcRenderer.on('pty:data', (_e, m) => cb(m)),
  onExit: (cb) => ipcRenderer.on('pty:exit', (_e, m) => cb(m)),
  clipRead: () => ipcRenderer.invoke('clip:read'),
  clipWrite: (text) => ipcRenderer.send('clip:write', text),
  openLink: (url) => ipcRenderer.send('link:open', url),
});
