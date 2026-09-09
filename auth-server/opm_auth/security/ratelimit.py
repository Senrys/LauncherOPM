"""Limitation de débit à fenêtre glissante.

Les limites imposées par ``docs/API.md`` §4.4 sont déclarées dans :data:`RULES` :

* ``auth.login`` — 5/min par IP **et** 10/h par compte ;
* ``auth.register`` — 3/h par IP ;
* ``yggdrasil.authenticate`` — 10/min par IP.

Deux implémentations partagent la même interface :

* :class:`InMemoryRateLimiter` — fenêtre glissante en mémoire, suffisante pour
  un processus unique (développement, petite production mono-instance) ;
* :class:`RedisRateLimiter` — même algorithme sur un ``ZSET`` Redis, atomique
  grâce à un script Lua, pour plusieurs instances derrière un répartiteur.

Choix de l'algorithme : la fenêtre glissante (et non le seau à jetons) évite
l'effet de bord des fenêtres fixes, où un attaquant peut envoyer deux fois la
limite à cheval sur la frontière de deux fenêtres.

Une requête refusée **n'est pas comptabilisée** : sinon un client insistant
repousserait indéfiniment sa propre date de déblocage.

Identifier l'appelant
=====================

Toute la protection repose sur :func:`client_ip`. ``X-Forwarded-For`` étant un
en-tête que le **client** écrit, il n'est lu que derrière un proxy déclaré de
confiance, et sa valeur est prise **en partant de la droite** : voir la
docstring de :func:`client_ip` pour le détail du contournement que cela ferme.
"""

from __future__ import annotations

import asyncio
import functools
import inspect
import ipaddress
import logging
import math
import secrets
import time
from abc import ABC, abstractmethod
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Mapping

from fastapi import Depends, Request

from opm_auth.security import setting
from opm_auth.security.deps import ApiError

logger = logging.getLogger(__name__)

__all__ = [
    "FAIL_CLOSED_RETRY_AFTER",
    "InMemoryRateLimiter",
    "RULES",
    "RateLimit",
    "RateLimitResult",
    "RateLimiterBackend",
    "RedisRateLimiter",
    "Rule",
    "client_ip",
    "enforce",
    "get_limiter",
    "limited",
    "parse_rate",
    "rate_limit",
    "reload_rules",
    "set_limiter",
    "trusted_hops",
    "trusted_proxy_networks",
]


@dataclass(frozen=True, slots=True)
class Rule:
    """Une limite : ``limit`` évènements par ``window`` secondes.

    :ivar scope: ``"ip"`` ou ``"account"`` — indique quelle valeur sert de clé.
    :ivar fail_open: comportement lorsque le magasin de compteurs (Redis) est
        injoignable. Vrai — le défaut — laisse passer : une panne de Redis ne
        doit pas couper une fonction de confort. Faux **refuse** la requête :
        pour les règles d'authentification, couper Redis reviendrait sinon à
        désactiver toute la protection anti-force-brute d'un simple déni de
        service sur le cache.
    """

    limit: int
    window: float
    scope: str = "ip"
    fail_open: bool = True

    def __post_init__(self) -> None:
        if self.limit < 1:
            raise ValueError("Une limite doit valoir au moins 1.")
        if self.window <= 0:
            raise ValueError("La fenêtre doit être strictement positive.")
        if self.scope not in {"ip", "account"}:
            raise ValueError(f"Portée inconnue : {self.scope!r}")


#: Attente imposée quand une règle ``fail_open=False`` ne peut pas être évaluée
#: (Redis injoignable). Volontairement courte : on refuse par précaution, pas
#: pour punir. En secondes.
FAIL_CLOSED_RETRY_AFTER: int = 5


#: Unités acceptées dans les réglages de la forme ``"5/minute"``.
_UNITS: Mapping[str, float] = {
    "second": 1.0,
    "seconde": 1.0,
    "minute": 60.0,
    "hour": 3_600.0,
    "heure": 3_600.0,
    "day": 86_400.0,
    "jour": 86_400.0,
}


