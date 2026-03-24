const { app, BrowserWindow, BrowserView, ipcMain, dialog, Menu, globalShortcut, shell, protocol, safeStorage } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const fs = require('fs');
const os = require('os');
const windowStateKeeper = require('electron-window-state');

/* GPU tile-memory fix — prevents "tile memory limits exceeded" on large SVG graphs */
app.commandLine.appendSwitch('max-active-webgl-contexts', '16');
app.commandLine.appendSwitch('force-gpu-mem-available-mb', '512');

/* Register custom protocol for serving vault files securely */
protocol.registerSchemesAsPrivileged([
  { scheme: 'vault-file', privileges: { bypassCSP: true, stream: true, supportFetchAPI: true } }
]);

const PORT = 8080;
let serverProcess = null;
let mainWindow = null;
let browserVisible = false;
let activeBrowserTabId = null;
let browserBounds = { x: 0, y: 0, width: 0, height: 0 };
const browserViews = new Map();

/* Secure password vault (encrypted at rest via OS keyring through Electron safeStorage). */
function getPasswordVaultFilePath() {
  return path.join(app.getPath('userData'), 'password_vault.json');
}

function passwordEncryptionAvailable() {
  try {
    return !!(safeStorage && safeStorage.isEncryptionAvailable());
  } catch {
    return false;
  }
}

function normalizeCredentialOrigin(rawOrigin) {
  const raw = String(rawOrigin || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return (url.hostname || '').toLowerCase();
  } catch {
    return '';
  }
}

function readPasswordVault() {
  const fp = getPasswordVaultFilePath();
  try {
    const raw = fs.readFileSync(fp, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.entries)) {
      return { version: 1, entries: parsed.entries };
    }
  } catch {}
  return { version: 1, entries: [] };
}

function writePasswordVault(vault) {
  const fp = getPasswordVaultFilePath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(vault, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

function encryptVaultSecret(value) {
  if (!passwordEncryptionAvailable()) {
    throw new Error('Chiffrement indisponible: keyring systeme non detecte.');
  }
  return safeStorage.encryptString(String(value || '')).toString('base64');
}

function decryptVaultSecret(cipherB64) {
  try {
    const plain = safeStorage.decryptString(Buffer.from(String(cipherB64 || ''), 'base64'));
    return String(plain || '');
  } catch {
    return '';
  }
}

function listVaultEntriesDecrypted() {
  const vault = readPasswordVault();
  return vault.entries.map((entry) => ({
    id: entry.id,
    origin: entry.origin,
    label: entry.label || '',
    username: decryptVaultSecret(entry.usernameEnc),
    updatedAt: entry.updatedAt || '',
  }));
}

function getVaultEntryById(credentialId) {
  const id = String(credentialId || '').trim();
  if (!id) return null;
  const vault = readPasswordVault();
  return vault.entries.find((entry) => entry.id === id) || null;
}

function autofillLoginFormScript(username, password) {
  return `(() => {
    const username = ${JSON.stringify(String(username || ''))};
    const password = ${JSON.stringify(String(password || ''))};

    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const setValue = (el, value) => {
      if (!el) return false;
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };

    const userSelectors = [
      'input[name="username"]',
      'input[name="login"]',
      'input[name="email"]',
      'input[type="email"]',
      'input[autocomplete="username"]',
      'input[id*="user" i]',
      'input[id*="login" i]'
    ];
    const passSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[autocomplete="current-password"]',
      'input[autocomplete="new-password"]'
    ];

    const userInput = userSelectors
      .flatMap((s) => Array.from(document.querySelectorAll(s)))
      .find((el) => isVisible(el) && !el.disabled && !el.readOnly);
    const passInput = passSelectors
      .flatMap((s) => Array.from(document.querySelectorAll(s)))
      .find((el) => isVisible(el) && !el.disabled && !el.readOnly);

    const userOk = setValue(userInput, username);
    const passOk = setValue(passInput, password);
    return { ok: userOk && passOk, userOk, passOk };
  })();`;
}

/* ═══════════════════════════════════════════════════════
   Path Helpers (handles packaged vs dev mode)
   ═══════════════════════════════════════════════════════ */
function resourceRootDir() {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return path.resolve(__dirname, '..', '..');
}

function resourcePath(...segments) {
  return path.join(resourceRootDir(), ...segments);
}

function resourceDir() {
  return resourceRootDir();
}

/* ═══════════════════════════════════════════════════════
   Python Server
   ═══════════════════════════════════════════════════════ */
function startPythonServer() {
  const serverPath = resourcePath('src', 'backend', 'server.py');
  serverProcess = spawn('python3', [serverPath], {
    cwd: resourcePath('src', 'backend'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (data) => {
    console.log(`[server] ${data.toString().trim()}`);
  });

  serverProcess.stderr.on('data', (data) => {
    console.error(`[server] ${data.toString().trim()}`);
  });

  serverProcess.on('error', (err) => {
    console.error('Failed to start Python server:', err.message);
  });
}

function waitForServer(port, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryConnect = () => {
      const socket = new net.Socket();
      socket.setTimeout(500);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - start > timeout) {
          reject(new Error('Server did not start in time'));
        } else {
          setTimeout(tryConnect, 200);
        }
      });
      socket.once('timeout', () => {
        socket.destroy();
        setTimeout(tryConnect, 200);
      });
      socket.connect(port, '127.0.0.1');
    };
    tryConnect();
  });
}

