"""Routeur du contenu du launcher — ``/api/v1`` (``docs/API.md`` §1.1 et §1.5).

C'est ce routeur qui remplit l'accueil et l'écran Donation de la maquette avec de
**vraies** données, lues dans la base du site :

=============================  ==========================================================
Chemin                         Source réelle
=============================  ==========================================================
``GET /bootstrap``             configuration + ``statistiques`` (adresse, téléchargements)
``GET /news``                  ``article``, ``published_date DESC``
``GET /instances``             ``launcher_instance``
``GET /status``                ping natif du serveur Minecraft + ``statistiques``
``GET /events/next``           ``statistiques.evenement_nom`` / ``evenement_date``
``GET /votes``                 ``statistiques.votes`` / ``votes_objectif``
``GET /donations``             ``statistiques.dons_*`` + paliers calculés
``POST /donations/checkout``   ``OPM_DONATION_URL`` — aucun paiement dans le launcher
``GET /profile/rp``            ``users`` + ``COUNT`` sur ``iles`` via ``equipages``
=============================  ==========================================================

Montage attendu côté application :

.. code-block:: python

    from opm_auth.routers import launcher

    app.include_router(launcher.router, prefix="/api/v1")

Où vit la logique
=================

La convention du projet veut que les routeurs appellent ``services/*``. Aucun
service de contenu n'existe : la lecture est donc rassemblée ici, dans une
section « couche de lecture » nettement séparée des gestionnaires de route, de
sorte qu'un futur ``services/content.py`` se fabrique par simple déplacement de
ce bloc, sans toucher aux routes.

Cache et mode hors ligne
========================

Chaque donnée porte sa propre durée de vie (``docs/DATA.md`` §5) : 60 s pour
``statistiques`` et les instances, 5 minutes pour le journal et le profil RP.
Le cache est en mémoire, par processus — il n'a pas besoin d'être partagé, ces
lectures sont peu coûteuses et strictement publiques.

Quand la base devient injoignable **et** qu'un cache périmé existe, il est
resservi tel quel, marqué ``"stale": true`` dans le corps et
``X-OPM-Stale: 1`` en en-tête : le launcher affiche alors un bandeau discret
« données hors ligne » au lieu d'un écran vide. Sans aucun cache à resservir,
la réponse est un ``503 content_unavailable`` honnête.

Régler ``OPM_CONTENT_CACHE_SECONDS`` à ``0`` désactive complètement ce cache —
pratique en développement pour voir un article apparaître immédiatement.

Ce que ce routeur n'écrit pas
=============================

Rien. Toutes ses routes sont en lecture. Les seules écritures du serveur d'auth
dans les tables du site vivent ailleurs : ``users.derniereconnexion`` à la
connexion, ``users.tempsdejeu`` en fin de partie, et la fréquentation par la
tâche de fond (``docs/DATA.md`` §4).
"""

from __future__ import annotations

import asyncio
import calendar
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date, datetime
from typing import Annotated, Any, Final, Literal

from fastapi import APIRouter, Query, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import func, nulls_last, select
from sqlalchemy.ext.asyncio import AsyncSession

from opm_auth.config import Settings, get_settings
from opm_auth.db import SessionDep
from opm_auth.models import STATS_ROW_ID, Article, Equipage, Ile, Instance, Paiement, Statistiques
from opm_auth.schemas import (
    AuthInfoOut,
    BootstrapOut,
    DonateCheckoutIn,
    DonateCheckoutOut,
    DonationsOut,
    DonationTierOut,
    InstanceOut,
    LauncherInfoOut,
    LinksOut,
    MaintenanceOut,
    NewsItemOut,
    NewsOut,
    NextEventOut,
    ServerInfoOut,
    ServerStatusOut,
    TierState,
    UserProfileOut,
    VotesOut,
)
from opm_auth.security.deps import ApiError, CurrentUser, OptionalUser
from opm_auth.security.ratelimit import enforce
from opm_auth.services import mcstatus, users

logger = logging.getLogger(__name__)

__all__ = ["clear_cache", "router"]

router = APIRouter(tags=["Contenu du launcher"])


# --------------------------------------------------------------------------- #
# Durées de vie (docs/DATA.md §5)
# --------------------------------------------------------------------------- #

#: ``statistiques`` : tuiles, événement, votes, cagnotte, adresse du serveur.
STATS_TTL: Final[float] = 60.0
#: ``article`` : le journal de bord.
NEWS_TTL: Final[float] = 300.0
#: ``launcher_instance`` : profils de jeu.
INSTANCES_TTL: Final[float] = 60.0
#: ``equipages`` / ``iles`` : le sous-titre du personnage.
PROFILE_TTL: Final[float] = 300.0

