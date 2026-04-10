from app_config import ACCOUNTS_FILE
from json_store import atomic_write_json, read_json_with_backup


# Normalise les champs d'authentification pour assurer la compatibilité ascendante
def normalize_auth_fields(account):
    provider = (account.get("provider", "") or "").lower()
    auth_type = (account.get("auth_type", "") or "").lower()
    if provider == "gmail_oauth" and not auth_type:
        auth_type = "oauth2"
    if auth_type:
        account["auth_type"] = auth_type
    return account


# Charge la liste des comptes email depuis le fichier de persistance
def load_accounts():
    accounts = read_json_with_backup(ACCOUNTS_FILE, [])
    if not isinstance(accounts, list):
        return []
    for acc in accounts:
        normalize_auth_fields(acc)
    return accounts


# Sauvegarde la liste des comptes email dans le fichier de persistance
def save_accounts(accounts):
    atomic_write_json(ACCOUNTS_FILE, accounts)


# Retourne l'index du compte correspondant à l'adresse email donnée, ou -1
def find_account_index_by_email(accounts, email_addr):
    target = (email_addr or "").strip().lower()
    for idx, acc in enumerate(accounts):
        if (acc.get("email", "") or "").strip().lower() == target:
            return idx
    return -1


# Retourne la configuration du compte correspondant à une adresse email
def find_account_by_email(email_addr):
    target = (email_addr or "").lower()
    for acc in load_accounts():
        if (acc.get("email", "") or "").lower() == target:
            return acc
    return None
