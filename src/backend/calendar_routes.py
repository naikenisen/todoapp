from urllib.parse import parse_qs, urlparse


# Traite le callback OAuth Google et finalise l'authentification du compte Gmail
def handle_oauth_callback(
    handler,
    *,
    pending_store,
    load_accounts,
    find_account_index_by_email,
    normalize_auth_fields,
    save_accounts,
    exchange_google_auth_code,
    build_oauth_callback_page,
    now_ts,
):
    try:
        qs = parse_qs(urlparse(handler.path).query)
        err = (qs.get("error", [""])[0] or "").strip()
        state = (qs.get("state", [""])[0] or "").strip()
        code = (qs.get("code", [""])[0] or "").strip()

        if err:
            html = build_oauth_callback_page(False, f"Google a renvoyé une erreur: {err}")
            handler.send_response(400)
            handler.send_header("Content-Type", "text/html; charset=utf-8")
            handler.end_headers()
            handler.wfile.write(html.encode("utf-8"))
            return True

        pending = pending_store.pop(state, None)
        if not pending:
            html = build_oauth_callback_page(False, "État OAuth invalide ou expiré.")
            handler.send_response(400)
            handler.send_header("Content-Type", "text/html; charset=utf-8")
            handler.end_headers()
            handler.wfile.write(html.encode("utf-8"))
            return True

        if not code:
            html = build_oauth_callback_page(False, "Code OAuth absent.")
            handler.send_response(400)
            handler.send_header("Content-Type", "text/html; charset=utf-8")
            handler.end_headers()
            handler.wfile.write(html.encode("utf-8"))
            return True

        account_email = pending["account_email"]
        accounts = load_accounts()
        idx = find_account_index_by_email(accounts, account_email)
        if idx < 0:
            html = build_oauth_callback_page(False, "Compte cible introuvable. Réessaie depuis l'application.")
            handler.send_response(404)
            handler.send_header("Content-Type", "text/html; charset=utf-8")
            handler.end_headers()
            handler.wfile.write(html.encode("utf-8"))
            return True

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
        account["oauth_token_expiry"] = now_ts() + max(30, expires_in - 30)
        if refresh_token:
            account["oauth_refresh_token"] = refresh_token
        granted_scope = (token_data.get("scope", "") or "").strip()
        if granted_scope:
            account["oauth_scope"] = granted_scope

        accounts[idx] = account
        save_accounts(accounts)

        html = build_oauth_callback_page(True, f"Le compte {account_email} est désormais connecté via Google OAuth 2.0.")
        handler.send_response(200)
        handler.send_header("Content-Type", "text/html; charset=utf-8")
        handler.end_headers()
        handler.wfile.write(html.encode("utf-8"))
        return True
    except Exception as e:
        html = build_oauth_callback_page(False, f"Impossible de finaliser OAuth: {e}")
        handler.send_response(500)
        handler.send_header("Content-Type", "text/html; charset=utf-8")
        handler.end_headers()
        handler.wfile.write(html.encode("utf-8"))
        return True

