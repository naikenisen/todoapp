"""Graph RAG Query — interroge le graphe Neo4j d'emails via recherche vectorielle + Cypher.

Pipeline :
  1. Vectorise la question utilisateur (sentence-transformers, all-MiniLM-L6-v2)
  2. Recherche vectorielle dans l'index Neo4j → emails les plus proches
  3. Traversée du graphe (Cypher) → expéditeur, destinataires, pièces jointes
  4. Génération de la réponse finale via Google Gemini (LangChain)

Usage :
  python rag_query.py "Trouve-moi le CV de la personne qui a postulé pour un stage M2 IA en avril"
  python rag_query.py --interactive     (mode interactif)

Dépendances internes :
    - app_config : (indirectement via neo4j_ingest)
    - neo4j_ingest : EmbeddingService, connect_neo4j, EMBEDDING_DIM

Dépendances externes :
    - neo4j, sentence-transformers, langchain-google-genai, python-dotenv
"""

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

# ── Logging ───────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# ── Env ───────────────────────────────────────────────
from pathlib import Path as _Path
_PROJECT_ROOT = str(_Path(__file__).resolve().parents[2])


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
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = (os.getenv("GEMINI_MODEL", "gemma-3-27b-it") or "").strip() or "gemma-3-27b-it"
GEMINI_FALLBACK_MODELS = [
    m.strip()
    for m in (os.getenv("GEMINI_FALLBACK_MODELS", "gemini-2.5-flash") or "").split(",")
    if m.strip()
]

# Nombre de résultats vectoriels à récupérer
TOP_K = 5

STOPWORDS_FR = {
    "a", "au", "aux", "avec", "ce", "ces", "dans", "de", "des", "du",
    "elle", "en", "et", "eux", "il", "je", "la", "le", "les", "leur",
    "lui", "ma", "mais", "me", "meme", "mes", "moi", "mon", "ne", "nos",
    "notre", "nous", "on", "ou", "par", "pas", "pour", "qu", "que", "qui",
    "sa", "se", "ses", "son", "sur", "ta", "te", "tes", "toi", "ton", "tu",
    "un", "une", "vos", "votre", "vous", "d", "l", "n", "y",
}


def is_llm_configured() -> bool:
    """Retourne True si la configuration Gemini est presente."""
    return bool((GEMINI_API_KEY or "").strip())


def _gemini_model_candidates() -> list[str]:
    """Retourne la liste des modèles à tenter (primaire + fallback)."""
    models: list[str] = []
    for model in [GEMINI_MODEL, *GEMINI_FALLBACK_MODELS]:
        if model and model not in models:
            models.append(model)
    return models or ["gemma-3-27b-it", "gemini-2.5-flash"]


def rewrite_question_for_retrieval(question: str) -> str:
    """Réécrit la question utilisateur pour améliorer le retrieval GraphRAG.

    La réécriture conserve l'intention et les contraintes explicites (personne,
    date, type de document) mais reformule en requête de recherche plus dense.
    """
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

            # Garde-fou: rejeter les réécritures trop courtes/tronquées (ex: "lettre de").
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


# ═════════════════════════════════════════════════════════
#  Data model pour les résultats
# ═════════════════════════════════════════════════════════

@dataclass
class EmailGraphResult:
    """Résultat enrichi par la traversée du graphe."""
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


# ═════════════════════════════════════════════════════════
#  Recherche vectorielle
# ═════════════════════════════════════════════════════════

def vector_search(driver, question_embedding: list[float], top_k: int = TOP_K) -> list[dict]:
    """Interroge l'index vectoriel Neo4j et retourne les top_k emails les plus proches."""
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


def _normalize_text(text: str) -> str:
    """Normalise un texte (minuscules + suppression des accents)."""
    txt = (text or "").lower()
    txt = unicodedata.normalize("NFD", txt)
    txt = "".join(ch for ch in txt if unicodedata.category(ch) != "Mn")
    return txt


def _tokenize_question(question: str) -> list[str]:
    """Tokenise la question en retirant les stopwords courts non informatifs."""
    norm = _normalize_text(question)
    tokens = re.findall(r"[a-z0-9_\-]{2,}", norm)
    return [t for t in tokens if t not in STOPWORDS_FR]


