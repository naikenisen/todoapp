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

from app_config import APP_DATA_DIR, GRAPH_ATT_DIR, GRAPH_MD_DIR, MAILS_DIR
from mail_utils import clean_string_for_file

# Convertisseur HTML vers texte brut, chargé si disponible
try:
    import html2text
    _H2T = html2text.HTML2Text()
    _H2T.ignore_links = False
    _H2T.body_width = 0
except ImportError:
    _H2T = None

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
def _load_runtime_env() -> list[str]:
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
            if load_dotenv(path, override=False):
                loaded.append(path)
    return loaded


# Liste des fichiers .env effectivement chargés au démarrage
_ENV_FILES = _load_runtime_env()
if _ENV_FILES:
    log.info("Fichiers .env chargés: %s", ", ".join(_ENV_FILES))
else:
    log.warning("Aucun fichier .env trouvé (chemins testés: repo/cwd/app-data).")

# URI de connexion au serveur Neo4j
NEO4J_URI = os.getenv("NEO4J_URI", "bolt://localhost:7687")
# Nom d'utilisateur Neo4j
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
# Mot de passe Neo4j
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "")
# Nom du modèle d'embedding utilisé pour la vectorisation
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "intfloat/multilingual-e5-base")

# Dimension par défaut des vecteurs d'embedding
EMBEDDING_DIM = int(os.getenv("EMBEDDING_DIM", "1024"))

# Mots-clés métier pour le tagging automatique des emails
MOTS_CLES: list[str] = [
    "projet", "stage", "facture", "urgent", "réunion",
    "candidature", "rapport", "admin", "examen",
]

# Noms des mois en français pour les tags de période
MOIS_FR: list[str] = [
    "janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre",
]


# Représente une personne (expéditeur ou destinataire) avec nom et email
@dataclass
class PersonData:
    name: str
    email: str = ""

    # Clé de fusion Neo4j basée sur l'email si disponible, sinon le nom
    @property
    def merge_key(self) -> str:
        return self.email if self.email else self.name


# Données structurées d'un email prêtes pour l'ingestion Neo4j
@dataclass
class EmailData:
    message_id: str
    subject: str
    date_str: str
    date_iso: str
    body: str
    sender: PersonData
    recipients: list[PersonData] = field(default_factory=list)
    cc: list[PersonData] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    attachments: list[str] = field(default_factory=list)
    source_file: str = ""


# Service d'encodage de texte en vecteurs via sentence-transformers avec chargement différé
class EmbeddingService:

    # Initialise le service avec le nom du modèle et la dimension par défaut
    def __init__(self, model_name: str = EMBEDDING_MODEL) -> None:
        self._model_name = model_name
        self._model = None
        self._dimension = EMBEDDING_DIM

    # Charge le modèle d'embedding en mémoire si ce n'est pas encore fait
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

    # Retourne la dimension effective des embeddings après chargement du modèle
    @property
    def dimension(self) -> int:
        self._load()
        return self._dimension

    # Encode un texte en vecteur normalisé
    def encode(self, text: str) -> list[float]:
        self._load()
        vec = self._model.encode(text, normalize_embeddings=True)
        return vec.tolist()

    # Encode une requête utilisateur avec le préfixe approprié pour les modèles E5
    def encode_query(self, text: str) -> list[float]:
        q = (text or "").strip()
        if "e5" in self._model_name.lower() and not q.lower().startswith("query:"):
            q = f"query: {q}"
        return self.encode(q)

    # Encode un document avec le préfixe passage pour les modèles E5
    def encode_document(self, text: str) -> list[float]:
        d = (text or "")
        if "e5" in self._model_name.lower() and not d.lower().startswith("passage:"):
            d = f"passage: {d}"
        return self.encode(d)


# Crée et vérifie la connexion au driver Neo4j, lève ConnectionError si inaccessible
def connect_neo4j() -> GraphDatabase.driver:
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