def parse_rate(expression: str, *, scope: str = "ip", fail_open: bool = True) -> Rule:
    """Convertit un réglage ``"5/minute"`` en :class:`Rule`.

    C'est la notation utilisée par ``config.py`` (``OPM_RATE_LIMIT_LOGIN_IP``…).
    """
    try:
        count, _, unit = expression.strip().partition("/")
        return Rule(
            int(count),
            _UNITS[unit.strip().lower().rstrip("s")],
            scope=scope,
            fail_open=fail_open,
        )
    except (KeyError, ValueError) as exc:
        raise ValueError(
            f"Réglage de limitation illisible : {expression!r}. Attendu par exemple "
            "« 5/minute », « 10/hour »."
        ) from exc


def _configured(field: str, fallback: str, *, scope: str, fail_open: bool = True) -> Rule:
    """Lit une règle depuis la configuration, avec repli sur le contrat d'API."""
    return parse_rate(setting(field, fallback), scope=scope, fail_open=fail_open)


def _build_rules() -> dict[str, Rule]:
    """Construit la table des règles à partir de la configuration.

    Les quatre premières sont imposées par ``docs/API.md`` §4.4 et réglables
    par variables d'environnement ; les suivantes sont des garde-fous fixes sur
    les points sensibles restants, larges au point de gêner l'automatisation
    sans jamais gêner un joueur.

    Les règles qui protègent un mot de passe sont déclarées ``fail_open=False``:
    si Redis tombe, elles refusent plutôt que d'ouvrir la porte.
    """
    return {
        # --- imposées par docs/API.md §4.4
        "auth.login.ip": _configured(
            "rate_limit_login_ip", "5/minute", scope="ip", fail_open=False
        ),
        "auth.login.account": _configured(
            "rate_limit_login_account", "10/hour", scope="account", fail_open=False
        ),
        "auth.register.ip": _configured(
            "rate_limit_register", "3/hour", scope="ip", fail_open=False
        ),
        "yggdrasil.authenticate.ip": _configured(
            "rate_limit_yggdrasil", "10/minute", scope="ip", fail_open=False
        ),
        # Force brute par COMPTE sur la porte Yggdrasil. Sans elle, seule la
        # limite par IP s'applique à POST /yggdrasil/authserver/authenticate,
        # soit 14 400 essais par jour et par IP sur un même compte, contre 240
        # par le chemin launcher. Le budget est celui de « auth.login.account »
        # (OPM_RATE_LIMIT_LOGIN_ACCOUNT), mais dans un compartiment distinct.
        #
        # ATTENTION : cette règle doit être appliquée par
        # ``services/yggdrasil.authenticate()`` — un
        # ``await enforce("yggdrasil.authenticate.account", email_normalisé)``
        # placé AVANT la recherche du compte, comme le fait
        # ``services/users.authenticate()``. Déclarer la règle ne suffit pas.
        "yggdrasil.authenticate.account": _configured(
            "rate_limit_login_account", "10/hour", scope="account", fail_open=False
        ),
        # --- garde-fous complémentaires
        "auth.refresh.ip": Rule(30, 60, scope="ip"),
        "auth.password.forgot.ip": _configured(
            "rate_limit_forgot", "3/hour", scope="ip", fail_open=False
        ),
        "auth.password.forgot.account": Rule(
            3, 86_400, scope="account", fail_open=False
        ),
        "auth.password.reset.ip": Rule(5, 3_600, scope="ip", fail_open=False),
        "auth.totp.account": Rule(10, 300, scope="account", fail_open=False),
        "link.microsoft.ip": Rule(10, 600, scope="ip", fail_open=False),
        "link.microsoft.account": Rule(10, 3_600, scope="account", fail_open=False),
        "game.session.account": Rule(20, 3_600, scope="account"),
        "donations.checkout.account": Rule(10, 3_600, scope="account"),
    }


