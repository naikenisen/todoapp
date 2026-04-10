#!/usr/bin/env python3
"""Serveur HTTP principal de l'application ISENAPP (Todo & Mail).

Point d'entrée du backend : démarre un serveur HTTP stdlib et route
les requêtes GET/POST vers les services métier appropriés.  Toute la
logique métier est déléguée aux modules spécialisés.

Dépendances internes :
    - app_config          : chemins et constantes de configuration
    - account_store       : CRUD des comptes email
    - json_store          : lecture/écriture atomique JSON
    - mail_utils          : parsing email, .eml I/O, seen UIDs, inbox index
    - mail_service        : protocoles POP3/IMAP/SMTP
    - google_calendar_service : OAuth2 Google (PKCE, tokens)
    - calendar_routes     : handler HTTP pour le callback OAuth Google
    - ai_service          : appels IA Google Gemini
    - graph_service       : graphe de connaissances et export email → Markdown
    - autoconfig_service  : auto-détection IMAP/SMTP (Mozilla Autoconfig)

Dépendances externes :
    - http.server (stdlib)
"""

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
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
from urllib.parse import parse_qs, urlparse
from datetime import datetime
from email import policy as email_policy

from app_config import (
    APP_DATA_DIR,
    APP_ENV_FILE,
    APP_RUNTIME_CONFIG_FILE,
    CONTACTS_CSV,
    DATA,
    DIR,
    GRAPH_ATT_DIR,
    GRAPH_MD_DIR,
    ISENAPP_DATA,
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
from ai_service import ai_generate_reminder, ai_generate_reply, ai_reformulate
from graph_service import export_email_to_graph, read_vault_file, scan_vault_graph
from autoconfig_service import autoconfig_email

# ── Neo4j / RAG (lazy, non-bloquant si Neo4j absent) ─
_neo4j_driver = None
_neo4j_embedder = None
_neo4j_available = None  # None = not checked yet
_neo4j_retry_after = 0.0
_neo4j_ingest_thread = None
_neo4j_ingest_lock = threading.Lock()
_neo4j_ingest_state = {
    "running": False,
    "phase": "idle",
    "processed": 0,
    "total": 0,
    "ingested": 0,
    "current_file": "",
    "source": "",
    "error": "",
    "finished": False,
}


def _mailchat_log(message: str) -> None:
    print(f"[mailchat] {message}", flush=True)


def _resolve_eml_from_md_source(source_name: str) -> str:
    """Résout un nom source .md vers son .eml via frontmatter `eml_file:`."""
    src = (source_name or "").strip()
    if not src.lower().endswith(".md"):
        return ""
    safe_name = os.path.basename(src)
    if safe_name != src:
        return ""

    md_path = os.path.join(GRAPH_MD_DIR, safe_name)
    if not os.path.isfile(md_path):
        return ""

    try:
        with open(md_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read(4096)
    except Exception:
        return ""

    # Frontmatter simple: ligne `eml_file: xxx.eml`
    for line in content.splitlines():
        line = line.strip()
        if line.startswith("eml_file:"):
            candidate = line.split(":", 1)[1].strip()
            candidate = os.path.basename(candidate)
            if candidate.lower().endswith(".eml"):
                return candidate
    return ""


def _parse_frontmatter(content: str) -> dict:
    """Parse YAML frontmatter from a markdown file content."""
    fm = {}
    if not content.startswith("---"):
        return fm
    end = content.find("---", 3)
    if end == -1:
        return fm
    block = content[3:end]
    for line in block.splitlines():
        if ":" in line:
            key, _, val = line.partition(":")
            fm[key.strip()] = val.strip()
    return fm


def _list_vault_mails():
    """List all markdown mails from the vault with frontmatter metadata."""
    mails = []
    if not os.path.isdir(GRAPH_MD_DIR):
        return mails
    for fname in sorted(os.listdir(GRAPH_MD_DIR)):
        if not fname.lower().endswith(".md"):
            continue
        fpath = os.path.join(GRAPH_MD_DIR, fname)
        try:
            with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            fm = _parse_frontmatter(content)
            body = content
            if content.startswith("---"):
                end = content.find("---", 3)
                if end != -1:
                    body = content[end + 3:].strip()
            date_val = fm.get("date", "")
            from_val = fm.get("from", "")
            to_val = fm.get("to", "")
            subject_val = fm.get("subject", "")
            # Fallback: extract metadata from body text for older files
            if not date_val or not from_val:
                for line in body.splitlines()[:10]:
                    if not date_val and "Date" in line:
                        match = re.search(r"(\d{4}-\d{2}-\d{2})", line)
                        if match:
                            date_val = match.group(1)
                    if not from_val and "De" in line:
                        # Example: **👤 De :** [[Alice Bob]]
                        clean = line.replace("[[", "").replace("]]", "")
                        clean = re.sub(r"^\*\*.*?De\s*:\*\*\s*", "", clean).strip()
                        if clean:
                            from_val = clean
                    if not to_val and "À" in line:
                        # Example: **👥 À :** [[foo]], [[bar]]
                        clean = line.replace("[[", "").replace("]]", "")
                        clean = re.sub(r"^\*\*.*?À\s*:\*\*\s*", "", clean).strip()
                        if clean:
                            to_val = clean
            if not subject_val:
                for line in body.splitlines()[:5]:
                    if line.startswith("# "):
                        subject_val = line[2:].strip()
                        break
            mails.append({
                "filename": fname,
                "subject": subject_val or fname.replace(".md", ""),
                "date": date_val,
                "from": from_val,
                "to": to_val,
                "eml_file": fm.get("eml_file", ""),
                "tags": fm.get("tags", ""),
                "body": body,
            })
        except Exception:
            continue
    return mails


def _ingest_progress_cb(ingested: int, processed: int, total: int, fname: str, source: str) -> None:
    with _neo4j_ingest_lock:
        _neo4j_ingest_state["processed"] = processed
        _neo4j_ingest_state["total"] = total
        _neo4j_ingest_state["ingested"] = ingested
        _neo4j_ingest_state["current_file"] = fname
        _neo4j_ingest_state["source"] = source


def _run_neo4j_ingest_job(mode: str) -> None:
    global _neo4j_ingest_thread
    try:
        driver, embedder = _get_neo4j()
        if not driver:
            raise RuntimeError("Neo4j non disponible")

        from neo4j_ingest import (
            init_schema,
            ingest_eml_directory,
            ingest_vault_directory,
            count_eml_files,
            count_vault_files,
        )

        init_schema(driver, embedding_dim=embedder.dimension)
        total_ingested = 0

        if mode in ("eml", "both"):
            from app_config import MAILS_DIR as _MAILS_DIR
            total_files = count_eml_files(_MAILS_DIR)
            with _neo4j_ingest_lock:
                _neo4j_ingest_state["phase"] = "eml"
                _neo4j_ingest_state["processed"] = 0
                _neo4j_ingest_state["total"] = total_files
            total_ingested += ingest_eml_directory(driver, embedder, _MAILS_DIR, progress_cb=_ingest_progress_cb)

        if mode in ("vault", "both"):
            from app_config import GRAPH_MD_DIR
            total_files = count_vault_files(GRAPH_MD_DIR)
            with _neo4j_ingest_lock:
                _neo4j_ingest_state["phase"] = "vault"
                _neo4j_ingest_state["processed"] = 0
                _neo4j_ingest_state["total"] = total_files
            total_ingested += ingest_vault_directory(driver, embedder, GRAPH_MD_DIR, progress_cb=_ingest_progress_cb)

        with _neo4j_ingest_lock:
            _neo4j_ingest_state["running"] = False
            _neo4j_ingest_state["finished"] = True
            _neo4j_ingest_state["phase"] = "done"
            _neo4j_ingest_state["ingested"] = total_ingested
            _neo4j_ingest_state["error"] = ""
        _mailchat_log(f"sync done: {total_ingested} email(s) ingérés")
    except Exception as exc:
        with _neo4j_ingest_lock:
            _neo4j_ingest_state["running"] = False
            _neo4j_ingest_state["finished"] = True
            _neo4j_ingest_state["phase"] = "error"
            _neo4j_ingest_state["error"] = str(exc)
        _mailchat_log(f"sync error: {exc}")
    finally:
        _neo4j_ingest_thread = None


def _get_neo4j():
    """Lazy init du driver Neo4j + embedder. Retourne (driver, embedder) ou (None, None)."""
    global _neo4j_driver, _neo4j_embedder, _neo4j_available, _neo4j_retry_after
    now = time.time()
    if _neo4j_available is False and now < _neo4j_retry_after:
        return None, None
    if _neo4j_driver is not None:
        return _neo4j_driver, _neo4j_embedder
    try:
        from neo4j_ingest import connect_neo4j, EmbeddingService
        _neo4j_driver = connect_neo4j()
        _neo4j_embedder = EmbeddingService()
        _neo4j_available = True
        _neo4j_retry_after = 0.0
        return _neo4j_driver, _neo4j_embedder
    except (Exception, SystemExit) as exc:
        logger.warning("Neo4j non disponible: %s", exc)
        _neo4j_available = False
        _neo4j_retry_after = now + 10.0
        return None, None


# In-memory OAuth state store (state -> metadata) for current server process.
GOOGLE_OAUTH_PENDING = {}

logging.basicConfig(
    filename=LOG_FILE,
    format="%(asctime)s [%(levelname)s] %(message)s",
    level=logging.ERROR,
)
logger = logging.getLogger("todoapp")


def loadAppState():
    return read_json_with_backup(DATA, {"sections": [], "settings": {}})


def saveAppState(data):
    atomic_write_json(DATA, data)


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


_LOCAL_ENV_KEYS = [
    "NEO4J_URI",
    "NEO4J_USER",
    "NEO4J_PASSWORD",
    "GEMINI_API_KEY",
    "GEMINI_MODEL",
    "GEMINI_FALLBACK_MODELS",
    "EMBEDDING_MODEL",
]


def _read_runtime_env_file() -> dict:
    """Read key/value pairs from local runtime .env file."""
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


def _write_runtime_env_file(values: dict) -> None:
    """Persist selected runtime env values to local .env file."""
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


def _get_app_install_config() -> dict:
    """Build config payload for local installation settings UI."""
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
            "vault_mails_dir": GRAPH_MD_DIR,
            "vault_attachments_dir": GRAPH_ATT_DIR,
            "log_file": LOG_FILE,
        },
        "env": {
            "NEO4J_URI": env_vals.get("NEO4J_URI", os.getenv("NEO4J_URI", "bolt://localhost:7687")),
            "NEO4J_USER": env_vals.get("NEO4J_USER", os.getenv("NEO4J_USER", "neo4j")),
            "NEO4J_PASSWORD": env_vals.get("NEO4J_PASSWORD", os.getenv("NEO4J_PASSWORD", "")),
            "GEMINI_API_KEY": env_vals.get("GEMINI_API_KEY", os.getenv("GEMINI_API_KEY", "")),
            "GEMINI_MODEL": env_vals.get("GEMINI_MODEL", os.getenv("GEMINI_MODEL", "gemma-3-27b-it")),
            "GEMINI_FALLBACK_MODELS": env_vals.get("GEMINI_FALLBACK_MODELS", os.getenv("GEMINI_FALLBACK_MODELS", "gemini-2.5-flash")),
            "EMBEDDING_MODEL": env_vals.get("EMBEDDING_MODEL", os.getenv("EMBEDDING_MODEL", "intfloat/multilingual-e5-base")),
        },
    }


