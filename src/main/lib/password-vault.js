const fs = require('fs');
const path = require('path');

function registerPasswordVaultIpcHandlers({ ipcMain, browserViews, app, safeStorage }) {
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
}

module.exports = {
  registerPasswordVaultIpcHandlers,
};