#: Règles effectives du projet, résolues au chargement du module.
RULES: dict[str, Rule] = _build_rules()


def reload_rules() -> None:
    """Reconstruit les règles après un changement de configuration (tests)."""
    RULES.clear()
    RULES.update(_build_rules())


@dataclass(frozen=True, slots=True)
class RateLimitResult:
    """Verdict rendu pour une tentative."""

    allowed: bool
    limit: int
    remaining: int
    #: Secondes à attendre avant la prochaine tentative autorisée (0 si permis).
    retry_after: float

    @property
    def retry_after_seconds(self) -> int:
        """Valeur entière, arrondie au supérieur, pour l'en-tête ``Retry-After``."""
        return max(1, math.ceil(self.retry_after))


# --------------------------------------------------------------------------- #
# Interface des implémentations
# --------------------------------------------------------------------------- #


class RateLimiterBackend(ABC):
    """Contrat commun aux implémentations mémoire et Redis."""

    @abstractmethod
    async def hit(self, key: str, rule: Rule) -> RateLimitResult:
        """Comptabilise une tentative et rend le verdict."""

    @abstractmethod
    async def reset(self, key: str) -> None:
        """Efface l'historique d'une clé (déblocage manuel, tests)."""

    async def close(self) -> None:
        """Libère les ressources éventuelles. Sans effet par défaut."""


@dataclass(slots=True)
class _Bucket:
    """Historique des horodatages d'une clé."""

    events: deque[float] = field(default_factory=deque)
    last_seen: float = 0.0


class InMemoryRateLimiter(RateLimiterBackend):
    """Fenêtre glissante en mémoire, protégée par un verrou asyncio.

    Les horodatages hors fenêtre sont purgés à chaque accès ; un balayage
    complet passe périodiquement pour libérer les clés devenues inactives, et
    un plafond de clés borne la mémoire même sous inondation d'adresses IP.
    """

    #: Intervalle du balayage complet, en secondes.
    SWEEP_INTERVAL = 60.0

    def __init__(self, *, max_keys: int = 100_000) -> None:
        self._buckets: dict[str, _Bucket] = {}
        self._lock = asyncio.Lock()
        self._max_keys = max_keys
        self._last_sweep = time.monotonic()

    async def hit(self, key: str, rule: Rule) -> RateLimitResult:
        now = time.monotonic()
        async with self._lock:
            if now - self._last_sweep > self.SWEEP_INTERVAL:
                self._sweep(now, rule.window)

            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = self._buckets[key] = _Bucket()
                self._enforce_capacity()
            bucket.last_seen = now

            horizon = now - rule.window
            events = bucket.events
            while events and events[0] <= horizon:
                events.popleft()

            if len(events) >= rule.limit:
                retry_after = events[0] + rule.window - now
                return RateLimitResult(
                    allowed=False,
                    limit=rule.limit,
                    remaining=0,
                    retry_after=max(0.0, retry_after),
                )

            events.append(now)
            return RateLimitResult(
                allowed=True,
                limit=rule.limit,
                remaining=rule.limit - len(events),
                retry_after=0.0,
            )

    async def reset(self, key: str) -> None:
        async with self._lock:
            self._buckets.pop(key, None)

    def _sweep(self, now: float, window: float) -> None:
        """Supprime les clés inactives depuis plus longtemps que la fenêtre."""
        self._last_sweep = now
        stale = [
            key
            for key, bucket in self._buckets.items()
            if now - bucket.last_seen > max(window, self.SWEEP_INTERVAL)
        ]
        for key in stale:
            del self._buckets[key]

    def _enforce_capacity(self) -> None:
        """Borne le nombre de clés en évinçant les moins récemment vues."""
        excess = len(self._buckets) - self._max_keys
        if excess <= 0:
            return
        logger.warning(
            "Limiteur de débit saturé (%d clés) : éviction des plus anciennes.",
            len(self._buckets),
        )
        oldest = sorted(self._buckets.items(), key=lambda item: item[1].last_seen)
        for key, _ in oldest[:excess]:
            del self._buckets[key]


