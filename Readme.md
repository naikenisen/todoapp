<div align="center">

# NeuRail

Client de bureau Electron et Python pour centraliser la gestion des tâches, des emails, des rappels, des leads et de l'agenda dans une interface unique.

[![Version](https://img.shields.io/badge/version-1.0.0-blue?style=flat-square)](package.json)
[![Electron](https://img.shields.io/badge/Electron-33-47848f?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Licence](https://img.shields.io/badge/licence-MIT-green?style=flat-square)](LICENSE)
[![Build](https://img.shields.io/badge/build-electron--builder-orange?style=flat-square)](https://www.electron.build/)

</div>

---

## Table des matières

- [NeuRail](#neurail)
  - [Fonctionnalités](#fonctionnalités)
  - [Installation (Développement)](#installation-développement)
    - [Prérequis par système d'exploitation](#prérequis-par-système-dexploitation)
    - [Mise en place](#mise-en-place)
  - [Build & Distribution](#build--distribution)
  - [Variables d'environnement](#variables-denvironnement)
  - [Licence](#licence)

---

## Fonctionnalités

NeuRail est conçu comme un poste de travail unifié pour les équipes qui gèrent à la fois leurs échanges email, leurs relances, leur organisation quotidienne et leur suivi commercial.

- Gestion des tâches dans une interface intégrée au reste du flux de travail.
- Messagerie multi-comptes avec consultation de la boîte de réception, rédaction, réponse et envoi depuis l'application.
- Configuration email facilitée grâce à l'auto-détection IMAP/SMTP et à la gestion centralisée des comptes.
- Suivi des échanges sortants avec rappels pour relancer un destinataire lorsqu'une réponse est attendue.
- Assistance IA pour reformuler un message, corriger la rédaction et générer des réponses à partir d'un contexte ou d'un prompt.
- Sauvegarde des emails au format `.eml` et archivage en Markdown pour faciliter l'indexation, l'analyse et l'exploitation par des outils IA.
- Visualisation des archives et des connaissances associées sous forme de graphe.
- Intégration de Google Agenda pour consulter les calendriers et piloter les événements depuis l'application.
- Gestion des leads, des projets et de l'organisation d'équipe dans le même environnement de travail.

L'objectif est de réduire les changements d'outils en regroupant dans un seul client les opérations de communication, de suivi et d'organisation.

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
# Debian / Ubuntu — AppImage + .deb
npm run build

# Arch Linux — AppImage + .deb
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
| Linux (Debian, Arch, …) | AppImage, `.deb` |
| macOS | `.dmg`, `.zip` |
| Windows | NSIS installer, Portable |

---

## Variables d'environnement

Copiez `.env.example` en `.env` à la racine du projet et renseignez les valeurs selon votre configuration :

```bash
cp .env.example .env   # Linux / macOS
# copy .env.example .env  # Windows (cmd)
```

| Variable | Description |
|---|---|
| `NEO4J_URI` | URI de connexion Neo4j (ex. `bolt://localhost:7687`) |
| `NEO4J_USER` | Nom d'utilisateur Neo4j |
| `NEO4J_PASSWORD` | Mot de passe Neo4j |
| `GEMINI_API_KEY` | Clé API Google Gemini pour les fonctionnalités IA |
| `GEMINI_MODEL` | Modèle Gemini principal (optionnel) |
| `GEMINI_FALLBACK_MODELS` | Modèles de secours Gemini (optionnel, séparés par des virgules) |
| `EMBEDDING_MODEL` | Modèle d'embedding (optionnel) |

---

## Licence

Ce projet est sous licence **MIT**. Voir le fichier [LICENSE](LICENSE) pour plus de détails.

---

<div align="center">

par [Isen Naiken](https://github.com/naikenisen)

</div>