# Initialise les contraintes d'unicité et l'index vectoriel dans Neo4j
def init_schema(driver: GraphDatabase.driver, embedding_dim: int = EMBEDDING_DIM) -> None:
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


# Déplace les préfixes RE/FW à la fin du sujet de l'email
def _clean_subject(subject: str) -> str:
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


# Parse un header d'adresses email en liste de PersonData
def _extract_addresses(header_value: str) -> list[PersonData]:
    if not header_value:
        return []
    result: list[PersonData] = []
    for name, addr in getaddresses([header_value]):
        clean_name = clean_string_for_file(name) if name else ""
        clean_addr = addr.strip().lower() if addr else ""
        display = clean_name or clean_addr or "Inconnu"
        result.append(PersonData(name=display, email=clean_addr))
    return result


# Génère les tags à partir du sujet, du corps, du domaine expéditeur et de la date
def _extract_tags(subject: str, body: str, sender_domain: str, dt: Optional[datetime]) -> list[str]:
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


# Extrait le corps texte et les noms de pièces jointes d'un message parsé
def _extract_body_and_attachments(msg: email.message.Message) -> tuple[str, list[str]]:
    body = ""
    attachments: list[str] = []

    for part in msg.walk():
        content_type = part.get_content_type()
        disposition = str(part.get("Content-Disposition", ""))

        if "attachment" in disposition or part.get_filename():
            filename = part.get_filename()
            if filename and not content_type.startswith("image/"):
                attachments.append(clean_string_for_file(filename))
            continue

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


# Parse un fichier .eml et retourne un EmailData ou None en cas d'erreur
def parse_eml(eml_path: str) -> Optional[EmailData]:
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

    dt: Optional[datetime] = None
    date_iso = ""
    try:
        dt = parsedate_to_datetime(date_hdr)
        date_iso = dt.strftime("%Y-%m-%d")
    except Exception:
        pass

    sender_list = _extract_addresses(msg.get("From", ""))
    sender = sender_list[0] if sender_list else PersonData(name="Inconnu")
    recipients = _extract_addresses(msg.get("To", ""))
    cc = _extract_addresses(msg.get("Cc", ""))

    sender_domain = ""
    if sender.email and "@" in sender.email:
        sender_domain = sender.email.split("@")[-1]

    body, attachments = _extract_body_and_attachments(msg)
    tags = _extract_tags(subject_raw, body, sender_domain, dt)

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


# Regex d'extraction du titre principal depuis le Markdown
_RE_HEADING = re.compile(r"^#\s+(.+)$", re.MULTILINE)
# Regex d'extraction de la date depuis le Markdown
_RE_DATE = re.compile(r"\*\*🗓️\s*Date\s*:\*\*\s*(\d{4}-\d{2}-\d{2})\s*(?:\(([^)]+)\))?")
# Regex d'extraction de l'expéditeur depuis le Markdown
_RE_FROM = re.compile(r"\*\*👤\s*De\s*:\*\*\s*\[\[([^\]]+)\]\]")
# Regex d'extraction des destinataires depuis le Markdown
_RE_TO = re.compile(r"\*\*👥\s*À\s*:\*\*\s*(.+)")
# Regex d'extraction des destinataires en copie depuis le Markdown
_RE_CC = re.compile(r"\*\*👀\s*Cc\s*:\*\*\s*(.+)")
# Regex d'extraction des liens wiki de type [[nom]]
_RE_WIKILINK = re.compile(r"\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]")
# Regex d'extraction de la section pièces jointes depuis le Markdown
_RE_ATTACHMENT_SECTION = re.compile(r"###\s*📎\s*Pièces Jointes\s*\n((?:\s*-\s*\[\[[^\]]+\]\]\s*\n?)+)", re.MULTILINE)


# Extrait les tags du frontmatter YAML d'un fichier Markdown
def _parse_frontmatter_tags(content: str) -> list[str]:
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


