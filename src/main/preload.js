const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  zoomIn: () => ipcRenderer.invoke('window:zoomIn'),
  zoomOut: () => ipcRenderer.invoke('window:zoomOut'),
  zoomReset: () => ipcRenderer.invoke('window:zoomReset'),

  openFileDialog: (options) => ipcRenderer.invoke('dialog:openFile', options),
  saveFileDialog: (options) => ipcRenderer.invoke('dialog:saveFile', options),
  messageDialog: (options) => ipcRenderer.invoke('dialog:message', options),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  readFile: (relativePath) => ipcRenderer.invoke('fs:readFile', relativePath),
  writeFile: (relativePath, content) => ipcRenderer.invoke('fs:writeFile', relativePath, content),

  showContextMenu: (params) => ipcRenderer.send('context-menu:show', params),
  onContextMenuAction: (channel, callback) => {
    const validChannels = ['context-menu:toggle-task', 'context-menu:delete-task'];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    }
  },

  scanVaultGraph: () => ipcRenderer.invoke('vault:scanGraph'),
  readVaultFile: (relpath) => ipcRenderer.invoke('vault:readFile', relpath),
  getVaultFileUrl: (relpath) => ipcRenderer.invoke('vault:getFileUrl', relpath),
  openVaultExternal: (relpath) => ipcRenderer.invoke('vault:openExternal', relpath),

  browserCreateTab: (payload) => ipcRenderer.invoke('browser:createTab', payload),
  browserActivateTab: (tabId) => ipcRenderer.invoke('browser:activateTab', tabId),
  browserCloseTab: (tabId) => ipcRenderer.invoke('browser:closeTab', tabId),
  browserNavigate: (payload) => ipcRenderer.invoke('browser:navigate', payload),
  browserGoBack: (tabId) => ipcRenderer.invoke('browser:goBack', tabId),
  browserGoForward: (tabId) => ipcRenderer.invoke('browser:goForward', tabId),
  browserReload: (tabId) => ipcRenderer.invoke('browser:reload', tabId),
  browserSetVisible: (visible) => ipcRenderer.invoke('browser:setVisible', visible),
  browserSetBounds: (bounds) => ipcRenderer.invoke('browser:setBounds', bounds),
  browserAutofillGithub: (payload) => ipcRenderer.invoke('browser:autofillGithub', payload),
  browserAutofillSavedCredential: (payload) => ipcRenderer.invoke('browser:autofillSavedCredential', payload),
  onBrowserTabUpdated: (callback) => {
    ipcRenderer.on('browser:tab-updated', (_event, payload) => callback(payload));
  },

  passwordVaultStatus: () => ipcRenderer.invoke('passwordVault:status'),
  passwordVaultList: () => ipcRenderer.invoke('passwordVault:list'),
  passwordVaultUpsert: (payload) => ipcRenderer.invoke('passwordVault:upsert', payload),
  passwordVaultDelete: (credentialId) => ipcRenderer.invoke('passwordVault:delete', credentialId),
  passwordVaultFindByOrigin: (origin) => ipcRenderer.invoke('passwordVault:findByOrigin', origin),
});
