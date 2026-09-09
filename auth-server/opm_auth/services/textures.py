"""Skins et capes : la couche d'apparence, adressée par le contenu.

Une texture est un PNG. On ne fait jamais confiance à son nom, ni à son
extension, ni à l'en-tête ``Content-Type`` annoncé par le client : **seul le
contenu décide**. Un fichier n'est accepté qu'après avoir franchi trois
barrières successives (:func:`_decode`) :

1. les huit octets magiques du format PNG ;
2. un décodage réel par Pillow, qui doit annoncer ``PNG`` et une taille figurant
   dans :data:`ALLOWED_SIZES` (64×64 ou 64×32 pour un skin) ;
3. un **ré-encodage** complet : le fichier écrit sur le disque est produit par
   Pillow à partir des seuls pixels. Tout ce que portait l'original — miniatures,
   commentaires ``tEXt``, données EXIF, octets ajoutés après la fin du flux —
   disparaît en chemin.

Le ``sha256`` est calculé sur ce PNG ré-encodé, et il sert de trois façons à la
fois : clé d'unicité en base (``texture.sha256``), nom du fichier sur le disque
(``OPM_TEXTURES_DIR/{sha[0:2]}/{sha}.png``) et URL publique immuable
(``/textures/{sha}.png``). Deux joueurs au même skin ne coûtent donc qu'un seul
fichier, et une URL de texture n'a jamais besoin d'être invalidée : un contenu
différent porte un nom différent.

Import automatique au rattachement (``docs/DATA.md`` §6)
========================================================

La réponse de ``https://api.minecraftservices.com/minecraft/profile`` contient
déjà l'URL du skin actif et son modèle de bras. :func:`import_from_mojang` la
télécharge dans la transaction du rattachement : **le joueur retrouve son
apparence sans rien faire**, et à partir de là c'est nous qui l'hébergeons.

Cet import n'est **jamais bloquant**. Microsoft injoignable, PNG douteux, disque
plein, base indisponible : on journalise, on retombe sur le skin par défaut, et
on retentera à la prochaine re-vérification. Refuser un rattachement pourtant
valide parce qu'une image de 8 Kio n'a pas pu être téléchargée serait une faute
de conception.

Écritures en base
=================

Aucune fonction de ce module ne valide la transaction : l'appelant reste maître
de son ``commit``. :func:`import_from_mojang` fait tout ce qui peut échouer —
réseau, décodage, écriture du fichier — **avant** de toucher à la session : quand
elle y touche enfin, il ne reste que deux insertions triviales. C'est cette
discipline, plutôt qu'un point de reprise SQL, qui garantit qu'un import raté ne
peut pas emporter le rattachement avec lui.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import os
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Final
from urllib.parse import urlsplit

import httpx
from PIL import Image, UnidentifiedImageError
from sqlalchemy import inspect as sa_inspect
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from opm_auth.config import get_settings
from opm_auth.models import (
    Texture,
    TextureKind,
    TextureModel,
    TextureSource,
    User,
    UserTexture,
    utcnow,
)
from opm_auth.schemas import TextureOut
from opm_auth.security import setting
from opm_auth.security.deps import ApiError

logger = logging.getLogger(__name__)

__all__ = [
    "ALLOWED_SIZES",
    "DOWNLOAD_TIMEOUT_SECONDS",
    "MOJANG_MAX_BYTES",
    "SHA256_RE",
    "StoredTexture",
    "TextureRejected",
    "blob_exists",
    "clear_texture",
    "current_textures",
    "download",
    "import_from_mojang",
    "is_sha256",
    "path_for",
    "relative_url",
    "set_transport",
    "store_upload",
    "texture_out",
    "texture_url",
    "validate",
]


# --------------------------------------------------------------------------- #
# Constantes de validation
# --------------------------------------------------------------------------- #

#: Les huit octets qui ouvrent tout fichier PNG (RFC 2083, §3.1).
PNG_MAGIC: Final = b"\x89PNG\r\n\x1a\n"

#: Empreinte hexadécimale minuscule : seule forme acceptée dans un chemin.
SHA256_RE: Final = re.compile(r"^[0-9a-f]{64}$")

#: Tailles admises, par type de texture.
#:
#: Un skin est en 64×64 (format moderne) ou 64×32 (format hérité, avant 1.8).
#: Une cape vaut 64×32 chez Mojang ; les capes haute définition en gardent le
#: rapport 2:1. Toute autre dimension est refusée : le client Minecraft
#: l'afficherait de travers, et une image de 8000×8000 n'a rien à faire ici.
ALLOWED_SIZES: Final[dict[str, frozenset[tuple[int, int]]]] = {
    TextureKind.SKIN.value: frozenset({(64, 64), (64, 32)}),
    TextureKind.CAPE.value: frozenset({(64, 32), (128, 64), (256, 128), (512, 256)}),
}

#: Plafond du téléchargement depuis Mojang (``docs/DATA.md`` §6).
MOJANG_MAX_BYTES: Final = 200 * 1024

#: Délai maximal du téléchargement d'une texture, en secondes (``docs/DATA.md`` §6).
DOWNLOAD_TIMEOUT_SECONDS: Final = 5.0

#: Hôtes autorisés à fournir une texture importée.
#:
#: L'URL vient d'une réponse Microsoft, donc d'un tiers : sans cette liste, un
#: profil malveillant ferait émettre à notre serveur une requête vers l'adresse
#: de son choix — y compris une adresse interne (SSRF). Une entrée commençant
#: par un point vaut pour tout le domaine. Surchargeable par
#: ``OPM_TEXTURE_IMPORT_HOSTS`` (liste séparée par des virgules).
DEFAULT_IMPORT_HOSTS: Final[tuple[str, ...]] = (
    "textures.minecraft.net",
    ".minecraft.net",
    ".mojang.com",
)

#: Identité annoncée lors du téléchargement d'une texture. Aucune donnée personnelle.
USER_AGENT: Final = "OPM-Auth/1.0 (+https://onepieceminecraft.fr)"


class TextureRejected(Exception):
    """Texture refusée : le contenu n'est pas un PNG exploitable.

    :ivar code: code machine stable, recopié tel quel dans le corps d'erreur
        normalisé (``docs/API.md`` §3) lorsqu'il s'agit d'un téléversement.
    :ivar message: phrase française affichable telle quelle par le launcher.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


