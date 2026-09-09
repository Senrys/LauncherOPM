"""Jetons : ``access_token`` JWT EdDSA, ``refresh_token`` opaques, jetons Yggdrasil.

Trois familles, à ne jamais confondre (``docs/API.md`` §0) :

===========================  ==========  =============================================
Jeton                        Durée       Rôle
===========================  ==========  =============================================
``access_token``             15 min      API launcher, en-tête ``Authorization: Bearer``
``refresh_token``            30 j        renouvellement, opaque, rotatif
``yggdrasil.accessToken``    24 h        session de jeu, transmise à Minecraft
===========================  ==========  =============================================

Règles appliquées ici :

* signature **EdDSA (Ed25519)** uniquement ; l'algorithme est imposé au décodage,
  donc ``alg: none`` et ``HS256`` sont rejetés d'office ;
* claims obligatoires ``sub``, ``jti``, ``typ``, ``iat``, ``exp`` ;
* le claim ``typ`` cloisonne les usages : un jeton de réinitialisation de mot de
  passe ne peut pas servir d'``access_token``, même signé par la même clé ;
* les ``refresh_token`` sont des secrets opaques de 64 octets, stockés hachés en
  SHA-256, tournés à chaque usage, avec détection de rejeu.
"""

from __future__ import annotations

import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Mapping, Protocol

import jwt
from jwt import InvalidTokenError
from jwt.exceptions import ExpiredSignatureError

from opm_auth.security import setting
from opm_auth.security.crypto import b64u_encode, constant_time_equals, sha256_hex
from opm_auth.security.keys import (
    ed25519_key_id,
    ed25519_private_key,
    ed25519_public_key,
)

__all__ = [
    "NewRefreshToken",
    "RefreshOutcome",
    "RefreshRecord",
    "RotationResult",
    "TokenClaims",
    "TokenError",
    "TokenExpired",
    "TokenInvalid",
    "TokenTypeMismatch",
    "TYPE_ACCESS",
    "TYPE_PASSWORD_RESET",
    "TYPE_YGGDRASIL",
    "access_token_ttl",
    "create_access_token",
    "create_password_reset_token",
    "create_yggdrasil_token",
    "decode_access_token",
    "decode_password_reset_token",
    "decode_yggdrasil_token",
    "hash_refresh_token",
    "new_client_token",
    "new_refresh_token",
    "refresh_token_ttl",
    "rotate_refresh_token",
    "verify_refresh_token",
    "yggdrasil_token_ttl",
]

#: Seul algorithme accepté, à l'émission comme à la vérification.
ALGORITHM = "EdDSA"

#: Valeurs du claim ``typ``.
TYPE_ACCESS = "access"
TYPE_YGGDRASIL = "yggdrasil"
TYPE_PASSWORD_RESET = "reset"

#: Taille du secret opaque d'un ``refresh_token`` (512 bits).
REFRESH_TOKEN_BYTES = 64


# --------------------------------------------------------------------------- #
# Erreurs
# --------------------------------------------------------------------------- #


class TokenError(Exception):
    """Erreur générique de jeton.

    :cvar api_code: code d'erreur normalisé de ``docs/API.md`` §3 associé.
    """

    api_code = "invalid_credentials"


class TokenInvalid(TokenError):
    """Jeton illisible, mal signé ou dont un claim obligatoire manque."""

    api_code = "invalid_credentials"


class TokenExpired(TokenError):
    """Jeton expiré : le client doit rafraîchir sa session."""

    api_code = "token_expired"


class TokenTypeMismatch(TokenInvalid):
    """Jeton valide mais présenté hors de son usage prévu."""


# --------------------------------------------------------------------------- #
# Réglages
# --------------------------------------------------------------------------- #


def issuer() -> str:
    """Émetteur déclaré dans le claim ``iss`` : l'URL publique du serveur."""
    return setting("jwt_issuer", setting("public_url", "http://127.0.0.1:8000"))


def api_audience() -> str:
    """Audience des jetons de l'API launcher."""
    return setting("jwt_audience", "opm-launcher")


def game_audience() -> str:
    """Audience des jetons de session de jeu (Yggdrasil).

    Audience distincte de celle de l'API : même signés par la même clé, les
    deux jetons ne sont jamais interchangeables.
    """
    return setting("jwt_game_audience", "opm-minecraft")


