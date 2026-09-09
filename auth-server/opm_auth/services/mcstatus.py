"""Ping du serveur Minecraft — *Server List Ping* natif, sans dépendance externe.

Ce module parle directement le protocole que le client Minecraft utilise quand
il affiche la ligne d'un serveur dans sa liste : une poignée de main TCP, une
requête de statut, une réponse JSON. Trois raisons de l'écrire à la main plutôt
que d'ajouter une bibliothèque :

* le protocole tient en cinquante lignes (VarInt, chaîne UTF-8, entier court) ;
* une dépendance de plus, c'est une surface d'attaque et une mise à jour de plus
  sur un service qui doit être au moins aussi disponible que le serveur de jeu ;
* nous avons besoin d'un contrôle fin du délai maximal : un ping lent ne doit
  jamais retarder l'API du launcher.

Déroulé d'un ping (protocole « status », état 1) :

.. code-block:: text

    → handshake   0x00  varint(protocole) string(hôte) ushort(port) varint(1)
    → request     0x00  (corps vide)
    ← response    0x00  string(JSON)

Le JSON contient la description (MOTD), la fréquentation et la version. Le TPS
n'y figure pas : aucun serveur vanilla ne le publie, et il n'est pas dans le
schéma du site — :attr:`PingResult.tps` reste donc à ``None`` tant qu'un plugin
ne l'expose pas (``docs/DATA.md`` §4).

Utilisation :

.. code-block:: python

    from opm_auth.services import mcstatus

    resultat = await mcstatus.current()          # cache de 20 s
    if resultat.online:
        print(resultat.players_online, "joueurs")

**Cache.** Le dernier relevé est conservé en mémoire pendant
``OPM_STATS_INTERVAL`` secondes (20 par défaut, ``docs/DATA.md`` §5). Les appels
concurrents se partagent le même ping : un verrou évite qu'une rafale de
requêtes ouvre vingt connexions au serveur de jeu.

**Résolution SRV.** Elle n'est volontairement *pas* implémentée : un résolveur
DNS maison mal écrit est pire que pas de résolveur du tout. ``server_ip`` doit
donc porter l'hôte réel, éventuellement suivi du port (``exemple.fr:25566``).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import struct
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final

from opm_auth.config import Settings, get_settings
from opm_auth.models import utcnow

logger = logging.getLogger(__name__)

__all__ = [
    "DEFAULT_PORT",
    "DEFAULT_TIMEOUT",
    "PingResult",
    "ProtocolError",
    "cached",
    "current",
    "invalidate",
    "parse_status",
    "ping",
    "refresh",
    "resolve_target",
    "set_cached",
]

# --------------------------------------------------------------------------- #
# Constantes du protocole
# --------------------------------------------------------------------------- #

#: Port par défaut d'un serveur Minecraft Java Edition.
DEFAULT_PORT: Final[int] = 25565

#: Délai maximal d'un ping complet, en secondes (``docs/DATA.md`` §5).
DEFAULT_TIMEOUT: Final[float] = 3.0

#: Version de protocole annoncée dans la poignée de main. ``-1`` est la valeur
#: conventionnelle d'un simple ping : elle indique « je ne cherche pas à jouer »,
#: et aucun serveur ne refuse un statut sur ce motif.
PROTOCOL_VERSION: Final[int] = -1

#: État demandé après la poignée de main : 1 = statut, 2 = connexion.
_STATE_STATUS: Final[int] = 1

#: Taille maximale acceptée pour un paquet de réponse (2 Mio). Une icône de
#: serveur pèse quelques dizaines de kilo-octets ; au-delà, c'est une anomalie
#: et nous refusons de remplir la mémoire pour un hôte hostile.
_MAX_PACKET: Final[int] = 2 * 1024 * 1024

#: Un VarInt tient sur cinq octets au plus.
_MAX_VARINT_BYTES: Final[int] = 5

#: Codes de couleur hérités (``§a``, ``§l``…) à retirer du MOTD.
_LEGACY_COLOR_RE: Final[re.Pattern[str]] = re.compile(r"§[0-9A-FK-ORXa-fk-orx]")

#: Blancs multiples et retours à la ligne du MOTD, ramenés à une seule espace.
_WHITESPACE_RE: Final[re.Pattern[str]] = re.compile(r"\s+")

#: Longueur maximale conservée pour le MOTD (l'accueil n'affiche qu'une ligne).
_MOTD_MAX_LENGTH: Final[int] = 250


class ProtocolError(RuntimeError):
    """Réponse illisible : ce n'est pas un serveur Minecraft, ou il est cassé."""