@dataclass(frozen=True, slots=True)
class StoredTexture:
    """Résultat d'une validation : le PNG propre, son empreinte et sa taille."""

    data: bytes
    sha256: str
    width: int
    height: int

    @property
    def size(self) -> int:
        """Taille du fichier ré-encodé, en octets."""
        return len(self.data)


# --------------------------------------------------------------------------- #
# Adressage : empreinte, chemin, URL
# --------------------------------------------------------------------------- #


def is_sha256(value: str) -> bool:
    """L'empreinte est-elle une chaîne hexadécimale minuscule de 64 caractères ?"""
    return bool(SHA256_RE.match(value))


def _normalize_sha(value: str) -> str:
    """Normalise et **valide** une empreinte avant tout usage.

    C'est le seul endroit du module où une empreinte devient utilisable. La
    validation par expression régulière a lieu *avant* toute construction de
    chemin : ``..``, ``/``, ``\\`` et les octets nuls ne franchissent pas cette
    ligne, et aucune traversée de répertoire n'est donc possible.

    :raises TextureRejected: si l'empreinte n'est pas un SHA-256 hexadécimal.
    """
    cleaned = value.strip().lower()
    if not is_sha256(cleaned):
        raise TextureRejected(
            "invalid_texture_id",
            "Cette référence de texture n'est pas une empreinte SHA-256 valide.",
        )
    return cleaned


def path_for(sha256: str) -> Path:
    """Chemin du blob sur le disque : ``OPM_TEXTURES_DIR/{sha[0:2]}/{sha}.png``.

    Le préfixe à deux caractères évite d'entasser des dizaines de milliers de
    fichiers dans un seul répertoire, ce que la plupart des systèmes de fichiers
    supportent mal.

    :raises TextureRejected: empreinte invalide (voir :func:`_normalize_sha`).
    """
    digest = _normalize_sha(sha256)
    return get_settings().textures_path / digest[:2] / f"{digest}.png"


