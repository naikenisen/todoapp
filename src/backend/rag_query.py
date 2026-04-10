
from __future__ import annotations

import argparse
import logging
import os
import re
import sys
import textwrap
import unicodedata
from dataclasses import dataclass, field
from typing import Optional

from dotenv import load_dotenv
from neo4j import GraphDatabase
from neo4j.exceptions import ServiceUnavailable

from neo4j_ingest import EmbeddingService, connect_neo4j
from app_config import APP_DATA_DIR

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
# Logger du module
log = logging.getLogger(__name__)

from pathlib import Path as _Path
# Chemin absolu de la racine du projet
_PROJECT_ROOT = str(_Path(__file__).resolve().parents[2])


# Charge les variables d'environnement depuis plusieurs emplacements candidats
def _load_runtime_env() -> None:
    candidates = [
        (os.getenv("ISENAPP_ENV_FILE") or "").strip(),
        os.path.join(_PROJECT_ROOT, ".env"),
        os.path.join(os.getcwd(), ".env"),
        os.path.join(APP_DATA_DIR, ".env"),
        str(_Path.home() / ".config" / "isenapp" / ".env"),
    ]
    seen = set()
    for candidate in candidates:
        if not candidate:
            continue
        path = os.path.abspath(candidate)
        if path in seen:
            continue
        seen.add(path)
        if os.path.isfile(path):
            load_dotenv(path, override=False)


_load_runtime_env()
# Clé d'API Google Gemini pour la génération de réponses
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
# Modèle Gemini principal utilisé pour la génération
GEMINI_MODEL = (os.getenv("GEMINI_MODEL", "gemma-3-27b-it") or "").strip() or "gemma-3-27b-it"
# Liste des modèles Gemini de repli en cas d'échec du modèle principal
GEMINI_FALLBACK_MODELS = [
    m.strip()
    for m in (os.getenv("GEMINI_FALLBACK_MODELS", "gemini-2.5-flash") or "").split(",")
    if m.strip()
]

# Nombre de résultats vectoriels récupérés par défaut
TOP_K = 5

# Ensemble de mots vides français exclus de la tokenisation
STOPWORDS_FR = {
    "a", "au", "aux", "avec", "ce", "ces", "dans", "de", "des", "du",
    "elle", "en", "et", "eux", "il", "je", "la", "le", "les", "leur",
    "lui", "ma", "mais", "me", "meme", "mes", "moi", "mon", "ne", "nos",
    "notre", "nous", "on", "ou", "par", "pas", "pour", "qu", "que", "qui",
    "sa", "se", "ses", "son", "sur", "ta", "te", "tes", "toi", "ton", "tu",
    "un", "une", "vos", "votre", "vous", "d", "l", "n", "y",
}


# Vérifie si la clé API Gemini est configurée
def is_llm_configured() -> bool:
    return bool((GEMINI_API_KEY or "").strip())


# Retourne la liste ordonnée des modèles Gemini à tenter
def _gemini_model_candidates() -> list[str]:
    models: list[str] = []
    for model in [GEMINI_MODEL, *GEMINI_FALLBACK_MODELS]:
        if model and model not in models:
            models.append(model)
    return models or ["gemma-3-27b-it", "gemini-2.5-flash"]