#: Script Lua : purge, comptage, ajout conditionnel — le tout atomiquement.
#: ARGV = maintenant (ms), fenêtre (ms), limite, membre unique.
#: Retourne {autorisé, compte, attente_ms}.
_REDIS_SCRIPT = """
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return {1, count + 1, 0}
end

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local wait = window
if oldest[2] then
  wait = (tonumber(oldest[2]) + window) - now
end
if wait < 0 then wait = 0 end
redis.call('PEXPIRE', key, window)
return {0, count, math.ceil(wait)}
"""


class RedisRateLimiter(RateLimiterBackend):
    """Fenêtre glissante partagée entre plusieurs instances, via Redis.

    :param client: un client ``redis.asyncio.Redis`` (ou compatible : seules
        les méthodes ``eval`` et ``delete`` sont utilisées). Le paquet ``redis``
        n'est pas importé ici, il reste donc facultatif tant qu'on ne s'en sert pas.
    :param prefix: préfixe des clés Redis.
    """

    def __init__(self, client: Any, *, prefix: str = "opm:rl:") -> None:
        self._client = client
        self._prefix = prefix

    async def hit(self, key: str, rule: Rule) -> RateLimitResult:
        now_ms = int(time.time() * 1000)
        window_ms = int(rule.window * 1000)
        member = f"{now_ms}-{secrets.token_hex(4)}"  # unicité même en cas d'égalité
        try:
            raw = await self._client.eval(
                _REDIS_SCRIPT,
                1,
                f"{self._prefix}{key}",
                now_ms,
                window_ms,
                rule.limit,
                member,
            )
        except Exception:  # pragma: no cover - Redis indisponible
            if rule.fail_open:
                # Règle de confort : une panne du limiteur ne doit pas couper la
                # fonction. On laisse passer et on alerte bruyamment.
                logger.exception(
                    "Limiteur Redis indisponible, la limite %r n'est pas appliquée.",
                    key,
                )
                return RateLimitResult(True, rule.limit, rule.limit, 0.0)
            # Règle d'authentification : laisser passer reviendrait à offrir la
            # force brute illimitée à qui sait faire tomber Redis. On refuse,
            # avec une attente courte pour qu'une panne brève ne bloque pas les
            # joueurs plus longtemps que nécessaire.
            logger.exception(
                "Limiteur Redis indisponible : la limite %r refuse par précaution.",
                key,
            )
            return RateLimitResult(
                False, rule.limit, 0, float(FAIL_CLOSED_RETRY_AFTER)
            )

        allowed, count, wait_ms = int(raw[0]), int(raw[1]), int(raw[2])
        return RateLimitResult(
            allowed=bool(allowed),
            limit=rule.limit,
            remaining=max(0, rule.limit - count),
            retry_after=wait_ms / 1000.0,
        )

    async def reset(self, key: str) -> None:
        await self._client.delete(f"{self._prefix}{key}")

    async def close(self) -> None:  # pragma: no cover - dépend du client fourni
        close = getattr(self._client, "aclose", None) or getattr(
            self._client, "close", None
        )
        if close is not None:
            result = close()
            if inspect.isawaitable(result):
                await result


# --------------------------------------------------------------------------- #
# Limiteur courant
# --------------------------------------------------------------------------- #

_limiter: RateLimiterBackend | None = None


