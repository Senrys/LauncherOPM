"""Comptes OPM : création, authentification, sessions, mot de passe et 2FA.

Ce module porte **toute** la logique des comptes ; le routeur
``opm_auth.routers.auth`` ne fait que traduire ses résultats en réponses HTTP.

La base est celle du site
=========================

Il n'existe **qu'un seul compte** : la ligne ``users`` du site Flask
(``docs/DATA.md`` §1). Un compte créé depuis le launcher se connecte au site, et
réciproquement. Trois conséquences structurent tout le fichier :

* ``users.id`` est un **entier** (``serial``), jamais un UUID ;
* le pseudonyme du launcher est ``users.name`` — le pseudo affiché **en jeu**
  est ``auth_mc_link.minecraft_username`` (``docs/DATA.md`` §8) ;
* les empreintes de mot de passe sont au **format Werkzeug**
  (``pbkdf2:sha256:<itérations>$sel$hex``), jamais en Argon2id : le site doit
  continuer de savoir vérifier les mots de passe (``docs/DATA.md`` §3).

Ce que ce module écrit dans la table du site
============================================

Rien d'autre que ceci, et c'est délibérément court (``docs/DATA.md`` §3 et §4) :

* l'``INSERT`` d'un nouveau compte (:func:`create_user`) ;
* ``users.password_hash`` — à l'inscription, à la réinitialisation, et lors du
  **renforcement transparent** de l'empreinte à la connexion ;
* ``users.derniereconnexion`` — à chaque connexion réussie ;
* ``users.tempsdejeu`` — incrémenté en fin de session de jeu
  (:func:`add_playtime`, par une instruction atomique). C'est la seule valeur
  que le **client** nous souffle : elle est donc confrontée à une session
  ``ygg_session`` réellement ouverte, plafonnée au temps écoulé depuis son
  émission, et la clôture n'a lieu qu'une fois.

Les colonnes RP (``prime``, ``berry``, ``niveau*``, ``faction``, ``equipage``,
``territoires``…) appartiennent au serveur Minecraft et au site : on les **lit**
pour l'affichage, jamais l'inverse. Seule exception assumée : l'``INSERT``
initial doit bien poser une valeur dans les colonnes ``NOT NULL`` dépourvues de
valeur par défaut, sans quoi la ligne serait refusée par PostgreSQL — voir
:data:`NEW_ACCOUNT_DEFAULTS`.

Trois règles guident le reste
=============================

* **anti-énumération** — une réponse ne doit jamais révéler qu'une adresse
  e-mail existe, ni par son code, ni par son message, ni par son temps de
  réponse (``docs/API.md`` §4.6) ;
* **rotation stricte des sessions** — un ``refresh_token`` sert une fois ;
  toute réapparition d'un jeton déjà consommé révoque la famille entière
  (``docs/API.md`` §4.3) ;
* **traçabilité** — chaque événement sensible laisse une entrée d'audit,
  expurgée de toute donnée secrète.

Convention de transaction : les fonctions publiques qui écrivent valident
elles-mêmes (``commit``). :func:`authenticate` fait exception sur son chemin
nominal : elle laisse la transaction ouverte pour que :func:`login` émette les
jetons dans la même unité de travail.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, NoReturn

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from opm_auth.config import Settings, get_settings
from opm_auth.models import (
    AuditAction,
    Equipage,
    Ile,
    PasswordReset,
    RecoveryCode,
    RefreshToken,
    TextureKind,
    TextureModel,
    Totp,
    User,
    YggSession,
    sha256_hex,
    utcnow,
)
from opm_auth.schemas import SkinOut, TokenPairOut, TotpSetupOut, UserOut
from opm_auth.security.crypto import (
    NONCE_SIZE,
    CryptoError,
    b64u_decode,
    b64u_encode,
    decrypt_totp_secret,
    encrypt_totp_secret,
)
from opm_auth.security.deps import ApiError, invalid_credentials
from opm_auth.security.passwords import (
    WeakPasswordError,
    check_password_strength,
    hash_password,
    needs_rehash,
    verify_password,
)
from opm_auth.security.ratelimit import enforce
from opm_auth.security.tokens import (
    TokenError,
    create_access_token,
    create_password_reset_token,
    decode_password_reset_token,
    hash_refresh_token,
    new_refresh_token,
    password_reset_ttl,
    rotate_refresh_token,
)
from opm_auth.security.totp import (
    generate_recovery_codes_async,
    generate_totp_secret,
    provisioning_uri,
    verify_recovery_code,
    verify_totp,
)
from opm_auth.services import audit

logger = logging.getLogger(__name__)

__all__ = [
    "NEW_ACCOUNT_DEFAULTS",
    "STARTING_LEVEL",
    "PasswordResetSender",
    "active_skin",
    "add_playtime",
    "authenticate",
    "blocked_reason",
    "can_play",
    "confirm_totp",
    "count_iles_tenues",
    "create_user",
    "disable_totp",
    "get_by_email",
    "get_by_username",
    "issue_tokens",
    "login",
    "logout",
    "microsoft_required",
    "normalize_email",
    "normalize_username",
    "request_password_reset",
    "reset_password",
    "rotate_session",
    "serialize",
    "serialize_with_profile",
    "set_password_reset_sender",
    "start_totp_enrollment",
]

#: Message unique de tous les échecs d'authentification par mot de passe.
#: Un seul texte, quelle que soit la cause : compte inconnu, mot de passe faux
#: ou compte supprimé entre-temps.
_INVALID_CREDENTIALS = "Adresse e-mail ou mot de passe incorrect."

#: Message unique des échecs de renouvellement de session.
_SESSION_LOST = "Votre session n'est plus valide, reconnectez-vous."

#: Longueur de ``auth_refresh_token.device_label``.
_DEVICE_LABEL_LENGTH = 120


# --------------------------------------------------------------------------- #
# PBKDF2 hors de la boucle d'évènements
# --------------------------------------------------------------------------- #
#
# Une dérivation PBKDF2 à 600 000 itérations coûte de 0,3 à 0,5 s de processeur,
# verrou global tenu. Appelée telle quelle depuis une coroutine, elle fige le
# worker entier : pendant ce temps, ni ``hasJoined`` (le serveur Minecraft
# refuserait l'entrée en jeu), ni le ping des statistiques, ni le
# renouvellement d'un jeton ne sont servis. Trois connexions simultanées
# suffisent à rendre l'API muette pendant deux secondes.
#
# Les fonctions de ``security/passwords.py`` restent délibérément synchrones :
# la CLI et les tests les appellent directement. C'est **ici**, au point
# d'appel asynchrone, que le calcul part dans un fil d'exécution.


async def _hash_password(password: str) -> str:
    """Calcule une empreinte Werkzeug sans bloquer la boucle d'évènements."""
    return await asyncio.to_thread(hash_password, password)