def _save_app_install_config(payload: dict) -> None:
    """Persist runtime config and env overrides to writable local files."""
    payload = payload or {}
    paths_in = payload.get("paths", {}) if isinstance(payload.get("paths", {}), dict) else {}
    env_in = payload.get("env", {}) if isinstance(payload.get("env", {}), dict) else {}

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


def _read_runtime_config_file() -> dict:
    """Read runtime JSON config from app data.

    Returns an empty dict when missing/unreadable.
    """
    if not os.path.isfile(APP_RUNTIME_CONFIG_FILE):
        return {}
    try:
        with open(APP_RUNTIME_CONFIG_FILE, "r", encoding="utf-8", errors="replace") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


# ── Hard-coded Neo4j Docker characteristics (not user-editable) ──
_NEO4J_DOCKER_FIXED = {
    "container_name": "neurail-neo4j",
    "image": "neo4j:latest",
    "bolt_port": 7687,
    "http_port": 7474,
    "volume": "neurail-neo4j-data",
}


def _neo4j_docker_default_config() -> dict:
    return {"enabled": True, **_NEO4J_DOCKER_FIXED}


def _get_neo4j_docker_config() -> dict:
    """Return the fixed Neo4j Docker config.  Container characteristics are
    hard-coded so every installation uses the exact same container."""
    return _neo4j_docker_default_config()