/* ═══════════════════════════════════════════════════════
   Window Creation
   ═══════════════════════════════════════════════════════ */
function createWindow() {
  const winState = windowStateKeeper({
    defaultWidth: 1100,
    defaultHeight: 800,
  });

  mainWindow = new BrowserWindow({
    x: winState.x,
    y: winState.y,
    width: winState.width,
    height: winState.height,
    minWidth: 800,
    minHeight: 550,
    title: 'ISENAPP',
    icon: resourcePath('assets', 'logo.svg'),
    frame: false,
    transparent: false,
    backgroundColor: '#1e1e2e',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  winState.manage(mainWindow);

  mainWindow.loadURL(`http://localhost:${PORT}`);
  mainWindow.setMenuBarVisibility(false);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    for (const view of browserViews.values()) {
      try {
        if (!view.webContents.isDestroyed()) view.webContents.destroy();
      } catch {}
    }
    browserViews.clear();
    activeBrowserTabId = null;
    mainWindow = null;
  });

  mainWindow.on('resize', () => {
    applyBrowserViewLayout();
  });
}

/* ═══════════════════════════════════════════════════════
   BrowserView Tabs (native Electron browser areas)
   ═══════════════════════════════════════════════════════ */
function sanitizeBrowserUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return 'https://www.google.com';
  if (/^https?:\/\//i.test(url)) return url;
  return 'https://' + url;
}

function browserSessionPartitionForUrl(rawUrl) {
  const safeUrl = sanitizeBrowserUrl(rawUrl);
  try {
    const host = (new URL(safeUrl).hostname || 'default').toLowerCase();
    const slug = host.replace(/[^a-z0-9.-]/g, '-').slice(0, 80) || 'default';
    return `persist:site-${slug}`;
  } catch {
    return 'persist:site-default';
  }
}

