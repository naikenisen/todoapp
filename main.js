const { app, BrowserWindow, ipcMain, dialog, Menu, globalShortcut } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const fs = require('fs');
const windowStateKeeper = require('electron-window-state');

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
    title: 'NexoMail',
    icon: path.join(__dirname, 'icon.png'),
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