# --------------------------------------------------------------------------- #
# Résultat d'un ping
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class PingResult:
    """Photographie du serveur de jeu à un instant donné.

    :ivar online: vrai seulement si le serveur a répondu un statut exploitable.
        **C'est la condition d'écriture** dans ``statistiques`` : sur un échec,
        on ne remplace pas une fréquentation connue par un zéro
        (``docs/DATA.md`` §4).
    :ivar tps: jamais renseigné par le protocole vanilla ; le champ existe pour
        le jour où un plugin le publiera dans le JSON de statut.
    :ivar error: motif technique de l'échec (``timeout``, ``refused``…), utile
        au journal, jamais montré au joueur.
    """

    host: str
    port: int
    online: bool = False
    players_online: int = 0
    players_max: int = 0
    motd: str | None = None
    latency_ms: int | None = None
    version_name: str | None = None
    protocol: int | None = None
    tps: float | None = None
    checked_at: datetime | None = None
    error: str | None = None

    @classmethod
    def offline(cls, host: str, port: int, *, error: str) -> PingResult:
        """Construit un résultat d'échec, horodaté."""
        return cls(host=host, port=port, online=False, error=error, checked_at=utcnow())

    @property
    def address(self) -> str:
        """Adresse lisible du serveur interrogé (``hôte:port``)."""
        return f"{self.host}:{self.port}"

    def age_seconds(self, *, now: datetime | None = None) -> float:
        """Ancienneté du relevé, en secondes (``inf`` s'il n'est pas horodaté)."""
        if self.checked_at is None:
            return float("inf")
        return ((now or utcnow()) - self.checked_at).total_seconds()


# --------------------------------------------------------------------------- #
# Encodage et décodage du protocole
# --------------------------------------------------------------------------- #


def _varint(value: int) -> bytes:
    """Encode un entier en VarInt (base 128, petit-boutiste, 7 bits utiles).

    Les valeurs négatives sont d'abord ramenées à leur représentation non signée
    sur 32 bits, comme le fait Java : ``-1`` s'écrit donc sur cinq octets.
    """
    if value < 0:
        value += 1 << 32
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def _string(value: str) -> bytes:
    """Encode une chaîne : longueur en VarInt, puis les octets UTF-8."""
    raw = value.encode("utf-8")
    return _varint(len(raw)) + raw


def _packet(payload: bytes) -> bytes:
    """Préfixe un paquet de sa longueur totale, comme l'exige le protocole."""
    return _varint(len(payload)) + payload


async def _read_varint(reader: asyncio.StreamReader) -> int:
    """Lit un VarInt octet par octet sur le flux."""
    value = 0
    for index in range(_MAX_VARINT_BYTES):
        chunk = await reader.readexactly(1)
        byte = chunk[0]
        value |= (byte & 0x7F) << (7 * index)
        if not byte & 0x80:
            # Retour au domaine signé sur 32 bits (le protocole est du Java).
            return value - (1 << 32) if value >= 1 << 31 else value
    raise ProtocolError("VarInt de plus de cinq octets : flux non conforme.")


def _flatten_component(node: Any) -> str:
    """Aplatit un composant de discussion Minecraft en texte brut.

    La description d'un serveur est soit une chaîne, soit un arbre
    ``{"text": …, "extra": [...]}`` — parfois profondément imbriqué. On ne garde
    que le texte : ni couleur, ni gras, ni événement de survol.
    """
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, (int, float, bool)):
        return str(node)
    if isinstance(node, list):
        return "".join(_flatten_component(child) for child in node)
    if isinstance(node, dict):
        text = str(node.get("text") or "")
        if not text and node.get("translate"):
            text = str(node["translate"])
        extra = node.get("extra")
        if extra:
            text += _flatten_component(extra)
        return text
    return ""


def _clean_motd(node: Any) -> str | None:
    """Transforme la description du serveur en une ligne affichable."""
    text = _LEGACY_COLOR_RE.sub("", _flatten_component(node))
    text = _WHITESPACE_RE.sub(" ", text).strip()
    if not text:
        return None
    return text if len(text) <= _MOTD_MAX_LENGTH else text[:_MOTD_MAX_LENGTH].rstrip() + "…"


