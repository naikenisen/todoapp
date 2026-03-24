#!/usr/bin/env python3
"""Serveur local pour l'app Todo & Mail — sauvegarde dans data.json."""

import base64
import csv
import email as email_lib
import email.policy
import hashlib
import http.server
import imaplib
import json
import logging
import mailbox
import os
import poplib
import re
import secrets
import shutil
import smtplib
import socket
import ssl
import subprocess
import time
import urllib.request
import urllib.parse
from urllib.parse import parse_qs, urlparse
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from email import encoders
from email import policy as email_policy
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import getaddresses, parsedate_to_datetime
from pathlib import Path

try:
    import html2text
    HAS_HTML2TEXT = True
except ImportError:
    HAS_HTML2TEXT = False

PORT = 8080
DIR = os.path.dirname(os.path.abspath(__file__))


def get_app_data_dir():
    """Return a writable data directory for runtime files.

    Runtime data is always stored outside the source tree so secrets/config are
    per-installation and never written to the git repository.

    Priority:
    1) ISENAPP_DATA_DIR env var (explicit override)
    2) XDG_DATA_HOME/isenapp
    3) ~/.local/share/isenapp
    """
    env_override = os.environ.get("ISENAPP_DATA_DIR", "").strip()
    if env_override:
        return env_override

    xdg_data_home = os.environ.get("XDG_DATA_HOME", "").strip()
    if xdg_data_home:
        return os.path.join(xdg_data_home, "isenapp")

    return os.path.join(str(Path.home()), ".local", "share", "isenapp")


APP_DATA_DIR = get_app_data_dir()
os.makedirs(APP_DATA_DIR, exist_ok=True)


def bootstrap_file(filename):
    """Copy bundled defaults to writable app data dir when missing."""
    src = os.path.join(DIR, filename)
    dst = os.path.join(APP_DATA_DIR, filename)
    if os.path.isfile(src) and not os.path.exists(dst):
        shutil.copy2(src, dst)
    return dst if os.path.exists(dst) else src


def read_json_with_backup(path, default_value):
    """Read JSON file with fallback to <file>.bak if primary is unreadable."""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        bak_path = f"{path}.bak"
        try:
            with open(bak_path, encoding="utf-8") as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return default_value


def atomic_write_json(path, payload):
    """Write JSON atomically and keep a one-file backup of previous content."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp_path = f"{path}.tmp"
    bak_path = f"{path}.bak"

    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())

    if os.path.exists(path):
        shutil.copy2(path, bak_path)
    os.replace(tmp_path, path)


DATA = bootstrap_file("data.json")
CONTACTS_CSV = bootstrap_file("contacts_complets_v2.csv")
LOG_FILE = os.path.join(APP_DATA_DIR, "api_errors.log")
DOWNLOADS = str(Path.home() / "Téléchargements")

# ── Mail storage ──
MAILS_DIR = str(Path.home() / "mails")
SEEN_UIDS_FILE = os.path.join(APP_DATA_DIR, "seen_uids.json")
ACCOUNTS_FILE = os.path.join(APP_DATA_DIR, "accounts.json")
INBOX_INDEX_FILE = os.path.join(APP_DATA_DIR, "inbox_index.json")

ISENAPP_DATA = str(Path.home() / "Documents" / "isenapp_mails")
OBSIDIAN_MD_DIR = os.path.join(ISENAPP_DATA, "mails")
OBSIDIAN_ATT_DIR = os.path.join(ISENAPP_DATA, "attachements")
OBSIDIAN_VAULT = ISENAPP_DATA

os.makedirs(MAILS_DIR, exist_ok=True)
os.makedirs(OBSIDIAN_MD_DIR, exist_ok=True)
os.makedirs(OBSIDIAN_ATT_DIR, exist_ok=True)

# In-memory OAuth state store (state -> metadata) for current server process.
GOOGLE_OAUTH_PENDING = {}
GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar"
GOOGLE_MAIL_SCOPE = "https://mail.google.com/"

logging.basicConfig(
    filename=LOG_FILE,
    format="%(asctime)s [%(levelname)s] %(message)s",
    level=logging.ERROR,
)
logger = logging.getLogger("todoapp")
if not os.path.isdir(DOWNLOADS):
    DOWNLOADS = str(Path.home() / "Downloads")
if not os.path.isdir(DOWNLOADS):
    DOWNLOADS = str(Path.home())


def load():
    return read_json_with_backup(DATA, {"sections": [], "settings": {}})


def save(data):
    atomic_write_json(DATA, data)


def load_contacts():
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


def ai_call(token, prompt):
    """Generic AI call via Google Gemini API — single request."""
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.3},
    }).encode()

    url = ("https://generativelanguage.googleapis.com/v1beta/"
           f"models/gemma-3-27b-it:generateContent?key={token}")

    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            result = json.loads(r.read())
        return result["candidates"][0]["content"]["parts"][0]["text"]
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        try:
            msg = json.loads(error_body).get("error", {}).get("message", error_body)
        except Exception:
            msg = error_body
        logger.error("Gemini API %d: %s", e.code, msg)
        raise RuntimeError(f"Gemini {e.code}: {msg}")
    except Exception as e:
        logger.error("Gemini API error: %s", e)
        raise


def ai_reformulate(payload):
    token = payload.get("token", "")
    text = payload.get("text", "")
    prompt = (
        "Corriges la syntaxe, la grammaire et l'orthographe du texte suivant. "
        "Réponds UNIQUEMENT avec le texte corrigé, sans commentaire ni explication :\n\n"
        + text
    )
    return ai_call(token, prompt)


def ai_generate_reminder(payload):
    token = payload.get("token", "")
    original_subject = payload.get("subject", "")
    original_to = payload.get("to", "")
    original_body = payload.get("body", "")
    prompt = (
        "Tu es un assistant professionnel. Il y a 3 jours j'ai envoyé un mail et je n'ai pas reçu de réponse. "
        "Génère un mail de relance poli et professionnel en français. "
        "Réponds UNIQUEMENT en JSON valide (sans balises markdown) avec cette structure :\n"
        '{"subject":"...","body":"..."}\n\n'
        f"Mail original :\n"
        f"À : {original_to}\n"
        f"Sujet : {original_subject}\n"
        f"Corps :\n{original_body}"
    )
    content = ai_call(token, prompt)
    if "```" in content:
        content = content.split("```json")[-1] if "```json" in content else content.split("```")[1]
        content = content.split("```")[0]
    return json.loads(content.strip())


def ai_generate_reply(payload):
    token = payload.get("token", "")
    user_prompt = payload.get("prompt", "")
    subject = payload.get("subject", "")
    sender = payload.get("from", "")
    original_text = payload.get("original_text", "")
    draft = payload.get("draft", "")

    prompt = (
        "Tu es un assistant de redaction email professionnel en francais. "
        "Genere UNIQUEMENT le texte de reponse (sans objet, sans salutation imposee, sans commentaire). "
        "Respecte strictement les instructions utilisateur ci-dessous. "
        "N'inclus pas le message original dans la sortie.\n\n"
        f"Sujet du fil : {subject}\n"
        f"Expediteur original : {sender}\n\n"
        "Instructions utilisateur :\n"
        f"{user_prompt}\n\n"
        "Brouillon actuel (a ameliorer si present) :\n"
        f"{draft}\n\n"
        "Message original recu (contexte, NE PAS recopier integralement) :\n"
        f"{original_text}"
    )
    return ai_call(token, prompt)


def build_eml(from_addr, to_addr, subject, body_text, html_body=None):
    if html_body:
        msg = MIMEMultipart("alternative")
        msg.attach(MIMEText(body_text, "plain", "utf-8"))
        msg.attach(MIMEText(html_body, "html", "utf-8"))
    else:
        msg = MIMEText(body_text, "plain", "utf-8")
    msg["From"] = from_addr
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg["Date"] = datetime.now().strftime("%a, %d %b %Y %H:%M:%S +0100")
    return msg.as_string()


def save_eml_to_downloads(from_addr, to_addr, subject, body_text, html_body=None):
    eml_content = build_eml(from_addr, to_addr, subject, body_text, html_body=html_body)
    safe_subject = "".join(c for c in subject if c.isalnum() or c in " _-").strip()[:80] or "mail"
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{safe_subject}_{ts}.eml"
    filepath = os.path.join(DOWNLOADS, filename)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(eml_content)
    return filepath


# ═══════════════════════════════════════════════════════
#  Accounts Management
# ═══════════════════════════════════════════════════════
def load_accounts():
    accounts = read_json_with_backup(ACCOUNTS_FILE, [])
    if not isinstance(accounts, list):
        return []
    for acc in accounts:
        normalize_auth_fields(acc)
    return accounts


def save_accounts(accounts):
    atomic_write_json(ACCOUNTS_FILE, accounts)


def normalize_auth_fields(account):
    """Normalize auth/provider fields for backward compatibility."""
    provider = (account.get("provider", "") or "").lower()
    auth_type = (account.get("auth_type", "") or "").lower()
    if provider == "gmail_oauth" and not auth_type:
        auth_type = "oauth2"
    if auth_type:
        account["auth_type"] = auth_type
    return account


def find_account_index_by_email(accounts, email_addr):
    target = (email_addr or "").strip().lower()
    for idx, acc in enumerate(accounts):
        if (acc.get("email", "") or "").strip().lower() == target:
            return idx
    return -1


def build_oauth_callback_page(ok, message):
    color = "#34d399" if ok else "#ef4444"
    icon = "✅" if ok else "❌"
    title = "Connexion Gmail réussie" if ok else "Connexion Gmail échouée"
    return f"""<!doctype html>