function emitBrowserTabUpdate(tabId, payload = {}) {
  if (!mainWindow || !mainWindow.webContents || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('browser:tab-updated', { tabId, ...payload });
}

function detachAllBrowserViews() {
  if (!mainWindow) return;
  for (const view of browserViews.values()) {
    try { mainWindow.removeBrowserView(view); } catch {}
  }
}

function applyBrowserViewLayout() {
  if (!mainWindow || !browserVisible || !activeBrowserTabId) return;
  const active = browserViews.get(activeBrowserTabId);
  if (!active) return;

  const bounds = {
    x: Math.max(0, Math.floor(browserBounds.x || 0)),
    y: Math.max(0, Math.floor(browserBounds.y || 0)),
    width: Math.max(100, Math.floor(browserBounds.width || 0)),
    height: Math.max(100, Math.floor(browserBounds.height || 0)),
  };

  try {
    active.setBounds(bounds);
    active.setAutoResize({ width: false, height: false, horizontal: false, vertical: false });
  } catch {}
}

function ensureBrowserViewTab(tabId, initialUrl, partition) {
  if (browserViews.has(tabId)) return browserViews.get(tabId);

  const tabPartition = String(partition || '').trim() || browserSessionPartitionForUrl(initialUrl);
  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      partition: tabPartition,
    },
  });
  browserViews.set(tabId, view);

  /* Allow OAuth / login popups: open them in a real BrowserWindow
     sharing the same session partition so auth cookies flow back. */
  view.webContents.setWindowOpenHandler(({ url }) => {
    const popupUrl = sanitizeBrowserUrl(url);
    const popup = new BrowserWindow({
      width: 600,
      height: 700,
      parent: mainWindow,
      modal: false,
      show: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        partition: tabPartition,
      },
    });
    popup.setMenuBarVisibility(false);
    popup.loadURL(popupUrl).catch(() => {});

    /* When the popup navigates back to the original site or closes,
       refresh the parent BrowserView so it picks up the new session. */
    popup.webContents.on('will-redirect', (_e, redirectUrl) => {
      try {
        const redirectHost = new URL(redirectUrl).hostname.toLowerCase();
        const originalHost = new URL(sanitizeBrowserUrl(view.webContents.getURL())).hostname.toLowerCase();
        if (redirectHost === originalHost) {
          popup.close();
          view.webContents.reload();
        }
      } catch {}
    });

    popup.on('closed', () => {
      /* After any auth popup closes, reload parent view to pick up session */
      try {
        if (!view.webContents.isDestroyed()) {
          emitBrowserTabUpdate(tabId, {
            url: view.webContents.getURL(),
            title: view.webContents.getTitle(),
          });
        }
      } catch {}
    });

    return { action: 'deny' };
  });

  view.webContents.on('did-start-loading', () => {
    emitBrowserTabUpdate(tabId, { loading: true });
  });
  view.webContents.on('did-stop-loading', () => {
    emitBrowserTabUpdate(tabId, {
      loading: false,
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
      canGoBack: view.webContents.canGoBack(),
      canGoForward: view.webContents.canGoForward(),
    });
  });
  view.webContents.on('did-navigate', (_event, url) => {
    emitBrowserTabUpdate(tabId, {
      url,
      title: view.webContents.getTitle(),
      canGoBack: view.webContents.canGoBack(),
      canGoForward: view.webContents.canGoForward(),
    });
  });
  view.webContents.on('did-navigate-in-page', (_event, url) => {
    emitBrowserTabUpdate(tabId, {
      url,
      title: view.webContents.getTitle(),
      canGoBack: view.webContents.canGoBack(),
      canGoForward: view.webContents.canGoForward(),
    });
  });
  view.webContents.on('page-title-updated', () => {
    emitBrowserTabUpdate(tabId, { title: view.webContents.getTitle() });
  });

  view.webContents.loadURL(sanitizeBrowserUrl(initialUrl || 'https://www.google.com')).catch(() => {});
  return view;
}

function activateBrowserViewTab(tabId) {
  if (!mainWindow) return false;
  const view = browserViews.get(tabId);
  if (!view) return false;

  activeBrowserTabId = tabId;
  detachAllBrowserViews();
  if (browserVisible) {
    try { mainWindow.addBrowserView(view); } catch {}
    applyBrowserViewLayout();
  }

  emitBrowserTabUpdate(tabId, {
    url: view.webContents.getURL(),
    title: view.webContents.getTitle(),
    loading: view.webContents.isLoading(),
    canGoBack: view.webContents.canGoBack(),
    canGoForward: view.webContents.canGoForward(),
    active: true,
  });
  return true;
}

ipcMain.handle('browser:createTab', async (_event, payload = {}) => {
  const tabId = String(payload.tabId || '').trim();
  const url = sanitizeBrowserUrl(payload.url || 'https://www.google.com');
  const partition = String(payload.partition || '').trim() || browserSessionPartitionForUrl(url);
  const shouldActivate = payload.activate !== false;
  if (!tabId) return { ok: false, error: 'tabId manquant' };
  ensureBrowserViewTab(tabId, url, partition);
  if (shouldActivate) activateBrowserViewTab(tabId);
  return { ok: true };
});

