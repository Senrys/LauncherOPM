"""Oracle de possession Minecraft : toute la chaîne Microsoft, côté serveur.

Ce module est **le** point de souveraineté du projet (voir ``docs/SOUVERAINETE.md``).
Il exécute, et lui seul, la chaîne complète :

.. code-block:: text

    code d'autorisation  ──►  jetons Microsoft
                              │
                              ├─► XBL   (user.auth.xboxlive.com/user/authenticate)
                              ├─► XSTS  (xsts.auth.xboxlive.com/xsts/authorize)
                              ├─► Minecraft Services (login_with_xbox)
                              ├─► /entitlements/mcstore
                              └─► /minecraft/profile   ──►  UUID + pseudo réels

Règles non négociables appliquées ici :

* **aucun jeton Microsoft ne sort du serveur** : ni vers le launcher, ni vers le
  jeu, ni dans les journaux. Le ``refresh_token`` est chiffré au repos par
  :mod:`opm_auth.security.crypto` avant d'atteindre la base ;
* **chaque étape a son délai maximal** (``OPM_MSA_TIMEOUT_SECONDS``) et son code
  d'erreur stable (:class:`MicrosoftError`), traduit en français pour le joueur ;
* **la preuve de possession est mise en cache** (``McLink.expires_at``,
  ``OPM_OWNERSHIP_TTL_DAYS``). Tant qu'elle est valide, une panne de Microsoft
  n'empêche personne de jouer ;
* **aucune application Azure n'est requise** : on utilise le ``client_id`` public
  du launcher officiel et les points d'entrée ``login.live.com``, tous
  configurables (§5 de ``.env.example``).

Le module expose aussi la persistance du rattachement (:func:`attach`,
:func:`refresh_link`, :func:`detach`) : les routeurs restent ainsi de simples
adaptateurs HTTP, conformément aux conventions du projet.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import secrets
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Final
from urllib.parse import urlencode

import httpx
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from opm_auth.config import Settings, get_settings
from opm_auth.models import AuditAction, McLink, User, utcnow
from opm_auth.security import setting
from opm_auth.security.crypto import (
    ENVELOPE_VERSION,
    NONCE_SIZE,
    CryptoError,
    b64u_decode,
    b64u_encode,
    decrypt_msa_token,
    derive_key,
    encrypt_msa_token,
)
from opm_auth.security.passwords import verify_password_async
from opm_auth.services import audit as audit_service

logger = logging.getLogger(__name__)

__all__ = [
    "DeviceFlow",
    "Entitlements",
    "MicrosoftError",
    "MicrosoftTokens",
    "MinecraftProfile",
    "OwnershipProof",
    "XboxToken",
    "attach",
    "authenticate_with_code",
    "authenticate_with_device",
    "build_authorize_url",
    "check_entitlements",
    "detach",
    "exchange_code",
    "get_profile",
    "minecraft_login",
    "poll_device",
    "refresh_link",
    "refresh_ownership",
    "refresh_tokens",
    "set_transport",
    "sign_device_ticket",
    "sign_state",
    "start_device_flow",
    "verify_device_ticket",
    "verify_ownership",
    "verify_state",
    "xbl_authenticate",
    "xsts_authorize",
]


# --------------------------------------------------------------------------- #
# Constantes de protocole
# --------------------------------------------------------------------------- #

#: Identité annoncée aux services Microsoft. Aucune donnée personnelle.
USER_AGENT: Final = "OPM-Auth/1.0 (+https://onepieceminecraft.fr)"

#: Partie de confiance demandée à XBL puis à XSTS.
XBL_RELYING_PARTY: Final = "http://auth.xboxlive.com"
XSTS_RELYING_PARTY: Final = "rp://api.minecraftservices.com/"

#: Portée du flux « device ». Les points d'entrée v2.0 de Microsoft refusent la
#: portée héritée ``MBI_SSL`` : les deux flux n'ont donc pas la même portée.
#: Surchargeable par ``OPM_MSA_DEVICE_SCOPE``.
DEFAULT_DEVICE_SCOPE: Final = "XboxLive.signin offline_access"

#: Préfixe du ticket RPS envoyé à XBL. Les jetons délivrés par le point d'entrée
#: v2.0 exigent ``d=`` ; certains tickets hérités doivent être envoyés bruts.
#: Surchargeable par ``OPM_MSA_RPS_PREFIX`` (valeur vide acceptée).
DEFAULT_RPS_PREFIX: Final = "d="

#: Durée de validité du ``state`` signé remis au launcher (docs/API.md §1.3).
STATE_TTL: Final = timedelta(minutes=10)

#: Contexte HKDF de la clé de signature des enveloppes ``state``/``device_code``.
_ENVELOPE_CONTEXT: Final = "opm:msa-link-state:v1"

#: Produits Minecraft : Java Edition acheté, ou fourni par un abonnement.
OWNING_PRODUCTS: Final = frozenset(
    {
        "product_minecraft",
        "game_minecraft",
        "product_game_pass_ultimate",
        "product_game_pass_pc",
    }
)

#: Codes ``XErr`` renvoyés par XSTS, avec leur code stable et leur message joueur.
#: Ces valeurs sont celles publiées par Microsoft ; elles ne changent jamais.
XSTS_ERRORS: Final[dict[int, tuple[str, str]]] = {
    2148916227: (
        "xbox_banned",
        "Ce compte Xbox Live est suspendu par Microsoft : le rattachement est impossible.",
    ),
    2148916233: (
        "xbox_no_account",
        "Ce compte Microsoft n'a pas de profil Xbox. Créez-en un sur xbox.com "
        "avec ce compte, puis relancez le rattachement.",
    ),
    2148916234: (
        "xbox_terms_not_accepted",
        "Ce compte Microsoft doit d'abord accepter les conditions d'utilisation "
        "de Xbox Live sur xbox.com.",
    ),
    2148916235: (
        "xbox_region_unsupported",
        "Xbox Live n'est pas disponible dans le pays enregistré sur ce compte "
        "Microsoft : la possession de Minecraft ne peut pas être vérifiée.",
    ),
    2148916236: (
        "xbox_adult_verification",
        "Ce compte Microsoft doit terminer la vérification d'âge sur xbox.com "
        "avant de pouvoir être rattaché.",
    ),
    2148916237: (
        "xbox_adult_verification",
        "Ce compte Microsoft doit terminer la vérification d'âge sur xbox.com "
        "avant de pouvoir être rattaché.",
    ),
    2148916238: (
        "xbox_child_account",
        "Ce compte Microsoft appartient à un mineur : un adulte doit d'abord "
        "l'ajouter à un groupe familial Microsoft pour l'autoriser à jouer.",
    ),
}

#: Erreurs OAuth de Microsoft traduites en codes stables. Le second élément
#: indique si l'erreur est passagère (une nouvelle tentative a du sens).
_OAUTH_ERRORS: Final[dict[str, tuple[str, str, int]]] = {
    "invalid_grant": (
        "microsoft_invalid_code",
        "L'autorisation Microsoft a expiré ou a déjà été utilisée. Recommencez le rattachement.",
        400,
    ),
    "expired_token": (
        "device_expired",
        "Le code affiché a expiré. Relancez le rattachement pour en obtenir un nouveau.",
        400,
    ),
    "authorization_declined": (
        "device_declined",
        "Vous avez refusé l'autorisation sur la page Microsoft.",
        400,
    ),
    "access_denied": (
        "microsoft_denied",
        "L'autorisation a été refusée côté Microsoft.",
        400,
    ),
    "bad_verification_code": (
        "device_invalid",
        "Le code d'appareil transmis est invalide. Relancez le rattachement.",
        400,
    ),
    "unauthorized_client": (
        "microsoft_client_rejected",
        "Microsoft a refusé l'identifiant d'application du serveur. "
        "Prévenez l'équipage : la configuration OPM_MSA_CLIENT_ID est à revoir.",
        503,
    ),
    "invalid_client": (
        "microsoft_client_rejected",
        "Microsoft a refusé l'identifiant d'application du serveur. "
        "Prévenez l'équipage : la configuration OPM_MSA_CLIENT_ID est à revoir.",
        503,
    ),
}


# --------------------------------------------------------------------------- #
# Erreur typée
# --------------------------------------------------------------------------- #


class MicrosoftError(Exception):
    """Échec d'une étape de la chaîne Microsoft, avec un code stable.

    :ivar code: code machine, jamais traduit, jamais renuméroté. Les routeurs le
        recopient tel quel dans le corps d'erreur normalisé (``docs/API.md`` §3).
    :ivar message: phrase française affichable telle quelle par le launcher.
    :ivar status_code: statut HTTP à renvoyer au launcher.
    :ivar details: complément machine (``interval``, ``xerr``…), jamais de jeton.
    :ivar transient: vrai si l'échec vient d'une indisponibilité passagère ; dans
        ce cas une preuve de possession encore valide ne doit **pas** être remise
        en cause.
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = 502,
        details: Mapping[str, Any] | None = None,
        transient: bool = False,
    ) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details: dict[str, Any] | None = dict(details) if details else None
        self.transient = transient