def texture_url(sha256: str) -> str:
    """URL publique absolue d'une texture, telle que la lit le client Minecraft.

    :raises TextureRejected: empreinte invalide.
    """
    return get_settings().texture_url(_normalize_sha(sha256))


def relative_url(sha256: str) -> str:
    """Chemin public d'une texture, relatif à ``OPM_PUBLIC_URL``."""
    return f"/textures/{_normalize_sha(sha256)}.png"


def texture_out(
    texture: Texture,
    *,
    kind: str,
    updated_at: datetime | None = None,
) -> TextureOut:
    """Vue publique d'une texture (schéma ``TextureOut``)."""
    return TextureOut.from_texture(texture, kind=kind, updated_at=updated_at)


# --------------------------------------------------------------------------- #
# Validation du contenu
# --------------------------------------------------------------------------- #


def _reject_size(kind: str) -> TextureRejected:
    """Erreur détaillée listant les dimensions admises pour ce type."""
    admitted = ", ".join(f"{width}×{height}" for width, height in sorted(ALLOWED_SIZES[kind]))
    label = "cape" if kind == TextureKind.CAPE.value else "skin"
    return TextureRejected(
        "invalid_texture",
        f"Les dimensions de cette image ne conviennent pas à un {label}. "
        f"Formats acceptés : {admitted}.",
    )


def _not_a_png() -> TextureRejected:
    """Erreur unique pour tout contenu qui n'est pas un PNG lisible."""
    return TextureRejected(
        "invalid_texture",
        "Ce fichier n'est pas une image PNG. Choisissez un skin au format PNG.",
    )


def _decode(data: bytes, kind: str) -> StoredTexture:
    """Valide un PNG **par son contenu**, puis le ré-encode proprement.

    Fonction bloquante (Pillow) : les appelants asynchrones passent par
    :func:`validate`, qui la déporte dans un fil d'exécution.

    :raises TextureRejected: contenu qui n'est pas un PNG, format inattendu,
        dimensions non admises, ou image illisible.
    """
    if not data:
        raise TextureRejected("invalid_texture", "Le fichier envoyé est vide.")
    if not data.startswith(PNG_MAGIC):
        # Ni l'extension ni le Content-Type ne sont regardés : seuls ces huit
        # octets font foi, et un JPEG renommé « skin.png » échoue ici.
        raise _not_a_png()

    allowed = ALLOWED_SIZES.get(kind, ALLOWED_SIZES[TextureKind.SKIN.value])
    try:
        with Image.open(io.BytesIO(data)) as probe:
            if (probe.format or "").upper() != "PNG":
                raise _not_a_png()
            size = (int(probe.width), int(probe.height))
            if size not in allowed:
                raise _reject_size(kind)
            # ``convert`` force le décodage complet : une image tronquée ou
            # volontairement malformée échoue ici, pas plus loin.
            image = probe.convert("RGBA")
    except TextureRejected:
        raise
    except (UnidentifiedImageError, OSError, ValueError, MemoryError) as exc:
        logger.info("Texture refusée : image illisible (%s).", type(exc).__name__)
        raise TextureRejected(
            "invalid_texture",
            "Cette image n'a pas pu être lue. Elle est peut-être incomplète ou abîmée.",
        ) from exc

    buffer = io.BytesIO()
    # Ré-encodage à partir des seuls pixels : rien de l'original ne subsiste.
    image.save(buffer, format="PNG", optimize=True)
    clean = buffer.getvalue()
    return StoredTexture(
        data=clean,
        sha256=hashlib.sha256(clean).hexdigest(),
        width=size[0],
        height=size[1],
    )


async def validate(data: bytes, *, kind: str = TextureKind.SKIN.value) -> StoredTexture:
    """Valide et ré-encode une texture sans bloquer la boucle d'évènements.

    :raises TextureRejected: si le contenu n'est pas une texture acceptable.
    """
    return await asyncio.to_thread(_decode, data, kind)


