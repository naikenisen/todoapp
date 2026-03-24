const fs = require('fs');
const os = require('os');
const path = require('path');

const VAULT_PATH = path.join(os.homedir(), 'Documents', 'isenapp_mails');
const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g;
const ATTACHMENT_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.pdf', '.docx', '.xlsx', '.pptx', '.odt', '.csv', '.zip']);

function sanitizeVaultRelativePath(relpath) {
  return path.normalize(String(relpath || '')).replace(/^(\.\.[/\\])+/, '');
}

function safeVaultFullPath(relpath) {
  const safe = sanitizeVaultRelativePath(relpath);
  const fullPath = path.join(VAULT_PATH, safe);
  if (!fullPath.startsWith(VAULT_PATH)) return null;
  return { safe, fullPath };
}

function scanVaultGraph() {
  const nodes = {};
  const edges = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === '.obsidian' || entry.name === '.trash') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

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

function handleVaultFileRequest(request) {
  const url = new URL(request.url);
  const relpath = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const safePath = safeVaultFullPath(relpath);
  if (!safePath) {
    return new Response('Forbidden', { status: 403 });
  }

  const ext = path.extname(safePath.fullPath).toLowerCase();
  const mimeMap = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.pdf': 'application/pdf',
  };
  const mime = mimeMap[ext] || 'application/octet-stream';

  try {
    const data = fs.readFileSync(safePath.fullPath);
    return new Response(data, { headers: { 'Content-Type': mime } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

function registerVaultGraphIpcHandlers({ ipcMain, shell }) {
  ipcMain.handle('vault:scanGraph', async () => {
    try {
      return scanVaultGraph();
    } catch (err) {
      return { nodes: [], edges: [], error: err.message };
    }
  });

  ipcMain.handle('vault:readFile', async (_event, relpath) => {
    const safePath = safeVaultFullPath(relpath);
    if (!safePath) return { ok: false, error: 'Path outside vault' };
    try {
      const content = fs.readFileSync(safePath.fullPath, 'utf-8');
      return { ok: true, content };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('vault:getFileUrl', async (_event, relpath) => {
    const safePath = safeVaultFullPath(relpath);
    if (!safePath) return { ok: false, error: 'Path outside vault' };
    try {
      fs.accessSync(safePath.fullPath, fs.constants.R_OK);
      return { ok: true, url: 'vault-file://load/' + encodeURIComponent(safePath.safe) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('vault:openExternal', async (_event, relpath) => {
    const safePath = safeVaultFullPath(relpath);
    if (!safePath) return { ok: false, error: 'Path outside vault' };
    try {
      await shell.openPath(safePath.fullPath);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

module.exports = {
  VAULT_PATH,
  handleVaultFileRequest,
  registerVaultGraphIpcHandlers,
};