async def _verify_password(stored_hash: str | None, password: str) -> bool:
    """Vérifie un mot de passe sans bloquer la boucle d'évènements.

    Conserve l'anti-énumération : ``verify_password`` brûle le même temps de
    processeur quand l'empreinte est absente (``docs/API.md`` §4.6).
    """
    return await asyncio.to_thread(verify_password, stored_hash, password)


async def _verify_recovery_code(code: str, hashes: list[str]) -> int | None:
    """Cherche un code de secours correspondant, hors de la boucle.

    Le parcours compare le code à chaque empreinte restante : jusqu'à dix
    dérivations d'affilée, soit le tiers d'une seconde de processeur.
    """
    return await asyncio.to_thread(verify_recovery_code, code, hashes)


# --------------------------------------------------------------------------- #
# Valeurs de départ d'une ligne « users »
# --------------------------------------------------------------------------- #

#: Niveau de départ d'un personnage. 1 et non 0 : c'est la plus petite valeur
#: qui ait un sens pour un niveau, et le launcher affiche « NIVEAU 1 » plutôt
#: qu'un « NIVEAU 0 » qui se lirait comme une donnée manquante.
STARTING_LEVEL: int = 1

#: Valeurs posées à l'``INSERT`` d'un compte créé depuis le launcher.
#:
#: Les colonnes listées ici sont **toutes** ``NOT NULL`` dans le dump du site
#: (``reference/opm-site-schema.sql``). Les dix-sept premières — neuf textes et
#: huit niveaux — n'ont **aucune valeur par défaut** : sans elles, l'``INSERT``
#: échouerait sur une violation de contrainte. Elles ont été relevées une par
#: une dans le ``CREATE TABLE public.users`` du dump. Les deux dernières
#: (``role_equipage``, ``titres``) ont bien un ``DEFAULT ''`` côté PostgreSQL,
#: mais on les renseigne quand même pour que l'objet Python soit complet avant
#: même le premier ``flush``.
#:
#: Le choix de la **chaîne vide** n'est pas un pis-aller : c'est déjà ce que le
#: site pose pour une fiche non remplie, et ``UserProfileOut.from_user``
#: traduit une chaîne vide en ``None``, ce que le launcher affiche par un tiret
#: honnête plutôt que par une étiquette vide. Le launcher n'invente donc ni
#: faction, ni équipage, ni métier : c'est au site et au serveur Minecraft de
#: les attribuer.
NEW_ACCOUNT_DEFAULTS: dict[str, Any] = {
    # -- fiche de personnage : NOT NULL, sans valeur par défaut ---------------
    "genre": "",
    "provenance": "",
    "faction": "",
    "race": "",
    "specialisation": "",
    "equipage": "",
    "territoires": "",
    "metier": "",
    "nomfdd": "",
    # -- niveaux : NOT NULL, sans valeur par défaut ---------------------------
    "niveaubase": STARTING_LEVEL,
    "niveaumetier": STARTING_LEVEL,
    "niveaucrochetage": STARTING_LEVEL,
    "niveauminage": STARTING_LEVEL,
    "niveaubuchage": STARTING_LEVEL,
    "niveaucueillette": STARTING_LEVEL,
    "niveauchasse": STARTING_LEVEL,
    "niveaupeche": STARTING_LEVEL,
    # -- NOT NULL avec DEFAULT côté base : renseignées par confort ------------
    "role_equipage": "",
    "titres": "",
}

# Les colonnes nullables (``age``, ``prime``, ``berry``, ``niveauhaki``,
# ``niveaufdd``, ``gigot``, ``tokenpaiement``) restent volontairement à ``NULL`` :
# une prime à 0 se lirait comme « pirate sans valeur », alors que l'absence de
# prime se lit comme « pas encore de prime ».


# --------------------------------------------------------------------------- #
# Normalisation et recherche
# --------------------------------------------------------------------------- #


def normalize_email(value: str) -> str:
    """Forme canonique d'une adresse e-mail : sans espaces, en minuscules."""
    return value.strip().lower()


def normalize_username(value: str) -> str:
    """Forme canonique d'un pseudonyme : sans espaces de bordure.

    La casse est **conservée** : ``users.name`` est la valeur affichée par le
    site comme par le launcher. L'unicité insensible à la casse est vérifiée à
    la requête (:func:`get_by_username`), la contrainte du site restant, elle,
    sensible à la casse.
    """
    return value.strip()


async def get_by_email(session: AsyncSession, email: str) -> User | None:
    """Cherche un compte par son adresse e-mail, sans égard à la casse.

    La comparaison passe par ``lower()`` plutôt que par une égalité stricte :
    les adresses déjà présentes dans la base du site n'ont pas toutes été
    normalisées, et un joueur inscrit sur le site sous ``Capitaine@…`` doit
    pouvoir se connecter au launcher en tapant ``capitaine@…``.
    """
    return await session.scalar(
        select(User).where(func.lower(User.email) == normalize_email(email))
    )


async def get_by_username(session: AsyncSession, username: str) -> User | None:
    """Cherche un compte par son pseudonyme (``users.name``), sans égard à la casse."""
    return await session.scalar(
        select(User).where(func.lower(User.name) == normalize_username(username).lower())
    )


# --------------------------------------------------------------------------- #
# Droit de jouer et sérialisation
# --------------------------------------------------------------------------- #


def microsoft_required(settings: Settings | None = None) -> bool:
    """Le rattachement Microsoft est-il exigé pour jouer ?

    * ``sovereign`` — jamais : le compte OPM se suffit à lui-même ;
    * ``microsoft`` — toujours : Microsoft *est* l'identité ;
    * ``hybrid``    — selon ``OPM_MICROSOFT_REQUIRED`` (vrai par défaut).
    """
    config = settings or get_settings()
    if config.auth_mode == "sovereign":
        return False
    if config.auth_mode == "microsoft":
        return True
    return config.microsoft_required


def blocked_reason(
    user: User,
    *,
    settings: Settings | None = None,
    now: datetime | None = None,
) -> str | None:
    """Motif empêchant ce compte de lancer le jeu, ou ``None``.

    Le calcul est délégué à ``User.blocked_reason()`` — la méthode même
    qu'utilise la barrière serveur ``require_can_play`` : le bouton JOUER du
    launcher et le refus de session de jeu ne peuvent donc pas diverger.

    Les trois motifs Microsoft sortent de ``auth_mc_link`` : rattachement
    absent (``microsoft_required``), possession non confirmée
    (``ownership_missing``), vérification périmée (``microsoft_expired``, quand
    ``expires_at`` est dépassé). ``banned`` sort de ``auth_ban``.

    ``email_unverified`` n'est jamais renvoyé : la base du site ne porte aucune
    colonne de vérification d'adresse. Le jour où elle en aura une, c'est ici
    qu'il faudra brancher la règle, avec une source de vérité réelle plutôt
    qu'un drapeau de configuration qui bloquerait tout le monde.
    """
    config = settings or get_settings()
    return user.blocked_reason(microsoft_required=microsoft_required(config), now=now)