<html lang=\"fr\"><head><meta charset=\"utf-8\"><title>{title}</title>
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head>
<body style=\"font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:1rem\">
  <div style=\"max-width:560px;width:100%;background:#111827;border:1px solid #374151;border-radius:12px;padding:1rem 1.2rem;box-shadow:0 8px 30px rgba(0,0,0,.35)\">
    <h1 style=\"margin:.1rem 0 .6rem 0;font-size:1.2rem;color:{color}\">{icon} {title}</h1>
    <p style=\"line-height:1.5;margin:0 0 .7rem 0\">{message}</p>
    <p style=\"line-height:1.5;margin:0;color:#94a3b8\">Tu peux maintenant fermer cet onglet et revenir dans ISENAPP.</p>
  </div>
</body></html>"""


def _b64url(data_bytes):
    return base64.urlsafe_b64encode(data_bytes).decode().rstrip("=")


def generate_pkce_pair():
    verifier = _b64url(secrets.token_bytes(64))
    challenge = _b64url(hashlib.sha256(verifier.encode("utf-8")).digest())
    return verifier, challenge


def exchange_google_auth_code(client_id, client_secret, redirect_uri, code, code_verifier):
    payload = {
        "grant_type": "authorization_code",
        "client_id": client_id,
        "code": code,
        "redirect_uri": redirect_uri,
        "code_verifier": code_verifier,
    }
    if client_secret:
        payload["client_secret"] = client_secret

    body = urllib.parse.urlencode(payload).encode("utf-8")
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read())


def refresh_google_token(account):
    refresh_token = (account.get("oauth_refresh_token", "") or "").strip()
    client_id = (account.get("oauth_client_id", "") or "").strip()
    client_secret = (account.get("oauth_client_secret", "") or "").strip()
    if not refresh_token:
        raise RuntimeError("Refresh token Gmail manquant. Reconnecte le compte OAuth.")
    if not client_id:
        raise RuntimeError("Client ID OAuth manquant pour ce compte Gmail.")

    payload = {
        "grant_type": "refresh_token",
        "client_id": client_id,
        "refresh_token": refresh_token,
    }
    if client_secret:
        payload["client_secret"] = client_secret

    body = urllib.parse.urlencode(payload).encode("utf-8")
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        token_data = json.loads(resp.read())

    access_token = token_data.get("access_token", "")
    expires_in = int(token_data.get("expires_in", 3600))
    if not access_token:
        raise RuntimeError("Google OAuth: access_token absent après refresh.")

    account["oauth_access_token"] = access_token
    account["oauth_token_expiry"] = int(time.time()) + max(30, expires_in - 30)
    if token_data.get("refresh_token"):
        account["oauth_refresh_token"] = token_data["refresh_token"]

    return account


def get_valid_gmail_access_token(account_email):
    """Load account from storage, refresh token when needed, and return valid token."""
    accounts = load_accounts()
    idx = find_account_index_by_email(accounts, account_email)
    if idx < 0:
        raise RuntimeError(f"Compte introuvable: {account_email}")

    account = normalize_auth_fields(accounts[idx])
    if account.get("auth_type") != "oauth2":
        raise RuntimeError("Ce compte n'est pas configuré en OAuth 2.0.")

    now = int(time.time())
    access_token = (account.get("oauth_access_token", "") or "").strip()
    expiry = int(account.get("oauth_token_expiry", 0) or 0)

    if access_token and expiry > now + 60:
        return access_token

    try:
        account = refresh_google_token(account)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Google OAuth refresh HTTP {e.code}: {body}")
    except Exception as e:
        raise RuntimeError(f"Refresh token Gmail impossible: {e}")

    accounts[idx] = account
    save_accounts(accounts)
    return account.get("oauth_access_token", "")


def get_google_oauth_accounts():
    """Return enabled OAuth2 accounts suitable for Google APIs."""
    oauth_accounts = []
    for acc in load_accounts():
        acc = normalize_auth_fields(acc)
        if acc.get("enabled", True) is False:
            continue
        if acc.get("auth_type") != "oauth2":
            continue
        email_addr = (acc.get("email", "") or "").strip()
        if not email_addr:
            continue
        oauth_accounts.append(acc)
    return oauth_accounts


def pick_google_oauth_account(preferred_email=""):
    """Pick an OAuth account; prefer the requested email when available."""
    accounts = get_google_oauth_accounts()
    if preferred_email:
        target = preferred_email.strip().lower()
        for acc in accounts:
            if (acc.get("email", "") or "").strip().lower() == target:
                return acc
    return accounts[0] if accounts else None


def map_google_calendar_event(ev, calendar_meta=None, calendar_id="primary"):
    """Normalize Google Calendar event payload for frontend use."""
    start_data = ev.get("start", {}) or {}
    end_data = ev.get("end", {}) or {}
    start_value = start_data.get("dateTime") or start_data.get("date") or ""
    end_value = end_data.get("dateTime") or end_data.get("date") or ""
    calendar_meta = calendar_meta or {}
    return {
        "id": ev.get("id", ""),
        "summary": ev.get("summary", "(Sans titre)"),
        "description": ev.get("description", "") or "",
        "location": ev.get("location", "") or "",
        "start": start_value,
        "end": end_value,
        "allDay": bool(start_data.get("date") and not start_data.get("dateTime")),
        "htmlLink": ev.get("htmlLink", "") or "",
        "status": ev.get("status", "") or "",
        "calendarId": calendar_id,
        "calendarName": calendar_meta.get("summary", calendar_id),
        "calendarColor": calendar_meta.get("backgroundColor", "#6c8aff"),
        "calendarTextColor": calendar_meta.get("foregroundColor", "#ffffff"),
        "canEdit": bool(calendar_meta.get("canEdit", True)),
    }


def normalize_google_calendar_datetime(dt_raw):
    """Normalize local/naive datetime string to RFC3339 with timezone."""
    value = (dt_raw or "").strip()
    if not value:
        raise RuntimeError("Date/heure manquante.")

    # Accept trailing Z and convert to an ISO offset so fromisoformat can parse it.
    candidate = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        dt = datetime.fromisoformat(candidate)
    except ValueError:
        raise RuntimeError("Format date/heure invalide (ISO attendu).")

    # Google Calendar rejects dateTime without timezone in many cases.
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.now().astimezone().tzinfo)

    return dt.isoformat(timespec="seconds")


def list_google_calendars(account_email):
    """Fetch the account calendar list with colors and edit rights."""
    access_token = get_valid_gmail_access_token(account_email)
    params = {
        "minAccessRole": "reader",
        "maxResults": 2500,
    }
    url = (
        "https://www.googleapis.com/calendar/v3/users/me/calendarList?"
        + urllib.parse.urlencode(params)
    )
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {access_token}"},
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        payload = json.loads(resp.read())

    items = payload.get("items", []) if isinstance(payload, dict) else []
    calendars = []
    for cal in items:
        cal_id = (cal.get("id", "") or "").strip()
        if not cal_id:
            continue
        access_role = (cal.get("accessRole", "") or "").strip().lower()
        calendars.append({
            "id": cal_id,
            "summary": cal.get("summary", cal_id),
            "backgroundColor": cal.get("backgroundColor", "#6c8aff"),
            "foregroundColor": cal.get("foregroundColor", "#ffffff"),
            "primary": bool(cal.get("primary", False)),
            "selected": bool(cal.get("selected", True)),
            "accessRole": access_role,
            "canEdit": access_role in {"owner", "writer"},
        })
    return calendars


def list_google_calendar_events(account_email, time_min_iso, time_max_iso, calendar_ids=None):
    """Fetch Google Calendar events for an arbitrary time range and calendars."""
    access_token = get_valid_gmail_access_token(account_email)
    calendars = list_google_calendars(account_email)
    calendars_by_id = {c["id"]: c for c in calendars}

    if calendar_ids:
        target_ids = [c for c in calendar_ids if c in calendars_by_id]
    else:
        target_ids = [c["id"] for c in calendars]

    if not target_ids:
        target_ids = ["primary"]

    events = []
    for cal_id in target_ids:
        params = {
            "timeMin": time_min_iso,
            "timeMax": time_max_iso,
            "singleEvents": "true",
            "orderBy": "startTime",
            "maxResults": 2500,
        }
        url = (
            "https://www.googleapis.com/calendar/v3/calendars/"
            + urllib.parse.quote(cal_id, safe="")
            + "/events?"
            + urllib.parse.urlencode(params)
        )
        req = urllib.request.Request(
            url,
            headers={"Authorization": f"Bearer {access_token}"},
        )
        with urllib.request.urlopen(req, timeout=25) as resp:
            payload = json.loads(resp.read())

        items = payload.get("items", []) if isinstance(payload, dict) else []
        calendar_meta = calendars_by_id.get(cal_id, {
            "summary": cal_id,
            "backgroundColor": "#6c8aff",
            "foregroundColor": "#ffffff",
            "canEdit": True,
        })
        for ev in items:
            events.append(map_google_calendar_event(ev, calendar_meta=calendar_meta, calendar_id=cal_id))

    return {
        "events": events,
        "calendars": calendars,
    }


def create_google_calendar_event(account_email, payload):
    """Create an event in the primary Google Calendar."""
    access_token = get_valid_gmail_access_token(account_email)
    calendar_id = (payload.get("calendarId", "") or "").strip() or "primary"
    summary = (payload.get("summary", "") or "").strip()
    if not summary:
        raise RuntimeError("Le titre (summary) est requis.")

    all_day = bool(payload.get("allDay"))
    event_data = {
        "summary": summary,
        "description": (payload.get("description", "") or "").strip(),
        "location": (payload.get("location", "") or "").strip(),
    }

    if all_day:
        start_date = (payload.get("startDate", "") or "").strip()
        end_date = (payload.get("endDate", "") or "").strip()
        if not start_date:
            raise RuntimeError("Date de début requise pour un événement journée entière.")

        try:
            start_dt = datetime.strptime(start_date, "%Y-%m-%d")
            if end_date:
                end_dt = datetime.strptime(end_date, "%Y-%m-%d")
            else:
                end_dt = start_dt + timedelta(days=1)
            if end_dt <= start_dt:
                end_dt = start_dt + timedelta(days=1)
        except ValueError:
            raise RuntimeError("Format de date invalide (AAAA-MM-JJ attendu).")

        event_data["start"] = {"date": start_dt.strftime("%Y-%m-%d")}
        event_data["end"] = {"date": end_dt.strftime("%Y-%m-%d")}
    else:
        start_dt_iso = (payload.get("startDateTime", "") or "").strip()
        end_dt_iso = (payload.get("endDateTime", "") or "").strip()
        if not start_dt_iso or not end_dt_iso:
            raise RuntimeError("Dates/horaires de début et fin requis.")

        event_data["start"] = {"dateTime": normalize_google_calendar_datetime(start_dt_iso)}
        event_data["end"] = {"dateTime": normalize_google_calendar_datetime(end_dt_iso)}

    body = json.dumps(event_data).encode("utf-8")
    req = urllib.request.Request(
        "https://www.googleapis.com/calendar/v3/calendars/"
        + urllib.parse.quote(calendar_id, safe="")
        + "/events",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        created = json.loads(resp.read())
    calendars = list_google_calendars(account_email)
    meta = next((c for c in calendars if c["id"] == calendar_id), None) or {}
    return map_google_calendar_event(created, calendar_meta=meta, calendar_id=calendar_id)


def update_google_calendar_event(account_email, payload):
    """Patch an existing event on a specific calendar."""
    access_token = get_valid_gmail_access_token(account_email)
    calendar_id = (payload.get("calendarId", "") or "").strip() or "primary"
    event_id = (payload.get("eventId", "") or "").strip()
    if not event_id:
        raise RuntimeError("eventId requis.")

    body_payload = {}
    if "summary" in payload:
        body_payload["summary"] = (payload.get("summary", "") or "").strip()
    if "description" in payload:
        body_payload["description"] = payload.get("description", "") or ""
    if "location" in payload:
        body_payload["location"] = payload.get("location", "") or ""

    if payload.get("allDay") is True:
        start_date = (payload.get("startDate", "") or "").strip()
        end_date = (payload.get("endDate", "") or "").strip()
        if not start_date:
            raise RuntimeError("startDate requis pour un événement journée entière.")
        if not end_date:
            end_dt = datetime.strptime(start_date, "%Y-%m-%d") + timedelta(days=1)
            end_date = end_dt.strftime("%Y-%m-%d")
        body_payload["start"] = {"date": start_date}
        body_payload["end"] = {"date": end_date}
    elif payload.get("allDay") is False:
        start_dt_iso = (payload.get("startDateTime", "") or "").strip()
        end_dt_iso = (payload.get("endDateTime", "") or "").strip()
        if not start_dt_iso or not end_dt_iso:
            raise RuntimeError("startDateTime/endDateTime requis pour un événement horaire.")
        body_payload["start"] = {"dateTime": normalize_google_calendar_datetime(start_dt_iso)}
        body_payload["end"] = {"dateTime": normalize_google_calendar_datetime(end_dt_iso)}

    if not body_payload:
        raise RuntimeError("Aucune propriété à mettre à jour.")

    body = json.dumps(body_payload).encode("utf-8")
    url = (
        "https://www.googleapis.com/calendar/v3/calendars/"
        + urllib.parse.quote(calendar_id, safe="")
        + "/events/"
        + urllib.parse.quote(event_id, safe="")
    )
    req = urllib.request.Request(
        url,
        data=body,
        method="PATCH",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        updated = json.loads(resp.read())

    calendars = list_google_calendars(account_email)
    meta = next((c for c in calendars if c["id"] == calendar_id), None) or {}
    return map_google_calendar_event(updated, calendar_meta=meta, calendar_id=calendar_id)


def delete_google_calendar_event(account_email, event_id):
    """Delete an event from the primary Google Calendar."""
    access_token = get_valid_gmail_access_token(account_email)
    calendar_id = "primary"
    if isinstance(event_id, dict):
        calendar_id = (event_id.get("calendarId", "") or "").strip() or "primary"
        event_id = event_id.get("eventId", "")

    event_id = (event_id or "").strip()
    if not event_id:
        raise RuntimeError("eventId requis.")

    url = (
        "https://www.googleapis.com/calendar/v3/calendars/"
        + urllib.parse.quote(calendar_id, safe="")
        + "/events/"
        + urllib.parse.quote(event_id, safe="")
    )
    req = urllib.request.Request(
        url,
        method="DELETE",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    with urllib.request.urlopen(req, timeout=25):
        return True


def parse_google_error_payload(body_text):
    """Parse Google API error JSON and expose actionable metadata."""
    info = {
        "message": body_text,
        "reason": "",
        "status": "",
        "activation_url": "",
    }
    try:
        payload = json.loads(body_text or "{}")
        err = payload.get("error", {}) if isinstance(payload, dict) else {}
        if isinstance(err, dict):
            info["message"] = err.get("message") or info["message"]
            info["status"] = err.get("status") or ""

            errors = err.get("errors") if isinstance(err.get("errors"), list) else []
            if errors and isinstance(errors[0], dict):
                info["reason"] = errors[0].get("reason", "") or info["reason"]

            details = err.get("details") if isinstance(err.get("details"), list) else []
            for detail in details:
                if not isinstance(detail, dict):
                    continue
                if detail.get("reason"):
                    info["reason"] = detail.get("reason")
                links = detail.get("links") if isinstance(detail.get("links"), list) else []
                for link in links:
                    if isinstance(link, dict) and link.get("url"):
                        info["activation_url"] = link.get("url")
                        break
                if info["activation_url"]:
                    break

        if not info["activation_url"] and "console.developers.google.com/apis/api/calendar-json.googleapis.com/overview" in body_text:
            marker = "https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview"
            start = body_text.find(marker)
            if start >= 0:
                end = body_text.find('"', start)
                info["activation_url"] = body_text[start:end] if end > start else marker
    except Exception:
        pass
    return info


def build_calendar_http_error_response(http_err):
    """Build a normalized JSON payload for Google Calendar HTTP errors."""
    body = http_err.read().decode("utf-8", errors="replace")
    info = parse_google_error_payload(body)
    reason = (info.get("reason", "") or "").lower()
    status = (info.get("status", "") or "").upper()

    if reason in {"insufficientpermissions", "access_token_scope_insufficient"}:
        return {
            "ok": False,
            "error_code": "CALENDAR_SCOPE_INSUFFICIENT",
            "error": "Le token OAuth n'a pas le scope Google Calendar requis.",
            "details": info.get("message", body),
        }, 502

    if reason in {"forbiddenfornonorganizer", "forbidden"} or (http_err.code == 403 and status == "PERMISSION_DENIED"):
        return {
            "ok": False,
            "error_code": "CALENDAR_EVENT_FORBIDDEN",
            "error": "Cet événement ou agenda ne peut pas être modifié avec ce compte.",
            "details": info.get("message", body),
        }, 502

    if reason in {"accessnotconfigured", "service_disabled"}:
        return {
            "ok": False,
            "error_code": "CALENDAR_API_DISABLED",
            "error": "Google Calendar API n'est pas activée pour ce projet Google Cloud.",
            "details": info.get("message", body),
            "activation_url": info.get("activation_url", ""),
        }, 502

    return {
        "ok": False,
        "error_code": "CALENDAR_HTTP_ERROR",
        "error": f"Google Calendar HTTP {http_err.code}",
        "details": info.get("message", body),
    }, 502


def build_xoauth2_string(username, access_token):
    raw = f"user={username}\x01auth=Bearer {access_token}\x01\x01"
    return raw.encode("utf-8")


def smtp_auth_xoauth2(server, username, access_token):
    token = base64.b64encode(build_xoauth2_string(username, access_token)).decode("ascii")
    code, resp = server.docmd("AUTH", f"XOAUTH2 {token}")
    if code != 235:
        detail = resp.decode("utf-8", errors="replace") if isinstance(resp, bytes) else str(resp)
        raise RuntimeError(f"SMTP OAuth refusé ({code}): {detail}")


# ═══════════════════════════════════════════════════════
#  Seen UIDs — deduplication
# ═══════════════════════════════════════════════════════
def load_seen_uids():
    return read_json_with_backup(SEEN_UIDS_FILE, {})


def save_seen_uids(seen):
    atomic_write_json(SEEN_UIDS_FILE, seen)


# ═══════════════════════════════════════════════════════
#  Inbox Index — local mail metadata
# ═══════════════════════════════════════════════════════
def load_inbox_index():
    index = read_json_with_backup(INBOX_INDEX_FILE, [])
    if not isinstance(index, list):
        return []

    # Drop entries pointing to missing .eml files to avoid stale inbox rows.
    filtered = []
    changed = False
    for m in index:
        eml_file = m.get("eml_file", "")
        if eml_file:
            eml_path = os.path.join(MAILS_DIR, eml_file)
            if not os.path.isfile(eml_path):
                changed = True
                continue
        filtered.append(m)

    if changed:
        save_inbox_index(filtered)
    return filtered


def save_inbox_index(index):
    atomic_write_json(INBOX_INDEX_FILE, index)


def compute_mail_id(raw_bytes):
    """Compute a stable hash for deduplication."""
    return hashlib.sha256(raw_bytes).hexdigest()[:24]


def clean_string_for_file(name):
    if not name:
        return ""
    name = str(name).replace('\n', ' ').replace('\r', '')
    return re.sub(r'[\\/*?:"<>|]', "", name).strip()


def unique_eml_filename_from_subject(subject, prefix=""):
    """Build a unique .eml filename from subject with _1, _2... suffixes."""
    safe_subject = clean_string_for_file(subject)[:120] or "mail"
    if prefix:
        safe_subject = f"{prefix}{safe_subject}"

    candidate = f"{safe_subject}.eml"
    index = 1
    while os.path.exists(os.path.join(MAILS_DIR, candidate)):
        candidate = f"{safe_subject}_{index}.eml"
        index += 1
    return candidate


def extract_bodies(msg):
    """Extract plain-text and HTML bodies from a parsed email message."""
    body_text = ""
    body_html = ""
    h = None
    if HAS_HTML2TEXT:
        h = html2text.HTML2Text()
        h.ignore_links = False
        h.body_width = 0

    for part in msg.walk():
        content_type = part.get_content_type()
        content_disposition = str(part.get("Content-Disposition", ""))

        if "attachment" in content_disposition:
            continue

        if content_type == "text/plain":
            if not body_text:
                try:
                    charset = part.get_content_charset('utf-8') or 'utf-8'
                    body_text = part.get_payload(decode=True).decode(charset, errors='replace')
                except Exception:
                    pass
        elif content_type == "text/html":
            try:
                charset = part.get_content_charset('utf-8') or 'utf-8'
                body_html = part.get_payload(decode=True).decode(charset, errors='replace')
            except Exception:
                pass

    if not body_text and body_html and h:
        try:
            body_text = h.handle(body_html)
        except Exception:
            body_text = ""

    return body_text, body_html


def get_attachment_payload(msg, index=None, filename=None):
    """Return (bytes, filename, content_type) for an attachment by index or filename."""
    found_idx = 0
    for part in msg.walk():
        content_disposition = str(part.get("Content-Disposition", ""))
        part_filename = part.get_filename()
        if not (("attachment" in content_disposition or part_filename) and part_filename):
            continue

        if index is not None:
            if found_idx != index:
                found_idx += 1
                continue
        elif filename is not None and part_filename != filename:
            found_idx += 1
            continue

        payload = part.get_payload(decode=True)
        if payload is None:
            return None, None, None
        return payload, part_filename, part.get_content_type() or "application/octet-stream"

    return None, None, None


def enrich_mail_from_eml(mail):
    """Populate body/body_html/attachments from local .eml when available."""
    eml_file = mail.get("eml_file", "")
    if not eml_file:
        return mail
    eml_path = os.path.join(MAILS_DIR, eml_file)
    if not os.path.isfile(eml_path):
        return mail

    try:
        with open(eml_path, "rb") as f:
            raw_bytes = f.read()
        parsed = parse_email_metadata(raw_bytes, mail.get("account", ""))
        mail["body"] = parsed.get("body", mail.get("body", ""))
        mail["body_html"] = parsed.get("body_html", "")
        mail["attachments"] = parsed.get("attachments", mail.get("attachments", []))
    except Exception:
        pass

    return mail


def extract_attachments_info(msg):
    """Return list of attachment filenames from a message."""
    attachments = []
    for part in msg.walk():
        content_disposition = str(part.get("Content-Disposition", ""))
        filename = part.get_filename()
        if ("attachment" in content_disposition or filename) and filename:
            attachments.append(filename)
    return attachments


def parse_email_metadata(raw_bytes, account_email=""):
    """Parse raw email bytes into metadata dict."""
    msg = email_lib.message_from_bytes(raw_bytes, policy=email_policy.default)

    subject = msg.get('Subject', 'Sans sujet') or 'Sans sujet'
    from_hdr = msg.get('From', '')
    to_hdr = msg.get('To', '')
    cc_hdr = msg.get('Cc', '')
    date_str = msg.get('Date', '')
    message_id = msg.get('Message-ID', '') or ''

    # Parse sender
    from_addrs = getaddresses([from_hdr])
    sender_name = ''
    sender_email = ''
    if from_addrs:
        sender_name = from_addrs[0][0] or ''
        sender_email = from_addrs[0][1] or ''

    # Parse date
    date_ts = 0
    date_display = date_str
    try:
        dt = parsedate_to_datetime(date_str)
        date_ts = int(dt.timestamp() * 1000)
        date_display = dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        date_ts = int(time.time() * 1000)
        date_display = datetime.now().strftime("%Y-%m-%d %H:%M")

    body_text, body_html = extract_bodies(msg)
    attachments = extract_attachments_info(msg)

    return {
        "subject": subject,
        "from_name": sender_name,
        "from_email": sender_email,
        "to": to_hdr,
        "cc": cc_hdr,
        "date": date_display,
        "date_ts": date_ts,
        "message_id": message_id,
        "body": body_text,
        "body_html": body_html,
        "attachments": attachments,
        "account": account_email,
    }


# ═══════════════════════════════════════════════════════
#  POP3 Fetch
# ═══════════════════════════════════════════════════════
def fetch_pop3(account):
    """Fetch emails via POP3 for one account. Returns (new_count, errors)."""
    server = account.get("pop3_server", "")
    port = int(account.get("pop3_port", 995))
    use_ssl = account.get("pop3_ssl", True)
    username = account.get("username", "")
    password = account.get("password", "")
    account_email = account.get("email", username)

    seen = load_seen_uids()
    account_key = f"{username}@{server}"
    if account_key not in seen:
        seen[account_key] = []

    inbox = load_inbox_index()
    new_count = 0
    errors = []

    try:
        if use_ssl:
            pop = poplib.POP3_SSL(server, port, timeout=30)
        else:
            pop = poplib.POP3(server, port, timeout=30)

        pop.user(username)
        pop.pass_(password)

        count, _ = pop.stat()
        # Get UIDL for dedup
        resp, uid_list, _ = pop.uidl()
        uid_map = {}
        for entry in uid_list:
            if isinstance(entry, bytes):
                entry = entry.decode('utf-8', errors='replace')
            parts = entry.strip().split(None, 1)
            if len(parts) == 2:
                uid_map[parts[0]] = parts[1]

        for msg_num_str, uid in uid_map.items():
            if uid in seen[account_key]:
                continue

            msg_num = int(msg_num_str)
            try:
                resp_lines, lines, octets = pop.retr(msg_num)
                raw_bytes = b"\r\n".join(lines)

                mail_id = compute_mail_id(raw_bytes)

                meta = parse_email_metadata(raw_bytes, account_email)
                eml_filename = unique_eml_filename_from_subject(meta.get("subject", "mail"))
                eml_path = os.path.join(MAILS_DIR, eml_filename)
                with open(eml_path, "wb") as f:
                    f.write(raw_bytes)

                # Parse metadata
                meta["id"] = mail_id
                meta["uid"] = uid
                meta["eml_file"] = eml_filename
                meta["read"] = False
                meta["starred"] = False
                meta["deleted"] = False

                inbox.append(meta)
                seen[account_key].append(uid)
                new_count += 1

            except Exception as e:
                errors.append(f"Message {msg_num}: {e}")

        pop.quit()

    except Exception as e:
        errors.append(str(e))

    save_seen_uids(seen)
    save_inbox_index(inbox)
    return new_count, errors


# ═══════════════════════════════════════════════════════
#  IMAP Fetch
# ═══════════════════════════════════════════════════════
def fetch_imap(account):
    """Fetch emails via IMAP for one account. Returns (new_count, errors)."""
    account = normalize_auth_fields(account)
    server = account.get("imap_server", "")
    port = int(account.get("imap_port", 993))
    use_ssl = account.get("imap_ssl", True)
    username = account.get("username", "")
    password = account.get("password", "")
    account_email = account.get("email", username)
    auth_type = account.get("auth_type", "password")
    post_action = account.get("imap_post_action", "mark_read")  # mark_read | delete

    seen = load_seen_uids()
    account_key = f"{username}@{server}"
    if account_key not in seen:
        seen[account_key] = []

    inbox = load_inbox_index()
    new_count = 0
    errors = []

    try:
        if use_ssl:
            imap = imaplib.IMAP4_SSL(server, port)
        else:
            imap = imaplib.IMAP4(server, port)

        if auth_type == "oauth2":
            oauth_user = username or account_email
            access_token = get_valid_gmail_access_token(account_email)
            imap.authenticate("XOAUTH2", lambda _: build_xoauth2_string(oauth_user, access_token))
        else:
            imap.login(username, password)
        imap.select("INBOX")

        # Search for all messages
        status, data = imap.search(None, "ALL")
        if status != "OK":
            errors.append("IMAP search failed")
            imap.logout()
            return 0, errors

        msg_nums = data[0].split()
        for num in msg_nums:
            # Get UID for dedup
            status, uid_data = imap.fetch(num, "(UID)")
            if status != "OK":
                continue
            uid_str = uid_data[0].decode("utf-8", errors="replace") if isinstance(uid_data[0], bytes) else str(uid_data[0])
            # Extract UID from response like '1 (UID 123)'
            uid_match = re.search(r"UID\s+(\d+)", uid_str)
            if not uid_match:
                continue
            uid = uid_match.group(1)

            if uid in seen[account_key]:
                continue

            # Fetch full message
            status, msg_data = imap.fetch(num, "(RFC822)")
            if status != "OK" or not msg_data or not msg_data[0]:
                continue

            try:
                raw_bytes = msg_data[0][1]
                mail_id = compute_mail_id(raw_bytes)

                meta = parse_email_metadata(raw_bytes, account_email)
                eml_filename = unique_eml_filename_from_subject(meta.get("subject", "mail"))
                eml_path = os.path.join(MAILS_DIR, eml_filename)
                with open(eml_path, "wb") as f:
                    f.write(raw_bytes)

                # Parse metadata
                meta["id"] = mail_id
                meta["uid"] = uid
                meta["eml_file"] = eml_filename
                meta["read"] = False
                meta["starred"] = False
                meta["deleted"] = False
                meta["protocol"] = "imap"

                inbox.append(meta)
                seen[account_key].append(uid)
                new_count += 1

                # Post-fetch action
                if post_action == "delete":
                    imap.store(num, "+FLAGS", "\\Deleted")
                elif post_action == "mark_read":
                    imap.store(num, "+FLAGS", "\\Seen")

            except Exception as e:
                errors.append(f"IMAP message {num}: {e}")

        if post_action == "delete":
            imap.expunge()

        imap.close()
        imap.logout()

    except Exception as e:
        errors.append(str(e))

    save_seen_uids(seen)
    save_inbox_index(inbox)
    return new_count, errors


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
            if protocol == "imap":
                n, errs = fetch_imap(acc)
            else:
                n, errs = fetch_pop3(acc)
            total_new += n
            all_errors.extend(errs)
        except Exception as e:
            all_errors.append(f"{acc.get('email', '?')}: {e}")

    return total_new, all_errors


# ═══════════════════════════════════════════════════════
#  Email Autoconfig (Mozilla Thunderbird database)
# ═══════════════════════════════════════════════════════
def autoconfig_email(email_addr):
    """Auto-detect IMAP/SMTP settings from Mozilla's autoconfig database."""
    domain = email_addr.strip().split("@")[-1].lower()

    config = None
    # Try Mozilla autoconfig
    url = f"https://autoconfig.thunderbird.net/v1.1/{domain}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ISENAPP/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            xml_data = resp.read()
        config = _parse_autoconfig_xml(xml_data, email_addr)
    except Exception:
        config = None

    if config:
        return config

    # Fallback: probe common hostnames
    return _autoconfig_fallback(domain, email_addr)


