"""Neo4j Ingestion — importe les emails dans un graphe Neo4j.

Deux modes d'ingestion :
  - eml   : parse les fichiers .eml bruts depuis MAILS_DIR
  - vault : parse les fichiers Markdown existants depuis GRAPH_MD_DIR

Usage :
  python neo4j_ingest.py --mode eml
  python neo4j_ingest.py --mode vault
  python neo4j_ingest.py --mode both
  python neo4j_ingest.py --init-only   (crée uniquement le schéma)

Dépendances internes :
    - app_config : chemins (MAILS_DIR, GRAPH_MD_DIR, GRAPH_ATT_DIR)

Dépendances externes :
    - neo4j, sentence-transformers, python-dotenv
"""

from __future__ import annotations

import argparse
import email as email_lib
import email.message
import logging
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime
from email import policy as email_policy
from email.utils import getaddresses, parsedate_to_datetime
from typing import Optional

from dotenv import load_dotenv
from neo4j import GraphDatabase
from neo4j.exceptions import ServiceUnavailable, AuthError

# ── Projet ────────────────────────────────────────────
from app_config import APP_DATA_DIR, GRAPH_ATT_DIR, GRAPH_MD_DIR, MAILS_DIR
from mail_utils import clean_string_for_file

try:
    import html2text
    _H2T = html2text.HTML2Text()
    _H2T.ignore_links = False
    _H2T.body_width = 0
except ImportError:
    _H2T = None

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


def _load_runtime_env() -> list[str]:
    """Charge les variables d'env depuis plusieurs emplacements possibles.

    En version installée, le backend n'est pas forcément lancé depuis la racine
    du repo, donc le .env local peut être introuvable.
    """
    loaded: list[str] = []
    env_override = (os.getenv("ISENAPP_ENV_FILE") or "").strip()
    candidates = [
        env_override,
        os.path.join(_PROJECT_ROOT, ".env"),
        os.path.join(os.getcwd(), ".env"),
        os.path.join(APP_DATA_DIR, ".env"),
        str(_Path.home() / ".config" / "isenapp" / ".env"),
    ]

    seen: set[str] = set()
    for candidate in candidates:
        if not candidate:
            continue
        path = os.path.abspath(candidate)
        if path in seen:
            continue
        seen.add(path)
        if os.path.isfile(path):
            # override=False pour conserver une valeur déjà fournie par l'OS.
            if load_dotenv(path, override=False):
                loaded.append(path)
    return loaded


_ENV_FILES = _load_runtime_env()
if _ENV_FILES:
    log.info("Fichiers .env chargés: %s", ", ".join(_ENV_FILES))
else:
    log.warning("Aucun fichier .env trouvé (chemins testés: repo/cwd/app-data).")