def _hybrid_bonus(tokens: list[str], result: EmailGraphResult) -> float:
    """Bonus lexical/métadonnées pour compléter le score vectoriel.

    L'objectif est de mieux remonter des résultats contenant des entités explicites
    (nom de personne, mot-clé métier, pièce jointe) même si le vecteur seul hésite.
    """
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


def _extract_sender_hint(question: str) -> str:
    """Extrait un indice d'expéditeur dans les requêtes du type 'envoyé par X'."""
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


def _contains_any(haystack: str, needles: list[str]) -> bool:
    """Retourne True si l'un des termes est présent dans la chaîne normalisée."""
    return any(n in haystack for n in needles)


def _intent_constraint_bonus(question: str, result: EmailGraphResult) -> float:
    """Applique des bonus/malus selon les contraintes explicites de la question."""
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
            # Souvent, le mail cible est une candidature/stage forwardée sans mention
            # explicite de "lettre de motivation" dans le snippet extrait.
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


def _result_blob(result: EmailGraphResult) -> str:
    """Concatène les champs textuels utiles pour des règles d'intention."""
    return " ".join([
        _normalize_text(result.subject),
        _normalize_text(result.body_snippet),
        " ".join(_normalize_text(t) for t in (result.topics or [])),
        " ".join(_normalize_text(a) for a in (result.attachments or [])),
        _normalize_text(result.sender_name),
    ])


def _matches_cover_letter_intent(result: EmailGraphResult) -> bool:
    blob = _result_blob(result)
    return _contains_any(blob, ["lettre de motivation", "motivation", "cover letter"])


def _intent_flags(question: str) -> dict[str, bool]:
    q = _normalize_text(question)
    return {
        "cover": _contains_any(q, ["lettre de motivation", "cover letter", "motivation letter"]),
        "stage": _contains_any(q, ["stage", "internship", "intern"]),
        "candidature": _contains_any(q, ["candidature", "application", "postule", "apply"]),
    }


def _lexical_intent_candidate_ids(
    driver,
    sender_hint: str,
    asks_cover: bool,
    asks_stage: bool,
    asks_candidature: bool,
    limit: int = 80,
) -> set[str]:
    """Retourne les IDs qui matchent explicitement les contraintes métier dans Neo4j."""
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


def _fetch_hits_by_ids(driver, ids: list[str]) -> list[dict]:
    """Récupère les champs de base pour une liste d'IDs Email."""
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


def _blend_vectors(v1: list[float], v2: list[float]) -> list[float]:
    """Moyenne deux embeddings de même dimension."""
    if len(v1) != len(v2):
        return v1
    return [(a + b) / 2.0 for a, b in zip(v1, v2)]


# ═════════════════════════════════════════════════════════
#  Traversée du graphe (enrichissement Cypher)
# ═════════════════════════════════════════════════════════

def enrich_with_graph(driver, email_id: str) -> dict:
    """Traverse le graphe autour d'un nœud Email pour récupérer le contexte complet."""
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


def search_and_enrich(
    driver,
    embedder: EmbeddingService,
    question: str,
    top_k: int = TOP_K,
) -> list[EmailGraphResult]:
    """Compatibilité: retourne uniquement la liste des résultats."""
    results, _meta = search_and_enrich_with_meta(driver, embedder, question, top_k=top_k)
    return results