def _build_limiter() -> RateLimiterBackend:
    """Choisit l'implémentation d'après ``OPM_RATE_LIMIT_STORAGE_URI``.

    ``memory://`` (défaut) reste en mémoire ; ``redis://…`` bascule sur Redis
    dès lors que le paquet ``redis`` est installé. Si Redis est demandé mais
    indisponible, on retombe en mémoire en le signalant : un serveur qui
    démarre en limitant mal vaut mieux qu'un serveur qui ne démarre pas.
    """
    uri = str(setting("rate_limit_storage_uri", "memory://")).strip()
    if uri.startswith(("redis://", "rediss://", "unix://")):
        try:
            import redis.asyncio as redis_asyncio
        except ImportError:
            logger.error(
                "OPM_RATE_LIMIT_STORAGE_URI demande Redis mais le paquet « redis » "
                "n'est pas installé : limitation en mémoire, non partagée entre "
                "les instances."
            )
        else:
            logger.info("Limitation de débit partagée via Redis.")
            return RedisRateLimiter(redis_asyncio.from_url(uri))
    return InMemoryRateLimiter()


def get_limiter() -> RateLimiterBackend:
    """Retourne le limiteur actif, en le créant au premier appel."""
    global _limiter
    if _limiter is None:
        _limiter = _build_limiter()
    return _limiter


def set_limiter(limiter: RateLimiterBackend | None) -> None:
    """Installe un limiteur (Redis en production, factice dans les tests)."""
    global _limiter
    _limiter = limiter


def enabled() -> bool:
    """La limitation est-elle active ? (``OPM_RATE_LIMIT_ENABLED``)"""
    return setting("rate_limit_enabled", True)


# --------------------------------------------------------------------------- #
# Identification de l'appelant
# --------------------------------------------------------------------------- #


#: Nombre maximal de sauts de confiance acceptés (garde-fou de configuration).
_MAX_TRUSTED_HOPS: int = 16

#: Réseaux tenus pour « nos proxys » quand ``OPM_TRUSTED_PROXY_IPS`` est vide :
#: boucle locale et réseaux privés, c'est-à-dire le cas courant d'un nginx sur
#: la même machine ou dans le même réseau. Aucune adresse publique n'y figure :
#: une requête venue d'Internet ne peut donc jamais faire croire ce qu'elle veut.
_DEFAULT_PROXY_NETWORKS: tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...] = (
    tuple(
        ipaddress.ip_network(cidr)
        for cidr in (
            "127.0.0.0/8",
            "::1/128",
            "10.0.0.0/8",
            "172.16.0.0/12",
            "192.168.0.0/16",
            "169.254.0.0/16",
            "fc00::/7",
            "fe80::/10",
        )
    )
)

#: Mémoire du dernier découpage de ``OPM_TRUSTED_PROXY_IPS`` : (brut, réseaux).
_proxy_networks_cache: (
    tuple[str, tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]] | None
) = None


def trusted_proxy_networks() -> tuple[
    ipaddress.IPv4Network | ipaddress.IPv6Network, ...
]:
    """Réseaux autorisés à écrire ``X-Forwarded-For`` (``OPM_TRUSTED_PROXY_IPS``).

    Adresses ou préfixes CIDR séparés par des virgules. Liste vide ou totalement
    illisible : repli sur :data:`_DEFAULT_PROXY_NETWORKS`. Ce repli est un choix
    de disponibilité — ne faire confiance à personne ferait porter à toutes les
    requêtes l'adresse du proxy, et cinq connexions par minute suffiraient à
    bloquer le serveur entier.
    """
    global _proxy_networks_cache
    raw = str(setting("trusted_proxy_ips", "")).strip()
    if _proxy_networks_cache is not None and _proxy_networks_cache[0] == raw:
        return _proxy_networks_cache[1]

    parsed: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        try:
            parsed.append(ipaddress.ip_network(item, strict=False))
        except ValueError:
            logger.error(
                "OPM_TRUSTED_PROXY_IPS : entrée illisible ignorée (%r).", item
            )
    networks = tuple(parsed) or _DEFAULT_PROXY_NETWORKS
    _proxy_networks_cache = (raw, networks)
    return networks


