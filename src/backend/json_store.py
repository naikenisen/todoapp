import json
import os
import shutil


# Lit un fichier JSON avec repli sur une sauvegarde en cas d'erreur de lecture
def read_json_with_backup(path, default_value):
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


# Écrit un fichier JSON de manière atomique en conservant une sauvegarde de la version précédente
def atomic_write_json(path, payload):
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
