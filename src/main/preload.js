// Modules Electron requis pour le pont de contexte
const { contextBridge, ipcRenderer } = require('electron');

// Exposition de l'API Electron au monde du renderer via contextBridge
contextBridge.exposeInMainWorld('electronAPI', {
  // Envoie un signal de minimisation à la fenêtre principale
  minimize: () => ipcRenderer.send('window:minimize'),
  // Envoie un signal de maximisation à la fenêtre principale
  maximize: () => ipcRenderer.send('window:maximize'),
  // Envoie un signal de fermeture à la fenêtre principale
  close: () => ipcRenderer.send('window:close'),
  // Vérifie si la fenêtre est actuellement maximisée
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  // Augmente le niveau de zoom de la fenêtre
  zoomIn: () => ipcRenderer.invoke('window:zoomIn'),
  // Diminue le niveau de zoom de la fenêtre
  zoomOut: () => ipcRenderer.invoke('window:zoomOut'),
  // Réinitialise le zoom à la valeur par défaut
  zoomReset: () => ipcRenderer.invoke('window:zoomReset'),

  // Ouvre un dialogue natif de sélection de fichier
  openFileDialog: (options) => ipcRenderer.invoke('dialog:openFile', options),
  // Ouvre un dialogue natif de sauvegarde de fichier
  saveFileDialog: (options) => ipcRenderer.invoke('dialog:saveFile', options),
  // Affiche une boîte de dialogue message native
  messageDialog: (options) => ipcRenderer.invoke('dialog:message', options),
  // Ouvre une URL dans le navigateur système par défaut
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Lit un fichier relatif au répertoire de l'application
  readFile: (relativePath) => ipcRenderer.invoke('fs:readFile', relativePath),
  // Écrit dans un fichier relatif au répertoire de l'application
  writeFile: (relativePath, content) => ipcRenderer.invoke('fs:writeFile', relativePath, content),

  // Affiche le menu contextuel natif avec les paramètres fournis
  showContextMenu: (params) => ipcRenderer.send('context-menu:show', params),
  // Enregistre un callback pour une action du menu contextuel
  onContextMenuAction: (channel, callback) => {
    const validChannels = ['context-menu:toggle-task', 'context-menu:delete-task'];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    }
  },

  // Scanne et retourne le graphe du vault Obsidian
  scanVaultGraph: () => ipcRenderer.invoke('vault:scanGraph'),
  // Lit le contenu d'un fichier du vault
  readVaultFile: (relpath) => ipcRenderer.invoke('vault:readFile', relpath),
  // Retourne l'URL de protocole sécurisé pour un fichier du vault
  getVaultFileUrl: (relpath) => ipcRenderer.invoke('vault:getFileUrl', relpath),
  // Ouvre un fichier du vault avec l'application système associée
  openVaultExternal: (relpath) => ipcRenderer.invoke('vault:openExternal', relpath),

  // Crée un nouvel onglet BrowserView pour le navigateur intégré
  browserCreateTab: (payload) => ipcRenderer.invoke('browser:createTab', payload),
  // Active et affiche un onglet BrowserView existant
  browserActivateTab: (tabId) => ipcRenderer.invoke('browser:activateTab', tabId),
  // Ferme et détruit un onglet BrowserView
  browserCloseTab: (tabId) => ipcRenderer.invoke('browser:closeTab', tabId),
  // Navigue vers une URL dans l'onglet BrowserView spécifié
  browserNavigate: (payload) => ipcRenderer.invoke('browser:navigate', payload),
  // Navigue en arrière dans l'historique d'un onglet
  browserGoBack: (tabId) => ipcRenderer.invoke('browser:goBack', tabId),
  // Navigue en avant dans l'historique d'un onglet
  browserGoForward: (tabId) => ipcRenderer.invoke('browser:goForward', tabId),
  // Recharge la page de l'onglet spécifié
  browserReload: (tabId) => ipcRenderer.invoke('browser:reload', tabId),
  // Affiche ou masque le navigateur intégré
  browserSetVisible: (visible) => ipcRenderer.invoke('browser:setVisible', visible),
  // Définit les dimensions et la position du navigateur intégré
  browserSetBounds: (bounds) => ipcRenderer.invoke('browser:setBounds', bounds),
  // Remplit automatiquement le formulaire GitHub avec les identifiants fournis
  browserAutofillGithub: (payload) => ipcRenderer.invoke('browser:autofillGithub', payload),
  // Remplit automatiquement un formulaire avec un identifiant sauvegardé
  browserAutofillSavedCredential: (payload) => ipcRenderer.invoke('browser:autofillSavedCredential', payload),
  // Enregistre un callback pour les événements de mise à jour d'onglets
  onBrowserTabUpdated: (callback) => {
    ipcRenderer.on('browser:tab-updated', (_event, payload) => callback(payload));
  },

  // Vérifie la disponibilité du chiffrement dans le coffre-fort
  passwordVaultStatus: () => ipcRenderer.invoke('passwordVault:status'),
  // Liste les entrées déchiffrées du coffre-fort de mots de passe
  passwordVaultList: () => ipcRenderer.invoke('passwordVault:list'),
  // Crée ou met à jour une entrée dans le coffre-fort
  passwordVaultUpsert: (payload) => ipcRenderer.invoke('passwordVault:upsert', payload),
  // Supprime une entrée du coffre-fort par identifiant
  passwordVaultDelete: (credentialId) => ipcRenderer.invoke('passwordVault:delete', credentialId),
  // Recherche une entrée dans le coffre-fort par origine (domaine)
  passwordVaultFindByOrigin: (origin) => ipcRenderer.invoke('passwordVault:findByOrigin', origin),
});