ipcMain.handle('browser:activateTab', async (_event, tabId) => {
  const ok = activateBrowserViewTab(String(tabId || '').trim());
  return { ok, error: ok ? '' : 'onglet introuvable' };
});

ipcMain.handle('browser:closeTab', async (_event, tabIdRaw) => {
  const tabId = String(tabIdRaw || '').trim();
  const view = browserViews.get(tabId);
  if (!view) return { ok: false, error: 'onglet introuvable' };

  try { if (mainWindow) mainWindow.removeBrowserView(view); } catch {}
  browserViews.delete(tabId);
  try { if (!view.webContents.isDestroyed()) view.webContents.destroy(); } catch {}

  if (activeBrowserTabId === tabId) {
    const next = browserViews.keys().next().value || null;
    activeBrowserTabId = next;
    if (next) activateBrowserViewTab(next);
    else detachAllBrowserViews();
  }
  return { ok: true, activeTabId: activeBrowserTabId };
});

ipcMain.handle('browser:navigate', async (_event, payload = {}) => {
  const tabId = String(payload.tabId || '').trim();
  const view = browserViews.get(tabId);
  if (!view) return { ok: false, error: 'onglet introuvable' };
  const url = sanitizeBrowserUrl(payload.url || view.webContents.getURL());
  try {
    await view.webContents.loadURL(url);
    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('browser:goBack', async (_event, tabIdRaw) => {
  const view = browserViews.get(String(tabIdRaw || '').trim());
  if (!view) return { ok: false, error: 'onglet introuvable' };
  if (view.webContents.canGoBack()) view.webContents.goBack();
  return { ok: true };
});

ipcMain.handle('browser:goForward', async (_event, tabIdRaw) => {
  const view = browserViews.get(String(tabIdRaw || '').trim());
  if (!view) return { ok: false, error: 'onglet introuvable' };
  if (view.webContents.canGoForward()) view.webContents.goForward();
  return { ok: true };
});

ipcMain.handle('browser:reload', async (_event, tabIdRaw) => {
  const view = browserViews.get(String(tabIdRaw || '').trim());
  if (!view) return { ok: false, error: 'onglet introuvable' };
  view.webContents.reload();
  return { ok: true };
});

ipcMain.handle('browser:setVisible', async (_event, visibleRaw) => {
  browserVisible = !!visibleRaw;
  if (!browserVisible) {
    detachAllBrowserViews();
    return { ok: true };
  }
  if (activeBrowserTabId && browserViews.has(activeBrowserTabId) && mainWindow) {
    try { mainWindow.addBrowserView(browserViews.get(activeBrowserTabId)); } catch {}
    applyBrowserViewLayout();
  }
  return { ok: true };
});

ipcMain.handle('browser:setBounds', async (_event, bounds = {}) => {
  browserBounds = {
    x: Number(bounds.x || 0),
    y: Number(bounds.y || 0),
    width: Number(bounds.width || 0),
    height: Number(bounds.height || 0),
  };
  applyBrowserViewLayout();
  return { ok: true };
});

ipcMain.handle('browser:autofillGithub', async (_event, payload = {}) => {
  const tabId = String(payload.tabId || '').trim();
  const username = String(payload.username || '');
  const password = String(payload.password || '');
  const view = browserViews.get(tabId);
  if (!view) return { ok: false, error: 'onglet introuvable' };

  const js = `(() => {
    const user = ${JSON.stringify(username)};
    const pass = ${JSON.stringify(password)};
    const userInput = document.querySelector('input[name="login"], input#login_field, input[type="email"]');
    const passInput = document.querySelector('input[name="password"], input#password');
    if (userInput) userInput.value = user;
    if (passInput) passInput.value = pass;
    return { ok: !!(userInput && passInput) };
  })();`;

  try {
    const result = await view.webContents.executeJavaScript(js, true);
    return { ok: true, filled: !!(result && result.ok) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('passwordVault:status', async () => {
  return {
    ok: true,
    encryptionAvailable: passwordEncryptionAvailable(),
  };
});

ipcMain.handle('passwordVault:list', async () => {
  try {
    return { ok: true, entries: listVaultEntriesDecrypted() };
  } catch (err) {
    return { ok: false, error: err.message || String(err), entries: [] };
  }
});

ipcMain.handle('passwordVault:upsert', async (_event, payload = {}) => {
  try {
    if (!passwordEncryptionAvailable()) {
      return { ok: false, error: 'Chiffrement indisponible sur cette machine.' };
    }
    const origin = normalizeCredentialOrigin(payload.origin || '');
    const username = String(payload.username || '').trim();
    const password = String(payload.password || '');
    const label = String(payload.label || '').trim();
    if (!origin) return { ok: false, error: 'Origine invalide.' };
    if (!username || !password) return { ok: false, error: 'Identifiant et mot de passe requis.' };

    const nowIso = new Date().toISOString();
    const vault = readPasswordVault();
    const wantedId = String(payload.id || '').trim();
    const existingIdx = wantedId
      ? vault.entries.findIndex((entry) => entry.id === wantedId)
      : vault.entries.findIndex((entry) => entry.origin === origin && decryptVaultSecret(entry.usernameEnc) === username);

    const nextEntry = {
      id: wantedId || ('cred-' + Math.random().toString(36).slice(2, 10)),
      origin,
      label,
      usernameEnc: encryptVaultSecret(username),
      passwordEnc: encryptVaultSecret(password),
      updatedAt: nowIso,
      createdAt: nowIso,
    };

    if (existingIdx >= 0) {
      nextEntry.id = vault.entries[existingIdx].id;
      nextEntry.createdAt = vault.entries[existingIdx].createdAt || nowIso;
      vault.entries[existingIdx] = nextEntry;
    } else {
      vault.entries.push(nextEntry);
    }

    writePasswordVault(vault);
    return { ok: true, entryId: nextEntry.id };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('passwordVault:delete', async (_event, credentialId) => {
  try {
    const id = String(credentialId || '').trim();
    if (!id) return { ok: false, error: 'Id credential manquant.' };
    const vault = readPasswordVault();
    vault.entries = vault.entries.filter((entry) => entry.id !== id);
    writePasswordVault(vault);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('passwordVault:findByOrigin', async (_event, rawOrigin) => {
  try {
    const origin = normalizeCredentialOrigin(rawOrigin || '');
    if (!origin) return { ok: true, entry: null };
    const vault = readPasswordVault();
    const found = vault.entries.find((entry) => entry.origin === origin) || null;
    if (!found) return { ok: true, entry: null };
    return {
      ok: true,
      entry: {
        id: found.id,
        origin: found.origin,
        label: found.label || '',
        username: decryptVaultSecret(found.usernameEnc),
      },
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err), entry: null };
  }
});

ipcMain.handle('browser:autofillSavedCredential', async (_event, payload = {}) => {
  try {
    const tabId = String(payload.tabId || '').trim();
    const credentialId = String(payload.credentialId || '').trim();
    const view = browserViews.get(tabId);
    if (!view) return { ok: false, error: 'onglet introuvable' };

    const entry = getVaultEntryById(credentialId);
    if (!entry) return { ok: false, error: 'credential introuvable' };

    const username = decryptVaultSecret(entry.usernameEnc);
    const password = decryptVaultSecret(entry.passwordEnc);
    if (!username || !password) {
      return { ok: false, error: 'credential invalide ou non dechiffrable' };
    }

    const result = await view.webContents.executeJavaScript(autofillLoginFormScript(username, password), true);
    return { ok: true, filled: !!(result && result.ok) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

/* ═══════════════════════════════════════════════════════
   IPC Handlers — Window Controls
   ═══════════════════════════════════════════════════════ */
ipcMain.on('window:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.on('window:close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('window:isMaximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});

ipcMain.handle('window:zoomIn', () => {
  if (!mainWindow) return false;
  const wc = mainWindow.webContents;
  wc.setZoomLevel(wc.getZoomLevel() + 0.2);
  return true;
});

ipcMain.handle('window:zoomOut', () => {
  if (!mainWindow) return false;
  const wc = mainWindow.webContents;
  wc.setZoomLevel(wc.getZoomLevel() - 0.2);
  return true;
});

ipcMain.handle('window:zoomReset', () => {
  if (!mainWindow) return false;
  mainWindow.webContents.setZoomLevel(0);
  return true;
});

/* ═══════════════════════════════════════════════════════
   IPC Handlers — Native Dialogs
   ═══════════════════════════════════════════════════════ */
ipcMain.handle('dialog:openFile', async (_event, options) => {
  if (!mainWindow) return { canceled: true, filePaths: [] };
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: options?.filters || [],
  });
  return result;
});

ipcMain.handle('dialog:saveFile', async (_event, options) => {
  if (!mainWindow) return { canceled: true, filePath: '' };
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: options?.defaultPath || '',
    filters: options?.filters || [],
  });
  return result;
});

ipcMain.handle('dialog:message', async (_event, options) => {
  if (!mainWindow) return { response: 0 };
  const result = await dialog.showMessageBox(mainWindow, {
    type: options?.type || 'info',
    title: options?.title || 'Todo & Mail',
    message: options?.message || '',
    buttons: options?.buttons || ['OK'],
  });
  return result;
});

ipcMain.handle('shell:openExternal', async (_event, url) => {
  try {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  } catch {
    return false;
  }
});

/* ═══════════════════════════════════════════════════════
   IPC Handlers — File System (scoped to app directory)
   ═══════════════════════════════════════════════════════ */
ipcMain.handle('fs:readFile', async (_event, relativePath) => {
  const baseDir = resourceDir();
  const safePath = path.resolve(baseDir, path.basename(relativePath));
  if (!safePath.startsWith(baseDir)) return null;
  try {
    return fs.readFileSync(safePath, 'utf-8');
  } catch {
    return null;
  }
});

ipcMain.handle('fs:writeFile', async (_event, relativePath, content) => {
  const baseDir = resourceDir();
  const safePath = path.resolve(baseDir, path.basename(relativePath));
  if (!safePath.startsWith(baseDir)) return false;
  try {
    fs.writeFileSync(safePath, content, 'utf-8');
    return true;
  } catch {
    return false;
  }
});

/* ═══════════════════════════════════════════════════════
   IPC Handlers — Vault Graph (local scan, no HTTP API)
   ═══════════════════════════════════════════════════════ */
const VAULT_PATH = path.join(os.homedir(), 'Documents', 'isenapp_mails');
const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g;
const ATTACHMENT_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.svg','.pdf','.docx','.xlsx','.pptx','.odt','.csv','.zip']);

function scanVaultGraph() {
  const nodes = {};
  const edges = [];

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === '.obsidian' || entry.name === '.trash') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(fullPath); continue; }
      const relpath = path.relative(VAULT_PATH, fullPath);
      const ext = path.extname(entry.name).toLowerCase();
      const nameNoExt = path.basename(entry.name, path.extname(entry.name));

      if (ext === '.md') {
        let tags = [];
        try {
          const content = fs.readFileSync(fullPath, 'utf-8').slice(0, 4096);
          if (content.startsWith('---')) {
            const end = content.indexOf('---', 3);
            if (end !== -1) {
              for (const line of content.slice(3, end).split('\n')) {
                const trimmed = line.trim();
                if (trimmed.startsWith('- ')) tags.push(trimmed.slice(2).trim());
              }
            }
          }
        } catch {}
        const group = relpath.includes('mails/') ? 'mail' : 'md';
        nodes[nameNoExt] = { id: nameNoExt, label: nameNoExt, path: relpath, type: 'md', tags, group };
      } else if (ATTACHMENT_EXTS.has(ext)) {
        nodes[entry.name] = { id: entry.name, label: entry.name, path: relpath, type: 'attachment', tags: [], group: 'attachment' };
      }
    }
  }
  walk(VAULT_PATH);

  // Extract wikilink edges
  for (const [name, node] of Object.entries(nodes)) {
    if (node.type !== 'md') continue;
    try {
      const content = fs.readFileSync(path.join(VAULT_PATH, node.path), 'utf-8');
      let match;
      WIKILINK_RE.lastIndex = 0;
      while ((match = WIKILINK_RE.exec(content)) !== null) {
        const link = match[1].trim();
        if (link in nodes) {
          edges.push({ source: name, target: link });
        } else {
          if (!(link in nodes)) {
            nodes[link] = { id: link, label: link, path: '', type: 'orphan', tags: [], group: 'orphan' };
          }
          edges.push({ source: name, target: link });
        }
      }
    } catch {}
  }

  return { nodes: Object.values(nodes), edges };
}

ipcMain.handle('vault:scanGraph', async () => {
  try { return scanVaultGraph(); }
  catch (err) { return { nodes: [], edges: [], error: err.message }; }
});

ipcMain.handle('vault:readFile', async (_event, relpath) => {
  const safe = path.normalize(relpath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(VAULT_PATH, safe);
  if (!fullPath.startsWith(VAULT_PATH)) return { ok: false, error: 'Path outside vault' };
  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('vault:getFileUrl', async (_event, relpath) => {
  const safe = path.normalize(relpath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(VAULT_PATH, safe);
  if (!fullPath.startsWith(VAULT_PATH)) return { ok: false, error: 'Path outside vault' };
  try {
    fs.accessSync(fullPath, fs.constants.R_OK);
    return { ok: true, url: 'vault-file://load/' + encodeURIComponent(safe) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('vault:openExternal', async (_event, relpath) => {
  const safe = path.normalize(relpath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(VAULT_PATH, safe);
  if (!fullPath.startsWith(VAULT_PATH)) return { ok: false, error: 'Path outside vault' };
  try {
    await shell.openPath(fullPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* ═══════════════════════════════════════════════════════
   IPC Handlers — Context Menu
   ═══════════════════════════════════════════════════════ */
ipcMain.on('context-menu:show', (_event, params) => {
  if (!mainWindow) return;
  const template = [];

  if (params.hasSelection) {
    template.push(
      { label: 'Copier', role: 'copy', accelerator: 'CmdOrCtrl+C' },
      { label: 'Couper', role: 'cut', accelerator: 'CmdOrCtrl+X' },
    );
  }
  template.push(
    { label: 'Coller', role: 'paste', accelerator: 'CmdOrCtrl+V' },
    { label: 'Tout sélectionner', role: 'selectAll', accelerator: 'CmdOrCtrl+A' },
  );
  template.push({ type: 'separator' });

  if (params.isEditable) {
    template.push(
      { label: 'Annuler', role: 'undo', accelerator: 'CmdOrCtrl+Z' },
      { label: 'Rétablir', role: 'redo', accelerator: 'CmdOrCtrl+Shift+Z' },
      { type: 'separator' },
    );
  }

  if (params.isTask) {
    template.push(
      {
        label: params.isTaskDone ? '↩ Marquer non-fait' : '✓ Marquer fait',
        click: () => mainWindow.webContents.send('context-menu:toggle-task', params.taskId, params.sectionId),
      },
      {
        label: '🗑 Supprimer la tâche',
        click: () => mainWindow.webContents.send('context-menu:delete-task', params.taskId, params.sectionId),
      },
      { type: 'separator' },
    );
  }

  template.push(
    { label: 'Recharger', role: 'reload', accelerator: 'CmdOrCtrl+R' },
    { label: 'Outils de développement', role: 'toggleDevTools', accelerator: 'F12' },
  );

  const menu = Menu.buildFromTemplate(template);
  menu.popup({ window: mainWindow });
});

/* ═══════════════════════════════════════════════════════
   App Lifecycle
   ═══════════════════════════════════════════════════════ */
app.whenReady().then(async () => {
  // Register vault-file:// protocol to serve vault files securely
  protocol.handle('vault-file', (request) => {
    const url = new URL(request.url);
    const relpath = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const safe = path.normalize(relpath).replace(/^(\.\.[/\\])+/, '');
    const fullPath = path.join(VAULT_PATH, safe);
    if (!fullPath.startsWith(VAULT_PATH)) {
      return new Response('Forbidden', { status: 403 });
    }
    const ext = path.extname(fullPath).toLowerCase();
    const mimeMap = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
      '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
    };
    const mime = mimeMap[ext] || 'application/octet-stream';
    try {
      const data = fs.readFileSync(fullPath);
      return new Response(data, { headers: { 'Content-Type': mime } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  startPythonServer();
  try {
    await waitForServer(PORT);
  } catch (e) {
    console.error(e.message);
    app.quit();
    return;
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