# --------------------------------------------------------------------------- #
# Écriture du blob
# --------------------------------------------------------------------------- #


def _write_blob(target: Path, data: bytes) -> None:
    """Écrit le fichier s'il manque, de façon atomique. Fonction bloquante.

    L'écriture passe par un fichier temporaire voisin puis ``os.replace`` : une
    coupure de courant ne peut pas laisser un PNG à moitié écrit sous un nom qui
    promet un contenu précis.
    """
    if target.exists():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    try:
        temporary.write_bytes(data)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


async def store_blob(stored: StoredTexture) -> Path:
    """Dépose le PNG ré-encodé sur le disque et retourne son chemin."""
    target = path_for(stored.sha256)
    await asyncio.to_thread(_write_blob, target, stored.data)
    return target


async def blob_exists(sha256: str) -> bool:
    """Le fichier de cette texture est-il présent sur le disque ?"""
    return await asyncio.to_thread(path_for(sha256).is_file)


# --------------------------------------------------------------------------- #
# Téléchargement (import Mojang)
# --------------------------------------------------------------------------- #

#: Transport injecté par les tests (``httpx.MockTransport``). ``None`` en
#: production : httpx ouvre alors de vraies connexions.
_transport: httpx.AsyncBaseTransport | None = None


def set_transport(transport: httpx.AsyncBaseTransport | None) -> None:
    """Impose un transport HTTP au téléchargement des textures.

    Réservé aux tests : ``set_transport(httpx.MockTransport(handler))`` simule
    le serveur de textures de Mojang sans toucher au réseau.
    """
    global _transport
    _transport = transport


@asynccontextmanager
async def _open_client() -> AsyncIterator[httpx.AsyncClient]:
    """Client httpx dédié : délai court, sans proxy, sans redirection."""
    options: dict[str, Any] = {
        "timeout": httpx.Timeout(DOWNLOAD_TIMEOUT_SECONDS, connect=DOWNLOAD_TIMEOUT_SECONDS),
        "headers": {"Accept": "image/png", "User-Agent": USER_AGENT},
        # Une redirection vers un hôte non contrôlé contournerait la liste
        # blanche : on les refuse toutes.
        "follow_redirects": False,
        "trust_env": False,
    }
    if _transport is not None:
        options["transport"] = _transport
    async with httpx.AsyncClient(**options) as client:
        yield client


def _import_hosts() -> tuple[str, ...]:
    """Hôtes autorisés à fournir une texture importée."""
    return tuple(setting("texture_import_hosts", DEFAULT_IMPORT_HOSTS))


def _host_allowed(url: str) -> bool:
    """L'URL vise-t-elle un hôte de la liste blanche ?"""
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"}:
        return False
    host = (parts.hostname or "").lower()
    if not host:
        return False
    return any(
        host == entry.lstrip(".") or host.endswith(entry) for entry in _import_hosts() if entry
    )


async def download(url: str | None, *, max_bytes: int = MOJANG_MAX_BYTES) -> bytes | None:
    """Télécharge une texture, avec plafond de taille et délai courts.

    :return: les octets reçus, ou ``None`` si le téléchargement a échoué pour
        quelque raison que ce soit. **Ne lève jamais** : un import de skin ne
        doit pas faire échouer l'opération qui l'a déclenché.
    """
    if not url or not _host_allowed(url):
        logger.info("Import de texture refusé : hôte non autorisé.")
        return None

    try:
        async with _open_client() as client, client.stream("GET", url) as response:
            if response.status_code != 200:
                logger.info("Import de texture abandonné : statut %s.", response.status_code)
                return None
            chunks: list[bytes] = []
            received = 0
            async for chunk in response.aiter_bytes():
                received += len(chunk)
                if received > max_bytes:
                    # On coupe la connexion plutôt que de remplir la mémoire :
                    # l'URL vient d'un tiers, la taille annoncée aussi.
                    logger.info("Import de texture abandonné : plus de %d octets.", max_bytes)
                    return None
                chunks.append(chunk)
        return b"".join(chunks)
    except (httpx.HTTPError, ValueError) as exc:
        logger.info("Import de texture impossible (%s).", type(exc).__name__)
        return None


