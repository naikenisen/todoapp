import json
import logging
import os
import urllib.error
import urllib.request

# Journaliseur de l'application
logger = logging.getLogger("todoapp")

# Modèle Gemini principal utilisé pour les appels IA
GEMINI_MODEL = (os.getenv("GEMINI_MODEL", "gemma-4-31b-it") or "").strip() or "gemma-4-31b-it"
# Liste des modèles Gemini de secours
GEMINI_FALLBACK_MODELS = [
    m.strip()
    for m in (os.getenv("GEMINI_FALLBACK_MODELS", "gemini-2.5-flash") or "").split(",")
    if m.strip()
]


# Retourne la liste ordonnée des modèles Gemini à essayer
def _gemini_model_candidates():
    models = []
    for model in [GEMINI_MODEL, *GEMINI_FALLBACK_MODELS]:
        if model and model not in models:
            models.append(model)
    return models or ["gemma-4-31b-it", "gemini-2.5-flash"]


# Effectue un appel générique à l'API Google Gemini et retourne le texte généré
def ai_call(token, prompt):
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


# Corrige la syntaxe, la grammaire et l'orthographe d'un texte via l'IA
def ai_reformulate(payload):
    token = payload.get("token", "")
    text = payload.get("text", "")
    prompt = (
        "Corriges la syntaxe, la grammaire et l'orthographe du texte suivant. "
        "Réponds UNIQUEMENT avec le texte corrigé, sans commentaire ni explication :\n\n"
        + text
    )
    return ai_call(token, prompt)


# Génère un mail de relance professionnel à partir d'un mail original
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


# Génère une réponse email professionnelle à partir du contexte et des instructions fournies
def ai_generate_reply(payload):
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


# Génère un résumé détaillé et exhaustif du corps d'un mail
def ai_summarize_mail(payload):
    token = payload.get("token", "")
    body = payload.get("body", "")
    prompt = (
        "CONSIGNE DE FORMAT STRICTE : ta réponse ENTIÈRE doit être UN SEUL PARAGRAPHE "
        "de prose continue, SANS AUCUN retour à la ligne.\n"
        "INTERDIT : titres, sous-titres, gras (**), bullet points (- ou *), "
        "listes numérotées, sections, sauts de ligne, markdown.\n"
        "INTERDIT : métadonnées (date, expéditeur, destinataire, objet), "
        "noms des personnes qui envoient ou reçoivent le mail.\n"
        "OBLIGATOIRE : phrases complètes enchaînées, style compte-rendu narratif, "
        "tous les faits (chiffres, noms d'auteurs, journaux, fichiers) intégrés "
        "dans le texte. Va directement aux faits sans introduction.\n"
        "Ignore les rendez-vous, réunions, visioconférences et pièces jointes.\n"
        "Réponds UNIQUEMENT avec le paragraphe.\n\n"
        "MAIL À RÉSUMER :\n"
        f"{body}"
    )
    return ai_call(token, prompt)