def _positive_int(value: Any) -> int:
    """Lit un entier de la réponse en refusant les valeurs absurdes."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, number)


def parse_status(payload: Any, *, host: str, port: int, latency_ms: int) -> PingResult:
    """Traduit le JSON de statut en :class:`PingResult`.

    Tolérant par construction : les serveurs moddés ajoutent, retirent ou
    renomment des champs, et un statut partiel vaut mieux qu'une exception.
    """
    if not isinstance(payload, dict):
        raise ProtocolError("Le statut renvoyé n'est pas un objet JSON.")

    players = payload.get("players")
    players = players if isinstance(players, dict) else {}
    version = payload.get("version")
    version = version if isinstance(version, dict) else {}

    protocol = version.get("protocol")
    return PingResult(
        host=host,
        port=port,
        online=True,
        players_online=_positive_int(players.get("online")),
        players_max=_positive_int(players.get("max")),
        motd=_clean_motd(payload.get("description")),
        latency_ms=max(0, latency_ms),
        version_name=(str(version["name"]).strip() or None) if version.get("name") else None,
        protocol=protocol if isinstance(protocol, int) else None,
        checked_at=utcnow(),
    )


# --------------------------------------------------------------------------- #
# Ping
# --------------------------------------------------------------------------- #


async def _exchange(host: str, port: int, protocol: int) -> tuple[Any, int]:
    """Ouvre la connexion, échange les deux paquets, renvoie (JSON, latence ms)."""
    reader, writer = await asyncio.open_connection(host, port)
    try:
        handshake = (
            b"\x00"
            + _varint(protocol)
            + _string(host)
            + struct.pack(">H", port)
            + _varint(_STATE_STATUS)
        )
        writer.write(_packet(handshake))
        writer.write(_packet(b"\x00"))  # requête de statut, corps vide

        started = time.perf_counter()
        await writer.drain()

        length = await _read_varint(reader)
        if length <= 0 or length > _MAX_PACKET:
            raise ProtocolError(f"Longueur de paquet hors limites : {length}.")
        body = await reader.readexactly(length)
        latency_ms = round((time.perf_counter() - started) * 1000)

        offset = 0
        packet_id = body[offset]
        # L'identifiant de paquet est lui-même un VarInt, mais 0x00 tient sur un
        # octet : toute autre valeur signale un serveur qui ne suit pas le protocole.
        if packet_id != 0x00:
            raise ProtocolError(f"Paquet de réponse inattendu : 0x{packet_id:02x}.")
        offset += 1

        json_length = 0
        for index in range(_MAX_VARINT_BYTES):
            byte = body[offset]
            offset += 1
            json_length |= (byte & 0x7F) << (7 * index)
            if not byte & 0x80:
                break
        else:
            raise ProtocolError("Longueur de chaîne JSON illisible.")

        raw = body[offset : offset + json_length]
        if len(raw) != json_length:
            raise ProtocolError("Réponse JSON tronquée.")
        return json.loads(raw.decode("utf-8", errors="replace")), latency_ms
    finally:
        # ``close()`` suffit et ne bloque pas. Attendre ``wait_closed()`` ici
        # avalerait l'annulation posée par ``asyncio.wait_for`` lorsqu'un délai
        # est dépassé — et le dépassement serait perdu.
        writer.close()


async def ping(
    host: str,
    port: int = DEFAULT_PORT,
    *,
    timeout: float | None = None,
    protocol: int = PROTOCOL_VERSION,
) -> PingResult:
    """Interroge un serveur Minecraft. **Ne lève jamais.**

    Un échec — hôte inconnu, connexion refusée, délai dépassé, réponse
    illisible — est un résultat comme un autre : :attr:`PingResult.online` vaut
    ``False`` et :attr:`PingResult.error` porte le motif. C'est ce qui permet
    aux appelants (l'API comme la tâche de fond) de décider sans ``try``.

    :param timeout: délai maximal en secondes (:data:`DEFAULT_TIMEOUT` par défaut).
    """
    delay = DEFAULT_TIMEOUT if timeout is None else max(0.1, timeout)
    try:
        payload, latency_ms = await asyncio.wait_for(_exchange(host, port, protocol), delay)
    except asyncio.CancelledError:
        raise
    except TimeoutError:
        logger.debug("Ping de %s:%s : délai de %.1fs dépassé.", host, port, delay)
        return PingResult.offline(host, port, error="timeout")
    except (ConnectionRefusedError, ConnectionResetError):
        logger.debug("Ping de %s:%s : connexion refusée.", host, port)
        return PingResult.offline(host, port, error="refused")
    except asyncio.IncompleteReadError:
        logger.debug("Ping de %s:%s : le serveur a coupé la connexion.", host, port)
        return PingResult.offline(host, port, error="truncated")
    except OSError as exc:
        logger.debug("Ping de %s:%s : %s", host, port, exc)
        return PingResult.offline(host, port, error="unreachable")
    except (ProtocolError, json.JSONDecodeError, IndexError, struct.error) as exc:
        logger.warning("Ping de %s:%s : réponse non conforme (%s).", host, port, exc)
        return PingResult.offline(host, port, error="protocol")

    try:
        return parse_status(payload, host=host, port=port, latency_ms=latency_ms)
    except ProtocolError as exc:
        logger.warning("Statut de %s:%s illisible : %s", host, port, exc)
        return PingResult.offline(host, port, error="protocol")


# --------------------------------------------------------------------------- #
# Adresse du serveur
# --------------------------------------------------------------------------- #


def resolve_target(
    server_ip: str | None = None,
    *,
    settings: Settings | None = None,
) -> tuple[str, int]:
    """Détermine l'hôte et le port à interroger.

    ``statistiques.server_ip`` fait autorité (``docs/DATA.md`` §1) ; il peut
    porter un port (``exemple.fr:25566``) ou une adresse IPv6 entre crochets.
    Quand il est vide ou inexploitable, on retombe sur ``OPM_MC_HOST`` et
    ``OPM_MC_PORT``.
    """
    config = settings or get_settings()
    fallback = (config.mc_host.strip() or "localhost", config.mc_port)

    raw = (server_ip or "").strip()
    if not raw:
        return fallback

    # Une adresse collée depuis le site peut porter un schéma ou un chemin.
    raw = raw.removeprefix("minecraft://").split("/", 1)[0].strip()
    if not raw:
        return fallback

    host, port = raw, DEFAULT_PORT
    if raw.startswith("["):  # IPv6 littérale : [::1]:25565
        closing = raw.find("]")
        if closing == -1:
            return fallback
        host = raw[1:closing]
        remainder = raw[closing + 1 :]
        if remainder.startswith(":"):
            port = _parse_port(remainder[1:], fallback[1])
    elif raw.count(":") == 1:
        host, _, tail = raw.partition(":")
        port = _parse_port(tail, fallback[1])
    elif raw.count(":") > 1:  # IPv6 sans crochets : aucun port possible
        host = raw

    host = host.strip()
    return (host, port) if host else fallback


def _parse_port(value: str, fallback: int) -> int:
    """Lit un numéro de port, ou retombe sur celui de la configuration."""
    try:
        port = int(value.strip())
    except (TypeError, ValueError):
        return fallback
    return port if 1 <= port <= 65535 else fallback


# --------------------------------------------------------------------------- #
# Cache mémoire (20 s par défaut)
# --------------------------------------------------------------------------- #

_last_result: PingResult | None = None
_lock = asyncio.Lock()


def cached() -> PingResult | None:
    """Dernier relevé connu, **sans aucun appel réseau**.

    C'est ce que sert ``GET /api/v1/status`` quand la tâche de fond tourne : la
    réponse est instantanée et le serveur de jeu n'est interrogé qu'une fois
    toutes les ``OPM_STATS_INTERVAL`` secondes, pas une fois par joueur.
    """
    return _last_result


def invalidate() -> None:
    """Oublie le dernier relevé (tests, changement d'adresse du serveur)."""
    global _last_result
    _last_result = None


def _cache_ttl(settings: Settings | None = None) -> float:
    """Durée de vie du relevé : la cadence du ping (``OPM_STATS_INTERVAL``)."""
    return float((settings or get_settings()).stats_interval)


async def refresh(
    host: str | None = None,
    port: int | None = None,
    *,
    timeout: float | None = None,
    settings: Settings | None = None,
) -> PingResult:
    """Effectue un ping et met le résultat en cache, quoi qu'il arrive.

    Appelée par la tâche de fond :func:`opm_auth.services.tasks.ping_and_write_stats`
    et par :func:`current` lorsque le cache est périmé.
    """
    global _last_result
    config = settings or get_settings()
    if host is None or port is None:
        # ``resolve_target`` sait détacher un port collé à l'hôte : on lui confie
        # toujours la chaîne complète, sans quoi « exemple.fr:25566 » finirait
        # utilisé tel quel comme nom d'hôte.
        resolved_host, resolved_port = resolve_target(host, settings=config)
        host = resolved_host
        port = resolved_port if port is None else port

    result = await ping(host, port, timeout=timeout)
    _last_result = result
    return result


async def current(
    host: str | None = None,
    port: int | None = None,
    *,
    force: bool = False,
    settings: Settings | None = None,
) -> PingResult:
    """Renvoie un relevé frais, en réutilisant le cache tant qu'il est valide.

    Les appels concurrents ne déclenchent qu'un seul ping : le verrou est pris
    avant de re-vérifier la fraîcheur, si bien que le second appelant repart
    avec le résultat du premier.
    """
    config = settings or get_settings()
    ttl = _cache_ttl(config)

    snapshot = _last_result
    if not force and snapshot is not None and snapshot.age_seconds() < ttl:
        return snapshot

    async with _lock:
        snapshot = _last_result
        if not force and snapshot is not None and snapshot.age_seconds() < ttl:
            return snapshot
        return await refresh(host, port, settings=config)


def set_cached(result: PingResult | None) -> None:
    """Impose un relevé au cache. **Réservé aux tests** et aux scripts de démonstration."""
    global _last_result
    _last_result = result