def trusted_hops() -> int:
    """Nombre de proxys de confiance devant nous (``OPM_TRUSTED_PROXIES``).

    Un seul par défaut : le nginx du serveur. Deux si un service de bordure
    (Cloudflare…) le précède, et ainsi de suite. Jamais moins de 1 : à zéro, on
    lirait la gauche de la chaîne, c'est-à-dire la valeur écrite par le client.
    """
    try:
        hops = int(setting("trusted_proxies", 1))
    except (TypeError, ValueError):
        logger.warning("OPM_TRUSTED_PROXIES est illisible : repli sur 1 saut.")
        return 1
    return max(1, min(hops, _MAX_TRUSTED_HOPS))


def _parse_ip(value: str) -> str | None:
    """Normalise une adresse d'en-tête, avec ou sans port (``[::1]:443``…)."""
    candidate = value.strip()
    if not candidate:
        return None
    if candidate.startswith("["):  # [2001:db8::1]:443
        candidate = candidate[1:].partition("]")[0]
    elif candidate.count(":") == 1:  # 203.0.113.7:443 (une IPv6 en a plusieurs)
        candidate = candidate.partition(":")[0]
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return None


def _is_trusted_proxy(address: str) -> bool:
    """L'adresse qui nous parle en direct est-elle l'un de nos proxys ?"""
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return False
    return any(parsed in network for network in trusted_proxy_networks())


def client_ip(request: Request) -> str:
    """Adresse IP de l'appelant, telle que la limitation de débit doit la compter.

    ``X-Forwarded-For`` est **écrit par le client** ; il n'est donc lu que si
    deux conditions sont réunies :

    1. ``OPM_TRUST_PROXY_HEADERS`` est vrai — il y a bien un proxy devant nous ;
    2. l'adresse qui ouvre la connexion appartient à ``OPM_TRUSTED_PROXY_IPS``
       (par défaut : boucle locale et réseaux privés). Un client qui atteint le
       serveur en direct ne peut donc rien affirmer sur sa propre adresse.

    La valeur retenue est lue **en partant de la droite**, en sautant
    ``OPM_TRUSTED_PROXIES`` entrées. C'est le point de la faille corrigée ici :
    nginx *ajoute* l'adresse réelle à la fin de la chaîne, si bien que la
    première entrée — celle que lisait la version précédente — est exactement
    celle que l'attaquant a écrite. En envoyant ``X-Forwarded-For: 203.0.113.7``
    puis ``…8``, ``…9``, il obtenait un compartiment neuf à chaque tentative et
    aucune limite par IP ne s'appliquait plus.

    Une chaîne plus courte que le nombre de sauts annoncé est un en-tête
    suspect : il est ignoré, et l'adresse de connexion directe fait foi.
    """
    direct = request.client.host if request.client else None

    if not setting("trust_proxy_headers", False):
        return direct or "inconnu"

    if direct is None or not _is_trusted_proxy(direct):
        # Requête arrivée hors de nos proxys : ses en-têtes ne valent rien.
        logger.debug(
            "En-têtes de proxy ignorés : %s n'est pas un proxy de confiance.", direct
        )
        return direct or "inconnu"

    hops = trusted_hops()
    parts = [
        part.strip()
        for part in request.headers.get("x-forwarded-for", "").split(",")
        if part.strip()
    ]
    if len(parts) >= hops:
        candidate = _parse_ip(parts[-hops])
        if candidate is not None:
            return candidate
        logger.debug("X-Forwarded-For inexploitable à %d saut(s).", hops)
    elif parts:
        logger.debug(
            "X-Forwarded-For à %d entrée(s) pour %d saut(s) annoncé(s) : ignoré.",
            len(parts),
            hops,
        )

    # X-Real-IP ne porte qu'une valeur, posée par le proxy lui-même : elle est
    # acceptable telle quelle maintenant que le pair direct est de confiance.
    real_ip = _parse_ip(request.headers.get("x-real-ip") or "")
    if real_ip is not None:
        return real_ip

    return direct or "inconnu"


