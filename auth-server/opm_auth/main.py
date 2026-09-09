"""Application FastAPI du serveur d'authentification One Piece Minecraft.

Ce module ne contient **aucune logique métier** : il assemble. Il monte les
routeurs, installe les intergiciels, branche les gestionnaires d'erreurs et
pilote le cycle de vie (clés, base, tâches de fond, courriels).

Les trois surfaces HTTP
=======================

======================  =========================================================
Racine                  Contenu
======================  =========================================================
``/api/v1``             API du launcher : comptes OPM, rattachement Microsoft,
                        sessions de jeu, contenu (``docs/API.md`` §1)
``/yggdrasil``          protocole Mojang attendu par authlib-injector (§2)
``/textures``           skins et capes en contenu adressable (§2.5)
======================  =========================================================

À quoi s'ajoutent deux routes de service, hors contrat d'API : ``GET /health``
(supervision, interroge réellement la base) et ``GET /version``.

Deux formats d'erreur, jamais mélangés
======================================

* sous ``/api/v1`` et partout ailleurs : le format normalisé de
  ``docs/API.md`` §3 — ``{"error", "message", "details"}`` ;
* sous ``/yggdrasil`` : le format Mojang — ``{"error", "errorMessage", "cause"}``,
  seul que le client Minecraft sache lire.

Les routeurs Yggdrasil convertissent déjà leurs propres erreurs (classe de route
``MojangRoute``). Les gestionnaires installés ici couvrent ce qui leur échappe :
chemin inconnu, méthode refusée, exception non prévue — et choisissent le format
d'après le préfixe du chemin demandé.

Cycle de vie (``lifespan``)
===========================

Au démarrage, dans cet ordre : journalisation, dossiers de travail, trousseau
cryptographique (généré s'il manque), vérification de la base, transporteur de
courriels, puis les trois tâches de fond de :mod:`opm_auth.services.tasks`.
À l'arrêt, l'inverse : tâches arrêtées et attendues, courriels débranchés, pool
de connexions fermé.

Lancement :

.. code-block:: sh

    uvicorn opm_auth.main:app --host 0.0.0.0 --port 8000
    python -m opm_auth.main          # équivalent, réglé par OPM_HOST / OPM_PORT
"""

from __future__ import annotations

import json
import logging
import sys
import time
import uuid
from collections.abc import AsyncIterator, Sequence
from contextlib import AsyncExitStack, asynccontextmanager, suppress
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any, Final

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import inspect as sa_inspect
from sqlalchemy import text
from sqlalchemy.engine import Connection
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.types import ASGIApp

from opm_auth import APP_NAME, __version__
from opm_auth.config import Settings, get_settings
from opm_auth.db import dispose_engine, get_engine, get_sessionmaker, init_models
from opm_auth.models import LAUNCHER_TABLE_NAMES
from opm_auth.routers import auth as auth_routes
from opm_auth.routers import game as game_routes
from opm_auth.routers import launcher as launcher_routes
from opm_auth.routers import microsoft as microsoft_routes
from opm_auth.routers import sessionserver as sessionserver_routes
from opm_auth.routers import textures as texture_routes
from opm_auth.routers import yggdrasil as yggdrasil_routes
from opm_auth.routers.yggdrasil import mojang_response
from opm_auth.security.deps import ApiError, api_error_handler
from opm_auth.security.keys import ensure_keys
from opm_auth.security.ratelimit import client_ip
from opm_auth.services import mailer, tasks
from opm_auth.services.mcstatus import cached as cached_status
from opm_auth.services.yggdrasil import FORBIDDEN, ILLEGAL_ARGUMENT, YggdrasilError

logger = logging.getLogger("opm_auth")

__all__ = [
    "API_PREFIX",
    "TEXTURES_PREFIX",
    "YGGDRASIL_PREFIX",
    "app",
    "configure_logging",
    "create_app",
    "current_request_id",
    "run",
]

