import base64
import hashlib
import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

from account_store import (
    find_account_index_by_email,
    load_accounts,
    normalize_auth_fields,
    save_accounts,
)


# Génère la page HTML de retour OAuth Google indiquant le succès ou l'échec
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


# Encode des octets en base64 URL-safe sans rembourrage
def _b64url(data_bytes):
    return base64.urlsafe_b64encode(data_bytes).decode().rstrip("=")


# Génère une paire verifier/challenge PKCE pour le flux OAuth2
def generate_pkce_pair():
    verifier = _b64url(secrets.token_bytes(64))
    challenge = _b64url(hashlib.sha256(verifier.encode("utf-8")).digest())
    return verifier, challenge


# Échange un code d'autorisation Google contre des tokens OAuth2
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


# Rafraîchit le token d'accès Gmail via le refresh token stocké dans le compte
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


# Retourne un token d'accès Gmail valide en le rafraîchissant si nécessaire
def get_valid_gmail_access_token(account_email):
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

