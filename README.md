# ISENAPP

Client email desktop multi-plateforme (Electron) avec gestion de tâches, relances automatiques par IA, visualisation de coffre Obsidian et export Markdown.

---

## Table des matières

- [ISENAPP](#isenapp)
  - [Table des matières](#table-des-matières)
  - [Fonctionnalités](#fonctionnalités)
    - [📬 Client email complet](#-client-email-complet)
    - [✅ Gestion de tâches](#-gestion-de-tâches)
    - [📨 Workflow tâche → email → relance](#-workflow-tâche--email--relance)
    - [🤖 Intelligence artificielle (Gemini)](#-intelligence-artificielle-gemini)
    - [🔗 Intégration Obsidian](#-intégration-obsidian)
    - [🎨 Interface](#-interface)
  - [Prérequis](#prérequis)
  - [Installation des dépendances](#installation-des-dépendances)
    - [Node.js](#nodejs)
    - [Python](#python)
  - [Lancement en développement](#lancement-en-développement)
  - [Compilation](#compilation)
    - [Linux (AppImage + .deb)](#linux-appimage--deb)
    - [macOS (DMG + ZIP)](#macos-dmg--zip)
    - [Windows (NSIS installer + Portable)](#windows-nsis-installer--portable)
    - [Toutes les plateformes](#toutes-les-plateformes)
    - [Dossier décompressé uniquement (debug)](#dossier-décompressé-uniquement-debug)
  - [Installation des binaires](#installation-des-binaires)
    - [Linux — AppImage](#linux--appimage)
    - [Linux — .deb](#linux--deb)
    - [macOS — DMG](#macos--dmg)
    - [Windows — Installateur](#windows--installateur)
    - [Windows — Portable](#windows--portable)
  - [Architecture du projet](#architecture-du-projet)
  - [Configuration des comptes email](#configuration-des-comptes-email)
    - [Autoconfiguration](#autoconfiguration)
    - [Exemple Gmail](#exemple-gmail)
  - [Raccourcis clavier](#raccourcis-clavier)
  - [Stockage des données](#stockage-des-données)
  - [Remarques](#remarques)

---

## Fonctionnalités

### 📬 Client email complet

- **Réception** via **POP3** et **IMAP** avec SSL/TLS
- **Envoi** via **SMTP** (STARTTLS ou SSL) avec pièces jointes
- **Autoconfiguration** des serveurs à partir de la base Mozilla Thunderbird (+ fallback par détection automatique `imap.*/smtp.*`)
- **Multi-comptes** avec sélection de l'expéditeur
- **Champs To / Cc** avec autocomplétion depuis un carnet de contacts CSV
- **Répondre**, **Répondre à tous**, **Transférer** depuis la boîte de réception
- **Pièces jointes** : ajout par clic ou glisser-déposer, sauvegardées dans le `.eml`
- **Dossiers** : Reçus / Envoyés avec bascule
- **Recherche**, filtres (Tous / Non lus / Favoris), marquage lu/non lu, étoiles
- **Suppression** locale et optionnellement sur le serveur distant

### ✅ Gestion de tâches

- **Sections** avec titre, badge, emoji, couleur et description
- **Types de tâches** : standard ou mail (workflow dédié)
- **Sous-tâches** par indentation
- **Glisser-déposer** entre sections
- **Barre de progression** globale avec animation confettis à 100 %
- **Mode édition** pour ajouter/modifier/supprimer tâches et sections

### 📨 Workflow tâche → email → relance

- Composer un mail directement depuis une tâche
- **Suivi d'état** : En attente → Envoyé → En attente de réponse → Répondu
- **Rappels automatiques** avec cycle de relances (3 jours par défaut)
- **Timeline mensuelle** interactive avec points colorés (envoyé, relance due, réponse reçue)
- **Génération IA** des relances via l'API Google Gemini

### 🤖 Intelligence artificielle (Gemini)

- **Reformulation** du corps d'un mail (correction orthographique, syntaxe, ton)
- **Génération de relances** contextuelles (sujet + corps) en fonction du cycle

### 🔗 Intégration Obsidian

- **Graphe interactif** D3.js du coffre Obsidian (notes, mails, fichiers, orphelins)
- **Lecteur intégré** : prévisualisation Markdown, images, PDF directement dans l'app
- **Export email → Obsidian** : conversion en `.md` avec frontmatter YAML, auto-tagging (domaine, période, sujet) et liens wikilinks vers les pièces jointes
- **Export en masse** de toute la boîte de réception

### 🎨 Interface

- Thème sombre (Catppuccin Mocha)
- Barre de titre personnalisée (frameless)
- 4 onglets : Todo, Inbox, Mail, Graph
- Responsive avec persistance de la taille/position de la fenêtre

---

## Prérequis

| Outil | Version minimum |
|-------|----------------|
| **Node.js** | ≥ 18 |
| **Python 3** | ≥ 3.8 |
| **pip** | (inclus avec Python) |

> **Important :** Python 3 doit être installé et accessible via `python3` sur la machine cible, même pour les binaires compilés, car le serveur backend est lancé en tant que processus enfant.

---

## Installation des dépendances

### Node.js

```bash
npm install
```

### Python

```bash
pip install -r requirements-v3.txt
```

Ou manuellement :

```bash
pip install html2text
```

---

## Lancement en développement

```bash
npm start
```

Electron démarre et lance automatiquement le serveur Python (`server.py`) sur le port `8080`.

---

## Compilation

Electron Builder permet de générer des exécutables pour **Linux**, **macOS** et **Windows** depuis le même code source.

### Linux (AppImage + .deb)

```bash
npm run build
```

### macOS (DMG + ZIP)

```bash
npm run build:mac
```

> Nécessite d'être exécuté sur macOS ou d'utiliser un CI macOS (GitHub Actions).

### Windows (NSIS installer + Portable)

```bash
npm run build:win
```

> Peut être cross-compilé depuis Linux avec `wine` installé, ou exécuté nativement sur Windows / via CI Windows.

### Toutes les plateformes

```bash
npm run build:all
```

### Dossier décompressé uniquement (debug)

```bash
npm run build:dir
```

Les fichiers générés se trouvent dans le dossier `dist/` :

| Plateforme | Fichier | Description |
|---|---|---|
| Linux | `ISENAPP-1.0.0.AppImage` | Exécutable portable, aucune installation requise |
| Linux | `isenapp_1.0.0_amd64.deb` | Paquet Debian installable |
| macOS | `ISENAPP-1.0.0.dmg` | Image disque macOS |
| macOS | `ISENAPP-1.0.0-mac.zip` | Archive ZIP macOS |
| Windows | `ISENAPP Setup 1.0.0.exe` | Installateur NSIS |
| Windows | `ISENAPP 1.0.0.exe` | Exécutable portable |

---

## Installation des binaires

### Linux — AppImage

```bash
chmod +x dist/ISENAPP-1.0.0.AppImage
./dist/ISENAPP-1.0.0.AppImage
```

> Si l'AppImage ne se lance pas, essayer avec `--no-sandbox`.

### Linux — .deb

```bash
sudo dpkg -i dist/isenapp_1.0.0_amd64.deb
isenapp
```

### macOS — DMG

Double-cliquer sur le `.dmg`, glisser ISENAPP dans le dossier Applications.

### Windows — Installateur

Exécuter `ISENAPP Setup 1.0.0.exe` et suivre l'assistant d'installation.

### Windows — Portable

Exécuter directement `ISENAPP 1.0.0.exe`, aucune installation nécessaire.

---

## Architecture du projet

```
main.js                  → Processus principal Electron (fenêtre, IPC, spawn Python)
preload.js               → Bridge IPC sécurisé (contextIsolation)
index.html               → Interface complète (CSS + HTML + JS inline)
server.py                → Serveur HTTP Python — API REST complète :
                             • CRUD tâches/sections
                             • SMTP / POP3 / IMAP
                             • Autoconfig email (Mozilla Thunderbird DB)
                             • Export Obsidian
                             • Scan du coffre Obsidian (graphe)
                             • IA Gemini (reformulation, relances)
                             • Gestion des contacts (CSV)
v3.py                    → Utilitaire de scan email et import vers le coffre Obsidian
data.json                → Données persistantes (tâches, sections, rappels, clé API)
accounts.json            → Comptes email configurés (créé au premier ajout)
inbox_index.json         → Index des emails téléchargés (métadonnées)
seen_uids.json           → UIDs déjà vus (dédoublonnage POP3/IMAP)
contacts_complets_v2.csv → Carnet de contacts pour l'autocomplétion
requirements-v3.txt      → Dépendances Python
logo.svg                 → Source d'icône (UI + favicon)
build/icon.png           → Icône Linux générée
build/icon.ico           → Icône Windows générée
build/icon.icns          → Icône macOS générée
package.json             → Configuration npm + electron-builder
```

---

## Configuration des comptes email

1. Ouvrir le modal **Comptes** (icône utilisateur dans l'onglet Inbox ou Mail)
2. Cliquer **+ Ajouter un compte**
3. Saisir l'adresse email puis cliquer **⚡ Autoconfig** pour remplir automatiquement les serveurs IMAP/SMTP
4. Compléter le mot de passe (pour Gmail : utiliser un **mot de passe d'application**, pas le mot de passe principal)
5. Cliquer **Enregistrer**

### Autoconfiguration

L'autoconfig interroge d'abord la base publique Mozilla :
```
https://autoconfig.thunderbird.net/v1.1/{domaine}
```
Si le domaine n'est pas trouvé, un fallback teste les hostnames courants (`imap.{domaine}`, `smtp.{domaine}`, `mail.{domaine}`) sur les ports standard avec détection SSL/STARTTLS automatique.

### Exemple Gmail

| Paramètre | Valeur |
|---|---|
| Protocole | IMAP |
| Serveur IMAP | `imap.gmail.com` : 993 (SSL) |
| Serveur SMTP | `smtp.gmail.com` : 587 (STARTTLS) |
| Identifiant | `votre.adresse@gmail.com` |
| Mot de passe | Mot de passe d'application Google |

---

## Raccourcis clavier

| Raccourci | Action |
|---|---|
| `Ctrl+E` / `Cmd+E` | Basculer le mode édition |
| `Ctrl+1` / `Cmd+1` | Onglet Todo |
| `Ctrl+2` / `Cmd+2` | Onglet Inbox |
| `Ctrl+3` / `Cmd+3` | Onglet Mail |
| `Ctrl+4` / `Cmd+4` | Onglet Graph |
| `Ctrl+N` / `Cmd+N` | Nouvelle section (en mode édition) |
| `Esc` | Fermer le modal actif |
| `Suppr` | Supprimer le mail sélectionné dans l'inbox |

---

## Stockage des données

| Fichier | Contenu |
|---|---|
| `data.json` | Tâches, sections, rappels, événements mail, clé API Gemini |
| `accounts.json` | Comptes email (serveurs, identifiants) |
| `inbox_index.json` | Métadonnées de chaque email (sujet, expéditeur, date, état lu/étoile) |
| `seen_uids.json` | UIDs déjà importés pour éviter les doublons |
| `~/mails/*.eml` | Emails bruts (reçus et envoyés) au format `.eml` |

---

## Remarques

- **Python 3 requis** sur la machine cible (y compris pour les binaires compilés), car le serveur backend est un processus enfant Python.
- Le serveur écoute sur `localhost:8080`. Vérifier que ce port est libre.
- Les données sont stockées à côté du serveur (dans `resources/` en mode packagé).
- Pour la **compilation cross-platform** :
  - Les builds macOS nécessitent un environnement macOS (ou un CI comme GitHub Actions).
  - Les builds Windows peuvent être réalisés depuis Linux avec `wine`, ou depuis un CI Windows.
  - Les builds Linux fonctionnent nativement sur Linux.
- L'intégration Obsidian utilise les chemins configurés dans `server.py` (`OBSIDIAN_MD_DIR`, `OBSIDIAN_ATT_DIR`).