#: Racine de l'API du launcher (``docs/API.md`` §1).
API_PREFIX: Final[str] = "/api/v1"

#: Racine du protocole Mojang, celle que reçoit authlib-injector (§2).
YGGDRASIL_PREFIX: Final[str] = "/yggdrasil"

#: Racine des textures. Le routeur porte déjà ce préfixe : il est monté nu.
TEXTURES_PREFIX: Final[str] = "/textures"

#: Chemins servant la documentation interactive — ``/docs``, sa page de retour
#: OAuth2 (``/docs/oauth2-redirect``), ``/redoc`` et le schéma. Ils chargent
#: leurs scripts depuis un CDN : la politique de sécurité stricte, qui interdit
#: tout chargement externe, ne s'y applique pas. Ils n'existent qu'hors production.
_DOC_PREFIXES: Final[tuple[str, ...]] = ("/docs", "/redoc", "/openapi.json")


def _is_documentation(path: str) -> bool:
    """Le chemin appartient-il à la documentation interactive ?"""
    return path.startswith(_DOC_PREFIXES)


#: Longueur maximale d'un identifiant de requête accepté depuis l'extérieur.
_REQUEST_ID_MAX = 64


# --------------------------------------------------------------------------- #
# 1. Identifiant de requête et journalisation structurée
# --------------------------------------------------------------------------- #

#: Identifiant de la requête en cours, propagé à toutes les lignes de journal
#: écrites pendant son traitement — y compris depuis les services, sans qu'ils
#: aient à le transporter.
_request_id: ContextVar[str] = ContextVar("opm_request_id", default="-")


def current_request_id() -> str:
    """Identifiant de la requête en cours, ou ``"-"`` hors requête."""
    return _request_id.get()


class _RequestIdFilter(logging.Filter):
    """Ajoute ``request_id`` à chaque enregistrement, même hors requête."""

    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, "request_id"):
            # ``setattr`` plutôt qu'une affectation directe : ``LogRecord`` n'a
            # pas ce champ dans ses annotations, et les vérificateurs de types
            # le signaleraient à juste titre.
            setattr(record, "request_id", current_request_id())  # noqa: B010
        return True


#: Champs facultatifs recopiés dans la ligne JSON quand ils sont présents.
_EXTRA_FIELDS: Final[tuple[str, ...]] = ("method", "path", "status", "duration_ms", "ip")


class JsonFormatter(logging.Formatter):
    """Journal en JSON, une ligne par événement — lisible par un collecteur.

    Rien de sensible n'y entre : les mots de passe, les jetons et les corps de
    requête ne sont jamais passés au journal (``docs/API.md`` §4.8). Ce
    formateur ne fait que sérialiser ce qu'on lui donne.
    """

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
            "request_id": getattr(record, "request_id", "-"),
        }
        for field in _EXTRA_FIELDS:
            value = getattr(record, field, None)
            if value is not None:
                payload[field] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


class TextFormatter(logging.Formatter):
    """Journal lisible par un humain, utilisé hors production."""

    def __init__(self) -> None:
        super().__init__(
            fmt="%(asctime)s %(levelname)-7s [%(request_id)s] %(name)s — %(message)s",
            datefmt="%H:%M:%S",
        )