def can_play(
    user: User,
    *,
    settings: Settings | None = None,
    now: datetime | None = None,
) -> bool:
    """Valeur que le launcher regarde pour activer le bouton JOUER."""
    return blocked_reason(user, settings=settings, now=now) is None


async def count_iles_tenues(session: AsyncSession, equipage: str | None) -> int:
    """Nombre d'îles tenues par un équipage (« 3 îles tenues » du sous-titre).

    Le lien entre un joueur et son équipage est **textuel** dans la base du
    site : ``users.equipage`` porte le nom, ``equipages.nom`` le porte aussi, et
    ``iles.equipage_id`` pointe sur ``equipages.id``. On joint donc sur le nom,
    faute de clé étrangère — c'est le schéma du site, pas un choix de notre part.

    La comparaison est **tolérante** : minuscules et bords rognés des deux
    côtés. Sans cela, un « les cœurs brisés » saisi côté ``users`` ne
    rejoindrait pas le « Les Cœurs Brisés » de la table ``equipages``, et le
    même écran afficherait « 0 île tenue » dans le bandeau du compte et « 3 îles
    tenues » dans le volet PERSONNAGE. C'est cette fonction qui fait foi : tout
    autre comptage d'îles doit l'appeler plutôt que refaire la jointure.

    Un joueur sans équipage ne déclenche aucune requête : il tient zéro île.
    """
    name = (equipage or "").strip()
    if not name:
        return 0
    total = await session.scalar(
        select(func.count(Ile.id))
        .select_from(Ile)
        .join(Equipage, Ile.equipage_id == Equipage.id)
        .where(func.lower(func.trim(Equipage.nom)) == name.lower())
    )
    return int(total or 0)


def active_skin(user: User) -> SkinOut | None:
    """Apparence active du joueur, ou ``None`` s'il porte le skin par défaut.

    Lit l'association ``user_texture`` déjà chargée avec le compte (les deux
    relations sont en ``selectin``) : aucune requête supplémentaire n'est émise.
    ``url`` est relative à ``OPM_PUBLIC_URL``, comme le reste de l'API.
    """
    link = user.active_texture(TextureKind.SKIN.value)
    if link is None or link.texture is None:
        return None

    texture = link.texture
    # Une valeur inattendue en base ne doit pas faire échouer la sérialisation
    # du compte : on préfère taire le modèle plutôt que renvoyer une erreur 500.
    known_models = {item.value for item in TextureModel}
    model = texture.model if texture.model in known_models else None
    return SkinOut(url=texture.relative_url, sha256=texture.sha256, model=model)


def serialize(
    user: User,
    *,
    iles_tenues: int = 0,
    settings: Settings | None = None,
    now: datetime | None = None,
) -> UserOut:
    """Vue complète d'un compte pour le launcher — **mappage pur, sans base**.

    ``iles_tenues`` doit être fourni par l'appelant : c'est une requête, et une
    fonction de sérialisation n'a pas à en émettre. Utilisez plutôt
    :func:`serialize_with_profile`, qui s'en charge.
    """
    config = settings or get_settings()
    return UserOut.from_user(
        user,
        microsoft_required=microsoft_required(config),
        iles_tenues=iles_tenues,
        skin=active_skin(user),
        now=now,
    )


async def serialize_with_profile(
    session: AsyncSession,
    user: User,
    *,
    settings: Settings | None = None,
    now: datetime | None = None,
) -> UserOut:
    """Vue complète d'un compte, îles tenues comprises.

    C'est la forme qu'attendent tous les endpoints qui renvoient un ``user``
    (``docs/API.md`` §1.2 et §1.3).
    """
    return serialize(
        user,
        iles_tenues=await count_iles_tenues(session, user.equipage),
        settings=settings,
        now=now,
    )


# --------------------------------------------------------------------------- #
# Création de compte
# --------------------------------------------------------------------------- #


def _reject_weak_password(password: str, *, email: str, username: str) -> None:
    """Applique la politique de robustesse, en français et en détail."""
    try:
        check_password_strength(password, email=email, username=username)
    except WeakPasswordError as exc:
        raise ApiError(
            "weak_password",
            "Ce mot de passe est trop faible.",
            status_code=400,
            details={"reasons": list(exc.reasons)},
        ) from exc


def _raise_taken(existing: User, *, email: str) -> NoReturn:
    """Traduit un conflit d'unicité en erreur normalisée.

    ``existing`` est la ligne qui bloque : si c'est son adresse qui coïncide,
    l'adresse est prise ; sinon c'est le pseudonyme.

    Sur l'anti-énumération : ``docs/API.md`` §3 impose les codes ``email_taken``
    et ``username_taken``, et le launcher en a besoin pour dire au joueur quel
    champ corriger. Le compromis retenu est donc celui-ci — le code est rendu,
    mais l'énumération reste impraticable :

    * le mot de passe est haché **avant** ce test, donc la réponse prend le même
      temps que l'adresse existe ou non ;
    * l'inscription est limitée à 3 tentatives par heure et par IP
      (``docs/API.md`` §4.4), ce qui interdit tout balayage ;
    * le message ne dit rien de plus que le code.
    """
    if normalize_email(existing.email) == email:
        raise ApiError(
            "email_taken",
            "Un compte existe déjà avec cette adresse e-mail.",
            status_code=409,
        )
    raise ApiError(
        "username_taken",
        "Ce pseudonyme est déjà pris.",
        status_code=409,
    )


