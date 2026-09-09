"""Journal d'audit : qui a fait quoi, quand, depuis où.

Le journal sert à trois choses, et rien d'autre :

* comprendre un incident (« ce compte a-t-il été repris ? ») ;
* détecter un abus (rafale d'échecs de connexion, rejeu de jeton) ;
* répondre à un joueur qui conteste une sanction.

Il n'est **jamais** une trace de débogage : aucune donnée sensible n'y entre.
Les mots de passe, jetons, secrets TOTP et codes de secours sont masqués par
:func:`sanitize` avant l'écriture, quelle que soit la profondeur à laquelle ils
apparaissent dans les métadonnées (``docs/API.md`` §4.8).

L'adresse IP n'est **jamais** écrite en clair
=============================================

La table ``auth_audit`` n'a pas de colonne ``ip`` : elle a ``ip_hash``
(``char(64)``, ``docs/DATA.md`` §2). :func:`record` reçoit donc l'adresse en
clair et n'écrit que son empreinte HMAC-SHA256, calculée avec une clé dérivée
d'``OPM_SECRET_KEY``. Deux conséquences voulues : on peut toujours rapprocher
deux événements venus de la même adresse (l'empreinte est stable), mais une
base volée ne rend pas les adresses — sans la clé, les quatre milliards
d'adresses IPv4 ne se recalculent pas.

Elle n'a pas davantage de colonne « réussi » : un refus se lit dans l'action
elle-même (``login_failed``, ``microsoft_verify_failed``) ou dans les
métadonnées. L'argument ``success`` de :func:`record` est donc replié dans
``meta["success"]``, jamais dans une colonne inventée.

Usage typique, dans un service :

.. code-block:: python

    await audit.record(
        session,
        AuditAction.LOGIN_FAILED,
        user_id=user.id,
        success=False,
        ip=context.ip,
        user_agent=context.user_agent,
        meta={"reason": "invalid_password"},
    )

L'écriture est ajoutée à la session courante et poussée en base (``flush``),
mais **jamais validée** : c'est l'appelant qui décide du moment du ``commit``,
afin qu'une entrée de journal ne survive pas à une opération annulée — sauf
lorsqu'il valide volontairement avant de lever une erreur, ce qui est le cas
des échecs d'authentification.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
from dataclasses import dataclass
from typing import Any, Mapping

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from opm_auth.models import Audit, AuditAction
from opm_auth.security.crypto import MissingKeyError, derive_key
from opm_auth.security.ratelimit import client_ip

logger = logging.getLogger(__name__)

__all__ = [
    "MASK",
    "MAX_META_KEYS",
    "MAX_VALUE_LENGTH",
    "RequestContext",
    "SENSITIVE_KEYS",
    "hash_ip",
    "record",
    "request_context",
    "sanitize",
]

#: Marqueur substitué à toute valeur jugée sensible.
MASK = "[masqué]"

#: Longueur maximale d'une chaîne conservée dans les métadonnées.
MAX_VALUE_LENGTH = 200

#: Nombre maximal de clés conservées, pour qu'une entrée reste lisible.
MAX_META_KEYS = 20

#: Profondeur maximale explorée dans les structures imbriquées.
_MAX_DEPTH = 3

#: Longueur maximale d'un ``User-Agent`` (taille de la colonne).
_MAX_USER_AGENT = 255

#: Usage de la clé dérivée qui sale les empreintes d'adresses IP. Le suffixe de
#: version permet d'en changer un jour sans confondre deux générations
#: d'empreintes dans la même colonne.
_IP_HASH_PURPOSE = "audit-ip-hash-v1"

#: Fragments de noms de clés dont la valeur ne doit jamais être écrite.
#: La comparaison est faite en minuscules, par inclusion : ``msa_refresh_token``
#: est donc masqué par le fragment ``token``.
SENSITIVE_KEYS: frozenset[str] = frozenset(
    {
        "authorization",
        "code",
        "cookie",
        "credential",
        "hash",
        "key",
        "otp",
        "passphrase",
        "password",
        "recovery",
        "secret",
        "seed",
        "signature",
        "token",
    }
)

#: Exceptions : ces clés contiennent le fragment ``code`` ou ``token`` mais ne
#: transportent aucun secret — ce sont des identifiants d'erreur ou de famille.
_ALLOWED_KEYS: frozenset[str] = frozenset(
    {
        "error_code",
        "status_code",
        "token_family",
        "token_outcome",
    }
)


def _is_sensitive(key: str) -> bool:
    """La valeur associée à cette clé doit-elle être masquée ?"""
    lowered = key.strip().lower()
    if lowered in _ALLOWED_KEYS:
        return False
    return any(fragment in lowered for fragment in SENSITIVE_KEYS)


def _clean_value(value: Any, depth: int) -> Any:
    """Réduit une valeur à quelque chose de sûr et de compact."""
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value if len(value) <= MAX_VALUE_LENGTH else value[:MAX_VALUE_LENGTH] + "…"
    if isinstance(value, Mapping):
        if depth >= _MAX_DEPTH:
            return MASK
        return _clean_mapping(value, depth + 1)
    if isinstance(value, (list, tuple, set, frozenset)):
        if depth >= _MAX_DEPTH:
            return MASK
        return [_clean_value(item, depth + 1) for item in list(value)[:MAX_META_KEYS]]
    # Objets métier, dates, énumérations : on n'en garde qu'une représentation.
    return _clean_value(str(value), depth)


def _clean_mapping(meta: Mapping[str, Any], depth: int) -> dict[str, Any]:
    """Nettoie un dictionnaire clé par clé, en masquant ce qui est sensible."""
    cleaned: dict[str, Any] = {}
    for key, value in list(meta.items())[:MAX_META_KEYS]:
        name = str(key)
        cleaned[name] = MASK if _is_sensitive(name) else _clean_value(value, depth)
    return cleaned


def sanitize(meta: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """Rend des métadonnées écrivables dans le journal.

    Masque les valeurs sensibles, tronque les chaînes trop longues, limite le
    nombre de clés et la profondeur. Retourne ``None`` si rien ne subsiste,
    afin de ne pas stocker un objet JSON vide.
    """
    if not meta:
        return None
    cleaned = _clean_mapping(meta, 0)
    return cleaned or None


def hash_ip(ip: str | None) -> str | None:
    """Empreinte salée d'une adresse IP, telle qu'elle entre dans ``ip_hash``.

    HMAC-SHA256 avec une clé dérivée d'``OPM_SECRET_KEY`` par HKDF, et non un
    ``sha256(secret + ip)`` : c'est la construction faite pour un hachage à clé,
    elle ne se prête ni à l'extension de longueur ni à la confusion de frontière
    entre le sel et la donnée. Le résultat fait 64 caractères hexadécimaux,
    exactement la taille de la colonne ``char(64)``.

    Le sel est indispensable : sans lui, une base volée livrerait toutes les
    adresses, l'espace IPv4 entier se recalculant en quelques minutes.

    :return: l'empreinte, ou ``None`` si l'adresse est absente — ou si la clé
        est indérivable, auquel cas on préfère ne rien écrire plutôt que
        d'écrire une empreinte non salée qui trahirait l'adresse.
    """
    cleaned = (ip or "").strip()
    if not cleaned:
        return None
    try:
        key = derive_key(_IP_HASH_PURPOSE)
    except MissingKeyError:
        logger.warning(
            "OPM_SECRET_KEY est absente : l'adresse IP n'est pas consignée dans "
            "le journal d'audit (une empreinte non salée serait réversible)."
        )
        return None
    return hmac.new(key, cleaned.encode("utf-8"), hashlib.sha256).hexdigest()


@dataclass(frozen=True, slots=True)
class RequestContext:
    """Origine d'une requête, telle qu'on la consigne.

    :ivar ip: adresse IP de l'appelant, résolue selon la même règle que la
        limitation de débit (``X-Forwarded-For`` n'est lu que derrière un
        répartiteur déclaré de confiance).
    :ivar user_agent: en-tête ``User-Agent``, tronqué à la taille de la colonne.
    """

    ip: str | None
    user_agent: str | None


def request_context(request: Request) -> RequestContext:
    """Extrait l'adresse IP et le ``User-Agent`` d'une requête entrante."""
    raw_agent = (request.headers.get("user-agent") or "").strip()
    return RequestContext(
        ip=client_ip(request),
        user_agent=raw_agent[:_MAX_USER_AGENT] or None,
    )


async def record(
    session: AsyncSession,
    action: AuditAction | str,
    *,
    user_id: int | None = None,
    success: bool | None = None,
    ip: str | None = None,
    user_agent: str | None = None,
    meta: Mapping[str, Any] | None = None,
) -> Audit:
    """Écrit une entrée dans le journal d'audit.

    :param session: session de la requête ; l'entrée y est ajoutée puis poussée
        en base, sans ``commit`` — l'appelant reste maître de sa transaction.
    :param action: valeur de :class:`~opm_auth.models.AuditAction`, ou chaîne
        équivalente pour un service qui définirait sa propre action.
    :param user_id: ``users.id`` du compte concerné — un **entier**
        (``docs/DATA.md`` §1) ; ``None`` quand il est inconnu (tentative de
        connexion sur une adresse qui n'existe pas, par exemple).
    :param success: faux pour une tentative rejetée. ``auth_audit`` n'a pas de
        colonne pour ça : la valeur est repliée dans ``meta["success"]``.
        Laissé à ``None``, rien n'est écrit — l'action suffit à dire l'issue.
    :param ip: adresse en clair ; seule son empreinte salée est stockée
        (:func:`hash_ip`).
    :param meta: contexte libre ; il passe par :func:`sanitize`.
    """
    payload: dict[str, Any] | None = dict(meta) if meta else None
    if success is not None:
        payload = payload or {}
        payload["success"] = bool(success)

    entry = Audit(
        user_id=user_id,
        action=str(action),
        ip_hash=hash_ip(ip),
        user_agent=user_agent[:_MAX_USER_AGENT] if user_agent else None,
        meta=sanitize(payload),
    )
    session.add(entry)
    await session.flush()
    logger.debug("Audit : %s (compte=%s)", entry.action, user_id)
    return entry
