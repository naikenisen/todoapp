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
from urllib.parse import parse_qs, urlparse
from datetime import datetime
from email import policy as email_policy
from email.utils import getaddresses

from app_config import (
    APP_DATA_DIR,
    APP_ENV_FILE,
    APP_RUNTIME_CONFIG_FILE,
    CONTACTS_CSV,
    DATA,
    DIR,
    ISENAPP_DATA,
    GOOGLE_MAIL_SCOPE,
    LOG_FILE,
    MAILS_DIR,
    PORT,
    PROJECT_ROOT,
    RENDERER_INDEX,
)

ATTACHMENTS_DIR = "/home/naiken/attachements"
os.makedirs(ATTACHMENTS_DIR, exist_ok=True)
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
    load_inbox_index,
    load_seen_uids,
    parse_email_metadata,
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

    # 2) Extraire les personnes depuis les fichiers .eml du dossier mails
    if os.path.isdir(MAILS_DIR):
        for fname in os.listdir(MAILS_DIR):
            if not fname.lower().endswith(".eml"):
                continue
            fpath = os.path.join(MAILS_DIR, fname)
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
            "vault_dir": ISENAPP_DATA,
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
    vault_dir = _clean_path(paths_in.get("vault_dir", ""), ISENAPP_DATA)

    runtime_cfg = _read_runtime_config_file()
    runtime_cfg["paths"] = {
        "mails_dir": mails_dir,
        "vault_dir": vault_dir,
    }
    runtime_cfg["updated_at"] = datetime.utcnow().isoformat() + "Z"

    os.makedirs(APP_DATA_DIR, exist_ok=True)
    os.makedirs(mails_dir, exist_ok=True)
    os.makedirs(os.path.join(vault_dir, "mails"), exist_ok=True)
    os.makedirs(os.path.join(vault_dir, "attachements"), exist_ok=True)

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
        if self.path == "/api/inbox":
            inbox = load_inbox_index()
            visible = [m for m in inbox if not m.get("deleted") and m.get("folder") != "sent"]
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
                        eml_path = os.path.join(MAILS_DIR, safe_eml)
                    else:
                        self.send_error(404)
                        return
                else:
                    eml_path = os.path.join(MAILS_DIR, mail.get("eml_file", ""))

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

        if self.path == "/api/mail/save-classified-attachment":
            try:
                mail_id = data.get("id", "")
                att_idx = data.get("att_idx")
                att_name = data.get("att_name", "")
                doc_type = data.get("type", "document")
                n1 = data.get("n1", "")
                n2 = data.get("n2", "")
                sender = data.get("sender", "inconnu")
                mail_date = data.get("date", "")

                if att_idx is None:
                    return self._json({"error": "att_idx requis"}, 400)

                inbox = load_inbox_index()
                mail = next((m for m in inbox if m.get("id") == mail_id), None)
                if not mail:
                    return self._json({"error": "Mail introuvable"}, 404)

                eml_path = os.path.join(MAILS_DIR, mail.get("eml_file", ""))
                if not os.path.isfile(eml_path):
                    return self._json({"error": "Fichier .eml introuvable"}, 404)

                with open(eml_path, "rb") as f:
                    msg = email_lib.message_from_bytes(f.read(), policy=email_policy.default)

                payload_data, resolved_name, _ct = get_attachment_payload(msg, index=int(att_idx), filename=att_name)
                if payload_data is None:
                    return self._json({"error": "Pièce jointe introuvable"}, 404)

                ext = os.path.splitext(resolved_name)[1].lower() if resolved_name else ""
                safe_sender = re.sub(r'[\\/*?:"<>|@\s]+', '_', sender.strip())[:50]
                safe_type = re.sub(r'[\\/*?:"<>|]+', '_', doc_type.strip())
                safe_n1 = re.sub(r'[\\/*?:"<>|]+', '_', n1.strip()) if n1 else ""
                safe_n2 = re.sub(r'[\\/*?:"<>|]+', '_', n2.strip()) if n2 else ""

                if not mail_date:
                    mail_date = datetime.now().strftime("%Y-%m-%d")
                else:
                    try:
                        from email.utils import parsedate_to_datetime as _pdt
                        dt = _pdt(mail_date)
                        mail_date = dt.strftime("%Y-%m-%d")
                    except Exception:
                        try:
                            mail_date = mail_date[:10]
                        except Exception:
                            mail_date = datetime.now().strftime("%Y-%m-%d")

                parts = [mail_date, safe_type, safe_sender]
                if safe_n1:
                    parts.append(safe_n1)
                if safe_n2:
                    parts.append(safe_n2)
                new_name = "-".join(parts) + ext

                dest_path = os.path.join(ATTACHMENTS_DIR, new_name)
                counter = 1
                while os.path.exists(dest_path):
                    new_name = "-".join(parts) + f"_{counter}" + ext
                    dest_path = os.path.join(ATTACHMENTS_DIR, new_name)
                    counter += 1

                with open(dest_path, "wb") as f:
                    f.write(payload_data)

                return self._json({"ok": True, "path": dest_path, "filename": new_name})
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
                return self._json({
                    "ok": True,
                    "new_count": new_count,
                    "errors": errors
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
                delete_on_server = data.get("delete_on_server", False)
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

                eml_path = os.path.join(MAILS_DIR, mail.get("eml_file", ""))
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
                delete_on_server = data.get("delete_on_server", False)
                if not ids or not isinstance(ids, list):
                    return self._json({"error": "ids manquants"}, 400)
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
                    eml_path = os.path.join(MAILS_DIR, mail.get("eml_file", ""))
                    if os.path.isfile(eml_path):
                        os.remove(eml_path)
                    if mail.get("uid"):
                        for key, uids in seen.items():
                            if mail["uid"] in uids:
                                uids.remove(mail["uid"])
                                seen_changed = True
                    mail["deleted"] = True
                    deleted += 1
                if seen_changed:
                    save_seen_uids(seen)
                save_inbox_index(inbox)
                return self._json({
                    "ok": True,
                    "deleted": deleted,
                    "errors": errors,
                    "remote": {
                        "already_missing": remote_missing,
                        "failed": remote_failed,
                    },
                })
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
        server = http.server.HTTPServer(("", PORT), Handler)
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