# Extrait un champ scalaire du frontmatter YAML par son nom
def _parse_frontmatter_field(content: str, field: str) -> str:
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


# Parse un fichier Markdown du vault et retourne un EmailData ou None
def parse_vault_md(md_path: str) -> Optional[EmailData]:
    try:
        with open(md_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except Exception as exc:
        log.warning("Impossible de lire %s : %s", md_path, exc)
        return None

    tags = _parse_frontmatter_tags(content)

    if "email" not in tags:
        return None

    eml_file = _parse_frontmatter_field(content, "eml_file")

    m_heading = _RE_HEADING.search(content)
    subject = m_heading.group(1).strip() if m_heading else os.path.splitext(os.path.basename(md_path))[0]

    m_date = _RE_DATE.search(content)
    date_iso = m_date.group(1) if m_date else ""
    date_str = m_date.group(2) if m_date and m_date.group(2) else date_iso

    m_from = _RE_FROM.search(content)
    sender_name = m_from.group(1).strip() if m_from else "Inconnu"
    sender = PersonData(name=sender_name)

    recipients: list[PersonData] = []
    m_to = _RE_TO.search(content)
    if m_to:
        for link in _RE_WIKILINK.findall(m_to.group(1)):
            recipients.append(PersonData(name=link.strip()))

    cc: list[PersonData] = []
    m_cc = _RE_CC.search(content)
    if m_cc:
        for link in _RE_WIKILINK.findall(m_cc.group(1)):
            cc.append(PersonData(name=link.strip()))

    attachments: list[str] = []
    m_att = _RE_ATTACHMENT_SECTION.search(content)
    if m_att:
        for att_link in _RE_WIKILINK.findall(m_att.group(1)):
            attachments.append(att_link.strip())

    body = ""
    parts = content.split("\n---\n")
    if len(parts) >= 3:
        body_parts = parts[2:]
        body = "\n---\n".join(body_parts)
        att_section = _RE_ATTACHMENT_SECTION.search(body)
        if att_section:
            body = body[:att_section.start()].rstrip()
    body = body.strip()

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


# Transaction Cypher qui crée les nœuds et relations pour un email dans Neo4j
def _ingest_email_tx(tx, data: EmailData, embedding: list[float]) -> None:

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


# Ingère un EmailData complet dans Neo4j en calculant et stockant son embedding
def ingest_email(driver, embedder: EmbeddingService, data: EmailData) -> None:
    text_for_embedding = f"{data.subject}\n\n{data.body[:2000]}"
    embedding = embedder.encode_document(text_for_embedding)

    with driver.session() as session:
        session.execute_write(_ingest_email_tx, data, embedding)


# Parse et ingère un seul fichier .eml dans Neo4j, retourne True si succès
def ingest_single_eml(driver, embedder: EmbeddingService, eml_path: str) -> bool:
    data = parse_eml(eml_path)
    if data is None:
        return False
    ingest_email(driver, embedder, data)
    return True


# Compte récursivement les fichiers .eml dans un répertoire
def count_eml_files(directory: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(directory):
        total += sum(1 for fname in files if fname.lower().endswith(".eml"))
    return total


# Compte les fichiers .md dans un répertoire vault
def count_vault_files(directory: str) -> int:
    try:
        return sum(1 for fname in os.listdir(directory) if fname.lower().endswith(".md"))
    except Exception:
        return 0


# Parcourt un répertoire de fichiers .eml et les ingère, retourne le nombre traité
def ingest_eml_directory(driver, embedder: EmbeddingService, directory: str, progress_cb=None) -> int:
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


# Parcourt un répertoire de fichiers Markdown du vault et les ingère, retourne le nombre traité
def ingest_vault_directory(driver, embedder: EmbeddingService, directory: str, progress_cb=None) -> int:
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


# Point d'entrée CLI pour l'ingestion des emails depuis .eml ou vault Markdown
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