# --------------------------------------------------------------------------- #
# Persistance
# --------------------------------------------------------------------------- #


async def _find_texture(session: AsyncSession, sha256: str) -> Texture | None:
    """Retrouve une texture par son empreinte."""
    statement = select(Texture).where(Texture.sha256 == sha256)
    return (await session.execute(statement)).scalars().first()


async def _has_other_holder(session: AsyncSession, texture_id: int) -> bool:
    """Cette texture est-elle déjà portée par au moins un joueur ?"""
    statement = select(UserTexture.user_id).where(UserTexture.texture_id == texture_id).limit(1)
    return (await session.execute(statement)).first() is not None


async def _get_or_create_texture(
    session: AsyncSession,
    stored: StoredTexture,
    *,
    kind: str,
    model: str,
    source: str,
) -> Texture:
    """Retourne la ligne ``texture`` de ce contenu, en la créant au besoin.

    Le contenu étant la clé, deux joueurs au même skin partagent une seule ligne
    et un seul fichier.

    Le modèle de bras (``classic`` / ``slim``), lui, n'est pas dans les pixels :
    un même PNG peut être porté des deux façons. Le schéma n'ayant qu'une colonne
    ``model`` par contenu (``docs/DATA.md`` §2), on ne la corrige que lorsque la
    texture n'a **aucun autre porteur** ; sinon on garde la valeur existante
    plutôt que de changer l'apparence d'un autre joueur.

    Course possible, assumée : si deux joueurs déposent le **même** PNG au même
    instant, la contrainte ``UNIQUE`` sur ``sha256`` tranche et le perdant reçoit
    une erreur. Volontairement non rattrapée ici — un point de reprise SQL au
    milieu d'un import serait un mécanisme lourd et mal portable pour un cas qui
    demande deux fichiers identiques à la milliseconde près. Le second essai
    trouve la ligne et réussit.
    """
    texture = await _find_texture(session, stored.sha256)
    if texture is not None:
        if (
            kind == TextureKind.SKIN.value
            and texture.model != model
            and not await _has_other_holder(session, texture.id)
        ):
            texture.model = model
        return texture

    texture = Texture(
        sha256=stored.sha256,
        kind=kind,
        model=model,
        width=stored.width,
        height=stored.height,
        bytes=stored.size,
        source=source,
    )
    session.add(texture)
    # Le ``flush`` donne son identifiant à la texture : ``user_texture`` en a
    # besoin tout de suite.
    await session.flush()
    return texture


async def _current_link(
    session: AsyncSession,
    user_id: int,
    kind: str,
) -> UserTexture | None:
    """Association ``user_texture`` de ce joueur pour ce type, ou ``None``.

    Passe par la clé primaire composite plutôt que par la collection du modèle :
    la fonction reste correcte même si l'objet ``User`` a été chargé sans ses
    textures, ce qu'une session asynchrone ne pardonnerait pas.
    """
    return await session.get(UserTexture, (user_id, kind))


async def _set_active(
    session: AsyncSession,
    user: User,
    kind: str,
    texture: Texture | None,
) -> None:
    """Pointe ``user_texture`` sur cette texture (``None`` = texture par défaut).

    La ligne existe même quand ``texture_id`` est nul : c'est ce qui distingue
    « ce joueur a choisi la texture par défaut » de « on n'a jamais rien importé
    pour lui ». Cette différence est ce qui empêche une re-vérification de
    possession de réinstaller un skin que le joueur vient justement de retirer.
    """
    link = await _current_link(session, user.id, kind)
    if link is None:
        link = UserTexture(user_id=user.id, kind=kind)
        session.add(link)
        state = sa_inspect(user)
        if "textures" not in state.unloaded and link not in user.textures:
            # Garde le graphe en mémoire cohérent quand il est déjà chargé.
            user.textures.append(link)
    # La relation est renseignée en plus de la clé étrangère : sans elle, la
    # sérialisation du compte, juste après, déclencherait un chargement paresseux
    # — interdit dans une session asynchrone.
    link.texture = texture
    link.texture_id = texture.id if texture is not None else None
    link.updated_at = utcnow()