def _leeway() -> timedelta:
    """Tolérance de dérive d'horloge acceptée à la vérification."""
    return timedelta(seconds=setting("jwt_leeway_seconds", 5))


def access_token_ttl() -> timedelta:
    """Durée de vie d'un ``access_token`` (``OPM_ACCESS_TTL_MINUTES``, 15 min)."""
    return setting("access_ttl", timedelta(minutes=setting("access_ttl_minutes", 15)))


def refresh_token_ttl() -> timedelta:
    """Durée de vie d'un ``refresh_token`` (``OPM_REFRESH_TTL_DAYS``, 30 j)."""
    return setting("refresh_ttl", timedelta(days=setting("refresh_ttl_days", 30)))


def yggdrasil_token_ttl() -> timedelta:
    """Durée de vie d'une session de jeu (``OPM_YGG_TTL_HOURS``, 24 h)."""
    return setting("ygg_ttl", timedelta(hours=setting("ygg_ttl_hours", 24)))


def password_reset_ttl() -> timedelta:
    """Durée de vie d'un lien de réinitialisation (``OPM_PASSWORD_RESET_TTL_MINUTES``)."""
    return setting(
        "password_reset_ttl",
        timedelta(minutes=setting("password_reset_ttl_minutes", 30)),
    )


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# JWT signés
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class TokenClaims:
    """Contenu vérifié d'un jeton signé."""

    subject: str
    token_id: str
    typ: str
    issued_at: datetime
    expires_at: datetime
    scopes: tuple[str, ...]
    raw: Mapping[str, Any]

    def get(self, name: str, default: Any = None) -> Any:
        """Accès direct à un claim additionnel (``name``, ``cid``…)."""
        return self.raw.get(name, default)


def _encode(
    *,
    subject: str,
    typ: str,
    ttl: timedelta,
    audience: str,
    scopes: tuple[str, ...] = (),
    extra: Mapping[str, Any] | None = None,
) -> str:
    """Fabrique un JWT EdDSA avec les claims obligatoires du projet."""
    if not subject:
        raise ValueError("Le sujet du jeton (sub) est obligatoire.")
    issued_at = _now()
    payload: dict[str, Any] = {
        "iss": issuer(),
        "aud": audience,
        "sub": str(subject),
        "jti": uuid.uuid4().hex,
        "typ": typ,
        "iat": issued_at,
        "nbf": issued_at,
        "exp": issued_at + ttl,
    }
    if scopes:
        payload["scope"] = " ".join(scopes)
    if extra:
        reserved = set(payload) & set(extra)
        if reserved:
            raise ValueError(
                f"Claims réservés impossibles à surcharger : {sorted(reserved)}"
            )
        payload.update(extra)

    return jwt.encode(
        payload,
        ed25519_private_key(),
        algorithm=ALGORITHM,
        headers={"kid": ed25519_key_id()},
    )


def _decode(token: str, *, expected_typ: str, audience: str) -> TokenClaims:
    """Vérifie et décode un JWT du projet.

    :raises TokenExpired: jeton expiré.
    :raises TokenTypeMismatch: jeton d'un autre usage.
    :raises TokenInvalid: signature, émetteur, audience ou claims invalides.
    """
    if not token or not isinstance(token, str):
        raise TokenInvalid("Jeton absent.")
    try:
        payload = jwt.decode(
            token,
            ed25519_public_key(),
            algorithms=[ALGORITHM],  # verrou : aucun autre algorithme accepté
            audience=audience,
            issuer=issuer(),
            leeway=_leeway(),
            options={
                "require": ["exp", "iat", "sub", "jti", "typ", "iss", "aud"],
                "verify_signature": True,
                "verify_exp": True,
                "verify_iat": True,
                "verify_aud": True,
                "verify_iss": True,
            },
        )
    except ExpiredSignatureError as exc:
        raise TokenExpired("Le jeton a expiré.") from exc
    except InvalidTokenError as exc:
        raise TokenInvalid("Jeton invalide.") from exc

    if payload.get("typ") != expected_typ:
        raise TokenTypeMismatch(
            f"Jeton de type {payload.get('typ')!r} présenté à la place de "
            f"{expected_typ!r}."
        )

    scope = payload.get("scope") or ""
    return TokenClaims(
        subject=str(payload["sub"]),
        token_id=str(payload["jti"]),
        typ=str(payload["typ"]),
        issued_at=datetime.fromtimestamp(int(payload["iat"]), tz=timezone.utc),
        expires_at=datetime.fromtimestamp(int(payload["exp"]), tz=timezone.utc),
        scopes=tuple(scope.split()) if scope else (),
        raw=payload,
    )