async def create_user(
    session: AsyncSession,
    *,
    email: str,
    username: str,
    password: str,
    ip: str | None = None,
    user_agent: str | None = None,
) -> User:
    """Crée un compte OPM — c'est-à-dire une ligne ``users`` du site.

    L'empreinte est calculée **avant** la vérification d'unicité : le temps de
    réponse est ainsi le même que le compte existe ou non, ce qui prive un
    attaquant du canal temporel d'énumération.

    Toutes les colonnes ``NOT NULL`` de ``users`` sont renseignées
    (:data:`NEW_ACCOUNT_DEFAULTS`), sans quoi PostgreSQL refuserait l'``INSERT``.
    ``datejoin`` reçoit l'instant courant ; ``derniereconnexion`` reste à
    ``NULL`` jusqu'à la première connexion.

    :raises ApiError: 403 ``registration_closed``, 400 ``weak_password``,
        409 ``email_taken`` ou ``username_taken``.
    """
    settings = get_settings()
    if not settings.registration_open:
        raise ApiError(
            "registration_closed",
            "Les inscriptions sont momentanément fermées.",
            status_code=403,
        )

    normalized_email = normalize_email(email)
    normalized_username = normalize_username(username)

    _reject_weak_password(password, email=normalized_email, username=normalized_username)
    password_hash = await _hash_password(password)

    existing = await session.scalar(
        select(User).where(
            or_(
                func.lower(User.email) == normalized_email,
                func.lower(User.name) == normalized_username.lower(),
            )
        )
    )
    if existing is not None:
        _raise_taken(existing, email=normalized_email)

    user = User(
        name=normalized_username,
        email=normalized_email,
        password_hash=password_hash,
        datejoin=utcnow(),
        **NEW_ACCOUNT_DEFAULTS,
    )
    session.add(user)
    try:
        await session.flush()
    except IntegrityError as exc:
        # Deux inscriptions simultanées sur la même adresse : la contrainte
        # d'unicité du site tranche, on traduit le conflit dans le langage de
        # l'API sans chercher à savoir laquelle des deux colonnes a cédé.
        await session.rollback()
        raise ApiError(
            "email_taken",
            "Un compte existe déjà avec ces informations.",
            status_code=409,
        ) from exc

    # Recharge les relations chargées en « selectin » (rattachement Microsoft,
    # sanctions, 2FA, textures) : sans cela, calculer can_play sur un objet tout
    # neuf déclencherait une lecture différée, interdite en contexte asynchrone.
    await session.refresh(user)

    await audit.record(
        session,
        AuditAction.REGISTER,
        user_id=user.id,
        ip=ip,
        user_agent=user_agent,
        meta={"username": user.name},
    )
    await session.commit()
    logger.info("Nouveau compte OPM créé : %s", user.id)
    return user


# --------------------------------------------------------------------------- #
# Authentification
# --------------------------------------------------------------------------- #


def _seal_totp_secret(secret: str, user_id: int) -> tuple[bytes, bytes]:
    """Chiffre un secret TOTP et le découpe pour les deux colonnes de ``auth_totp``.

    ``opm_auth.security.crypto`` produit une enveloppe unique
    ``base64url(version || nonce || chiffré+tag)``. Le schéma de
    ``docs/DATA.md`` §2 range, lui, le nonce dans sa propre colonne ``bytea``.
    On sépare donc les deux morceaux plutôt que de recopier le nonce à deux
    endroits : ``secret_enc`` garde l'octet de version **et** le chiffré, ce qui
    laisse la porte ouverte à un changement d'algorithme.

    :return: ``(secret_enc, nonce)``, prêts pour :class:`~opm_auth.models.Totp`.
    """
    raw = b64u_decode(encrypt_totp_secret(secret, str(user_id)))
    return raw[:1] + raw[1 + NONCE_SIZE :], raw[1 : 1 + NONCE_SIZE]


def _open_totp_secret(row: Totp, user_id: int) -> str | None:
    """Recompose puis déchiffre le secret TOTP, ou ``None`` s'il est illisible.

    Un secret illisible (clé changée, ligne altérée) ne doit pas provoquer
    d'erreur 500 au milieu d'une connexion : on journalise et on refuse le
    second facteur, ce qui laisse la porte des codes de secours ouverte.
    """
    try:
        sealed = bytes(row.secret_enc)
        envelope = b64u_encode(sealed[:1] + bytes(row.nonce) + sealed[1:])
        return decrypt_totp_secret(envelope, str(user_id))
    except (CryptoError, ValueError, TypeError):
        logger.error("Secret TOTP illisible pour le compte %s.", user_id)
        return None


def _totp_secret(user: User) -> str | None:
    """Secret TOTP en clair du compte, ou ``None`` s'il n'y en a pas."""
    row = user.totp
    if row is None:
        return None
    return _open_totp_secret(row, user.id)


async def _consume_second_factor(
    session: AsyncSession,
    user: User,
    code: str,
    *,
    ip: str | None,
    user_agent: str | None,
) -> bool:
    """Valide un code TOTP ou, à défaut, un code de secours à usage unique.

    Un code de secours accepté est immédiatement marqué comme consommé
    (``auth_recovery_code.used_at``) : il ne peut servir qu'une fois, c'est
    toute sa raison d'être.
    """
    secret = _totp_secret(user)
    if secret and verify_totp(secret, code):
        return True

    unused = list(
        await session.scalars(
            select(RecoveryCode)
            .where(RecoveryCode.user_id == user.id, RecoveryCode.used_at.is_(None))
            .order_by(RecoveryCode.id)
        )
    )
    if not unused:
        return False

    index = await _verify_recovery_code(code, [entry.code_hash for entry in unused])
    if index is None:
        return False

    unused[index].used_at = utcnow()
    await audit.record(
        session,
        AuditAction.RECOVERY_CODE_USED,
        user_id=user.id,
        ip=ip,
        user_agent=user_agent,
        meta={"remaining": len(unused) - 1},
    )
    logger.info("Code de secours consommé pour le compte %s.", user.id)
    return True


async def _login_failure(
    session: AsyncSession,
    *,
    reason: str,
    user_id: int | None,
    ip: str | None,
    user_agent: str | None,
    error: ApiError,
) -> ApiError:
    """Consigne un échec de connexion, valide le journal et rend l'erreur à lever.

    Le ``commit`` est délibéré : la trace d'un échec doit survivre au rejet de
    la requête, sinon la détection d'attaque par force brute perd sa mémoire.
    S'utilise sous la forme ``raise await _login_failure(...)``.
    """
    await audit.record(
        session,
        AuditAction.LOGIN_FAILED,
        user_id=user_id,
        ip=ip,
        user_agent=user_agent,
        meta={"reason": reason},
    )
    await session.commit()
    return error


