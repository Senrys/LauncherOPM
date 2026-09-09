"""Tâches de fond du serveur d'authentification.

Trois boucles, démarrées par le ``lifespan`` de l'application et arrêtées avec
elle :

===========================  ==========  ===================================
Tâche                        Cadence     Rôle
===========================  ==========  ===================================
:func:`ping_and_write_stats` 20 s        relève la fréquentation du serveur
                                         Minecraft et l'écrit dans
                                         ``statistiques`` (``docs/DATA.md`` §4)
:func:`refresh_ownership`    6 h         re-vérifie en lot les rattachements
                                         Microsoft qui expirent bientôt
:func:`purge`                1 h         supprime ce qui a cessé d'exister
                                         (sessions, jetons, demandes)
===========================  ==========  ===================================

**Règle intangible : une tâche de fond ne fait jamais tomber le service.**
Chaque itération est enveloppée dans son propre ``try``/``except`` : une
exception est journalisée, l'itération est perdue, la boucle continue. Seule une
annulation (arrêt de l'application) sort de la boucle.

Branchement dans l'application :

.. code-block:: python

    from contextlib import asynccontextmanager
    from opm_auth.services import tasks

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with tasks.background():
            yield

Les trois coroutines restent appelables une par une — ``opm_auth/cli.py`` s'en
sert pour offrir un ``opm-auth purge`` ou un relevé manuel.

Chaque tâche ouvre **sa propre session** de base de données : elle ne vit pas
dans le cycle d'une requête HTTP, et emprunter la session d'une requête serait
un moyen sûr de la voir mourir sous elle.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import date, timedelta
from typing import TYPE_CHECKING, Any, Final

from sqlalchemy import TextClause, delete, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from opm_auth.config import Settings, get_settings
from opm_auth.db import get_sessionmaker
from opm_auth.models import (
    STATS_ROW_ID,
    McLink,
    PasswordReset,
    RefreshToken,
    Statistiques,
    User,
    YggJoin,
    YggSession,
    utcnow,
)
from opm_auth.services import mcstatus

if TYPE_CHECKING:  # pragma: no cover - visibilité pour les outils d'analyse
    from sqlalchemy.sql.expression import Executable

logger = logging.getLogger(__name__)

__all__ = [
    "BackgroundLoops",
    "OWNERSHIP_HORIZON",
    "PURGE_INTERVAL",
    "RECORD_DATE_FORMAT",
    "REFRESH_TOKEN_GRACE",
    "background",
    "manager",
    "ping_and_write_stats",
    "purge",
    "refresh_ownership",
    "set_ownership_refresher",
    "start",
    "stop",
]

# --------------------------------------------------------------------------- #
# Réglages fixes (ce qui n'a pas vocation à varier d'une installation à l'autre)
# --------------------------------------------------------------------------- #

#: Intervalle entre deux passes de re-vérification de possession Microsoft.
OWNERSHIP_INTERVAL: Final[float] = 6 * 3600.0

#: Fenêtre d'anticipation : on rafraîchit ce qui expire dans moins de trois
#: jours, largement avant que le joueur ne s'en aperçoive.
OWNERSHIP_HORIZON: Final[timedelta] = timedelta(days=3)

#: Nombre de rattachements traités par passe. Microsoft n'aime pas les rafales,
#: et six heures plus tard il en reste de toute façon peu à faire.
OWNERSHIP_BATCH: Final[int] = 100

#: Pause entre deux comptes, pour étaler les appels sortants.
OWNERSHIP_DELAY: Final[float] = 1.0

#: Intervalle entre deux purges.
PURGE_INTERVAL: Final[float] = 3600.0

#: Les jetons de renouvellement expirés sont conservés une semaine de plus : la
#: détection de rejeu s'appuie sur leur existence en base. Purger trop tôt, c'est
#: transformer un rejeu détectable en simple « jeton inconnu ».
REFRESH_TOKEN_GRACE: Final[timedelta] = timedelta(days=7)

#: Format écrit dans ``statistiques.record_date``. Le site stocke un
#: ``varchar(50)`` libre : ISO 8601 est le seul choix non ambigu et triable.
#: Une seule constante à changer si le site impose un jour son propre format.
RECORD_DATE_FORMAT: Final[str] = "%Y-%m-%d"

#: Décalages au démarrage : le relevé part tout de suite (l'accueil en a besoin),
#: la purge et la re-vérification attendent que l'application respire.
_INITIAL_DELAYS: Final[dict[str, float]] = {
    "statistiques": 0.0,
    "purge": 60.0,
    "possession": 300.0,
}


# --------------------------------------------------------------------------- #
# 1. Relevé de fréquentation
# --------------------------------------------------------------------------- #


async def _server_address(session: AsyncSession, settings: Settings) -> tuple[str, int]:
    """Adresse à interroger : ``statistiques.server_ip``, sinon la configuration."""
    try:
        server_ip = await session.scalar(
            select(Statistiques.server_ip).where(Statistiques.id == STATS_ROW_ID)
        )
    except Exception:  # une base indisponible ne doit pas priver de ping
        logger.warning(
            "Adresse du serveur illisible en base : repli sur OPM_MC_HOST.", exc_info=True
        )
        server_ip = None
    return mcstatus.resolve_target(server_ip, settings=settings)


def _write_stats_statement(settings: Settings) -> TextClause:
    """Construit l'**unique instruction atomique** d'écriture de la fréquentation.

    Le site relève la même chose de son côté : deux écrivains sur une ligne
    unique. ``GREATEST`` et le ``CASE`` garantissent qu'aucun des deux ne peut
    écraser le record établi par l'autre, et qu'aucune lecture-puis-écriture ne
    vient perdre un record en cas de course (``docs/DATA.md`` §4).

    SQLite — utilisé en développement — ne connaît pas ``GREATEST`` : sa
    fonction ``MAX`` à deux arguments fait exactement la même chose.
    """
    greatest = "MAX" if settings.is_sqlite else "GREATEST"
    return text(
        f"""
        UPDATE statistiques
           SET joueurs_en_ligne = :online,
               record_joueurs   = {greatest}(record_joueurs, :online),
               record_date      = CASE WHEN :online > record_joueurs
                                       THEN :today ELSE record_date END
         WHERE id = :row_id
        """
    )


async def ping_and_write_stats(*, settings: Settings | None = None) -> mcstatus.PingResult:
    """Relève la fréquentation du serveur Minecraft et l'écrit dans ``statistiques``.

    Déroulé :

    1. lecture de ``statistiques.server_ip`` (repli : ``OPM_MC_HOST``) ;
    2. *Server List Ping* natif, 3 secondes au plus, résultat mis en cache pour
       ``GET /api/v1/status`` ;
    3. **si et seulement si le ping a réussi**, une seule instruction atomique
       met à jour ``joueurs_en_ligne``, ``record_joueurs`` et ``record_date``.

    Un ping en échec n'écrit **rien** : remplacer une fréquentation connue par un
    zéro sur un simple dépassement de délai afficherait « serveur vide » sur
    l'accueil de tous les joueurs alors que le serveur tourne (``docs/DATA.md`` §4).

    L'écriture entière se coupe par ``OPM_STATS_WRITE`` : le relevé continue
    alors d'alimenter l'API, mais le site reste seul maître de la table.
    """
    config = settings or get_settings()
    factory = get_sessionmaker()

    async with factory() as session:
        host, port = await _server_address(session, config)
        result = await mcstatus.refresh(host, port, settings=config)

        if not result.online:
            logger.info(
                "Serveur %s injoignable (%s) : aucune écriture dans « statistiques ».",
                result.address,
                result.error or "motif inconnu",
            )
            return result

        if not config.stats_write:
            logger.debug(
                "OPM_STATS_WRITE est faux : %d joueur(s) relevé(s), rien n'est écrit.",
                result.players_online,
            )
            return result

        await session.execute(
            _write_stats_statement(config),
            {
                "online": result.players_online,
                "today": date.today().strftime(RECORD_DATE_FORMAT),
                "row_id": STATS_ROW_ID,
            },
        )
        await session.commit()

    logger.debug(
        "Fréquentation écrite : %d/%d joueur(s) sur %s (%s ms).",
        result.players_online,
        result.players_max,
        result.address,
        result.latency_ms,
    )
    return result


# --------------------------------------------------------------------------- #
# 2. Re-vérification de possession Microsoft
# --------------------------------------------------------------------------- #

#: Signature du vérificateur : il reçoit la session et le compte à re-vérifier.
OwnershipRefresher = Callable[[AsyncSession, User], Awaitable[Any]]

_ownership_refresher: OwnershipRefresher | None = None


def set_ownership_refresher(refresher: OwnershipRefresher | None) -> None:
    """Remplace le vérificateur de possession. **Réservé aux tests.**"""
    global _ownership_refresher
    _ownership_refresher = refresher


async def _default_ownership_refresher(session: AsyncSession, user: User) -> Any:
    """Vérificateur par défaut : la chaîne Microsoft de ``services.microsoft``.

    L'import est différé pour deux raisons : éviter un cycle entre services, et
    ne pas faire dépendre le démarrage des tâches de fond d'un module qui parle
    à un tiers.
    """
    from opm_auth.services import microsoft

    return await microsoft.refresh_link(session, user, force=True)


async def refresh_ownership(*, settings: Settings | None = None) -> int:
    """Re-vérifie en lot les possessions Minecraft qui expirent bientôt.

    Le joueur n'est jamais réveillé : tout se passe entre le serveur d'auth et
    Microsoft, avec le ``refresh_token`` chiffré au repos. L'intérêt est simple —
    quand la vérification d'un joueur arrive à échéance, elle a déjà été
    renouvelée trois jours plus tôt, et une panne de Microsoft ce jour-là ne
    l'empêche pas de jouer (``docs/DATA.md`` §7).

    Un échec est **sans conséquence pour le joueur** : la preuve existante est
    conservée par ``services.microsoft``, et la passe suivante réessaiera.

    :returns: nombre de rattachements effectivement re-vérifiés.
    """
    config = settings or get_settings()
    refresher = _ownership_refresher or _default_ownership_refresher
    horizon = utcnow() + OWNERSHIP_HORIZON
    factory = get_sessionmaker()

    async with factory() as session:
        user_ids = list(
            await session.scalars(
                select(McLink.user_id)
                .where(McLink.expires_at <= horizon)
                .order_by(McLink.expires_at)
                .limit(OWNERSHIP_BATCH)
            )
        )

    if not user_ids:
        logger.debug("Aucune possession Microsoft à re-vérifier.")
        return 0

    logger.info("Re-vérification de %d rattachement(s) Microsoft.", len(user_ids))
    renewed = 0

    for index, user_id in enumerate(user_ids):
        if index:
            # On étale les appels sortants : cent comptes d'un coup ressemblent
            # à une attaque vus de chez Microsoft.
            await asyncio.sleep(OWNERSHIP_DELAY)
        try:
            async with factory() as session:
                user = await session.scalar(
                    select(User)
                    .where(User.id == user_id)
                    .options(selectinload(User.mc_link))
                )
                if user is None or user.mc_link is None:
                    continue
                await refresher(session, user)
                renewed += 1
        except asyncio.CancelledError:
            raise
        except Exception:  # un compte en échec n'arrête pas le lot
            logger.warning(
                "Re-vérification impossible pour le compte %s : la preuve en place "
                "est conservée, nouvelle tentative à la prochaine passe.",
                user_id,
                exc_info=True,
            )

    logger.info("Possession re-vérifiée pour %d compte(s) sur %d.", renewed, len(user_ids))
    return renewed


# --------------------------------------------------------------------------- #
# 3. Purge
# --------------------------------------------------------------------------- #


async def _purge_step(session: AsyncSession, label: str, statement: Executable) -> int:
    """Exécute une suppression, la valide, et n'interrompt jamais les suivantes."""
    try:
        result = await session.execute(statement.execution_options(synchronize_session=False))
        await session.commit()
    except asyncio.CancelledError:
        raise
    except Exception:  # une purge partielle vaut mieux qu'aucune
        await session.rollback()
        logger.warning("Purge « %s » impossible.", label, exc_info=True)
        return 0

    # ``rowcount`` n'existe que sur le résultat d'un curseur : on le lit
    # défensivement, un pilote exotique pourrait ne pas le fournir.
    removed = int(getattr(result, "rowcount", 0) or 0)
    if removed:
        logger.info("Purge « %s » : %d ligne(s) supprimée(s).", label, removed)
    return removed


