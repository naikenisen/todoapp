import os
import json
import shutil
from pathlib import Path

# Port d'écoute du serveur
PORT = 8080
# Répertoire du fichier courant
DIR = os.path.dirname(os.path.abspath(__file__))
# Racine du projet
PROJECT_ROOT = str(Path(DIR).resolve().parents[1])
# Répertoire des données embarquées
BUNDLED_DATA_DIR = os.path.join(PROJECT_ROOT, "data")
# Chemin vers la page HTML principale du renderer
RENDERER_INDEX = os.path.join(PROJECT_ROOT, "src", "renderer", "index.html")


# Retourne le répertoire de données applicatives inscriptible
def get_app_data_dir():
    env_override = os.environ.get("ISENAPP_DATA_DIR", "").strip()
    if env_override:
        return env_override

    xdg_data_home = os.environ.get("XDG_DATA_HOME", "").strip()
    if xdg_data_home:
        return os.path.join(xdg_data_home, "isenapp")

    return os.path.join(str(Path.home()), ".local", "share", "isenapp")


# Répertoire de données applicatives à l'exécution
APP_DATA_DIR = get_app_data_dir()
os.makedirs(APP_DATA_DIR, exist_ok=True)

# Chemin du fichier de configuration locale
APP_RUNTIME_CONFIG_FILE = os.path.join(APP_DATA_DIR, "runtime_config.json")
# Chemin du fichier .env local
APP_ENV_FILE = os.path.join(APP_DATA_DIR, ".env")


# Charge la configuration locale optionnelle depuis les données applicatives
def _load_runtime_config():
    if not os.path.isfile(APP_RUNTIME_CONFIG_FILE):
        return {}
    try:
        with open(APP_RUNTIME_CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


# Crée le fichier de configuration par défaut au premier démarrage
def ensure_runtime_config_file():
    if os.path.isfile(APP_RUNTIME_CONFIG_FILE):
        return
    default_cfg = {
        "paths": {
            "mails_dir": "/home/naiken/mails",
            "vault_dir": "/home/naiken/mails",
        }
    }
    try:
        with open(APP_RUNTIME_CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(default_cfg, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


# Copie les fichiers embarqués vers le répertoire applicatif si absents
def bootstrap_file(filename):
    src = os.path.join(BUNDLED_DATA_DIR, filename)
    if not os.path.isfile(src):
        src = os.path.join(DIR, filename)
    dst = os.path.join(APP_DATA_DIR, filename)
    if os.path.isfile(src) and not os.path.exists(dst):
        shutil.copy2(src, dst)
    return dst if os.path.exists(dst) else src


# Chemin vers le fichier de données principal
DATA = bootstrap_file("data.json")
# Chemin vers le fichier CSV des contacts
CONTACTS_CSV = bootstrap_file("contacts_complets_v2.csv")
# Chemin du fichier de log des erreurs API
LOG_FILE = os.path.join(APP_DATA_DIR, "api_errors.log")
# Répertoire de téléchargements par défaut
DOWNLOADS = str(Path.home() / "Téléchargements")

# Configuration locale chargée à l'exécution
_RUNTIME = _load_runtime_config()
# Sous-dictionnaire des chemins de la configuration locale
_PATHS = _RUNTIME.get("paths", {}) if isinstance(_RUNTIME.get("paths", {}), dict) else {}

# Répertoire de mails par défaut
_default_mails_dir = "/home/naiken/mails"
# Répertoire de vault par défaut
_default_vault_dir = "/home/naiken/mails"

# Répertoire de stockage des mails
MAILS_DIR = str(_PATHS.get("mails_dir", _default_mails_dir)).strip() or _default_mails_dir
# Fichier de suivi des UIDs de mails lus
SEEN_UIDS_FILE = os.path.join(APP_DATA_DIR, "seen_uids.json")
# Fichier de configuration des comptes email
ACCOUNTS_FILE = os.path.join(APP_DATA_DIR, "accounts.json")
# Fichier d'index de la boîte de réception
INBOX_INDEX_FILE = os.path.join(APP_DATA_DIR, "inbox_index.json")

# Répertoire principal du vault applicatif
ISENAPP_DATA = MAILS_DIR
# Répertoire des fichiers Markdown du graphe
GRAPH_MD_DIR = os.path.join(ISENAPP_DATA, "mails")
# Répertoire des pièces jointes du graphe
GRAPH_ATT_DIR = os.path.join(ISENAPP_DATA, "attachements")
# Alias du vault pour le graphe de connaissances
GRAPH_VAULT = ISENAPP_DATA

# Scope OAuth Google pour l'accès Gmail
GOOGLE_MAIL_SCOPE = "https://mail.google.com/"

os.makedirs(MAILS_DIR, exist_ok=True)
os.makedirs(GRAPH_MD_DIR, exist_ok=True)
os.makedirs(GRAPH_ATT_DIR, exist_ok=True)


# Crée un modèle .env local dans les données applicatives si absent
def ensure_runtime_env_file():
    if os.path.isfile(APP_ENV_FILE):
        return

    template = "\n".join([
        "# NeuRail runtime environment",
        "# Ce fichier est local a cette machine (hors .deb et hors repository)",
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
        pass


ensure_runtime_env_file()
ensure_runtime_config_file()

if not os.path.isdir(DOWNLOADS):
    DOWNLOADS = str(Path.home() / "Downloads")
if not os.path.isdir(DOWNLOADS):
    DOWNLOADS = str(Path.home())
