"""Yggdrasil maison : identité en jeu, sessions signées et poignée de main join/hasJoined.

C'est le module qui rend le serveur Minecraft indépendant de Mojang. Il ne parle
jamais HTTP vers *nos* clients : les routeurs :mod:`opm_auth.routers.yggdrasil`,
:mod:`opm_auth.routers.sessionserver` et :mod:`opm_auth.routers.game` se
contentent de l'appeler et de traduire ses erreurs.

Quatre responsabilités :

1. **Identité en jeu** — l'UUID et le pseudonyme que le serveur Minecraft voit.
   Ils viennent de ``auth_mc_link`` : l'**UUID premium réel** renvoyé par
   Microsoft (``minecraft_uuid``, 32 caractères sans tirets) et le pseudo
   Minecraft (``minecraft_username``), **jamais** ``users.name`` et jamais un
   UUID fabriqué (``docs/DATA.md`` §8). Mondes, LuckPerms, économie, claims,
   bans et statistiques sont déjà indexés dessus : aucun joueur ne perd sa
   progression.

2. **Sessions** — émission, validation, rafraîchissement et invalidation de
   l'``accessToken`` de jeu (JWT EdDSA de 24 h, ``docs/API.md`` §0). Chaque
   jeton émis laisse une ligne :class:`~opm_auth.models.YggSession` où seule
   l'**empreinte SHA-256** du JWT est conservée : le JWT prouve l'authenticité,
   la ligne permet la révocation, et la base ne contient jamais de jeton
   directement utilisable.

3. **Profils et textures** — la propriété ``textures`` pointe sur nos URL
   ``/textures/{sha256}.png`` (servies par ``routers/textures.py``), encodée en
   base64 et signée en ``SHA1withRSA`` avec la clé publiée dans
   ``signaturePublickey``. SHA-1 et RSA sont imposés par le client Minecraft,
   pas par nous (voir :mod:`opm_auth.security.keys`).

4. **join / hasJoined** — le ``serverId`` transite par la table
   :class:`~opm_auth.models.YggJoin`, dont la durée de vie est très courte
   (``OPM_JOIN_TTL_SECONDS``, 30 s). Une annonce est **consommée** au premier
   ``hasJoined`` : elle n'est pas rejouable. Les lignes périmées sont purgées
   paresseusement, à chaque passage : pas de tâche de fond à surveiller.

Le droit de jouer est toujours calculé par ``User.blocked_reason()`` — la même
méthode qui alimente le champ ``can_play`` de l'API launcher. Le bouton JOUER et
la barrière du serveur de jeu ne peuvent donc pas diverger.

Écritures autorisées
====================

Ce module ne touche aux tables du site que sur un seul point, celui que
``docs/DATA.md`` §4 permet explicitement : ``users.tempsdejeu`` est incrémenté à
la fin d'une session de jeu, par une instruction atomique — et seulement pour
une session de jeu **retrouvée en base**, dont la durée réelle plafonne la durée
annoncée par le client.

Tout le reste de ``users`` — y compris ``password_hash`` — est en **lecture
seule** ici. C'est un choix, pas un oubli : ``docs/DATA.md`` §3 veut que
l'empreinte soit renforcée « à chaque connexion réussie », mais §4 ne nous
autorise pas à écrire ``password_hash`` depuis n'importe quel chemin, et un
client Minecraft n'est pas un client de confiance pour déclencher une écriture
dans la base du site. Le renforcement transparent se joue donc uniquement sur le
chemin de connexion du launcher (``services/users.py``, ``POST /auth/login``),
qui est celui qu'empruntent les joueurs du launcher OPM.
"""

from __future__ import annotations

import base64
import json
import logging
from collections.abc import Iterable
from datetime import datetime
from typing import Any, Literal

import httpx
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from opm_auth import __version__
from opm_auth.config import Settings, get_settings
from opm_auth.models import (
    AuditAction,
    McLink,
    TextureKind,
    TextureModel,
    User,
    UserTexture,
    YggJoin,
    YggSession,
    offline_profile_uuid,
    sha256_hex,
    utcnow,
)
from opm_auth.schemas import (
    GameSessionMetaOut,
    GameSessionOut,
    YggAuthenticateIn,
    YggAuthenticateOut,
    YggJoinIn,
    YggMetaLinksOut,
    YggMetaOut,
    YggProfileOut,
    YggPropertyOut,
    YggRefreshIn,
    YggRootOut,
    YggSignoutIn,
    YggTextureEntry,
    YggTextureMetadata,
    YggTexturesPayload,
    YggUserOut,
    YggValidateIn,
)
from opm_auth.security import setting
from opm_auth.security.deps import ApiError
from opm_auth.security.keys import rsa_public_key_pem, sign_textures
from opm_auth.security.passwords import verify_password_async
from opm_auth.security.ratelimit import enforce
from opm_auth.security.tokens import (
    TokenError,
    create_yggdrasil_token,
    decode_access_token,
    decode_yggdrasil_token,
    new_client_token,
)
from opm_auth.services import audit
from opm_auth.services import textures as texture_service

logger = logging.getLogger(__name__)

__all__ = [
    "BLOCKED_MESSAGES",
    "FORBIDDEN",
    "ILLEGAL_ARGUMENT",
    "YggdrasilError",
    "authenticate",
    "blocked_reason",
    "build_profile",
    "clear_profile_texture",
    "close_game_session",
    "create_game_session",
    "ensure_can_play_api",
    "ensure_can_play_yggdrasil",
    "game_identity",
    "has_joined",
    "invalidate",
    "issue_session",
    "join",
    "microsoft_required",
    "profile_by_uuid",
    "profiles_by_names",
    "refresh",
    "resolve_bearer",
    "resolve_session",
    "root_metadata",
    "signout",
    "store_profile_texture",
    "validate",
]

# --------------------------------------------------------------------------- #
# Vocabulaire d'erreur du protocole Mojang
# --------------------------------------------------------------------------- #

#: Erreur générique du protocole : identifiants, jeton ou droit refusés.
FORBIDDEN = "ForbiddenOperationException"
#: Requête syntaxiquement inacceptable (champ manquant, profil déjà assigné…).
ILLEGAL_ARGUMENT = "IllegalArgumentException"

#: Message rendu pour tout jeton illisible, périmé ou révoqué. Volontairement
#: identique dans les trois cas : le client n'a pas à savoir lequel.
INVALID_TOKEN = "Jeton de session invalide ou expiré."
#: Message rendu quand le couple identifiant/mot de passe ne correspond pas.
INVALID_CREDENTIALS = "Identifiant ou mot de passe incorrect."

#: Longueur maximale d'un ``clientToken`` acceptée (taille de la colonne
#: ``ygg_session.client_token``, ``varchar(64)``).
CLIENT_TOKEN_MAX_LENGTH = 64

