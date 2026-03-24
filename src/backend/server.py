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
    - google_calendar_service : OAuth2 Google + Calendar API v3
    - calendar_routes     : handlers HTTP pour les routes /api/calendar/*
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
import os
import secrets
import subprocess
import time
import urllib.parse
from urllib.parse import parse_qs, urlparse
from datetime import datetime
from email import policy as email_policy

from app_config import (
    CONTACTS_CSV,
    DATA,
    DIR,
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
    build_calendar_http_error_response,
    build_oauth_callback_page,
    create_google_calendar_event,
    delete_google_calendar_event,
    exchange_google_auth_code,
    generate_pkce_pair,
    get_valid_gmail_access_token,
    get_google_oauth_accounts,
    list_google_calendars,
    list_google_calendar_events,
    parse_google_error_payload,
    pick_google_oauth_account,
    update_google_calendar_event,
)
from calendar_routes import (
    handle_calendar_accounts_get,
    handle_calendar_calendars_get,
    handle_calendar_event_create_post,
    handle_calendar_event_delete_post,
    handle_calendar_event_update_post,
    handle_calendar_events_get,
    handle_oauth_callback,
)
from ai_service import ai_generate_reminder, ai_generate_reply, ai_reformulate
from graph_service import export_email_to_graph, read_vault_file, scan_vault_graph
from autoconfig_service import autoconfig_email

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
        if self.path == "/api/calendar/accounts":
            return handle_calendar_accounts_get(self, get_google_oauth_accounts=get_google_oauth_accounts)
        if self.path.startswith("/api/calendar/calendars"):
            return handle_calendar_calendars_get(
                self,
                pick_google_oauth_account=pick_google_oauth_account,
                list_google_calendars=list_google_calendars,
                build_calendar_http_error_response=build_calendar_http_error_response,
            )
        if self.path.startswith("/api/calendar/events"):
            return handle_calendar_events_get(
                self,
                pick_google_oauth_account=pick_google_oauth_account,
                list_google_calendar_events=list_google_calendar_events,
                parse_google_error_payload=parse_google_error_payload,
            )
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
                idx_raw = qs.get("idx", [None])[0]
                filename = qs.get("name", [None])[0]
                idx = int(idx_raw) if idx_raw is not None else None

                inbox = load_inbox_index()
                mail = next((m for m in inbox if m.get("id") == mail_id), None)
                if not mail:
                    self.send_error(404)
                    return

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
        if self.path.startswith("/api/vault/read?"):
            try:
                qs = parse_qs(urlparse(self.path).query)
                relpath = qs.get('path', [''])[0]
                content = read_vault_file(relpath)
                return self._json({"ok": True, "content": content, "path": relpath})
            except Exception as e:
                return self._json({"error": str(e)}, 500)
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

        # ── Google Calendar events CRUD ──
        if self.path == "/api/calendar/events":
            return handle_calendar_event_create_post(
                self,
                data,
                pick_google_oauth_account=pick_google_oauth_account,
                create_google_calendar_event=create_google_calendar_event,
                build_calendar_http_error_response=build_calendar_http_error_response,
            )

        if self.path == "/api/calendar/events/update":
            return handle_calendar_event_update_post(
                self,
                data,
                pick_google_oauth_account=pick_google_oauth_account,
                update_google_calendar_event=update_google_calendar_event,
                build_calendar_http_error_response=build_calendar_http_error_response,
            )

        if self.path == "/api/calendar/events/delete":
            return handle_calendar_event_delete_post(
                self,
                data,
                pick_google_oauth_account=pick_google_oauth_account,
                delete_google_calendar_event=delete_google_calendar_event,
                parse_google_error_payload=parse_google_error_payload,
            )

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

        # ── Export email to graph markdown ──
        if self.path == "/api/mail/export-graph":
            try:
                mail_id = data.get("id", "")
                inbox = load_inbox_index()
                mail = next((m for m in inbox if m.get("id") == mail_id), None)
                if not mail:
                    return self._json({"error": "Mail introuvable"}, 404)
                md_path = export_email_to_graph(mail)
                return self._json({"ok": True, "path": md_path})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        # ── Bulk export to graph ──
        if self.path == "/api/mail/export-graph-all":
            try:
                inbox = load_inbox_index()
                visible = [m for m in inbox if not m.get("deleted")]
                exported = 0
                errors = []
                for mail in visible:
                    try:
                        export_email_to_graph(mail)
                        exported += 1
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
    print(f"🚀 Todo → http://localhost:{PORT}")
    http.server.HTTPServer(("", PORT), Handler).serve_forever()
