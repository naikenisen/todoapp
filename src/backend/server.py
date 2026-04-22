#!/usr/bin/env python3

import csv
import email as email_lib
import http.server
import json
import logging
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.parse
import hashlib
import threading
from urllib.parse import parse_qs, urlparse
from datetime import datetime
from email import policy as email_policy
from email.utils import getaddresses

from app_config import (
    APP_DATA_DIR,
    APP_ENV_FILE,
    APP_RUNTIME_CONFIG_FILE,
    COMMERCIAL_DIR,
    CONTACTS_CSV,
    DATA,
    DIR,
    DOWNLOADS,
    GOOGLE_MAIL_SCOPE,
    LOG_FILE,
    MAILS_DIR,
    PORT,
    PROJECT_ROOT,
    RENDERER_INDEX,
)

from account_store import (
    find_account_by_email,
    find_account_index_by_email,
    load_accounts,
    normalize_auth_fields,
    save_accounts,
)
from json_store import atomic_write_json, read_json_with_backup
from mail_utils import (
    build_eml,
    compute_mail_id,
    enrich_mail_from_eml,
    get_attachment_payload,
    ingest_manual_eml_files,
    load_inbox_index,
    load_seen_uids,
    parse_email_metadata,
    resolve_eml_path,
    save_eml_to_downloads,
    save_inbox_index,
    save_seen_uids,
    unique_eml_filename_from_subject,
)
from mail_service import (
    delete_mail_on_server as _delete_mail_on_server_impl,
    fetch_imap as _fetch_imap_impl,
    fetch_pop3 as _fetch_pop3_impl,
    send_email_smtp as _send_email_smtp_impl,
)
from google_calendar_service import (
    build_oauth_callback_page,
    exchange_google_auth_code,
    generate_pkce_pair,
    get_valid_gmail_access_token,
)
from calendar_routes import handle_oauth_callback
from ai_service import ai_generate_reminder, ai_generate_reply, ai_reformulate, ai_summarize_mail
from autoconfig_service import autoconfig_email

# Stockage en mémoire des états OAuth Google en attente
GOOGLE_OAUTH_PENDING = {}

logging.basicConfig(
    filename=LOG_FILE,
    format="%(asctime)s [%(levelname)s] %(message)s",
    level=logging.ERROR,
)
# Instance du logger de l'application
logger = logging.getLogger("todoapp")


# Charge l'état applicatif depuis le fichier JSON
def loadAppState():
    return read_json_with_backup(DATA, {"sections": [], "settings": {}})


# Sauvegarde l'état applicatif dans le fichier JSON
def saveAppState(data):
    atomic_write_json(DATA, data)


