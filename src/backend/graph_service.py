"""Service Graph — graphe de vault et export email → Markdown.

Gère le graphe de connaissances : scan du vault pour extraire les nœuds
(fichiers .md + pièces jointes) et arêtes (wikilinks), lecture de fichiers,
et export d'emails au format Markdown avec frontmatter YAML.

Dépendances internes :
    - app_config : chemins (GRAPH_VAULT, GRAPH_MD_DIR, GRAPH_ATT_DIR, MAILS_DIR)
    - mail_utils : clean_string_for_file

Dépendances externes :
    - html2text (optionnel) : conversion HTML → texte brut pour le corps des emails
"""

import email as email_lib
import os
import re
from datetime import datetime
from email import policy as email_policy
from email.utils import getaddresses, parsedate_to_datetime

from app_config import MAILS_DIR, GRAPH_ATT_DIR, GRAPH_MD_DIR, GRAPH_VAULT
from mail_utils import clean_string_for_file

try:
    import html2text
    HAS_HTML2TEXT = True
except ImportError:
    HAS_HTML2TEXT = False

MOTS_CLES = ['projet', 'stage', 'facture', 'urgent', 'réunion', 'candidature', 'rapport', 'admin', 'examen']

WIKILINK_RE = re.compile(r'\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]')
DATE_RE = re.compile(r'\*\*.*Date.*:\*\*\s*(\d{4}-\d{2}-\d{2})')

def scan_vault_graph():
    """Scan le vault pour extraire nœuds (fichiers .md + attachments) et arêtes (wikilinks)."""
    vault = GRAPH_VAULT
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
                date = None
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
                    # Extract date from body
                    m = DATE_RE.search(content)
                    if m:
                        date = m.group(1)
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
                    'date': date,
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
    """Read a file from the graph vault by relative path."""
    # Sanitize: prevent directory traversal
    safe = os.path.normpath(relpath)
    if safe.startswith('..') or os.path.isabs(safe):
        raise ValueError('Invalid path')
    fpath = os.path.join(GRAPH_VAULT, safe)
    if not fpath.startswith(GRAPH_VAULT):
        raise ValueError('Path outside vault')
    if not os.path.isfile(fpath):
        raise FileNotFoundError('File not found')
    with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
        return f.read()


def export_email_to_graph(mail_meta):
    """Export a single email to graph markdown, replicating mail_to_md.py logic."""
    os.makedirs(GRAPH_MD_DIR, exist_ok=True)
    os.makedirs(GRAPH_ATT_DIR, exist_ok=True)

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
    md_filepath = os.path.join(GRAPH_MD_DIR, md_filename)
    r_idx = 1
    while os.path.exists(md_filepath):
        md_filename = f"{base_md_filename}_r{r_idx}.md"
        md_filepath = os.path.join(GRAPH_MD_DIR, md_filename)
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
                att_filepath = os.path.join(GRAPH_ATT_DIR, att_filename)
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
        eml_file = mail_meta.get("eml_file", "")
        if eml_file:
            md_file.write(f"eml_file: {eml_file}\n")
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