#: Sessionserver officiel interrogé par le repli ``OPM_YGG_MOJANG_FALLBACK``.
#: Surchargeable par ``OPM_YGG_MOJANG_SESSION_URL`` sans toucher au code.
MOJANG_HAS_JOINED_URL = "https://sessionserver.mojang.com/session/minecraft/hasJoined"

#: Délai maximal accordé à Mojang. Court volontairement : le serveur de jeu
#: attend cette réponse pour laisser entrer un joueur, il ne doit pas geler.
MOJANG_TIMEOUT_SECONDS = 5.0


class YggdrasilError(Exception):
    """Erreur au format Mojang, transportée jusqu'au routeur.

    Le protocole Yggdrasil n'utilise **pas** le format d'erreur normalisé de
    ``docs/API.md`` §3 mais le sien : ``{"error", "errorMessage", "cause"}``,
    servi en HTTP 403 la plupart du temps.

    :ivar error: nom d'exception Java attendu par le client.
    :ivar error_message: message affiché au joueur, en français.
    :ivar cause: précision facultative (le motif de blocage, par exemple).
    """

    def __init__(
        self,
        error_message: str,
        *,
        error: str = FORBIDDEN,
        cause: str | None = None,
        status_code: int = 403,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.error = error
        self.error_message = error_message
        self.cause = cause
        self.status_code = status_code
        self.headers = headers
        super().__init__(error_message)


#: Messages affichés dans le client Minecraft selon le motif de blocage
#: (``docs/API.md`` §1.2). Ils apparaissent tels quels sur l'écran de
#: déconnexion : ils doivent donc dire au joueur quoi faire, pas seulement
#: constater le refus.
BLOCKED_MESSAGES: dict[str, str] = {
    "microsoft_required": (
        "Rattachez un compte Microsoft possédant Minecraft depuis le launcher "
        "One Piece Minecraft avant de vous connecter."
    ),
    "microsoft_expired": (
        "La vérification de votre compte Microsoft a expiré. Ouvrez le launcher "
        "et relancez-la depuis les paramètres, rubrique Comptes."
    ),
    "ownership_missing": (
        "Le compte Microsoft rattaché ne possède pas Minecraft : Java Edition."
    ),
    "banned": "Votre compte est suspendu : vous ne pouvez pas rejoindre le serveur.",
    "email_unverified": (
        "Confirmez votre adresse e-mail depuis le launcher pour pouvoir jouer."
    ),
}

#: Repli lorsqu'un motif inconnu apparaît (nouvelle règle côté modèle).
DEFAULT_BLOCKED_MESSAGE = "Votre compte n'est pas autorisé à rejoindre le serveur."


# --------------------------------------------------------------------------- #
# Droit de jouer
# --------------------------------------------------------------------------- #


def microsoft_required(settings: Settings | None = None) -> bool:
    """Le rattachement Microsoft est-il exigé pour jouer ?

    * ``sovereign`` — jamais : le compte OPM se suffit à lui-même ;
    * ``microsoft`` — toujours : Microsoft *est* l'identité ;
    * ``hybrid``    — selon ``OPM_MICROSOFT_REQUIRED`` (vrai par défaut).

    La règle est celle de ``docs/API.md`` §0. Elle est réécrite ici, en quatre
    lignes, plutôt qu'importée de :mod:`opm_auth.services.users` : le protocole
    Yggdrasil doit rester utilisable même si la couche « comptes » évolue, et
    une dépendance croisée entre les deux services n'apporterait rien.
    """
    config = settings or get_settings()
    if config.auth_mode == "sovereign":
        return False
    if config.auth_mode == "microsoft":
        return True
    return config.microsoft_required


def blocked_reason(user: User, *, now: datetime | None = None) -> str | None:
    """Motif empêchant ce compte de jouer, ou ``None`` s'il en a le droit.

    Applique la politique en vigueur à la méthode du modèle. Le motif
    ``email_unverified`` n'est jamais rendu : la base du site ne porte aucune
    colonne de vérification d'adresse (voir ``User.blocked_reason``).
    """
    return user.blocked_reason(microsoft_required=microsoft_required(), now=now)


def ensure_can_play_yggdrasil(user: User, *, now: datetime | None = None) -> None:
    """Barrière du protocole Yggdrasil.

    :raises YggdrasilError: 403 au format Mojang, message en français.
    """
    reason = blocked_reason(user, now=now)
    if reason is None:
        return
    logger.info("Connexion Yggdrasil refusée pour le compte %s : %s.", user.id, reason)
    raise YggdrasilError(
        BLOCKED_MESSAGES.get(reason, DEFAULT_BLOCKED_MESSAGE), cause=reason
    )


def ensure_can_play_api(user: User, *, now: datetime | None = None) -> None:
    """Barrière de l'API launcher, au format d'erreur normalisé.

    :raises ApiError: 403 ``microsoft_required`` / ``banned``… (``docs/API.md`` §3).
    """
    reason = blocked_reason(user, now=now)
    if reason is None:
        return

    details: dict[str, Any] | None = None
    if reason == "banned":
        ban = user.active_ban(now)
        if ban is not None:
            details = {
                "until": ban.until.isoformat() if ban.until else None,
                "reason": ban.reason,
            }

    raise ApiError(
        reason,
        BLOCKED_MESSAGES.get(reason, DEFAULT_BLOCKED_MESSAGE),
        status_code=403,
        details=details,
    )


# --------------------------------------------------------------------------- #
# Identité en jeu
# --------------------------------------------------------------------------- #


def game_identity(user: User) -> tuple[str, str]:
    """Couple ``(UUID, pseudonyme)`` que le serveur Minecraft verra.

    Source unique : ``auth_mc_link``. L'UUID est celui que Microsoft a renvoyé —
    l'UUID **premium réel**, sans tirets — et le pseudonyme est
    ``minecraft_username``, resynchronisé à chaque re-vérification de possession.
    ``users.name`` n'apparaît jamais en jeu : commandes, bans et journaux du
    serveur doivent rester cohérents avec ce que Mojang connaît
    (``docs/DATA.md`` §8).

    Le seul cas où un UUID est *dérivé* est le mode ``sovereign`` — hors du
    périmètre de ce projet, qui tourne en « hybride imposé » — sur un compte sans
    rattachement : on retombe alors sur l'UUID hors-ligne calculé depuis
    ``users.name``, exactement comme un serveur ``online-mode=false``.

    :raises YggdrasilError: 403 si le compte n'a pas de rattachement alors que la
        politique l'exige. Ce cas est normalement déjà écarté par
        :func:`ensure_can_play_yggdrasil` ; la garde reste pour qu'aucun chemin
        d'appel ne puisse fabriquer une identité de jeu par accident.
    """
    link = user.mc_link
    if link is not None:
        return link.minecraft_uuid.lower(), link.minecraft_username

    if microsoft_required():
        raise YggdrasilError(
            BLOCKED_MESSAGES["microsoft_required"], cause="microsoft_required"
        )
    return offline_profile_uuid(user.name), user.name


# --------------------------------------------------------------------------- #
# Profils et textures
# --------------------------------------------------------------------------- #


def _texture_entry(link: UserTexture) -> YggTextureEntry | None:
    """Traduit une association ``user_texture`` en entrée du protocole Mojang.

    Retourne ``None`` quand ``texture_id`` est nul : la ligne signifie alors
    « ce joueur a choisi l'apparence par défaut », et le protocole exprime ce
    choix par l'**absence** d'entrée — le client affiche alors Steve ou Alex
    selon l'UUID, ce qui est exactement le comportement voulu.
    """
    texture = link.texture
    if texture is None:
        return None

    metadata: YggTextureMetadata | None = None
    if link.kind == TextureKind.SKIN.value and texture.model == TextureModel.SLIM.value:
        # Seul le modèle « slim » se déclare ; « classic » est l'implicite.
        metadata = YggTextureMetadata(model="slim")
    return YggTextureEntry(
        url=get_settings().texture_url(texture.sha256), metadata=metadata
    )


def textures_payload(
    user: User,
    *,
    profile_uuid: str,
    profile_name: str,
    now: datetime | None = None,
) -> YggTexturesPayload:
    """Charge utile ``textures`` d'un joueur, avant encodage en base64.

    Les URL sont absolues et pointent sur ``OPM_PUBLIC_URL`` + ``/textures/…`` :
    le client Minecraft les télécharge directement, et authlib-injector vérifie
    que leur domaine figure dans ``skinDomains``.
    """
    moment = now or utcnow()
    entries: dict[Literal["SKIN", "CAPE"], YggTextureEntry] = {}

    skin = user.active_texture(TextureKind.SKIN.value)
    if skin is not None and (entry := _texture_entry(skin)) is not None:
        entries["SKIN"] = entry
    cape = user.active_texture(TextureKind.CAPE.value)
    if cape is not None and (entry := _texture_entry(cape)) is not None:
        entries["CAPE"] = entry

    return YggTexturesPayload(
        timestamp=int(moment.timestamp() * 1000),
        profile_id=profile_uuid,
        profile_name=profile_name,
        signature_required=True,
        textures=entries,
    )


def _encode_textures(
    user: User,
    *,
    profile_uuid: str,
    profile_name: str,
    signed: bool,
    now: datetime | None = None,
) -> str:
    """Encode la propriété ``textures`` en base64, exactement comme Mojang.

    Le JSON est compact et sans espace : c'est cette chaîne base64, octet pour
    octet, que le client vérifie contre la signature. ``signatureRequired`` n'est
    présent que dans une réponse signée.
    """
    payload = textures_payload(
        user, profile_uuid=profile_uuid, profile_name=profile_name, now=now
    )
    excluded: set[str] = set() if signed else {"signature_required"}
    data = payload.model_dump(by_alias=True, exclude_none=True, exclude=excluded)
    raw = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return base64.b64encode(raw).decode("ascii")


def profile_properties(
    user: User,
    *,
    profile_uuid: str,
    profile_name: str,
    signed: bool,
    now: datetime | None = None,
) -> list[YggPropertyOut]:
    """Propriétés d'un profil : ``textures``, signée si le client l'exige."""
    value = _encode_textures(
        user,
        profile_uuid=profile_uuid,
        profile_name=profile_name,
        signed=signed,
        now=now,
    )
    return [
        YggPropertyOut(
            name="textures",
            value=value,
            signature=sign_textures(value) if signed else None,
        )
    ]


def build_profile(
    user: User,
    *,
    with_properties: bool = False,
    signed: bool = False,
    now: datetime | None = None,
) -> YggProfileOut:
    """Profil Mojang d'un joueur, bâti sur son identité de jeu.

    :param with_properties: joint la propriété ``textures``. Les réponses de
        ``authenticate`` et ``refresh`` n'en portent pas : le protocole ne les
        attend que sur ``hasJoined`` et ``profile``.
    :param signed: signe la propriété (``SHA1withRSA``).
    """
    profile_uuid, profile_name = game_identity(user)
    return YggProfileOut(
        id=profile_uuid,
        name=profile_name,
        properties=(
            profile_properties(
                user,
                profile_uuid=profile_uuid,
                profile_name=profile_name,
                signed=signed,
                now=now,
            )
            if with_properties
            else None
        ),
    )


# --------------------------------------------------------------------------- #
# Recherche de comptes
# --------------------------------------------------------------------------- #


async def _find_user(db: AsyncSession, identifier: str) -> User | None:
    """Cherche un compte par adresse e-mail **ou** par pseudonyme OPM.

    C'est ce que promet ``feature.non_email_login`` dans les métadonnées ALI :
    le joueur saisit ce qu'il veut dans le champ « Adresse e-mail » du client.
    Le pseudonyme comparé est ``users.name`` — celui du site et du launcher — et
    non le pseudo Minecraft, qui n'est pas un identifiant de connexion.

    La comparaison est insensible à la casse ; si plusieurs lignes du site ne se
    distinguent que par la casse, la correspondance **exacte** l'emporte, afin
    que le résultat ne dépende jamais de l'ordre de lecture.
    """
    raw = (identifier or "").strip()
    needle = raw.lower()
    if not needle:
        return None

    statement = select(User).where(
        or_(func.lower(User.email) == needle, func.lower(User.name) == needle)
    )
    candidates = list((await db.execute(statement)).scalars().all())
    if not candidates:
        return None
    for user in candidates:
        if user.email == raw or user.name == raw:
            return user
    return candidates[0]


async def _find_by_game_name(db: AsyncSession, name: str) -> User | None:
    """Cherche un compte par le pseudonyme qu'il porte **en jeu**.

    Source principale : ``auth_mc_link.minecraft_username``. En mode souverain
    seulement — où aucun rattachement n'est exigé — on retombe sur ``users.name``,
    qui est alors le pseudo de jeu (voir :func:`game_identity`).
    """
    needle = (name or "").strip().lower()
    if not needle:
        return None

    statement = (
        select(User)
        .join(McLink, McLink.user_id == User.id)
        .where(func.lower(McLink.minecraft_username) == needle)
    )
    user = (await db.execute(statement)).scalars().first()
    if user is not None:
        return user

    if microsoft_required():
        return None
    return (
        await db.execute(select(User).where(func.lower(User.name) == needle))
    ).scalars().first()


# --------------------------------------------------------------------------- #
# Sessions de jeu
# --------------------------------------------------------------------------- #


def _normalize_client_token(client_token: str | None) -> str:
    """Retourne le ``clientToken`` à utiliser, en en générant un si besoin.

    :raises YggdrasilError: 400 si le jeton fourni dépasse la taille stockable.
    """
    candidate = (client_token or "").strip()
    if not candidate:
        return new_client_token()
    if len(candidate) > CLIENT_TOKEN_MAX_LENGTH:
        raise YggdrasilError(
            "Le clientToken fourni est trop long.",
            error=ILLEGAL_ARGUMENT,
            status_code=400,
        )
    return candidate


async def _purge_expired_sessions(db: AsyncSession, user_id: int, now: datetime) -> None:
    """Supprime les sessions périmées du joueur (nettoyage paresseux)."""
    await db.execute(
        delete(YggSession).where(
            YggSession.user_id == user_id,
            YggSession.expires_at <= now,
        )
    )


async def issue_session(
    db: AsyncSession,
    user: User,
    *,
    client_token: str | None = None,
    now: datetime | None = None,
) -> tuple[str, YggSession]:
    """Émet un ``accessToken`` de jeu et enregistre la session correspondante.

    Sémantique Mojang : un même ``clientToken`` ne porte qu'une session vivante.
    Réauthentifier depuis le même client invalide donc la session précédente,
    ce qui évite qu'un jeton oublié reste utilisable pendant 24 h.

    Seule l'empreinte SHA-256 du JWT est stockée (``ygg_session.access_token``) :
    une fuite de la base ne livre aucun jeton utilisable.

    :return: le couple ``(accessToken, ligne de session)``. La transaction
        n'est **pas** validée : l'appelant reste maître de son unité de travail.
    """
    moment = now or utcnow()
    token_client = _normalize_client_token(client_token)
    profile_uuid, profile_name = game_identity(user)

    access_token = create_yggdrasil_token(
        player_uuid=profile_uuid,
        name=profile_name,
        client_token=token_client,
    )
    # Relecture immédiate : elle donne la date d'expiration réelle du jeton et
    # vérifie au passage que la paire de clés est cohérente.
    claims = decode_yggdrasil_token(access_token, client_token=token_client)

    await _purge_expired_sessions(db, user.id, moment)
    await db.execute(
        update(YggSession)
        .where(
            YggSession.user_id == user.id,
            YggSession.client_token == token_client,
            YggSession.invalidated_at.is_(None),
        )
        .values(invalidated_at=moment)
    )

    session_row = YggSession(
        user_id=user.id,
        access_token=sha256_hex(access_token),
        client_token=token_client,
        issued_at=moment,
        expires_at=claims.expires_at,
    )
    db.add(session_row)
    await db.flush()
    return access_token, session_row


async def resolve_session(
    db: AsyncSession,
    access_token: str,
    *,
    client_token: str | None = None,
    now: datetime | None = None,
) -> tuple[User, YggSession]:
    """Vérifie un ``accessToken`` de jeu et retourne le joueur et sa session.

    Deux barrières successives : la signature du JWT (authenticité) puis la
    ligne en base (révocation). L'une sans l'autre ne suffirait pas.

    :raises YggdrasilError: 403 si le jeton est illisible, périmé, révoqué, ou
        si son ``clientToken`` ne correspond pas.
    """
    moment = now or utcnow()
    try:
        decode_yggdrasil_token(
            access_token, client_token=(client_token or "").strip() or None
        )
    except TokenError as exc:
        raise YggdrasilError(INVALID_TOKEN) from exc

    session_row = (
        await db.execute(
            select(YggSession).where(YggSession.access_token == sha256_hex(access_token))
        )
    ).scalar_one_or_none()
    if session_row is None or not session_row.is_active(moment):
        raise YggdrasilError(INVALID_TOKEN)

    user = await db.get(User, session_row.user_id)
    if user is None:  # compte supprimé alors que la session courait encore
        raise YggdrasilError(INVALID_TOKEN)
    return user, session_row


def _authenticate_response(
    user: User, access_token: str, client_token: str, *, request_user: bool
) -> YggAuthenticateOut:
    """Réponse commune à ``authenticate`` et ``refresh``."""
    profile = build_profile(user)
    return YggAuthenticateOut(
        access_token=access_token,
        client_token=client_token,
        available_profiles=[profile],
        selected_profile=profile,
        # ``users.id`` est un entier ; le protocole veut une chaîne.
        user=YggUserOut(id=str(user.id)) if request_user else None,
    )


def _account_key(identifier: str | None) -> str:
    """Clé de limitation par compte, **commune aux deux portes de connexion**.

    ``services/users.authenticate`` limite ``auth.login.account`` sur l'adresse
    e-mail normalisée (sans espaces, en minuscules). La même clé est recalculée
    ici à partir de ce que le joueur a saisi : les deux chemins partagent alors
    un seul compteur au lieu d'offrir deux quotas indépendants sur le même
    compte.
    """
    return (identifier or "").strip().lower()


async def _login_failed(
    db: AsyncSession, *, user: User | None, ip: str | None, reason: str
) -> YggdrasilError:
    """Consigne l'échec dans ``auth_audit``, valide, et rend l'erreur à lever.

    Le ``commit`` est délibéré, exactement comme dans
    ``services/users._login_failure`` : la trace d'un échec doit survivre au
    rejet de la requête, sinon la détection d'une attaque par force brute perd
    sa mémoire. S'utilise sous la forme ``raise await _login_failed(...)``.
    """
    await audit.record(
        db,
        AuditAction.LOGIN_FAILED,
        user_id=user.id if user is not None else None,
        ip=ip,
        meta={"reason": reason, "source": "yggdrasil"},
    )
    await db.commit()
    return YggdrasilError(INVALID_CREDENTIALS)


async def _check_credentials(
    db: AsyncSession, *, username: str, password: str, ip: str | None
) -> User:
    """Vérifie un couple identifiant/mot de passe du protocole Yggdrasil.

    Cette surface reçoit les mêmes garde-fous que ``POST /auth/login``, sans
    quoi elle serait une porte de force brute parallèle — dix fois plus large,
    et muette dans le journal d'audit :

    * la limite ``auth.login.account`` est appliquée **avant** la recherche du
      compte : un identifiant inconnu qui ne serait jamais bloqué se trahirait ;
    * le joueur pouvant se connecter par son pseudonyme OPM, une seconde clé —
      celle de son adresse e-mail — est consommée lorsque les deux diffèrent :
      sinon le pseudonyme offrirait un quota neuf sur un compte déjà protégé ;
    * la vérification passe par :func:`verify_password_async` : hors de la
      boucle d'évènements, et à budget de temps constant, donc sans révéler par
      sa durée si le compte existe ;
    * tout échec est écrit dans ``auth_audit``.

    :raises YggdrasilError: 403 quand les identifiants ne correspondent pas.
    :raises ApiError: 429 quand la limite par compte est atteinte ; le routeur
        la traduit au format Mojang.
    """
    identifier = (username or "").strip()
    await enforce("auth.login.account", _account_key(identifier))

    user = await _find_user(db, identifier)
    if user is not None:
        email_key = _account_key(user.email)
        if email_key and email_key != _account_key(identifier):
            await enforce("auth.login.account", email_key)

    # Le mot de passe est vérifié au format Werkzeug (``docs/DATA.md`` §3), et
    # sur une empreinte absente quand le compte est inconnu : le calcul factice
    # de verify_password rend les deux cas indiscernables.
    valid = await verify_password_async(
        user.password_hash if user is not None else None, password
    )
    if user is None or not valid:
        raise await _login_failed(
            db,
            user=user,
            ip=ip,
            reason="unknown_account" if user is None else "invalid_password",
        )
    return user


async def authenticate(
    db: AsyncSession, payload: YggAuthenticateIn, *, ip: str | None = None
) -> YggAuthenticateOut:
    """``POST /yggdrasil/authserver/authenticate``.

    Accepte l'adresse e-mail **ou** le pseudonyme OPM (``users.name``), refuse
    tout compte dont ``can_play`` est faux en expliquant pourquoi en français,
    puis délivre une session de 24 h.

    Les identifiants passent par :func:`_check_credentials` : même limitation
    par compte et même journalisation des échecs que ``POST /auth/login``.

    Aucune écriture n'a lieu sur ``users`` : ni ``derniereconnexion`` — cette
    page-là appartient au chemin de connexion du launcher — ni le renforcement
    de l'empreinte voulu par ``docs/DATA.md`` §3, volontairement réservé au
    chemin ``/api`` (voir l'en-tête du module).
    """
    user = await _check_credentials(
        db, username=payload.username, password=payload.password, ip=ip
    )

    ensure_can_play_yggdrasil(user)

    access_token, session_row = await issue_session(
        db, user, client_token=payload.client_token
    )
    await db.commit()
    logger.info(
        "Session Yggdrasil ouverte pour le compte %s depuis %s.", user.id, ip or "?"
    )
    return _authenticate_response(
        user, access_token, session_row.client_token, request_user=payload.request_user
    )


async def refresh(
    db: AsyncSession, payload: YggRefreshIn, *, ip: str | None = None
) -> YggAuthenticateOut:
    """``POST /yggdrasil/authserver/refresh`` : échange un jeton contre un neuf."""
    if payload.selected_profile is not None:
        # Comportement Mojang : on ne choisit pas de profil au rafraîchissement,
        # notre serveur n'en propose qu'un seul.
        raise YggdrasilError(
            "Ce jeton porte déjà un profil : le champ selectedProfile est refusé.",
            error=ILLEGAL_ARGUMENT,
            status_code=400,
        )

    moment = utcnow()
    user, session_row = await resolve_session(
        db, payload.access_token, client_token=payload.client_token, now=moment
    )
    ensure_can_play_yggdrasil(user, now=moment)

    # L'ancien jeton meurt avec le nouveau : sinon deux sessions vivraient en
    # parallèle après chaque rafraîchissement.
    session_row.invalidated_at = moment
    access_token, new_row = await issue_session(
        db,
        user,
        client_token=session_row.client_token,
        now=moment,
    )
    await db.commit()
    logger.debug("Session Yggdrasil renouvelée pour le compte %s (%s).", user.id, ip or "?")
    return _authenticate_response(
        user, access_token, new_row.client_token, request_user=payload.request_user
    )


async def validate(db: AsyncSession, payload: YggValidateIn) -> None:
    """``POST /yggdrasil/authserver/validate``.

    Ne renvoie rien : l'absence d'erreur **est** la réponse (204).

    :raises YggdrasilError: 403 si la session n'est plus valable.
    """
    await resolve_session(db, payload.access_token, client_token=payload.client_token)


async def invalidate(db: AsyncSession, payload: YggValidateIn) -> None:
    """``POST /yggdrasil/authserver/invalidate`` : ferme une session.

    Toujours silencieux (204), même sur un jeton inconnu : le protocole
    l'exige, et un client qui se déconnecte n'a rien à apprendre de nous. La
    ligne est retrouvée par empreinte, sans même décoder le JWT — un jeton
    expiré doit pouvoir être nettoyé.
    """
    moment = utcnow()
    await db.execute(
        update(YggSession)
        .where(
            YggSession.access_token == sha256_hex(payload.access_token),
            YggSession.invalidated_at.is_(None),
        )
        .values(invalidated_at=moment)
    )
    await db.commit()


async def signout(
    db: AsyncSession, payload: YggSignoutIn, *, ip: str | None = None
) -> None:
    """``POST /yggdrasil/authserver/signout`` : ferme **toutes** les sessions.

    Cette route vérifie un mot de passe : elle est donc protégée exactement
    comme ``authenticate`` (limite par compte, échecs consignés). Sans cela,
    elle offrirait le même oracle de force brute, mais sans le bruit d'une
    session ouverte.

    :raises YggdrasilError: 403 si les identifiants ne correspondent pas.
    """
    user = await _check_credentials(
        db, username=payload.username, password=payload.password, ip=ip
    )

    moment = utcnow()
    await db.execute(
        update(YggSession)
        .where(
            YggSession.user_id == user.id,
            YggSession.invalidated_at.is_(None),
        )
        .values(invalidated_at=moment)
    )
    await db.commit()
    logger.info("Toutes les sessions de jeu du compte %s ont été fermées.", user.id)


# --------------------------------------------------------------------------- #
# Consultation de profils
# --------------------------------------------------------------------------- #


async def profiles_by_names(
    db: AsyncSession, names: Iterable[str]
) -> list[YggProfileOut]:
    """``POST /yggdrasil/api/profiles/minecraft`` : pseudonymes → profils.

    Les pseudonymes sont ceux du **jeu** (``auth_mc_link.minecraft_username``).
    Les inconnus sont simplement absents de la réponse, sans erreur ; l'ordre de
    la demande est conservé et les doublons fusionnés.

    La résolution tient en une requête (deux en mode souverain) : le protocole
    autorise cent pseudonymes par appel, et un aller-retour par nom ferait cent
    allers-retours à la base pour une seule question.
    """
    wanted: list[str] = []
    for name in names:
        lowered = (name or "").strip().lower()
        if lowered and lowered not in wanted:
            wanted.append(lowered)
    if not wanted:
        return []

    found: dict[str, User] = {}
    rows = (
        await db.execute(
            select(User)
            .join(McLink, McLink.user_id == User.id)
            .where(func.lower(McLink.minecraft_username).in_(wanted))
        )
    ).scalars()
    for user in rows:
        link = user.mc_link
        if link is not None:
            found[link.minecraft_username.lower()] = user

    missing = [name for name in wanted if name not in found]
    if missing and not microsoft_required():
        # Mode souverain : le pseudo de jeu est alors ``users.name``.
        others = (
            await db.execute(select(User).where(func.lower(User.name).in_(missing)))
        ).scalars()
        for user in others:
            found.setdefault(user.name.lower(), user)

    return [build_profile(found[name]) for name in wanted if name in found]


async def profile_by_uuid(
    db: AsyncSession, profile_uuid: str, *, unsigned: bool = True
) -> YggProfileOut | None:
    """``GET /session/minecraft/profile/{uuid}`` : profil complet d'un joueur.

    La résolution passe par ``auth_mc_link.minecraft_uuid``, la seule table qui
    associe un UUID de jeu à un compte. Un compte sans rattachement n'a donc pas
    de profil consultable par UUID : reconstituer un UUID hors-ligne exigerait de
    parcourir toute la table ``users``, ce qu'on refuse. Le serveur de jeu passe
    de toute façon par ``hasJoined``, qui lui rend le profil complet.

    :param unsigned: laisser à ``True`` (défaut du protocole) pour une réponse
        sans signature ; le client ne la réclame que pour les skins qu'il
        affiche hors du jeu.
    """
    needle = (profile_uuid or "").replace("-", "").strip().lower()
    if len(needle) != 32:
        return None

    statement = (
        select(User)
        .join(McLink, McLink.user_id == User.id)
        .where(func.lower(McLink.minecraft_uuid) == needle)
    )
    user = (await db.execute(statement)).scalars().first()
    if user is None:
        return None
    return build_profile(user, with_properties=True, signed=not unsigned)


# --------------------------------------------------------------------------- #
# API étendue : textures d'un profil (docs/API.md §2.4)
# --------------------------------------------------------------------------- #


async def resolve_bearer(db: AsyncSession, authorization: str | None) -> User:
    """Identifie le porteur d'un en-tête ``Authorization: Bearer …``.

    Deux jetons sont acceptés, dans cet ordre :

    1. l'``accessToken`` Yggdrasil délivré par ``authserver/authenticate`` —
       c'est celui que présente un client parlant le protocole d'authlib-injector,
       et donc le seul que connaisse un outil de changement de skin ;
    2. l'``access_token`` de l'API launcher, pour que le launcher OPM puisse
       emprunter cette route comme n'importe quel autre client, sans ouvrir une
       session de jeu pour rien.

    :raises YggdrasilError: 401 quand l'en-tête est absent, mal formé, ou que le
        jeton n'est ni l'un ni l'autre.
    """
    scheme, _, raw = (authorization or "").partition(" ")
    token = raw.strip()
    if scheme.lower() != "bearer" or not token:
        raise YggdrasilError("Jeton d'accès manquant.", status_code=401)

    try:
        user, _session_row = await resolve_session(db, token)
    except YggdrasilError:
        pass  # ce n'est pas un jeton de jeu : reste le jeton de l'API launcher.
    else:
        return user

    try:
        claims = decode_access_token(token)
        user_id = int(claims.subject)
    except (TokenError, TypeError, ValueError):
        raise YggdrasilError(INVALID_TOKEN, status_code=401) from None

    user = await db.get(User, user_id)
    if user is None:  # jeton authentique, compte supprimé depuis
        raise YggdrasilError(INVALID_TOKEN, status_code=401)
    return user


def _ensure_own_profile(user: User, profile_uuid: str) -> None:
    """Vérifie que l'UUID de l'URL est bien celui du porteur du jeton.

    Sans cette garde, un joueur authentifié changerait le skin de n'importe quel
    autre profil du serveur : l'UUID est public, il apparaît dans chaque réponse
    ``hasJoined``.
    """
    wanted = (profile_uuid or "").replace("-", "").strip().lower()
    identity, _name = game_identity(user)
    owned = identity.replace("-", "").strip().lower()
    if not wanted or wanted != owned:
        logger.info(
            "Texture refusée : le compte %s n'est pas propriétaire du profil %s.",
            user.id,
            wanted or "?",
        )
        raise YggdrasilError(
            "Ce profil n'est pas le vôtre.", cause="profile_mismatch"
        )


async def store_profile_texture(
    db: AsyncSession,
    *,
    authorization: str | None,
    profile_uuid: str,
    texture_type: str,
    data: bytes,
    model: str | None = None,
) -> None:
    """``PUT /yggdrasil/api/user/profile/{uuid}/{textureType}``.

    Point d'entrée standard d'authlib-injector pour poser un skin ou une cape.
    Le contenu est validé, ré-encodé et rangé par
    :func:`opm_auth.services.textures.store_upload` — exactement le même chemin
    que ``POST /textures/{kind}`` du launcher : une seule implémentation, donc
    une seule politique de taille, de dimensions et de format.

    :param model: ``slim`` pour le modèle de bras fin ; toute autre valeur, y
        compris la chaîne vide qu'envoie authlib-injector, vaut ``classic``.
    :raises YggdrasilError: 401 jeton absent ou invalide, 403 profil d'un autre.
    :raises ApiError: 400 ``invalid_texture`` / 413 ``texture_too_large`` ; le
        routeur les rend au format Mojang.
    """
    user = await resolve_bearer(db, authorization)
    _ensure_own_profile(user, profile_uuid)

    kind = texture_service.normalize_kind(texture_type)
    await texture_service.store_upload(
        db,
        user,
        data,
        kind=kind,
        model=texture_service.normalize_model(model),
    )
    await db.commit()
    logger.info(
        "Texture %s déposée par l'API Yggdrasil pour le compte %s.", kind, user.id
    )


async def clear_profile_texture(
    db: AsyncSession,
    *,
    authorization: str | None,
    profile_uuid: str,
    texture_type: str,
) -> None:
    """``DELETE /yggdrasil/api/user/profile/{uuid}/{textureType}``.

    Remet le joueur à l'apparence par défaut. Le blob reste sur le disque : son
    URL a été annoncée immuable et il est peut-être partagé. Idempotent —
    retirer une texture déjà absente réussit.
    """
    user = await resolve_bearer(db, authorization)
    _ensure_own_profile(user, profile_uuid)

    kind = texture_service.normalize_kind(texture_type)
    await texture_service.clear_texture(db, user, kind)
    await db.commit()
    logger.info(
        "Texture %s retirée par l'API Yggdrasil pour le compte %s.", kind, user.id
    )


# --------------------------------------------------------------------------- #
# Protocole join / hasJoined
# --------------------------------------------------------------------------- #


async def _purge_join_requests(db: AsyncSession, now: datetime) -> None:
    """Nettoyage paresseux des annonces d'arrivée périmées."""
    await db.execute(
        delete(YggJoin).where(YggJoin.created_at <= now - get_settings().join_ttl)
    )


async def join(db: AsyncSession, payload: YggJoinIn, *, ip: str | None = None) -> None:
    """``POST /session/minecraft/join`` : le client annonce son arrivée.

    Le serveur Minecraft confirmera dans la seconde par ``hasJoined``. La trace
    ne vit que ``OPM_JOIN_TTL_SECONDS`` (30 s) : au-delà, la poignée de main a
    échoué et il faut la recommencer.

    :raises YggdrasilError: 403 si la session est invalide ou si le profil
        annoncé n'est pas celui du porteur du jeton.
    """
    moment = utcnow()
    user, _session_row = await resolve_session(db, payload.access_token, now=moment)

    profile_uuid, _name = game_identity(user)
    if payload.selected_profile.lower() != profile_uuid:
        raise YggdrasilError("Le profil annoncé ne correspond pas à cette session.")
    ensure_can_play_yggdrasil(user, now=moment)

    await _purge_join_requests(db, moment)
    # ``server_id`` est la clé primaire : une nouvelle annonce remplace la
    # précédente, une reconnexion immédiate ne peut donc pas être validée par la
    # poignée de main d'avant.
    await db.execute(delete(YggJoin).where(YggJoin.server_id == payload.server_id))
    db.add(
        YggJoin(
            server_id=payload.server_id,
            user_id=user.id,
            ip=ip,
            created_at=moment,
        )
    )
    await db.commit()


async def _profile_for_join(
    db: AsyncSession,
    *,
    user_id: int,
    join_ip: str | None,
    username: str,
    ip: str | None,
    now: datetime,
) -> YggProfileOut | None:
    """Vérifie une annonce consommée et rend le profil signé, ou ``None``.

    L'annonce est passée « à plat » (identifiant du compte et adresse mémorisée)
    plutôt que par son objet : la ligne vient d'être supprimée, et manipuler une
    instance dont la ligne n'existe plus n'apporterait que des surprises.
    """
    user = await db.get(User, user_id)
    if user is None:
        return None

    _profile_uuid, profile_name = game_identity(user)
    if profile_name.lower() != username.lower():
        logger.info(
            "hasJoined refusé : le serveur annonce « %s » là où la session porte « %s ».",
            username,
            profile_name,
        )
        return None

    # L'adresse n'est transmise que si ``prevent-proxy-connections`` est actif :
    # on ne la compare donc que lorsqu'elle est fournie **et** qu'on a mémorisé
    # celle du client au moment du join.
    if ip and join_ip and ip != join_ip:
        logger.info(
            "hasJoined refusé pour %s : adresse %s au lieu de %s.", username, ip, join_ip
        )
        return None

    reason = blocked_reason(user, now=now)
    if reason is not None:
        # Une sanction tombée entre le join et le hasJoined doit fermer la porte.
        logger.info("hasJoined refusé pour %s : %s.", username, reason)
        return None

    return build_profile(user, with_properties=True, signed=True, now=now)


async def has_joined(
    db: AsyncSession, *, username: str, server_id: str, ip: str | None = None
) -> YggProfileOut | None:
    """``GET /session/minecraft/hasJoined`` : le serveur Minecraft vérifie.

    L'annonce est **consommée** : trouvée ou périmée, la ligne est supprimée
    avant même d'être jugée. Un ``serverId`` ne vaut donc qu'une seule fois, et
    une réponse rejouée ne peut pas servir à entrer une seconde fois.

    :param ip: adresse vue par le serveur de jeu.
    :return: le profil **signé**, ou ``None`` si aucune annonce ne correspond
        (le routeur répond alors 204, comme le protocole l'exige).
    """
    settings = get_settings()
    moment = utcnow()
    needle = (username or "").strip()
    if not needle or not server_id:
        return None

    row = await db.get(YggJoin, server_id)
    profile: YggProfileOut | None = None
    if row is not None:
        expired = row.is_expired(settings.join_ttl_seconds, moment)
        user_id, join_ip = row.user_id, row.ip
        # Consommation immédiate : non rejouable, même en cas de refus.
        await db.execute(delete(YggJoin).where(YggJoin.server_id == server_id))
        db.expunge(row)
        if not expired:
            profile = await _profile_for_join(
                db,
                user_id=user_id,
                join_ip=join_ip,
                username=needle,
                ip=ip,
                now=moment,
            )

    await _purge_join_requests(db, moment)
    await db.commit()

    if profile is not None:
        return profile
    if settings.ygg_mojang_fallback and await _find_by_game_name(db, needle) is None:
        return await _mojang_has_joined(needle, server_id, ip)
    return None


async def _mojang_has_joined(
    username: str, server_id: str, ip: str | None
) -> YggProfileOut | None:
    """Repli ``OPM_YGG_MOJANG_FALLBACK`` : demander à Mojang de trancher.

    Quand le pseudonyme est **inconnu de notre base**, on relaie la question au
    sessionserver officiel. Les joueurs premium venus du launcher officiel
    peuvent alors entrer sur le serveur.

    Le compromis, à connaître avant d'activer le réglage :

    * on ouvre le serveur à des comptes qui n'ont **aucun** compte OPM : ni fiche
      RP, ni temps de jeu, ni possibilité de les bannir depuis le launcher ;
    * les propriétés relayées sont signées par la **clé de Mojang**, pas par la
      nôtre. Comme authlib-injector publie notre clé publique, les clients
      refuseront cette signature : ces joueurs apparaîtront avec l'apparence par
      défaut. Leur connexion fonctionne, leur skin non ;
    * la réponse dépend d'un service externe : le délai est volontairement court
      (:data:`MOJANG_TIMEOUT_SECONDS`) pour ne pas geler le serveur de jeu, et
      toute panne se traduit par un refus, jamais par une acceptation.

    Le repli n'est **jamais** consulté pour un pseudonyme que nous connaissons :
    un compte banni ou sans possession vérifiée ne peut donc pas contourner nos
    règles en passant par Mojang. À laisser désactivé en « hybride imposé »
    (``docs/DATA.md`` §8).
    """
    url = setting("ygg_mojang_session_url", MOJANG_HAS_JOINED_URL)
    params: dict[str, str] = {"username": username, "serverId": server_id}
    if ip:
        params["ip"] = ip

    try:
        async with httpx.AsyncClient(timeout=MOJANG_TIMEOUT_SECONDS) as client:
            response = await client.get(url, params=params)
    except httpx.HTTPError as exc:
        logger.warning("Repli Mojang injoignable pour %s : %s.", username, exc)
        return None

    if response.status_code != 200 or not response.content:
        return None
    try:
        payload = response.json()
    except ValueError:
        logger.warning("Réponse Mojang illisible pour %s.", username)
        return None
    if not isinstance(payload, dict) or not payload.get("id") or not payload.get("name"):
        return None

    properties = [
        YggPropertyOut.model_validate(item)
        for item in payload.get("properties") or []
        if isinstance(item, dict) and item.get("name") and item.get("value")
    ]
    logger.info("Joueur premium %s admis par le repli Mojang.", payload["name"])
    return YggProfileOut(
        id=str(payload["id"]).replace("-", "").lower(),
        name=str(payload["name"]),
        properties=properties or None,
    )


# --------------------------------------------------------------------------- #
# Métadonnées ALI (authlib-injector)
# --------------------------------------------------------------------------- #


def root_metadata() -> YggRootOut:
    """``GET /yggdrasil`` : ce que lit authlib-injector au démarrage du serveur.

    Le champ ``signaturePublickey`` publie la clé RSA qui vérifie les propriétés
    ``textures`` ; ``skinDomains`` liste les domaines depuis lesquels le client
    acceptera de télécharger une texture. ``feature.non_email_login`` annonce que
    le joueur peut se connecter avec son pseudonyme OPM.
    """
    settings = get_settings()
    homepage = settings.link_website or settings.public_url
    return YggRootOut(
        meta=YggMetaOut(
            server_name=settings.server_name,
            implementation_name="opm-yggdrasil",
            implementation_version=__version__,
            links=YggMetaLinksOut(
                homepage=homepage, register_url=f"{homepage}/register"
            ),
            feature_non_email_login=True,
        ),
        skin_domains=settings.skin_domains_list,
        signature_publickey=rsa_public_key_pem(),
    )


# --------------------------------------------------------------------------- #
# Session de jeu de l'API launcher (docs/API.md §1.4)
# --------------------------------------------------------------------------- #


async def create_game_session(
    db: AsyncSession, user: User, *, client_token: str | None = None
) -> GameSessionOut:
    """``POST /api/v1/game/session`` : la session que le launcher passe au jeu.

    La forme est exactement celle de l'objet ``authenticator`` de
    ``minecraft-java-core`` : le launcher la transmet telle quelle. Aucun jeton
    Microsoft n'y figure — le launcher ne donne au jeu que ce que **nous** avons
    signé — et ``uuid`` / ``name`` sont l'identité premium du joueur, pas son
    identité de site.

    :raises ApiError: 403 ``microsoft_required`` / ``banned``… si le compte n'a
        pas le droit de jouer, 429 ``rate_limited`` en cas d'abus.
    """
    await enforce("game.session.account", str(user.id))
    ensure_can_play_api(user)

    access_token, session_row = await issue_session(db, user, client_token=client_token)
    await db.commit()

    profile_uuid, profile_name = game_identity(user)
    logger.info("Session de jeu délivrée au compte %s (%s).", user.id, profile_name)
    return GameSessionOut(
        access_token=access_token,
        client_token=session_row.client_token,
        uuid=profile_uuid,
        name=profile_name,
        user_properties="{}",
        meta=GameSessionMetaOut(
            type="OPM", demo=False, expires_at=session_row.expires_at
        ),
    )


async def close_game_session(
    db: AsyncSession,
    user: User,
    *,
    duration_s: int,
    client_token: str | None = None,
) -> int:
    """``POST /api/v1/game/session/close`` : le jeu s'est arrêté.

    Deux effets, et rien d'autre :

    1. la durée jouée s'ajoute à ``users.tempsdejeu`` — la seconde des deux
       seules colonnes de ``users`` que ``docs/DATA.md`` §4 nous autorise à
       écrire. L'incrément passe par **une** instruction atomique
       (``tempsdejeu = tempsdejeu + :durée``) : le serveur Minecraft et le site
       écrivent parfois au même instant, un lire-puis-écrire perdrait du temps
       de jeu ;
    2. la session Yggdrasil correspondante est invalidée quand le launcher
       fournit son ``clientToken``, pour qu'un jeton de 24 h ne survive pas à la
       partie qu'il servait.

    **La durée annoncée n'est jamais crue sur parole.** C'est la seule écriture
    que nous fassions dans une colonne affichée par le site : elle doit être
    irréprochable. Le crédit exige donc une session de jeu réelle — celle que
    désigne le ``clientToken`` — et il est plafonné par la durée qu'elle a
    vécue. Un launcher modifié qui rejouerait la requête avec 86 400 s ne
    trouverait, la deuxième fois, aucune session ouverte à fermer : rien ne
    serait crédité.

    .. note::
       Le jour où ``services/users.py`` exposera ``add_playtime``, cette fonction
       devra s'y déléguer : l'instruction ci-dessous en est l'exact équivalent.
       Elle est écrite ici pour que la fermeture de session ne dépende pas d'une
       fonction qui n'existe pas encore.

    :param duration_s: durée jouée annoncée par le launcher, en secondes. Les
        valeurs négatives sont ramenées à zéro et le plafond absolu est posé par
        le schéma d'entrée ; le plafond réel, lui, est la durée de la session.
    :param client_token: celui de la session ouverte par ``POST /game/session``.
        Sans lui, aucune partie n'est identifiable : la session n'est pas fermée
        et **rien n'est crédité**. La réponse reste un 204 — fermer une partie
        n'est pas une opération qui doit pouvoir échouer sous les yeux du joueur.
    :return: le nombre de secondes réellement ajoutées.
    """
    moment = utcnow()
    announced = max(0, int(duration_s or 0))
    token = (client_token or "").strip()
    seconds = 0

    if not token:
        logger.warning(
            "Fermeture de session sans clientToken pour le compte %s : "
            "aucune partie à créditer.",
            user.id,
        )
        return 0

    session_row = (
        await db.execute(
            select(YggSession).where(
                YggSession.user_id == user.id,
                YggSession.client_token == token,
                YggSession.invalidated_at.is_(None),
            )
        )
    ).scalars().first()

    if session_row is None:
        # Session inconnue, déjà fermée, ou appartenant à quelqu'un d'autre :
        # la requête est un rejeu. On ne crédite rien et on ne se plaint pas.
        logger.info(
            "Fermeture de session ignorée pour le compte %s : aucune partie ouverte "
            "sous ce clientToken.",
            user.id,
        )
        return 0

    # La clause ``invalidated_at IS NULL`` fait office de verrou : de deux
    # fermetures concurrentes, une seule referme la ligne, donc une seule
    # crédite.
    closed = await db.execute(
        update(YggSession)
        .where(
            YggSession.id == session_row.id,
            YggSession.invalidated_at.is_(None),
        )
        .values(invalidated_at=moment)
    )
    if closed.rowcount:
        lived = int((moment - session_row.issued_at).total_seconds())
        seconds = max(0, min(announced, lived))

    if seconds:
        await db.execute(
            update(User)
            .where(User.id == user.id)
            .values(tempsdejeu=func.coalesce(User.tempsdejeu, 0) + seconds)
        )

    await db.commit()
    if seconds:
        logger.info(
            "Temps de jeu du compte %s augmenté de %d s (annoncé %d s).",
            user.id,
            seconds,
            announced,
        )
    return seconds
