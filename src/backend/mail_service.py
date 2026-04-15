import base64
import hashlib
import imaplib
import os
import poplib
import re
import smtplib
import time
from datetime import datetime
from email import encoders
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText


def _save_eml_bytes_atomic(raw_bytes, subject, *, unique_eml_filename_from_subject, mails_dir, max_attempts=100):
    os.makedirs(mails_dir, exist_ok=True)
    for _ in range(max_attempts):
        eml_filename = unique_eml_filename_from_subject(subject)
        eml_path = os.path.join(mails_dir, eml_filename)
        try:
            with open(eml_path, "xb") as f:
                f.write(raw_bytes)
            return eml_filename
        except FileExistsError:
            continue
    raise RuntimeError("Impossible de créer un nom .eml unique sans écrasement")


# Construit la chaîne XOAUTH2 encodée pour l'authentification OAuth2 SMTP/IMAP
def build_xoauth2_string(username, access_token):
    raw = f"user={username}\x01auth=Bearer {access_token}\x01\x01"
    return raw.encode("utf-8")


# Effectue l'authentification XOAUTH2 sur une connexion SMTP existante
def smtp_auth_xoauth2(server, username, access_token):
    token = base64.b64encode(build_xoauth2_string(username, access_token)).decode("ascii")
    code, resp = server.docmd("AUTH", f"XOAUTH2 {token}")
    if code != 235:
        detail = resp.decode("utf-8", errors="replace") if isinstance(resp, bytes) else str(resp)
        raise RuntimeError(f"SMTP OAuth refusé ({code}): {detail}")


# Récupère les emails d'un compte via POP3 et retourne le nombre de nouveaux messages et les erreurs
def fetch_pop3(
    account,
    *,
    load_seen_uids,
    save_seen_uids,
    load_inbox_index,
    save_inbox_index,
    compute_mail_id,
    parse_email_metadata,
    unique_eml_filename_from_subject,
    mails_dir,
):
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

        pop.stat()
        _, uid_list, _ = pop.uidl()
        uid_map = {}
        for entry in uid_list:
            if isinstance(entry, memoryview):
                entry = entry.tobytes()
            if isinstance(entry, bytes):
                entry = entry.decode("utf-8", errors="replace")
            if not isinstance(entry, str):
                entry = str(entry)
            parts = entry.strip().split(None, 1)
            if len(parts) == 2:
                uid_map[parts[0]] = parts[1]

        for msg_num_str, uid in uid_map.items():
            if uid in seen[account_key]:
                continue

            msg_num = int(msg_num_str)
            try:
                _, lines, _ = pop.retr(msg_num)
                raw_bytes = b"\r\n".join(lines)

                mail_id = compute_mail_id(raw_bytes)

                meta = parse_email_metadata(raw_bytes, account_email)
                eml_filename = _save_eml_bytes_atomic(
                    raw_bytes,
                    meta.get("subject", "mail"),
                    unique_eml_filename_from_subject=unique_eml_filename_from_subject,
                    mails_dir=mails_dir,
                )

                meta["id"] = mail_id
                meta["uid"] = uid
                meta["eml_file"] = eml_filename
                meta["processed"] = False
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