def configure_logging(settings: Settings | None = None) -> None:
    """Installe la journalisation du processus. Appel idempotent.

    * en production : une ligne JSON par événement (:class:`JsonFormatter`) ;
    * ailleurs : du texte lisible.

    Le journal d'accès d'uvicorn est **désactivé** : le nôtre est plus complet
    (identifiant de requête, durée) et évite d'écrire deux fois la même chose.
    """
    config = settings or get_settings()
    root = logging.getLogger()
    level = getattr(logging, config.log_level.upper(), logging.INFO)

    # Les messages sont en français : sur une console Windows en cp1252, chaque
    # accent sortirait échappé (« é »). On force donc l'UTF-8 quand le flux
    # le permet, sans jamais faire échouer le démarrage pour si peu.
    reconfigure = getattr(sys.stderr, "reconfigure", None)
    if callable(reconfigure):
        with suppress(OSError, ValueError):
            reconfigure(encoding="utf-8", errors="backslashreplace")

    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter() if config.is_prod else TextFormatter())
    handler.addFilter(_RequestIdFilter())

    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(level)

    # Uvicorn installe ses propres gestionnaires : on les débranche pour que
    # tout passe par le nôtre, format compris.
    for name in ("uvicorn", "uvicorn.error"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers.clear()
        uvicorn_logger.propagate = True
    access = logging.getLogger("uvicorn.access")
    access.handlers.clear()
    access.propagate = False
    access.disabled = True

    logging.getLogger("sqlalchemy.engine").setLevel(
        logging.INFO if config.debug_sql else logging.WARNING
    )
    # httpx journalise chaque appel sortant en INFO, URL comprise : trop bavard,
    # et les URL Microsoft n'ont rien à faire dans un journal de production.
    logging.getLogger("httpx").setLevel(logging.WARNING)


# --------------------------------------------------------------------------- #
# 2. Intergiciels
# --------------------------------------------------------------------------- #


def _clean_request_id(raw: str | None) -> str | None:
    """Retient un identifiant fourni par un répartiteur, s'il est inoffensif.

    Un ``X-Request-ID`` venu de l'extérieur finit dans les journaux : on n'y
    laisse passer que des caractères imprimables simples, et pas plus de
    :data:`_REQUEST_ID_MAX`, pour qu'aucune injection de saut de ligne ne puisse
    fabriquer une fausse entrée de journal.
    """
    if not raw:
        return None
    candidate = raw.strip()[:_REQUEST_ID_MAX]
    if not candidate:
        return None
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:")
    return candidate if set(candidate) <= allowed else None


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Identifiant de requête, chronomètre et journal d'accès.

    Ce que la ligne d'accès contient : méthode, chemin **sans la chaîne de
    requête**, code de retour, durée et adresse de l'appelant. Ce qu'elle ne
    contient jamais : en-tête ``Authorization``, corps, jeton, mot de passe.
    La chaîne de requête est écartée par principe — c'est le seul endroit d'une
    URL où un client maladroit pourrait glisser un secret.
    """

    def __init__(self, app: ASGIApp, *, trust_incoming: bool = False) -> None:
        super().__init__(app)
        self._trust_incoming = trust_incoming

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        incoming = (
            _clean_request_id(request.headers.get("x-request-id")) if self._trust_incoming else None
        )
        request_id = incoming or uuid.uuid4().hex[:16]
        token = _request_id.set(request_id)
        request.state.request_id = request_id
        started = time.perf_counter()
        # L'adresse est résolue par la même règle que la limitation de débit :
        # « X-Forwarded-For » n'est cru que derrière un répartiteur déclaré.
        ip = client_ip(request)

        try:
            try:
                response = await call_next(request)
            except Exception:
                elapsed = int((time.perf_counter() - started) * 1000)
                logger.exception(
                    "%s %s — exception non traitée (%d ms)",
                    request.method,
                    request.url.path,
                    elapsed,
                    extra={
                        "method": request.method,
                        "path": request.url.path,
                        "status": 500,
                        "duration_ms": elapsed,
                        "ip": ip,
                    },
                )
                raise

            elapsed = int((time.perf_counter() - started) * 1000)
            response.headers.setdefault("X-Request-ID", request_id)
            logger.log(
                logging.WARNING if response.status_code >= 500 else logging.INFO,
                "%s %s → %d (%d ms)",
                request.method,
                request.url.path,
                response.status_code,
                elapsed,
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "status": response.status_code,
                    "duration_ms": elapsed,
                    "ip": ip,
                },
            )
            return response
        finally:
            _request_id.reset(token)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """En-têtes de sécurité, posés sur toutes les réponses.

    Le serveur ne rend que du JSON et des PNG : la politique la plus stricte est
    aussi la plus juste. ``default-src 'none'`` interdit tout chargement depuis
    une réponse de cette API si elle était un jour affichée dans un navigateur.
    Seules les pages de documentation en sont exemptées — elles chargent leurs
    scripts depuis un CDN.

    ``setdefault`` partout : un routeur qui a déjà choisi son en-tête (le
    ``Cache-Control: immutable`` des textures, par exemple) garde le sien.
    """

    def __init__(self, app: ASGIApp, *, hsts: bool = False) -> None:
        super().__init__(app)
        self._hsts = hsts

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        response = await call_next(request)
        headers = response.headers
        headers.setdefault("X-Content-Type-Options", "nosniff")
        headers.setdefault("X-Frame-Options", "DENY")
        headers.setdefault("Referrer-Policy", "no-referrer")
        headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
        headers.setdefault("Cross-Origin-Resource-Policy", "cross-origin")
        headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
        if not _is_documentation(request.url.path):
            headers.setdefault(
                "Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'"
            )
        if self._hsts:
            headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        return response


# --------------------------------------------------------------------------- #
# 3. Gestionnaires d'erreurs
# --------------------------------------------------------------------------- #

#: Code métier associé à un statut HTTP produit hors de nos services (404, 405…).
_HTTP_CODES: Final[dict[int, str]] = {
    400: "bad_request",
    401: "invalid_credentials",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    413: "payload_too_large",
    415: "unsupported_media_type",
    422: "invalid_request",
    429: "rate_limited",
    500: "internal_error",
    503: "service_unavailable",
}

#: Messages en français, affichables tels quels par le launcher.
_HTTP_MESSAGES: Final[dict[int, str]] = {
    404: "Cette ressource n'existe pas.",
    405: "Cette méthode n'est pas autorisée sur cette ressource.",
    413: "Le fichier envoyé est trop volumineux.",
    415: "Format de contenu non pris en charge.",
    500: "Une erreur interne est survenue. Réessayez dans un instant.",
    503: "Le service est momentanément indisponible.",
}


def _is_yggdrasil(request: Request) -> bool:
    """La requête vise-t-elle la surface Mojang (donc l'autre format d'erreur) ?"""
    return request.url.path.startswith(YGGDRASIL_PREFIX)


def _mojang_error(
    message: str,
    *,
    status_code: int,
    cause: str | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    """Construit une réponse d'erreur au format attendu par le client Minecraft.

    Le nom d'exception Java suit la convention du protocole :
    ``IllegalArgumentException`` pour une requête mal formée, sinon
    ``ForbiddenOperationException``.
    """
    return mojang_response(
        YggdrasilError(
            message,
            error=ILLEGAL_ARGUMENT if status_code in (400, 404, 405, 422) else FORBIDDEN,
            cause=cause,
            status_code=status_code,
            headers=headers,
        )
    )


def _normalized(
    code: str,
    message: str,
    *,
    status_code: int,
    details: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    """Construit une réponse au format ``docs/API.md`` §3."""
    return JSONResponse(
        status_code=status_code,
        content={"error": code, "message": message, "details": details},
        headers=headers,
    )


async def handle_api_error(request: Request, exc: Exception) -> Response:
    """Erreur applicative : format normalisé, ou format Mojang sous ``/yggdrasil``."""
    if not isinstance(exc, ApiError):  # pragma: no cover - garde-fou
        raise exc
    if _is_yggdrasil(request):
        return _mojang_error(
            exc.message,
            status_code=exc.status_code,
            cause=exc.code,
            headers=dict(exc.headers) if exc.headers else None,
        )
    return api_error_handler(request, exc)


async def handle_http_exception(request: Request, exc: Exception) -> Response:
    """Erreurs HTTP de Starlette : chemin inconnu, méthode refusée, etc."""
    if not isinstance(exc, StarletteHTTPException):  # pragma: no cover - garde-fou
        raise exc
    status_code = exc.status_code
    code = _HTTP_CODES.get(status_code, "http_error")
    detail = exc.detail if isinstance(exc.detail, str) and exc.detail else None
    message = _HTTP_MESSAGES.get(status_code) or detail or "La requête n'a pas abouti."
    headers = dict(exc.headers) if exc.headers else None

    if _is_yggdrasil(request):
        return _mojang_error(message, status_code=status_code, cause=code, headers=headers)
    return _normalized(code, message, status_code=status_code, headers=headers)


def _field_errors(errors: Sequence[Any]) -> list[dict[str, str]]:
    """Réduit les erreurs Pydantic à ce qui est utile au client.

    On ne renvoie ni la valeur reçue ni le contexte de validation : un corps de
    requête peut contenir un mot de passe, et il n'a rien à faire dans une
    réponse d'erreur.
    """
    fields: list[dict[str, str]] = []
    for error in errors:
        location = [str(part) for part in error.get("loc", ()) if part not in ("body", "query")]
        fields.append(
            {
                "field": ".".join(location) or "corps",
                "message": str(error.get("msg", "valeur invalide")),
            }
        )
    return fields


async def handle_validation_error(request: Request, exc: Exception) -> Response:
    """Corps ou paramètres invalides (Pydantic)."""
    if not isinstance(exc, RequestValidationError):  # pragma: no cover - garde-fou
        raise exc
    fields = _field_errors(exc.errors())

    if _is_yggdrasil(request):
        return _mojang_error(
            "Requête invalide : le client n'a pas envoyé les champs attendus.",
            status_code=400,
            cause=fields[0]["field"] if fields else None,
        )
    return _normalized(
        "invalid_request",
        "La requête est invalide.",
        status_code=422,
        details={"fields": fields},
    )


async def handle_unexpected_error(request: Request, exc: Exception) -> Response:
    """Dernier filet : toute exception non prévue devient une 500 propre.

    Le détail technique part dans le journal, avec l'identifiant de requête ;
    le client, lui, ne reçoit que cet identifiant — de quoi retrouver la trace
    dans le journal sans rien apprendre du serveur.
    """
    request_id = getattr(request.state, "request_id", current_request_id())
    logger.exception(
        "Exception non traitée sur %s %s", request.method, request.url.path, exc_info=exc
    )
    message = _HTTP_MESSAGES[500]
    if _is_yggdrasil(request):
        return _mojang_error(message, status_code=500, cause=request_id)
    return _normalized(
        "internal_error", message, status_code=500, details={"request_id": request_id}
    )


# --------------------------------------------------------------------------- #
# 4. Cycle de vie
# --------------------------------------------------------------------------- #


async def _ping_database() -> None:
    """Vérifie que la base répond. Lève si elle ne répond pas."""
    factory = get_sessionmaker()
    async with factory() as session:
        await session.execute(text("SELECT 1"))


def _existing_tables(connection: Connection) -> set[str]:
    """Noms des tables présentes dans la base (appelé via ``run_sync``)."""
    return set(sa_inspect(connection).get_table_names())


async def _missing_launcher_tables() -> set[str]:
    """Tables du launcher absentes de la base — donc migration non appliquée."""
    engine = get_engine()
    async with engine.connect() as connection:
        present = await connection.run_sync(_existing_tables)
    return set(LAUNCHER_TABLE_NAMES) - present


async def _prepare_database(settings: Settings) -> None:
    """Prépare la base **du site** : on vérifie, on ne crée jamais chez elle.

    * en production : la connexion doit répondre et les douze tables du launcher
      doivent exister. Si elles manquent, le démarrage échoue avec la commande à
      lancer — mieux vaut un service qui refuse de monter qu'un service qui
      répond 500 à chaque joueur ;
    * en développement sur SQLite : les tables du launcher sont créées à la
      volée (``init_models``), le site n'existant pas ;
    * en développement sur PostgreSQL : rien n'est créé, un avertissement
      rappelle Alembic. C'est peut-être déjà la base du site.
    """
    try:
        await _ping_database()
    except Exception:
        if settings.is_prod:
            logger.critical(
                "Base de données injoignable : vérifiez OPM_DATABASE_URL et que le "
                "PostgreSQL du site accepte la connexion."
            )
            raise
        logger.warning(
            "Base de données injoignable au démarrage : le serveur monte quand même "
            "(environnement « %s »), mais toutes les routes échoueront.",
            settings.env,
            exc_info=True,
        )
        return

    if settings.is_sqlite and not settings.is_prod:
        await init_models()
        logger.info("Tables du launcher créées ou déjà présentes (SQLite de développement).")
        return

    missing = await _missing_launcher_tables()
    if not missing:
        logger.info("Schéma vérifié : les douze tables du launcher sont en place.")
        return

    listing = ", ".join(sorted(missing))
    if settings.is_prod:
        raise RuntimeError(
            "Tables du launcher absentes de la base du site : "
            f"{listing}. Appliquez la migration avant de démarrer :\n"
            "    cd auth-server && alembic upgrade head\n"
            "(voir auth-server/README.md, section « Migration »). Aucune table n'est "
            "créée automatiquement : la base appartient au site."
        )
    logger.warning(
        "Tables du launcher absentes (%s). Lancez « alembic upgrade head ». "
        "Rien n'est créé automatiquement sur une base non-SQLite.",
        listing,
    )


def _background_wanted(settings: Settings) -> bool:
    """Faut-il démarrer les tâches de fond dans ce processus ?

    Elles sont inutiles — et nuisibles — pendant les tests : chaque suite
    démarrerait un ping du serveur Minecraft toutes les vingt secondes.
    """
    return not settings.is_test


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Démarrage et arrêt ordonnés du serveur."""
    settings: Settings = app.state.settings
    configure_logging(settings)
    logger.info(
        "Démarrage de %s %s — environnement « %s », mode d'authentification « %s ».",
        APP_NAME,
        __version__,
        settings.env,
        settings.auth_mode,
    )

    settings.ensure_directories()
    ensure_keys()  # génère les paires manquantes et vérifie leur cohérence
    await _prepare_database(settings)
    mailer.install()

    async with AsyncExitStack() as stack:
        if _background_wanted(settings):
            await stack.enter_async_context(tasks.background(settings))
        else:
            logger.info("Tâches de fond désactivées (environnement « %s »).", settings.env)
        app.state.ready = True
        logger.info(
            "Prêt. API sur %s, Yggdrasil sur %s.",
            f"{settings.public_url}{API_PREFIX}",
            settings.yggdrasil_base_url,
        )
        try:
            yield
        finally:
            app.state.ready = False
            logger.info("Arrêt en cours…")

    mailer.uninstall()
    await dispose_engine()
    logger.info("Arrêté proprement.")


# --------------------------------------------------------------------------- #
# 5. Fabrique d'application
# --------------------------------------------------------------------------- #

_DESCRIPTION = """
Serveur d'authentification souverain du serveur **One Piece Minecraft**.

* `/api/v1` — comptes OPM, rattachement Microsoft, sessions de jeu, contenu ;
* `/yggdrasil` — protocole Mojang pour authlib-injector ;
* `/textures` — skins et capes servis en contenu adressable.
"""

_TAGS: Final[list[dict[str, str]]] = [
    {"name": "Comptes OPM", "description": "Inscription, connexion, sessions, 2FA."},
    {
        "name": "Rattachement Microsoft",
        "description": "Microsoft comme simple oracle de possession de Minecraft.",
    },
    {"name": "game", "description": "Ouverture et clôture des sessions de jeu."},
    {"name": "Contenu du launcher", "description": "Accueil, journal, instances, statistiques."},
    {"name": "yggdrasil", "description": "Protocole Mojang (authlib-injector)."},
    {"name": "Textures", "description": "Skins et capes."},
    {"name": "Service", "description": "Supervision."},
]


def _install_middlewares(app: FastAPI, settings: Settings) -> None:
    """Installe les intergiciels, du plus intérieur au plus extérieur.

    ``add_middleware`` **empile** : le dernier ajouté enveloppe les précédents.
    L'ordre ci-dessous donne donc, vu de l'extérieur :

    ``contexte de requête`` → ``CORS`` → ``en-têtes de sécurité`` → ``GZip`` → routes.

    Le contexte de requête est volontairement le plus extérieur : l'identifiant
    existe ainsi avant tout le reste, y compris pour une réponse produite par
    l'intergiciel CORS.
    """
    # GZip : le JSON de /bootstrap et du journal compresse d'un facteur cinq.
    # Le seuil évite de compresser les réponses minuscules (et l'essentiel des
    # PNG de textures, déjà compressés, passe rarement en dessous : c'est un peu
    # de CPU perdu, accepté pour ne pas complexifier l'empilement).
    app.add_middleware(GZipMiddleware, minimum_size=1024)

    app.add_middleware(
        SecurityHeadersMiddleware,
        hsts=settings.is_prod and settings.public_url.startswith("https://"),
    )

    # CORS fermé par défaut (``docs/API.md`` §4.7) : le launcher Electron parle
    # à l'API depuis le processus principal, il n'est soumis à aucune politique
    # d'origine. On n'ouvre que si une origine est explicitement déclarée — le
    # site, par exemple, s'il venait un jour consommer cette API.
    origins = settings.cors_origins_list
    if origins:
        logger.info("CORS ouvert pour : %s", ", ".join(origins))
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
            expose_headers=["X-Request-ID", "X-OPM-Stale", "Retry-After"],
            max_age=600,
        )

    app.add_middleware(RequestContextMiddleware, trust_incoming=settings.trust_proxy_headers)