async def current_textures(session: AsyncSession, user_id: int) -> dict[str, Texture]:
    """Textures actives d'un joueur, indexées par type (``skin`` / ``cape``).

    Les types pointant explicitement sur la texture par défaut (``texture_id``
    nul) sont absents du résultat : le dictionnaire ne contient que des textures
    qui existent réellement.
    """
    statement = (
        select(UserTexture.kind, Texture)
        .join(Texture, Texture.id == UserTexture.texture_id)
        .where(UserTexture.user_id == user_id)
    )
    rows = (await session.execute(statement)).all()
    return {str(kind): texture for kind, texture in rows}


async def clear_texture(session: AsyncSession, user: User, kind: str) -> None:
    """Fait revenir le joueur à la texture par défaut, sans supprimer le blob.

    Le fichier reste sur le disque : il est peut-être partagé avec d'autres
    joueurs, et son URL a été annoncée immuable. Seule l'association change.
    """
    await _set_active(session, user, kind, None)
    logger.info("Texture %s du compte %s remise par défaut.", kind, user.id)


# --------------------------------------------------------------------------- #
# Téléversement depuis le launcher
# --------------------------------------------------------------------------- #


def _max_upload_bytes() -> int:
    """Plafond d'un téléversement, en octets (``OPM_TEXTURE_MAX_KIB``)."""
    return int(get_settings().texture_max_kib) * 1024


def normalize_kind(value: str | None) -> str:
    """Ramène un type de texture à ``skin`` ou ``cape``."""
    cleaned = (value or "").strip().lower()
    return cleaned if cleaned in ALLOWED_SIZES else TextureKind.SKIN.value


def normalize_model(value: str | None) -> str:
    """Ramène un modèle de bras à ``classic`` ou ``slim``."""
    cleaned = (value or "").strip().lower()
    known = {item.value for item in TextureModel}
    return cleaned if cleaned in known else TextureModel.CLASSIC.value


async def store_upload(
    session: AsyncSession,
    user: User,
    data: bytes,
    *,
    kind: str = TextureKind.SKIN.value,
    model: str = TextureModel.CLASSIC.value,
) -> Texture:
    """Enregistre une texture envoyée par le joueur et l'active sur son compte.

    Le contrôle de type se fait **sur le contenu** — en-tête PNG puis décodage
    Pillow —, jamais sur l'extension du fichier ni sur l'en-tête
    ``Content-Type`` : l'un comme l'autre sont choisis par l'appelant, donc sans
    valeur de preuve.

    :raises ApiError: ``texture_too_large`` (413) ou ``invalid_texture`` (400).
    """
    limit = _max_upload_bytes()
    if len(data) > limit:
        raise ApiError(
            "texture_too_large",
            f"Cette image dépasse la taille maximale autorisée ({limit // 1024} Kio).",
            status_code=413,
            details={"max_bytes": limit},
        )

    kind = normalize_kind(kind)
    model = normalize_model(model)

    try:
        stored = await validate(data, kind=kind)
    except TextureRejected as exc:
        raise ApiError(exc.code, exc.message, status_code=400) from exc

    await store_blob(stored)
    texture = await _get_or_create_texture(
        session, stored, kind=kind, model=model, source=TextureSource.UPLOAD.value
    )
    await _set_active(session, user, kind, texture)
    logger.info(
        "Texture %s téléversée pour le compte %s (%s, %d octets).",
        kind,
        user.id,
        stored.sha256[:12],
        stored.size,
    )
    return texture


# --------------------------------------------------------------------------- #
# Import depuis Mojang
# --------------------------------------------------------------------------- #