async def authenticate(
    session: AsyncSession,
    *,
    email: str,
    password: str,
    totp: str | None = None,
    ip: str | None = None,
    user_agent: str | None = None,
) -> User:
    """Vérifie des identifiants et rend le compte correspondant.

    Ordre imposé : mot de passe d'abord, second facteur ensuite. Tant que le
    mot de passe est faux, l'API ne dit jamais si la 2FA est active — sinon
    elle confirmerait l'existence du compte.

    **Renforcement transparent de l'empreinte** : si l'empreinte stockée n'est
    pas au format canonique ``pbkdf2:sha256`` à ``OPM_PASSWORD_ITERATIONS``
    itérations (typiquement les ``pbkdf2:sha256:260000`` écrits par Werkzeug <
    2.3 côté site), elle est recalculée et réécrite ici même. Le format reste du
    Werkzeug : le site continue de vérifier le mot de passe sans une ligne de
    code à changer, et le parc se durcit tout seul (``docs/DATA.md`` §3). Ce
    recalcul n'a lieu qu'**après** le second facteur : sur un compte 2FA encore
    en 260 000 itérations, une saisie de code ratée ne doit pas coûter une
    demi-seconde de processeur pour un résultat aussitôt jeté.

    Les deux seules colonnes de ``users`` que cette fonction rend « sales » sont
    ``derniereconnexion`` et, le cas échéant, ``password_hash`` : le ``UPDATE``
    émis au ``commit`` ne touchera rien d'autre.

    La transaction reste ouverte en cas de succès : l'appelant (:func:`login`)
    émet les jetons puis valide le tout d'un bloc.

    :raises ApiError: 401 ``invalid_credentials``, ``totp_required`` ou
        ``totp_invalid`` ; 429 ``rate_limited``.
    """
    normalized_email = normalize_email(email)
    # Limite par compte visé, appliquée même si l'adresse n'existe pas : sans
    # cela, l'absence de blocage trahirait les adresses inconnues.
    await enforce("auth.login.account", normalized_email)

    user = await get_by_email(session, normalized_email)
    # verify_password consomme le même temps CPU quand l'empreinte est absente :
    # le compte inconnu et le mot de passe faux sont indiscernables.
    valid = await _verify_password(
        user.password_hash if user is not None else None, password
    )

    if user is None or not valid:
        raise await _login_failure(
            session,
            reason="unknown_account" if user is None else "invalid_password",
            user_id=user.id if user is not None else None,
            ip=ip,
            user_agent=user_agent,
            error=invalid_credentials(_INVALID_CREDENTIALS),
        )

    if user.totp_enabled:
        if not totp:
            raise await _login_failure(
                session,
                reason="totp_required",
                user_id=user.id,
                ip=ip,
                user_agent=user_agent,
                error=ApiError(
                    "totp_required",
                    "Saisissez le code de votre application d'authentification.",
                    status_code=401,
                ),
            )
        await enforce("auth.totp.account", str(user.id))
        if not await _consume_second_factor(
            session, user, totp, ip=ip, user_agent=user_agent
        ):
            raise await _login_failure(
                session,
                reason="totp_invalid",
                user_id=user.id,
                ip=ip,
                user_agent=user_agent,
                error=ApiError(
                    "totp_invalid",
                    "Ce code de double authentification est incorrect.",
                    status_code=401,
                ),
            )

    # Renforcement transparent : calculé seulement maintenant, une fois le
    # compte pleinement authentifié — et jamais deux fois pour rien.
    if needs_rehash(user.password_hash):
        try:
            user.password_hash = await _hash_password(password)
        except (TypeError, ValueError):  # pragma: no cover - garde-fou
            logger.warning("Renforcement d'empreinte impossible, ancien format gardé.")
        else:
            await audit.record(
                session,
                AuditAction.PASSWORD_REHASH,
                user_id=user.id,
                ip=ip,
                user_agent=user_agent,
            )
            logger.info(
                "Empreinte de mot de passe renforcée pour le compte %s.", user.id
            )

    # La seule écriture « site » de la connexion (docs/DATA.md §4).
    user.derniereconnexion = utcnow()

    await audit.record(
        session,
        AuditAction.LOGIN,
        user_id=user.id,
        ip=ip,
        user_agent=user_agent,
        meta={"totp": user.totp_enabled},
    )
    return user


async def login(
    session: AsyncSession,
    *,
    email: str,
    password: str,
    totp: str | None = None,
    ip: str | None = None,
    user_agent: str | None = None,
) -> tuple[User, TokenPairOut]:
    """Authentifie puis ouvre une session : c'est ce qu'appelle ``POST /auth/login``."""
    user = await authenticate(
        session,
        email=email,
        password=password,
        totp=totp,
        ip=ip,
        user_agent=user_agent,
    )
    pair = await issue_tokens(session, user, user_agent=user_agent)
    return user, pair


# --------------------------------------------------------------------------- #
# Sessions du launcher (refresh_token rotatif)
# --------------------------------------------------------------------------- #


def _device_label(user_agent: str | None) -> str | None:
    """Étiquette d'appareil rangée dans ``auth_refresh_token.device_label``.

    On garde le ``User-Agent`` tronqué : c'est ce qui permettra un jour d'offrir
    au joueur la liste de ses sessions ouvertes. Aucune adresse IP n'est stockée
    ici — la table n'a pas de colonne pour ça, et le journal d'audit en garde
    déjà une empreinte.
    """
    cleaned = (user_agent or "").strip()
    return cleaned[:_DEVICE_LABEL_LENGTH] or None


@dataclass(frozen=True, slots=True)
class _RotationView:
    """Vue d'un ``auth_refresh_token`` telle que ``security.tokens`` l'attend.

    ``security.tokens.rotate_refresh_token`` raisonne sur un ``used_at`` ; notre
    table, elle, marque la consommation par ``replaced_by`` (le successeur) et
    ``revoked_at``. Cette vue fait la traduction, ce qui évite de dupliquer la
    logique de décision — la détection de rejeu vit à un seul endroit.
    """

    family_id: str
    expires_at: datetime
    revoked_at: datetime | None
    used_at: datetime | None


def _rotation_view(record: RefreshToken | None) -> _RotationView | None:
    """Traduit une ligne ``auth_refresh_token`` en :class:`_RotationView`."""
    if record is None:
        return None
    return _RotationView(
        family_id=record.family_id.hex,
        expires_at=record.expires_at,
        # Un jeton déjà remplacé a servi : c'est ce qui trahit un rejeu.
        used_at=record.revoked_at if record.replaced_by is not None else None,
        revoked_at=record.revoked_at,
    )


async def issue_tokens(
    session: AsyncSession,
    user: User,
    *,
    user_agent: str | None = None,
    family_id: uuid.UUID | None = None,
) -> TokenPairOut:
    """Émet un couple ``access_token`` / ``refresh_token`` et valide la transaction.

    Le ``refresh_token`` en clair n'existe qu'ici : la base n'en garde que
    l'empreinte SHA-256 (``docs/API.md`` §4.3).

    :param family_id: famille à prolonger lors d'une rotation ; ``None`` ouvre
        une nouvelle famille (nouvelle connexion, donc nouvel appareil).
    """
    settings = get_settings()
    fresh = new_refresh_token(family_id=family_id.hex if family_id else None)
    session.add(
        RefreshToken(
            user_id=user.id,
            token_hash=fresh.token_hash,
            family_id=uuid.UUID(fresh.family_id),
            device_label=_device_label(user_agent),
            expires_at=fresh.expires_at,
        )
    )
    await session.commit()

    return TokenPairOut(
        access_token=create_access_token(str(user.id)),
        refresh_token=fresh.token,
        expires_in=int(settings.access_ttl.total_seconds()),
    )


async def _revoke_family(session: AsyncSession, family_id: uuid.UUID) -> None:
    """Révoque tous les jetons encore vivants d'une famille.

    Le motif n'est pas stocké : ``auth_refresh_token`` n'a pas de colonne pour
    ça (``docs/DATA.md`` §2). Il vit dans le journal d'audit, où l'appelant
    l'écrit avec l'IP et l'appareil.
    """
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.family_id == family_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=utcnow())
    )


