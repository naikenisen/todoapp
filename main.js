const { app, BrowserWindow, ipcMain, dialog, Menu, globalShortcut, shell, protocol } = require('electron');
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

/* ═══════════════════════════════════════════════════════
   Path Helpers (handles packaged vs dev mode)
   ═══════════════════════════════════════════════════════ */
function resourcePath(filename) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, filename);
  }
  return path.join(__dirname, filename);
}

function resourceDir() {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return __dirname;
}

/* ═══════════════════════════════════════════════════════
   Python Server
   ═══════════════════════════════════════════════════════ */
function startPythonServer() {
  const serverPath = resourcePath('server.py');
  serverProcess = spawn('python3', [serverPath], {
    cwd: resourceDir(),
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
    icon: resourcePath('logo.svg'),
    frame: false,
    transparent: false,
    backgroundColor: '#1e1e2e',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
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
    mainWindow = null;
  });
}

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