NEO4J_URI = os.getenv("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "intfloat/multilingual-e5-base")

# Valeur de repli. La dimension réelle est lue depuis le modèle chargé.
EMBEDDING_DIM = int(os.getenv("EMBEDDING_DIM", "1024"))

MOTS_CLES: list[str] = [
    "projet", "stage", "facture", "urgent", "réunion",
    "candidature", "rapport", "admin", "examen",
]

MOIS_FR: list[str] = [
    "janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre",
]

# ═════════════════════════════════════════════════════════
#  Data model
# ═════════════════════════════════════════════════════════

@dataclass
class PersonData:
    """Représente une personne (expéditeur / destinataire)."""
    name: str
    email: str = ""

    @property
    def merge_key(self) -> str:
        """Clé utilisée pour le MERGE Neo4j (email si dispo, sinon nom)."""
        return self.email if self.email else self.name


@dataclass
class EmailData:
    """Données structurées extraites d'un email, prêtes pour l'ingestion."""
    message_id: str
    subject: str
    date_str: str
    date_iso: str  # YYYY-MM-DD
    body: str
    sender: PersonData
    recipients: list[PersonData] = field(default_factory=list)
    cc: list[PersonData] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    attachments: list[str] = field(default_factory=list)
    source_file: str = ""


# ═════════════════════════════════════════════════════════
#  Embedding service (chargement lazy)
# ═════════════════════════════════════════════════════════

class EmbeddingService:
    """Wrapper lazy autour de sentence-transformers."""

    def __init__(self, model_name: str = EMBEDDING_MODEL) -> None:
        self._model_name = model_name
        self._model = None
        self._dimension = EMBEDDING_DIM

    def _load(self) -> None:
        if self._model is not None:
            return
        log.info("Chargement du modèle d'embedding '%s' …", self._model_name)
        from sentence_transformers import SentenceTransformer
        self._model = SentenceTransformer(self._model_name)
        try:
            if hasattr(self._model, "get_embedding_dimension"):
                dim = int(self._model.get_embedding_dimension())
            else:
                dim = int(self._model.get_sentence_embedding_dimension())
            if dim > 0:
                self._dimension = dim
        except Exception:
            pass
        log.info("Modèle chargé.")

    @property
    def dimension(self) -> int:
        """Dimension d'embedding effectivement utilisée."""
        self._load()
        return self._dimension

    def encode(self, text: str) -> list[float]:
        """Encode un texte en vecteur normalisé."""
        self._load()
        vec = self._model.encode(text, normalize_embeddings=True)  # type: ignore[union-attr]
        return vec.tolist()

    def encode_query(self, text: str) -> list[float]:
        """Encode une requête utilisateur (format query pour modèles E5)."""
        q = (text or "").strip()
        if "e5" in self._model_name.lower() and not q.lower().startswith("query:"):
            q = f"query: {q}"
        return self.encode(q)

    def encode_document(self, text: str) -> list[float]:
        """Encode un document (format passage pour modèles E5)."""
        d = (text or "")
        if "e5" in self._model_name.lower() and not d.lower().startswith("passage:"):
            d = f"passage: {d}"
        return self.encode(d)


# ═════════════════════════════════════════════════════════
#  Neo4j helpers
# ═════════════════════════════════════════════════════════

def connect_neo4j() -> GraphDatabase.driver:
    """Crée et vérifie la connexion au driver Neo4j.

    Raises ConnectionError when Neo4j is unreachable (safe for library use).
    """
    if not NEO4J_PASSWORD:
        raise ConnectionError(
            "NEO4J_PASSWORD non défini. Ajoute-le dans l'environnement "
            "ou dans un fichier .env (racine projet, dossier courant, "
            f"ou {os.path.join(APP_DATA_DIR, '.env')})."
        )
    try:
        driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
        driver.verify_connectivity()
        log.info("Connecté à Neo4j (%s)", NEO4J_URI)
        return driver
    except ServiceUnavailable:
        raise ConnectionError(f"Impossible de joindre Neo4j sur {NEO4J_URI}. Le serveur est-il démarré ?")
    except AuthError:
        raise ConnectionError(f"Authentification Neo4j échouée (user={NEO4J_USER}). Vérifie tes identifiants.")


def init_schema(driver: GraphDatabase.driver, embedding_dim: int = EMBEDDING_DIM) -> None:
    """Crée les contraintes d'unicité et l'index vectoriel (dimension-aware)."""
    constraints = [
        "CREATE CONSTRAINT email_id IF NOT EXISTS FOR (e:Email) REQUIRE e.id IS UNIQUE",
        "CREATE CONSTRAINT person_email IF NOT EXISTS FOR (p:Person) REQUIRE p.email IS UNIQUE",
        "CREATE CONSTRAINT topic_name IF NOT EXISTS FOR (t:Topic) REQUIRE t.name IS UNIQUE",
        "CREATE CONSTRAINT document_filename IF NOT EXISTS FOR (d:Document) REQUIRE d.filename IS UNIQUE",
    ]
    vector_index = (
        "CREATE VECTOR INDEX email_embedding IF NOT EXISTS "
        "FOR (e:Email) ON (e.embedding) "
        "OPTIONS {indexConfig: {"
        f"  `vector.dimensions`: {embedding_dim},"
        "  `vector.similarity_function`: 'cosine'"
        "}}"
    )

    with driver.session() as session:
        for cypher in constraints:
            session.run(cypher)
            log.info("  ✓ %s", cypher.split("REQUIRE")[0].strip())

        existing_dim = None
        idx = session.run(
            """
            SHOW INDEXES YIELD name, type, options
            WHERE name = 'email_embedding' AND type = 'VECTOR'
            RETURN options
            """
        ).single()
        if idx and idx.get("options"):
            cfg = idx.get("options", {}).get("indexConfig", {})
            existing_dim = cfg.get("vector.dimensions") or cfg.get("`vector.dimensions`")
            try:
                existing_dim = int(existing_dim)
            except Exception:
                existing_dim = None

        if existing_dim and existing_dim != embedding_dim:
            log.warning(
                "Index email_embedding en %sD incompatible avec le modèle actuel (%sD): recréation.",
                existing_dim,
                embedding_dim,
            )
            session.run("DROP INDEX email_embedding IF EXISTS")

        session.run(vector_index)
        log.info("  ✓ Index vectoriel email_embedding (%dD, cosine)", embedding_dim)

    log.info("Schéma Neo4j initialisé.")


# ═════════════════════════════════════════════════════════
#  Parsing — mode .eml
# ═════════════════════════════════════════════════════════

def _clean_subject(subject: str) -> str:
    """Déplace les préfixes RE/FW à la fin du sujet."""
    clean = subject
    prefixes: list[str] = []
    pattern = r'^(\s*(re|fw|fwd)\s*[:：\-]+)'
    while True:
        m = re.match(pattern, clean, re.IGNORECASE)
        if m:
            prefixes.append(m.group(1).strip())
            clean = clean[m.end():].lstrip()
        else:
            break
    return f"{clean} ({' '.join(prefixes)})" if prefixes else clean


def _extract_addresses(header_value: str) -> list[PersonData]:
    """Parse un header d'adresse email en liste de PersonData."""
    if not header_value:
        return []
    result: list[PersonData] = []
    for name, addr in getaddresses([header_value]):
        clean_name = clean_string_for_file(name) if name else ""
        clean_addr = addr.strip().lower() if addr else ""
        display = clean_name or clean_addr or "Inconnu"
        result.append(PersonData(name=display, email=clean_addr))
    return result


def _extract_tags(subject: str, body: str, sender_domain: str, dt: Optional[datetime]) -> list[str]:
    """Génère les tags à partir du sujet, corps, domaine et date."""
    tags = ["email"]
    if sender_domain:
        tags.append(f"domaine/{sender_domain.replace('.', '_')}")
    if dt:
        mois = MOIS_FR[dt.month - 1]
        tags.append(f"periode/{mois}-{dt.year}")
    combined = (subject + " " + body[:500]).lower()
    for kw in MOTS_CLES:
        if kw in combined:
            tags.append(f"sujet/{kw}")
    return tags


def _extract_body_and_attachments(msg: email.message.Message) -> tuple[str, list[str]]:
    """Extrait le corps texte et les noms de pièces jointes d'un email parsé."""
    body = ""
    attachments: list[str] = []

    for part in msg.walk():
        content_type = part.get_content_type()
        disposition = str(part.get("Content-Disposition", ""))

        # Pièce jointe
        if "attachment" in disposition or part.get_filename():
            filename = part.get_filename()
            if filename and not content_type.startswith("image/"):
                attachments.append(clean_string_for_file(filename))
            continue

        # Corps texte
        if content_type == "text/plain" and not body:
            try:
                charset = part.get_content_charset("utf-8") or "utf-8"
                body = part.get_payload(decode=True).decode(charset, errors="replace")
            except Exception:
                pass
        elif content_type == "text/html" and _H2T:
            try:
                charset = part.get_content_charset("utf-8") or "utf-8"
                html = part.get_payload(decode=True).decode(charset, errors="replace")
                body = _H2T.handle(html)
            except Exception:
                pass

    return body, attachments


def parse_eml(eml_path: str) -> Optional[EmailData]:
    """Parse un fichier .eml et retourne un EmailData."""
    try:
        with open(eml_path, "rb") as f:
            msg = email_lib.message_from_bytes(f.read(), policy=email_policy.default)
    except Exception as exc:
        log.warning("Impossible de lire %s : %s", eml_path, exc)
        return None

    subject_raw = msg.get("Subject", "Sans_Sujet") or "Sans_Sujet"
    subject = _clean_subject(subject_raw)
    message_id = msg.get("Message-ID", "") or ""
    date_hdr = msg.get("Date", "")

    # Parse date
    dt: Optional[datetime] = None
    date_iso = ""
    try:
        dt = parsedate_to_datetime(date_hdr)
        date_iso = dt.strftime("%Y-%m-%d")
    except Exception:
        pass

    # Adresses
    sender_list = _extract_addresses(msg.get("From", ""))
    sender = sender_list[0] if sender_list else PersonData(name="Inconnu")
    recipients = _extract_addresses(msg.get("To", ""))
    cc = _extract_addresses(msg.get("Cc", ""))

    # Domaine expéditeur
    sender_domain = ""
    if sender.email and "@" in sender.email:
        sender_domain = sender.email.split("@")[-1]

    body, attachments = _extract_body_and_attachments(msg)
    tags = _extract_tags(subject_raw, body, sender_domain, dt)

    # ID unique : Message-ID ou hash du fichier
    unique_id = message_id.strip("<>") if message_id else os.path.basename(eml_path)

    return EmailData(
        message_id=unique_id,
        subject=subject,
        date_str=date_hdr,
        date_iso=date_iso,
        body=body,
        sender=sender,
        recipients=recipients,
        cc=cc,
        tags=tags,
        attachments=attachments,
        source_file=os.path.basename(eml_path),
    )


# ═════════════════════════════════════════════════════════
#  Parsing — mode vault Markdown
# ═════════════════════════════════════════════════════════

# Regex pour extraire les métadonnées du Markdown
_RE_HEADING = re.compile(r"^#\s+(.+)$", re.MULTILINE)
_RE_DATE = re.compile(r"\*\*🗓️\s*Date\s*:\*\*\s*(\d{4}-\d{2}-\d{2})\s*(?:\(([^)]+)\))?")
_RE_FROM = re.compile(r"\*\*👤\s*De\s*:\*\*\s*\[\[([^\]]+)\]\]")
_RE_TO = re.compile(r"\*\*👥\s*À\s*:\*\*\s*(.+)")
_RE_CC = re.compile(r"\*\*👀\s*Cc\s*:\*\*\s*(.+)")
_RE_WIKILINK = re.compile(r"\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]")
_RE_ATTACHMENT_SECTION = re.compile(r"###\s*📎\s*Pièces Jointes\s*\n((?:\s*-\s*\[\[[^\]]+\]\]\s*\n?)+)", re.MULTILINE)


def _parse_frontmatter_tags(content: str) -> list[str]:
    """Extrait les tags du frontmatter YAML."""
    if not content.startswith("---"):
        return []
    end = content.find("---", 3)
    if end == -1:
        return []
    fm = content[3:end]
    tags: list[str] = []
    for line in fm.split("\n"):
        line = line.strip()
        if line.startswith("- "):
            tags.append(line[2:].strip())
    return tags


def _parse_frontmatter_field(content: str, field: str) -> str:
    """Extrait un champ scalaire du frontmatter YAML (ex: eml_file)."""
    if not content.startswith("---"):
        return ""
    end = content.find("---", 3)
    if end == -1:
        return ""
    fm = content[3:end]
    for line in fm.split("\n"):
        line = line.strip()
        if line.startswith(f"{field}:"):
            return line[len(field) + 1:].strip()
    return ""


def parse_vault_md(md_path: str) -> Optional[EmailData]:
    """Parse un fichier Markdown du vault et retourne un EmailData."""
    try:
        with open(md_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except Exception as exc:
        log.warning("Impossible de lire %s : %s", md_path, exc)
        return None

    tags = _parse_frontmatter_tags(content)

    # Vérifier que c'est bien un email
    if "email" not in tags:
        return None

    # Référence au fichier .eml source (si présent dans le frontmatter)
    eml_file = _parse_frontmatter_field(content, "eml_file")

    # Sujet
    m_heading = _RE_HEADING.search(content)
    subject = m_heading.group(1).strip() if m_heading else os.path.splitext(os.path.basename(md_path))[0]

    # Date
    m_date = _RE_DATE.search(content)
    date_iso = m_date.group(1) if m_date else ""
    date_str = m_date.group(2) if m_date and m_date.group(2) else date_iso

    # Expéditeur
    m_from = _RE_FROM.search(content)
    sender_name = m_from.group(1).strip() if m_from else "Inconnu"
    sender = PersonData(name=sender_name)

    # Destinataires
    recipients: list[PersonData] = []
    m_to = _RE_TO.search(content)
    if m_to:
        for link in _RE_WIKILINK.findall(m_to.group(1)):
            recipients.append(PersonData(name=link.strip()))

    # Cc
    cc: list[PersonData] = []
    m_cc = _RE_CC.search(content)
    if m_cc:
        for link in _RE_WIKILINK.findall(m_cc.group(1)):
            cc.append(PersonData(name=link.strip()))

    # Pièces jointes (section dédiée)
    attachments: list[str] = []
    m_att = _RE_ATTACHMENT_SECTION.search(content)
    if m_att:
        for att_link in _RE_WIKILINK.findall(m_att.group(1)):
            attachments.append(att_link.strip())

    # Corps : tout entre le séparateur `---` (après métadonnées) et la section PJ
    body = ""
    parts = content.split("\n---\n")
    if len(parts) >= 3:
        # parts[0] = frontmatter, parts[1] = header+meta, parts[2+] = body(+PJ)
        body_parts = parts[2:]
        body = "\n---\n".join(body_parts)
        # Retirer la section pièces jointes du body
        att_section = _RE_ATTACHMENT_SECTION.search(body)
        if att_section:
            body = body[:att_section.start()].rstrip()
    body = body.strip()

    # ID unique basé sur le nom de fichier
    unique_id = f"vault:{os.path.basename(md_path)}"

    return EmailData(
        message_id=unique_id,
        subject=subject,
        date_str=date_str,
        date_iso=date_iso,
        body=body,
        sender=sender,
        recipients=recipients,
        cc=cc,
        tags=tags,
        attachments=attachments,
        source_file=eml_file if eml_file else os.path.basename(md_path),
    )


# ═════════════════════════════════════════════════════════
#  Ingestion Neo4j
# ═════════════════════════════════════════════════════════

def _ingest_email_tx(tx, data: EmailData, embedding: list[float]) -> None:
    """Transaction Cypher : crée les nœuds et relations pour un email."""

    # 1. Nœud Email
    tx.run(
        """
        MERGE (e:Email {id: $id})
        SET e.subject   = $subject,
            e.date      = $date,
            e.date_iso  = $date_iso,
            e.body      = $body,
            e.source    = $source,
            e.embedding = $embedding
        """,
        id=data.message_id,
        subject=data.subject,
        date=data.date_str,
        date_iso=data.date_iso,
        body=data.body,
        source=data.source_file,
        embedding=embedding,
    )

    # 2. Expéditeur → SENT → Email
    if data.sender.email:
        tx.run(
            """
            MERGE (p:Person {email: $email})
            SET p.name = coalesce($name, p.name)
            WITH p
            MATCH (e:Email {id: $eid})
            MERGE (p)-[:SENT]->(e)
            """,
            email=data.sender.email,
            name=data.sender.name,
            eid=data.message_id,
        )
    else:
        tx.run(
            """
            MERGE (p:Person {name: $name})
            WITH p
            MATCH (e:Email {id: $eid})
            MERGE (p)-[:SENT]->(e)
            """,
            name=data.sender.name,
            eid=data.message_id,
        )

    # 3. Email → RECEIVED_BY → destinataires (To + Cc)
    all_recipients = data.recipients + data.cc
    for person in all_recipients:
        if person.email:
            tx.run(
                """
                MERGE (p:Person {email: $email})
                SET p.name = coalesce($name, p.name)
                WITH p
                MATCH (e:Email {id: $eid})
                MERGE (e)-[:RECEIVED_BY]->(p)
                """,
                email=person.email,
                name=person.name,
                eid=data.message_id,
            )
        else:
            tx.run(
                """
                MERGE (p:Person {name: $name})
                WITH p
                MATCH (e:Email {id: $eid})
                MERGE (e)-[:RECEIVED_BY]->(p)
                """,
                name=person.name,
                eid=data.message_id,
            )

    # 4. Email → ABOUT → Topics (tags sujet/*)
    for tag in data.tags:
        if tag.startswith("sujet/"):
            topic_name = tag.split("/", 1)[1]
            tx.run(
                """
                MERGE (t:Topic {name: $name})
                WITH t
                MATCH (e:Email {id: $eid})
                MERGE (e)-[:ABOUT]->(t)
                """,
                name=topic_name,
                eid=data.message_id,
            )

    # 5. Email → HAS_ATTACHMENT → Documents
    for filename in data.attachments:
        tx.run(
            """
            MERGE (d:Document {filename: $filename})
            WITH d
            MATCH (e:Email {id: $eid})
            MERGE (e)-[:HAS_ATTACHMENT]->(d)
            """,
            filename=filename,
            eid=data.message_id,
        )


def ingest_email(driver, embedder: EmbeddingService, data: EmailData) -> None:
    """Ingère un EmailData complet dans Neo4j."""
    # Texte à vectoriser : sujet + corps (tronqué à 512 tokens environ)
    text_for_embedding = f"{data.subject}\n\n{data.body[:2000]}"
    embedding = embedder.encode_document(text_for_embedding)

    with driver.session() as session:
        session.execute_write(_ingest_email_tx, data, embedding)


def ingest_single_eml(driver, embedder: EmbeddingService, eml_path: str) -> bool:
    """Ingère un seul fichier .eml dans Neo4j. Retourne True si succès."""
    data = parse_eml(eml_path)
    if data is None:
        return False
    ingest_email(driver, embedder, data)
    return True


def count_eml_files(directory: str) -> int:
    """Compte les fichiers .eml dans un dossier récursivement."""
    total = 0
    for root, _dirs, files in os.walk(directory):
        total += sum(1 for fname in files if fname.lower().endswith(".eml"))
    return total


def count_vault_files(directory: str) -> int:
    """Compte les fichiers .md d'un dossier vault (non récursif)."""
    try:
        return sum(1 for fname in os.listdir(directory) if fname.lower().endswith(".md"))
    except Exception:
        return 0


# ═════════════════════════════════════════════════════════
#  Orchestration
# ═════════════════════════════════════════════════════════

def ingest_eml_directory(driver, embedder: EmbeddingService, directory: str, progress_cb=None) -> int:
    """Parcourt un répertoire de fichiers .eml et les ingère. Retourne le nombre traité."""
    count = 0
    total = count_eml_files(directory)
    processed = 0
    for root, _dirs, files in os.walk(directory):
        for fname in sorted(files):
            if not fname.lower().endswith(".eml"):
                continue
            processed += 1
            eml_path = os.path.join(root, fname)
            data = parse_eml(eml_path)
            if data is None:
                if progress_cb:
                    progress_cb(count, processed, total, fname, "eml")
                continue
            try:
                ingest_email(driver, embedder, data)
                count += 1
                if count % 50 == 0:
                    log.info("  … %d emails ingérés", count)
            except Exception as exc:
                log.error("Erreur ingestion %s : %s", fname, exc)
            if progress_cb:
                progress_cb(count, processed, total, fname, "eml")
    return count


def ingest_vault_directory(driver, embedder: EmbeddingService, directory: str, progress_cb=None) -> int:
    """Parcourt un répertoire de fichiers .md du vault et les ingère. Retourne le nombre traité."""
    count = 0
    total = count_vault_files(directory)
    processed = 0
    for fname in sorted(os.listdir(directory)):
        if not fname.lower().endswith(".md"):
            continue
        processed += 1
        md_path = os.path.join(directory, fname)
        data = parse_vault_md(md_path)
        if data is None:
            if progress_cb:
                progress_cb(count, processed, total, fname, "vault")
            continue
        try:
            ingest_email(driver, embedder, data)
            count += 1
            if count % 50 == 0:
                log.info("  … %d emails (vault) ingérés", count)
        except Exception as exc:
            log.error("Erreur ingestion vault %s : %s", fname, exc)
        if progress_cb:
            progress_cb(count, processed, total, fname, "vault")
    return count


# ═════════════════════════════════════════════════════════
#  CLI
# ═════════════════════════════════════════════════════════

def main() -> None:
    parser = argparse.ArgumentParser(description="Ingestion d'emails dans Neo4j")
    parser.add_argument(
        "--mode",
        choices=["eml", "vault", "both"],
        default="both",
        help="Source des données (défaut: both)",
    )
    parser.add_argument(
        "--init-only",
        action="store_true",
        help="Crée uniquement le schéma (contraintes + index) sans ingérer",
    )
    parser.add_argument(
        "--eml-dir",
        default=MAILS_DIR,
        help=f"Répertoire des .eml (défaut: {MAILS_DIR})",
    )
    parser.add_argument(
        "--vault-dir",
        default=GRAPH_MD_DIR,
        help=f"Répertoire du vault Markdown (défaut: {GRAPH_MD_DIR})",
    )
    args = parser.parse_args()

    log.info("═══ Neo4j Email Ingest ═══")
    try:
        driver = connect_neo4j()
    except ConnectionError as exc:
        log.error("%s", exc)
        sys.exit(1)

    try:
        log.info("Initialisation du schéma …")
        preview_embedder = EmbeddingService()
        init_schema(driver, embedding_dim=preview_embedder.dimension)

        if args.init_only:
            log.info("--init-only : schéma créé, fin.")
            return

        embedder = EmbeddingService()
        total = 0

        if args.mode in ("eml", "both"):
            log.info("─── Mode EML : %s ───", args.eml_dir)
            n = ingest_eml_directory(driver, embedder, args.eml_dir)
            log.info("✓ %d emails ingérés depuis .eml", n)
            total += n

        if args.mode in ("vault", "both"):
            log.info("─── Mode Vault : %s ───", args.vault_dir)
            n = ingest_vault_directory(driver, embedder, args.vault_dir)
            log.info("✓ %d emails ingérés depuis le vault", n)
            total += n

        log.info("═══ Terminé — %d emails au total ═══", total)

    finally:
        driver.close()


if __name__ == "__main__":
    main()