async def _revoke_all_sessions(session: AsyncSession, user_id: int) -> None:
    """Coupe **toutes** les sessions d'un compte : launcher et jeu.

    Deux tables, parce qu'il y a deux durées de vie :

    * ``auth_refresh_token`` — les sessions du launcher, jusqu'à 30 jours ;
    * ``ygg_session`` — les sessions de jeu que nous signons, valables 24 h.
      ``resolve_session`` ne regarde que cette table et l'échéance : sans cette
      seconde instruction, un compte repris par « mot de passe oublié »
      laisserait l'attaquant connecté au serveur Minecraft une journée entière,
      alors même que le joueur légitime a repris la main.

    L'``access_token`` d'API, lui, vit 15 minutes et n'a pas d'état en base :
    c'est le seul reliquat, et il est borné par sa propre durée de vie.
    """
    moment = utcnow()
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=moment)
    )
    await session.execute(
        update(YggSession)
        .where(YggSession.user_id == user_id, YggSession.invalidated_at.is_(None))
        .values(invalidated_at=moment)
    )


async def rotate_session(
    session: AsyncSession,
    *,
    refresh_token: str,
    ip: str | None = None,
    user_agent: str | None = None,
) -> tuple[User, TokenPairOut]:
    """Échange un ``refresh_token`` contre un couple neuf, avec rotation stricte.

    Le jeton présenté est consommé et remplacé : il reçoit ``revoked_at`` et
    ``replaced_by``. S'il avait déjà servi, c'est qu'il a été volé — ou que le
    client légitime a été doublé : la famille entière est révoquée, l'incident
    est consigné, et le porteur doit se reconnecter (``docs/API.md`` §4.3).

    La ligne est lue **avec verrou** (``SELECT … FOR UPDATE``) et le verrou tient
    jusqu'au ``commit``. Sans lui, deux présentations simultanées du même jeton
    verraient toutes deux ``revoked_at`` à ``NULL``, seraient toutes deux
    acceptées, et le rejeu — précisément ce que la rotation existe pour détecter
    — passerait inaperçu. Sur SQLite (tests), ``with_for_update`` est ignoré
    sans erreur.

    :raises ApiError: 401 ``token_revoked``.
    """
    record = await session.scalar(
        select(RefreshToken)
        .where(RefreshToken.token_hash == hash_refresh_token(refresh_token))
        .with_for_update()
    )
    outcome = rotate_refresh_token(_rotation_view(record))

    if not outcome.accepted:
        if record is not None and outcome.revoke_family:
            await _revoke_family(session, record.family_id)
            await audit.record(
                session,
                AuditAction.TOKEN_REPLAY,
                user_id=record.user_id,
                ip=ip,
                user_agent=user_agent,
                meta={
                    "token_outcome": outcome.outcome.value,
                    "token_family": record.family_id.hex,
                },
            )
            logger.warning(
                "Rejeu de refresh_token détecté (compte %s) : famille %s révoquée.",
                record.user_id,
                record.family_id.hex,
            )
        await session.commit()
        raise ApiError("token_revoked", _SESSION_LOST, status_code=401)

    assert record is not None and outcome.replacement is not None  # garanti ci-dessus

    user = await session.get(User, record.user_id)
    if user is None:
        # Compte supprimé alors qu'une session vivait encore.
        await _revoke_family(session, record.family_id)
        await session.commit()
        raise ApiError("token_revoked", _SESSION_LOST, status_code=401)

    replacement = outcome.replacement
    successor = RefreshToken(
        user_id=user.id,
        token_hash=replacement.token_hash,
        family_id=record.family_id,
        device_label=_device_label(user_agent) or record.device_label,
        expires_at=replacement.expires_at,
    )
    session.add(successor)
    await session.flush()

    record.revoked_at = utcnow()
    record.replaced_by = successor.id

    await audit.record(
        session,
        AuditAction.TOKEN_REFRESH,
        user_id=user.id,
        ip=ip,
        user_agent=user_agent,
        meta={"token_family": record.family_id.hex},
    )
    await session.commit()

    settings = get_settings()
    return user, TokenPairOut(
        access_token=create_access_token(str(user.id)),
        refresh_token=replacement.token,
        expires_in=int(settings.access_ttl.total_seconds()),
    )


async def logout(
    session: AsyncSession,
    *,
    refresh_token: str,
    ip: str | None = None,
    user_agent: str | None = None,
) -> None:
    """Ferme la session portée par ce ``refresh_token``.

    Toute la famille est révoquée : se déconnecter d'un appareil ferme la
    chaîne de rotations née de cette connexion, et rien d'autre. L'opération
    est idempotente — un jeton inconnu ne provoque pas d'erreur, pour ne pas
    transformer la déconnexion en oracle.
    """
    record = await session.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(refresh_token))
    )
    if record is not None:
        await _revoke_family(session, record.family_id)
        await audit.record(
            session,
            AuditAction.LOGOUT,
            user_id=record.user_id,
            ip=ip,
            user_agent=user_agent,
            meta={"token_family": record.family_id.hex},
        )
    await session.commit()


# --------------------------------------------------------------------------- #
# Temps de jeu
# --------------------------------------------------------------------------- #


#: Message unique des fins de session de jeu refusées. Volontairement le même
#: pour « aucune session ouverte » et « session déjà clôturée » : un launcher
#: modifié n'a pas à savoir laquelle des deux barrières l'a arrêté.
_NO_OPEN_GAME_SESSION = (
    "Aucune session de jeu ouverte ne correspond à ce launcher : "
    "le temps de jeu n'a pas été enregistré."
)