async def purge(*, settings: Settings | None = None) -> dict[str, int]:
    """Supprime ce qui a cessé d'exister.

    * ``ygg_session`` — sessions de jeu expirées (24 h de durée de vie) ;
    * ``ygg_join`` — annonces d'arrivée de plus de ``OPM_JOIN_TTL_SECONDS``
      (30 s) : elles ne servent qu'entre le client et le serveur Minecraft ;
    * ``auth_password_reset`` — demandes consommées ou périmées ;
    * ``auth_refresh_token`` — jetons expirés depuis plus de
      :data:`REFRESH_TOKEN_GRACE`.

    Chaque suppression est validée séparément : si l'une échoue, les autres
    aboutissent quand même.

    :returns: nombre de lignes supprimées, par table.
    """
    config = settings or get_settings()
    now = utcnow()
    join_cutoff = now - config.join_ttl
    token_cutoff = now - REFRESH_TOKEN_GRACE
    factory = get_sessionmaker()
    removed: dict[str, int] = {}

    async with factory() as session:
        removed["ygg_session"] = await _purge_step(
            session,
            "sessions de jeu expirées",
            delete(YggSession).where(YggSession.expires_at < now),
        )
        removed["ygg_join"] = await _purge_step(
            session,
            "annonces d'arrivée périmées",
            delete(YggJoin).where(YggJoin.created_at < join_cutoff),
        )
        removed["auth_password_reset"] = await _purge_step(
            session,
            "demandes de réinitialisation",
            delete(PasswordReset).where(
                or_(PasswordReset.used_at.is_not(None), PasswordReset.expires_at < now)
            ),
        )

        # Les jetons de renouvellement se pointent les uns les autres par
        # ``replaced_by`` (c'est ainsi qu'une famille se reconstitue). Supprimer
        # une cible encore référencée violerait la clé étrangère : on détache
        # d'abord les pointeurs, on supprime ensuite.
        await _purge_step(
            session,
            "chaînage des jetons expirés",
            update(RefreshToken)
            .where(
                RefreshToken.replaced_by.in_(
                    select(RefreshToken.id).where(RefreshToken.expires_at < token_cutoff)
                )
            )
            .values(replaced_by=None),
        )
        removed["auth_refresh_token"] = await _purge_step(
            session,
            "jetons de renouvellement expirés",
            delete(RefreshToken).where(RefreshToken.expires_at < token_cutoff),
        )

    return removed


