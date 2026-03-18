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
import shutil
import smtplib
import socket
import ssl
import subprocess
import time
import urllib.request
from urllib.parse import parse_qs, urlparse
import xml.etree.ElementTree as ET
from datetime import datetime
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

    In dev mode we keep writing next to server.py. In packaged mode (AppImage/.deb),
    resources are typically read-only so we switch to ~/.local/share/isenapp.
    """
    if os.access(DIR, os.W_OK):
        return DIR
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


def build_eml(from_addr, to_addr, subject, body_text):
    msg = MIMEText(body_text, "plain", "utf-8")
    msg["From"] = from_addr
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg["Date"] = datetime.now().strftime("%a, %d %b %Y %H:%M:%S +0100")
    return msg.as_string()


def save_eml_to_downloads(from_addr, to_addr, subject, body_text):
    eml_content = build_eml(from_addr, to_addr, subject, body_text)
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
    return read_json_with_backup(ACCOUNTS_FILE, [])


def save_accounts(accounts):
    atomic_write_json(ACCOUNTS_FILE, accounts)


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
    server = account.get("imap_server", "")
    port = int(account.get("imap_port", 993))
    use_ssl = account.get("imap_ssl", True)
    username = account.get("username", "")
    password = account.get("password", "")
    account_email = account.get("email", username)
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
def send_email_smtp(account, to_addr, subject, body_text, cc="", attachments=None):
    """Send email via SMTP using account config. Also saves .eml locally.
    attachments: list of dicts with keys: filename, content_type, data (base64-encoded)
    """
    smtp_server = account.get("smtp_server", "")
    smtp_port = int(account.get("smtp_port", 587))
    smtp_ssl = account.get("smtp_ssl", False)
    smtp_starttls = account.get("smtp_starttls", True)
    username = account.get("username", "")
    password = account.get("password", "")
    from_addr = account.get("email", username)

    msg = MIMEMultipart()
    msg["From"] = from_addr
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg["Date"] = datetime.now().strftime("%a, %d %b %Y %H:%M:%S +0100")
    msg["Message-ID"] = f"<{hashlib.md5((from_addr + to_addr + subject + str(time.time())).encode()).hexdigest()}@isenapp>"
    if cc:
        msg["Cc"] = cc
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
        if smtp_starttls:
            server.starttls()

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
    protocol = account.get("protocol", "pop3").lower()

    if protocol == "imap":
        server = account.get("imap_server", "")
        port = int(account.get("imap_port", 993))
        use_ssl = account.get("imap_ssl", True)
        username = account.get("username", "")
        password = account.get("password", "")

        if use_ssl:
            imap = imaplib.IMAP4_SSL(server, port)
        else:
            imap = imaplib.IMAP4(server, port)

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
        if self.path == "/api/state":
            return self._json(load())
        if self.path == "/api/contacts":
            return self._json(load_contacts())
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
                    data.get("body", "")
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

        # ── Account management ──
        if self.path == "/api/accounts/save":
            try:
                accounts = data.get("accounts", [])
                save_accounts(accounts)
                return self._json({"ok": True})
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
                account = find_account_by_email(from_addr)
                if not account:
                    return self._json({"error": f"Aucun compte configuré pour {from_addr}"}, 400)
                send_email_smtp(account, to_addr, subject, body, cc, attachments=attachments)
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