def _parse_autoconfig_xml(xml_data, email_addr):
    """Parse Mozilla autoconfig XML and return structured config dict."""
    root = ET.fromstring(xml_data)
    ns = ''
    # Handle potential namespace
    if root.tag.startswith('{'):
        ns = root.tag.split('}')[0] + '}'

    result = {"imap": None, "smtp": None, "source": "mozilla"}

    for provider in root.iter(f"{ns}emailProvider"):
        # Find IMAP
        for inc in provider.iter(f"{ns}incomingServer"):
            if inc.get("type") == "imap":
                hostname = (inc.findtext(f"{ns}hostname") or "").strip()
                port = int(inc.findtext(f"{ns}port") or "993")
                socket_type = (inc.findtext(f"{ns}socketType") or "SSL").strip()
                username_tpl = (inc.findtext(f"{ns}username") or "%EMAILADDRESS%").strip()
                username = username_tpl.replace("%EMAILADDRESS%", email_addr).replace("%EMAILLOCALPART%", email_addr.split("@")[0])
                result["imap"] = {
                    "server": hostname, "port": port,
                    "ssl": socket_type in ("SSL", "STARTTLS"),
                    "socket_type": socket_type, "username": username
                }
                break

        # Find SMTP
        for out in provider.iter(f"{ns}outgoingServer"):
            if out.get("type") == "smtp":
                hostname = (out.findtext(f"{ns}hostname") or "").strip()
                port = int(out.findtext(f"{ns}port") or "587")
                socket_type = (out.findtext(f"{ns}socketType") or "STARTTLS").strip()
                username_tpl = (out.findtext(f"{ns}username") or "%EMAILADDRESS%").strip()
                username = username_tpl.replace("%EMAILADDRESS%", email_addr).replace("%EMAILLOCALPART%", email_addr.split("@")[0])
                result["smtp"] = {
                    "server": hostname, "port": port,
                    "ssl": socket_type == "SSL",
                    "starttls": socket_type == "STARTTLS",
                    "socket_type": socket_type, "username": username
                }
                break

    if result["imap"] or result["smtp"]:
        return result
    return None