# Réécrit la question utilisateur via Gemini pour améliorer la pertinence du retrieval
def rewrite_question_for_retrieval(question: str) -> str:
    q = (question or "").strip()
    if not q:
        return q
    if not is_llm_configured():
        return q

    try:
        from langchain_google_genai import ChatGoogleGenerativeAI
    except ImportError:
        return q

    prompt = (
        "Tu es un assistant de reformulation pour un moteur de recherche d'emails. "
        "Réécris la requête pour maximiser la pertinence sémantique. "
        "Règles: conserve impérativement les noms propres, dates, contraintes 'envoyé par', "
        "et les termes métier (ex: candidature, lettre de motivation, CV). "
        "N'enlève jamais les entités importantes. Garde la même langue que la requête. "
        "Retourne UNE seule ligne, sans explication.\n\n"
        f"Requête utilisateur: {q}\n"
        "Requête optimisée:"
    )
    for model in _gemini_model_candidates():
        try:
            llm = ChatGoogleGenerativeAI(
                model=model,
                google_api_key=GEMINI_API_KEY,
                temperature=0.0,
                max_output_tokens=80,
            )
            rewritten = (llm.invoke(prompt).content or "").strip()
            if not rewritten:
                continue
            rewritten = " ".join(rewritten.splitlines()).strip()
            if not rewritten:
                continue

            orig_tokens = _tokenize_question(q)
            rew_tokens = _tokenize_question(rewritten)
            if len(rew_tokens) < max(3, len(orig_tokens) // 2):
                continue
            if len(rewritten) < max(12, int(len(q) * 0.45)):
                continue
            if model != GEMINI_MODEL:
                log.warning("Rewrite via fallback model: %s", model)
            return rewritten
        except Exception as exc:
            log.warning("Echec rewrite Gemini model=%s: %s", model, exc)
            continue
    return q



# Résultat de recherche enrichi par la traversée du graphe Neo4j
@dataclass
class EmailGraphResult:
    email_id: str
    subject: str
    date: str
    body_snippet: str
    score: float
    sender_name: str = ""
    sender_email: str = ""
    recipients: list[str] = field(default_factory=list)
    topics: list[str] = field(default_factory=list)
    attachments: list[str] = field(default_factory=list)
    eml_file: str = ""



# Interroge l'index vectoriel Neo4j et retourne les emails les plus proches
def vector_search(driver, question_embedding: list[float], top_k: int = TOP_K) -> list[dict]:
    query = """
    CALL db.index.vector.queryNodes('email_embedding', $top_k, $embedding)
    YIELD node AS email, score
    RETURN email.id        AS id,
           email.subject   AS subject,
           email.date      AS date,
           email.date_iso  AS date_iso,
           left(email.body, 500) AS body_snippet,
           email.source    AS eml_file,
           score
    ORDER BY score DESC
    """
    with driver.session() as session:
        result = session.run(query, top_k=top_k, embedding=question_embedding)
        return [dict(record) for record in result]


# Normalise un texte en minuscules sans accents
def _normalize_text(text: str) -> str:
    txt = (text or "").lower()
    txt = unicodedata.normalize("NFD", txt)
    txt = "".join(ch for ch in txt if unicodedata.category(ch) != "Mn")
    return txt


# Tokenise la question en filtrant les stopwords français
def _tokenize_question(question: str) -> list[str]:
    norm = _normalize_text(question)
    tokens = re.findall(r"[a-z0-9_\-]{2,}", norm)
    return [t for t in tokens if t not in STOPWORDS_FR]


# Calcule un bonus lexical et métadonnées pour compléter le score vectoriel
def _hybrid_bonus(tokens: list[str], result: EmailGraphResult) -> float:
    if not tokens:
        return 0.0

    subject = _normalize_text(result.subject)
    snippet = _normalize_text(result.body_snippet)
    sender = _normalize_text(result.sender_name)
    topics = " ".join(_normalize_text(t) for t in (result.topics or []))
    attachments = " ".join(_normalize_text(a) for a in (result.attachments or []))

    bonus = 0.0
    for tok in tokens:
        if tok in subject:
            bonus += 0.28
        if tok in snippet:
            bonus += 0.22
        if tok in sender:
            bonus += 0.35
        if tok in topics:
            bonus += 0.20
        if tok in attachments:
            bonus += 0.25

    return bonus


# Extrait un indice d'expéditeur depuis les formulations du type envoyé par X
def _extract_sender_hint(question: str) -> str:
    norm_q = _normalize_text(question)
    patterns = [
        r"\bpar\s+([a-z0-9_\-]{2,})",
        r"\b(?:ecrite|ecrit|envoye|envoyee)\s+(?:par\s+)?([a-z0-9_\-]{2,})",
        r"\b(?:written|sent)\s+by\s+([a-z0-9_\-]{2,})",
    ]
    for p in patterns:
        m = re.search(p, norm_q)
        if m:
            return m.group(1)
    return ""


# Retourne True si l'un des termes est présent dans la chaîne
def _contains_any(haystack: str, needles: list[str]) -> bool:
    return any(n in haystack for n in needles)


# Calcule des bonus et malus selon les contraintes explicites détectées dans la question
def _intent_constraint_bonus(question: str, result: EmailGraphResult) -> float:
    q = _normalize_text(question)
    sender = _normalize_text(result.sender_name)
    blob = " ".join([
        _normalize_text(result.subject),
        _normalize_text(result.body_snippet),
        " ".join(_normalize_text(t) for t in (result.topics or [])),
        " ".join(_normalize_text(a) for a in (result.attachments or [])),
        sender,
    ])

    bonus = 0.0

    asks_cover_letter = _contains_any(q, ["lettre de motivation", "cover letter", "motivation letter"])
    asks_stage = _contains_any(q, ["stage", "internship", "intern"])
    asks_candidature = _contains_any(q, ["candidature", "application", "postule", "apply"])

    if asks_cover_letter:
        has_cover = _contains_any(blob, ["lettre de motivation", "motivation", "cover letter"])
        has_stage_or_cand = _contains_any(blob, ["stage", "intern", "candidature", "application"])
        if has_cover:
            bonus += 0.95
        elif has_stage_or_cand:
            bonus += 0.15
        else:
            bonus -= 0.65

    if asks_stage:
        if _contains_any(blob, ["stage", "internship", "intern"]):
            bonus += 0.55
        else:
            bonus -= 0.30

    if asks_candidature:
        if _contains_any(blob, ["candidature", "application", "postule", "apply"]):
            bonus += 0.45
        else:
            bonus -= 0.25

    return bonus


# Concatène les champs textuels normalisés d'un résultat pour les règles d'intention
def _result_blob(result: EmailGraphResult) -> str:
    return " ".join([
        _normalize_text(result.subject),
        _normalize_text(result.body_snippet),
        " ".join(_normalize_text(t) for t in (result.topics or [])),
        " ".join(_normalize_text(a) for a in (result.attachments or [])),
        _normalize_text(result.sender_name),
    ])


# Vérifie si un résultat contient des indicateurs de lettre de motivation
def _matches_cover_letter_intent(result: EmailGraphResult) -> bool:
    blob = _result_blob(result)
    return _contains_any(blob, ["lettre de motivation", "motivation", "cover letter"])


# Détecte les types d'intention présents dans la question
def _intent_flags(question: str) -> dict[str, bool]:
    q = _normalize_text(question)
    return {
        "cover": _contains_any(q, ["lettre de motivation", "cover letter", "motivation letter"]),
        "stage": _contains_any(q, ["stage", "internship", "intern"]),
        "candidature": _contains_any(q, ["candidature", "application", "postule", "apply"]),
    }


# Retourne les IDs d'emails correspondant aux contraintes métier via Neo4j
def _lexical_intent_candidate_ids(
    driver,
    sender_hint: str,
    asks_cover: bool,
    asks_stage: bool,
    asks_candidature: bool,
    limit: int = 80,
) -> set[str]:
    if not sender_hint and not asks_cover and not asks_stage and not asks_candidature:
        return set()

    query = """
    MATCH (e:Email)
    OPTIONAL MATCH (s:Person)-[:SENT]->(e)
    OPTIONAL MATCH (e)-[:HAS_ATTACHMENT]->(d:Document)
    WITH e,
         toLower(coalesce(s.name, '')) AS sender,
         toLower(coalesce(e.subject, '')) AS subj,
         toLower(coalesce(e.body, '')) AS body,
         collect(toLower(coalesce(d.filename, ''))) AS atts
    WITH e,
         CASE
            WHEN $sender_hint = '' THEN 1
            WHEN sender CONTAINS $sender_hint OR subj CONTAINS $sender_hint OR body CONTAINS $sender_hint THEN 1
            ELSE 0
         END AS sender_ok,
         CASE
            WHEN $asks_cover = false THEN 1
            WHEN subj CONTAINS 'lettre de motivation'
              OR body CONTAINS 'lettre de motivation'
              OR subj CONTAINS 'cover letter'
              OR body CONTAINS 'cover letter'
              OR any(a IN atts WHERE a CONTAINS 'motivation' OR a CONTAINS 'cover')
                            OR (
                                        (subj CONTAINS 'stage' OR body CONTAINS 'stage' OR subj CONTAINS 'intern' OR body CONTAINS 'intern')
                                AND (subj CONTAINS 'candidature' OR body CONTAINS 'candidature' OR subj CONTAINS 'application' OR body CONTAINS 'application')
                            )
            THEN 1
            ELSE 0
         END AS cover_ok,
         CASE
            WHEN $asks_stage = false THEN 1
            WHEN subj CONTAINS 'stage' OR body CONTAINS 'stage' OR subj CONTAINS 'intern' OR body CONTAINS 'intern'
            THEN 1
            ELSE 0
         END AS stage_ok,
         CASE
            WHEN $asks_candidature = false THEN 1
            WHEN subj CONTAINS 'candidature' OR body CONTAINS 'candidature' OR subj CONTAINS 'application' OR body CONTAINS 'application'
            THEN 1
            ELSE 0
         END AS candidature_ok
    WHERE sender_ok = 1 AND cover_ok = 1 AND stage_ok = 1 AND candidature_ok = 1
    RETURN e.id AS id
    LIMIT $limit
    """
    with driver.session() as session:
        rows = session.run(
            query,
            sender_hint=sender_hint,
            asks_cover=asks_cover,
            asks_stage=asks_stage,
            asks_candidature=asks_candidature,
            limit=limit,
        )
        return {r["id"] for r in rows}


# Récupère les champs de base depuis Neo4j pour une liste d'IDs d'email
def _fetch_hits_by_ids(driver, ids: list[str]) -> list[dict]:
    if not ids:
        return []
    query = """
    MATCH (email:Email)
    WHERE email.id IN $ids
    RETURN email.id        AS id,
           email.subject   AS subject,
           email.date      AS date,
           email.date_iso  AS date_iso,
           left(email.body, 500) AS body_snippet,
           email.source    AS eml_file,
           0.0             AS score
    """
    with driver.session() as session:
        rows = [dict(r) for r in session.run(query, ids=ids)]
    by_id = {r["id"]: r for r in rows}
    return [by_id[i] for i in ids if i in by_id]


# Calcule la moyenne de deux vecteurs d'embedding de même dimension
def _blend_vectors(v1: list[float], v2: list[float]) -> list[float]:
    if len(v1) != len(v2):
        return v1
    return [(a + b) / 2.0 for a, b in zip(v1, v2)]



# Traverse le graphe autour d'un email pour récupérer expéditeur, destinataires et pièces jointes
def enrich_with_graph(driver, email_id: str) -> dict:
    query = """
    MATCH (e:Email {id: $eid})

    OPTIONAL MATCH (sender:Person)-[:SENT]->(e)
    OPTIONAL MATCH (e)-[:RECEIVED_BY]->(recipient:Person)
    OPTIONAL MATCH (e)-[:ABOUT]->(topic:Topic)
    OPTIONAL MATCH (e)-[:HAS_ATTACHMENT]->(doc:Document)

    RETURN sender.name       AS sender_name,
           sender.email      AS sender_email,
           collect(DISTINCT recipient.name)  AS recipients,
           collect(DISTINCT topic.name)      AS topics,
           collect(DISTINCT doc.filename)    AS attachments,
           e.source          AS eml_file
    """
    with driver.session() as session:
        result = session.run(query, eid=email_id)
        record = result.single()
        if record is None:
            return {}
        return dict(record)


# Alias de search_and_enrich_with_meta retournant uniquement la liste de résultats
def search_and_enrich(
    driver,
    embedder: EmbeddingService,
    question: str,
    top_k: int = TOP_K,
) -> list[EmailGraphResult]:
    results, _meta = search_and_enrich_with_meta(driver, embedder, question, top_k=top_k)
    return results


# Pipeline complet de recherche avec réécriture de requête, retrieval vectoriel et reranking hybride
def search_and_enrich_with_meta(
    driver,
    embedder: EmbeddingService,
    question: str,
    top_k: int = TOP_K,
) -> tuple[list[EmailGraphResult], dict]:
    log.info("Vectorisation de la question …")
    original_question = (question or "").strip()
    retrieval_question = rewrite_question_for_retrieval(original_question)

    base_embedding = embedder.encode_query(original_question)
    if retrieval_question and retrieval_question != original_question:
        rewritten_embedding = embedder.encode_query(retrieval_question)
        question_embedding = _blend_vectors(base_embedding, rewritten_embedding)
    else:
        question_embedding = base_embedding

    retrieve_k = min(max(top_k * 30, 120), 400)
    log.info("Recherche vectorielle (top %d candidates) …", retrieve_k)
    hits = vector_search(driver, question_embedding, retrieve_k)

    if not hits:
        log.info("Aucun résultat trouvé.")
        return [], {
            "original_question": original_question,
            "retrieval_question": retrieval_question,
            "question_rewritten": retrieval_question != original_question,
        }

    log.info("%d candidat(s), enrichissement via le graphe …", len(hits))
    merged_q = original_question + " " + retrieval_question
    q_tokens = _tokenize_question(merged_q)
    sender_hint = _extract_sender_hint(merged_q)
    flags = _intent_flags(merged_q)
    strict_ids = _lexical_intent_candidate_ids(
        driver,
        sender_hint=sender_hint,
        asks_cover=flags["cover"],
        asks_stage=flags["stage"],
        asks_candidature=flags["candidature"],
        limit=120,
    )

    if strict_ids:
        existing = {h["id"] for h in hits}
        missing_ids = [eid for eid in strict_ids if eid not in existing]
        if missing_ids:
            hits.extend(_fetch_hits_by_ids(driver, missing_ids[:200]))
    results: list[EmailGraphResult] = []
    for hit in hits:
        graph_ctx = enrich_with_graph(driver, hit["id"])
        eml_file = hit.get("eml_file", "") or graph_ctx.get("eml_file", "") or ""
        row = EmailGraphResult(
            email_id=hit["id"],
            subject=hit["subject"] or "",
            date=hit["date"] or hit.get("date_iso", ""),
            body_snippet=hit["body_snippet"] or "",
            score=hit["score"],
            sender_name=graph_ctx.get("sender_name", "") or "",
            sender_email=graph_ctx.get("sender_email", "") or "",
            recipients=graph_ctx.get("recipients", []),
            topics=graph_ctx.get("topics", []),
            attachments=graph_ctx.get("attachments", []),
            eml_file=eml_file,
        )

        row.score = float(row.score) + _hybrid_bonus(q_tokens, row)
        row.score += _intent_constraint_bonus(original_question + " " + retrieval_question, row)
        if strict_ids and row.email_id in strict_ids:
            row.score += 1.75
        results.append(row)

    if sender_hint:
        any_sender_match = any(sender_hint in _normalize_text(r.sender_name) for r in results)
        if any_sender_match:
            for r in results:
                sender_norm = _normalize_text(r.sender_name)
                if sender_hint in sender_norm:
                    r.score += 0.90
                else:
                    r.score -= 50.0
        else:
            for r in results:
                blob = " ".join([
                    _normalize_text(r.subject),
                    _normalize_text(r.body_snippet),
                    " ".join(_normalize_text(a) for a in (r.attachments or [])),
                ])
                if sender_hint in blob:
                    r.score += 0.65

    if flags["cover"]:
        has_cover_match = any(_matches_cover_letter_intent(r) for r in results)
        if has_cover_match:
            for r in results:
                if _matches_cover_letter_intent(r):
                    r.score += 0.80
                else:
                    r.score -= 0.90

    results.sort(key=lambda r: r.score, reverse=True)

    deduped: list[EmailGraphResult] = []
    seen: set[tuple[str, str, str]] = set()
    for r in results:
        key = (_normalize_text(r.subject), _normalize_text(r.date), _normalize_text(r.sender_name))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(r)
        if len(deduped) >= top_k:
            break

    meta = {
        "original_question": original_question,
        "retrieval_question": retrieval_question,
        "question_rewritten": retrieval_question != original_question,
    }
    return deduped, meta



# Formate les résultats de recherche en contexte compact pour le LLM
def _format_context(results: list[EmailGraphResult]) -> str:
    parts: list[str] = []
    for i, r in enumerate(results, 1):
        lines = [f"[{i}] {r.subject} | {r.date} | De: {r.sender_name}"]
        if r.recipients:
            lines.append(f"  À: {', '.join(r.recipients)}")
        if r.topics:
            lines.append(f"  Tags: {', '.join(r.topics)}")
        if r.attachments:
            lines.append(f"  PJ: {', '.join(r.attachments)}")
        snippet = r.body_snippet[:300].strip()
        if snippet:
            lines.append(f"  > {snippet}")
        parts.append("\n".join(lines))
    return "\n\n".join(parts)


# Génère la réponse finale à la question via Gemini en se basant sur les résultats
def generate_answer(question: str, results: list[EmailGraphResult]) -> str:
    if not is_llm_configured():
        log.warning("GEMINI_API_KEY non définie — réponse brute sans LLM.")
        return _format_context(results)

    try:
        from langchain_google_genai import ChatGoogleGenerativeAI
    except ImportError:
        log.error("langchain-google-genai non installé. pip install langchain-google-genai")
        return _format_context(results)

    context = _format_context(results)
    prompt = (
        "Réponds en français, concis. Base-toi UNIQUEMENT sur ces emails. "
        "Cite noms, dates, pièces jointes si pertinent. "
        "Si l'info manque, dis-le.\n\n"
        f"EMAILS:\n{context}\n\n"
        f"Q: {question}\nR:"
    )

    last_exc: Exception | None = None
    for model in _gemini_model_candidates():
        try:
            llm = ChatGoogleGenerativeAI(
                model=model,
                google_api_key=GEMINI_API_KEY,
                temperature=0.2,
                max_output_tokens=500,
            )
            response = llm.invoke(prompt)
            if model != GEMINI_MODEL:
                log.warning("Answer generated via fallback model: %s", model)
            return response.content
        except Exception as exc:
            last_exc = exc
            log.warning("Echec answer Gemini model=%s: %s", model, exc)

    log.error("Tous les modèles Gemini ont échoué: %s", last_exc)
    return _format_context(results)



# Affiche les résultats de recherche de façon lisible dans le terminal
def print_results(results: list[EmailGraphResult]) -> None:
    if not results:
        print("\n  Aucun email trouvé.\n")
        return
    print(f"\n{'═' * 60}")
    print(f"  {len(results)} email(s) trouvé(s)")
    print(f"{'═' * 60}\n")
    for i, r in enumerate(results, 1):
        print(f"  [{i}] {r.subject}")
        print(f"      📅 {r.date}  |  👤 {r.sender_name} <{r.sender_email}>")
        if r.recipients:
            print(f"      👥 → {', '.join(r.recipients)}")
        if r.topics:
            print(f"      🏷️  {', '.join(r.topics)}")
        if r.attachments:
            print(f"      📎 {', '.join(r.attachments)}")
        print(f"      (score: {r.score:.3f})")
        print()



# Exécute une requête complète et affiche les résultats avec la réponse LLM
def run_query(driver, embedder: EmbeddingService, question: str, top_k: int = TOP_K) -> None:
    results = search_and_enrich(driver, embedder, question, top_k=top_k)
    print_results(results)

    if results:
        print(f"{'─' * 60}")
        print("  🤖 Génération de la réponse …\n")
        answer = generate_answer(question, results)
        print(answer)
        print(f"\n{'═' * 60}\n")


# Point d'entrée CLI pour l'interrogation interactive ou directe du graphe d'emails
def main() -> None:
    parser = argparse.ArgumentParser(description="Graph RAG — Interroge le graphe d'emails")
    parser.add_argument(
        "question",
        nargs="?",
        help="Question en langage naturel",
    )
    parser.add_argument(
        "--interactive", "-i",
        action="store_true",
        help="Mode interactif (boucle de questions)",
    )
    parser.add_argument(
        "--top-k", "-k",
        type=int,
        default=TOP_K,
        help=f"Nombre de résultats vectoriels (défaut: {TOP_K})",
    )
    args = parser.parse_args()

    if not args.question and not args.interactive:
        parser.print_help()
        sys.exit(1)

    driver = connect_neo4j()
    embedder = EmbeddingService()

    try:
        if args.interactive:
            print("\n🔍 Graph RAG — Mode interactif (tapez 'q' pour quitter)\n")
            while True:
                try:
                    question = input("❓ ").strip()
                except (EOFError, KeyboardInterrupt):
                    break
                if not question or question.lower() in ("q", "quit", "exit"):
                    break
                run_query(driver, embedder, question, top_k=args.top_k)
        else:
            run_query(driver, embedder, args.question, top_k=args.top_k)
    finally:
        driver.close()


if __name__ == "__main__":
    main()
