"""Configuration et chemins de l'application ISENAPP.

Centralise toutes les constantes de configuration : port du serveur,
chemins des fichiers de données, répertoires du graphe, scopes OAuth
Google, et bootstrap des fichiers par défaut.

Dépendances internes :
    (aucune — module racine de configuration)

Dépendances externes :
    (aucune)
"""

import os
import json
import shutil
from pathlib import Path

PORT = 8080
DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = str(Path(DIR).resolve().parents[1])
BUNDLED_DATA_DIR = os.path.join(PROJECT_ROOT, "data")
RENDERER_INDEX = os.path.join(PROJECT_ROOT, "src", "renderer", "index.html")


def get_app_data_dir():
    """Return a writable data directory for runtime files."""
    env_override = os.environ.get("ISENAPP_DATA_DIR", "").strip()
    if env_override:
        return env_override

    xdg_data_home = os.environ.get("XDG_DATA_HOME", "").strip()
    if xdg_data_home:
        return os.path.join(xdg_data_home, "isenapp")

    return os.path.join(str(Path.home()), ".local", "share", "isenapp")


APP_DATA_DIR = get_app_data_dir()
os.makedirs(APP_DATA_DIR, exist_ok=True)

APP_RUNTIME_CONFIG_FILE = os.path.join(APP_DATA_DIR, "runtime_config.json")
APP_ENV_FILE = os.path.join(APP_DATA_DIR, ".env")


def _load_runtime_config():
    """Load optional local runtime config from writable app data."""
    if not os.path.isfile(APP_RUNTIME_CONFIG_FILE):
        return {}
    try:
        with open(APP_RUNTIME_CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def ensure_runtime_config_file():
    """Create a default runtime config file on first start."""
    if os.path.isfile(APP_RUNTIME_CONFIG_FILE):
        return
    default_cfg = {
        "paths": {
            "mails_dir": str(Path.home() / "mails"),
            "vault_dir": str(Path.home() / "Documents" / "isenapp_mails"),
        }
    }
    try:
        with open(APP_RUNTIME_CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(default_cfg, f, ensure_ascii=False, indent=2)
    except Exception:
        # Non bloquant: l'app peut continuer sans ce fichier.
        pass


def bootstrap_file(filename):
    """Copy bundled defaults to writable app data dir when missing."""
    src = os.path.join(BUNDLED_DATA_DIR, filename)
    if not os.path.isfile(src):
        src = os.path.join(DIR, filename)
    dst = os.path.join(APP_DATA_DIR, filename)
    if os.path.isfile(src) and not os.path.exists(dst):
        shutil.copy2(src, dst)
    return dst if os.path.exists(dst) else src


DATA = bootstrap_file("data.json")
CONTACTS_CSV = bootstrap_file("contacts_complets_v2.csv")
LOG_FILE = os.path.join(APP_DATA_DIR, "api_errors.log")
DOWNLOADS = str(Path.home() / "Téléchargements")

_RUNTIME = _load_runtime_config()
_PATHS = _RUNTIME.get("paths", {}) if isinstance(_RUNTIME.get("paths", {}), dict) else {}

_default_mails_dir = str(Path.home() / "mails")
_default_vault_dir = str(Path.home() / "Documents" / "isenapp_mails")

MAILS_DIR = str(_PATHS.get("mails_dir", _default_mails_dir)).strip() or _default_mails_dir
SEEN_UIDS_FILE = os.path.join(APP_DATA_DIR, "seen_uids.json")
ACCOUNTS_FILE = os.path.join(APP_DATA_DIR, "accounts.json")
INBOX_INDEX_FILE = os.path.join(APP_DATA_DIR, "inbox_index.json")

ISENAPP_DATA = str(_PATHS.get("vault_dir", _default_vault_dir)).strip() or _default_vault_dir
GRAPH_MD_DIR = os.path.join(ISENAPP_DATA, "mails")
GRAPH_ATT_DIR = os.path.join(ISENAPP_DATA, "attachements")
GRAPH_VAULT = ISENAPP_DATA

GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar"
GOOGLE_MAIL_SCOPE = "https://mail.google.com/"

os.makedirs(MAILS_DIR, exist_ok=True)
os.makedirs(GRAPH_MD_DIR, exist_ok=True)
os.makedirs(GRAPH_ATT_DIR, exist_ok=True)


def ensure_runtime_env_file():
    """Create a local .env template in writable app data when missing."""
    if os.path.isfile(APP_ENV_FILE):
        return

    template = "\n".join([
        "# NeuRail runtime environment",
        "# Ce fichier est local a cette machine (hors .deb et hors repository)",
        "NEO4J_URI=bolt://localhost:7687",
        "NEO4J_USER=neo4j",
        "NEO4J_PASSWORD=changeme",
        "GEMINI_API_KEY=",
        "GEMINI_MODEL=gemma-3-27b-it",
        "GEMINI_FALLBACK_MODELS=gemini-2.5-flash",
        "EMBEDDING_MODEL=intfloat/multilingual-e5-base",
        "",
    ])
    try:
        with open(APP_ENV_FILE, "w", encoding="utf-8") as f:
            f.write(template)
    except Exception:
        # Non bloquant: l'app peut continuer meme si l'ecriture echoue.
        pass


ensure_runtime_env_file()
ensure_runtime_config_file()

if not os.path.isdir(DOWNLOADS):
    DOWNLOADS = str(Path.home() / "Downloads")
if not os.path.isdir(DOWNLOADS):
    DOWNLOADS = str(Path.home())