def _autoconfig_fallback(domain, email_addr):
    """Fallback: test common IMAP/SMTP hostnames and ports."""
    result = {"imap": None, "smtp": None, "source": "fallback"}

    # Try IMAP
    for host in [f"imap.{domain}", f"mail.{domain}"]:
        for port, use_ssl in [(993, True), (143, False)]:
            try:
                if use_ssl:
                    conn = imaplib.IMAP4_SSL(host, port, timeout=5)
                else:
                    conn = imaplib.IMAP4(host, port)
                    conn.socket().settimeout(5)
                conn.logout()
                result["imap"] = {
                    "server": host, "port": port, "ssl": use_ssl,
                    "socket_type": "SSL" if use_ssl else "plain",
                    "username": email_addr
                }
                break
            except Exception:
                continue
        if result["imap"]:
            break

    # Try SMTP
    for host in [f"smtp.{domain}", f"mail.{domain}"]:
        for port, use_ssl, use_starttls in [(465, True, False), (587, False, True), (25, False, False)]:
            try:
                if use_ssl:
                    srv = smtplib.SMTP_SSL(host, port, timeout=5)
                else:
                    srv = smtplib.SMTP(host, port, timeout=5)
                    if use_starttls:
                        srv.starttls()
                srv.quit()
                result["smtp"] = {
                    "server": host, "port": port, "ssl": use_ssl,
                    "starttls": use_starttls,
                    "socket_type": "SSL" if use_ssl else ("STARTTLS" if use_starttls else "plain"),
                    "username": email_addr
                }
                break
            except Exception:
                continue
        if result["smtp"]:
            break

    if result["imap"] or result["smtp"]:
        return result
    return None