def _install_exception_handlers(app: FastAPI) -> None:
    """Branche les quatre gestionnaires d'erreurs.

    L'ordre de déclaration est sans importance : Starlette cherche le
    gestionnaire le long de la hiérarchie de classes de l'exception. ``ApiError``
    dérive de ``HTTPException`` et trouve donc son gestionnaire spécifique avant
    celui, plus général, des erreurs HTTP.
    """
    app.add_exception_handler(ApiError, handle_api_error)
    app.add_exception_handler(RequestValidationError, handle_validation_error)
    app.add_exception_handler(StarletteHTTPException, handle_http_exception)
    app.add_exception_handler(Exception, handle_unexpected_error)


def _install_routers(app: FastAPI) -> None:
    """Monte les sept routeurs sous leurs trois racines."""
    # API du launcher.
    app.include_router(auth_routes.router, prefix=API_PREFIX)
    app.include_router(microsoft_routes.router, prefix=API_PREFIX)
    app.include_router(game_routes.router, prefix=API_PREFIX)
    app.include_router(launcher_routes.router, prefix=API_PREFIX)

    # Protocole Mojang : les deux routeurs se partagent la même racine.
    app.include_router(yggdrasil_routes.router, prefix=YGGDRASIL_PREFIX)
    app.include_router(sessionserver_routes.router, prefix=YGGDRASIL_PREFIX)

    # Textures : le routeur porte déjà « /textures ».
    app.include_router(texture_routes.router)


