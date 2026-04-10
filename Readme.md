<div align="center">

# NeuRail

Client de bureau Electron et Python pour centraliser la gestion des tâches, des emails, des rappels, de l'archivage et des recherches complexes dans une interface unique.

[![Version](https://img.shields.io/badge/version-1.0.0-blue?style=flat-square)](package.json)
[![Electron](https://img.shields.io/badge/Electron-33-47848f?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Licence](https://img.shields.io/badge/licence-MIT-green?style=flat-square)](LICENSE)
[![Build](https://img.shields.io/badge/build-electron--builder-orange?style=flat-square)](https://www.electron.build/)

</div>

---

## Table des matières

- [NeuRail](#neurail)
  - [Table des matières](#table-des-matières)
  - [Fonctionnalités](#fonctionnalités)
  - [Installation (Développement)](#installation-développement)
    - [Prérequis par système d'exploitation](#prérequis-par-système-dexploitation)
      - [Debian / Ubuntu](#debian--ubuntu)
      - [Arch Linux](#arch-linux)
      - [macOS](#macos)
      - [Windows](#windows)
    - [Mise en place](#mise-en-place)
  - [Build \& Distribution](#build--distribution)
  - [Variables d'environnement](#variables-denvironnement)
  - [Licence](#licence)

---

## Fonctionnalités

NeuRail est conçu comme un poste de travail unifié :

- L'objectif 1 est de connecter une todo list à un maileur pour gérer les relances de mail.
  
- L'objectif 2 est d'implémenter des outils d'IA génératif directement dans le maileur.

- L'objectif 3 est de créer un outil de type GraphRAG pour la recherche des archives du maileur

---

## Installation (Développement)

### Prérequis par système d'exploitation

#### Debian / Ubuntu

```bash
sudo apt update
sudo apt install nodejs npm python3 python3-venv python3-pip
```

#### Arch Linux

```bash
sudo pacman -S nodejs npm python python-pip
```

#### macOS

```bash
brew install node python
```

> Si Homebrew n'est pas installé : [https://brew.sh](https://brew.sh)

#### Windows

1. Télécharger et installer **Node.js** (>= 18 LTS) : [https://nodejs.org](https://nodejs.org)
2. Télécharger et installer **Python** (>= 3.8) : [https://www.python.org/downloads](https://www.python.org/downloads)
   - Cocher **"Add Python to PATH"** lors de l'installation.

---

### Mise en place

```bash
# 1. Cloner le dépôt
git clone https://github.com/naikenisen/NeuRail.git
cd NeuRail

# 2. Installer les dépendances Node.js
npm install

# 3. Créer un environnement virtuel Python et installer les dépendances
python3 -m venv venv
source venv/bin/activate        # Linux / macOS
# .\venv\Scripts\activate       # Windows (PowerShell)
pip install -r requirements.txt

# 4. Lancer l'application en mode développement
npm start
```

> **Note :** Le serveur Python backend (`server.py`) est automatiquement démarré par le processus principal d'Electron au lancement. Assurez-vous que le port **8080** est disponible.

---

## Build & Distribution

NeuRail utilise [electron-builder](https://www.electron.build/) pour le packaging. Les artefacts sont générés dans le dossier `dist/`.

```bash
# Linux (Debian, Ubuntu, Arch, …) — AppImage + .deb
npm run build

# macOS — .dmg + .zip
npm run build:mac

# Windows — installeur NSIS + portable
npm run build:win

# Toutes les plateformes simultanément
npm run build:all
```

| Plateforme | Formats générés |
|---|---|
| Linux | AppImage (universel), `.deb` |
| macOS | `.dmg`, `.zip` |
| Windows | NSIS installer, Portable |

> **Note Linux :** L'AppImage fonctionne sur toutes les distributions (Debian, Arch, Fedora, …). Le paquet `.deb` est destiné aux distributions basées sur Debian/Ubuntu.

---

## Variables d'environnement

Copiez `.env.example` en `.env` à la racine du projet et renseignez les valeurs selon votre configuration :

```bash
cp .env.example .env   # Linux / macOS
# copy .env.example .env  # Windows (cmd)
```

| Variable | Description | Requis |
|---|---|---|
| `NEO4J_URI` | URI de connexion Neo4j (ex. `bolt://localhost:7687`) | Oui |
| `NEO4J_USER` | Nom d'utilisateur Neo4j | Oui |
| `NEO4J_PASSWORD` | Mot de passe Neo4j | Oui |
| `GEMINI_API_KEY` | Clé API Google Gemini pour les fonctionnalités IA | Oui |
| `GEMINI_MODEL` | Modèle Gemini principal | Non |
| `GEMINI_FALLBACK_MODELS` | Modèles de secours Gemini (séparés par des virgules) | Non |
| `EMBEDDING_MODEL` | Modèle d'embedding | Non |

---

## Licence

Ce projet est sous licence **MIT**. Voir le fichier [LICENSE](LICENSE) pour plus de détails.

---

<div align="center">

par [Isen Naiken](https://github.com/naikenisen)

</div>