# ═══════════════════════════════════════════════════════
#  SMTP Send
# ═══════════════════════════════════════════════════════
def send_email_smtp(account, to_addr, subject, body_text, cc="", attachments=None, html_body=None):
    """Send email via SMTP using account config. Also saves .eml locally.
    attachments: list of dicts with keys: filename, content_type, data (base64-encoded)
    html_body: optional HTML version of the email body (e.g. body + HTML signature)
    """
    account = normalize_auth_fields(account)
    smtp_server = account.get("smtp_server", "")
    smtp_port = int(account.get("smtp_port", 587))
    smtp_ssl = account.get("smtp_ssl", False)
    smtp_starttls = account.get("smtp_starttls", True)
    username = account.get("username", "")
    password = account.get("password", "")
    from_addr = account.get("email", username)
    auth_type = account.get("auth_type", "password")

    msg = MIMEMultipart("mixed")  # 'mixed' supports both text/html alternatives and file attachments
    msg["From"] = from_addr
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg["Date"] = datetime.now().strftime("%a, %d %b %Y %H:%M:%S +0100")
    msg["Message-ID"] = f"<{hashlib.md5((from_addr + to_addr + subject + str(time.time())).encode()).hexdigest()}@isenapp>"
    if cc:
        msg["Cc"] = cc
    if html_body:
        alt = MIMEMultipart("alternative")
        alt.attach(MIMEText(body_text, "plain", "utf-8"))
        alt.attach(MIMEText(html_body, "html", "utf-8"))
        msg.attach(alt)
    else:
        msg.attach(MIMEText(body_text, "plain", "utf-8"))

    # Attach files
    if attachments:
        for att in attachments:
            filename = att.get("filename", "attachment")
            content_type = att.get("content_type", "application/octet-stream")
            file_data = base64.b64decode(att.get("data", ""))
            maintype, subtype = content_type.split("/", 1) if "/" in content_type else ("application", "octet-stream")
            part = MIMEBase(maintype, subtype)
            part.set_payload(file_data)
            encoders.encode_base64(part)
            part.add_header("Content-Disposition", "attachment", filename=filename)
            msg.attach(part)

    raw_msg = msg.as_string()
    raw_bytes = raw_msg.encode("utf-8")

    if smtp_ssl:
        server = smtplib.SMTP_SSL(smtp_server, smtp_port, timeout=30)
    else:
        server = smtplib.SMTP(smtp_server, smtp_port, timeout=30)
        server.ehlo()
        if smtp_starttls:
            server.starttls()
            server.ehlo()

    if auth_type == "oauth2":
        oauth_user = username or from_addr
        access_token = get_valid_gmail_access_token(from_addr)
        smtp_auth_xoauth2(server, oauth_user, access_token)
    else:
        server.login(username, password)

    all_recipients = [a.strip() for a in to_addr.split(",")]
    if cc:
        all_recipients += [a.strip() for a in cc.split(",")]
    server.sendmail(from_addr, all_recipients, raw_msg)
    server.quit()

    # Save sent email locally as .eml in MAILS_DIR using subject as filename
    mail_id = compute_mail_id(raw_bytes)
    eml_filename = unique_eml_filename_from_subject(subject)
    eml_path = os.path.join(MAILS_DIR, eml_filename)
    with open(eml_path, "wb") as f:
        f.write(raw_bytes)

    # Add to inbox index as sent mail
    meta = parse_email_metadata(raw_bytes, from_addr)
    meta["id"] = mail_id
    meta["uid"] = ""
    meta["eml_file"] = eml_filename
    meta["read"] = True
    meta["starred"] = False
    meta["deleted"] = False
    meta["folder"] = "sent"
    inbox = load_inbox_index()
    inbox.append(meta)
    save_inbox_index(inbox)

    return True