# --------------------------------------------------------------------------- #
# Ordonnanceur
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class _Loop:
    """Description d'une boucle périodique."""

    name: str
    interval: float
    action: Callable[[], Awaitable[Any]]
    initial_delay: float = 0.0


async def _run_loop(loop: _Loop) -> None:
    """Exécute une action à intervalle régulier, sans jamais s'arrêter sur erreur.

    L'action est appelée **dans** un ``try``, la temporisation **en dehors** :
    une exception métier n'interrompt pas la boucle, tandis qu'une annulation
    (arrêt de l'application) la termine proprement.
    """
    if loop.initial_delay > 0:
        await asyncio.sleep(loop.initial_delay)

    logger.info("Tâche de fond « %s » démarrée (toutes les %.0f s).", loop.name, loop.interval)
    while True:
        started = time.monotonic()
        try:
            await loop.action()
        except asyncio.CancelledError:
            raise
        except Exception:  # c'est tout l'objet de cette boucle
            logger.exception(
                "Tâche de fond « %s » : itération en échec, la boucle continue.", loop.name
            )
        # La cadence est comptée depuis le début de l'itération : une passe
        # lente ne décale pas indéfiniment les suivantes.
        await asyncio.sleep(max(1.0, loop.interval - (time.monotonic() - started)))