async def _may_import(session: AsyncSession, user_id: int, kind: str) -> bool:
    """Peut-on remplacer la texture actuelle par un import Mojang ?

    Trois cas, et un seul refus :

    * aucune association : rien n'a jamais été posé, on importe ;
    * association issue d'un import Mojang : on la rafraîchit, le joueur ayant
      pu changer de skin côté Mojang depuis ;
    * association choisie par le joueur — téléversement, ou texture par défaut
      demandée explicitement : **on n'y touche pas**. Ce qu'il a choisi dans le
      launcher ne doit pas être défait par une re-vérification de possession.
    """
    link = await _current_link(session, user_id, kind)
    if link is None:
        return True
    if link.texture_id is None:
        return False
    texture = link.texture
    return texture is None or texture.source == TextureSource.MOJANG_IMPORT.value


async def _import_one(
    session: AsyncSession,
    user: User,
    *,
    url: str | None,
    kind: str,
    model: str,
) -> Texture | None:
    """Télécharge, valide et active une texture. Ne lève pas d'erreur métier.

    Le travail réseau et la validation ont lieu **avant** toute écriture : quand
    on touche enfin à la session, il ne reste que deux insertions triviales.
    """
    if not url or not await _may_import(session, user.id, kind):
        return None

    raw = await download(url)
    if raw is None:
        return None

    try:
        stored = await validate(raw, kind=kind)
    except TextureRejected as exc:
        logger.info("Texture Mojang refusée pour le compte %s : %s.", user.id, exc.code)
        return None

    try:
        await store_blob(stored)
    except OSError as exc:
        logger.warning("Écriture de la texture impossible (%s).", type(exc).__name__)
        return None

    texture = await _get_or_create_texture(
        session,
        stored,
        kind=kind,
        model=model,
        source=TextureSource.MOJANG_IMPORT.value,
    )
    await _set_active(session, user, kind, texture)
    return texture


def _model_of(profile: Any) -> str:
    """Modèle de bras annoncé par le profil Minecraft (``classic`` par défaut)."""
    variant = str(getattr(profile, "skin_model", "") or "").strip().lower()
    return TextureModel.SLIM.value if variant == "slim" else TextureModel.CLASSIC.value


async def import_from_mojang(
    session: AsyncSession,
    user: User,
    profile: Any | None,
) -> Texture | None:
    """Importe le skin (et la cape) du profil Minecraft du joueur.

    Appelée dans la **transaction du rattachement**, juste après l'enregistrement
    du lien : le joueur qui vient de rattacher son compte Microsoft retrouve son
    apparence dès la réponse, sans rien faire (``docs/DATA.md`` §6).

    :param profile: le ``MinecraftProfile`` rapporté par
        ``services.microsoft.get_profile`` — il porte déjà ``skin_url``,
        ``skin_model`` et ``cape_url``. ``None`` est accepté et ne fait rien.
    :return: la texture de skin importée, ou ``None`` si rien ne l'a été.

    **Cette fonction ne lève jamais.** Si quoi que ce soit échoue — Microsoft
    injoignable, PNG douteux, disque plein, base indisponible — le rattachement
    reste valide, le joueur garde le skin par défaut, et l'import sera retenté à
    la prochaine re-vérification.
    """
    if profile is None:
        return None

    skin_url = getattr(profile, "skin_url", None)
    cape_url = getattr(profile, "cape_url", None)
    if not skin_url and not cape_url:
        return None

    skin: Texture | None = None
    try:
        skin = await _import_one(
            session,
            user,
            url=skin_url,
            kind=TextureKind.SKIN.value,
            model=_model_of(profile),
        )
        await _import_one(
            session,
            user,
            url=cape_url,
            kind=TextureKind.CAPE.value,
            model=TextureModel.CLASSIC.value,
        )
    except SQLAlchemyError as exc:
        logger.warning(
            "Import du skin impossible pour le compte %s (%s).",
            user.id,
            type(exc).__name__,
        )
        return None
    except Exception:  # pragma: no cover - filet de sécurité : jamais bloquant
        logger.exception("Import du skin interrompu pour le compte %s.", user.id)
        return None

    if skin is not None:
        logger.info(
            "Skin de %s importé depuis Mojang (%s, modèle %s).",
            user.id,
            skin.sha256[:12],
            skin.model,
        )
    return skin
