const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Window Controls ──────────────────────────
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  zoomIn: () => ipcRenderer.invoke('window:zoomIn'),
  zoomOut: () => ipcRenderer.invoke('window:zoomOut'),
  zoomReset: () => ipcRenderer.invoke('window:zoomReset'),

  // ── Native Dialogs ──────────────────────────
  openFileDialog: (options) => ipcRenderer.invoke('dialog:openFile', options),
  saveFileDialog: (options) => ipcRenderer.invoke('dialog:saveFile', options),
  messageDialog: (options) => ipcRenderer.invoke('dialog:message', options),

  // ── File System (scoped) ────────────────────
  readFile: (relativePath) => ipcRenderer.invoke('fs:readFile', relativePath),
  writeFile: (relativePath, content) => ipcRenderer.invoke('fs:writeFile', relativePath, content),

  // ── Context Menu ────────────────────────────
  showContextMenu: (params) => ipcRenderer.send('context-menu:show', params),
  onContextMenuAction: (channel, callback) => {
    const validChannels = ['context-menu:toggle-task', 'context-menu:delete-task'];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    }
  },

  // ── Vault Graph ─────────────────────────────
  scanVaultGraph: () => ipcRenderer.invoke('vault:scanGraph'),
  readVaultFile: (relpath) => ipcRenderer.invoke('vault:readFile', relpath),
  getVaultFileUrl: (relpath) => ipcRenderer.invoke('vault:getFileUrl', relpath),
  openVaultExternal: (relpath) => ipcRenderer.invoke('vault:openExternal', relpath),
});
