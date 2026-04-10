"""Conversion massive d'emails (.eml / .mbox) en fichiers Markdown pour le Graph.

Script autonome qui parcourt un répertoire source contenant des emails
(formats .eml, .mbox, ou mbox sans extension), les convertit en fichiers
Markdown avec frontmatter YAML (tags, métadonnées), et extrait les
pièces jointes.

Dépendances internes :
    (aucune — script autonome exécuté via subprocess)

Dépendances externes :
    - html2text : conversion HTML → texte brut
"""

import os
import email
from email import policy
from email.utils import getaddresses, parsedate_to_datetime
import re
from datetime import datetime
import html2text
import mailbox
import shutil

from pathlib import Path

# --- CONFIGURATION DES CHEMINS ---
SRC_DIR = str(Path.home() / "mails")
ISENAPP_DATA = str(Path.home() / "Documents" / "isenapp_mails")
DEST_MD_DIR = os.path.join(ISENAPP_DATA, "mails")
DEST_ATT_DIR = os.path.join(ISENAPP_DATA, "attachements")

os.makedirs(DEST_MD_DIR, exist_ok=True)
os.makedirs(DEST_ATT_DIR, exist_ok=True)

h = html2text.HTML2Text()
h.ignore_links = False
h.body_width = 0

# --- CONFIGURATION DES MOTS-CLÉS ---
MOTS_CLES = ['projet', 'stage', 'facture', 'urgent', 'réunion', 'candidature', 'rapport', 'admin', 'examen']

def clean_string(name):
    if not name:
        return ""
    name = str(name).replace('\n', ' ').replace('\r', '')
    return re.sub(r'[\\/*?:"<>|]', "", name).strip()

def parse_addresses(header_value):
    if not header_value:
        return []
    addresses = getaddresses([header_value])
    results = []
    for name, addr in addresses:
        if name:
            results.append(clean_string(name))
        elif addr:
            results.append(clean_string(addr))
    return results

def parse_addresses_full(header_value):
    """Parse addresses returning (name, email) tuples to preserve both pieces of information."""
    if not header_value:
        return []
    addresses = getaddresses([header_value])
    results = []
    for name, addr in addresses:
        results.append((clean_string(name), clean_string(addr)))
    return results

def process_message(msg):
    # 1. Extraction basique
    subject = msg.get('Subject', 'Sans_Sujet')
    # Déplacer les préfixes RE/FWD à la fin
    subject_clean = subject
    prefix_pattern = r'^(\s*(re|fw|fwd)\s*[:：\-]+)'
    prefixes = []
    while True:
        m = re.match(prefix_pattern, subject_clean, re.IGNORECASE)
        if m:
            prefixes.append(m.group(1).strip())
            subject_clean = subject_clean[m.end():].lstrip()
        else:
            break
    # Ajoute les préfixes à la fin du sujet
    if prefixes:
        subject_final = f"{subject_clean} ({' '.join(prefixes)})"
    else:
        subject_final = subject_clean
    safe_subject = clean_string(subject_final) or "Sans_Sujet"
    
    # 2. Traitement des Expéditeurs, Destinataires et Domaines
    from_hdr = msg.get('From', '')
    to_hdr = msg.get('To', '')
    cc_hdr = msg.get('Cc', '')
    
    sender_list = parse_addresses(from_hdr)
    sender_name = sender_list[0] if sender_list else 'Inconnu'
    
    raw_sender = getaddresses([from_hdr])
    sender_domain = ""
    if raw_sender and raw_sender[0][1] and '@' in raw_sender[0][1]:
        sender_domain = raw_sender[0][1].split('@')[-1].lower()

    to_list = parse_addresses(to_hdr)
    cc_list = parse_addresses_full(cc_hdr)
    
    # 3. Traitement Temporel & Noms de fichiers chronologiques
    date_str = msg.get('Date', '')
    daily_note_link = ""
    year_month_tag = ""
    try:
        dt = parsedate_to_datetime(date_str)
        daily_note_link = dt.strftime("%Y-%m-%d")
        # Format mois en français
        mois_fr = [
            "janvier", "février", "mars", "avril", "mai", "juin",
            "juillet", "août", "septembre", "octobre", "novembre", "décembre"
        ]
        mois = mois_fr[dt.month - 1]
        year_month_tag = f"{mois}-{dt.year}"
        # Format propre pour le nom du fichier : YYYY-MM-DD_HHMMSS
        file_time = dt.strftime("%Y-%m-%d_%H%M%S") 
    except:
        file_time = datetime.now().strftime("%Y-%m-%d_%H%M%S")
        
    # Nouveau format de nom : Sujet puis date à la fin pour éviter les doublons
    base_md_filename = f"{safe_subject[:100]}"
    md_filename = f"{base_md_filename}.md"
    md_filepath = os.path.join(DEST_MD_DIR, md_filename)
    # Gestion des doublons : ajoute r1, r2, ... si le fichier existe déjà
    r_idx = 1
    while os.path.exists(md_filepath):
        md_filename = f"{base_md_filename}_r{r_idx}.md"
        md_filepath = os.path.join(DEST_MD_DIR, md_filename)
        r_idx += 1

    # 4. Mots-clés et Tags
    tags = ["email"]
    if sender_domain:
        tags.append(f"domaine/{sender_domain.replace('.', '_')}")
    if year_month_tag:
        tags.append(f"periode/{year_month_tag}")
        
    subject_lower = subject.lower()
    for kw in MOTS_CLES:
        if kw in subject_lower:
            tags.append(f"sujet/{kw}")

    # --- LECTURE DU CORPS ET DES PIÈCES JOINTES ---
    body_content = ""
    attachments_links = []

    for part in msg.walk():
        content_type = part.get_content_type()
        content_disposition = str(part.get("Content-Disposition"))

        if "attachment" in content_disposition or part.get_filename():
            filename = part.get_filename()
            if filename:
                # Exclusion des images
                if content_type.startswith('image/'):
                    continue
                
                safe_filename = clean_string(filename)
                # On utilise aussi la date propre pour les pièces jointes
                att_filename = f"{file_time}_{safe_filename}"
                att_filepath = os.path.join(DEST_ATT_DIR, att_filename)
                
                with open(att_filepath, 'wb') as att_file:
                    att_file.write(part.get_payload(decode=True))
                
                attachments_links.append(f"[[{att_filename}]]")

        elif content_type == "text/plain" and "attachment" not in content_disposition:
            if not body_content:
                try:
                    body_content = part.get_payload(decode=True).decode(part.get_content_charset('utf-8') or 'utf-8', errors='replace')
                except:
                    pass
        elif content_type == "text/html" and "attachment" not in content_disposition:
            try:
                html_content = part.get_payload(decode=True).decode(part.get_content_charset('utf-8') or 'utf-8', errors='replace')
                body_content = h.handle(html_content)
            except:
                pass
                
    body_lower = body_content[:500].lower()
    for kw in MOTS_CLES:
        if kw in body_lower and f"sujet/{kw}" not in tags:
            tags.append(f"sujet/{kw}")

    # --- CRÉATION DU FICHIER MARKDOWN ---
    with open(md_filepath, 'w', encoding='utf-8') as md_file:
        md_file.write("---\n")
        md_file.write("type: email\n")
        if daily_note_link:
            md_file.write(f"date: {daily_note_link}\n")
        md_file.write(f"subject: {subject_final}\n")
        md_file.write(f"from: {sender_name}\n")
        if to_list:
            md_file.write(f"to: {', '.join(to_list)}\n")
        md_file.write("tags:\n")
        for tag in tags:
            md_file.write(f"  - {tag}\n")
        md_file.write("---\n\n")
        # Titre sans date/heure
        md_file.write(f"# {subject_final}\n\n")
        # Date en info, sans crochets
        if daily_note_link:
            md_file.write(f"**🗓️ Date :** {daily_note_link} ({date_str})\n")
        else:
            md_file.write(f"**🗓️ Date :** {date_str}\n")
        md_file.write(f"**👤 De :** [[{sender_name}]]\n")
        if to_list:
            to_links = ", ".join([f"[[{dest}]]" for dest in to_list])
            md_file.write(f"**👥 À :** {to_links}\n")
        if cc_list:
            cc_parts = []
            for cc_name, cc_addr in cc_list:
                if cc_name and cc_addr:
                    cc_parts.append(f"[[{cc_name}]] <{cc_addr}>")
                elif cc_name:
                    cc_parts.append(f"[[{cc_name}]]")
                elif cc_addr:
                    cc_parts.append(cc_addr)
            if cc_parts:
                md_file.write(f"**👀 Cc :** {', '.join(cc_parts)}\n")
        md_file.write("\n---\n\n")
        md_file.write(body_content)
        md_file.write("\n\n")
        if attachments_links:
            md_file.write("---\n### 📎 Pièces Jointes\n")
            for link in attachments_links:
                md_file.write(f"- {link}\n")
    print(f"✅ Généré : {md_filename}")