async def add_playtime(
    session: AsyncSession,
    user_id: int,
    seconds: int,
    *,
    client_token: str | None,
    now: datetime | None = None,
    ip: str | None = None,
    user_agent: str | None = None,
) -> int:
    """Clôture une session de jeu et crédite sa durée dans ``users.tempsdejeu``.

    ``users.tempsdejeu`` est une colonne du **site** : elle s'affiche sur
    onepieceminecraft.fr et sert de base à des récompenses. C'est l'une des deux
    seules colonnes de ``users`` que ``docs/DATA.md`` §4 nous autorise à écrire,
    et la seule dont la valeur soit fournie par le client. Elle mérite donc
    trois verrous, et non la parole du launcher :

    1. **une session réelle** — la durée est rattachée à une ligne
       ``ygg_session`` encore ouverte (même compte, même ``clientToken``). Une
       fin de session sans début n'existe pas ;
    2. **plafonnée au temps écoulé** — on ne crédite jamais plus que
       ``min(maintenant, expires_at) - issued_at``. Un jeton de session émis il y
       a douze minutes ne peut pas avoir servi vingt-quatre heures, et une
       session périmée ne compte plus au-delà de sa péremption ;
    3. **non rejouable** — la clôture est un ``UPDATE`` conditionnel sur
       ``invalidated_at IS NULL``. Seul le premier appel voit une ligne
       modifiée ; les suivants, y compris deux appels simultanés, sont refusés.
       Rejouer la requête n'ajoute donc pas une seconde.

    L'incrément lui-même reste **une** instruction atomique
    (``tempsdejeu = tempsdejeu + :durée``) : jamais de lire-puis-écrire, car le
    serveur Minecraft et le site écrivent parfois au même instant et une
    addition perdue serait du temps de jeu volé au joueur.

    :param seconds: durée annoncée par le launcher, en secondes. Négative ou
        nulle, elle ne crédite rien — mais la session est tout de même clôturée.
    :param client_token: ``clientToken`` de la session à clôturer. Obligatoire :
        c'est lui qui désigne la session, et donc le plafond.
    :return: le nombre de secondes réellement créditées.
    :raises ApiError: 400 ``game_session_unknown`` — aucune session ouverte ne
        correspond, ou elle vient d'être clôturée.
    """
    moment = now or utcnow()
    token = (client_token or "").strip()
    if not token:
        raise ApiError("game_session_unknown", _NO_OPEN_GAME_SESSION, status_code=400)

    row = await session.scalar(
        select(YggSession)
        .where(
            YggSession.user_id == user_id,
            YggSession.client_token == token,
            YggSession.invalidated_at.is_(None),
        )
        .order_by(YggSession.issued_at.desc())
        .limit(1)
        .with_for_update()
    )
    if row is None:
        logger.warning(
            "Fin de session de jeu sans session ouverte (compte %s) : refusée.",
            user_id,
        )
        raise ApiError("game_session_unknown", _NO_OPEN_GAME_SESSION, status_code=400)

    claimed = max(0, int(seconds or 0))
    # Fenêtre réellement jouable : de l'émission du jeton à maintenant, sans
    # jamais dépasser sa péremption.
    window = int((min(moment, row.expires_at) - row.issued_at).total_seconds())
    credited = max(0, min(claimed, window))

    # Clôture conditionnelle : c'est elle qui rend l'opération non rejouable.
    closed = await session.execute(
        update(YggSession)
        .where(YggSession.id == row.id, YggSession.invalidated_at.is_(None))
        .values(invalidated_at=moment)
        .execution_options(synchronize_session=False)
    )
    if closed.rowcount != 1:
        # Deux fermetures simultanées : l'autre a gagné, celle-ci ne crédite
        # rien. Aucune ligne n'a été modifiée, il n'y a donc rien à défaire —
        # la transaction est laissée à l'appelant, qui peut avoir son propre
        # travail en cours.
        raise ApiError("game_session_unknown", _NO_OPEN_GAME_SESSION, status_code=400)

    if credited:
        await session.execute(
            update(User)
            .where(User.id == user_id)
            .values(tempsdejeu=func.coalesce(User.tempsdejeu, 0) + credited)
            .execution_options(synchronize_session=False)
        )

    await audit.record(
        session,
        AuditAction.GAME_SESSION_END,
        user_id=user_id,
        ip=ip,
        user_agent=user_agent,
        meta={"claimed_s": claimed, "credited_s": credited, "window_s": window},
    )
    await session.commit()

    if credited < claimed:
        logger.warning(
            "Temps de jeu annoncé (%d s) supérieur à la session du compte %s "
            "(%d s) : ramené au temps écoulé.",
            claimed,
            user_id,
            window,
        )
    logger.info("Temps de jeu du compte %s augmenté de %d s.", user_id, credited)
    return credited


# --------------------------------------------------------------------------- #
# Mot de passe oublié
# --------------------------------------------------------------------------- #

#: Signature du transporteur du lien de réinitialisation : il reçoit le compte,
#: le jeton en clair et sa date d'expiration.
PasswordResetSender = Callable[[User, str, datetime], Awaitable[None]]

_reset_sender: PasswordResetSender | None = None


def set_password_reset_sender(sender: PasswordResetSender | None) -> None:
    """Branche le transporteur du lien de réinitialisation.

    La couche d'envoi (courriel) l'installe au démarrage de l'application ; les
    tests y branchent une capture. Tant que rien n'est branché, le jeton est
    généré et enregistré mais n'est remis à personne — et surtout pas au
    journal, où un jeton en clair n'a rien à faire (``docs/API.md`` §4.8).
    """
    global _reset_sender
    _reset_sender = sender


async def _deliver_reset(user: User, token: str, expires_at: datetime) -> None:
    """Remet le lien de réinitialisation, si un transporteur est branché."""
    if _reset_sender is None:
        logger.warning(
            "Aucun transporteur de courriel n'est branché : le lien de "
            "réinitialisation du compte %s n'a pas été remis.",
            user.id,
        )
        return
    await _reset_sender(user, token, expires_at)


async def request_password_reset(
    session: AsyncSession,
    *,
    email: str,
    ip: str | None = None,
    user_agent: str | None = None,
) -> None:
    """Prépare une réinitialisation de mot de passe.

    Ne lève jamais d'erreur liée à l'existence du compte : le routeur répond
    ``202`` dans tous les cas (``docs/API.md`` §4.6). Une éventuelle demande en
    attente est invalidée, de sorte qu'un seul lien vive à la fois.
    """
    normalized_email = normalize_email(email)
    await enforce("auth.password.forgot.account", normalized_email)

    user = await get_by_email(session, normalized_email)
    if user is None:
        logger.info("Demande de réinitialisation pour une adresse inconnue, ignorée.")
        return

    now = utcnow()
    await session.execute(
        update(PasswordReset)
        .where(PasswordReset.user_id == user.id, PasswordReset.used_at.is_(None))
        .values(used_at=now)
    )

    token = create_password_reset_token(str(user.id))
    expires_at = now + password_reset_ttl()
    session.add(
        PasswordReset(
            user_id=user.id,
            token_hash=sha256_hex(token),
            expires_at=expires_at,
        )
    )
    await audit.record(
        session,
        AuditAction.PASSWORD_FORGOT,
        user_id=user.id,
        ip=ip,
        user_agent=user_agent,
    )
    await session.commit()

    await _deliver_reset(user, token, expires_at)


async def reset_password(
    session: AsyncSession,
    *,
    token: str,
    password: str,
    ip: str | None = None,
    user_agent: str | None = None,
) -> None:
    """Change le mot de passe à partir du jeton reçu par courriel.

    Le jeton est à usage unique : sa consommation est marquée en base, ce qui
    interdit le rejeu même s'il est cryptographiquement encore valide. Toutes
    les sessions du compte sont coupées — celles du launcher **et** les sessions
    de jeu Yggdrasil : si le mot de passe a été réinitialisé, c'est peut-être
    qu'il avait fuité, et un intrus resté dans le jeu pendant 24 h ferait de
    cette réinitialisation une fausse promesse.

    La nouvelle empreinte est écrite au format Werkzeug : le joueur peut se
    reconnecter au site dans la foulée (``docs/DATA.md`` §3).

    :raises ApiError: 401 ``invalid_credentials`` (jeton invalide, expiré ou
        déjà utilisé), 400 ``weak_password``.
    """
    error = invalid_credentials("Ce lien de réinitialisation est invalide ou expiré.")

    try:
        claims = decode_password_reset_token(token)
        subject = int(claims.subject)
    except (TokenError, TypeError, ValueError) as exc:
        raise error from exc

    record = await session.scalar(
        select(PasswordReset).where(PasswordReset.token_hash == sha256_hex(token))
    )
    if record is None or not record.is_active() or record.user_id != subject:
        raise error

    user = await session.get(User, record.user_id)
    if user is None:
        raise error

    _reject_weak_password(password, email=user.email, username=user.name)

    user.password_hash = await _hash_password(password)
    record.used_at = utcnow()
    await _revoke_all_sessions(session, user.id)
    await audit.record(
        session,
        AuditAction.PASSWORD_RESET,
        user_id=user.id,
        ip=ip,
        user_agent=user_agent,
    )
    await session.commit()
    logger.info("Mot de passe réinitialisé pour le compte %s.", user.id)


