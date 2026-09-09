"""Environnement Alembic du serveur d'authentification One Piece Minecraft.

Trois particularités par rapport à un ``env.py`` généré par ``alembic init`` :

1. **L'URL de connexion n'est pas dans ``alembic.ini``.** Elle est lue depuis
   ``opm_auth.config.get_settings()`` (variable ``OPM_DATABASE_URL``), pour qu'aucun
   secret ne se retrouve dans un fichier versionné.
2. **Le moteur est asynchrone** (``asyncpg`` en production, ``aiosqlite`` en
   développement). Les migrations tournent dans ``connection.run_sync(...)`` : à
   l'intérieur d'un script de migration, ``op.get_bind()`` renvoie donc une
   connexion **synchrone** classique, utilisable telle quelle.
3. **La base est partagée avec le site Flask.** Onze tables appartiennent au site
   et ne doivent JAMAIS être créées, modifiées ni supprimées par nos migrations.
   Un filtre (``include_name`` / ``include_object``) restreint l'autogénération aux
   seules tables du launcher : si un jour ``alembic revision --autogenerate``
   est lancé, il ne pourra pas proposer de toucher au site.

Rappel : la table de versions reste ``alembic_version``, celle du site. Notre
migration se chaîne donc à l'historique du site (voir ``migrations/README.md``,
section « Cohabitation avec l'Alembic du site »).
"""

from __future__ import annotations

import asyncio
import logging
import sys
from logging.config import fileConfig
from pathlib import Path
from typing import Any

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import create_async_engine

# ---------------------------------------------------------------------------
# Chemin d'import : « alembic » peut être lancé depuis n'importe où, le paquet
# opm_auth doit rester importable (auth-server/ est le parent de migrations/).
# ---------------------------------------------------------------------------
AUTH_SERVER_DIR = Path(__file__).resolve().parent.parent
if str(AUTH_SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(AUTH_SERVER_DIR))

from opm_auth.config import get_settings  # noqa: E402  (après l'ajustement de sys.path)

# ---------------------------------------------------------------------------
# Configuration Alembic et journalisation
# ---------------------------------------------------------------------------
config = context.config

if config.config_file_name is not None:
    # ``disable_existing_loggers=False`` : on ne veut pas museler les journaux
    # de l'application si Alembic est appelé depuis un script Python.
    fileConfig(config.config_file_name, disable_existing_loggers=False)

logger = logging.getLogger("alembic.env")
settings = get_settings()

# ---------------------------------------------------------------------------
# Frontière de propriété des tables — le garde-fou central de ce fichier
# ---------------------------------------------------------------------------

#: Les seules tables que nos migrations ont le droit de créer, modifier ou
#: supprimer. Toute table absente de cet ensemble appartient au site.
TABLES_LAUNCHER: frozenset[str] = frozenset(
    {
        "auth_mc_link",
        "auth_refresh_token",
        "auth_totp",
        "auth_recovery_code",
        "auth_password_reset",
        "auth_ban",
        "auth_audit",
        "ygg_session",
        "ygg_join",
        "texture",
        "user_texture",
        "launcher_instance",
    }
)

#: Tables appartenant au site Flask. Listées pour la documentation et pour
#: produire un message d'erreur explicite si quelqu'un tente de les inclure.
TABLES_SITE: frozenset[str] = frozenset(
    {
        "users",
        "article",
        "statistiques",
        "equipages",
        "iles",
        "combats",
        "produits",
        "equipe",
        "securite",
        "contact",
        "alembic_version",
    }
)


def _charger_metadata() -> Any | None:
    """Renvoie les métadonnées SQLAlchemy des modèles, ou ``None`` si indisponibles.

    L'autogénération est un confort, pas une nécessité : si les modèles ne sont
    pas importables (dépendance manquante, configuration incomplète), les
    migrations écrites à la main doivent continuer de s'appliquer.
    """
    try:
        from opm_auth import models  # noqa: F401  (enregistre les tables sur Base.metadata)
        from opm_auth.db import Base
    except Exception as erreur:  # pragma: no cover - dépend de l'environnement
        logger.warning(
            "Modèles non importables (%s) : « --autogenerate » est désactivé, "
            "les migrations écrites à la main restent applicables.",
            erreur,
        )
        return None
    return Base.metadata