def _unavailable(step: str, cause: Exception | None = None) -> MicrosoftError:
    """Erreur passagère : Microsoft n'a pas répondu correctement."""
    logger.warning("Microsoft injoignable à l'étape %s (%s).", step, type(cause).__name__)
    return MicrosoftError(
        "microsoft_unavailable",
        "Les services Microsoft sont momentanément injoignables. Réessayez dans "
        "quelques minutes ; si votre compte est déjà vérifié, vous pouvez jouer "
        "normalement.",
        status_code=503,
        details={"step": step},
        transient=True,
    )


# --------------------------------------------------------------------------- #
# Objets de transport (jamais persistés tels quels)
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class MicrosoftTokens:
    """Jetons Microsoft, en mémoire uniquement.

    ``__repr__`` est neutralisé : un ``logger.debug("%r", tokens)`` malencontreux
    ne doit jamais recopier un secret dans un fichier de journal.
    """

    access_token: str
    refresh_token: str | None
    expires_in: int = 3600
    #: Identifiant stable du compte Microsoft, quand le point d'entrée le donne.
    user_id: str | None = None

    def __repr__(self) -> str:  # pragma: no cover - protection anti-fuite
        return f"<MicrosoftTokens user_id={self.user_id!r} refresh={bool(self.refresh_token)}>"


@dataclass(frozen=True, slots=True)
class XboxToken:
    """Jeton XBL ou XSTS accompagné de son ``uhs`` (hachage d'utilisateur)."""

    token: str
    user_hash: str
    xuid: str | None = None

    def __repr__(self) -> str:  # pragma: no cover - protection anti-fuite
        return f"<XboxToken xuid={self.xuid!r}>"


@dataclass(frozen=True, slots=True)
class Entitlements:
    """Résultat de ``/entitlements/mcstore``."""

    owns: bool
    products: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class MinecraftProfile:
    """Profil Minecraft réel : c'est la preuve de possession.

    ``skin_url``, ``skin_model`` et ``cape_url`` sont exposés pour le service de
    textures, qui importe l'apparence du joueur au rattachement
    (``docs/DATA.md`` §6). Un échec d'import n'est jamais bloquant.
    """

    uuid: str
    username: str
    skin_url: str | None = None
    skin_model: str | None = None
    cape_url: str | None = None


@dataclass(frozen=True, slots=True)
class DeviceFlow:
    """Réponse du flux « device » : ce que le joueur doit saisir."""

    device_code: str
    user_code: str
    verification_uri: str
    interval: int = 5
    expires_in: int = 900

    def __repr__(self) -> str:  # pragma: no cover - protection anti-fuite
        return f"<DeviceFlow user_code={self.user_code!r} expires_in={self.expires_in}>"


@dataclass(frozen=True, slots=True)
class OwnershipProof:
    """Ce que la chaîne Microsoft rapporte, et rien de plus.

    Seuls ``msa_sub``, ``xuid`` et le profil finissent en base ; le
    ``refresh_token`` y va **chiffré**, les autres jetons sont oubliés à la fin
    de la requête.
    """

    msa_sub: str
    minecraft_uuid: str
    minecraft_username: str
    owns_minecraft: bool
    xuid: str | None = None
    refresh_token: str | None = field(default=None, repr=False)
    profile: MinecraftProfile | None = field(default=None, repr=False)
    products: tuple[str, ...] = ()


# --------------------------------------------------------------------------- #
# Plomberie HTTP
# --------------------------------------------------------------------------- #

#: Transport injecté par les tests (``httpx.MockTransport``). En production il
#: reste à ``None`` et httpx ouvre de vraies connexions.
_transport: httpx.AsyncBaseTransport | None = None


def set_transport(transport: httpx.AsyncBaseTransport | None) -> None:
    """Impose un transport HTTP à tous les appels sortants.

    Réservé aux tests : ``set_transport(httpx.MockTransport(handler))`` simule
    la chaîne Microsoft entière sans toucher au réseau. ``set_transport(None)``
    rétablit le comportement normal.
    """
    global _transport
    _transport = transport


@asynccontextmanager
async def _open_client() -> AsyncIterator[httpx.AsyncClient]:
    """Ouvre un client httpx configuré pour les appels Microsoft."""
    settings = get_settings()
    timeout = httpx.Timeout(
        settings.msa_timeout_seconds,
        connect=min(10.0, settings.msa_timeout_seconds),
    )
    options: dict[str, Any] = {
        "timeout": timeout,
        "headers": {"Accept": "application/json", "User-Agent": USER_AGENT},
        "follow_redirects": False,
        # Pas de proxy hérité de l'environnement : les appels sortants du serveur
        # d'authentification doivent être prévisibles.
        "trust_env": False,
    }
    if _transport is not None:
        options["transport"] = _transport
    async with httpx.AsyncClient(**options) as client:
        yield client