# Récupère les emails d'un compte via IMAP et retourne le nombre de nouveaux messages et les erreurs
def fetch_imap(
    account,
    *,
    normalize_auth_fields,
    get_valid_gmail_access_token,
    load_seen_uids,
    save_seen_uids,
    load_inbox_index,
    save_inbox_index,
    compute_mail_id,
    parse_email_metadata,
    unique_eml_filename_from_subject,
    mails_dir,
):
    account = normalize_auth_fields(account)
    server = account.get("imap_server", "")
    port = int(account.get("imap_port", 993))
    use_ssl = account.get("imap_ssl", True)
    username = account.get("username", "")
    password = account.get("password", "")
    account_email = account.get("email", username)
    auth_type = account.get("auth_type", "password")
    post_action = account.get("imap_post_action", "keep")

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

        status, data = imap.search(None, "ALL")
        if status != "OK":
            errors.append("IMAP search failed")
            imap.logout()
            return 0, errors

        msg_nums = data[0].split()
        for num in msg_nums:
            status, uid_data = imap.fetch(num, "(UID)")
            if status != "OK":
                continue
            uid_str = uid_data[0].decode("utf-8", errors="replace") if isinstance(uid_data[0], bytes) else str(uid_data[0])
            uid_match = re.search(r"UID\s+(\d+)", uid_str)
            if not uid_match:
                continue
            uid = uid_match.group(1)

            if uid in seen[account_key]:
                continue

            status, msg_data = imap.fetch(num, "(RFC822)")
            if status != "OK" or not msg_data or not msg_data[0]:
                continue

            try:
                raw_bytes = msg_data[0][1]
                if not isinstance(raw_bytes, (bytes, bytearray)):
                    continue
                mail_id = compute_mail_id(raw_bytes)

                meta = parse_email_metadata(raw_bytes, account_email)
                eml_filename = _save_eml_bytes_atomic(
                    raw_bytes,
                    meta.get("subject", "mail"),
                    unique_eml_filename_from_subject=unique_eml_filename_from_subject,
                    mails_dir=mails_dir,
                )

                meta["id"] = mail_id
                meta["uid"] = uid
                meta["eml_file"] = eml_filename
                meta["processed"] = False
                meta["deleted"] = False
                meta["protocol"] = "imap"

                inbox.append(meta)
                seen[account_key].append(uid)
                new_count += 1

                if post_action == "delete":
                    imap.store(num, "+FLAGS", "\\Deleted")

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


# Envoie un email via SMTP, sauvegarde le .eml localement et retourne True si succès
def send_email_smtp(
    account,
    to_addr,
    subject,
    body_text,
    cc="",
    attachments=None,
    html_body=None,
    *,
    normalize_auth_fields,
    get_valid_gmail_access_token,
    compute_mail_id,
    unique_eml_filename_from_subject,
    parse_email_metadata,
    load_inbox_index,
    save_inbox_index,
    mails_dir,
):
    account = normalize_auth_fields(account)
    smtp_server = account.get("smtp_server", "")
    smtp_port = int(account.get("smtp_port", 587))
    smtp_ssl = account.get("smtp_ssl", False)
    smtp_starttls = account.get("smtp_starttls", True)
    username = account.get("username", "")
    password = account.get("password", "")
    from_addr = account.get("email", username)
    auth_type = account.get("auth_type", "password")

    msg = MIMEMultipart("mixed")
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

    mail_id = compute_mail_id(raw_bytes)
    eml_filename = _save_eml_bytes_atomic(
        raw_bytes,
        subject,
        unique_eml_filename_from_subject=unique_eml_filename_from_subject,
        mails_dir=mails_dir,
    )

    meta = parse_email_metadata(raw_bytes, from_addr)
    meta["id"] = mail_id
    meta["uid"] = ""
    meta["eml_file"] = eml_filename
    meta["processed"] = True
    meta["deleted"] = False
    meta["folder"] = "sent"
    inbox = load_inbox_index()
    inbox.append(meta)
    save_inbox_index(inbox)

    return True


# Supprime un message sur le serveur distant (POP3 ou IMAP) identifié par son UID
def delete_mail_on_server(account, uid_to_delete, *, normalize_auth_fields, get_valid_gmail_access_token):
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
        else:
            imap.close()
            imap.logout()
            return False

        imap.close()
        imap.logout()
        return True

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

    _, uid_list, _ = pop.uidl()
    deleted = False
    for entry in uid_list:
        if isinstance(entry, memoryview):
            entry = entry.tobytes()
        if isinstance(entry, bytes):
            entry = entry.decode("utf-8", errors="replace")
        if not isinstance(entry, str):
            entry = str(entry)
        parts = entry.strip().split(None, 1)
        if len(parts) == 2 and parts[1] == uid_to_delete:
            pop.dele(int(parts[0]))
            deleted = True
            break

    pop.quit()
    return deleted
