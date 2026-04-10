const { app, BrowserWindow, BrowserView, ipcMain, dialog, Menu, globalShortcut, shell, protocol, safeStorage } = require('electron');
const { spawn, spawnSync, execSync } = require('child_process');
const path = require('path');
const net = require('net');
const fs = require('fs');
const os = require('os');
const windowStateKeeper = require('electron-window-state');
const { resourcePath, resourceDir } = require('./lib/resource-paths');
const { registerPasswordVaultIpcHandlers, normalizeCredentialOrigin, readVaultRaw, autofillLoginFormScript } = require('./lib/password-vault');
const { handleVaultFileRequest, registerVaultGraphIpcHandlers } = require('./lib/vault-graph');

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
let backendLastError = '';
let backendLogBuffer = [];
let browserVisible = false;
let activeBrowserTabId = null;
let browserBounds = { x: 0, y: 0, width: 0, height: 0 };
const browserViews = new Map();

/* Decrypt a vault secret using safeStorage (available after app ready) */
function decryptVaultSecretMain(cipherB64) {
  try {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) return '';
    const plain = safeStorage.decryptString(Buffer.from(String(cipherB64 || ''), 'base64'));
    return String(plain || '');
  } catch {
    return '';
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

/* ═══════════════════════════════════════════════════════
   Python Server
   ═══════════════════════════════════════════════════════ */
function pushBackendLog(line) {
  if (!line) return;
  backendLogBuffer.push(String(line));
  if (backendLogBuffer.length > 80) {
    backendLogBuffer = backendLogBuffer.slice(-80);
  }
}

function detectPythonCommand() {
  const fromEnv = String(process.env.ISENAPP_PYTHON || '').trim();
  if (fromEnv) return fromEnv;
  return 'python3';
}

function ensurePythonDependencies(pythonCmd) {
  // Check ALL required imports, not just a subset
  const requiredImports = ['html2text', 'neo4j', 'dotenv', 'sentence_transformers', 'langchain', 'langchain_community'];
  const check = spawnSync(pythonCmd, ['-c', `import ${requiredImports.join(', ')}`], {
    encoding: 'utf8',
    timeout: 30000,
  });

  if (check.status === 0) {
    pushBackendLog('Python deps check: OK');
    return;
  }

  const reqPath = resourcePath(app, 'requirements.txt');
  if (!fs.existsSync(reqPath)) {
    pushBackendLog('requirements.txt introuvable: installation auto impossible');
    return;
  }

  pushBackendLog('Dépendances Python manquantes: tentative d\'installation locale (--user) ...');
  // Try standard pip install first
  let install = spawnSync(
    pythonCmd,
    ['-m', 'pip', 'install', '--user', '-r', reqPath],
    { encoding: 'utf8', timeout: 300000 },
  );

  // If we hit PEP 668 "externally-managed-environment", retry with --break-system-packages
  if (install.status !== 0 && (install.stderr || '').includes('externally-managed-environment')) {
    pushBackendLog('PEP 668 detected, retrying with --break-system-packages ...');
    install = spawnSync(
      pythonCmd,
      ['-m', 'pip', 'install', '--user', '--break-system-packages', '-r', reqPath],
      { encoding: 'utf8', timeout: 300000 },
    );
  }

  if (install.stdout) pushBackendLog(install.stdout.slice(-500).trim());
  if (install.stderr) pushBackendLog(install.stderr.slice(-500).trim());

  if (install.status !== 0) {
    pushBackendLog(`Installation Python deps échouée (code ${install.status ?? 'n/a'})`);
  } else {
    pushBackendLog('Installation Python deps terminée');
  }
}

function buildBackendFailureMessage() {
  const logs = backendLogBuffer.slice(-12).join('\n').trim();
  const details = logs || 'Aucun log backend disponible.';
  return [
    'Le backend Python n\'a pas pu démarrer.',
    '',
    'Cause probable: dépendances Python absentes (ex: html2text) dans l\'environnement système.',
    '',
    'Commande de correction (Linux):',
    'python3 -m pip install --user -r requirements.txt',
    '',
    'Tu peux aussi forcer un interpréteur Python via la variable ISENAPP_PYTHON.',
    '',
    `Détail: ${backendLastError || 'timeout de démarrage'}`,
    '',
    'Derniers logs backend:',
    details,
  ].join('\n');
}

function startPythonServer() {
  const pythonCmd = detectPythonCommand();
  const serverPath = resourcePath(app, 'src', 'backend', 'server.py');
  backendLastError = '';
  backendLogBuffer = [];

  ensurePythonDependencies(pythonCmd);

  serverProcess = spawn(pythonCmd, ['-u', serverPath], {
    cwd: resourcePath(app, 'src', 'backend'),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (data) => {
    const line = data.toString().trim();
    if (!line) return;
    pushBackendLog(line);
    console.log(`[server] ${line}`);
  });

  serverProcess.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (!line) return;
    pushBackendLog(line);
    console.error(`[server] ${line}`);
  });

  serverProcess.on('error', (err) => {
    backendLastError = err.message;
    pushBackendLog(`spawn error: ${err.message}`);
    console.error('Failed to start Python server:', err.message);
  });

  serverProcess.on('close', (code, signal) => {
    if (code && code !== 0) {
      backendLastError = `backend exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`;
      console.error(`[server] exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`);
    }
    serverProcess = null;
  });
}