def _save_neo4j_docker_config(cfg: dict) -> dict:
    """Persist only the enabled flag; container characteristics are fixed."""
    merged = _get_neo4j_docker_config()
    if isinstance(cfg, dict):
        merged["enabled"] = bool(cfg.get("enabled", merged["enabled"]))
    current = _read_runtime_config_file()
    current["neo4j_docker"] = merged
    current["updated_at"] = datetime.utcnow().isoformat() + "Z"
    with open(APP_RUNTIME_CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(current, f, ensure_ascii=False, indent=2)
    return merged


def _docker_permission_denied(output: str) -> bool:
    out = (output or "").lower()
    return "permission denied" in out and "docker.sock" in out


def _docker_daemon_active_via_service() -> bool:
    # Some environments block docker client access but still expose service state.
    if shutil.which("systemctl"):
        res = _run_cmd(["systemctl", "is-active", "docker"], timeout=8)
        return (res.get("output") or "").strip().lower() == "active"
    if shutil.which("service"):
        res = _run_cmd(["service", "docker", "status"], timeout=8)
        out = (res.get("output") or "").lower()
        return "active (running)" in out or "is running" in out
    return False


def _neo4j_docker_status() -> dict:
    cfg = _get_neo4j_docker_config()
    docker_bin = bool(shutil.which("docker"))
    info_res = _run_cmd(["docker", "info"], timeout=10) if docker_bin else {"ok": False, "output": ""}
    docker_client_ok = info_res.get("ok", False)
    daemon_ok = docker_client_ok or _docker_daemon_active_via_service()
    permission_denied = _docker_permission_denied(info_res.get("output", "")) if docker_bin else False
    bolt_port = int(cfg.get("bolt_port", 7687))
    reachable = _can_open_tcp("127.0.0.1", bolt_port)
    if not docker_bin:
        return {"ok": False, "docker_available": False, "daemon_running": False, "exists": False, "running": False, "config": cfg, "neo4j_reachable": reachable, "error": "docker introuvable"}
    if not daemon_ok:
        return {"ok": False, "docker_available": True, "daemon_running": False, "exists": False, "running": False, "config": cfg, "neo4j_reachable": reachable, "error": "daemon docker non démarré"}

    if permission_denied:
        if reachable:
            return {
                "ok": True,
                "docker_available": True,
                "daemon_running": True,
                "docker_access": False,
                "exists": True,
                "running": True,
                "config": cfg,
                "neo4j_reachable": True,
            }
        return {
            "ok": False,
            "docker_available": True,
            "daemon_running": True,
            "docker_access": False,
            "exists": False,
            "running": False,
            "config": cfg,
            "neo4j_reachable": False,
            "error": "daemon docker actif mais accès au socket refusé (ajoute l'utilisateur au groupe docker, puis reconnecte la session)",
        }

    name = cfg["container_name"]
    inspect = _run_cmd(["docker", "inspect", name], timeout=8)
    if not inspect.get("ok"):
        if reachable:
            return {
                "ok": True,
                "docker_available": True,
                "daemon_running": True,
                "docker_access": True,
                "exists": True,
                "running": True,
                "config": cfg,
                "neo4j_reachable": True,
            }
        return {
            "ok": True,
            "docker_available": True,
            "daemon_running": True,
            "docker_access": True,
            "exists": False,
            "running": False,
            "config": cfg,
            "neo4j_reachable": reachable,
        }

    running_res = _run_cmd(["docker", "inspect", "-f", "{{.State.Running}}", name], timeout=5)
    running = str(running_res.get("output", "")).strip().lower() == "true"
    health_res = _run_cmd(["docker", "inspect", "-f", "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", name], timeout=5)
    return {
        "ok": True,
        "docker_available": True,
        "daemon_running": True,
        "docker_access": True,
        "exists": True,
        "running": running,
        "health": health_res.get("output", ""),
        "config": cfg,
        "neo4j_reachable": reachable,
    }


def _neo4j_docker_ensure_container(cfg: dict, payload: dict | None = None) -> dict:
    status = _neo4j_docker_status()
    if not status.get("docker_available"):
        raise RuntimeError(status.get("error") or "Docker indisponible")
    if not status.get("daemon_running"):
        raise RuntimeError(status.get("error") or "Daemon Docker indisponible")

    if status.get("exists"):
        return status

    payload = payload or {}
    env_vals = _read_runtime_env_file()
    user = env_vals.get("NEO4J_USER", os.getenv("NEO4J_USER", "neo4j"))
    password = str(payload.get("neo4j_password", "") or "").strip()
    if not password:
        password = env_vals.get("NEO4J_PASSWORD", os.getenv("NEO4J_PASSWORD", ""))

    # If password is supplied from UI action, persist it for next runs.
    if str(payload.get("neo4j_password", "") or "").strip():
        _write_runtime_env_file({"NEO4J_PASSWORD": password})
        os.environ["NEO4J_PASSWORD"] = password

    if not password:
        raise RuntimeError("NEO4J_PASSWORD vide: renseigne-le dans Paramètres > Installation locale.")

    bolt_port = int(cfg.get("bolt_port", 7687))
    http_port = int(cfg.get("http_port", 7474))

    run_res = _run_cmd([
        "docker", "run", "-d",
        "--name", cfg["container_name"],
        "-p", f"{cfg['http_port']}:7474",
        "-p", f"{cfg['bolt_port']}:7687",
        "-v", f"{cfg['volume']}:/data",
        "-e", f"NEO4J_AUTH={user}/{password}",
        cfg["image"],
    ], timeout=25)
    if not run_res.get("ok"):
        raise RuntimeError(run_res.get("output") or "Impossible de créer le conteneur Neo4j")
    return _neo4j_docker_status()


def _start_docker_daemon() -> dict:
    """Try multiple strategies to start Docker daemon from a desktop app context."""
    if _run_cmd(["docker", "info"], timeout=8).get("ok"):
        return {"ok": True, "method": "already-running", "details": "daemon déjà actif"}
    if _docker_daemon_active_via_service():
        return {
            "ok": True,
            "method": "service-active",
            "details": "daemon actif (accès docker potentiellement restreint)",
        }

    attempts = [
        ["systemctl", "start", "docker"],
        ["sudo", "-n", "systemctl", "start", "docker"],
        ["pkexec", "systemctl", "start", "docker"],
        ["service", "docker", "start"],
    ]
    errors = []

    for cmd in attempts:
        if not shutil.which(cmd[0]):
            continue

        res = _run_cmd(cmd, timeout=20)
        if not res.get("ok"):
            details = (res.get("output") or "").strip() or "échec sans sortie"
            errors.append(f"{' '.join(cmd)} -> {details}")
            continue

        # Give daemon a brief startup window and verify with docker info or service state.
        for _ in range(8):
            if _run_cmd(["docker", "info"], timeout=8).get("ok") or _docker_daemon_active_via_service():
                return {
                    "ok": True,
                    "method": " ".join(cmd),
                    "details": "daemon démarré",
                }
            time.sleep(0.5)

        errors.append(f"{' '.join(cmd)} -> commande OK mais daemon non joignable")

    return {
        "ok": False,
        "method": "",
        "details": " | ".join(errors) if errors else "aucune méthode disponible sur ce système",
    }


def _neo4j_docker_action(action: str, payload: dict | None = None) -> dict:
    payload = payload or {}
    cfg = _get_neo4j_docker_config()
    name = cfg["container_name"]

    if action == "start":
        st = _neo4j_docker_ensure_container(cfg, payload)
        if st.get("exists") and not st.get("running"):
            res = _run_cmd(["docker", "start", name], timeout=20)
            if not res.get("ok"):
                raise RuntimeError(res.get("output") or "Echec du démarrage du conteneur")
        return _neo4j_docker_status()

    if action == "stop":
        st = _neo4j_docker_status()
        if st.get("exists") and st.get("running"):
            res = _run_cmd(["docker", "stop", name], timeout=20)
            if not res.get("ok"):
                raise RuntimeError(res.get("output") or "Echec de l'arrêt du conteneur")
        return _neo4j_docker_status()

    if action == "restart":
        st = _neo4j_docker_action("start", payload)
        res = _run_cmd(["docker", "restart", name], timeout=25)
        if not res.get("ok"):
            raise RuntimeError(res.get("output") or "Echec du redémarrage du conteneur")
        return _neo4j_docker_status()

    if action == "reinstall":
        if not bool(payload.get("confirm", False)):
            raise RuntimeError("Confirmation requise pour la réinstallation")
        remove_volume = bool(payload.get("remove_volume", False))
        st = _neo4j_docker_status()
        if st.get("exists"):
            _run_cmd(["docker", "rm", "-f", name], timeout=25)
        if remove_volume:
            _run_cmd(["docker", "volume", "rm", "-f", cfg["volume"]], timeout=25)
        _neo4j_docker_ensure_container(cfg, payload)
        return _neo4j_docker_status()

    if action == "change-password":
        old_password = str(payload.get("old_password", "") or "")
        new_password = str(payload.get("new_password", "") or "")
        if not old_password or not new_password:
            raise RuntimeError("Ancien et nouveau mot de passe requis")
        if len(new_password) < 8:
            raise RuntimeError("Le nouveau mot de passe doit contenir au moins 8 caractères")

        st = _neo4j_docker_action("start", payload)
        if not st.get("running"):
            raise RuntimeError("Le conteneur Neo4j doit être en cours d'exécution")

        escaped_new = new_password.replace("'", "\\'")
        cypher = f"ALTER USER neo4j SET PASSWORD '{escaped_new}'"
        res = _run_cmd([
            "docker", "exec", name,
            "cypher-shell", "-u", "neo4j", "-p", old_password,
            cypher,
        ], timeout=20)
        if not res.get("ok"):
            raise RuntimeError(res.get("output") or "Impossible de changer le mot de passe Neo4j")

        _write_runtime_env_file({"NEO4J_PASSWORD": new_password})
        os.environ["NEO4J_PASSWORD"] = new_password
        return _neo4j_docker_status()

    if action == "start-daemon":
        if not shutil.which("docker"):
            raise RuntimeError("Docker CLI introuvable. Installe Docker Engine puis réessaie.")

        start_res = _start_docker_daemon()
        status = _neo4j_docker_status()
        if not start_res.get("ok") or not status.get("daemon_running"):
            details = start_res.get("details") or "raison inconnue"
            raise RuntimeError(
                "Impossible de démarrer le daemon Docker automatiquement. "
                f"Détails: {details}. "
                "Essaie en terminal: sudo systemctl start docker. "
                "Si nécessaire, ajoute ton utilisateur au groupe docker: sudo usermod -aG docker $USER"
            )
        return status

    raise RuntimeError(f"Action Docker Neo4j inconnue: {action}")


def _run_cmd(args: list[str], timeout: int = 8) -> dict:
    """Run a command safely and capture output for diagnostics."""
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        out = ((p.stdout or "") + "\n" + (p.stderr or "")).strip()
        return {"ok": p.returncode == 0, "code": p.returncode, "output": out}
    except FileNotFoundError:
        return {"ok": False, "code": None, "output": "commande introuvable"}
    except Exception as exc:
        return {"ok": False, "code": None, "output": str(exc)}


def _parse_neo4j_host_port(uri: str) -> tuple[str, int]:
    raw = (uri or "bolt://localhost:7687").strip()
    parsed = urlparse(raw)
    host = parsed.hostname or "localhost"
    port = int(parsed.port or 7687)
    return host, port


def _can_open_tcp(host: str, port: int, timeout: float = 1.5) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False


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


def _build_system_diagnostics() -> dict:
    env_vals = _read_runtime_env_file()
    neo4j_uri = env_vals.get("NEO4J_URI", os.getenv("NEO4J_URI", "bolt://localhost:7687"))
    host, port = _parse_neo4j_host_port(neo4j_uri)

    node_check = _run_cmd(["node", "--version"])
    python_check = _run_cmd(["python3", "--version"])
    pip_check = _run_cmd(["python3", "-m", "pip", "--version"])
    docker_check = _run_cmd(["docker", "--version"])
    docker_daemon_check = _run_cmd(["docker", "info", "--format", "{{.ServerVersion}}"], timeout=10) if docker_check["ok"] else {"ok": False, "output": "docker absent"}
    dpkg_check = _run_cmd(["dpkg", "--version"])
    apt_check = _run_cmd(["apt-get", "--version"])
    neo4j_socket_ok = _can_open_tcp(host, port)

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
            "id": "docker",
            "label": "Docker (optionnel)",
            "ok": docker_check["ok"],
            "details": docker_check.get("output", "") or "Docker non détecté.",
            "fix": "Optionnel: sudo apt install docker.io",
        },
        {
            "id": "docker-daemon",
            "label": "Daemon Docker actif",
            "ok": bool(docker_daemon_check.get("ok")),
            "details": docker_daemon_check.get("output", ""),
            "fix": "sudo systemctl start docker && sudo usermod -aG docker $USER",
        },
        {
            "id": "neo4j-port",
            "label": f"Neo4j joignable ({host}:{port})",
            "ok": neo4j_socket_ok,
            "details": "Port Bolt accessible" if neo4j_socket_ok else "Connexion TCP impossible",
            "fix": "Démarrer Neo4j (service local ou conteneur Docker) et vérifier NEO4J_URI.",
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
        "docker.io": _dpkg_package_status("docker.io"),
    }

    return {
        "ok": True,
        "platform": sys.platform,
        "dpkg_note": "dpkg n'installe pas automatiquement les dépendances manquantes. Utiliser: sudo apt install ./Neurail.deb ou sudo apt install -f après dpkg -i.",
        "checks": checks,
        "packages": packages,
    }