def find_account_by_email(email_addr):
    """Find account config matching a sender email."""
    accounts = load_accounts()
    for acc in accounts:
        if acc.get("email", "").lower() == email_addr.lower():
            return acc
    return None


# ═══════════════════════════════════════════════════════
#  Delete mail from POP3 server
# ═══════════════════════════════════════════════════════
def delete_mail_on_server(account, uid_to_delete):
    """Connect via POP3 or IMAP and delete a message by UID."""
    account = normalize_auth_fields(account)
    protocol = account.get("protocol", "pop3").lower()

    if protocol == "imap":
        server = account.get("imap_server", "")
        port = int(account.get("imap_port", 993))
        use_ssl = account.get("imap_ssl", True)
        username = account.get("username", "")
        password = account.get("password", "")
        account_email = account.get("email", username)
        auth_type = account.get("auth_type", "password")

        if use_ssl:
            imap = imaplib.IMAP4_SSL(server, port)
        else:
            imap = imaplib.IMAP4(server, port)

        if auth_type == "oauth2":
            oauth_user = username or account_email
            access_token = get_valid_gmail_access_token(account_email)
            imap.authenticate("XOAUTH2", lambda _: build_xoauth2_string(oauth_user, access_token))
        else:
            imap.login(username, password)
        imap.select("INBOX")

        status, data = imap.search(None, f"UID {uid_to_delete}")
        if status == "OK" and data[0]:
            for num in data[0].split():
                imap.store(num, "+FLAGS", "\\Deleted")
            imap.expunge()

        imap.close()
        imap.logout()
        return True

    # POP3 fallback
    server = account.get("pop3_server", "")
    port = int(account.get("pop3_port", 995))
    use_ssl = account.get("pop3_ssl", True)
    username = account.get("username", "")
    password = account.get("password", "")

    if use_ssl:
        pop = poplib.POP3_SSL(server, port, timeout=30)
    else:
        pop = poplib.POP3(server, port, timeout=30)

    pop.user(username)
    pop.pass_(password)

    resp, uid_list, _ = pop.uidl()
    deleted = False
    for entry in uid_list:
        if isinstance(entry, bytes):
            entry = entry.decode('utf-8', errors='replace')
        parts = entry.strip().split(None, 1)
        if len(parts) == 2 and parts[1] == uid_to_delete:
            pop.dele(int(parts[0]))
            deleted = True
            break

    pop.quit()
    return deleted


# ═══════════════════════════════════════════════════════
#  Obsidian Export (v3.py logic)
# ═══════════════════════════════════════════════════════
MOTS_CLES = ['projet', 'stage', 'facture', 'urgent', 'réunion', 'candidature', 'rapport', 'admin', 'examen']

WIKILINK_RE = re.compile(r'\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]')


def scan_vault_graph():
    """Scan Obsidian vault, extract nodes (md files + attachments) and edges (wikilinks)."""
    vault = OBSIDIAN_VAULT
    nodes = {}  # name -> {id, label, path, type, tags, group}
    edges = []  # [{source, target}]

    # Collect all files
    for root, dirs, files in os.walk(vault):
        # Skip .obsidian config
        dirs[:] = [d for d in dirs if d != '.obsidian']
        for fname in files:
            fpath = os.path.join(root, fname)
            relpath = os.path.relpath(fpath, vault)
            name_no_ext = os.path.splitext(fname)[0]

            if fname.lower().endswith('.md'):
                # Parse frontmatter for tags
                tags = []
                try:
                    with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
                        content = f.read(4096)  # Read just enough for frontmatter
                    if content.startswith('---'):
                        end = content.find('---', 3)
                        if end != -1:
                            fm = content[3:end]
                            for line in fm.split('\n'):
                                line = line.strip()
                                if line.startswith('- '):
                                    tags.append(line[2:].strip())
                except Exception:
                    pass

                # Determine group from path
                group = 'mail' if '/mails/' in relpath or relpath.startswith('mails/') else 'note'

                nodes[name_no_ext] = {
                    'id': name_no_ext,
                    'label': name_no_ext,
                    'path': relpath,
                    'type': 'md',
                    'tags': tags,
                    'group': group,
                }
            else:
                # Attachment (pdf, jpg, etc.)
                ext = os.path.splitext(fname)[1].lower()
                if ext in ('.png', '.jpg', '.jpeg', '.gif', '.svg', '.pdf',
                           '.docx', '.xlsx', '.pptx', '.odt', '.csv', '.zip'):
                    nodes[fname] = {
                        'id': fname,
                        'label': fname,
                        'path': relpath,
                        'type': 'attachment',
                        'tags': [],
                        'group': 'attachment',
                    }

    # Extract edges from wikilinks in md files
    for name, node in list(nodes.items()):
        if node['type'] != 'md':
            continue
        fpath = os.path.join(vault, node['path'])
        try:
            with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read()
            links = WIKILINK_RE.findall(content)
            for link in links:
                link = link.strip()
                if link in nodes:
                    edges.append({'source': name, 'target': link})
                # Also try with known extensions for attachments
                elif link + '.md' in nodes:
                    pass  # wikilinks usually reference without .md
                else:
                    # Target might not exist yet — create an "orphan" node
                    if link not in nodes:
                        nodes[link] = {
                            'id': link,
                            'label': link,
                            'path': '',
                            'type': 'orphan',
                            'tags': [],
                            'group': 'orphan',
                        }
                    edges.append({'source': name, 'target': link})
        except Exception:
            pass

    return {'nodes': list(nodes.values()), 'edges': edges}


def read_vault_file(relpath):
    """Read a file from the Obsidian vault by relative path."""
    # Sanitize: prevent directory traversal
    safe = os.path.normpath(relpath)
    if safe.startswith('..') or os.path.isabs(safe):
        raise ValueError('Invalid path')
    fpath = os.path.join(OBSIDIAN_VAULT, safe)
    if not fpath.startswith(OBSIDIAN_VAULT):
        raise ValueError('Path outside vault')
    if not os.path.isfile(fpath):
        raise FileNotFoundError('File not found')
    with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
        return f.read()