def _install_service_routes(app: FastAPI, settings: Settings) -> None:
    """Ajoute ``GET /health`` et ``GET /version``, hors contrat d'API."""

    @app.get(
        "/health",
        tags=["Service"],
        summary="État du service",
        include_in_schema=False,
    )
    async def health() -> Response:
        """Sonde de supervision : **interroge réellement la base**.

        Un ``/health`` qui répond « ok » sans toucher à la base ne prouve que
        l'existence du processus. Celui-ci exécute un ``SELECT 1`` : c'est la
        panne la plus probable, et la seule qui rende le serveur inutile.

        Retourne 200 si tout va bien, 503 sinon — de quoi piloter un
        répartiteur de charge ou une sonde Docker.
        """
        database_ok = True
        try:
            await _ping_database()
        except Exception:
            database_ok = False
            logger.warning("Sonde /health : base injoignable.", exc_info=True)

        loops = tasks.manager()
        last_ping = cached_status()
        checked_at = last_ping.checked_at if last_ping else None
        payload: dict[str, Any] = {
            "status": "ok" if database_ok else "degraded",
            "version": __version__,
            "database": "ok" if database_ok else "unreachable",
            "background_tasks": bool(loops and loops.running),
            "minecraft_server": {
                "address": last_ping.address if last_ping else None,
                "online": last_ping.online if last_ping else None,
                "checked_at": checked_at.isoformat() if checked_at else None,
            },
        }
        return JSONResponse(status_code=200 if database_ok else 503, content=payload)

    @app.get(
        "/version",
        tags=["Service"],
        summary="Version du serveur",
        include_in_schema=False,
    )
    async def version() -> dict[str, Any]:
        """Identité du service — utile au support et aux sondes de déploiement."""
        return {
            "name": APP_NAME,
            "version": __version__,
            "api": API_PREFIX,
            "yggdrasil": settings.yggdrasil_base_url,
            "server_name": settings.server_name,
        }


