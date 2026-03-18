#!/usr/bin/env python3
"""Serveur local pour l'app Todo — sauvegarde dans data.json."""

import csv
import http.server
import json
import os
import subprocess
import urllib.request
from datetime import datetime
from email.mime.text import MIMEText
from pathlib import Path

PORT = 8080
DIR = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(DIR, "data.json")
CONTACTS_CSV = os.path.join(DIR, "contacts_complets_v2.csv")
DOWNLOADS = str(Path.home() / "Téléchargements")
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
    """Generic AI call via GitHub Models API."""
    body = json.dumps({
        "model": "gpt-4o",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.3,
    }).encode()

    req = urllib.request.Request(
        "https://models.inference.ai.azure.com/chat/completions",
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )

    with urllib.request.urlopen(req, timeout=60) as r:
        result = json.loads(r.read())

    return result["choices"][0]["message"]["content"]


def ai_organize(payload):
    token = payload.get("token", "")
    sections = payload.get("sections", [])

    lines = []
    for s in sections:
        lines.append(f"\n## {s.get('emoji', '')} {s.get('title', '')}")
        if s.get("description"):
            lines.append(f"   {s['description']}")
        for t in s.get("tasks", []):
            mark = "x" if t.get("done") else " "
            indent = "  " * t.get("indent", 0)
            line = f"{indent}- [{mark}] {t.get('label', '')}"
            if t.get("note"):
                line += f"  (Note: {t['note']})"
            lines.append(line)

    prompt = (
        "Tu es un assistant d'organisation. Voici une todo-list.\n"
        "Réorganise, reformule clairement et trie les tâches en sections logiques.\n"
        "Conserve le statut fait/pas fait de chaque tâche.\n"
        "Propose un emoji approprié pour chaque section.\n"
        "Réponds UNIQUEMENT en JSON valide (sans balises markdown) avec cette structure :\n"
        '{"sections":[{"emoji":"📞","title":"...","badge":"...","color":"blue|orange|green|purple|pink|slate",'
        '"description":"...","tasks":[{"label":"...","note":"","done":false,"indent":0}]}]}\n\n'
        + "\n".join(lines)
    )

    content = ai_call(token, prompt)
    if "```" in content:
        content = content.split("```json")[-1] if "```json" in content else content.split("```")[1]
        content = content.split("```")[0]
    return json.loads(content.strip())


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


def build_eml(to_addr, subject, body_text):
    msg = MIMEText(body_text, "plain", "utf-8")
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg["Date"] = datetime.now().strftime("%a, %d %b %Y %H:%M:%S +0100")
    return msg.as_string()


def save_eml_to_downloads(to_addr, subject, body_text):
    eml_content = build_eml(to_addr, subject, body_text)
    safe_subject = "".join(c for c in subject if c.isalnum() or c in " _-").strip()[:80] or "mail"
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{safe_subject}_{ts}.eml"
    filepath = os.path.join(DOWNLOADS, filename)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(eml_content)
    return filepath


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DIR, **kw)

    def do_GET(self):
        if self.path == "/api/state":
            return self._json(load())
        if self.path == "/api/contacts":
            return self._json(load_contacts())
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

        if self.path == "/api/organize":
            try:
                result = ai_organize(data)
                return self._json(result)
            except Exception as e:
                return self._json({"error": str(e)}, 500)

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
                    data.get("to", ""),
                    data.get("subject", ""),
                    data.get("body", "")
                )
                subprocess.Popen(["thunderbird", "-compose",
                    f"to='{data.get('to', '')}',subject='{data.get('subject', '')}',body='{data.get('body', '')}'"])
                return self._json({"ok": True, "path": filepath})
            except Exception as e:
                return self._json({"error": str(e)}, 500)

        if self.path == "/api/generate-reminder":
            try:
                result = ai_generate_reminder(data)
                return self._json({"ok": True, "reminder": result})
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
