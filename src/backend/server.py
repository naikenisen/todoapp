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
import secrets
import subprocess
import sys
import threading
import time
import urllib.parse
from urllib.parse import parse_qs, urlparse
from datetime import datetime
from email import policy as email_policy

from app_config import (
    CONTACTS_CSV,
    DATA,
    DIR,
    GRAPH_ATT_DIR,
    GRAPH_MD_DIR,
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
            mails.append({
                "filename": fname,
                "subject": fm.get("subject", fname.replace(".md", "")),
                "date": fm.get("date", ""),
                "from": fm.get("from", ""),
                "to": fm.get("to", ""),
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
