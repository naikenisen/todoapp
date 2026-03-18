#!/usr/bin/env python3
"""Serveur local pour l'app Todo & Mail — sauvegarde dans data.json."""

import csv
import email as email_lib
import email.policy
import hashlib
import http.server
import json
import logging
import mailbox
import os
import poplib
import re
import shutil
import smtplib
import subprocess
import time
import urllib.request
from datetime import datetime
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
DATA = os.path.join(DIR, "data.json")
CONTACTS_CSV = os.path.join(DIR, "contacts_complets_v2.csv")
LOG_FILE = os.path.join(DIR, "api_errors.log")
DOWNLOADS = str(Path.home() / "Téléchargements")

# ── Mail storage ──
MAILS_DIR = "/home/naiken/mails"
SEEN_UIDS_FILE = os.path.join(DIR, "seen_uids.json")
ACCOUNTS_FILE = os.path.join(DIR, "accounts.json")
INBOX_INDEX_FILE = os.path.join(DIR, "inbox_index.json")

OBSIDIAN_MD_DIR = "/home/naiken/Documents/obsidian_coffres/isen/mails"
OBSIDIAN_ATT_DIR = "/home/naiken/Documents/obsidian_coffres/isen/attachements"

os.makedirs(MAILS_DIR, exist_ok=True)

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
    try:
        with open(DATA, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"sections": [], "settings": {}}


def save(data):
    with open(DATA, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


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
    try:
        with open(ACCOUNTS_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def save_accounts(accounts):
    with open(ACCOUNTS_FILE, "w", encoding="utf-8") as f:
        json.dump(accounts, f, ensure_ascii=False, indent=2)


# ═══════════════════════════════════════════════════════
#  Seen UIDs — deduplication
# ═══════════════════════════════════════════════════════
def load_seen_uids():
    try:
        with open(SEEN_UIDS_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_seen_uids(seen):
    with open(SEEN_UIDS_FILE, "w", encoding="utf-8") as f:
        json.dump(seen, f, ensure_ascii=False, indent=2)


# ═══════════════════════════════════════════════════════
#  Inbox Index — local mail metadata
# ═══════════════════════════════════════════════════════
def load_inbox_index():
    try:
        with open(INBOX_INDEX_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def save_inbox_index(index):
    with open(INBOX_INDEX_FILE, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)


def compute_mail_id(raw_bytes):
    """Compute a stable hash for deduplication."""
    return hashlib.sha256(raw_bytes).hexdigest()[:24]


def clean_string_for_file(name):
    if not name:
        return ""
    name = str(name).replace('\n', ' ').replace('\r', '')
    return re.sub(r'[\\/*?:"<>|]', "", name).strip()


def extract_text_body(msg):
    """Extract text body from a parsed email message."""
    body_content = ""
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
            if not body_content:
                try:
                    charset = part.get_content_charset('utf-8') or 'utf-8'
                    body_content = part.get_payload(decode=True).decode(charset, errors='replace')
                except Exception:
                    pass
        elif content_type == "text/html" and h:
            try:
                charset = part.get_content_charset('utf-8') or 'utf-8'
                html_content = part.get_payload(decode=True).decode(charset, errors='replace')
                body_content = h.handle(html_content)
            except Exception:
                pass

    return body_content


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
    msg = email_lib.message_from_bytes(raw_bytes, policy=email_lib.policy.default)

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

    body = extract_text_body(msg)
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
        "body": body,
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

                # Save raw .eml to /home/naiken/mails
                safe_id = mail_id[:16]
                eml_filename = f"{safe_id}.eml"
                eml_path = os.path.join(MAILS_DIR, eml_filename)
                with open(eml_path, "wb") as f:
                    f.write(raw_bytes)

                # Parse metadata
                meta = parse_email_metadata(raw_bytes, account_email)
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


def fetch_all_accounts():
    """Fetch from all configured POP3 accounts."""
    accounts = load_accounts()
    total_new = 0
    all_errors = []

    for acc in accounts:
        if not acc.get("enabled", True):
            continue
        try:
            n, errs = fetch_pop3(acc)
            total_new += n
            all_errors.extend(errs)
        except Exception as e:
            all_errors.append(f"{acc.get('email', '?')}: {e}")

    return total_new, all_errors


# ═══════════════════════════════════════════════════════
#  SMTP Send
# ═══════════════════════════════════════════════════════
def send_email_smtp(account, to_addr, subject, body_text, cc=""):
    """Send email via SMTP using account config."""
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
    if cc:
        msg["Cc"] = cc
    msg.attach(MIMEText(body_text, "plain", "utf-8"))

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
    server.sendmail(from_addr, all_recipients, msg.as_string())
    server.quit()

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
    """Connect via POP3 and delete a message by UID."""
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


def export_email_to_obsidian(mail_meta):
    """Export a single email to Obsidian markdown, replicating v3.py logic."""
    os.makedirs(OBSIDIAN_MD_DIR, exist_ok=True)
    os.makedirs(OBSIDIAN_ATT_DIR, exist_ok=True)

    eml_path = os.path.join(MAILS_DIR, mail_meta.get("eml_file", ""))
    if not os.path.isfile(eml_path):
        raise FileNotFoundError(f"Fichier .eml introuvable: {eml_path}")

    with open(eml_path, "rb") as f:
        raw_bytes = f.read()

    msg = email_lib.message_from_bytes(raw_bytes, policy=email_lib.policy.default)

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
            # Filter out deleted, sort by date desc
            visible = [m for m in inbox if not m.get("deleted")]
            visible.sort(key=lambda m: m.get("date_ts", 0), reverse=True)
            return self._json(visible)
        if self.path.startswith("/api/mail/"):
            mail_id = self.path.split("/api/mail/")[1]
            inbox = load_inbox_index()
            mail = next((m for m in inbox if m.get("id") == mail_id), None)
            if mail:
                return self._json(mail)
            self.send_error(404)
            return
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

        if self.path == "/api/open-thunderbird":
            try:
                filepath = save_eml_to_downloads(
                    data.get("from", ""),
                    data.get("to", ""),
                    data.get("subject", ""),
                    data.get("body", "")
                )
                subprocess.Popen(["thunderbird", "-compose",
                    f"from='{data.get('from', '')}',to='{data.get('to', '')}',subject='{data.get('subject', '')}',body='{data.get('body', '')}'"])
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

        # ── Fetch emails (POP3) ──
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
                account = find_account_by_email(from_addr)
                if not account:
                    return self._json({"error": f"Aucun compte configuré pour {from_addr}"}, 400)
                send_email_smtp(account, to_addr, subject, body, cc)
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
