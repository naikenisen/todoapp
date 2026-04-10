"""Service d'intelligence artificielle — appels Google Gemini.

Fournit des fonctions de génération de texte via l'API Google Gemini :
reformulation, rédaction de relances et réponses email.

Dépendances internes :
    (aucune)

Dépendances externes :
    - API Google Gemini (generativelanguage.googleapis.com)
"""

import json
import logging
import os
import urllib.error
import urllib.request

logger = logging.getLogger("todoapp")

GEMINI_MODEL = (os.getenv("GEMINI_MODEL", "gemma-3-27b-it") or "").strip() or "gemma-3-27b-it"
GEMINI_FALLBACK_MODELS = [
    m.strip()
    for m in (os.getenv("GEMINI_FALLBACK_MODELS", "gemini-2.5-flash") or "").split(",")
    if m.strip()
]


def _gemini_model_candidates():
    models = []
    for model in [GEMINI_MODEL, *GEMINI_FALLBACK_MODELS]:
        if model and model not in models:
            models.append(model)
    return models or ["gemma-3-27b-it", "gemini-2.5-flash"]


def ai_call(token, prompt):
    """Generic AI call via Google Gemini API — single request."""
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.3},
    }).encode()

    last_exc = None
    for model in _gemini_model_candidates():
        url = (
            "https://generativelanguage.googleapis.com/v1beta/"
            f"models/{model}:generateContent?key={token}"
        )

        req = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                result = json.loads(r.read())
            if model != GEMINI_MODEL:
                logger.warning("Gemini fallback model used: %s", model)
            return result["candidates"][0]["content"]["parts"][0]["text"]
        except urllib.error.HTTPError as e:
            error_body = e.read().decode()
            try:
                msg = json.loads(error_body).get("error", {}).get("message", error_body)
            except Exception:
                msg = error_body
            last_exc = RuntimeError(f"Gemini {e.code} ({model}): {msg}")
            logger.warning("Gemini API %d (%s): %s", e.code, model, msg)
            continue
        except Exception as e:
            last_exc = e
            logger.warning("Gemini API error (%s): %s", model, e)
            continue

    logger.error("Tous les modèles Gemini ont échoué")
    raise last_exc if last_exc else RuntimeError("All Gemini models failed")


def ai_reformulate(payload):
    """Corrige la syntaxe, grammaire et orthographe d'un texte."""
    token = payload.get("token", "")
    text = payload.get("text", "")
    prompt = (
        "Corriges la syntaxe, la grammaire et l'orthographe du texte suivant. "
        "Réponds UNIQUEMENT avec le texte corrigé, sans commentaire ni explication :\n\n"
        + text
    )
    return ai_call(token, prompt)


def ai_generate_reminder(payload):
    """Génère un mail de relance à partir d'un mail original."""
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


def ai_generate_reply(payload):
    """Génère une réponse email professionnelle à partir du contexte fourni."""
    token = payload.get("token", "")
    user_prompt = payload.get("prompt", "")
    subject = payload.get("subject", "")
    sender = payload.get("from", "")
    original_text = payload.get("original_text", "")
    draft = payload.get("draft", "")

    prompt = (
        "Tu es un assistant de redaction email professionnel en francais. "
        "Genere UNIQUEMENT le texte de reponse (sans objet, sans salutation imposee, sans commentaire). "
        "Respecte strictement les instructions utilisateur ci-dessous. "
        "N'inclus pas le message original dans la sortie.\n\n"
        f"Sujet du fil : {subject}\n"
        f"Expediteur original : {sender}\n\n"
        "Instructions utilisateur :\n"
        f"{user_prompt}\n\n"
        "Brouillon actuel (a ameliorer si present) :\n"
        f"{draft}\n\n"
        "Message original recu (contexte, NE PAS recopier integralement) :\n"
        f"{original_text}"
    )
    return ai_call(token, prompt)