@asynccontextmanager
async def _using(client: httpx.AsyncClient | None) -> AsyncIterator[httpx.AsyncClient]:
    """Réutilise le client fourni, ou en ouvre un le temps de l'appel."""
    if client is not None:
        yield client
        return
    async with _open_client() as owned:
        yield owned


async def _send(
    client: httpx.AsyncClient,
    step: str,
    request: httpx.Request,
) -> httpx.Response:
    """Envoie une requête et convertit toute panne réseau en erreur passagère."""
    try:
        return await client.send(request)
    except httpx.TimeoutException as exc:
        raise MicrosoftError(
            "microsoft_timeout",
            "Microsoft n'a pas répondu dans le délai imparti. Réessayez dans un instant.",
            status_code=504,
            details={"step": step},
            transient=True,
        ) from exc
    except httpx.HTTPError as exc:
        raise _unavailable(step, exc) from exc


def _json(step: str, response: httpx.Response) -> dict[str, Any]:
    """Décode un corps JSON, ou lève une erreur passagère s'il est illisible."""
    try:
        payload = response.json()
    except ValueError as exc:
        logger.warning(
            "Réponse illisible à l'étape %s (statut %s, %d octets).",
            step,
            response.status_code,
            len(response.content),
        )
        raise _unavailable(step, exc) from exc
    if not isinstance(payload, dict):
        raise _unavailable(step)
    return payload


