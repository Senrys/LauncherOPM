"""Couche base de données : moteur asynchrone, fabrique de sessions, base déclarative.

Le serveur utilise SQLAlchemy 2.0 en style asynchrone. SQLite (aiosqlite) sert en
développement, PostgreSQL (asyncpg) en production ; le choix se fait uniquement
par ``OPM_DATABASE_URL``.

Points d'entrée :

* ``Base``            : classe déclarative commune à tous les modèles ;
* ``get_session``     : dépendance FastAPI livrant une ``AsyncSession`` ;
* ``SessionDep``      : raccourci annoté de la dépendance ci-dessus ;
* ``LAUNCHER_TABLES`` : les seules tables que ce projet a le droit de créer ;
* ``init_models()``   : création du schéma (développement et tests uniquement) ;
* ``dispose_engine()``: fermeture propre du pool, à l'arrêt de l'application.

**La base est partagée avec le site.** ``users``, ``article``, ``statistiques``,
``equipages`` et ``iles`` appartiennent au site Flask : nous les lisons, nous
n'en créons aucune. C'est pourquoi ``init_models()`` ne reçoit jamais
``Base.metadata`` en bloc, mais la liste explicite :data:`LAUNCHER_TABLES`.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Annotated, Any

from fastapi import Depends
from sqlalchemy import JSON, DateTime, MetaData, String, Table, event
from sqlalchemy.engine.interfaces import DBAPIConnection
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.pool import ConnectionPoolEntry, StaticPool
from sqlalchemy.types import TypeDecorator

from opm_auth.config import get_settings

if TYPE_CHECKING:  # pragma: no cover - visibilité pour les outils d'analyse
    # Résolus à l'exécution par ``__getattr__`` (models importe db : pas d'import direct).
    LAUNCHER_TABLES: tuple[Table, ...]
    SITE_TABLES: tuple[Table, ...]

# Convention de nommage des contraintes : indispensable pour qu'Alembic puisse
# générer des migrations réversibles (sans elle, SQLite et PostgreSQL nomment
# les contraintes différemment et les « ALTER » deviennent impossibles).
NAMING_CONVENTION: dict[str, str] = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class TZDateTime(TypeDecorator[datetime]):
    """Horodatage toujours conservé et restitué en UTC, avec fuseau explicite.

    SQLite ne stocke pas le décalage horaire : sans ce décorateur, une date lue
    revient « naïve » et toute comparaison avec ``datetime.now(UTC)`` échoue.
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.astimezone(UTC)

    def process_result_value(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)


# Correspondances par défaut entre annotations Python et types SQL : un
# ``Mapped[datetime]`` devient un horodatage UTC, un ``Mapped[str]`` sans
# précision devient un VARCHAR(255), un ``Mapped[dict[str, Any]]`` devient du JSON.
TYPE_ANNOTATION_MAP: dict[Any, Any] = {
    datetime: TZDateTime,
    str: String(255),
    dict[str, Any]: JSON,
}


class Base(DeclarativeBase):
    """Base déclarative de tous les modèles du serveur."""

    metadata = MetaData(naming_convention=NAMING_CONVENTION)
    type_annotation_map = TYPE_ANNOTATION_MAP

    def __repr__(self) -> str:  # pragma: no cover - confort de débogage
        identifier = getattr(self, "id", None)
        return f"<{type(self).__name__} id={identifier!r}>"


# --------------------------------------------------------------------------- moteur
_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def _create_engine() -> AsyncEngine:
    """Construit le moteur asynchrone à partir de la configuration."""
    settings = get_settings()
    url = settings.sqlalchemy_url
    options: dict[str, Any] = {
        "echo": settings.debug_sql,
        "pool_pre_ping": True,
    }

    if settings.is_sqlite:
        # SQLite ne supporte ni le pool dimensionné ni le partage entre threads.
        options["connect_args"] = {"check_same_thread": False}
        if settings.sqlite_file is None:
            # Base en mémoire : une seule connexion partagée, sinon chaque session
            # ouvrirait une base vide qui lui serait propre.
            options["poolclass"] = StaticPool
    else:
        options["pool_size"] = settings.db_pool_size
        options["max_overflow"] = settings.db_max_overflow
        options["pool_recycle"] = 1800

    engine = create_async_engine(url, **options)

    if settings.is_sqlite:

        @event.listens_for(engine.sync_engine, "connect")
        def _sqlite_pragmas(
            dbapi_connection: DBAPIConnection,
            connection_record: ConnectionPoolEntry,
        ) -> None:
            """Active les clés étrangères et un journal résistant aux coupures."""
            cursor = dbapi_connection.cursor()
            try:
                cursor.execute("PRAGMA foreign_keys=ON")
                cursor.execute("PRAGMA journal_mode=WAL")
                cursor.execute("PRAGMA synchronous=NORMAL")
                cursor.execute("PRAGMA busy_timeout=5000")
            finally:
                cursor.close()

    return engine