target_metadata = _charger_metadata()


def _table_concernee(objet: Any, nom: str | None, type_: str) -> str | None:
    """Nom de la table à laquelle se rattache un objet de schéma, si applicable."""
    if type_ == "table":
        return nom
    table = getattr(objet, "table", None)
    return getattr(table, "name", None)


def include_name(nom: str | None, type_: str, parent_names: dict[str, str | None]) -> bool:
    """Filtre les noms **réflétés** dans la base pendant l'autogénération.

    Sans ce filtre, Alembic verrait les onze tables du site, ne les trouverait pas
    dans nos modèles, et proposerait allègrement de les supprimer.
    """
    if type_ == "schema":
        return nom is None  # uniquement le schéma par défaut (public)
    if type_ == "table":
        return nom in TABLES_LAUNCHER
    return True


def include_object(
    objet: Any,
    nom: str | None,
    type_: str,
    reflected: bool,
    compare_to: Any,
) -> bool:
    """Filtre les objets **des modèles** pendant l'autogénération.

    Symétrique de :func:`include_name` : même si un modèle cartographie une table
    du site (``users`` est mappée en lecture), elle ne doit jamais entrer dans une
    migration.
    """
    table = _table_concernee(objet, nom, type_)
    if table is None:
        return True
    return table in TABLES_LAUNCHER


def process_revision_directives(
    contexte: Any,
    revision: Any,
    directives: list[Any],
) -> None:
    """Évite de créer un fichier de migration vide (bruit dans l'historique)."""
    if not config.cmd_opts or not getattr(config.cmd_opts, "autogenerate", False):
        return
    if directives and directives[0].upgrade_ops.is_empty():
        directives[:] = []
        logger.info("Aucune différence détectée sur les tables du launcher : rien à générer.")


def _options_communes() -> dict[str, Any]:
    """Options passées à ``context.configure`` dans les deux modes."""
    return {
        "target_metadata": target_metadata,
        # La table de versions est celle du site : notre migration se chaîne à
        # son historique (voir README.md).
        "version_table": "alembic_version",
        "include_schemas": False,
        "include_name": include_name,
        "include_object": include_object,
        "process_revision_directives": process_revision_directives,
        "compare_type": True,
        # Les valeurs par défaut serveur sont volontairement hors comparaison :
        # PostgreSQL les réécrit (``'[]'`` devient ``'[]'::jsonb``) et Alembic
        # signalerait une différence à chaque exécution.
        "compare_server_default": False,
        # SQLite ne sait pas faire d'ALTER : le mode « batch » recrée la table.
        "render_as_batch": settings.is_sqlite,
    }


def _url_synchrone(url: str) -> str:
    """Retire le pilote asynchrone d'une URL (mode hors ligne, sans connexion)."""
    return url.replace("+asyncpg", "").replace("+aiosqlite", "")


# ---------------------------------------------------------------------------
# Mode hors ligne : « alembic upgrade head --sql » produit le SQL sans se
# connecter. C'est le mode à utiliser pour faire relire la migration avant de
# l'appliquer en production.
# ---------------------------------------------------------------------------
def run_migrations_offline() -> None:
    """Génère le SQL des migrations sans ouvrir de connexion."""
    context.configure(
        url=_url_synchrone(settings.sqlalchemy_url),
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        **_options_communes(),
    )
    with context.begin_transaction():
        context.run_migrations()


# ---------------------------------------------------------------------------
# Mode en ligne : connexion réelle, moteur asynchrone.
# ---------------------------------------------------------------------------
def do_run_migrations(connection: Connection) -> None:
    """Exécute les migrations sur une connexion synchrone (fournie par run_sync)."""
    context.configure(connection=connection, **_options_communes())
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    """Ouvre un moteur asynchrone jetable et y déroule les migrations."""
    engine = create_async_engine(
        settings.sqlalchemy_url,
        poolclass=pool.NullPool,  # un script de migration n'a que faire d'un pool
        echo=settings.debug_sql,
    )
    try:
        async with engine.connect() as connection:
            await connection.run_sync(do_run_migrations)
    finally:
        await engine.dispose()


def run_migrations_online() -> None:
    """Point d'entrée du mode en ligne."""
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