# --- EXÉCUTION PRINCIPALE ---
print("🚀 Démarrage du traitement massif des emails...")

for root, dirs, files in os.walk(SRC_DIR):
    for file in files:
        filepath = os.path.join(root, file)

        # Ignorer Trash.sbd lors du traitement
        if file == "Trash.sbd":
            continue

        if file.lower().endswith('.eml'):
            with open(filepath, 'rb') as f:
                msg = email.message_from_binary_file(f, policy=policy.default)
                process_message(msg)

        elif file.lower().endswith('.mbox') or file.lower() == 'mbox':
            print(f"📂 Lecture de l'archive MBOX : {file}")
            mb = mailbox.mbox(filepath)
            for mbox_msg in mb:
                msg_bytes = mbox_msg.as_bytes()
                msg = email.message_from_bytes(msg_bytes, policy=policy.default)
                process_message(msg)

        else:
            # Détection heuristique d'un fichier mbox sans extension
            try:
                with open(filepath, 'r', encoding='utf-8', errors='ignore') as ftest:
                    first_line = ftest.readline()
                    if first_line.startswith('From '):
                        print(f"📂 Lecture de l'archive MBOX (sans extension) : {file}")
                        mb = mailbox.mbox(filepath)
                        for mbox_msg in mb:
                            msg_bytes = mbox_msg.as_bytes()
                            msg = email.message_from_bytes(msg_bytes, policy=policy.default)
                            process_message(msg)
            except Exception as e:
                print(f"Erreur lors de la détection/lecture du fichier {file} : {e}")

print("🎉 Traitement terminé ! Fichiers renommés proprement et dates ignorées sur le graphe.")

def delete_all_in_src_dir(src_dir):
    for root, dirs, files in os.walk(src_dir, topdown=False):
        for name in files:
            try:
                os.remove(os.path.join(root, name))
            except Exception as e:
                print(f"Erreur suppression fichier {name}: {e}")
        for name in dirs:
            try:
                shutil.rmtree(os.path.join(root, name))
            except Exception as e:
                print(f"Erreur suppression dossier {name}: {e}")

delete_all_in_src_dir(SRC_DIR)
print(f"🧹 Tous les fichiers et dossiers de {SRC_DIR} ont été supprimés.")