def _rule(name: str) -> Rule:
    try:
        return RULES[name]
    except KeyError:
        raise KeyError(f"Règle de limitation inconnue : {name!r}") from None


def _too_many(name: str, result: RateLimitResult) -> ApiError:
    """Construit l'erreur 429 normalisée avec son en-tête ``Retry-After``."""
    seconds = result.retry_after_seconds
    logger.info("Limite %s atteinte, blocage pour %ds.", name, seconds)
    return ApiError(
        "rate_limited",
        f"Trop de tentatives. Réessayez dans {seconds} seconde"
        f"{'s' if seconds > 1 else ''}.",
        status_code=429,
        details={"retry_after": seconds, "limit": result.limit},
        headers={"Retry-After": str(seconds)},
    )


async def enforce(name: str, identifier: str) -> None:
    """Applique une règle nommée à un identifiant (IP ou compte).

    À utiliser dans les services pour les règles à portée ``account``, dont la
    clé n'est connue qu'après lecture du corps de la requête.

    :raises ApiError: 429 ``rate_limited`` si la limite est dépassée.
    """
    if not enabled():
        return
    rule = _rule(name)
    result = await get_limiter().hit(f"{name}:{identifier}", rule)
    if not result.allowed:
        raise _too_many(name, result)


class RateLimit:
    """Dépendance FastAPI appliquant une ou plusieurs règles à portée ``ip``.

    .. code-block:: python

        @router.post("/auth/login", dependencies=[Depends(RateLimit("auth.login.ip"))])
        async def login(...): ...
    """

    def __init__(self, *names: str) -> None:
        if not names:
            raise ValueError("Indiquez au moins une règle.")
        for name in names:
            if _rule(name).scope != "ip":
                raise ValueError(
                    f"La règle {name!r} est à portée « account » : appliquez-la "
                    "avec enforce() une fois le compte identifié."
                )
        self.names = names

    async def __call__(self, request: Request) -> None:
        if not enabled():
            return
        address = client_ip(request)
        for name in self.names:
            await enforce(name, address)


# ``from __future__ import annotations`` transforme toutes les annotations de ce
# module en chaînes. Pour résoudre une chaîne, FastAPI évalue une ForwardRef dans
# les ``__globals__`` de l'objet appelé — or une *instance* de classe n'en a pas.
# L'annotation ``"Request"`` de ``__call__`` resterait donc irrésolue, et FastAPI
# dégraderait silencieusement le paramètre en paramètre de requête : toute route
# protégée répondrait « 422 — query.request: Field required ».
# On repose donc la vraie classe : FastAPI ne convertit en ForwardRef que ce qui
# est encore une chaîne, et laisse passer un type déjà résolu.
RateLimit.__call__.__annotations__["request"] = Request


def rate_limit(*names: str) -> Any:
    """Raccourci : ``dependencies=[rate_limit("auth.login.ip")]``."""
    return Depends(RateLimit(*names))


def limited(
    name: str,
    *,
    key: Callable[..., str],
) -> Callable[[Callable[..., Awaitable[Any]]], Callable[..., Awaitable[Any]]]:
    """Décorateur appliquant une règle à une fonction asynchrone de service.

    ``key`` reçoit les arguments de l'appel sous forme de mots-clés et retourne
    la valeur qui sert de clé de limitation :

    .. code-block:: python

        @limited("auth.login.account", key=lambda **kw: kw["email"].lower())
        async def authenticate(email: str, password: str) -> User: ...
    """

    def decorator(func: Callable[..., Awaitable[Any]]) -> Callable[..., Awaitable[Any]]:
        signature = inspect.signature(func)

        @functools.wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            bound = signature.bind_partial(*args, **kwargs)
            bound.apply_defaults()
            await enforce(name, str(key(**bound.arguments)))
            return await func(*args, **kwargs)

        return wrapper

    return decorator