def create_access_token(
    subject: str,
    *,
    scopes: tuple[str, ...] | list[str] = (),
    ttl: timedelta | None = None,
    extra: Mapping[str, Any] | None = None,
) -> str:
    """Émet un ``access_token`` pour l'API launcher.

    :param subject: identifiant de l'utilisateur (UUID).
    :param scopes: portées accordées (``"admin"``, ``"play"``…).
    :param extra: claims additionnels non réservés.
    """
    return _encode(
        subject=subject,
        typ=TYPE_ACCESS,
        ttl=ttl or access_token_ttl(),
        audience=api_audience(),
        scopes=tuple(scopes),
        extra=extra,
    )


def decode_access_token(token: str) -> TokenClaims:
    """Vérifie un ``access_token`` et retourne ses claims."""
    return _decode(token, expected_typ=TYPE_ACCESS, audience=api_audience())


def create_password_reset_token(subject: str, *, ttl: timedelta | None = None) -> str:
    """Émet le jeton à usage unique du lien de réinitialisation de mot de passe.

    Le caractère « usage unique » est assuré côté service en mémorisant le
    ``jti`` consommé : le jeton reste cryptographiquement valide jusqu'à son
    expiration, c'est la base qui refuse de le rejouer.
    """
    return _encode(
        subject=subject,
        typ=TYPE_PASSWORD_RESET,
        ttl=ttl or password_reset_ttl(),
        audience=api_audience(),
    )


def decode_password_reset_token(token: str) -> TokenClaims:
    """Vérifie un jeton de réinitialisation de mot de passe."""
    return _decode(token, expected_typ=TYPE_PASSWORD_RESET, audience=api_audience())


# --------------------------------------------------------------------------- #
# Session de jeu (Yggdrasil)
# --------------------------------------------------------------------------- #


def new_client_token() -> str:
    """Génère un ``clientToken`` Yggdrasil (UUID sans tirets)."""
    return uuid.uuid4().hex


def create_yggdrasil_token(
    *,
    player_uuid: str,
    name: str,
    client_token: str,
    ttl: timedelta | None = None,
) -> str:
    """Émet l'``accessToken`` de session de jeu.

    :param player_uuid: UUID Minecraft du joueur, sans tirets.
    :param name: pseudonyme affiché en jeu.
    :param client_token: ``clientToken`` lié à la session ; le protocole
        Yggdrasil exige qu'il corresponde lors des ``refresh`` et ``validate``.
    """
    normalized = str(player_uuid).replace("-", "").lower()
    if len(normalized) != 32:
        raise ValueError(f"UUID Minecraft invalide : {player_uuid!r}")
    if not name:
        raise ValueError("Le pseudonyme du joueur est obligatoire.")
    if not client_token:
        raise ValueError("Le clientToken est obligatoire.")

    return _encode(
        subject=normalized,
        typ=TYPE_YGGDRASIL,
        ttl=ttl or yggdrasil_token_ttl(),
        audience=game_audience(),
        extra={"name": name, "cid": client_token},
    )


def decode_yggdrasil_token(
    token: str,
    *,
    client_token: str | None = None,
) -> TokenClaims:
    """Vérifie un ``accessToken`` de session de jeu.

    :param client_token: si fourni, doit correspondre au claim ``cid``.
        C'est la sémantique Mojang : un ``clientToken`` différent invalide la
        session même quand le jeton est authentique.
    """
    claims = _decode(token, expected_typ=TYPE_YGGDRASIL, audience=game_audience())
    if client_token is not None:
        stored = str(claims.get("cid", ""))
        if not constant_time_equals(stored, client_token):
            raise TokenInvalid("Le clientToken ne correspond pas à la session.")
    return claims


# --------------------------------------------------------------------------- #
# Refresh tokens opaques
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class NewRefreshToken:
    """Un ``refresh_token`` fraîchement émis.

    :ivar token: valeur à transmettre au client — **la seule fois** où elle
        existe en clair.
    :ivar token_hash: empreinte SHA-256 à stocker en base.
    :ivar family_id: identifiant de la famille (chaîne de rotations issue d'une
        même connexion) ; sert à tout révoquer en cas de rejeu.
    :ivar expires_at: date d'expiration absolue.
    """

    token: str
    token_hash: str
    family_id: str
    expires_at: datetime