def get_engine() -> AsyncEngine:
    """Renvoie le moteur asynchrone unique, créé à la première demande."""
    global _engine
    if _engine is None:
        _engine = _create_engine()
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    """Renvoie la fabrique de sessions unique."""
    global _sessionmaker
    if _sessionmaker is None:
        _sessionmaker = async_sessionmaker(
            bind=get_engine(),
            class_=AsyncSession,
            expire_on_commit=False,  # les objets restent lisibles après commit
            autoflush=False,
        )
    return _sessionmaker


# ------------------------------------------------------- propriété des tables
def launcher_tables() -> tuple[Table, ...]:
    """Les douze tables du launcher : les seules que ce projet peut créer.

    L'import de ``models`` est différé (``models`` importe ``db``), et le résultat
    n'est pas mémorisé : il est déjà constant, et le recalculer garde la fonction
    utilisable dans les tests qui rechargent les modules.
    """
    from opm_auth import models

    return models.LAUNCHER_TABLES


def site_tables() -> tuple[Table, ...]:
    """Les tables du site, mappées en lecture. **Ne jamais les créer ni les altérer.**"""
    from opm_auth import models

    return models.SITE_TABLES


def __getattr__(name: str) -> Any:
    """Expose ``db.engine``, ``db.session_factory`` et les listes de tables.

    Ces attributs sont résolus à la demande : le moteur ne doit pas naître à
    l'import, et les listes de tables vivent dans ``models``, qui importe ``db``.
    """
    if name == "engine":
        return get_engine()
    if name == "session_factory":
        return get_sessionmaker()
    if name == "LAUNCHER_TABLES":
        return launcher_tables()
    if name == "SITE_TABLES":
        return site_tables()
    raise AttributeError(f"module {__name__!r} n'a pas d'attribut {name!r}")


# ------------------------------------------------------------------------ sessions
async def get_session() -> AsyncIterator[AsyncSession]:
    """Dépendance FastAPI : une session par requête, annulée en cas d'exception.

    La validation (``commit``) reste à la charge des services : une requête qui
    échoue ne doit jamais laisser d'écriture partielle derrière elle.
    """
    factory = get_sessionmaker()
    async with factory() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise


SessionDep = Annotated[AsyncSession, Depends(get_session)]


# ------------------------------------------------------------------ cycle de vie
async def init_models(*, force: bool = False, with_site_tables: bool = False) -> None:
    """Crée les tables **du launcher** manquantes, et elles seules.

    Réservé au développement et aux tests : en production, le schéma est géré par
    Alembic. Le garde-fou ``force`` n'existe que pour les scripts d'amorçage
    volontaires (première installation).

    La base est partagée avec le site : ``Base.metadata.create_all`` en bloc
    créerait ``users`` ou ``statistiques`` s'ils venaient à manquer, ce qui serait
    une faute grave. On ne passe donc que :data:`LAUNCHER_TABLES`.

    :param force: autorise l'appel en production (première installation seulement).
    :param with_site_tables: crée **aussi** les tables du site. Réservé aux tests
        sur une base SQLite jetable, où le site n'existe pas et où les clés
        étrangères vers ``users`` n'auraient sinon aucune cible. Refusé sur toute
        base non-SQLite : jamais sur la vraie base.
    """
    settings = get_settings()
    if settings.is_prod and not force:
        raise RuntimeError(
            "init_models() est interdit en production : appliquez les migrations Alembic "
            "(alembic upgrade head)."
        )
    if with_site_tables and not settings.is_sqlite:
        raise RuntimeError(
            "init_models(with_site_tables=True) est réservé à SQLite : les tables du site "
            "(users, article, statistiques, equipages, iles) appartiennent au site Flask et "
            "ne doivent jamais être créées par ce projet."
        )
    settings.ensure_directories()

    tables: tuple[Table, ...] = launcher_tables()
    if with_site_tables:
        # Les tables du site d'abord : les clés étrangères du launcher les visent.
        tables = site_tables() + tables

    engine = get_engine()
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all, tables=tables)


async def dispose_engine() -> None:
    """Ferme le pool de connexions et oublie le moteur (arrêt ou tests)."""
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessionmaker = None