def search_and_enrich_with_meta(
    driver,
    embedder: EmbeddingService,
    question: str,
    top_k: int = TOP_K,
) -> tuple[list[EmailGraphResult], dict]:
    """Pipeline complet : query rewrite → retrieval vectoriel → reranking hybride."""
    log.info("Vectorisation de la question …")
    original_question = (question or "").strip()
    retrieval_question = rewrite_question_for_retrieval(original_question)

    base_embedding = embedder.encode_query(original_question)
    if retrieval_question and retrieval_question != original_question:
        rewritten_embedding = embedder.encode_query(retrieval_question)
        question_embedding = _blend_vectors(base_embedding, rewritten_embedding)
    else:
        question_embedding = base_embedding

    # On récupère un pool de candidats large pour éviter de manquer les bons mails.
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

    # Complète le pool vectoriel avec des candidats strictement alignés sur l'intention,
    # même s'ils n'étaient pas présents dans le top vectoriel initial.
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

        # Score hybride = score vectoriel + bonus lexical/métadonnées.
        row.score = float(row.score) + _hybrid_bonus(q_tokens, row)
        row.score += _intent_constraint_bonus(original_question + " " + retrieval_question, row)
        if strict_ids and row.email_id in strict_ids:
            row.score += 1.75
        results.append(row)

    # Si un expéditeur explicite est demandé et qu'on a des candidats qui matchent,
    # on favorise fortement ces candidats et on pénalise les autres.
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
            # Fallback: on tente aussi un match dans le sujet/corps/PJ quand le sender
            # est absent ou mal extrait depuis certains emails forwardés.
            for r in results:
                blob = " ".join([
                    _normalize_text(r.subject),
                    _normalize_text(r.body_snippet),
                    " ".join(_normalize_text(a) for a in (r.attachments or [])),
                ])
                if sender_hint in blob:
                    r.score += 0.65

    # Si la question demande explicitement une lettre de motivation, on privilégie
    # fortement les candidats qui matchent cette contrainte.
    if flags["cover"]:
        has_cover_match = any(_matches_cover_letter_intent(r) for r in results)
        if has_cover_match:
            for r in results:
                if _matches_cover_letter_intent(r):
                    r.score += 0.80
                else:
                    r.score -= 0.90

    # Tri final par score hybride décroissant.
    results.sort(key=lambda r: r.score, reverse=True)

    # Déduplication douce pour éviter des doublons quasi-identiques dans le top-k.
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


# ═════════════════════════════════════════════════════════
#  Génération de la réponse (LangChain + Gemini)
# ═════════════════════════════════════════════════════════

def _format_context(results: list[EmailGraphResult]) -> str:
    """Formate les résultats en contexte compact pour le LLM (économie de tokens)."""
    parts: list[str] = []
    for i, r in enumerate(results, 1):
        lines = [f"[{i}] {r.subject} | {r.date} | De: {r.sender_name}"]
        if r.recipients:
            lines.append(f"  À: {', '.join(r.recipients)}")
        if r.topics:
            lines.append(f"  Tags: {', '.join(r.topics)}")
        if r.attachments:
            lines.append(f"  PJ: {', '.join(r.attachments)}")
        # Tronquer le body à 300 chars pour limiter les tokens
        snippet = r.body_snippet[:300].strip()
        if snippet:
            lines.append(f"  > {snippet}")
        parts.append("\n".join(lines))
    return "\n\n".join(parts)


def generate_answer(question: str, results: list[EmailGraphResult]) -> str:
    """Génère la réponse finale via Gemini (modèle configurable + fallback)."""
    if not is_llm_configured():
        log.warning("GEMINI_API_KEY non définie — réponse brute sans LLM.")
        return _format_context(results)

    try:
        from langchain_google_genai import ChatGoogleGenerativeAI
    except ImportError:
        log.error("langchain-google-genai non installé. pip install langchain-google-genai")
        return _format_context(results)

    context = _format_context(results)
    # Prompt compact pour minimiser la consommation de tokens
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


# ═════════════════════════════════════════════════════════
#  Affichage
# ═════════════════════════════════════════════════════════

def print_results(results: list[EmailGraphResult]) -> None:
    """Affiche les résultats de recherche de façon lisible."""
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


# ═════════════════════════════════════════════════════════
#  CLI
# ═════════════════════════════════════════════════════════

def run_query(driver, embedder: EmbeddingService, question: str, top_k: int = TOP_K) -> None:
    """Exécute une requête complète et affiche les résultats + réponse LLM."""
    results = search_and_enrich(driver, embedder, question, top_k=top_k)
    print_results(results)

    if results:
        print(f"{'─' * 60}")
        print("  🤖 Génération de la réponse …\n")
        answer = generate_answer(question, results)
        print(answer)
        print(f"\n{'═' * 60}\n")


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