def new_refresh_token(
    *,
    family_id: str | None = None,
    ttl: timedelta | None = None,
) -> NewRefreshToken:
    """Tire un ``refresh_token`` opaque de 64 octets aléatoires."""
    token = b64u_encode(secrets.token_bytes(REFRESH_TOKEN_BYTES))
    return NewRefreshToken(
        token=token,
        token_hash=hash_refresh_token(token),
        family_id=family_id or uuid.uuid4().hex,
        expires_at=_now() + (ttl or refresh_token_ttl()),
    )


def hash_refresh_token(token: str) -> str:
    """Empreinte SHA-256 hexadécimale d'un ``refresh_token``."""
    if not token:
        raise ValueError("Le refresh_token est vide.")
    return sha256_hex(token)


def verify_refresh_token(token: str, expected_hash: str) -> bool:
    """Compare un ``refresh_token`` présenté à l'empreinte stockée."""
    if not token or not expected_hash:
        return False
    return constant_time_equals(hash_refresh_token(token), expected_hash)


class RefreshOutcome(str, Enum):
    """Verdict rendu sur un ``refresh_token`` présenté."""

    #: Jeton valide : on le consomme et on en émet un nouveau.
    ACCEPTED = "accepted"
    #: Jeton déjà utilisé → tentative de rejeu, la famille entière est révoquée.
    REPLAYED = "replayed"
    #: Jeton explicitement révoqué (déconnexion, révocation de famille).
    REVOKED = "revoked"
    #: Jeton périmé.
    EXPIRED = "expired"
    #: Aucun enregistrement correspondant.
    UNKNOWN = "unknown"


class RefreshRecord(Protocol):
    """Forme attendue de l'enregistrement stocké en base.

    Volontairement exprimé comme un ``Protocol`` : le modèle SQLAlchemy vit
    ailleurs, cette couche n'a besoin que de ces quatre attributs.
    """

    family_id: str
    expires_at: datetime
    revoked_at: datetime | None
    used_at: datetime | None


@dataclass(frozen=True, slots=True)
class RotationResult:
    """Décision prise à la présentation d'un ``refresh_token``.

    :ivar outcome: verdict.
    :ivar revoke_family: si vrai, l'appelant doit révoquer **toute** la famille
        (rejeu détecté ou jeton déjà révoqué : on considère la chaîne compromise).
    :ivar replacement: le nouveau jeton à renvoyer au client, si accepté.
    """

    outcome: RefreshOutcome
    revoke_family: bool
    replacement: NewRefreshToken | None = None

    @property
    def accepted(self) -> bool:
        """Raccourci : la rotation a-t-elle réussi ?"""
        return self.outcome is RefreshOutcome.ACCEPTED


def _as_utc(moment: datetime) -> datetime:
    """Ramène une date en UTC (SQLite renvoie souvent des dates naïves)."""
    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def rotate_refresh_token(
    record: RefreshRecord | None,
    *,
    now: datetime | None = None,
    ttl: timedelta | None = None,
) -> RotationResult:
    """Décide du sort d'un ``refresh_token`` présenté et prépare son successeur.

    Logique pure, sans accès à la base : l'appelant fournit l'enregistrement
    trouvé (ou ``None``) et applique la décision.

    Détection de rejeu : un jeton déjà consommé (``used_at`` renseigné) qui
    ressurgit signifie qu'il a été volé — ou que le client légitime a été
    doublé par un attaquant. Dans les deux cas la seule réponse sûre est de
    révoquer la famille entière et d'exiger une reconnexion (``docs/API.md`` §4.3).
    """
    moment = now or _now()

    if record is None:
        return RotationResult(RefreshOutcome.UNKNOWN, revoke_family=False)
    if record.used_at is not None:
        return RotationResult(RefreshOutcome.REPLAYED, revoke_family=True)
    if record.revoked_at is not None:
        return RotationResult(RefreshOutcome.REVOKED, revoke_family=True)
    if _as_utc(record.expires_at) <= moment:
        return RotationResult(RefreshOutcome.EXPIRED, revoke_family=False)

    return RotationResult(
        RefreshOutcome.ACCEPTED,
        revoke_family=False,
        replacement=new_refresh_token(family_id=record.family_id, ttl=ttl),
    )
