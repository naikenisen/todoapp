<div align="center">

# 🚀 ISENAPP

**Client de bureau tout-en-un : email, gestion de tâches, navigateur intégré et visualisation graph.**

[![Version](https://img.shields.io/badge/version-1.0.0-blue?style=flat-square)](package.json)
[![Electron](https://img.shields.io/badge/Electron-33-47848f?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Licence](https://img.shields.io/badge/licence-MIT-green?style=flat-square)](LICENSE)
[![Build](https://img.shields.io/badge/build-electron--builder-orange?style=flat-square)](https://www.electron.build/)

<!-- Remplacer par une capture d'écran réelle de l'application -->
> 📸 **Capture d'écran** : _Placez ici une image de l'interface (ex. `assets/screenshot.png`)_
>
> `![ISENAPP Screenshot](assets/screenshot.png)`

</div>

---

## 📋 Table des matières

- [🚀 ISENAPP](#-isenapp)
  - [📋 Table des matières](#-table-des-matières)
  - [✨ Fonctionnalités](#-fonctionnalités)
  - [🏗 Architecture \& Sécurité](#-architecture--sécurité)
    - [🔒 Mesures de sécurité](#-mesures-de-sécurité)
  - [💻 Installation (Développement)](#-installation-développement)
    - [Prérequis](#prérequis)
    - [Mise en place](#mise-en-place)
  - [🔧 Variables d'environnement](#-variables-denvironnement)
  - [📦 Build \& Distribution](#-build--distribution)
    - [Générer les icônes (optionnel, nécessite `rsvg-convert`)](#générer-les-icônes-optionnel-nécessite-rsvg-convert)
    - [Packager par OS](#packager-par-os)
  - [📁 Structure du projet](#-structure-du-projet)
  - [📡 Communication IPC](#-communication-ipc)
    - [1. Preload — Exposition de l'API sécurisée](#1-preload--exposition-de-lapi-sécurisée)
    - [2. Main — Gestion des événements IPC](#2-main--gestion-des-événements-ipc)
    - [3. Renderer — Utilisation côté interface](#3-renderer--utilisation-côté-interface)
    - [Flux résumé](#flux-résumé)
  - [🤝 Contribution](#-contribution)
    - [Conventions](#conventions)
  - [📄 Licence](#-licence)

---

## ✨ Fonctionnalités

| Domaine | Détails |
|---|---|
| **📧 Client Email** | Réception (IMAP/POP3), envoi (SMTP), autoconfig par domaine, support multi-comptes |
| **✅ Gestion de tâches** | Sections personnalisées, menu contextuel natif (compléter/supprimer), persistance JSON |
| **🌐 Navigateur intégré** | Onglets natifs via `BrowserView`, sessions persistantes par site, popups OAuth |
| **🔐 Coffre-fort de mots de passe** | Chiffrement au repos via `safeStorage` (keyring OS), CRUD complet, autofill sur formulaires |
| **🗂 Visualisation graph** | Scan du graphe de vault, lecture de fichiers Markdown, protocole sécurisé `vault-file://` |
| **🤖 Assistance IA** | Intégration Google Gemini API pour la génération et reformulation de contenu |
| **👥 Contacts** | Import CSV, autocomplétion dans le compositeur d'emails |
| **🎨 Thèmes** | Dark mode (Catppuccin) & Light mode, bascule instantanée |
| **🖥 Expérience desktop** | Barre de titre personnalisée (frameless), raccourcis clavier globaux, zoom, persistance de l'état de fenêtre |
| **💾 Hors-ligne** | Tâches et données locales accessibles sans connexion internet |

---

## 🏗 Architecture & Sécurité

ISENAPP suit l'architecture multi-processus recommandée par Electron :

```
┌─────────────────────────────────────────────────────┐
│                   Main Process                       │
│  (src/main/main.js)                                  │
│  • Cycle de vie de l'app & fenêtres                  │
│  • Handlers IPC (ipcMain)                            │
│  • Spawn du serveur Python backend                   │
│  • Coffre-fort chiffré (safeStorage)                 │
│  • Protocole vault-file:// sécurisé                  │
├────────────────────┬────────────────────────────────┤
│   Preload Script   │       Renderer Process          │
│  (preload.js)      │  (src/renderer/index.html)      │
│  • contextBridge   │  • Interface utilisateur         │
│  • API exposée     │  • Appels via window.electronAPI │
│    sécurisée       │  • Aucun accès Node.js direct    │
└────────────────────┴────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│              Python Backend (port 8080)               │
│  (src/backend/server.py)                              │
│  • API HTTP locale pour emails, tâches, contacts      │
│  • Écriture atomique JSON avec backups                │
│  • Stockage des données dans ~/.local/share/isenapp   │
└─────────────────────────────────────────────────────┘
```

### 🔒 Mesures de sécurité

Le processus Renderer est entièrement isolé grâce à la configuration suivante dans `BrowserWindow` :

```js
webPreferences: {
  nodeIntegration: false,        // Aucun accès à Node.js depuis le renderer
  contextIsolation: true,        // Isolation complète du contexte JavaScript
  sandbox: true,                 // Sandbox OS activé
  webSecurity: true,             // Politique same-origin appliquée
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  preload: path.join(__dirname, 'preload.js'),
}
```

- **`contextIsolation: true`** — Le renderer ne peut jamais accéder aux APIs Node.js ni modifier le script preload.
- **`sandbox: true`** — Le processus renderer tourne dans un bac à sable au niveau de l'OS.
- **Preload script** — Seule passerelle entre Main et Renderer via `contextBridge.exposeInMainWorld()`.
- **Protocole `vault-file://`** — Sert les fichiers du vault graph sans exposer le système de fichiers.
- **Chiffrement `safeStorage`** — Les mots de passe sont chiffrés via le keyring natif de l'OS.

---

## 💻 Installation (Développement)

### Prérequis

| Outil | Version requise |
|---|---|
| **Node.js** | `>= 18 LTS` |
| **npm** | `>= 9` |
| **Python** | `>= 3.8` |
| **Git** | dernière version stable |

### Mise en place

```bash
# 1. Cloner le dépôt
git clone https://github.com/naikenisen/ISENAPP.git
cd ISENAPP

# 2. Installer les dépendances Node.js
npm install

# 3. Créer un environnement virtuel Python et installer les dépendances
python3 -m venv venv
source venv/bin/activate        # Linux/macOS
# .\venv\Scripts\activate       # Windows (PowerShell)
pip install -r requirements.txt

# 4. Lancer l'application en mode développement
npm start
```

> **Note :** Le serveur Python backend (`server.py`) est automatiquement démarré par le processus Main d'Electron au lancement. Assurez-vous que le port **8080** est disponible.

---

## 🔧 Variables d'environnement

L'application utilise des variables d'environnement optionnelles pour personnaliser le stockage des données :

```bash
# .env.example

# Répertoire de stockage des données runtime (comptes, tâches, emails indexés).
# Par défaut : ~/.local/share/isenapp (ou $XDG_DATA_HOME/isenapp)
ISENAPP_DATA_DIR=

# Clé API Google Gemini pour les fonctionnalités d'assistance IA
# (configurée dans l'interface de l'application)
```

---

## 📦 Build & Distribution

ISENAPP utilise [electron-builder](https://www.electron.build/) pour le packaging.

### Générer les icônes (optionnel, nécessite `rsvg-convert`)

```bash
npm run icons:generate
```

### Packager par OS

```bash
# Linux (AppImage + .deb)
npm run build

# macOS (DMG + ZIP)
npm run build:mac

# Windows (NSIS installer + portable)
npm run build:win

# Toutes les plateformes
npm run build:all
```

Les artefacts sont générés dans le dossier `dist/`.

| Plateforme | Formats | Catégorie |
|---|---|---|
| 🐧 Linux | AppImage, `.deb` | Office |
| 🍎 macOS | `.dmg`, `.zip` | Productivity |
| 🪟 Windows | NSIS installer, Portable | — |

---

## 📁 Structure du projet

```
ISENAPP/
├── assets/                  # Ressources statiques (logo SVG, icônes)
├── build/                   # Icônes générées (icon.png, icon.icns, icon.ico)
├── data/                    # Données par défaut embarquées (bootstrap)
│   ├── data.json            #   État initial de l'application
│   └── contacts_*.csv       #   Carnet de contacts par défaut
├── dist/                    # Artefacts de build (généré)
├── src/
│   ├── main/
│   │   ├── main.js          # ⚡ Processus principal Electron
│   │   └── preload.js       # 🔒 Script preload (contextBridge)
│   ├── renderer/
│   │   ├── index.html       # 🖼 Interface utilisateur complète
│   │   ├── styles.css       # 🎨 Feuille de styles
│   │   └── renderer.js      #    Point d'entrée renderer
│   └── backend/
│       ├── server.py        # 🐍 Serveur HTTP Python (API locale)
│       └── v3.py            #    Module complémentaire backend
├── package.json             # Configuration npm & electron-builder
├── requirements.txt         # Dépendances Python
└── README.md                # Ce fichier
```

---

## 📡 Communication IPC

Toute communication entre le Renderer et le Main process transite par le **preload script** via `contextBridge`, garantissant une isolation complète.

### 1. Preload — Exposition de l'API sécurisée

```js
// src/main/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Contrôles fenêtre
  minimize:    () => ipcRenderer.send('window:minimize'),
  maximize:    () => ipcRenderer.send('window:maximize'),
  close:       () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),

  // Fichiers
  readFile:  (path)          => ipcRenderer.invoke('fs:readFile', path),
  writeFile: (path, content) => ipcRenderer.invoke('fs:writeFile', path, content),

  // Coffre-fort mots de passe
  passwordVaultList:   () => ipcRenderer.invoke('passwordVault:list'),
  passwordVaultUpsert: (payload) => ipcRenderer.invoke('passwordVault:upsert', payload),
  // ... autres canaux
});
```

### 2. Main — Gestion des événements IPC

```js
// src/main/main.js
const { ipcMain } = require('electron');

// Événement unidirectionnel (send → on)
ipcMain.on('window:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

// Événement bidirectionnel (invoke → handle)
ipcMain.handle('window:isMaximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});
```

### 3. Renderer — Utilisation côté interface

```js
// Dans le code du renderer (index.html)
// Appel simple (fire-and-forget)
window.electronAPI.minimize();

// Appel avec réponse (async)
const isMax = await window.electronAPI.isMaximized();
```

### Flux résumé

```
Renderer                    Preload                      Main
   │                           │                           │
   │  electronAPI.minimize()   │                           │
   │ ─────────────────────────►│  ipcRenderer.send(...)    │
   │                           │ ─────────────────────────►│
   │                           │                           │  mainWindow.minimize()
   │                           │                           │
   │  await electronAPI        │                           │
   │    .isMaximized()         │  ipcRenderer.invoke(...)  │
   │ ─────────────────────────►│ ─────────────────────────►│
   │                           │◄─────────────────────────│  return true/false
   │◄─────────────────────────│                           │
```

---

## 🤝 Contribution

Les contributions sont les bienvenues ! Merci de suivre ces étapes :

1. **Forkez** le dépôt
2. Créez une branche pour votre fonctionnalité (`git checkout -b feat/ma-fonctionnalite`)
3. Committez vos changements (`git commit -m "feat: description"`)
4. Poussez vers la branche (`git push origin feat/ma-fonctionnalite`)
5. Ouvrez une **Pull Request**

### Conventions

- Commits : suivez la convention [Conventional Commits](https://www.conventionalcommits.org/)
- Code JavaScript : pas de TypeScript — vanilla JS, `const`/`let`, template literals
- Sécurité : toute nouvelle API IPC doit passer par le preload avec des canaux explicitement validés

---

## 📄 Licence

Ce projet est sous licence **MIT**. Voir le fichier [LICENSE](LICENSE) pour plus de détails.

---

<div align="center">

par [Isen Naiken](https://github.com/naikenisen) 

</div>