# ═══════════════════════════════════════════════════════
#  DI wrappers — bind mail_utils callbacks into mail_service
# ═══════════════════════════════════════════════════════
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


def fetch_pop3(account):
    return _fetch_pop3_impl(account, **_MAIL_DI_COMMON)


def fetch_imap(account):
    return _fetch_imap_impl(
        account,
        normalize_auth_fields=normalize_auth_fields,
        get_valid_gmail_access_token=get_valid_gmail_access_token,
        **_MAIL_DI_COMMON,
    )


def fetch_all_accounts():
    """Fetch from all configured accounts (POP3 or IMAP)."""
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


def delete_mail_on_server(account, uid_to_delete):
    return _delete_mail_on_server_impl(
        account, uid_to_delete,
        normalize_auth_fields=normalize_auth_fields,
        get_valid_gmail_access_token=get_valid_gmail_access_token,
    )


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=PROJECT_ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

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
        if self.path == "/api/neo4j/docker/config":
            try:
                return self._json({"ok": True, "config": _get_neo4j_docker_config()})
            except Exception as e:
                return self._json({"error": str(e)}, 500)
        if self.path == "/api/neo4j/docker/status":
            try:
                return self._json({"ok": True, **_neo4j_docker_status()})
            except Exception as e:
                return self._json({"error": str(e)}, 500)
        if self.path == "/api/accounts":
            return self._json(load_accounts())
        if self.path == "/api/inbox":
            inbox = load_inbox_index()
            # Filter out deleted and sent, sort by date desc
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
                    # Fallback: on tente l'accès direct au .eml si fourni par le résultat RAG.
                    safe_eml = os.path.basename(eml_file or "")
                    if safe_eml.lower().endswith(".md"):
                        resolved = _resolve_eml_from_md_source(safe_eml)
                        if resolved:
                            safe_eml = resolved
                    if safe_eml and safe_eml == (eml_file or ""):
                        eml_path = os.path.join(MAILS_DIR, safe_eml)
                    elif safe_eml and safe_eml.lower().endswith(".eml"):
                        eml_path = os.path.join(MAILS_DIR, safe_eml)
                    else:
                        self.send_error(404)
                        return
                else:
                    eml_path = os.path.join(MAILS_DIR, mail.get("eml_file", ""))

                if not os.path.isfile(eml_path):
                    # Fallback final: pièces jointes déjà exportées dans le vault graph.
                    safe_name = os.path.basename(filename or "")
                    if safe_name and safe_name == (filename or ""):
                        graph_att_path = os.path.join(GRAPH_ATT_DIR, safe_name)
                        if os.path.isfile(graph_att_path):
                            with open(graph_att_path, "rb") as f:
                                payload = f.read()
                            content_type = mimetypes.guess_type(safe_name)[0] or "application/octet-stream"
                            self.send_response(200)
                            self.send_header("Content-Type", content_type)
                            self.send_header("Content-Disposition", f'inline; filename="{safe_name}"')
                            self.send_header("Content-Length", str(len(payload)))
                            self.end_headers()
                            self.wfile.write(payload)
                            return
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
        if self.path == "/api/vault/graph":
            try:
                return self._json(scan_vault_graph())
            except Exception as e:
                return self._json({"error": str(e)}, 500)
        if self.path == "/api/vault/mails":
            try:
                return self._json(_list_vault_mails())
            except Exception as e:
                return self._json({"error": str(e)}, 500)
        if self.path.startswith("/api/vault/read?"):
            try:
                qs = parse_qs(urlparse(self.path).query)
                relpath = qs.get('path', [''])[0]
                content = read_vault_file(relpath)
                return self._json({"ok": True, "content": content, "path": relpath})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        # ── Neo4j status ──
        if self.path == "/api/neo4j/status":
            driver, _ = _get_neo4j()
            return self._json({"available": driver is not None})

        if self.path == "/api/neo4j/ingest-status":
            with _neo4j_ingest_lock:
                return self._json(dict(_neo4j_ingest_state))

        super().do_GET()

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

        if self.path == "/api/neo4j/docker/config":
            try:
                cfg = _save_neo4j_docker_config(data.get("config", {}))
                return self._json({"ok": True, "config": cfg})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/neo4j/docker/action":
            try:
                action = (data.get("action", "") or "").strip().lower()
                status = _neo4j_docker_action(action, data)
                return self._json({"ok": True, "status": status})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/neo4j/test-auth":
            try:
                password = str(data.get("password", "") or "").strip()
                if not password:
                    return self._json({"error": "Mot de passe requis"}, 400)
                uri = os.getenv("NEO4J_URI", "bolt://localhost:7687")
                user = os.getenv("NEO4J_USER", "neo4j")
                from neo4j import GraphDatabase
                from neo4j.exceptions import AuthError as Neo4jAuthError
                drv = GraphDatabase.driver(uri, auth=(user, password))
                try:
                    drv.verify_connectivity()
                    # Auth succeeded — persist password for future runs.
                    _write_runtime_env_file({"NEO4J_PASSWORD": password})
                    os.environ["NEO4J_PASSWORD"] = password
                    # Reset lazy driver so it reconnects with the new password.
                    global _neo4j_driver, _neo4j_available, _neo4j_retry_after
                    if _neo4j_driver is not None:
                        try:
                            _neo4j_driver.close()
                        except Exception:
                            pass
                    _neo4j_driver = None
                    _neo4j_available = None
                    _neo4j_retry_after = 0.0
                    return self._json({"ok": True})
                except Neo4jAuthError:
                    return self._json({"ok": False, "auth_failed": True, "error": "Mot de passe incorrect"})
                except Exception as e:
                    return self._json({"ok": False, "error": str(e)})
                finally:
                    drv.close()
            except ImportError:
                return self._json({"error": "Driver neo4j non installé"}, 500)
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/run-mail-to-md":
            script_path = os.path.join(DIR, "mail_to_md.py")
            try:
                result = subprocess.run(
                    ["python3", script_path],
                    capture_output=True, text=True, timeout=300
                )
                output = result.stdout + result.stderr
                return self._json({"ok": result.returncode == 0, "output": output})
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 500)

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

        # ── Chatbot Graph RAG ──
        if self.path == "/api/chatbot/query":
            try:
                question = (data.get("question", "") or "").strip()
                if not question:
                    return self._json({"error": "Question vide"}, 400)
                _mailchat_log(f"query received: {question[:120]}")
                driver, embedder = _get_neo4j()
                if not driver:
                    return self._json({"error": "Neo4j non disponible"}, 503)

                from rag_query import search_and_enrich_with_meta, generate_answer, is_llm_configured
                top_k = min(int(data.get("top_k", 5)), 10)
                results, search_meta = search_and_enrich_with_meta(driver, embedder, question, top_k=top_k)
                if search_meta.get("question_rewritten"):
                    _mailchat_log(f"query rewritten: {search_meta.get('retrieval_question', '')[:160]}")

                # Build eml_file → mail_id lookup from inbox index
                inbox = load_inbox_index()
                eml_to_id = {m.get("eml_file", ""): m.get("id", "") for m in inbox if m.get("eml_file")}

                # Structure les résultats pour le frontend
                hits = []
                for r in results:
                    mail_id = eml_to_id.get(r.eml_file, "") if r.eml_file else ""
                    hits.append({
                        "subject": r.subject,
                        "date": r.date,
                        "sender_name": r.sender_name,
                        "sender_email": r.sender_email,
                        "recipients": r.recipients,
                        "topics": r.topics,
                        "attachments": r.attachments,
                        "score": round(r.score, 3),
                        "body_snippet": r.body_snippet[:200],
                        "eml_file": r.eml_file,
                        "mail_id": mail_id,
                    })

                # Génère la réponse LLM uniquement si demandé et disponible
                answer = ""
                llm_requested = bool(data.get("generate", True))
                llm_available = is_llm_configured()
                llm_used = False
                llm_warning = ""
                if llm_requested and not llm_available:
                    llm_warning = (
                        "Mode IA indisponible: GEMINI_API_KEY manquante. "
                        "Ajoutez-la dans .env pour activer la synthese LLM."
                    )

                if llm_requested and llm_available and results:
                    try:
                        answer = generate_answer(question, results)
                        llm_used = True
                    except Exception as llm_err:
                        logger.error("LLM error: %s", llm_err)
                        answer = f"Erreur LLM: {llm_err}"

                return self._json({
                    "ok": True,
                    "answer": answer,
                    "results": hits,
                    "count": len(hits),
                    "retrieval": "graph_rag",
                    "llm_requested": llm_requested,
                    "llm_available": llm_available,
                    "llm_used": llm_used,
                    "llm_warning": llm_warning,
                    "original_question": search_meta.get("original_question", question),
                    "retrieval_question": search_meta.get("retrieval_question", question),
                    "question_rewritten": bool(search_meta.get("question_rewritten", False)),
                })
            except Exception as e:
                logger.error("Chatbot query error: %s", e)
                _mailchat_log(f"query error: {e}")
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/chatbot/search":
            # Recherche vectorielle seule (sans LLM) — économise les tokens
            try:
                question = (data.get("question", "") or "").strip()
                if not question:
                    return self._json({"error": "Question vide"}, 400)
                driver, embedder = _get_neo4j()
                if not driver:
                    return self._json({"error": "Neo4j non disponible"}, 503)

                from rag_query import search_and_enrich_with_meta
                top_k = min(int(data.get("top_k", 5)), 10)
                results, search_meta = search_and_enrich_with_meta(driver, embedder, question, top_k=top_k)

                # Build eml_file → mail_id lookup from inbox index
                inbox = load_inbox_index()
                eml_to_id = {m.get("eml_file", ""): m.get("id", "") for m in inbox if m.get("eml_file")}

                hits = []
                for r in results:
                    mail_id = eml_to_id.get(r.eml_file, "") if r.eml_file else ""
                    hits.append({
                        "subject": r.subject,
                        "date": r.date,
                        "sender_name": r.sender_name,
                        "sender_email": r.sender_email,
                        "recipients": r.recipients,
                        "topics": r.topics,
                        "attachments": r.attachments,
                        "score": round(r.score, 3),
                        "body_snippet": r.body_snippet[:200],
                        "eml_file": r.eml_file,
                        "mail_id": mail_id,
                    })

                return self._json({
                    "ok": True,
                    "results": hits,
                    "count": len(hits),
                    "original_question": search_meta.get("original_question", question),
                    "retrieval_question": search_meta.get("retrieval_question", question),
                    "question_rewritten": bool(search_meta.get("question_rewritten", False)),
                })
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/chatbot/normalize":
            # Normalise et réécrit la requête sémantique sans lancer la recherche.
            try:
                question = (data.get("question", "") or "").strip()
                fields = data.get("fields", {}) or {}
                if not question:
                    parts = []
                    who = (fields.get("who", "") or "").strip()
                    doc_type = (fields.get("docType", "") or "").strip()
                    context = (fields.get("context", "") or "").strip()
                    period = (fields.get("period", "") or "").strip()
                    attachment = (fields.get("attachment", "") or "").strip().lower()
                    comment = (fields.get("comment", "") or "").strip()

                    if who:
                        parts.append(f"Expéditeur/personne: {who}")
                    if doc_type:
                        parts.append(f"Type recherché: {doc_type}")
                    if context:
                        parts.append(f"Contexte: {context}")
                    if period:
                        parts.append(f"Période: {period}")
                    if attachment == "oui":
                        parts.append("Le mail doit contenir une pièce jointe")
                    elif attachment == "non":
                        parts.append("Le mail ne doit pas contenir de pièce jointe")
                    if comment:
                        parts.append(f"Commentaire: {comment}")
                    question = " | ".join(parts).strip()

                if not question:
                    return self._json({"error": "Question vide"}, 400)

                from rag_query import rewrite_question_for_retrieval
                normalized = rewrite_question_for_retrieval(question)
                return self._json({
                    "ok": True,
                    "question": question,
                    "normalized_question": normalized,
                    "rewritten": normalized != question,
                })
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/neo4j/ingest":
            # Lance l'ingestion Neo4j en tâche de fond et retourne l'état.
            try:
                driver, _embedder = _get_neo4j()
                if not driver:
                    return self._json({"error": "Neo4j non disponible"}, 503)

                mode = data.get("mode", "both")
                if mode not in ("eml", "vault", "both"):
                    mode = "both"

                global _neo4j_ingest_thread
                with _neo4j_ingest_lock:
                    if _neo4j_ingest_state.get("running"):
                        return self._json({"ok": True, "running": True, **_neo4j_ingest_state})

                    _neo4j_ingest_state.update({
                        "running": True,
                        "phase": "starting",
                        "processed": 0,
                        "total": 0,
                        "ingested": 0,
                        "current_file": "",
                        "source": "",
                        "error": "",
                        "finished": False,
                    })

                _mailchat_log(f"sync started (mode={mode})")
                _neo4j_ingest_thread = threading.Thread(
                    target=_run_neo4j_ingest_job,
                    args=(mode,),
                    daemon=True,
                )
                _neo4j_ingest_thread.start()
                with _neo4j_ingest_lock:
                    return self._json({"ok": True, "running": True, **_neo4j_ingest_state})
            except Exception as e:
                logger.error("Ingest error: %s", e)
                _mailchat_log(f"sync launch error: {e}")
                return self._json({"error": str(e)}, 500)

        # ── Account management ──
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

        # ── Start Google OAuth flow for Gmail account ──
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

                # Persist normalized values before opening auth URL.
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

        # ── Email autoconfig (Mozilla Thunderbird DB) ──
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

        # ── Fetch emails (POP3/IMAP) ──
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

        # ── Send email (SMTP) ──
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

        # ── Mark email read/unread/starred ──
        if self.path == "/api/mail/mark-read":
            try:
                mail_id = data.get("id", "")
                inbox = load_inbox_index()
                for m in inbox:
                    if m.get("id") == mail_id:
                        if "read" in data:
                            m["read"] = data["read"]
                        if "starred" in data:
                            m["starred"] = data["starred"]
                        break
                save_inbox_index(inbox)
                return self._json({"ok": True})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        # ── Delete email ──
        if self.path == "/api/mail/delete":
            try:
                mail_id = data.get("id", "")
                delete_on_server = data.get("delete_on_server", False)
                inbox = load_inbox_index()
                mail = next((m for m in inbox if m.get("id") == mail_id), None)
                if not mail:
                    return self._json({"error": "Mail introuvable"}, 404)

                # Delete on POP3 server if requested
                if delete_on_server and mail.get("uid") and mail.get("account"):
                    account = find_account_by_email(mail["account"])
                    if account:
                        try:
                            delete_mail_on_server(account, mail["uid"])
                        except Exception as del_err:
                            pass  # Continue even if server delete fails

                # Remove local .eml file
                eml_path = os.path.join(MAILS_DIR, mail.get("eml_file", ""))
                if os.path.isfile(eml_path):
                    os.remove(eml_path)

                # Remove from seen UIDs so we don't have stale entries
                if mail.get("uid") and mail.get("account"):
                    seen = load_seen_uids()
                    for key, uids in seen.items():
                        if mail["uid"] in uids:
                            uids.remove(mail["uid"])
                    save_seen_uids(seen)

                # Mark as deleted in index
                mail["deleted"] = True
                save_inbox_index(inbox)

                return self._json({"ok": True})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        # ── Export email to graph markdown + Neo4j ──
        if self.path == "/api/mail/export-graph":
            try:
                mail_id = data.get("id", "")
                inbox = load_inbox_index()
                mail = next((m for m in inbox if m.get("id") == mail_id), None)
                if not mail:
                    return self._json({"error": "Mail introuvable"}, 404)
                md_path = export_email_to_graph(mail)

                # Also ingest into Neo4j if available
                neo4j_ok = False
                driver, embedder = _get_neo4j()
                if driver:
                    try:
                        eml_file = mail.get("eml_file", "")
                        if eml_file:
                            eml_path = os.path.join(MAILS_DIR, eml_file)
                            if os.path.isfile(eml_path):
                                from neo4j_ingest import ingest_single_eml
                                ingest_single_eml(driver, embedder, eml_path)
                                neo4j_ok = True
                    except Exception as neo4j_err:
                        logger.warning("Neo4j ingest after export: %s", neo4j_err)

                return self._json({"ok": True, "path": md_path, "neo4j": neo4j_ok})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        # ── Bulk export to graph ──
        if self.path == "/api/mail/export-graph-all":
            try:
                inbox = load_inbox_index()
                visible = [m for m in inbox if not m.get("deleted")]
                exported = 0
                errors = []

                # Prepare Neo4j for bulk ingest
                driver, embedder = _get_neo4j()
                if driver:
                    try:
                        from neo4j_ingest import init_schema
                        init_schema(driver)
                    except Exception:
                        pass

                for mail in visible:
                    try:
                        export_email_to_graph(mail)
                        exported += 1
                        # Also ingest into Neo4j
                        if driver:
                            try:
                                eml_file = mail.get("eml_file", "")
                                if eml_file:
                                    eml_path = os.path.join(MAILS_DIR, eml_file)
                                    if os.path.isfile(eml_path):
                                        from neo4j_ingest import ingest_single_eml
                                        ingest_single_eml(driver, embedder, eml_path)
                            except Exception as neo4j_err:
                                logger.warning("Neo4j bulk ingest: %s", neo4j_err)
                    except Exception as e:
                        errors.append(f"{mail.get('subject', '?')}: {e}")
                return self._json({"ok": True, "exported": exported, "errors": errors})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        # ── Import contacts CSV ──
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

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # silencieux


if __name__ == "__main__":
    import signal
    import socketserver
    import traceback

    # Force unbuffered stdout/stderr so Electron sees all output
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr = sys.stdout  # Redirect stderr to stdout for Electron capture

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