function isPortOpen(port, host = '127.0.0.1', timeout = 700) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
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
    title: 'NeuRail',
    icon: resourcePath(app, 'assets', 'logo.png'),
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

  // Multiple BrowserViews/tabs can register lifecycle listeners on the window.
  mainWindow.setMaxListeners(50);

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

function getNavigationState(webContents) {
  const history = webContents && webContents.navigationHistory;
  const canGoBack = history && typeof history.canGoBack === 'function'
    ? history.canGoBack()
    : webContents.canGoBack();
  const canGoForward = history && typeof history.canGoForward === 'function'
    ? history.canGoForward()
    : webContents.canGoForward();
  return { canGoBack, canGoForward };
}

function detachAllBrowserViews() {
  if (!mainWindow) return;
  for (const view of browserViews.values()) {
    try {
      mainWindow.removeBrowserView(view);
    } catch {}
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
  view.webContents.on('did-stop-loading', async () => {
    const nav = getNavigationState(view.webContents);
    const url = view.webContents.getURL();
    emitBrowserTabUpdate(tabId, {
      loading: false,
      url,
      title: view.webContents.getTitle(),
      canGoBack: nav.canGoBack,
      canGoForward: nav.canGoForward,
    });

    // Check for saved credentials and login form, then auto-fill if possible
    try {
      const origin = normalizeCredentialOrigin(url);
      if (!origin) return;
      const vault = readVaultRaw(app);
      const found = vault.entries.find((e) => e.origin === origin) || null;

      const hasLoginForm = await view.webContents
        .executeJavaScript(`(() => {
          const passInputs = Array.from(document.querySelectorAll('input[type="password"]'))
            .filter(el => {
              const s = window.getComputedStyle(el);
              const r = el.getBoundingClientRect();
              return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
            });
          // A login form has exactly one visible password field
          // (registration/change-password forms typically have 2+)
          if (passInputs.length !== 1) return false;
          const userSelectors = [
            'input[type="email"]', 'input[type="text"]',
            'input[name="username"]', 'input[name="login"]',
            'input[autocomplete="username"]'
          ];
          const hasUserField = userSelectors.some(s => {
            const el = document.querySelector(s);
            if (!el) return false;
            const st = window.getComputedStyle(el);
            return st.display !== 'none' && st.visibility !== 'hidden';
          });
          return hasUserField || passInputs.length === 1;
        })()`, true)
        .catch(() => false);

      emitBrowserTabUpdate(tabId, {
        hasCredentials: !!found,
        credentialId: found ? found.id : null,
        hasLoginForm: !!hasLoginForm,
      });

      // Auto-fill when credentials are saved and a login form is present
      if (found && hasLoginForm) {
        try {
          const username = decryptVaultSecretMain(found.usernameEnc);
          const password = decryptVaultSecretMain(found.passwordEnc);
          if (username && password) {
            await view.webContents.executeJavaScript(autofillLoginFormScript(username, password), true);
          }
        } catch {}
      }
    } catch {}
  });
  view.webContents.on('did-navigate', (_event, url) => {
    const nav = getNavigationState(view.webContents);
    emitBrowserTabUpdate(tabId, {
      url,
      title: view.webContents.getTitle(),
      canGoBack: nav.canGoBack,
      canGoForward: nav.canGoForward,
    });
  });
  view.webContents.on('did-navigate-in-page', (_event, url) => {
    const nav = getNavigationState(view.webContents);
    emitBrowserTabUpdate(tabId, {
      url,
      title: view.webContents.getTitle(),
      canGoBack: nav.canGoBack,
      canGoForward: nav.canGoForward,
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
    try {
      mainWindow.addBrowserView(view);
    } catch {}
    applyBrowserViewLayout();
  }

  const nav = getNavigationState(view.webContents);
  emitBrowserTabUpdate(tabId, {
    url: view.webContents.getURL(),
    title: view.webContents.getTitle(),
    loading: view.webContents.isLoading(),
    canGoBack: nav.canGoBack,
    canGoForward: nav.canGoForward,
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

  try {
    if (mainWindow) mainWindow.removeBrowserView(view);
  } catch {}
  browserViews.delete(tabId);
  try {
    if (!view.webContents.isDestroyed()) view.webContents.destroy();
  } catch {}

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
  const history = view.webContents.navigationHistory;
  if (history && typeof history.canGoBack === 'function' && history.canGoBack()) {
    history.goBack();
  }
  return { ok: true };
});

ipcMain.handle('browser:goForward', async (_event, tabIdRaw) => {
  const view = browserViews.get(String(tabIdRaw || '').trim());
  if (!view) return { ok: false, error: 'onglet introuvable' };
  const history = view.webContents.navigationHistory;
  if (history && typeof history.canGoForward === 'function' && history.canGoForward()) {
    history.goForward();
  }
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
    try {
      mainWindow.addBrowserView(browserViews.get(activeBrowserTabId));
    } catch {}
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

registerPasswordVaultIpcHandlers({
  ipcMain,
  browserViews,
  app,
  safeStorage,
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
  const baseDir = resourceDir(app);
  const safePath = path.resolve(baseDir, path.basename(relativePath));
  if (!safePath.startsWith(baseDir)) return null;
  try {
    return fs.readFileSync(safePath, 'utf-8');
  } catch {
    return null;
  }
});

ipcMain.handle('fs:writeFile', async (_event, relativePath, content) => {
  const baseDir = resourceDir(app);
  const safePath = path.resolve(baseDir, path.basename(relativePath));
  if (!safePath.startsWith(baseDir)) return false;
  try {
    fs.writeFileSync(safePath, content, 'utf-8');
    return true;
  } catch {
    return false;
  }
});

registerVaultGraphIpcHandlers({ ipcMain, shell });

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
   Neo4j Auto-Start
   ═══════════════════════════════════════════════════════ */

/**
 * Read Neo4j Docker config from runtime_config.json (shared with the Settings panel).
 * Falls back to sensible defaults if the file doesn't exist yet.
 */
function readNeo4jDockerConfig() {
  // Fixed Neo4j Docker config — not user-editable.
  return { container_name: 'neurail-neo4j', image: 'neo4j:latest', volume: 'neurail-neo4j-data', bolt_port: 7687, http_port: 7474 };
}

/**
 * Read NEO4J_PASSWORD from .env files (app data dir first, then project root).
 */
function readNeo4jPassword() {
  const appDataDir = path.join(process.env.HOME || os.homedir(), '.local', 'share', 'isenapp');
  const candidates = [
    path.join(appDataDir, '.env'),
    path.join(path.dirname(path.dirname(__dirname)), '.env'),
  ];
  for (const envPath of candidates) {
    try {
      if (!fs.existsSync(envPath)) continue;
      const content = fs.readFileSync(envPath, 'utf-8');
      const match = content.match(/^NEO4J_PASSWORD=(.+)$/m);
      if (match && match[1].trim()) return match[1].trim();
    } catch { /* skip */ }
  }
  return '';
}

function startNeo4j() {
  return new Promise(async (resolve) => {
    const cfg = readNeo4jDockerConfig();
    const containerName = cfg.container_name; // always 'neurail-neo4j'
    const boltPort = cfg.bolt_port;
    const httpPort = cfg.http_port;

    // If Neo4j is already reachable, skip
    if (await isPortOpen(boltPort, '127.0.0.1', 500)) {
      console.log(`[neo4j] already running on port ${boltPort}`);
      resolve(true);
      return;
    }

    // Check if Docker is available
    try {
      execSync('docker info', { timeout: 8000, stdio: 'ignore' });
    } catch {
      console.warn('[neo4j] Docker not available — Neo4j must be started manually');
      resolve(false);
      return;
    }

    // Try to start the named container (covers both running & stopped states).
    try {
      execSync(`docker start ${containerName}`, { timeout: 10000, stdio: 'ignore' });
      console.log(`[neo4j] Existing container started (${containerName})`);
    } catch {
      // Container doesn’t exist yet — create it.
      const neo4jPassword = readNeo4jPassword() || 'changeme';
      console.log('[neo4j] Creating detached Neo4j container...');
      try {
        execSync(
          [
            'docker run -d',
            `--name ${containerName}`,
            `-p ${httpPort}:7474`,
            `-p ${boltPort}:7687`,
            `-e NEO4J_AUTH=neo4j/${neo4jPassword}`,
            `-v ${cfg.volume}:/data`,
            cfg.image,
          ].join(' '),
          { timeout: 30000, stdio: 'ignore' },
        );
        console.log(`[neo4j] New detached container created (${containerName})`);
      } catch (createErr) {
        console.error('[neo4j] Failed to create container:', createErr.message);
        resolve(false);
        return;
      }
    }

    // Wait up to 30s for Neo4j to become reachable.
    const start = Date.now();
    const waitLoop = async () => {
      if (await isPortOpen(boltPort, '127.0.0.1', 500)) {
        console.log(`[neo4j] Ready on port ${boltPort}`);
        resolve(true);
        return;
      }
      if (Date.now() - start > 30000) {
        console.error('[neo4j] Timeout waiting for Neo4j to start');
        resolve(false);
        return;
      }
      setTimeout(waitLoop, 800);
    };
    setTimeout(waitLoop, 2000); // Give Docker a head start
  });
}

/* ═══════════════════════════════════════════════════════
   App Lifecycle
   ═══════════════════════════════════════════════════════ */
app.whenReady().then(async () => {
  protocol.handle('vault-file', handleVaultFileRequest);

  // Start Neo4j in background (non-blocking for app startup)
  const neo4jReady = startNeo4j();

  const backendAlreadyRunning = await isPortOpen(PORT);
  if (backendAlreadyRunning) {
    console.log(`[server] backend already running on port ${PORT}, reusing it`);
  } else {
    startPythonServer();
  }

  try {
    await waitForServer(PORT);
  } catch (e) {
    backendLastError = backendLastError || e.message;
    console.error(e.message);
    dialog.showErrorBox('NeuRail - Erreur de démarrage', buildBackendFailureMessage());
    app.quit();
    return;
  }

  // Log Neo4j status (don't block app launch)
  neo4jReady.then(ok => {
    if (!ok) console.warn('[neo4j] Neo4j not available — chatbot features will be disabled');
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
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