# Charge la liste des contacts depuis le fichier CSV
def loadContactsData():
    contacts = []
    try:
        with open(CONTACTS_CSV, encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                name = row.get("Display Name", "").strip()
                if not name:
                    first = row.get("First Name", "").strip()
                    last = row.get("Last Name", "").strip()
                    name = f"{first} {last}".strip()
                email_addr = row.get("Primary Email", "").strip()
                if email_addr:
                    contacts.append({"name": name, "email": email_addr})
    except Exception:
        pass
    return contacts


# Construit l'annuaire unifié à partir des contacts CSV et des fichiers .eml
def _build_annuaire():
    directory = {}  # clé = email normalisé

    # 1) Contacts CSV importés
    for c in loadContactsData():
        email_lower = c["email"].lower()
        if email_lower not in directory:
            directory[email_lower] = {
                "name": c["name"],
                "email": c["email"],
                "sources": ["import"],
                "mail_count": 0,
            }
        elif "import" not in directory[email_lower]["sources"]:
            directory[email_lower]["sources"].append("import")
            if c["name"] and not directory[email_lower]["name"]:
                directory[email_lower]["name"] = c["name"]

    # 2) Extraire les personnes depuis les fichiers .eml des dossiers mails + commercial
    for source_dir in (MAILS_DIR, COMMERCIAL_DIR):
        if not os.path.isdir(source_dir):
            continue
        for fname in os.listdir(source_dir):
            if not fname.lower().endswith(".eml"):
                continue
            fpath = os.path.join(source_dir, fname)
            try:
                with open(fpath, "rb") as f:
                    msg = email_lib.message_from_bytes(f.read(), policy=email_policy.default)
            except Exception:
                continue

            people = []
            # From
            from_hdr = msg.get("From", "")
            if from_hdr:
                for name, addr in getaddresses([from_hdr]):
                    if addr:
                        people.append((name, addr))
            # To
            to_hdr = msg.get("To", "")
            if to_hdr:
                for name, addr in getaddresses([to_hdr]):
                    if addr:
                        people.append((name, addr))
            # Cc
            cc_hdr = msg.get("Cc", "")
            if cc_hdr:
                for name, addr in getaddresses([cc_hdr]):
                    if addr:
                        people.append((name, addr))
            # X-Forwarded-To / Resent-From (forwarded mails)
            for fwd_key in ("X-Forwarded-To", "X-Forwarded-For", "Resent-From", "Resent-To"):
                fwd_hdr = msg.get(fwd_key, "")
                if fwd_hdr:
                    for name, addr in getaddresses([fwd_hdr]):
                        if addr:
                            people.append((name, addr))

            for name, addr in people:
                email_lower = addr.strip().lower()
                if not email_lower:
                    continue
                if email_lower not in directory:
                    directory[email_lower] = {
                        "name": name.strip(),
                        "email": addr.strip(),
                        "sources": ["mail"],
                        "mail_count": 0,
                    }
                else:
                    if "mail" not in directory[email_lower]["sources"]:
                        directory[email_lower]["sources"].append("mail")
                    if name.strip() and not directory[email_lower]["name"]:
                        directory[email_lower]["name"] = name.strip()
                directory[email_lower]["mail_count"] += 1

    result = sorted(directory.values(), key=lambda c: (c.get("name") or c.get("email", "")).lower())
    return result


# Liste des clés d'environnement gérées localement
_LOCAL_ENV_KEYS = [
    "GEMINI_API_KEY",
    "GEMINI_MODEL",
    "GEMINI_FALLBACK_MODELS",
    "EMBEDDING_MODEL",
]


# Lit les paires clé/valeur du fichier .env d'exécution local
def _read_runtime_env_file() -> dict:
    out = {}
    if not os.path.isfile(APP_ENV_FILE):
        return out
    try:
        with open(APP_ENV_FILE, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith("#") or "=" not in s:
                    continue
                key, val = s.split("=", 1)
                key = key.strip()
                if not key:
                    continue
                out[key] = val.strip()
    except Exception:
        return {}
    return out


# Persiste les valeurs d'environnement d'exécution sélectionnées dans le fichier .env local
def _write_runtime_env_file(values: dict) -> None:
    current = _read_runtime_env_file()
    current.update({k: str(v) for k, v in (values or {}).items() if k in _LOCAL_ENV_KEYS})

    lines = [
        "# NeuRail runtime environment",
        "# Fichier local a cette machine (hors .deb / hors repository)",
    ]
    for key in _LOCAL_ENV_KEYS:
        lines.append(f"{key}={current.get(key, '')}")
    lines.append("")

    with open(APP_ENV_FILE, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


# Construit le payload de configuration pour l'interface des paramètres d'installation
def _get_app_install_config() -> dict:
    env_vals = _read_runtime_env_file()
    return {
        "paths": {
            "app_data_dir": APP_DATA_DIR,
            "runtime_config_file": APP_RUNTIME_CONFIG_FILE,
            "runtime_env_file": APP_ENV_FILE,
            "data_json": DATA,
            "accounts_file": os.path.join(APP_DATA_DIR, "accounts.json"),
            "inbox_index_file": os.path.join(APP_DATA_DIR, "inbox_index.json"),
            "seen_uids_file": os.path.join(APP_DATA_DIR, "seen_uids.json"),
            "contacts_csv": CONTACTS_CSV,
            "mails_dir": MAILS_DIR,
            "commercial_dir": COMMERCIAL_DIR,
            "vault_dir": MAILS_DIR,
            "log_file": LOG_FILE,
        },
        "env": {
            "GEMINI_API_KEY": env_vals.get("GEMINI_API_KEY", os.getenv("GEMINI_API_KEY", "")),
            "GEMINI_MODEL": env_vals.get("GEMINI_MODEL", os.getenv("GEMINI_MODEL", "gemma-3-27b-it")),
            "GEMINI_FALLBACK_MODELS": env_vals.get("GEMINI_FALLBACK_MODELS", os.getenv("GEMINI_FALLBACK_MODELS", "gemini-2.5-flash")),
            "EMBEDDING_MODEL": env_vals.get("EMBEDDING_MODEL", os.getenv("EMBEDDING_MODEL", "intfloat/multilingual-e5-base")),
        },
    }


# Persiste la configuration d'exécution et les surcharges d'environnement dans les fichiers locaux
def _save_app_install_config(payload: dict) -> None:
    payload = payload or {}
    paths_in = payload.get("paths", {}) if isinstance(payload.get("paths", {}), dict) else {}
    env_in = payload.get("env", {}) if isinstance(payload.get("env", {}), dict) else {}

    # Normalise et résout un chemin de fichier
    def _clean_path(value: str, fallback: str) -> str:
        p = str(value or "").strip()
        if not p:
            p = fallback
        p = os.path.abspath(os.path.expanduser(p))
        return p

    mails_dir = _clean_path(paths_in.get("mails_dir", ""), MAILS_DIR)
    commercial_dir = _clean_path(paths_in.get("commercial_dir", ""), COMMERCIAL_DIR)
    vault_dir = mails_dir

    runtime_cfg = _read_runtime_config_file()
    runtime_cfg["paths"] = {
        "mails_dir": mails_dir,
        "commercial_dir": commercial_dir,
        "vault_dir": vault_dir,
    }
    runtime_cfg["updated_at"] = datetime.utcnow().isoformat() + "Z"

    os.makedirs(APP_DATA_DIR, exist_ok=True)
    os.makedirs(mails_dir, exist_ok=True)
    os.makedirs(commercial_dir, exist_ok=True)

    with open(APP_RUNTIME_CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(runtime_cfg, f, ensure_ascii=False, indent=2)

    _write_runtime_env_file(env_in)
    for key, val in env_in.items():
        if key in _LOCAL_ENV_KEYS:
            os.environ[key] = str(val)


# Lit la configuration JSON d'exécution depuis les données de l'application
def _read_runtime_config_file() -> dict:
    if not os.path.isfile(APP_RUNTIME_CONFIG_FILE):
        return {}
    try:
        with open(APP_RUNTIME_CONFIG_FILE, "r", encoding="utf-8", errors="replace") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


# Exécute une commande système et capture la sortie pour le diagnostic
def _run_cmd(args: list[str], timeout: int = 8) -> dict:
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        out = ((p.stdout or "") + "\n" + (p.stderr or "")).strip()
        return {"ok": p.returncode == 0, "code": p.returncode, "output": out}
    except FileNotFoundError:
        return {"ok": False, "code": None, "output": "commande introuvable"}
    except Exception as exc:
        return {"ok": False, "code": None, "output": str(exc)}


# Retourne le statut d'installation d'un paquet dpkg
def _dpkg_package_status(pkg_name: str) -> dict:
    if not shutil.which("dpkg-query"):
        return {"installed": None, "status": "dpkg-query indisponible"}
    res = _run_cmd(["dpkg-query", "-W", "-f=${Status}", pkg_name])
    out = (res.get("output") or "").lower()
    installed = "install ok installed" in out
    return {
        "installed": installed,
        "status": res.get("output", "") or ("installé" if installed else "non installé"),
    }


# Construit le rapport de diagnostic système complet
def _build_system_diagnostics() -> dict:
    node_check = _run_cmd(["node", "--version"])
    python_check = _run_cmd(["python3", "--version"])
    pip_check = _run_cmd(["python3", "-m", "pip", "--version"])
    dpkg_check = _run_cmd(["dpkg", "--version"])
    apt_check = _run_cmd(["apt-get", "--version"])

    checks = [
        {
            "id": "dpkg",
            "label": "dpkg disponible",
            "ok": dpkg_check["ok"],
            "details": dpkg_check.get("output", ""),
            "fix": "Installer dpkg/apt (distribution Debian/Ubuntu).",
        },
        {
            "id": "apt",
            "label": "apt-get disponible",
            "ok": apt_check["ok"],
            "details": apt_check.get("output", ""),
            "fix": "Utiliser apt pour résoudre les dépendances: sudo apt install -f",
        },
        {
            "id": "python3",
            "label": "Python 3",
            "ok": python_check["ok"],
            "details": python_check.get("output", ""),
            "fix": "sudo apt install python3 python3-pip",
        },
        {
            "id": "pip",
            "label": "pip Python",
            "ok": pip_check["ok"],
            "details": pip_check.get("output", ""),
            "fix": "sudo apt install python3-pip",
        },
        {
            "id": "nodejs",
            "label": "Node.js (optionnel au runtime)",
            "ok": node_check["ok"],
            "details": node_check.get("output", "") or "Node.js n'est pas requis pour utiliser l'app installée.",
            "fix": "Optionnel: sudo apt install nodejs npm (utile surtout pour le dev/build)",
        },
        {
            "id": "app-data",
            "label": "Dossier app data accessible",
            "ok": os.path.isdir(APP_DATA_DIR) and os.access(APP_DATA_DIR, os.W_OK),
            "details": APP_DATA_DIR,
            "fix": "Vérifier les permissions du dossier utilisateur NeuRail.",
        },
    ]

    packages = {
        "python3": _dpkg_package_status("python3"),
        "python3-pip": _dpkg_package_status("python3-pip"),
        "nodejs": _dpkg_package_status("nodejs"),
    }

    return {
        "ok": True,
        "platform": sys.platform,
        "dpkg_note": "dpkg n'installe pas automatiquement les dépendances manquantes. Utiliser: sudo apt install ./Neurail.deb ou sudo apt install -f après dpkg -i.",
        "checks": checks,
        "packages": packages,
    }


# Dictionnaire d'injection de dépendances commun pour les services mail
_MAIL_DI_COMMON = dict(
    load_seen_uids=load_seen_uids,
    save_seen_uids=save_seen_uids,
    load_inbox_index=load_inbox_index,
    save_inbox_index=save_inbox_index,
    compute_mail_id=compute_mail_id,
    parse_email_metadata=parse_email_metadata,
    unique_eml_filename_from_subject=unique_eml_filename_from_subject,
    mails_dir=MAILS_DIR,
)

COMMERCIAL_SENDERS_FILE = os.path.join(APP_DATA_DIR, "commercial_senders.json")
RSPAMD_SPAM_ACTIONS = {"add header", "rewrite subject", "soft reject", "reject", "greylist"}


def _mailbox_of(mail):
    if mail.get("folder") == "sent":
        return "sent"
    mb = str(mail.get("mailbox", "") or "").strip().lower()
    if mb in ("inbox", "commercial", "sent"):
        return mb
    return "inbox"


def _load_commercial_senders() -> set[str]:
    data = read_json_with_backup(COMMERCIAL_SENDERS_FILE, [])
    if not isinstance(data, list):
        return set()
    return {
        str(item or "").strip().lower()
        for item in data
        if str(item or "").strip()
    }


def _save_commercial_senders(senders: set[str]):
    atomic_write_json(COMMERCIAL_SENDERS_FILE, sorted(senders))


def _rspamd_marks_suspect(eml_path: str) -> bool:
    if not eml_path or not os.path.isfile(eml_path):
        return False

    rspamc_cmd = os.environ.get("RSPAMC_CMD", "rspamc").strip() or "rspamc"
    if not shutil.which(rspamc_cmd):
        return False

    try:
        proc = subprocess.run(
            [rspamc_cmd, "symbols", "-i", eml_path],
            capture_output=True,
            text=True,
            timeout=8,
        )
    except Exception:
        return False

    output = "\n".join([
        proc.stdout or "",
        proc.stderr or "",
    ])
    if not output.strip():
        return False

    action_match = re.search(r"Action:\s*([^;\n]+)", output, flags=re.IGNORECASE)
    if action_match:
        action = action_match.group(1).strip().lower()
        if action in RSPAMD_SPAM_ACTIONS:
            return True
        if action in ("no action", "ham"):
            return False

    score_match = re.search(r"Score:\s*(-?\d+(?:\.\d+)?)\s*/", output, flags=re.IGNORECASE)
    if score_match:
        try:
            score = float(score_match.group(1))
            if score >= 6.0:
                return True
        except Exception:
            pass

    lower_output = output.lower()
    return "is spam" in lower_output or "spam: true" in lower_output


def _ensure_unique_filename_in_dir(filename: str, target_dir: str) -> str:
    base = os.path.basename(filename or "")
    if not base:
        base = unique_eml_filename_from_subject("mail", target_dir=target_dir)
    candidate = base
    stem, ext = os.path.splitext(base)
    i = 1
    while os.path.exists(os.path.join(target_dir, candidate)):
        candidate = f"{stem}_{i}{ext or '.eml'}"
        i += 1
    return candidate


def _move_mail_to_storage(mail: dict, target_dir: str, target_mailbox: str, processed_override=None) -> bool:
    os.makedirs(target_dir, exist_ok=True)
    current_path = resolve_eml_path(mail)
    if not current_path or not os.path.isfile(current_path):
        return False

    target_name = _ensure_unique_filename_in_dir(mail.get("eml_file", ""), target_dir)
    target_path = os.path.join(target_dir, target_name)

    same_path = os.path.abspath(current_path) == os.path.abspath(target_path)
    if not same_path:
        os.replace(current_path, target_path)

    mail["eml_file"] = target_name
    mail["storage_dir"] = target_dir
    mail["mailbox"] = target_mailbox
    if processed_override is not None:
        mail["processed"] = bool(processed_override)
    return True


def apply_commercial_filter(inbox: list[dict]) -> int:
    changed = 0
    sender_rules = _load_commercial_senders()
    for mail in inbox:
        if mail.get("deleted") or mail.get("folder") == "sent":
            continue

        sender = str(mail.get("from_email", "") or "").strip().lower()
        sender_marked_commercial = bool(sender and sender in sender_rules)
        rspamd_suspect = _rspamd_marks_suspect(resolve_eml_path(mail))

        if str(mail.get("commercial_override", "") or "").lower() == "keep":
            target_mailbox = "inbox"
        else:
            target_mailbox = "commercial" if (sender_marked_commercial or rspamd_suspect) else "inbox"
        current_mailbox = _mailbox_of(mail)

        if target_mailbox == "commercial":
            if current_mailbox != "commercial":
                moved = _move_mail_to_storage(mail, COMMERCIAL_DIR, "commercial", processed_override=True)
                if moved:
                    changed += 1
            else:
                mail["processed"] = True
        else:
            if current_mailbox == "commercial":
                moved = _move_mail_to_storage(mail, MAILS_DIR, "inbox", processed_override=False)
                if moved:
                    changed += 1
            else:
                mail["mailbox"] = "inbox"
                mail["storage_dir"] = MAILS_DIR
    return changed


def refresh_and_classify_local_mailboxes():
    total_new = 0
    all_errors = []

    n1, e1 = ingest_manual_eml_files(
        load_inbox_index_fn=load_inbox_index,
        save_inbox_index_fn=save_inbox_index,
        compute_mail_id_fn=compute_mail_id,
        parse_email_metadata_fn=parse_email_metadata,
        mails_dir=MAILS_DIR,
        mailbox="inbox",
        processed_default=False,
    )
    total_new += n1
    all_errors.extend(e1)

    n2, e2 = ingest_manual_eml_files(
        load_inbox_index_fn=load_inbox_index,
        save_inbox_index_fn=save_inbox_index,
        compute_mail_id_fn=compute_mail_id,
        parse_email_metadata_fn=parse_email_metadata,
        mails_dir=COMMERCIAL_DIR,
        mailbox="commercial",
        processed_default=True,
    )
    total_new += n2
    all_errors.extend(e2)

    inbox = load_inbox_index()
    changed = apply_commercial_filter(inbox)
    if changed:
        save_inbox_index(inbox)

    return total_new, all_errors, changed


def delete_mails_batch(ids, delete_on_server=True):
    if not ids or not isinstance(ids, list):
        return {"ok": False, "error": "ids manquants"}, 400

    inbox = load_inbox_index()
    seen = load_seen_uids()
    seen_changed = False
    deleted = 0
    errors = []
    remote_missing = 0
    remote_failed = []

    for mail_id in ids:
        mail = next((m for m in inbox if m.get("id") == mail_id), None)
        if not mail:
            errors.append(mail_id)
            continue

        remote_ok_for_local_delete = True
        if delete_on_server and mail.get("uid") and mail.get("account"):
            account = find_account_by_email(mail["account"])
            if account:
                try:
                    remote_deleted = delete_mail_on_server(account, mail["uid"])
                    if remote_deleted is False:
                        remote_missing += 1
                except Exception as del_err:
                    logger.warning("Batch delete on server failed for %s: %s", mail_id, del_err)
                    remote_failed.append({"id": mail_id, "error": str(del_err)})
                    remote_ok_for_local_delete = False

        if delete_on_server and not remote_ok_for_local_delete:
            errors.append(mail_id)
            continue

        eml_path = resolve_eml_path(mail)
        if os.path.isfile(eml_path):
            os.remove(eml_path)
        if mail.get("uid"):
            for _, uids in seen.items():
                if mail["uid"] in uids:
                    uids.remove(mail["uid"])
                    seen_changed = True
        mail["deleted"] = True
        deleted += 1

    if seen_changed:
        save_seen_uids(seen)
    save_inbox_index(inbox)

    return {
        "ok": True,
        "deleted": deleted,
        "errors": errors,
        "remote": {
            "already_missing": remote_missing,
            "failed": remote_failed,
        },
    }, 200


DOWNLOAD_RELEVANT_EXTS = {".docx", ".xlsx", ".csv", ".pdf", ".odt", ".txt", ".pptx"}
DOWNLOADS_METADATA_FILE = "data.csv"
DOWNLOADS_METADATA_FIELDS = ["filename", "name1", "name2", "description", "deposited"]
ONLYOFFICE_CANDIDATE_CMDS = [
    os.environ.get("ONLYOFFICE_CMD", "").strip(),
    "onlyoffice-desktopeditors",
    "desktopeditors",
]

_MAILBOX_REFRESH_LOCK = threading.Lock()
_MAILBOX_REFRESH_RUNNING = False
_MAILBOX_REFRESH_LAST_START = 0.0

_DOWNLOADS_CACHE_LOCK = threading.Lock()
_DOWNLOADS_CACHE_FILES = []
_DOWNLOADS_CACHE_TS = 0.0
_DOWNLOADS_CACHE_RUNNING = False


def _is_subpath(path_value: str, root_dir: str) -> bool:
    try:
        path_abs = os.path.abspath(path_value)
        root_abs = os.path.abspath(root_dir)
        return os.path.commonpath([path_abs, root_abs]) == root_abs
    except Exception:
        return False


def _safe_download_path(path_value: str) -> str:
    raw = str(path_value or "").strip()
    if not raw:
        raise ValueError("Chemin manquant")
    abs_path = os.path.abspath(raw)
    if not _is_subpath(abs_path, DOWNLOADS):
        raise ValueError("Chemin hors du dossier Téléchargements")
    if not os.path.isfile(abs_path):
        raise ValueError("Fichier introuvable")
    return abs_path


def _schedule_mailbox_refresh(min_interval_seconds: int = 20) -> bool:
    global _MAILBOX_REFRESH_RUNNING, _MAILBOX_REFRESH_LAST_START
    now = time.time()
    with _MAILBOX_REFRESH_LOCK:
        if _MAILBOX_REFRESH_RUNNING:
            return False
        if (now - _MAILBOX_REFRESH_LAST_START) < float(min_interval_seconds):
            return False
        _MAILBOX_REFRESH_RUNNING = True
        _MAILBOX_REFRESH_LAST_START = now

    def _worker():
        global _MAILBOX_REFRESH_RUNNING
        try:
            refresh_and_classify_local_mailboxes()
        except Exception:
            pass
        finally:
            with _MAILBOX_REFRESH_LOCK:
                _MAILBOX_REFRESH_RUNNING = False

    threading.Thread(target=_worker, daemon=True, name="neurail-mailbox-refresh").start()
    return True


def _downloads_metadata_csv_path() -> str:
    return os.path.join(DOWNLOADS, DOWNLOADS_METADATA_FILE)


def _read_downloads_metadata() -> dict[str, dict]:
    csv_path = _downloads_metadata_csv_path()
    if not os.path.isfile(csv_path):
        return {}

    out = {}
    try:
        with open(csv_path, "r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                filename = str(row.get("filename", "") or "").strip()
                if not filename:
                    continue
                out[filename] = {
                    "filename": filename,
                    "name1": str(row.get("name1", "") or "").strip(),
                    "name2": str(row.get("name2", "") or "").strip(),
                    "description": str(row.get("description", "") or "").strip(),
                    "deposited": str(row.get("deposited", "") or "").strip().lower() in ("1", "true", "yes", "oui"),
                }
    except Exception:
        return {}
    return out


def _write_downloads_metadata(entries: dict[str, dict]):
    os.makedirs(DOWNLOADS, exist_ok=True)
    csv_path = _downloads_metadata_csv_path()
    rows = []
    for filename in sorted(entries.keys()):
        row = entries[filename] or {}
        rows.append({
            "filename": filename,
            "name1": str(row.get("name1", "") or "").strip(),
            "name2": str(row.get("name2", "") or "").strip(),
            "description": str(row.get("description", "") or "").strip(),
            "deposited": "1" if bool(row.get("deposited", False)) else "0",
        })

    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=DOWNLOADS_METADATA_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def _sanitize_filename_token(value: str) -> str:
    s = str(value or "").strip()
    s = re.sub(r"\s+", "_", s)
    s = re.sub(r"[^A-Za-z0-9_\-]", "", s)
    return s.strip("_-")


def _build_renamed_download_path(file_path: str, name1: str, name2: str) -> str:
    directory = os.path.dirname(file_path)
    ext = os.path.splitext(file_path)[1].lower()
    base = f"{_sanitize_filename_token(name1)}_{_sanitize_filename_token(name2)}".strip("_")
    if not base:
        raise ValueError("Nom 1 et Nom 2 invalides")

    candidate = f"{base}{ext}"
    target_path = os.path.join(directory, candidate)
    if os.path.abspath(target_path) == os.path.abspath(file_path):
        return target_path

    stem, ext_only = os.path.splitext(candidate)
    i = 1
    while os.path.exists(target_path):
        candidate = f"{stem}_{i}{ext_only}"
        target_path = os.path.join(directory, candidate)
        i += 1
    return target_path


def update_download_metadata(path_value: str, name1: str, name2: str, description: str) -> dict:
    source_path = _safe_download_path(path_value)
    source_name = os.path.basename(source_path)

    clean_name1 = str(name1 or "").strip()
    clean_name2 = str(name2 or "").strip()
    clean_desc = str(description or "").strip()

    metadata = _read_downloads_metadata()
    entry = dict(metadata.get(source_name) or {})
    entry["name1"] = clean_name1
    entry["name2"] = clean_name2
    entry["description"] = clean_desc
    entry["deposited"] = bool(entry.get("deposited", False))

    final_path = source_path
    final_name = source_name

    if clean_name1 and clean_name2:
        target_path = _build_renamed_download_path(source_path, clean_name1, clean_name2)
        if os.path.abspath(target_path) != os.path.abspath(source_path):
            os.replace(source_path, target_path)
            final_path = target_path
            final_name = os.path.basename(target_path)

    if final_name != source_name and source_name in metadata:
        metadata.pop(source_name, None)

    metadata[final_name] = {
        "filename": final_name,
        "name1": clean_name1,
        "name2": clean_name2,
        "description": clean_desc,
        "deposited": bool(entry.get("deposited", False)),
    }
    _write_downloads_metadata(metadata)

    st = os.stat(final_path)
    return {
        "path": final_path,
        "name": final_name,
        "ext": os.path.splitext(final_name)[1].lower(),
        "size": int(st.st_size),
        "mtime": int(st.st_mtime * 1000),
        "date": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
        "name1": clean_name1,
        "name2": clean_name2,
        "description": clean_desc,
        "deposited": bool(entry.get("deposited", False)),
    }


def mark_download_deposited(path_value: str, deposited: bool = True) -> dict:
    file_path = _safe_download_path(path_value)
    filename = os.path.basename(file_path)

    metadata = _read_downloads_metadata()
    row = dict(metadata.get(filename) or {})
    row["filename"] = filename
    row["name1"] = str(row.get("name1", "") or "").strip()
    row["name2"] = str(row.get("name2", "") or "").strip()
    row["description"] = str(row.get("description", "") or "").strip()
    row["deposited"] = bool(deposited)
    metadata[filename] = row
    _write_downloads_metadata(metadata)
    return row


def trash_deposited_downloads() -> dict:
    files = list_download_candidates(force_refresh=True)
    deposited_files = [f for f in files if bool(f.get("deposited", False))]
    if not deposited_files:
        return {"ok": True, "deleted": 0, "errors": []}

    deleted = 0
    errors = []
    moved_names = set()

    for f in deposited_files:
        path_value = str(f.get("path", "") or "").strip()
        name = str(f.get("name", "") or "").strip()
        try:
            move_file_to_trash(path_value)
            deleted += 1
            if name:
                moved_names.add(name)
        except Exception as e:
            errors.append(f"{name or path_value}: {e}")

    if moved_names:
        metadata = _read_downloads_metadata()
        for name in moved_names:
            metadata.pop(name, None)
        _write_downloads_metadata(metadata)

    _schedule_downloads_refresh()
    return {"ok": True, "deleted": deleted, "errors": errors}


def _compute_download_candidates():
    files = []
    if not os.path.isdir(DOWNLOADS):
        return files

    metadata = _read_downloads_metadata()

    for current_root, _, filenames in os.walk(DOWNLOADS):
        for name in filenames:
            if name == DOWNLOADS_METADATA_FILE:
                continue
            ext = os.path.splitext(name)[1].lower()
            if ext not in DOWNLOAD_RELEVANT_EXTS:
                continue
            full_path = os.path.join(current_root, name)
            if not os.path.isfile(full_path):
                continue
            try:
                st = os.stat(full_path)
                meta = metadata.get(name, {})
                files.append({
                    "id": hashlib.sha1(full_path.encode("utf-8", errors="ignore")).hexdigest()[:16],
                    "path": full_path,
                    "name": name,
                    "ext": ext,
                    "size": int(st.st_size),
                    "mtime": int(st.st_mtime * 1000),
                    "date": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
                    "name1": str(meta.get("name1", "") or "").strip(),
                    "name2": str(meta.get("name2", "") or "").strip(),
                    "description": str(meta.get("description", "") or "").strip(),
                    "deposited": bool(meta.get("deposited", False)),
                })
            except Exception:
                continue

    files.sort(key=lambda x: x.get("mtime", 0), reverse=True)
    return files


def _schedule_downloads_refresh() -> bool:
    global _DOWNLOADS_CACHE_RUNNING, _DOWNLOADS_CACHE_FILES, _DOWNLOADS_CACHE_TS
    with _DOWNLOADS_CACHE_LOCK:
        if _DOWNLOADS_CACHE_RUNNING:
            return False
        _DOWNLOADS_CACHE_RUNNING = True

    def _worker():
        global _DOWNLOADS_CACHE_RUNNING, _DOWNLOADS_CACHE_FILES, _DOWNLOADS_CACHE_TS
        try:
            fresh = _compute_download_candidates()
            with _DOWNLOADS_CACHE_LOCK:
                _DOWNLOADS_CACHE_FILES = fresh
                _DOWNLOADS_CACHE_TS = time.time()
        finally:
            with _DOWNLOADS_CACHE_LOCK:
                _DOWNLOADS_CACHE_RUNNING = False

    threading.Thread(target=_worker, daemon=True, name="neurail-downloads-refresh").start()
    return True


def list_download_candidates(force_refresh: bool = False):
    global _DOWNLOADS_CACHE_FILES, _DOWNLOADS_CACHE_TS
    now = time.time()
    with _DOWNLOADS_CACHE_LOCK:
        cache_age = now - _DOWNLOADS_CACHE_TS
        has_cache = bool(_DOWNLOADS_CACHE_FILES)
        should_refresh = force_refresh or (cache_age > 10.0)
        cached = list(_DOWNLOADS_CACHE_FILES)

    if should_refresh:
        _schedule_downloads_refresh()

    if has_cache:
        return cached

    # Premier appel: calcul synchrone unique pour amorcer le cache.
    fresh = _compute_download_candidates()
    with _DOWNLOADS_CACHE_LOCK:
        _DOWNLOADS_CACHE_FILES = fresh
        _DOWNLOADS_CACHE_TS = time.time()
    return list(fresh)


def prepare_download_for_drag(path_value: str, short_name: str):
    source_path = _safe_download_path(path_value)
    short = str(short_name or "").strip()
    if not re.match(r"^[^\s_]+_[^\s_]+$", short):
        raise ValueError("Nom court invalide (format attendu: Mot1_Mot2)")

    st = os.stat(source_path)
    dt = datetime.fromtimestamp(st.st_mtime)
    date_part = dt.strftime("%Y_%m_%d")
    ext = os.path.splitext(source_path)[1].lower()
    staged_name = f"{date_part}_{short}{ext}"

    staging_dir = os.path.join(APP_DATA_DIR, "download_staging")
    os.makedirs(staging_dir, exist_ok=True)

    candidate = staged_name
    stem, ext_only = os.path.splitext(staged_name)
    i = 1
    while os.path.exists(os.path.join(staging_dir, candidate)):
        candidate = f"{stem}_{i}{ext_only}"
        i += 1

    target_path = os.path.join(staging_dir, candidate)
    shutil.copy2(source_path, target_path)
    return target_path, candidate


def move_file_to_trash(path_value: str):
    file_path = _safe_download_path(path_value)

    if shutil.which("gio"):
        proc = subprocess.run(["gio", "trash", file_path], capture_output=True, text=True)
        if proc.returncode == 0:
            return True

    if shutil.which("trash-put"):
        proc = subprocess.run(["trash-put", file_path], capture_output=True, text=True)
        if proc.returncode == 0:
            return True

    trash_dir = os.path.join(os.path.expanduser("~"), ".local", "share", "Trash", "files")
    os.makedirs(trash_dir, exist_ok=True)
    base = os.path.basename(file_path)
    candidate = base
    stem, ext = os.path.splitext(base)
    i = 1
    while os.path.exists(os.path.join(trash_dir, candidate)):
        candidate = f"{stem}_{i}{ext}"
        i += 1
    shutil.move(file_path, os.path.join(trash_dir, candidate))
    return True


def open_file_in_onlyoffice(path_value: str) -> str:
    file_path = _safe_download_path(path_value)

    for cmd in ONLYOFFICE_CANDIDATE_CMDS:
        if not cmd:
            continue
        if not shutil.which(cmd):
            continue
        subprocess.Popen([cmd, file_path], start_new_session=True)
        return cmd

    raise RuntimeError("OnlyOffice introuvable (commande: onlyoffice-desktopeditors)")


def get_download_candidates_for_drop() -> list[dict]:
    files = list_download_candidates()
    return [
        f for f in files
        if str(f.get("name1", "")).strip()
        and str(f.get("name2", "")).strip()
        and str(f.get("description", "")).strip()
    ]


# Récupère les emails via POP3 pour un compte donné
def fetch_pop3(account):
    return _fetch_pop3_impl(account, **_MAIL_DI_COMMON)


# Récupère les emails via IMAP pour un compte donné
def fetch_imap(account):
    return _fetch_imap_impl(
        account,
        normalize_auth_fields=normalize_auth_fields,
        get_valid_gmail_access_token=get_valid_gmail_access_token,
        **_MAIL_DI_COMMON,
    )


# Récupère les emails de tous les comptes configurés (POP3 ou IMAP)
def fetch_all_accounts():
    accounts = load_accounts()
    total_new = 0
    all_errors = []

    for acc in accounts:
        if not acc.get("enabled", True):
            continue
        try:
            protocol = acc.get("protocol", "pop3").lower()
            n, errs = fetch_imap(acc) if protocol == "imap" else fetch_pop3(acc)
            total_new += n
            all_errors.extend(errs)
        except Exception as e:
            all_errors.append(f"{acc.get('email', '?')}: {e}")

    local_new, local_errors, _ = refresh_and_classify_local_mailboxes()
    total_new += local_new
    all_errors.extend(local_errors)

    return total_new, all_errors


# Envoie un email via SMTP pour un compte donné
def send_email_smtp(account, to_addr, subject, body_text, cc="", attachments=None, html_body=None):
    return _send_email_smtp_impl(
        account, to_addr, subject, body_text,
        cc=cc, attachments=attachments, html_body=html_body,
        normalize_auth_fields=normalize_auth_fields,
        get_valid_gmail_access_token=get_valid_gmail_access_token,
        compute_mail_id=compute_mail_id,
        unique_eml_filename_from_subject=unique_eml_filename_from_subject,
        parse_email_metadata=parse_email_metadata,
        load_inbox_index=load_inbox_index,
        save_inbox_index=save_inbox_index,
        mails_dir=MAILS_DIR,
    )


# Supprime un email sur le serveur distant pour un compte donné
def delete_mail_on_server(account, uid_to_delete):
    return _delete_mail_on_server_impl(
        account, uid_to_delete,
        normalize_auth_fields=normalize_auth_fields,
        get_valid_gmail_access_token=get_valid_gmail_access_token,
    )


# Gestionnaire HTTP principal de l'application
class Handler(http.server.SimpleHTTPRequestHandler):
    # Initialise le gestionnaire avec le répertoire racine du projet
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=PROJECT_ROOT, **kw)

    # Ajoute les en-têtes de contrôle de cache à chaque réponse
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    # Traite les requêtes HTTP GET
    def do_GET(self):
        if self.path == "/" or self.path.startswith("/index.html"):
            try:
                with open(RENDERER_INDEX, "rb") as f:
                    content = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)
                return
            except FileNotFoundError:
                self.send_error(404)
                return

        if self.path.startswith("/api/oauth/google/callback"):
            return handle_oauth_callback(
                self,
                pending_store=GOOGLE_OAUTH_PENDING,
                load_accounts=load_accounts,
                find_account_index_by_email=find_account_index_by_email,
                normalize_auth_fields=normalize_auth_fields,
                save_accounts=save_accounts,
                exchange_google_auth_code=exchange_google_auth_code,
                build_oauth_callback_page=build_oauth_callback_page,
                now_ts=lambda: int(time.time()),
            )

        if self.path == "/api/state":
            return self._json(loadAppState())
        if self.path == "/api/contacts":
            return self._json(loadContactsData())
        if self.path == "/api/annuaire":
            try:
                return self._json(_build_annuaire())
            except Exception as e:
                return self._json({"error": str(e)}, 500)
        if self.path == "/api/app-config":
            try:
                return self._json({"ok": True, **_get_app_install_config()})
            except Exception as e:
                return self._json({"error": str(e)}, 500)
        if self.path == "/api/system/check":
            try:
                return self._json(_build_system_diagnostics())
            except Exception as e:
                return self._json({"error": str(e)}, 500)
        if self.path == "/api/accounts":
            return self._json(load_accounts())
        if self.path == "/api/downloads/files":
            try:
                files = list_download_candidates()
                return self._json({
                    "ok": True,
                    "root": DOWNLOADS,
                    "count": len(files),
                    "files": files,
                })
            except Exception as e:
                return self._json({"error": str(e)}, 500)
        if self.path.startswith("/api/downloads/file?"):
            try:
                qs = parse_qs(urlparse(self.path).query)
                path_value = qs.get("path", [""])[0]
                file_path = _safe_download_path(path_value)
                content_type, _ = mimetypes.guess_type(file_path)
                content_type = content_type or "application/octet-stream"

                with open(file_path, "rb") as f:
                    payload = f.read()

                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Content-Disposition", f'inline; filename="{os.path.basename(file_path)}"')
                self.end_headers()
                self.wfile.write(payload)
                return
            except ValueError as ve:
                return self._json({"error": str(ve)}, 400)
            except Exception as e:
                return self._json({"error": str(e)}, 500)
        if self.path == "/api/inbox":
            # Rafraîchit en arrière-plan pour garder une UI instantanée.
            _schedule_mailbox_refresh()
            inbox = load_inbox_index()
            visible = [
                m for m in inbox
                if not m.get("deleted") and m.get("folder") != "sent" and _mailbox_of(m) == "inbox"
            ]
            visible.sort(key=lambda m: m.get("date_ts", 0), reverse=True)
            return self._json(visible)
        if self.path == "/api/inbox/commercial":
            _schedule_mailbox_refresh()
            inbox = load_inbox_index()
            visible = [
                m for m in inbox
                if not m.get("deleted") and m.get("folder") != "sent" and _mailbox_of(m) == "commercial"
            ]
            visible.sort(key=lambda m: m.get("date_ts", 0), reverse=True)
            return self._json(visible)
        if self.path == "/api/inbox/sent":
            inbox = load_inbox_index()
            sent = [m for m in inbox if m.get("folder") == "sent" and not m.get("deleted")]
            sent.sort(key=lambda m: m.get("date_ts", 0), reverse=True)
            return self._json(sent)
        if self.path.startswith("/api/mail/attachment?"):
            try:
                qs = parse_qs(urlparse(self.path).query)
                mail_id = qs.get("id", [""])[0]
                eml_file = qs.get("eml_file", [""])[0]
                idx_raw = qs.get("idx", [None])[0]
                filename = qs.get("name", [None])[0]
                idx = int(idx_raw) if idx_raw is not None else None

                inbox = load_inbox_index()
                mail = None
                if mail_id:
                    mail = next((m for m in inbox if m.get("id") == mail_id), None)
                if not mail and eml_file:
                    mail = next((m for m in inbox if m.get("eml_file") == eml_file), None)
                if not mail:
                    safe_eml = os.path.basename(eml_file or "")
                    if safe_eml and safe_eml.lower().endswith(".eml"):
                        inbox_match = next((m for m in inbox if m.get("eml_file") == safe_eml), None)
                        if inbox_match:
                            eml_path = resolve_eml_path(inbox_match)
                        else:
                            eml_path = os.path.join(MAILS_DIR, safe_eml)
                    else:
                        self.send_error(404)
                        return
                else:
                    eml_path = resolve_eml_path(mail)

                if not os.path.isfile(eml_path):
                    self.send_error(404)
                    return

                with open(eml_path, "rb") as f:
                    raw_bytes = f.read()
                msg = email_lib.message_from_bytes(raw_bytes, policy=email_policy.default)
                payload, resolved_name, content_type = get_attachment_payload(msg, index=idx, filename=filename)
                if payload is None:
                    self.send_error(404)
                    return
                content_type = content_type or "application/octet-stream"

                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Disposition", f'inline; filename="{resolved_name}"')
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            except Exception:
                self.send_error(500)
                return

        if self.path.startswith("/api/mail/by-eml?"):
            try:
                qs = parse_qs(urlparse(self.path).query)
                eml_file = (qs.get("eml_file", [""])[0] or "").strip()
                if not eml_file:
                    self.send_error(400)
                    return
                inbox = load_inbox_index()
                mail = next((m for m in inbox if m.get("eml_file") == eml_file), None)
                if mail:
                    mail = enrich_mail_from_eml(mail)
                    return self._json(mail)
                self.send_error(404)
                return
            except Exception:
                self.send_error(500)
                return

        if self.path.startswith("/api/mail/"):
            mail_id = self.path.split("/api/mail/")[1]
            inbox = load_inbox_index()
            mail = next((m for m in inbox if m.get("id") == mail_id), None)
            if mail:
                mail = enrich_mail_from_eml(mail)
                return self._json(mail)
            self.send_error(404)
            return

        super().do_GET()

    # Traite les requêtes HTTP POST
    def do_POST(self):
        try:
            raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            data = json.loads(raw) if raw else {}
        except (json.JSONDecodeError, ValueError):
            return self._json({"error": "JSON invalide"}, 400)

        if self.path == "/api/state":
            saveAppState(data)
            return self._json({"ok": True})

        if self.path == "/api/app-config":
            try:
                _save_app_install_config(data)
                return self._json({"ok": True, "requires_restart": True})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/run-mail-to-md":
            return self._json({"error": "Route supprimée"}, 410)

        if self.path == "/api/mail/summarize":
            try:
                text = ai_summarize_mail(data)
                return self._json({"ok": True, "text": text})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/reformulate":
            try:
                corrected = ai_reformulate(data)
                return self._json({"ok": True, "text": corrected})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/save-eml":
            try:
                filepath = save_eml_to_downloads(
                    data.get("from", ""),
                    data.get("to", ""),
                    data.get("subject", ""),
                    data.get("body", ""),
                    html_body=data.get("html_body", None)
                )
                return self._json({"ok": True, "path": filepath})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/generate-reminder":
            try:
                result = ai_generate_reminder(data)
                return self._json({"ok": True, "reminder": result})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/generate-reply":
            try:
                text = ai_generate_reply(data)
                return self._json({"ok": True, "text": text})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/accounts/save":
            try:
                accounts = data.get("accounts", [])
                for acc in accounts:
                    normalize_auth_fields(acc)
                    if (acc.get("provider", "") or "").lower() == "gmail_oauth":
                        acc["protocol"] = "imap"
                        acc["auth_type"] = "oauth2"
                        acc["username"] = acc.get("email", acc.get("username", ""))
                        acc["imap_server"] = "imap.gmail.com"
                        acc["imap_port"] = 993
                        acc["imap_ssl"] = True
                        acc["smtp_server"] = "smtp.gmail.com"
                        acc["smtp_port"] = 587
                        acc["smtp_ssl"] = False
                        acc["smtp_starttls"] = True
                        if not acc.get("oauth_redirect_uri"):
                            acc["oauth_redirect_uri"] = "http://127.0.0.1:8080/api/oauth/google/callback"
                        if not acc.get("oauth_scope"):
                            acc["oauth_scope"] = "https://mail.google.com/"
                save_accounts(accounts)
                return self._json({"ok": True})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/oauth/google/start":
            try:
                account_email = (data.get("email", "") or "").strip()
                requested_scope = (data.get("scope", "") or "").strip()
                if not account_email or "@" not in account_email:
                    return self._json({"error": "Adresse email invalide"}, 400)

                accounts = load_accounts()
                idx = find_account_index_by_email(accounts, account_email)
                if idx < 0:
                    return self._json({"error": "Compte introuvable"}, 404)

                account = normalize_auth_fields(accounts[idx])
                client_id = (account.get("oauth_client_id", "") or "").strip()
                client_secret = (account.get("oauth_client_secret", "") or "").strip()
                redirect_uri = (account.get("oauth_redirect_uri", "") or "").strip() or "http://127.0.0.1:8080/api/oauth/google/callback"
                scope = requested_scope or (account.get("oauth_scope", "") or "").strip() or GOOGLE_MAIL_SCOPE

                if not client_id:
                    return self._json({"error": "Client ID OAuth requis pour Gmail."}, 400)

                verifier, challenge = generate_pkce_pair()
                state = secrets.token_urlsafe(24)
                GOOGLE_OAUTH_PENDING[state] = {
                    "account_email": account_email,
                    "code_verifier": verifier,
                    "created_at": int(time.time()),
                }

                query = {
                    "client_id": client_id,
                    "redirect_uri": redirect_uri,
                    "response_type": "code",
                    "scope": scope,
                    "access_type": "offline",
                    "prompt": "consent",
                    "include_granted_scopes": "true",
                    "state": state,
                    "code_challenge": challenge,
                    "code_challenge_method": "S256",
                }
                auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(query)

                account["provider"] = "gmail_oauth"
                account["auth_type"] = "oauth2"
                account["protocol"] = "imap"
                account["username"] = account_email
                account["email"] = account_email
                account["oauth_redirect_uri"] = redirect_uri
                account["oauth_scope"] = scope
                if client_secret:
                    account["oauth_client_secret"] = client_secret
                accounts[idx] = account
                save_accounts(accounts)

                return self._json({"ok": True, "auth_url": auth_url})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/autoconfig":
            try:
                email_addr = data.get("email", "").strip()
                if not email_addr or "@" not in email_addr:
                    return self._json({"error": "Adresse email invalide"}, 400)
                result = autoconfig_email(email_addr)
                if result:
                    return self._json({"ok": True, "config": result})
                else:
                    domain = email_addr.split("@")[-1]
                    return self._json({"error": f"Aucune configuration trouvée pour {domain}"}, 404)
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/fetch-emails":
            try:
                new_count, errors = fetch_all_accounts()
                inbox = load_inbox_index()
                commercial_count = len([
                    m for m in inbox
                    if not m.get("deleted") and m.get("folder") != "sent" and _mailbox_of(m) == "commercial"
                ])
                return self._json({
                    "ok": True,
                    "new_count": new_count,
                    "errors": errors,
                    "commercial_count": commercial_count,
                })
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/mail/reclassify-commercial":
            try:
                _, _, moved = refresh_and_classify_local_mailboxes()
                return self._json({"ok": True, "moved": moved})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/commercial/keep":
            try:
                ids = data.get("ids", [])
                if not isinstance(ids, list) or not ids:
                    return self._json({"error": "ids manquants"}, 400)

                inbox = load_inbox_index()
                kept = 0
                for mail in inbox:
                    if mail.get("id") not in ids:
                        continue
                    if _mailbox_of(mail) != "commercial":
                        continue
                    if _move_mail_to_storage(mail, MAILS_DIR, "inbox", processed_override=False):
                        mail["commercial_override"] = "keep"
                        kept += 1

                save_inbox_index(inbox)
                return self._json({"ok": True, "kept": kept})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/mail/mark-commercial":
            try:
                mail_id = str(data.get("id", "") or "").strip()
                if not mail_id:
                    return self._json({"error": "id manquant"}, 400)

                inbox = load_inbox_index()
                mail = next((m for m in inbox if m.get("id") == mail_id), None)
                if not mail:
                    return self._json({"error": "Mail introuvable"}, 404)
                if mail.get("folder") == "sent" or mail.get("deleted"):
                    return self._json({"error": "Mail non classable"}, 400)

                sender = str(mail.get("from_email", "") or "").strip().lower()
                if not sender:
                    return self._json({"error": "Expediteur introuvable"}, 400)

                if not _move_mail_to_storage(mail, COMMERCIAL_DIR, "commercial", processed_override=True):
                    return self._json({"error": "Impossible de deplacer le mail"}, 500)

                mail["commercial_override"] = ""
                sender_rules = _load_commercial_senders()
                sender_rules.add(sender)
                _save_commercial_senders(sender_rules)
                save_inbox_index(inbox)
                return self._json({"ok": True, "sender": sender})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/commercial/delete-all":
            try:
                inbox = load_inbox_index()
                ids = [
                    m.get("id") for m in inbox
                    if not m.get("deleted") and m.get("folder") != "sent" and _mailbox_of(m) == "commercial"
                ]
                if not ids:
                    return self._json({"ok": True, "deleted": 0, "errors": []})
                result, code = delete_mails_batch(ids, delete_on_server=True)
                return self._json(result, code)
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/downloads/prepare-drop":
            try:
                path_value = data.get("path", "")
                short_name = data.get("short_name", "")
                description = data.get("description", "")
                if not str(description or "").strip():
                    return self._json({"error": "Description obligatoire"}, 400)

                prepared_path, filename = prepare_download_for_drag(path_value, short_name)
                return self._json({
                    "ok": True,
                    "prepared_path": prepared_path,
                    "filename": filename,
                })
            except ValueError as ve:
                return self._json({"error": str(ve)}, 400)
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/downloads/trash":
            try:
                path_value = data.get("path", "")
                move_file_to_trash(path_value)
                _schedule_downloads_refresh()
                return self._json({"ok": True})
            except ValueError as ve:
                return self._json({"error": str(ve)}, 400)
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/downloads/open-onlyoffice":
            try:
                path_value = data.get("path", "")
                cmd = open_file_in_onlyoffice(path_value)
                return self._json({"ok": True, "cmd": cmd})
            except ValueError as ve:
                return self._json({"error": str(ve)}, 400)
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/downloads/update-metadata":
            try:
                path_value = data.get("path", "")
                name1 = data.get("name1", "")
                name2 = data.get("name2", "")
                description = data.get("description", "")
                file_data = update_download_metadata(path_value, name1, name2, description)
                _schedule_downloads_refresh()
                return self._json({"ok": True, "file": file_data})
            except ValueError as ve:
                return self._json({"error": str(ve)}, 400)
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/downloads/mark-deposited":
            try:
                path_value = data.get("path", "")
                deposited = bool(data.get("deposited", True))
                row = mark_download_deposited(path_value, deposited)
                _schedule_downloads_refresh()
                return self._json({"ok": True, "row": row})
            except ValueError as ve:
                return self._json({"error": str(ve)}, 400)
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/downloads/trash-deposited":
            try:
                result = trash_deposited_downloads()
                return self._json(result)
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/downloads/drop-candidates":
            try:
                files = get_download_candidates_for_drop()
                return self._json({
                    "ok": True,
                    "root": DOWNLOADS,
                    "csv_path": _downloads_metadata_csv_path(),
                    "count": len(files),
                    "files": files,
                })
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/send-email":
            try:
                from_addr = data.get("from", "")
                to_addr = data.get("to", "")
                subject = data.get("subject", "")
                body = data.get("body", "")
                cc = data.get("cc", "")
                attachments = data.get("attachments", None)
                html_body = data.get("html_body", None)
                account = find_account_by_email(from_addr)
                if not account:
                    return self._json({"error": f"Aucun compte configuré pour {from_addr}"}, 400)
                send_email_smtp(account, to_addr, subject, body, cc, attachments=attachments, html_body=html_body)
                return self._json({"ok": True})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/mail/mark-processed":
            try:
                mail_id = data.get("id", "")
                processed = bool(data.get("processed", True))
                if not mail_id:
                    return self._json({"error": "id manquant"}, 400)

                inbox = load_inbox_index()
                updated = False
                for m in inbox:
                    if m.get("id") == mail_id:
                        m["processed"] = processed
                        updated = True
                        break

                if not updated:
                    return self._json({"error": "Mail introuvable"}, 404)

                save_inbox_index(inbox)
                return self._json({"ok": True})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/mail/delete":
            try:
                mail_id = data.get("id", "")
                delete_on_server = True
                inbox = load_inbox_index()
                mail = next((m for m in inbox if m.get("id") == mail_id), None)
                if not mail:
                    return self._json({"error": "Mail introuvable"}, 404)

                remote_missing = False
                remote_error = None

                if delete_on_server and mail.get("uid") and mail.get("account"):
                    account = find_account_by_email(mail["account"])
                    if account:
                        try:
                            remote_deleted = delete_mail_on_server(account, mail["uid"])
                            if remote_deleted is False:
                                remote_missing = True
                        except Exception as del_err:
                            remote_error = str(del_err)

                if delete_on_server and remote_error:
                    return self._json({
                        "ok": False,
                        "error": f"Suppression distante impossible: {remote_error}",
                        "remote": {
                            "already_missing": remote_missing,
                            "error": remote_error,
                        },
                    }, 502)

                eml_path = resolve_eml_path(mail)
                if os.path.isfile(eml_path):
                    os.remove(eml_path)

                if mail.get("uid") and mail.get("account"):
                    seen = load_seen_uids()
                    for key, uids in seen.items():
                        if mail["uid"] in uids:
                            uids.remove(mail["uid"])
                    save_seen_uids(seen)

                mail["deleted"] = True
                save_inbox_index(inbox)

                return self._json({
                    "ok": True,
                    "remote": {
                        "already_missing": remote_missing,
                        "error": remote_error,
                    },
                })
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/mail/delete-batch":
            try:
                ids = data.get("ids", [])
                result, code = delete_mails_batch(ids, delete_on_server=True)
                return self._json(result, code)
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/contacts/import":
            try:
                csv_content = data.get("csv", "")
                if not csv_content:
                    return self._json({"error": "Aucun contenu CSV"}, 400)
                with open(CONTACTS_CSV, "w", encoding="utf-8") as f:
                    f.write(csv_content)
                new_contacts = loadContactsData()
                return self._json({"ok": True, "count": len(new_contacts)})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        self.send_error(404)

    # Sérialise un objet en JSON et l'envoie comme réponse HTTP
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # Supprime la journalisation des requêtes HTTP
    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    import signal
    import socketserver
    import traceback

    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr = sys.stdout

    # Gestionnaire de signal pour arrêt propre du serveur
    def _sig_handler(signum, frame):
        print(f"⚠️ Received signal {signum}, shutting down", flush=True)
        sys.exit(0)

    signal.signal(signal.SIGTERM, _sig_handler)
    signal.signal(signal.SIGINT, _sig_handler)

    print(f"🚀 Todo → http://localhost:{PORT}", flush=True)
    try:
        socketserver.TCPServer.allow_reuse_address = True
        server = http.server.ThreadingHTTPServer(("", PORT), Handler)
        print(f"✅ Server bound to port {PORT}, serving…", flush=True)
        server.serve_forever()
    except SystemExit as se:
        code = se.code if se.code is not None else 0
        if code == 0:
            print("🛑 Server stopped cleanly.", flush=True)
        else:
            print(f"❌ Server exited with code {code}", flush=True)
        sys.exit(code)
    except Exception as exc:
        print(f"❌ Server crashed: {type(exc).__name__}: {exc}", flush=True)
        traceback.print_exc(file=sys.stdout)
        sys.exit(1)