#: Nombre d'articles gardés en cache : on lit une fois, on tranche ensuite selon
#: le ``limit`` demandé, plutôt qu'une entrée de cache par valeur de ``limit``.
NEWS_CACHE_SIZE: Final[int] = 50

#: Après un échec de lecture, on resert le cache périmé pendant ce délai avant
#: de retenter : inutile de marteler une base déjà à terre.
STALE_RETRY_SECONDS: Final[float] = 5.0

#: En-tête signalant une réponse servie depuis un cache périmé.
STALE_HEADER: Final[str] = "X-OPM-Stale"

#: Paliers de la cagnotte, repris de la maquette (écran Donation). Les
#: récompenses n'ont pas de source en base : seuls les **seuils** sont calculés,
#: depuis ``dons_objectif``. Un palier dont la récompense n'est pas encore
#: arrêtée s'affiche « À déterminer » — jamais une promesse inventée.
DONATION_TIERS: Final[tuple[tuple[str, int, str, str], ...]] = (
    ("palier-1", 25, "À déterminer", "La récompense de ce palier sera annoncée par le staff."),
    ("evenement-rp", 50, "Événement RP surprise", "Animé par le staff, primes doublées."),
    ("ile-avant-premiere", 75, "Île en avant-première", "Ouverture anticipée d'une semaine."),
    ("coffre-tresor", 100, "Coffre du Trésor pour tous", "Et un cosmétique exclusif du mois."),
)


# --------------------------------------------------------------------------- #
# Cache mémoire, avec resservice du périmé
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class _Entry:
    """Une valeur en cache et sa date de péremption (horloge monotone)."""

    value: Any
    expires_at: float
    fetched_at: float


def _unavailable() -> ApiError:
    """Erreur servie quand la base est injoignable et qu'aucun cache n'existe."""
    return ApiError(
        "content_unavailable",
        "Les données du serveur sont momentanément indisponibles.",
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        headers={"Retry-After": "30"},
    )