async def _post_json(
    client: httpx.AsyncClient,
    step: str,
    url: str,
    body: dict[str, Any],
    *,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    """POST JSON. Le corps n'est jamais journalisé : il contient des jetons."""
    request = client.build_request(
        "POST",
        url,
        json=body,
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    response = await _send(client, step, request)
    logger.debug("Étape %s : statut %s.", step, response.status_code)
    return response


async def _post_form(
    client: httpx.AsyncClient,
    step: str,
    url: str,
    form: dict[str, str],
) -> httpx.Response:
    """POST ``application/x-www-form-urlencoded`` (points d'entrée OAuth)."""
    request = client.build_request("POST", url, data=form)
    response = await _send(client, step, request)
    logger.debug("Étape %s : statut %s.", step, response.status_code)
    return response


async def _get_json(
    client: httpx.AsyncClient,
    step: str,
    url: str,
    bearer: str,
) -> httpx.Response:
    """GET authentifié par un jeton Minecraft Services."""
    request = client.build_request("GET", url, headers={"Authorization": f"Bearer {bearer}"})
    response = await _send(client, step, request)
    logger.debug("Étape %s : statut %s.", step, response.status_code)
    return response


def _oauth_failure(step: str, response: httpx.Response) -> MicrosoftError:
    """Traduit une erreur du point d'entrée OAuth de Microsoft."""
    payload: dict[str, Any] = {}
    try:
        raw = response.json()
        if isinstance(raw, dict):
            payload = raw
    except ValueError:
        payload = {}

    error = str(payload.get("error") or "").strip()
    known = _OAUTH_ERRORS.get(error)
    if known is not None:
        code, message, status = known
        logger.info("Étape %s refusée par Microsoft : %s.", step, error)
        return MicrosoftError(code, message, status_code=status, details={"step": step})

    if response.status_code >= 500:
        return _unavailable(step)

    # Message de secours : on ne recopie jamais le corps brut, il peut contenir
    # des identifiants de corrélation nominatifs.
    logger.info(
        "Étape %s refusée par Microsoft (statut %s, error=%s).",
        step,
        response.status_code,
        error or "inconnu",
    )
    return MicrosoftError(
        "microsoft_rejected",
        "Microsoft a refusé la demande de rattachement. Recommencez depuis le "
        "launcher ; si le problème persiste, prévenez l'équipage.",
        status_code=400,
        details={"step": step, "microsoft_error": error or None},
    )


# --------------------------------------------------------------------------- #
# Enveloppes signées : « state » et ticket d'appareil
# --------------------------------------------------------------------------- #


def _envelope_key() -> bytes:
    """Clé HMAC dédiée, dérivée de ``OPM_SECRET_KEY``."""
    return derive_key(_ENVELOPE_CONTEXT)


def _sign_envelope(kind: str, user_id: str, data: str, ttl: timedelta) -> str:
    """Signe ``data`` pour un utilisateur donné, avec une date de péremption.

    Le serveur ne garde donc **aucun état** entre ``start`` et ``complete`` :
    l'enveloppe se suffit à elle-même, et elle est inutilisable pour un autre
    compte OPM ou après ``ttl``.
    """
    payload = {
        "k": kind,
        "u": user_id,
        "d": data,
        "x": int((utcnow() + ttl).timestamp()),
        "n": secrets.token_hex(8),
    }
    body = b64u_encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
    mac = hmac.new(_envelope_key(), body.encode("ascii"), hashlib.sha256).digest()
    return f"{body}.{b64u_encode(mac)}"


def _invalid_envelope(kind: str) -> MicrosoftError:
    """Erreur unique pour toute enveloppe refusée : on n'en dit pas plus."""
    if kind == "device":
        return MicrosoftError(
            "device_invalid",
            "Ce code d'appareil n'est plus valable. Relancez le rattachement depuis le launcher.",
            status_code=400,
        )
    return MicrosoftError(
        "microsoft_state_invalid",
        "La demande de rattachement a expiré ou ne correspond pas à votre "
        "compte. Relancez-la depuis le launcher.",
        status_code=400,
    )


def _verify_envelope(kind: str, user_id: str, envelope: str) -> str:
    """Vérifie une enveloppe et retourne la donnée signée.

    :raises MicrosoftError: signature fausse, enveloppe expirée, mauvais usage,
        ou enveloppe émise pour un autre compte OPM.
    """
    body, separator, signature = envelope.partition(".")
    if not separator or not body:
        raise _invalid_envelope(kind)

    expected = hmac.new(_envelope_key(), body.encode("ascii"), hashlib.sha256).digest()
    try:
        given = b64u_decode(signature)
    except (ValueError, TypeError) as exc:
        raise _invalid_envelope(kind) from exc
    if not hmac.compare_digest(expected, given):
        logger.info("Enveloppe %s rejetée : signature invalide.", kind)
        raise _invalid_envelope(kind)

    try:
        payload = json.loads(b64u_decode(body))
    except (ValueError, TypeError) as exc:
        raise _invalid_envelope(kind) from exc
    if not isinstance(payload, dict):
        raise _invalid_envelope(kind)

    if payload.get("k") != kind or payload.get("u") != user_id:
        logger.info("Enveloppe %s rejetée : usage ou compte non concordant.", kind)
        raise _invalid_envelope(kind)
    if int(payload.get("x", 0)) <= int(utcnow().timestamp()):
        logger.info("Enveloppe %s rejetée : expirée.", kind)
        raise _invalid_envelope(kind)

    data = payload.get("d")
    if not isinstance(data, str):
        raise _invalid_envelope(kind)
    return data


def sign_state(user_id: str) -> str:
    """``state`` OAuth signé, valable dix minutes et lié à un compte OPM."""
    return _sign_envelope("state", user_id, "", STATE_TTL)


def verify_state(user_id: str, state: str) -> None:
    """Vérifie le ``state`` renvoyé par le launcher.

    :raises MicrosoftError: ``microsoft_state_invalid`` si l'enveloppe est
        fausse, expirée, ou émise pour un autre compte.
    """
    _verify_envelope("state", user_id, state)


def sign_device_ticket(user_id: str, device_code: str, expires_in: int) -> str:
    """Emballe le ``device_code`` Microsoft dans une enveloppe signée.

    Le launcher ne manipule donc jamais le code brut, et un ticket volé est
    inutilisable sur un autre compte OPM.
    """
    ttl = timedelta(seconds=max(60, expires_in))
    return _sign_envelope("device", user_id, device_code, ttl)


def verify_device_ticket(user_id: str, ticket: str) -> str:
    """Ouvre l'enveloppe et retourne le ``device_code`` Microsoft d'origine."""
    return _verify_envelope("device", user_id, ticket)


# --------------------------------------------------------------------------- #
# 1. Démarrage des deux flux
# --------------------------------------------------------------------------- #


def _client_credentials(settings: Settings) -> dict[str, str]:
    """Identifiants d'application. Le secret reste facultatif (client public)."""
    form = {"client_id": settings.msa_client_id}
    if settings.msa_client_secret:
        form["client_secret"] = settings.msa_client_secret
    return form


def build_authorize_url(state: str) -> str:
    """URL d'autorisation à ouvrir dans la fenêtre embarquée du launcher.

    Le launcher se contente d'y récupérer le paramètre ``code`` de l'URL de
    redirection : il ne l'échange jamais lui-même (``docs/API.md`` §1.3).
    """
    settings = get_settings()
    query = urlencode(
        {
            "client_id": settings.msa_client_id,
            "response_type": "code",
            "redirect_uri": settings.msa_redirect_uri,
            "scope": settings.msa_scope,
            "state": state,
            # Laisse le joueur choisir son compte même s'il est déjà connecté à
            # un autre compte Microsoft dans la fenêtre embarquée.
            "prompt": "select_account",
        }
    )
    return f"{settings.msa_authorize_url}?{query}"


async def start_device_flow(*, client: httpx.AsyncClient | None = None) -> DeviceFlow:
    """Demande à Microsoft un code d'appareil (flux sans navigateur embarqué)."""
    settings = get_settings()
    form = {
        **_client_credentials(settings),
        "scope": setting("msa_device_scope", DEFAULT_DEVICE_SCOPE),
    }
    async with _using(client) as http:
        response = await _post_form(http, "device_code", settings.msa_device_code_url, form)
        if response.status_code >= 400:
            raise _oauth_failure("device_code", response)
        payload = _json("device_code", response)

    device_code = str(payload.get("device_code") or "")
    user_code = str(payload.get("user_code") or "")
    verification = str(payload.get("verification_uri") or payload.get("verification_url") or "")
    if not device_code or not user_code or not verification:
        raise _unavailable("device_code")

    return DeviceFlow(
        device_code=device_code,
        user_code=user_code,
        verification_uri=verification,
        interval=int(payload.get("interval") or 5),
        expires_in=int(payload.get("expires_in") or 900),
    )


# --------------------------------------------------------------------------- #
# 2. Obtention des jetons Microsoft
# --------------------------------------------------------------------------- #


def _tokens_from(step: str, payload: Mapping[str, Any]) -> MicrosoftTokens:
    """Construit les jetons à partir d'une réponse OAuth valide."""
    access_token = str(payload.get("access_token") or "")
    if not access_token:
        logger.warning("Réponse OAuth sans access_token à l'étape %s.", step)
        raise _unavailable(step)
    refresh_token = payload.get("refresh_token")
    return MicrosoftTokens(
        access_token=access_token,
        refresh_token=str(refresh_token) if refresh_token else None,
        expires_in=int(payload.get("expires_in") or 3600),
        user_id=str(payload["user_id"]) if payload.get("user_id") else None,
    )


async def exchange_code(code: str, *, client: httpx.AsyncClient | None = None) -> MicrosoftTokens:
    """Échange le code d'autorisation contre les jetons Microsoft."""
    settings = get_settings()
    form = {
        **_client_credentials(settings),
        "code": code,
        "grant_type": "authorization_code",
        "redirect_uri": settings.msa_redirect_uri,
        "scope": settings.msa_scope,
    }
    async with _using(client) as http:
        response = await _post_form(http, "token", settings.msa_token_url, form)
        if response.status_code >= 400:
            raise _oauth_failure("token", response)
        return _tokens_from("token", _json("token", response))


async def poll_device(
    device_code: str,
    *,
    client: httpx.AsyncClient | None = None,
) -> MicrosoftTokens:
    """Interroge Microsoft pour savoir si le joueur a validé le code.

    :raises MicrosoftError: ``device_pending`` (statut 202) tant que le joueur
        n'a pas terminé, ``device_expired`` ou ``device_declined`` ensuite.
    """
    settings = get_settings()
    form = {
        **_client_credentials(settings),
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        "device_code": device_code,
    }
    async with _using(client) as http:
        response = await _post_form(http, "device_token", settings.msa_device_token_url, form)
        if response.status_code < 400:
            return _tokens_from("device_token", _json("device_token", response))

        payload: dict[str, Any] = {}
        try:
            raw = response.json()
            if isinstance(raw, dict):
                payload = raw
        except ValueError:
            payload = {}

    error = str(payload.get("error") or "")
    if error == "authorization_pending":
        raise MicrosoftError(
            "device_pending",
            "En attente de votre validation sur la page Microsoft.",
            status_code=202,
            details={"interval": int(payload.get("interval") or 5)},
        )
    if error == "slow_down":
        # Microsoft demande d'espacer les appels : on renvoie un intervalle plus
        # large plutôt qu'une erreur, le launcher n'a rien de spécial à faire.
        raise MicrosoftError(
            "device_pending",
            "En attente de votre validation sur la page Microsoft.",
            status_code=202,
            details={"interval": int(payload.get("interval") or 5) + 5},
        )
    raise _oauth_failure("device_token", response)


async def refresh_tokens(
    refresh_token: str,
    *,
    client: httpx.AsyncClient | None = None,
) -> MicrosoftTokens:
    """Renouvelle les jetons Microsoft sans intervention du joueur.

    C'est ce qui permet de re-vérifier la possession tous les trente jours de
    façon silencieuse : le joueur ne se reconnecte jamais à Microsoft.
    """
    settings = get_settings()
    device = settings.msa_flow == "device"
    url = settings.msa_device_token_url if device else settings.msa_token_url
    form = {
        **_client_credentials(settings),
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }
    if not device:
        form["redirect_uri"] = settings.msa_redirect_uri
        form["scope"] = settings.msa_scope

    async with _using(client) as http:
        response = await _post_form(http, "token_refresh", url, form)
        if response.status_code >= 400:
            failure = _oauth_failure("token_refresh", response)
            if failure.code == "microsoft_invalid_code":
                # Le consentement a été révoqué chez Microsoft : seul un nouveau
                # rattachement peut relancer la vérification.
                raise MicrosoftError(
                    "microsoft_expired",
                    "Microsoft a révoqué l'autorisation de vérification. "
                    "Rattachez de nouveau votre compte Microsoft depuis les "
                    "paramètres du launcher.",
                    status_code=403,
                    details={"step": "token_refresh"},
                ) from failure
            raise failure
        return _tokens_from("token_refresh", _json("token_refresh", response))


# --------------------------------------------------------------------------- #
# 3. Xbox Live : XBL puis XSTS
# --------------------------------------------------------------------------- #


def _user_hash(payload: Mapping[str, Any]) -> tuple[str, str | None]:
    """Extrait ``uhs`` et, si présent, le ``xid`` des ``DisplayClaims``."""
    claims = payload.get("DisplayClaims")
    entries = claims.get("xui") if isinstance(claims, dict) else None
    if not isinstance(entries, list) or not entries or not isinstance(entries[0], dict):
        return "", None
    first = entries[0]
    xid = first.get("xid")
    return str(first.get("uhs") or ""), (str(xid) if xid else None)


async def xbl_authenticate(
    ms_access_token: str,
    *,
    client: httpx.AsyncClient | None = None,
) -> XboxToken:
    """Échange le jeton Microsoft contre un jeton Xbox Live."""
    settings = get_settings()
    prefix: str = setting("msa_rps_prefix", DEFAULT_RPS_PREFIX)
    body = {
        "Properties": {
            "AuthMethod": "RPS",
            "SiteName": "user.auth.xboxlive.com",
            "RpsTicket": f"{prefix}{ms_access_token}",
        },
        "RelyingParty": XBL_RELYING_PARTY,
        "TokenType": "JWT",
    }
    async with _using(client) as http:
        response = await _post_json(http, "xbl", settings.xbl_auth_url, body)
        if response.status_code >= 500:
            raise _unavailable("xbl")
        if response.status_code >= 400:
            logger.info("XBL a refusé le ticket (statut %s).", response.status_code)
            raise MicrosoftError(
                "xbox_rejected",
                "Xbox Live a refusé la connexion de ce compte Microsoft. "
                "Recommencez le rattachement depuis le launcher.",
                status_code=400,
                details={"step": "xbl"},
            )
        payload = _json("xbl", response)

    token = str(payload.get("Token") or "")
    user_hash, xuid = _user_hash(payload)
    if not token or not user_hash:
        raise _unavailable("xbl")
    return XboxToken(token=token, user_hash=user_hash, xuid=xuid)


async def xsts_authorize(
    xbl: XboxToken,
    *,
    client: httpx.AsyncClient | None = None,
) -> XboxToken:
    """Autorise le jeton XBL auprès de Minecraft Services.

    C'est l'étape qui rend visibles les particularités d'un compte : profil Xbox
    absent, compte enfant, pays non pris en charge… Chaque ``XErr`` reçoit un
    code stable et un message français explicite (:data:`XSTS_ERRORS`).
    """
    settings = get_settings()
    body = {
        "Properties": {"SandboxId": "RETAIL", "UserTokens": [xbl.token]},
        "RelyingParty": XSTS_RELYING_PARTY,
        "TokenType": "JWT",
    }
    async with _using(client) as http:
        response = await _post_json(http, "xsts", settings.xsts_auth_url, body)
        if response.status_code >= 500:
            raise _unavailable("xsts")
        if response.status_code >= 400:
            payload = _json("xsts", response)
            raise _xsts_failure(payload)
        payload = _json("xsts", response)

    token = str(payload.get("Token") or "")
    user_hash, xuid = _user_hash(payload)
    if not token or not user_hash:
        raise _unavailable("xsts")
    return XboxToken(token=token, user_hash=user_hash, xuid=xuid or xbl.xuid)


def _xsts_failure(payload: Mapping[str, Any]) -> MicrosoftError:
    """Traduit le ``XErr`` renvoyé par XSTS en erreur typée et lisible."""
    try:
        xerr = int(payload.get("XErr") or 0)
    except (TypeError, ValueError):
        xerr = 0

    known = XSTS_ERRORS.get(xerr)
    if known is not None:
        code, message = known
        logger.info("XSTS a refusé le compte : XErr %s (%s).", xerr, code)
        return MicrosoftError(code, message, status_code=403, details={"xerr": xerr})

    logger.info("XSTS a refusé le compte : XErr inconnu %s.", xerr or "absent")
    return MicrosoftError(
        "xbox_rejected",
        "Xbox Live a refusé ce compte Microsoft. Vérifiez qu'il possède bien un "
        "profil Xbox utilisable, puis recommencez.",
        status_code=403,
        details={"xerr": xerr or None},
    )


# --------------------------------------------------------------------------- #
# 4. Minecraft Services
# --------------------------------------------------------------------------- #


async def minecraft_login(
    xsts: XboxToken,
    *,
    client: httpx.AsyncClient | None = None,
) -> str:
    """Échange le jeton XSTS contre un jeton Minecraft Services.

    :return: le jeton Minecraft, valable quelques heures et **jamais persisté**.
    """
    settings = get_settings()
    body = {"identityToken": f"XBL3.0 x={xsts.user_hash};{xsts.token}"}
    async with _using(client) as http:
        response = await _post_json(http, "mc_login", settings.mc_login_url, body)
        if response.status_code >= 500:
            raise _unavailable("mc_login")
        if response.status_code >= 400:
            logger.info(
                "Minecraft Services a refusé le jeton XSTS (statut %s).",
                response.status_code,
            )
            raise MicrosoftError(
                "minecraft_rejected",
                "Les services Minecraft ont refusé ce compte. Vérifiez qu'il "
                "possède bien Minecraft : Java Edition.",
                status_code=403,
                details={"step": "mc_login"},
            )
        payload = _json("mc_login", response)

    token = str(payload.get("access_token") or "")
    if not token:
        raise _unavailable("mc_login")
    return token


async def check_entitlements(
    mc_token: str,
    *,
    client: httpx.AsyncClient | None = None,
) -> Entitlements:
    """Lit les licences attachées au compte (achat ou abonnement)."""
    settings = get_settings()
    async with _using(client) as http:
        response = await _get_json(http, "entitlements", settings.mc_entitlements_url, mc_token)
        if response.status_code >= 500:
            raise _unavailable("entitlements")
        if response.status_code in (401, 403):
            raise MicrosoftError(
                "minecraft_rejected",
                "Les services Minecraft ont refusé la lecture des licences de ce "
                "compte. Recommencez le rattachement.",
                status_code=403,
                details={"step": "entitlements"},
            )
        if response.status_code >= 400:
            # 404 ou 400 : compte sans licence. Ce n'est pas une panne.
            return Entitlements(owns=False)
        payload = _json("entitlements", response)

    raw_items = payload.get("items")
    items = raw_items if isinstance(raw_items, list) else []
    products = tuple(
        str(item.get("name")) for item in items if isinstance(item, dict) and item.get("name")
    )
    owns = any(name in OWNING_PRODUCTS for name in products) or bool(products)
    return Entitlements(owns=owns, products=products)


def _active_texture(entries: Any, key: str) -> dict[str, Any] | None:
    """Retourne la texture active (``state`` = ``ACTIVE``) d'une liste de profil."""
    if not isinstance(entries, list):
        return None
    for entry in entries:
        if isinstance(entry, dict) and str(entry.get("state", "")).upper() == "ACTIVE":
            return entry
    logger.debug("Aucune texture active de type %s dans le profil.", key)
    return None


async def get_profile(
    mc_token: str,
    *,
    client: httpx.AsyncClient | None = None,
) -> MinecraftProfile | None:
    """Lit le profil Minecraft réel : UUID, pseudo, skin et cape.

    :return: le profil, ou ``None`` si le compte ne possède pas le jeu (404).
    """
    settings = get_settings()
    async with _using(client) as http:
        response = await _get_json(http, "profile", settings.mc_profile_url, mc_token)
        if response.status_code == 404:
            logger.info("Compte Microsoft sans profil Minecraft (404).")
            return None
        if response.status_code >= 500:
            raise _unavailable("profile")
        if response.status_code >= 400:
            raise MicrosoftError(
                "minecraft_rejected",
                "Les services Minecraft ont refusé la lecture du profil de ce "
                "compte. Recommencez le rattachement.",
                status_code=403,
                details={"step": "profile"},
            )
        payload = _json("profile", response)

    profile_id = str(payload.get("id") or "").replace("-", "").lower()
    name = str(payload.get("name") or "")
    if not profile_id or not name:
        raise _unavailable("profile")

    skin = _active_texture(payload.get("skins"), "skin")
    cape = _active_texture(payload.get("capes"), "cape")
    variant = str(skin.get("variant", "")).lower() if skin else ""
    return MinecraftProfile(
        uuid=profile_id,
        username=name,
        skin_url=str(skin["url"]) if skin and skin.get("url") else None,
        skin_model="slim" if variant == "slim" else ("classic" if skin else None),
        cape_url=str(cape["url"]) if cape and cape.get("url") else None,
    )


# --------------------------------------------------------------------------- #
# 5. Chaîne complète
# --------------------------------------------------------------------------- #


async def verify_ownership(tokens: MicrosoftTokens) -> OwnershipProof:
    """Déroule XBL → XSTS → Minecraft Services → profil, en un seul client HTTP.

    :raises MicrosoftError: ``ownership_missing`` si le compte Microsoft ne
        possède pas Minecraft : Java Edition, ou l'erreur typée de l'étape qui a
        échoué.
    """
    async with _open_client() as http:
        xbl = await xbl_authenticate(tokens.access_token, client=http)
        xsts = await xsts_authorize(xbl, client=http)
        mc_token = await minecraft_login(xsts, client=http)
        entitlements = await check_entitlements(mc_token, client=http)
        profile = await get_profile(mc_token, client=http)

    # Le profil fait foi : c'est lui qui porte l'UUID et le pseudo réels. Les
    # licences servent de corroboration et de trace pour l'audit.
    if profile is None:
        logger.info(
            "Possession refusée : aucun profil Minecraft (licences vues : %d).",
            len(entitlements.products),
        )
        raise MicrosoftError(
            "ownership_missing",
            "Ce compte Microsoft ne possède pas Minecraft : Java Edition. "
            "Rattachez le compte Microsoft avec lequel vous avez acheté le jeu.",
            status_code=403,
            details={"entitlements": len(entitlements.products)},
        )

    msa_sub = tokens.user_id or xsts.xuid or xbl.xuid
    if not msa_sub:
        # Sans identifiant stable, impossible de garantir l'unicité d'un compte
        # Microsoft : mieux vaut refuser que rattacher n'importe quoi.
        logger.warning("Aucun identifiant Microsoft stable dans la chaîne d'authentification.")
        raise _unavailable("identity")

    return OwnershipProof(
        msa_sub=msa_sub,
        minecraft_uuid=profile.uuid,
        minecraft_username=profile.username,
        owns_minecraft=True,
        xuid=xsts.xuid or xbl.xuid,
        refresh_token=tokens.refresh_token,
        profile=profile,
        products=entitlements.products,
    )


async def authenticate_with_code(code: str) -> OwnershipProof:
    """Flux embarqué : du code d'autorisation à la preuve de possession."""
    tokens = await exchange_code(code)
    return await verify_ownership(tokens)


async def authenticate_with_device(device_code: str) -> OwnershipProof:
    """Flux « device » : de la validation du joueur à la preuve de possession."""
    tokens = await poll_device(device_code)
    return await verify_ownership(tokens)


def _seal_refresh_token(token: str, user_id: int) -> tuple[bytes, bytes]:
    """Chiffre le ``refresh_token`` Microsoft pour les deux colonnes du schéma.

    ``docs/DATA.md`` §2 range le secret dans deux ``bytea`` : ``msa_refresh_enc``
    (chiffré + tag) et ``msa_refresh_nonce``. L'enveloppe produite par
    :mod:`opm_auth.security.crypto` est ``version || nonce || chiffré+tag`` : on
    la découpe ici, et :func:`_open_refresh_token` la recompose. Le format du
    coffre reste donc défini à un seul endroit.
    """
    raw = b64u_decode(encrypt_msa_token(token, str(user_id)))
    return raw[1 + NONCE_SIZE :], raw[1 : 1 + NONCE_SIZE]


def _open_refresh_token(link: McLink) -> str:
    """Recompose puis déchiffre le ``refresh_token`` Microsoft d'un rattachement.

    :raises CryptoError: enveloppe absente, altérée, ou chiffrée avec une clé
        qui n'est plus configurée.
    """
    if not link.msa_refresh_enc or not link.msa_refresh_nonce:
        raise CryptoError("Aucun jeton Microsoft conservé pour ce compte.")
    envelope = b64u_encode(
        bytes([ENVELOPE_VERSION]) + bytes(link.msa_refresh_nonce) + bytes(link.msa_refresh_enc)
    )
    return decrypt_msa_token(envelope, str(link.user_id))


async def refresh_ownership(link: McLink) -> OwnershipProof:
    """Re-vérifie la possession sans reconnexion du joueur.

    Déchiffre le ``refresh_token`` Microsoft conservé pour ce compte, obtient de
    nouveaux jetons, puis redéroule toute la chaîne.

    :raises MicrosoftError: ``microsoft_expired`` si aucun ``refresh_token``
        exploitable n'est disponible — seul un nouveau rattachement peut alors
        relancer la vérification.
    """
    try:
        refresh_token = _open_refresh_token(link)
    except CryptoError as exc:
        # Clé de chiffrement changée ou enregistrement altéré : on ne peut plus
        # rien faire de ce jeton, mais on ne perd pas la preuve déjà acquise.
        logger.error("Jeton Microsoft illisible pour le compte %s : %s", link.user_id, exc)
        raise MicrosoftError(
            "microsoft_expired",
            "La vérification automatique n'est plus possible pour ce compte. "
            "Rattachez de nouveau votre compte Microsoft depuis les paramètres "
            "du launcher.",
            status_code=403,
        ) from exc

    tokens = await refresh_tokens(refresh_token)
    if tokens.refresh_token is None:
        # Microsoft n'a pas renvoyé de nouveau jeton : on garde l'ancien, il
        # reste valable.
        tokens = MicrosoftTokens(
            access_token=tokens.access_token,
            refresh_token=refresh_token,
            expires_in=tokens.expires_in,
            user_id=tokens.user_id,
        )
    return await verify_ownership(tokens)


# --------------------------------------------------------------------------- #
# 6. Persistance du rattachement
# --------------------------------------------------------------------------- #


async def _audit(
    session: AsyncSession,
    user_id: int | None,
    action: AuditAction,
    *,
    ip: str | None = None,
    user_agent: str | None = None,
    meta: Mapping[str, Any] | None = None,
) -> None:
    """Ajoute une entrée au journal d'audit ``auth_audit``.

    Passe par :mod:`opm_auth.services.audit`, qui masque les valeurs sensibles
    et hache l'adresse IP : aucun jeton Microsoft ne peut se retrouver dans le
    journal, même par accident.

    ``auth_audit`` n'a pas de colonne « réussi » (``docs/DATA.md`` §2) : un refus
    se lit dans l'action elle-même (``microsoft_verify_failed``) ou dans la clé
    ``outcome`` des métadonnées.
    """
    await audit_service.record(
        session,
        action,
        user_id=user_id,
        ip=ip,
        user_agent=user_agent,
        meta=meta,
    )


def _already_linked(*, other_account: bool) -> MicrosoftError:
    """409 ``already_linked`` : un compte Minecraft, un seul compte OPM.

    C'est la règle de ``docs/DATA.md`` §8, garantie par deux contraintes
    ``UNIQUE`` (``msa_sub`` et ``minecraft_uuid``) et vérifiée ici pour pouvoir
    répondre une phrase compréhensible plutôt qu'une erreur de base de données.
    """
    if other_account:
        return MicrosoftError(
            "already_linked",
            "Ce compte Microsoft est déjà rattaché à un autre compte OPM. "
            "Contactez l'équipage si vous pensez qu'il s'agit d'une erreur.",
            status_code=409,
            details={"conflict": "other_account"},
        )
    return MicrosoftError(
        "already_linked",
        "Un compte Microsoft est déjà rattaché à votre compte OPM. "
        "Dissociez-le d'abord depuis les paramètres du launcher.",
        status_code=409,
        details={"conflict": "current_account"},
    )


async def _conflicting_link(
    session: AsyncSession,
    user_id: int,
    proof: OwnershipProof,
) -> McLink | None:
    """Cherche le même compte Microsoft rattaché à un **autre** compte OPM."""
    statement = select(McLink).where(
        McLink.user_id != user_id,
        (McLink.msa_sub == proof.msa_sub) | (McLink.minecraft_uuid == proof.minecraft_uuid),
    )
    return (await session.execute(statement)).scalars().first()


def _apply_proof(link: McLink, proof: OwnershipProof, *, now: datetime) -> None:
    """Recopie une preuve fraîche dans le rattachement et repousse l'échéance.

    Le pseudo Minecraft est resynchronisé à chaque passage : c'est lui que le
    serveur de jeu affiche, et un joueur qui se renomme chez Mojang doit rester
    reconnaissable dans les commandes, les bans et les journaux du serveur
    (``docs/DATA.md`` §8).
    """
    settings = get_settings()
    link.msa_sub = proof.msa_sub
    link.minecraft_uuid = proof.minecraft_uuid
    link.minecraft_username = proof.minecraft_username
    link.owns_minecraft = proof.owns_minecraft
    link.verified_at = now
    link.expires_at = now + settings.ownership_ttl
    link.updated_at = now
    if proof.refresh_token:
        # Le jeton Microsoft n'atteint jamais le disque en clair.
        link.msa_refresh_enc, link.msa_refresh_nonce = _seal_refresh_token(
            proof.refresh_token, link.user_id
        )


async def attach(
    session: AsyncSession,
    user: User,
    proof: OwnershipProof,
    *,
    ip: str | None = None,
    user_agent: str | None = None,
) -> McLink:
    """Enregistre la preuve de possession et ouvre la fenêtre de validité.

    * un compte Minecraft ne peut être rattaché qu'à **un seul** compte OPM :
      sinon ``already_linked`` (409) ;
    * un compte OPM déjà rattaché à **un autre** compte Microsoft doit d'abord
      être dissocié — mot de passe exigé : sinon ``already_linked`` (409) ;
    * rattacher **le même** compte Microsoft une seconde fois est autorisé et
      sans effet de bord : cela rafraîchit la preuve, le pseudo et le skin.

    L'identité de jeu du joueur est le ``minecraft_uuid`` de ce rattachement, et
    rien d'autre (``docs/DATA.md`` §8) : ni la table ``users`` du site, ni le
    launcher n'inventent d'UUID.

    La transaction est validée avant le retour ; l'import du skin, déclenché par
    le routeur juste après, la prolonge sans jamais pouvoir la remettre en cause.
    """
    now = utcnow()

    conflict = await _conflicting_link(session, user.id, proof)
    if conflict is not None:
        logger.info(
            "Rattachement refusé pour %s : compte Minecraft déjà pris par %s.",
            user.id,
            conflict.user_id,
        )
        await _audit(
            session,
            user.id,
            AuditAction.MICROSOFT_LINK,
            ip=ip,
            user_agent=user_agent,
            meta={
                "outcome": "refused",
                "reason": "already_linked",
                "minecraft_uuid": proof.minecraft_uuid,
            },
        )
        await session.commit()
        raise _already_linked(other_account=True)

    link = user.mc_link
    if link is not None and link.msa_sub != proof.msa_sub:
        logger.info("Rattachement refusé pour %s : un autre compte Microsoft est lié.", user.id)
        raise _already_linked(other_account=False)

    first_link = link is None
    if link is None:
        link = McLink(
            user_id=user.id,
            msa_sub=proof.msa_sub,
            minecraft_uuid=proof.minecraft_uuid,
            minecraft_username=proof.minecraft_username,
            expires_at=now,
            created_at=now,
        )
        session.add(link)
        user.mc_link = link

    _apply_proof(link, proof, now=now)

    await _audit(
        session,
        user.id,
        AuditAction.MICROSOFT_LINK,
        ip=ip,
        user_agent=user_agent,
        meta={
            "minecraft_uuid": proof.minecraft_uuid,
            "minecraft_username": proof.minecraft_username,
            "xuid": proof.xuid,
            "first_link": first_link,
            "expires_at": link.expires_at.isoformat(),
            "products": list(proof.products),
        },
    )

    try:
        await session.commit()
    except IntegrityError as exc:
        # Deux rattachements concurrents du même compte Microsoft : la contrainte
        # UNIQUE tranche, et le perdant reçoit la même réponse que s'il était
        # arrivé une seconde plus tard.
        await session.rollback()
        logger.info("Rattachement refusé pour %s : conflit d'unicité en base.", user.id)
        raise _already_linked(other_account=True) from exc

    logger.info(
        "Compte %s rattaché au profil Minecraft %s (valide jusqu'au %s).",
        user.id,
        proof.minecraft_username,
        link.expires_at.date().isoformat(),
    )
    return link


async def refresh_link(
    session: AsyncSession,
    user: User,
    *,
    force: bool = False,
    ip: str | None = None,
    user_agent: str | None = None,
    on_verified: Callable[[OwnershipProof], Awaitable[None]] | None = None,
) -> McLink:
    """Re-vérifie la possession, ou répond depuis le cache si elle est valide.

    C'est ici que se joue la souveraineté : tant que ``expires_at`` n'est pas
    dépassé, **aucun appel à Microsoft n'est émis** et une panne de leur côté n'a
    strictement aucun effet sur les joueurs déjà vérifiés. Quand la fenêtre est
    écoulée et que Microsoft est injoignable, la preuve existante est conservée
    telle quelle : seule une réponse explicite de Microsoft peut la contredire.

    :param force: relance la vérification même si le cache est encore valide.
    :param on_verified: appelé avec la preuve fraîche **uniquement** lorsqu'une
        vérification a réellement eu lieu, dans la transaction de celle-ci. C'est
        par là que passe la nouvelle tentative d'import du skin
        (``docs/DATA.md`` §6) : le profil Minecraft n'est disponible qu'ici, et
        une réponse servie depuis le cache ne doit rien déclencher.
    """
    link = user.mc_link
    if link is None:
        raise MicrosoftError(
            "microsoft_required",
            "Aucun compte Microsoft n'est rattaché à votre compte OPM.",
            status_code=403,
        )

    now = utcnow()
    if not force and link.is_valid(now):
        logger.debug("Possession de %s servie depuis le cache.", user.id)
        return link

    settings = get_settings()
    try:
        proof = await refresh_ownership(link)
    except MicrosoftError as exc:
        await _audit(
            session,
            user.id,
            AuditAction.MICROSOFT_VERIFY_FAILED,
            ip=ip,
            user_agent=user_agent,
            meta={"error_code": exc.code, "transient": exc.transient},
        )

        if exc.code == "ownership_missing":
            # Réponse explicite de Microsoft : la licence a disparu. On le note
            # sans effacer le rattachement, pour que le joueur voie pourquoi il
            # est bloqué plutôt que de trouver un écran vide.
            link.owns_minecraft = False
            link.verified_at = now
            link.expires_at = now + settings.ownership_ttl
            link.updated_at = now
            await session.commit()
            return link

        await session.commit()
        if exc.transient and link.owns_minecraft:
            # Microsoft est en panne : on prolonge la confiance plutôt que de
            # punir un joueur dont rien n'indique qu'il a triché.
            logger.info(
                "Re-vérification impossible pour %s (%s) : preuve existante conservée.",
                user.id,
                exc.code,
            )
            return link
        raise

    _apply_proof(link, proof, now=now)

    if on_verified is not None:
        # Dans la même transaction que la re-vérification : ce qui en découle
        # — l'import du skin, aujourd'hui — est validé avec elle, ou pas du tout.
        await on_verified(proof)

    await _audit(
        session,
        user.id,
        AuditAction.MICROSOFT_VERIFY,
        ip=ip,
        user_agent=user_agent,
        meta={
            "minecraft_uuid": proof.minecraft_uuid,
            "minecraft_username": proof.minecraft_username,
            "expires_at": link.expires_at.isoformat(),
        },
    )
    await session.commit()
    logger.info("Possession de %s re-vérifiée auprès de Microsoft.", user.id)
    return link


async def detach(
    session: AsyncSession,
    user: User,
    password: str,
    *,
    ip: str | None = None,
    user_agent: str | None = None,
) -> None:
    """Dissocie le compte Microsoft. Le mot de passe OPM est exigé.

    Sans cette exigence, une session launcher volée suffirait à libérer le compte
    Minecraft d'un joueur — et donc à le lui reprendre. Le mot de passe est
    vérifié au format Werkzeug, celui du site (``docs/DATA.md`` §3).

    Les textures importées et le temps de jeu ne sont pas touchés : ils
    appartiennent au compte OPM, pas à Microsoft.
    """
    link = user.mc_link
    if link is None:
        raise MicrosoftError(
            "microsoft_required",
            "Aucun compte Microsoft n'est rattaché à votre compte OPM.",
            status_code=403,
        )

    # Variante asynchrone obligatoire : une dérivation PBKDF2 dure de 0,14 à
    # 0,65 s, verrou global tenu. Appelée telle quelle depuis cette coroutine,
    # elle figerait tout le processus — y compris le ``hasJoined`` du serveur
    # Minecraft, dont le retard éjecte un joueur en pleine partie.
    if not await verify_password_async(user.password_hash, password):
        await _audit(
            session,
            user.id,
            AuditAction.MICROSOFT_UNLINK,
            ip=ip,
            user_agent=user_agent,
            meta={"outcome": "refused", "reason": "invalid_password"},
        )
        await session.commit()
        raise MicrosoftError(
            "invalid_credentials",
            "Mot de passe incorrect.",
            status_code=401,
        )

    meta = {
        "minecraft_uuid": link.minecraft_uuid,
        "minecraft_username": link.minecraft_username,
    }
    # La suppression de la ligne emporte le jeton Microsoft chiffré : il ne reste
    # rien de ce compte Microsoft dans notre base.
    await session.delete(link)

    await _audit(
        session,
        user.id,
        AuditAction.MICROSOFT_UNLINK,
        ip=ip,
        user_agent=user_agent,
        meta=meta,
    )
    await session.commit()
    # ``expire_on_commit`` est désactivé : sans ce rafraîchissement, l'objet en
    # mémoire continuerait d'annoncer un rattachement qui n'existe plus.
    await session.refresh(user, attribute_names=["mc_link"])
    logger.info("Compte %s dissocié de son compte Microsoft.", user.id)


def expires_at_of(link: McLink) -> datetime:
    """Fin de validité de la preuve de possession (confort de lecture)."""
    return link.expires_at