class BackgroundLoops:
    """Groupe de boucles périodiques, démarrées et arrêtées ensemble.

    Le nom évite volontairement ``BackgroundTasks`` : c'est déjà celui d'un objet
    de FastAPI, qui n'a rien à voir (il exécute un travail après une réponse HTTP).
    """

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()
        self._tasks: list[asyncio.Task[None]] = []

    @property
    def running(self) -> bool:
        """Au moins une boucle est-elle en vie ?"""
        return any(not task.done() for task in self._tasks)

    def _loops(self) -> list[_Loop]:
        """Boucles à lancer, d'après la configuration."""
        return [
            _Loop(
                name="statistiques",
                interval=float(self._settings.stats_interval),
                action=ping_and_write_stats,
                initial_delay=_INITIAL_DELAYS["statistiques"],
            ),
            _Loop(
                name="possession",
                interval=OWNERSHIP_INTERVAL,
                action=refresh_ownership,
                initial_delay=_INITIAL_DELAYS["possession"],
            ),
            _Loop(
                name="purge",
                interval=PURGE_INTERVAL,
                action=purge,
                initial_delay=_INITIAL_DELAYS["purge"],
            ),
        ]

    def start(self) -> BackgroundLoops:
        """Démarre les boucles. Appel idempotent."""
        if self._tasks:
            return self
        for loop in self._loops():
            self._tasks.append(asyncio.create_task(_run_loop(loop), name=f"opm.{loop.name}"))
        return self

    async def stop(self) -> None:
        """Annule les boucles et attend leur fin.

        L'attente est bornée : un arrêt d'application ne doit pas rester
        suspendu parce qu'un ping traîne.
        """
        if not self._tasks:
            return
        for task in self._tasks:
            task.cancel()
        try:
            await asyncio.wait_for(
                asyncio.gather(*self._tasks, return_exceptions=True), timeout=10.0
            )
        except TimeoutError:  # pragma: no cover - arrêt forcé
            logger.warning("Certaines tâches de fond ne se sont pas arrêtées à temps.")
        self._tasks.clear()
        logger.info("Tâches de fond arrêtées.")


_manager: BackgroundLoops | None = None


def manager() -> BackgroundLoops | None:
    """Groupe de tâches actuellement installé, ou ``None``."""
    return _manager


def start(settings: Settings | None = None) -> BackgroundLoops:
    """Démarre les tâches de fond du processus courant."""
    global _manager
    if _manager is None:
        _manager = BackgroundLoops(settings)
    return _manager.start()


async def stop() -> None:
    """Arrête les tâches de fond du processus courant."""
    global _manager
    if _manager is not None:
        await _manager.stop()
        _manager = None


@asynccontextmanager
async def background(settings: Settings | None = None) -> AsyncIterator[BackgroundLoops]:
    """Gestionnaire de contexte à utiliser dans le ``lifespan`` de l'application.

    .. code-block:: python

        @asynccontextmanager
        async def lifespan(app: FastAPI):
            async with tasks.background():
                yield
    """
    tasks_group = start(settings)
    try:
        yield tasks_group
    finally:
        await stop()