class _ContentCache:
    """Cache par clé, à durée de vie, qui ressert le périmé en cas de panne.

    Un verrou par clé évite la ruée : cent requêtes simultanées sur un cache
    périmé ne déclenchent qu'**une** lecture en base, les autres attendent son
    résultat.
    """

    def __init__(self) -> None:
        self._entries: dict[str, _Entry] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def _lock(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = self._locks[key] = asyncio.Lock()
        return lock

    def _fresh(self, key: str, ttl: float) -> _Entry | None:
        """Entrée encore valide, ou ``None``."""
        if ttl <= 0:
            return None
        entry = self._entries.get(key)
        return entry if entry is not None and entry.expires_at > time.monotonic() else None

    async def fetch(
        self,
        key: str,
        ttl: float,
        loader: Callable[[], Awaitable[Any]],
    ) -> tuple[Any, bool]:
        """Renvoie ``(valeur, périmée)``.

        :raises ApiError: ``503 content_unavailable`` si la lecture échoue et
            qu'aucune valeur, même périmée, n'est disponible.
        """
        entry = self._fresh(key, ttl)
        if entry is not None:
            return entry.value, False

        async with self._lock(key):
            # Un autre appelant a pu rafraîchir pendant l'attente du verrou.
            entry = self._fresh(key, ttl)
            if entry is not None:
                return entry.value, False

            previous = self._entries.get(key)
            try:
                value = await loader()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # toute panne de lecture
                if previous is None:
                    logger.error("Lecture « %s » impossible, aucun cache à servir.", key)
                    raise _unavailable() from exc
                logger.warning(
                    "Lecture « %s » impossible : le dernier cache connu est resservi "
                    "(réponse marquée « hors ligne »).",
                    key,
                    exc_info=True,
                )
                previous.expires_at = time.monotonic() + STALE_RETRY_SECONDS
                return previous.value, True

            now = time.monotonic()
            self._entries[key] = _Entry(value=value, expires_at=now + ttl, fetched_at=now)
            return value, False

    def clear(self) -> None:
        """Vide le cache (tests, rechargement de configuration)."""
        self._entries.clear()


_cache = _ContentCache()


def clear_cache() -> None:
    """Vide le cache de contenu. **Réservé aux tests et aux scripts.**"""
    _cache.clear()
    mcstatus.invalidate()


def _ttl(base: float, settings: Settings) -> float:
    """Durée de vie effective d'une donnée.

    ``OPM_CONTENT_CACHE_SECONDS = 0`` désactive le cache pour toutes les données
    de contenu : en développement, un article publié apparaît au rechargement
    suivant, sans attendre cinq minutes.
    """
    return 0.0 if settings.content_cache_seconds <= 0 else base


# --------------------------------------------------------------------------- #
# Couche de lecture — les seules requêtes SQL de ce module
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class _Stats:
    """Copie figée de la ligne unique de ``statistiques``.

    On ne met **pas** l'objet SQLAlchemy en cache : il appartient à la session
    de la requête qui l'a lu, et resservir un objet détaché deux minutes plus
    tard est une bonne façon de provoquer une erreur incompréhensible. Cette
    photographie, elle, est immuable et sans attache.

    Les noms de champs sont ceux de la base du site : les fabriques des schémas
    (``NextEventOut.from_stats``, ``VotesOut.from_stats``,
    ``DonationsOut.from_stats``) l'acceptent donc telle quelle.
    """

    joueurs_en_ligne: int
    record_joueurs: int
    record_date: str
    evenement_nom: str
    evenement_date: datetime | None
    votes: int
    votes_objectif: int
    dons_collecte: int
    dons_objectif: int
    donateurs: int
    server_ip: str
    launcher_windows: str
    launcher_mac: str
    launcher_linux: str


async def _load_stats(session: AsyncSession) -> _Stats | None:
    """Lit la ligne unique de ``statistiques`` (``id = 1``)."""
    row = await session.get(Statistiques, STATS_ROW_ID)
    if row is None:
        # Installation dont la ligne ne porterait pas l'identifiant 1 : on prend
        # la première plutôt que d'afficher un accueil vide.
        row = await session.scalar(select(Statistiques).order_by(Statistiques.id).limit(1))
    if row is None:
        logger.warning("La table « statistiques » est vide : l'accueil sera incomplet.")
        return None

    return _Stats(
        joueurs_en_ligne=row.joueurs_en_ligne or 0,
        record_joueurs=row.record_joueurs or 0,
        record_date=row.record_date or "",
        evenement_nom=row.evenement_nom or "",
        evenement_date=row.evenement_date,
        votes=row.votes or 0,
        votes_objectif=row.votes_objectif or 0,
        dons_collecte=row.dons_collecte or 0,
        dons_objectif=row.dons_objectif or 0,
        donateurs=row.donateurs or 0,
        server_ip=row.server_ip or "",
        launcher_windows=row.launcher_windows or "",
        launcher_mac=row.launcher_mac or "",
        launcher_linux=row.launcher_linux or "",
    )


async def _stats(session: AsyncSession) -> tuple[_Stats | None, bool]:
    """``statistiques`` en cache 60 s. Lève ``503`` si rien n'est servable."""
    settings = get_settings()
    return await _cache.fetch("stats", _ttl(STATS_TTL, settings), lambda: _load_stats(session))


#: Cache court de la collecte : après un don, le launcher relit la cagnotte
#: toutes les quelques secondes pour voir sa jauge bouger — 60 s seraient
#: trop longs, mais interroger la base à chaque requête serait absurde.
COLLECTE_TTL: Final[float] = 10.0


@dataclass(slots=True)
class _Collecte:
    """Ce que ``paiements`` a encaissé depuis le premier jour du mois (UTC)."""

    total_cents: int
    count: int


async def _load_collecte(session: AsyncSession) -> _Collecte:
    """Somme et nombre des paiements du mois — dons ET achats de gigots.

    Même règle que ``collecte_du_mois()`` sur le site : l'objectif du mois est
    « ce que Stripe a encaissé », quel que soit le type. Le mois commence au
    premier jour à minuit **UTC**, comme là-bas (``datetime.utcnow()``), pour
    que les deux écrans affichent le même chiffre à toute heure.
    """
    debut = datetime.utcnow().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    row = (
        await session.execute(
            select(
                func.coalesce(func.sum(Paiement.montant_cents), 0),
                func.count(Paiement.id),
            ).where(Paiement.date >= debut)
        )
    ).one()
    return _Collecte(total_cents=int(row[0] or 0), count=int(row[1] or 0))


async def _collecte(session: AsyncSession) -> tuple[_Collecte | None, bool]:
    """La collecte en cache 10 s ; ``None`` si ``paiements`` est illisible.

    Une table absente (site pas encore migré) ou un droit manquant ne doit
    pas casser l'écran : on retombe alors sur ``statistiques`` seule, comme
    avant, et on le dit dans le journal.
    """
    settings = get_settings()
    try:
        return await _cache.fetch(
            "collecte", _ttl(COLLECTE_TTL, settings), lambda: _load_collecte(session)
        )
    except ApiError:
        logger.warning(
            "« paiements » illisible : la cagnotte ne compte que statistiques.dons_collecte. "
            "Vérifiez que la migration « paiements » du site est passée et que le rôle "
            "a le droit SELECT dessus."
        )
        return None, True


async def _stats_soft(session: AsyncSession) -> tuple[_Stats | None, bool]:
    """Comme :func:`_stats`, mais ne fait jamais échouer la requête.

    Réservé à ``/bootstrap`` et ``/status`` : le launcher doit démarrer et
    afficher l'état du serveur même si la base du site est tombée. Les valeurs
    manquantes retombent alors sur la configuration.
    """
    try:
        return await _stats(session)
    except ApiError:
        logger.warning("« statistiques » illisible : repli sur la configuration.")
        return None, True


async def _load_news(session: AsyncSession) -> list[NewsItemOut]:
    """Lit le journal de bord, du plus récent au plus ancien.

    Les articles sans date de publication passent en dernier : ce sont des
    brouillons ou des reprises, ils n'ont rien à faire en une.
    """
    rows = await session.scalars(
        select(Article)
        .order_by(nulls_last(Article.published_date.desc()), Article.id.desc())
        .limit(NEWS_CACHE_SIZE)
    )
    return [NewsItemOut.from_article(article) for article in rows]


async def _news(session: AsyncSession) -> tuple[list[NewsItemOut], bool]:
    """Journal de bord en cache 5 minutes."""
    settings = get_settings()
    return await _cache.fetch("news", _ttl(NEWS_TTL, settings), lambda: _load_news(session))


async def _load_instances(session: AsyncSession) -> list[InstanceOut]:
    """Lit les profils de jeu actifs, dans l'ordre d'affichage voulu."""
    rows = await session.scalars(
        select(Instance)
        .where(Instance.enabled.is_(True))
        .order_by(Instance.sort_order, Instance.name)
    )
    instances = [InstanceOut.from_instance(row) for row in rows]
    if not instances:
        logger.warning(
            "Aucune instance active dans « launcher_instance » : le launcher n'aura "
            "rien à lancer."
        )
    return instances


async def _instances(session: AsyncSession) -> tuple[list[InstanceOut], bool]:
    """Instances en cache 60 s."""
    settings = get_settings()
    return await _cache.fetch(
        "instances", _ttl(INSTANCES_TTL, settings), lambda: _load_instances(session)
    )


async def _load_iles_tenues(session: AsyncSession, equipage: str) -> int:
    """Compte les îles tenues par un équipage.

    Le lien se fait par le **nom** : ``users.equipage`` porte un libellé, pas une
    clé étrangère (c'est le schéma du site). La comparaison est donc insensible
    à la casse et aux espaces de bord, faute de quoi « Les Cœurs Brisés » et
    « les cœurs brisés » compteraient pour deux équipages différents.
    """
    needle = equipage.strip().lower()
    if not needle:
        return 0
    total = await session.scalar(
        select(func.count())
        .select_from(Ile)
        .join(Equipage, Ile.equipage_id == Equipage.id)
        .where(func.lower(func.trim(Equipage.nom)) == needle)
    )
    return int(total or 0)


async def _iles_tenues(session: AsyncSession, equipage: str | None) -> tuple[int, bool]:
    """Nombre d'îles tenues, en cache 5 minutes par équipage."""
    name = (equipage or "").strip()
    if not name:
        return 0, False
    settings = get_settings()
    return await _cache.fetch(
        f"iles:{name.lower()}",
        _ttl(PROFILE_TTL, settings),
        lambda: _load_iles_tenues(session, name),
    )


# --------------------------------------------------------------------------- #
# Mise en forme des réponses
# --------------------------------------------------------------------------- #


def _stale(payload: BaseModel | list[BaseModel]) -> JSONResponse:
    """Sérialise une réponse servie depuis un cache périmé.

    Le corps porte ``"stale": true`` (impossible sur une réponse-liste, qui n'a
    pas d'objet racine) et l'en-tête ``X-OPM-Stale: 1`` — que le launcher lit
    dans les deux cas.
    """
    body = jsonable_encoder(payload, by_alias=True)
    if isinstance(body, dict):
        body["stale"] = True
    return JSONResponse(content=body, headers={STALE_HEADER: "1"})


def _respond(payload: BaseModel | list[BaseModel], *, stale: bool) -> Any:
    """Renvoie le modèle tel quel, ou sa version « hors ligne » s'il est périmé."""
    return _stale(payload) if stale else payload


Platform = Literal["windows", "mac", "linux"]

#: Fragments d'``User-Agent`` trahissant la plateforme, dans l'ordre d'examen.
_PLATFORM_HINTS: Final[tuple[tuple[str, Platform], ...]] = (
    ("windows", "windows"),
    ("win32", "windows"),
    ("mac", "mac"),
    ("darwin", "mac"),
    ("linux", "linux"),
    ("x11", "linux"),
)


def _platform_of(request: Request, explicit: Platform | None) -> Platform:
    """Détermine la plateforme du launcher qui interroge le serveur.

    Le paramètre ``?platform=`` fait autorité ; à défaut on renifle
    l'``User-Agent`` ; en dernier recours, Windows — c'est ce que lance
    l'immense majorité des joueurs.

    Le launcher Electron annonce ``OPMLauncher/<version>`` sans mention de
    système : c'est bien ``?platform=`` qu'il doit passer pour recevoir l'URL
    de mise à jour de sa plateforme.
    """
    if explicit is not None:
        return explicit
    agent = (request.headers.get("user-agent") or "").lower()
    for fragment, platform in _PLATFORM_HINTS:
        if fragment in agent:
            return platform
    return "windows"


def _download_url(stats: _Stats | None, platform: Platform, settings: Settings) -> str | None:
    """URL de téléchargement du launcher pour cette plateforme.

    Les trois adresses vivent dans ``statistiques.launcher_windows``,
    ``_mac`` et ``_linux`` (``docs/DATA.md`` §1). ``OPM_LAUNCHER_DOWNLOAD_URL``
    n'est qu'un repli, pour une installation dont la ligne n'est pas encore
    remplie.
    """
    if stats is not None:
        candidates: dict[Platform, str] = {
            "windows": stats.launcher_windows,
            "mac": stats.launcher_mac,
            "linux": stats.launcher_linux,
        }
        url = candidates[platform].strip()
        if url:
            return url
    return settings.launcher_download_url.strip() or None


def _links(settings: Settings) -> LinksOut:
    """Rail social. Un lien vide devient ``null`` : le launcher masque l'icône."""
    return LinksOut(
        discord=settings.link_discord.strip() or None,
        twitch=settings.link_twitch.strip() or None,
        youtube=settings.link_youtube.strip() or None,
        website=settings.link_website.strip() or None,
    )


def _days_left_in_month(today: date | None = None) -> int:
    """Jours restants dans le mois en cours, aujourd'hui non compté.

    La cagnotte est mensuelle : « 58 € restants · 11 jours » sur la maquette.
    """
    day = today or date.today()
    return calendar.monthrange(day.year, day.month)[1] - day.day


def _build_tiers(collected_cents: int, goal_cents: int) -> list[DonationTierOut]:
    """Calcule les quatre paliers depuis le ratio collecté / objectif.

    Trois états : ``unlocked`` pour un palier atteint, ``near`` pour le **premier**
    palier non atteint (le seul vers lequel un don fait réellement avancer le
    serveur), ``locked`` pour les suivants. Le launcher refait ce calcul de son
    côté à partir des seuils : les deux doivent concorder, d'où la même règle ici.

    Sans objectif publié (``dons_objectif = 0``), tous les seuils valent zéro et
    les paliers restent verrouillés : on n'annonce pas un palier « débloqué »
    parce que la ligne du site est vide.
    """
    goal = max(0, goal_cents)
    collected = max(0, collected_cents)
    thresholds = [round(goal * percent / 100) for _, percent, _, _ in DONATION_TIERS]

    next_index = next(
        (index for index, threshold in enumerate(thresholds) if collected < threshold), None
    )

    tiers: list[DonationTierOut] = []
    for index, (identifier, _percent, label, description) in enumerate(DONATION_TIERS):
        threshold = thresholds[index]
        state: TierState
        if goal <= 0:
            state = "locked"
        elif collected >= threshold:
            state = "unlocked"
        elif index == next_index:
            state = "near"
        else:
            state = "locked"
        tiers.append(
            DonationTierOut(
                id=identifier,
                label=label,
                amount_cents=threshold,
                state=state,
                description=description,
            )
        )
    return tiers


# --------------------------------------------------------------------------- #
# 1.1 Bootstrap
# --------------------------------------------------------------------------- #

PlatformQuery = Annotated[
    Platform | None,
    Query(description="Plateforme du launcher ; déduite de l'User-Agent si absente."),
]


@router.get(
    "/bootstrap",
    response_model=BootstrapOut,
    summary="Première réponse lue par le launcher",
)
async def bootstrap(
    request: Request,
    session: SessionDep,
    platform: PlatformQuery = None,
) -> Any:
    """Politique d'authentification, adresse du serveur, liens et mise à jour.

    Appelée avant tout le reste, sans authentification. **Elle répond même si la
    base du site est injoignable** : le launcher doit pouvoir démarrer et
    expliquer la situation au joueur, pas rester sur un écran blanc. Les valeurs
    issues de ``statistiques`` retombent alors sur la configuration.
    """
    settings = get_settings()
    stats, stale = await _stats_soft(session)

    host, port = mcstatus.resolve_target(stats.server_ip if stats else None, settings=settings)

    payload = BootstrapOut(
        launcher=LauncherInfoOut(
            version_min=settings.launcher_version_min,
            version_latest=settings.launcher_version_latest,
            download_url=_download_url(stats, _platform_of(request, platform), settings),
        ),
        maintenance=MaintenanceOut(
            active=settings.maintenance_active,
            message=settings.maintenance_message,
            eta=settings.maintenance_eta,
        ),
        auth=AuthInfoOut(
            mode=settings.auth_mode,
            microsoft_required=users.microsoft_required(settings),
            registration_open=settings.registration_open,
            flow=settings.msa_flow,
        ),
        server=ServerInfoOut(host=host, port=port),
        links=_links(settings),
    )
    return _respond(payload, stale=stale)


# --------------------------------------------------------------------------- #
# 1.5 Contenu
# --------------------------------------------------------------------------- #

LimitQuery = Annotated[
    int | None,
    Query(ge=1, le=NEWS_CACHE_SIZE, description="Nombre d'articles, vedette comprise."),
]


@router.get("/news", response_model=NewsOut, summary="Journal de bord")
async def news(session: SessionDep, limit: LimitQuery = None) -> Any:
    """Le **JOURNAL DE BORD** : la plus récente en vedette, les suivantes en liste.

    ``kind`` est dérivé de ``article.categorie`` (un ``varchar`` libre, coloré par
    le launcher) et ``excerpt`` du corps HTML, balises retirées : la table du
    site n'a ni l'un ni l'autre, et il n'est pas question de lui ajouter des
    colonnes pour le confort du launcher.
    """
    settings = get_settings()
    items, stale = await _news(session)
    selection = items[: limit or settings.news_limit]

    payload = NewsOut(
        featured=selection[0] if selection else None,
        items=selection[1:],
    )
    return _respond(payload, stale=stale)


@router.get(
    "/instances",
    response_model=list[InstanceOut],
    summary="Profils de jeu",
)
async def instances(session: SessionDep) -> Any:
    """Instances au format attendu par ``minecraft-java-core``.

    Les noms de champs (``loadder``, ``whitelistActive``, ``nameServer``) sont
    ceux de l'ancien launcher, faute de frappe comprise : la bibliothèque les
    attend tels quels, et les renommer casserait le lancement du jeu
    (``docs/API.md`` §1.5).

    Une réponse périmée ne porte pas de champ ``stale`` — c'est une liste, elle
    n'a pas d'objet racine — mais toujours l'en-tête ``X-OPM-Stale: 1``.
    """
    payload, stale = await _instances(session)
    return _respond(payload, stale=stale)


@router.get("/status", response_model=ServerStatusOut, summary="Statut du serveur de jeu")
async def server_status(session: SessionDep) -> Any:
    """Dernier relevé du serveur Minecraft, servi depuis le cache mémoire.

    Le ping natif est effectué par la tâche de fond toutes les
    ``OPM_STATS_INTERVAL`` secondes : cette route n'ouvre donc **aucune**
    connexion vers le serveur de jeu tant que le relevé est frais. Si la tâche
    de fond ne tourne pas (script, test), un ping est déclenché à la demande.

    Le TPS n'est pas exposé par le protocole vanilla : il reste ``null`` tant
    qu'un plugin ne le publie pas. Le record, lui, vient de ``statistiques``.
    """
    settings = get_settings()
    stats, stale = await _stats_soft(session)
    host, port = mcstatus.resolve_target(stats.server_ip if stats else None, settings=settings)
    result = await mcstatus.current(host, port, settings=settings)

    payload = ServerStatusOut(
        online=result.online,
        players_online=result.players_online,
        players_max=result.players_max,
        tps=result.tps,
        motd=result.motd,
        latency_ms=result.latency_ms,
        record_players=stats.record_joueurs if stats else None,
        record_date=(stats.record_date or None) if stats else None,
    )
    return _respond(payload, stale=stale)


@router.get("/events/next", response_model=NextEventOut, summary="Prochain événement RP")
async def next_event(session: SessionDep) -> Any:
    """Nom et date du prochain événement, pour le compte à rebours de l'accueil.

    Rien n'est inventé : quand ``statistiques.evenement_nom`` est vide, le titre
    l'est aussi et le launcher masque la tuile.
    """
    stats, stale = await _stats(session)
    payload = (
        NextEventOut.from_stats(stats) if stats is not None else NextEventOut(title="")
    )
    return _respond(payload, stale=stale)


@router.get("/votes", response_model=VotesOut, summary="Votes du mois")
async def votes(session: SessionDep) -> Any:
    """Compteur de votes du mois et objectif.

    ``reward`` et ``url`` restent ``null`` : ni la récompense ni la page de vote
    n'ont de source dans la base du site. Un texte inventé ici deviendrait un
    mensonge le jour où la récompense changerait.
    """
    stats, stale = await _stats(session)
    payload = VotesOut.from_stats(stats) if stats is not None else VotesOut()
    return _respond(payload, stale=stale)


@router.get("/donations", response_model=DonationsOut, summary="Cagnotte du mois")
async def donations(session: SessionDep) -> Any:
    """État de la cagnotte, paliers compris — le même chiffre que l'accueil du site.

    Collecté = somme des ``paiements`` du mois (Stripe : dons et gigots) plus
    le complément manuel ``statistiques.dons_collecte`` ; donateurs = nombre de
    paiements du mois plus ``statistiques.donateurs``. Objectif : ``dons_objectif``.
    ``statistiques`` est en **euros entiers**, ``paiements`` en centimes.

    * les quatre paliers sont calculés depuis le ratio ;
    * ``top`` reste vide : le site n'affiche pas de classement de donateurs, et
      le launcher n'a pas à en inventer un ;
    * ``perks_url`` reste ``null``.
    """
    stats, stale = await _stats(session)
    collecte, collecte_stale = await _collecte(session)

    manual_cents = (stats.dons_collecte if stats else 0) * 100
    manual_donors = stats.donateurs if stats else 0
    goal_cents = (stats.dons_objectif if stats else 0) * 100
    collected_cents = manual_cents + (collecte.total_cents if collecte else 0)
    donors = manual_donors + (collecte.count if collecte else 0)

    payload = DonationsOut(
        collected_cents=max(0, collected_cents),
        goal_cents=max(0, goal_cents),
        donors_count=max(0, donors),
        days_left=_days_left_in_month(),
        tiers=_build_tiers(collected_cents, goal_cents),
    )
    return _respond(payload, stale=stale or collecte_stale)


@router.post(
    "/donations/checkout",
    response_model=DonateCheckoutOut,
    summary="Ouvrir la page de don",
)
async def donations_checkout(payload: DonateCheckoutIn, user: OptionalUser) -> DonateCheckoutOut:
    """Ouvre une session de paiement Stripe pour le montant choisi — **comme le site**.

    Le launcher fait exactement ce que fait ``create_donation_session`` sur
    le site (``boutique.py``) : même clé Stripe, mêmes métadonnées
    (``type=don``, ``user_id``, ``gigots=0``), et surtout **mêmes pages de
    retour** — ``/paiement/succes`` et ``/paiement/annule`` du site. C'est donc
    le webhook du site qui crédite ``paiements`` et les points de fidélité :
    rien n'est dupliqué, aucun paiement ne peut être compté deux fois, et la
    cagnotte du launcher (``/donations``) reflète le don dès qu'il est encaissé.

    Le joueur connecté au launcher l'est via ``users`` — la table du site — donc
    ``user_id`` est directement celui que le site attend pour créditer.

    Sans ``OPM_STRIPE_SECRET_KEY``, comportement d'avant : on ouvre
    ``OPM_DONATION_URL`` et le joueur donne depuis le site.

    L'authentification est facultative : un joueur déconnecté doit pouvoir
    soutenir le serveur (don anonyme, sans points). Quand le compte est connu,
    la limite de débit par compte s'applique.
    """
    settings = get_settings()
    if user is not None:
        await enforce("donations.checkout.account", str(user.id))

    amount = payload.amount_cents
    if not settings.donation_min_cents <= amount <= settings.donation_max_cents:
        raise ApiError(
            "invalid_amount",
            f"Un don va de {settings.donation_min_cents // 100} € à "
            f"{settings.donation_max_cents // 100} €.",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    if not settings.stripe_secret_key.strip():
        url = settings.donation_url.strip()
        if not url:
            logger.error(
                "Ni OPM_STRIPE_SECRET_KEY ni OPM_DONATION_URL : le bouton « FAIRE UN DON » "
                "ne mène nulle part."
            )
            raise ApiError(
                "content_unavailable",
                "La page de don n'est pas configurée.",
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        logger.info("Intention de don de %.2f € ouverte vers %s (sans Stripe).", amount / 100, url)
        return DonateCheckoutOut(checkout_url=url)

    checkout_url = await _stripe_checkout(settings, amount, user.id if user else None)
    logger.info(
        "Session Stripe créée : don de %.2f € par %s.",
        amount / 100,
        f"le compte {user.id}" if user else "un joueur anonyme",
    )
    return DonateCheckoutOut(checkout_url=checkout_url)


async def _stripe_checkout(settings: Settings, amount_cents: int, user_id: int | None) -> str:
    """Crée la session Stripe et rend l'URL de paiement.

    La bibliothèque ``stripe`` est synchrone : l'appel passe par un fil à part
    pour ne pas figer la boucle d'événements — même règle que le SMTP et les
    textures.

    Le libellé, la description et les métadonnées sont **copiés du site** : le
    webhook de celui-ci lit ``metadata.type`` pour distinguer un don d'un achat
    et ``metadata.user_id`` pour créditer le bon joueur. Changer ces clés ici
    casserait le crédit là-bas.
    """
    import stripe  # import différé : la bibliothèque n'est chargée que si Stripe est configuré

    site = settings.site_url.rstrip("/")
    session_kwargs = {
        "payment_method_types": ["card"],
        "mode": "payment",
        "submit_type": "donate",
        "line_items": [
            {
                "price_data": {
                    "currency": "eur",
                    "product_data": {
                        "name": "Don à One Piece Minecraft",
                        "description": (
                            "Soutien au serveur : hébergement, modération et développement de la map."
                        ),
                    },
                    "unit_amount": amount_cents,
                },
                "quantity": 1,
            }
        ],
        "success_url": f"{site}/paiement/succes?session_id={{CHECKOUT_SESSION_ID}}",
        "cancel_url": f"{site}/paiement/annule",
        "metadata": {
            "type": "don",
            "user_id": str(user_id) if user_id else "",
            "gigots": "0",
            "source": "launcher",
        },
    }

    def create() -> str:
        client = stripe.StripeClient(settings.stripe_secret_key.strip())
        session = client.checkout.sessions.create(params=session_kwargs)
        return str(session.url or "")

    try:
        url = await asyncio.to_thread(create)
    except Exception as exc:  # noqa: BLE001 — n'importe quelle erreur Stripe ou réseau
        logger.exception("Création de la session Stripe impossible : %s", exc)
        raise ApiError(
            "checkout_unavailable",
            "Le paiement est momentanément indisponible. Réessayez dans un instant.",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        ) from exc

    if not url.startswith("https://"):
        logger.error("Stripe a répondu sans URL de paiement exploitable.")
        raise ApiError(
            "checkout_unavailable",
            "Le paiement est momentanément indisponible. Réessayez dans un instant.",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        )
    return url


@router.get("/profile/rp", response_model=UserProfileOut, summary="Fiche RP du joueur")
async def profile_rp(user: CurrentUser, session: SessionDep) -> Any:
    """Volet « VOTRE PERSONNAGE » : faction, métier, équipage, îles tenues.

    Alimente le sous-titre de l'accueil — « Pirate · Équipage des Cœurs Brisés ·
    3 îles tenues ». Le nombre d'îles est un ``COUNT`` sur ``iles``, joint à
    ``equipages`` par le nom que porte ``users.equipage``.

    **Lecture seule.** Ces colonnes appartiennent au site et au serveur
    Minecraft ; le launcher les affiche, il ne les écrit jamais
    (``docs/DATA.md`` §4).
    """
    iles_tenues, stale = await _iles_tenues(session, user.equipage)
    payload = UserProfileOut.from_user(user, iles_tenues=iles_tenues)
    return _respond(payload, stale=stale)