def create_app(settings: Settings | None = None) -> FastAPI:
    """Construit l'application FastAPI complète.

    La documentation interactive (``/docs``, ``/redoc``) n'est publiée qu'en
    dehors de la production : elle décrit toute la surface d'attaque et n'a
    aucun public légitime sur un serveur de jeu. Elle reste disponible en
    développement, où elle est précieuse.
    """
    config = settings or get_settings()
    configure_logging(config)

    app = FastAPI(
        title="OPM Auth",
        version=__version__,
        description=_DESCRIPTION,
        openapi_tags=_TAGS,
        lifespan=lifespan,
        docs_url=None if config.is_prod else "/docs",
        redoc_url=None if config.is_prod else "/redoc",
        openapi_url=None if config.is_prod else "/openapi.json",
    )
    app.state.settings = config
    app.state.ready = False
    app.state.started_at = datetime.now(UTC)

    _install_exception_handlers(app)
    _install_routers(app)
    _install_service_routes(app, config)
    _install_middlewares(app, config)
    return app


#: Application ASGI de production : ``uvicorn opm_auth.main:app``.
app = create_app()


def run() -> None:
    """Démarre uvicorn avec la configuration du projet (``python -m opm_auth.main``).

    Pratique en développement. En production, on préfère invoquer uvicorn (ou
    gunicorn) directement, pour maîtriser le nombre de processus et le passage
    des en-têtes du répartiteur.
    """
    import uvicorn

    settings = get_settings()
    options: dict[str, Any] = {
        "host": settings.host,
        "port": settings.port,
        "reload": settings.is_dev,
        "proxy_headers": settings.trust_proxy_headers,
        # La journalisation est déjà installée par create_app : uvicorn ne doit
        # pas réinstaller la sienne par-dessus.
        "log_config": None,
    }
    if settings.trust_proxy_headers:
        # Le répartiteur est déclaré de confiance par la configuration ; c'est
        # lui, et lui seul, qui doit être joignable sur ce port.
        options["forwarded_allow_ips"] = "*"
    uvicorn.run("opm_auth.main:app", **options)


if __name__ == "__main__":  # pragma: no cover - point d'entrée
    run()