# --------------------------------------------------------------------------- #
# Double authentification
# --------------------------------------------------------------------------- #


async def start_totp_enrollment(
    session: AsyncSession,
    user: User,
    *,
    ip: str | None = None,
    user_agent: str | None = None,
) -> TotpSetupOut:
    """Prépare l'activation de la 2FA : secret, URI ``otpauth`` et codes de secours.

    Le secret est chiffré au repos dans ``auth_totp`` ; la 2FA reste
    **inactive** jusqu'à ce que :func:`confirm_totp` prouve que l'application du
    joueur génère les bons codes. Les anciens codes de secours sont détruits :
    une nouvelle inscription remplace intégralement la précédente.

    :raises ApiError: 409 ``totp_already_enabled``.
    """
    if user.totp_enabled:
        raise ApiError(
            "totp_already_enabled",
            "La double authentification est déjà active sur ce compte.",
            status_code=409,
        )

    settings = get_settings()
    secret = generate_totp_secret()
    secret_enc, nonce = _seal_totp_secret(secret, user.id)

    row = await session.get(Totp, user.id)
    if row is None:
        session.add(
            Totp(
                user_id=user.id,
                secret_enc=secret_enc,
                nonce=nonce,
                enabled=False,
                confirmed_at=None,
            )
        )
    else:
        row.secret_enc = secret_enc
        row.nonce = nonce
        row.enabled = False
        row.confirmed_at = None

    await session.execute(delete(RecoveryCode).where(RecoveryCode.user_id == user.id))
    # Dix dérivations PBKDF2 : hors de la boucle d'évènements, sinon tout le
    # serveur se fige une demi-seconde à chaque activation de la double
    # authentification.
    codes = await generate_recovery_codes_async(settings.recovery_codes_count)
    session.add_all(
        RecoveryCode(user_id=user.id, code_hash=code_hash) for code_hash in codes.hashes
    )

    await audit.record(
        session,
        AuditAction.TOTP_SETUP,
        user_id=user.id,
        ip=ip,
        user_agent=user_agent,
        meta={"recovery_codes": len(codes.codes)},
    )
    await session.commit()
    await session.refresh(user, ["totp"])

    return TotpSetupOut(
        secret=secret,
        otpauth_uri=provisioning_uri(secret, user.email),
        recovery_codes=list(codes.codes),
    )


async def confirm_totp(
    session: AsyncSession,
    user: User,
    *,
    code: str,
    ip: str | None = None,
    user_agent: str | None = None,
) -> None:
    """Active la 2FA après vérification d'un premier code.

    :raises ApiError: 409 ``totp_already_enabled``, 400 ``totp_setup_required``,
        401 ``totp_invalid``.
    """
    if user.totp_enabled:
        raise ApiError(
            "totp_already_enabled",
            "La double authentification est déjà active sur ce compte.",
            status_code=409,
        )
    row = user.totp
    secret = _open_totp_secret(row, user.id) if row is not None else None
    if row is None or secret is None:
        raise ApiError(
            "totp_setup_required",
            "Commencez par générer un secret de double authentification.",
            status_code=400,
        )

    await enforce("auth.totp.account", str(user.id))
    if not verify_totp(secret, code):
        await audit.record(
            session,
            AuditAction.TOTP_ENABLE,
            user_id=user.id,
            ip=ip,
            user_agent=user_agent,
            meta={"reason": "totp_invalid"},
        )
        await session.commit()
        raise ApiError(
            "totp_invalid",
            "Ce code de double authentification est incorrect.",
            status_code=401,
        )

    row.enabled = True
    row.confirmed_at = utcnow()
    await audit.record(
        session,
        AuditAction.TOTP_ENABLE,
        user_id=user.id,
        ip=ip,
        user_agent=user_agent,
    )
    await session.commit()
    await session.refresh(user, ["totp"])


async def disable_totp(
    session: AsyncSession,
    user: User,
    *,
    password: str,
    code: str,
    ip: str | None = None,
    user_agent: str | None = None,
) -> None:
    """Désactive la 2FA : mot de passe **et** second facteur valides exigés.

    Le secret et les codes de secours sont détruits : réactiver la 2FA repart
    d'une inscription neuve.

    :raises ApiError: 409 ``totp_not_enabled``, 401 ``invalid_credentials`` ou
        ``totp_invalid``.
    """
    if not user.totp_enabled:
        raise ApiError(
            "totp_not_enabled",
            "La double authentification n'est pas active sur ce compte.",
            status_code=409,
        )

    await enforce("auth.totp.account", str(user.id))

    if not await _verify_password(user.password_hash, password):
        await audit.record(
            session,
            AuditAction.TOTP_DISABLE,
            user_id=user.id,
            ip=ip,
            user_agent=user_agent,
            meta={"reason": "invalid_password"},
        )
        await session.commit()
        raise invalid_credentials("Mot de passe incorrect.")

    if not await _consume_second_factor(session, user, code, ip=ip, user_agent=user_agent):
        await audit.record(
            session,
            AuditAction.TOTP_DISABLE,
            user_id=user.id,
            ip=ip,
            user_agent=user_agent,
            meta={"reason": "totp_invalid"},
        )
        await session.commit()
        raise ApiError(
            "totp_invalid",
            "Ce code de double authentification est incorrect.",
            status_code=401,
        )

    # Vide la session avant les suppressions : si le second facteur présenté
    # était un code de secours, sa consommation est encore en attente. Sans ce
    # « flush », l'UPDATE partirait après le DELETE et porterait sur une ligne
    # disparue.
    await session.flush()
    await session.execute(delete(RecoveryCode).where(RecoveryCode.user_id == user.id))
    await session.execute(delete(Totp).where(Totp.user_id == user.id))

    await audit.record(
        session,
        AuditAction.TOTP_DISABLE,
        user_id=user.id,
        ip=ip,
        user_agent=user_agent,
    )
    await session.commit()
    await session.refresh(user, ["totp"])