def export_email_to_obsidian(mail_meta):
    """Export a single email to Obsidian markdown, replicating v3.py logic."""
    os.makedirs(OBSIDIAN_MD_DIR, exist_ok=True)
    os.makedirs(OBSIDIAN_ATT_DIR, exist_ok=True)

    eml_path = os.path.join(MAILS_DIR, mail_meta.get("eml_file", ""))
    if not os.path.isfile(eml_path):
        raise FileNotFoundError(f"Fichier .eml introuvable: {eml_path}")

    with open(eml_path, "rb") as f:
        raw_bytes = f.read()

    msg = email_lib.message_from_bytes(raw_bytes, policy=email_policy.default)

    subject = msg.get('Subject', 'Sans_Sujet') or 'Sans_Sujet'
    from_hdr = msg.get('From', '')
    to_hdr = msg.get('To', '')
    cc_hdr = msg.get('Cc', '')
    date_str = msg.get('Date', '')

    # Clean subject — move RE/FW prefixes to end
    subject_clean = subject
    prefixes = []
    prefix_pattern = r'^(\s*(re|fw|fwd)\s*[:：\-]+)'
    while True:
        m = re.match(prefix_pattern, subject_clean, re.IGNORECASE)
        if m:
            prefixes.append(m.group(1).strip())
            subject_clean = subject_clean[m.end():].lstrip()
        else:
            break
    subject_final = f"{subject_clean} ({' '.join(prefixes)})" if prefixes else subject_clean
    safe_subject = clean_string_for_file(subject_final) or "Sans_Sujet"

    # Parse addresses
    def parse_addresses_list(header_value):
        if not header_value:
            return []
        addresses = getaddresses([header_value])
        results = []
        for name, addr in addresses:
            results.append(clean_string_for_file(name) if name else clean_string_for_file(addr))
        return results

    sender_list = parse_addresses_list(from_hdr)
    sender_name = sender_list[0] if sender_list else 'Inconnu'
    raw_sender = getaddresses([from_hdr])
    sender_domain = ""
    if raw_sender and raw_sender[0][1] and '@' in raw_sender[0][1]:
        sender_domain = raw_sender[0][1].split('@')[-1].lower()

    to_list = parse_addresses_list(to_hdr)
    cc_list = parse_addresses_list(cc_hdr)

    # Date parsing
    daily_note_link = ""
    year_month_tag = ""
    mois_fr = ["janvier", "février", "mars", "avril", "mai", "juin",
               "juillet", "août", "septembre", "octobre", "novembre", "décembre"]
    try:
        dt = parsedate_to_datetime(date_str)
        daily_note_link = dt.strftime("%Y-%m-%d")
        mois = mois_fr[dt.month - 1]
        year_month_tag = f"{mois}-{dt.year}"
        file_time = dt.strftime("%Y-%m-%d_%H%M%S")
    except Exception:
        file_time = datetime.now().strftime("%Y-%m-%d_%H%M%S")

    # Filename
    base_md_filename = safe_subject[:100]
    md_filename = f"{base_md_filename}.md"
    md_filepath = os.path.join(OBSIDIAN_MD_DIR, md_filename)
    r_idx = 1
    while os.path.exists(md_filepath):
        md_filename = f"{base_md_filename}_r{r_idx}.md"
        md_filepath = os.path.join(OBSIDIAN_MD_DIR, md_filename)
        r_idx += 1

    # Tags
    tags = ["email"]
    if sender_domain:
        tags.append(f"domaine/{sender_domain.replace('.', '_')}")
    if year_month_tag:
        tags.append(f"periode/{year_month_tag}")
    subject_lower = subject.lower()
    for kw in MOTS_CLES:
        if kw in subject_lower:
            tags.append(f"sujet/{kw}")

    # Body & attachments
    h = None
    if HAS_HTML2TEXT:
        h = html2text.HTML2Text()
        h.ignore_links = False
        h.body_width = 0

    body_content = ""
    attachments_links = []

    for part in msg.walk():
        content_type = part.get_content_type()
        content_disposition = str(part.get("Content-Disposition", ""))

        if "attachment" in content_disposition or part.get_filename():
            filename = part.get_filename()
            if filename:
                if content_type.startswith('image/'):
                    continue
                safe_filename = clean_string_for_file(filename)
                att_filename = f"{file_time}_{safe_filename}"
                att_filepath = os.path.join(OBSIDIAN_ATT_DIR, att_filename)
                payload = part.get_payload(decode=True)
                if payload:
                    with open(att_filepath, 'wb') as att_file:
                        att_file.write(payload)
                    attachments_links.append(f"[[{att_filename}]]")

        elif content_type == "text/plain" and "attachment" not in content_disposition:
            if not body_content:
                try:
                    charset = part.get_content_charset('utf-8') or 'utf-8'
                    body_content = part.get_payload(decode=True).decode(charset, errors='replace')
                except Exception:
                    pass
        elif content_type == "text/html" and "attachment" not in content_disposition and h:
            try:
                charset = part.get_content_charset('utf-8') or 'utf-8'
                html_content = part.get_payload(decode=True).decode(charset, errors='replace')
                body_content = h.handle(html_content)
            except Exception:
                pass

    body_lower = body_content[:500].lower()
    for kw in MOTS_CLES:
        if kw in body_lower and f"sujet/{kw}" not in tags:
            tags.append(f"sujet/{kw}")

    # Write markdown
    with open(md_filepath, 'w', encoding='utf-8') as md_file:
        md_file.write("---\n")
        md_file.write("type: email\n")
        md_file.write("tags:\n")
        for tag in tags:
            md_file.write(f"  - {tag}\n")
        md_file.write("---\n\n")
        md_file.write(f"# {subject_final}\n\n")
        if daily_note_link:
            md_file.write(f"**🗓️ Date :** {daily_note_link} ({date_str})\n")
        else:
            md_file.write(f"**🗓️ Date :** {date_str}\n")
        md_file.write(f"**👤 De :** [[{sender_name}]]\n")
        if to_list:
            to_links = ", ".join([f"[[{dest}]]" for dest in to_list])
            md_file.write(f"**👥 À :** {to_links}\n")
        if cc_list:
            cc_links = ", ".join([f"[[{cc}]]" for cc in cc_list])
            md_file.write(f"**👀 Cc :** {cc_links}\n")
        md_file.write("\n---\n\n")
        md_file.write(body_content)
        md_file.write("\n\n")
        if attachments_links:
            md_file.write("---\n### 📎 Pièces Jointes\n")
            for link in attachments_links:
                md_file.write(f"- {link}\n")

    return md_filepath


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DIR, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/api/oauth/google/callback"):
            try:
                qs = parse_qs(urlparse(self.path).query)
                err = (qs.get("error", [""])[0] or "").strip()
                state = (qs.get("state", [""])[0] or "").strip()
                code = (qs.get("code", [""])[0] or "").strip()

                if err:
                    html = build_oauth_callback_page(False, f"Google a renvoyé une erreur: {err}")
                    self.send_response(400)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.end_headers()
                    self.wfile.write(html.encode("utf-8"))
                    return

                pending = GOOGLE_OAUTH_PENDING.pop(state, None)
                if not pending:
                    html = build_oauth_callback_page(False, "État OAuth invalide ou expiré.")
                    self.send_response(400)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.end_headers()
                    self.wfile.write(html.encode("utf-8"))
                    return

                if not code:
                    html = build_oauth_callback_page(False, "Code OAuth absent.")
                    self.send_response(400)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.end_headers()
                    self.wfile.write(html.encode("utf-8"))
                    return

                account_email = pending["account_email"]
                accounts = load_accounts()
                idx = find_account_index_by_email(accounts, account_email)
                if idx < 0:
                    html = build_oauth_callback_page(False, "Compte cible introuvable. Réessaie depuis l'application.")
                    self.send_response(404)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.end_headers()
                    self.wfile.write(html.encode("utf-8"))
                    return

                account = normalize_auth_fields(accounts[idx])
                client_id = (account.get("oauth_client_id", "") or "").strip()
                client_secret = (account.get("oauth_client_secret", "") or "").strip()
                redirect_uri = (account.get("oauth_redirect_uri", "") or "").strip() or "http://127.0.0.1:8080/api/oauth/google/callback"

                token_data = exchange_google_auth_code(
                    client_id=client_id,
                    client_secret=client_secret,
                    redirect_uri=redirect_uri,
                    code=code,
                    code_verifier=pending["code_verifier"],
                )

                access_token = token_data.get("access_token", "")
                refresh_token = token_data.get("refresh_token", "")
                expires_in = int(token_data.get("expires_in", 3600))
                if not access_token:
                    raise RuntimeError("Google OAuth: access_token absent")

                account["provider"] = "gmail_oauth"
                account["auth_type"] = "oauth2"
                account["protocol"] = "imap"
                account["email"] = account_email
                account["username"] = account_email
                account["imap_server"] = "imap.gmail.com"
                account["imap_port"] = 993
                account["imap_ssl"] = True
                account["imap_post_action"] = account.get("imap_post_action", "mark_read")
                account["smtp_server"] = "smtp.gmail.com"
                account["smtp_port"] = 587
                account["smtp_ssl"] = False
                account["smtp_starttls"] = True
                account["oauth_access_token"] = access_token
                account["oauth_token_expiry"] = int(time.time()) + max(30, expires_in - 30)
                if refresh_token:
                    account["oauth_refresh_token"] = refresh_token
                granted_scope = (token_data.get("scope", "") or "").strip()
                if granted_scope:
                    account["oauth_scope"] = granted_scope

                accounts[idx] = account
                save_accounts(accounts)

                html = build_oauth_callback_page(True, f"Le compte {account_email} est désormais connecté via Google OAuth 2.0.")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(html.encode("utf-8"))
                return
            except Exception as e:
                html = build_oauth_callback_page(False, f"Impossible de finaliser OAuth: {e}")
                self.send_response(500)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(html.encode("utf-8"))
                return

        if self.path == "/api/state":
            return self._json(load())
        if self.path == "/api/contacts":
            return self._json(load_contacts())
        if self.path == "/api/accounts":
            return self._json(load_accounts())
        if self.path == "/api/calendar/accounts":
            accounts = get_google_oauth_accounts()
            return self._json([
                {
                    "email": (acc.get("email", "") or "").strip(),
                    "provider": acc.get("provider", ""),
                    "connected": bool((acc.get("oauth_refresh_token", "") or "").strip()),
                }
                for acc in accounts
            ])
        if self.path.startswith("/api/calendar/calendars"):
            try:
                qs = parse_qs(urlparse(self.path).query)
                account_email = (qs.get("account", [""])[0] or "").strip()
                account = pick_google_oauth_account(account_email)
                if not account:
                    return self._json({"error": "Aucun compte Google OAuth disponible."}, 404)

                calendars = list_google_calendars(account.get("email", ""))
                return self._json({
                    "ok": True,
                    "account": account.get("email", ""),
                    "calendars": calendars,
                })
            except urllib.error.HTTPError as e:
                payload, code = build_calendar_http_error_response(e)
                return self._json(payload, code)
            except Exception as e:
                return self._json({"error": str(e)}, 500)
        if self.path.startswith("/api/calendar/events"):
            try:
                qs = parse_qs(urlparse(self.path).query)
                year_raw = (qs.get("year", [""])[0] or "").strip()
                month_raw = (qs.get("month", [""])[0] or "").strip()
                start_raw = (qs.get("start", [""])[0] or "").strip()
                end_raw = (qs.get("end", [""])[0] or "").strip()
                account_email = (qs.get("account", [""])[0] or "").strip()
                calendars_raw = (qs.get("calendars", [""])[0] or "").strip()
                calendar_ids = [c.strip() for c in calendars_raw.split(",") if c.strip()]

                now = datetime.now()
                year = int(year_raw) if year_raw.isdigit() else now.year
                month = int(month_raw) if month_raw.isdigit() else now.month

                if start_raw and end_raw:
                    try:
                        start_dt = datetime.strptime(start_raw, "%Y-%m-%d")
                        end_dt = datetime.strptime(end_raw, "%Y-%m-%d")
                    except ValueError:
                        return self._json({"error": "Format start/end invalide (AAAA-MM-JJ attendu)."}, 400)

                    if end_dt <= start_dt:
                        return self._json({"error": "La date de fin doit être après la date de début."}, 400)

                    time_min_iso = start_dt.strftime("%Y-%m-%dT00:00:00Z")
                    time_max_iso = end_dt.strftime("%Y-%m-%dT00:00:00Z")
                else:
                    if month < 1 or month > 12:
                        return self._json({"error": "Mois invalide (1-12)."}, 400)

                    start_dt = datetime(year, month, 1)
                    if month == 12:
                        end_dt = datetime(year + 1, 1, 1)
                    else:
                        end_dt = datetime(year, month + 1, 1)
                    time_min_iso = start_dt.strftime("%Y-%m-%dT00:00:00Z")
                    time_max_iso = end_dt.strftime("%Y-%m-%dT00:00:00Z")

                account = pick_google_oauth_account(account_email)
                if not account:
                    return self._json({"error": "Aucun compte Google OAuth disponible."}, 404)

                result_data = list_google_calendar_events(
                    account.get("email", ""),
                    time_min_iso,
                    time_max_iso,
                    calendar_ids=calendar_ids,
                )
                return self._json({
                    "ok": True,
                    "account": account.get("email", ""),
                    "year": year,
                    "month": month,
                    "start": start_dt.strftime("%Y-%m-%d"),
                    "end": end_dt.strftime("%Y-%m-%d"),
                    "events": result_data.get("events", []),
                    "calendars": result_data.get("calendars", []),
                })
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", errors="replace")
                info = parse_google_error_payload(body)
                reason = (info.get("reason", "") or "").lower()
                status = (info.get("status", "") or "").upper()

                if reason in {"accessnotconfigured", "service_disabled"} or status == "PERMISSION_DENIED":
                    return self._json({
                        "ok": False,
                        "error_code": "CALENDAR_API_DISABLED",
                        "error": "Google Calendar API n'est pas activée pour ce projet Google Cloud.",
                        "details": info.get("message", ""),
                        "activation_url": info.get("activation_url", ""),
                    }, 502)

                if reason in {"insufficientpermissions", "access_token_scope_insufficient"}:
                    return self._json({
                        "ok": False,
                        "error_code": "CALENDAR_SCOPE_INSUFFICIENT",
                        "error": "Le token OAuth n'a pas le scope Google Calendar requis.",
                        "details": info.get("message", ""),
                    }, 502)

                return self._json({
                    "ok": False,
                    "error_code": "CALENDAR_HTTP_ERROR",
                    "error": f"Google Calendar HTTP {e.code}",
                    "details": info.get("message", body),
                }, 502)
            except Exception as e:
                return self._json({"error": str(e)}, 500)
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
            save(data)
            return self._json({"ok": True})

        if self.path == "/api/run-v3":
            v3_path = os.path.join(DIR, "v3.py")
            try:
                result = subprocess.run(
                    ["python3", v3_path],
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
            try:
                account_email = (data.get("account", "") or "").strip()
                account = pick_google_oauth_account(account_email)
                if not account:
                    return self._json({"error": "Aucun compte Google OAuth disponible."}, 404)

                created = create_google_calendar_event(account.get("email", ""), data)
                return self._json({"ok": True, "event": created})
            except urllib.error.HTTPError as e:
                payload, code = build_calendar_http_error_response(e)
                return self._json(payload, code)
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/calendar/events/update":
            try:
                account_email = (data.get("account", "") or "").strip()
                account = pick_google_oauth_account(account_email)
                if not account:
                    return self._json({"error": "Aucun compte Google OAuth disponible."}, 404)

                updated = update_google_calendar_event(account.get("email", ""), data)
                return self._json({"ok": True, "event": updated})
            except urllib.error.HTTPError as e:
                payload, code = build_calendar_http_error_response(e)
                return self._json(payload, code)
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/calendar/events/delete":
            try:
                account_email = (data.get("account", "") or "").strip()
                event_id = (data.get("eventId", "") or "").strip()
                calendar_id = (data.get("calendarId", "") or "").strip() or "primary"
                account = pick_google_oauth_account(account_email)
                if not account:
                    return self._json({"error": "Aucun compte Google OAuth disponible."}, 404)
                if not event_id:
                    return self._json({"error": "eventId requis."}, 400)

                delete_google_calendar_event(account.get("email", ""), {
                    "eventId": event_id,
                    "calendarId": calendar_id,
                })
                return self._json({"ok": True})
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", errors="replace")
                info = parse_google_error_payload(body)
                return self._json({
                    "ok": False,
                    "error_code": "CALENDAR_HTTP_ERROR",
                    "error": f"Google Calendar HTTP {e.code}",
                    "details": info.get("message", body),
                }, 502)
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

        # ── Export email to Obsidian markdown ──
        if self.path == "/api/mail/export-obsidian":
            try:
                mail_id = data.get("id", "")
                inbox = load_inbox_index()
                mail = next((m for m in inbox if m.get("id") == mail_id), None)
                if not mail:
                    return self._json({"error": "Mail introuvable"}, 404)
                md_path = export_email_to_obsidian(mail)
                return self._json({"ok": True, "path": md_path})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        # ── Bulk export to Obsidian ──
        if self.path == "/api/mail/export-obsidian-all":
            try:
                inbox = load_inbox_index()
                visible = [m for m in inbox if not m.get("deleted")]
                exported = 0
                errors = []
                for mail in visible:
                    try:
                        export_email_to_obsidian(mail)
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
                new_contacts = load_contacts()
                return self._json({"ok": True, "count": len(new_contacts)})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        self.send_error(404)

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # silencieux


if __name__ == "__main__":
    print(f"🚀 Todo → http://localhost:{PORT}")
    http.server.HTTPServer(("", PORT), Handler).serve_forever()
