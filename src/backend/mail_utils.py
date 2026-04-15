import email as email_lib
import email.policy
import hashlib
import os
import random
import re
import string
import time
from datetime import datetime
from email import policy as email_policy
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import getaddresses, parsedate_to_datetime

from app_config import DOWNLOADS, INBOX_INDEX_FILE, MAILS_DIR, SEEN_UIDS_FILE
from json_store import atomic_write_json, read_json_with_backup

# Indicateur de disponibilité de la bibliothèque html2text
try:
    import html2text
    HAS_HTML2TEXT = True
except ImportError:
    HAS_HTML2TEXT = False


EML_NAME_LENGTH = 9
EML_ALPHABET = string.ascii_uppercase + string.digits


# Charge les UIDs déjà vus depuis le fichier de déduplication
def load_seen_uids():
    return read_json_with_backup(SEEN_UIDS_FILE, {})


# Sauvegarde les UIDs vus dans le fichier de déduplication
def save_seen_uids(seen):
    atomic_write_json(SEEN_UIDS_FILE, seen)


# Charge l'index local de la boîte de réception en filtrant les entrées obsolètes
def load_inbox_index():
    index = read_json_with_backup(INBOX_INDEX_FILE, [])
    if not isinstance(index, list):
        return []

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


# Sauvegarde l'index de la boîte de réception
def save_inbox_index(index):
    atomic_write_json(INBOX_INDEX_FILE, index)


# Calcule un hash stable pour la déduplication des emails
def compute_mail_id(raw_bytes):
    return hashlib.sha256(raw_bytes).hexdigest()[:24]


# Nettoie une chaîne en supprimant les caractères invalides pour les noms de fichiers
def clean_string_for_file(name):
    if not name:
        return ""
    name = str(name).replace('\n', ' ').replace('\r', '')
    return re.sub(r'[\\/*?:"<>|]', "", name).strip()


# Génère un nom de fichier .eml unique à partir du sujet en ajoutant un suffixe numérique si nécessaire
def unique_eml_filename_from_subject(subject, prefix=""):
    while True:
        candidate = "".join(random.choices(EML_ALPHABET, k=EML_NAME_LENGTH)) + ".eml"
        if not os.path.exists(os.path.join(MAILS_DIR, candidate)):
            return candidate


# Extrait les corps texte brut et HTML d'un message email parsé
def extract_bodies(msg):
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


# Retourne les données brutes, le nom de fichier et le type MIME d'une pièce jointe identifiée par index ou nom
def get_attachment_payload(msg, index=None, filename=None):
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


# Enrichit un mail avec le corps et les pièces jointes depuis le fichier .eml local correspondant
def enrich_mail_from_eml(mail):
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


# Retourne la liste des noms de pièces jointes d'un message email
def extract_attachments_info(msg):
    attachments = []
    for part in msg.walk():
        content_disposition = str(part.get("Content-Disposition", ""))
        filename = part.get_filename()
        if ("attachment" in content_disposition or filename) and filename:
            attachments.append(filename)
    return attachments


# Parse les octets bruts d'un email et retourne un dictionnaire de métadonnées
def parse_email_metadata(raw_bytes, account_email=""):
    msg = email_lib.message_from_bytes(raw_bytes, policy=email_policy.default)

    subject = msg.get('Subject', 'Sans sujet') or 'Sans sujet'
    from_hdr = msg.get('From', '')
    to_hdr = msg.get('To', '')
    cc_hdr = msg.get('Cc', '')
    date_str = msg.get('Date', '')
    message_id = msg.get('Message-ID', '') or ''

    from_addrs = getaddresses([from_hdr])
    sender_name = ''
    sender_email = ''
    if from_addrs:
        sender_name = from_addrs[0][0] or ''
        sender_email = from_addrs[0][1] or ''

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


# Construit une chaîne email RFC-2822 à partir des paramètres fournis
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


# Sauvegarde un email en fichier .eml dans le dossier Téléchargements
def save_eml_to_downloads(from_addr, to_addr, subject, body_text, html_body=None):
    eml_content = build_eml(from_addr, to_addr, subject, body_text, html_body=html_body)
    safe_subject = "".join(c for c in subject if c.isalnum() or c in " _-").strip()[:80] or "mail"
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{safe_subject}_{ts}.eml"
    filepath = os.path.join(DOWNLOADS, filename)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(eml_content)
    return filepath
