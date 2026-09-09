"""Fixtures communes aux tests du serveur d'authentification.

L'environnement de test est posé **avant tout import de ``opm_auth``** : la
configuration (``opm_auth.config.get_settings``) et la couche de sécurité sont
mises en cache dès leur premier chargement, il serait donc trop tard ensuite.

Choix structurants
==================

* **SQLite en mémoire, recréée à chaque test.** La base réelle est le
  PostgreSQL **du site** ; elle n'a pas sa place dans une suite de tests, et on
  ne la crée surtout pas. ``init_models(with_site_tables=True)`` fabrique donc,
  et uniquement sur SQLite, une réplique jetable des tables du site (``users``,
  ``article``, ``statistiques``, ``equipages``, ``iles``) en plus des douze
  tables du launcher : sans elle, les clés étrangères vers ``users.id``
  n'auraient aucune cible.

* **Ce que SQLite ne sait pas faire.** Deux choses du contrat exigent le vrai
  PostgreSQL : l'écriture atomique de la fréquentation
  (``GREATEST(record_joueurs, :online)``, ``docs/DATA.md`` §4) et le type
  ``jsonb`` de ``auth_audit.meta``. Les tests qui en dépendent portent la marque
  ``@pytest.mark.postgres`` et sont **ignorés** tant que la variable
  ``OPM_TEST_POSTGRES_URL`` ne désigne pas une base PostgreSQL jetable :

  .. code-block:: sh

      OPM_TEST_POSTGRES_URL=postgresql+asyncpg://opm:opm@localhost/opm_test pytest

  Ils sont ignorés, jamais silencieusement transformés en tests SQLite : un test
  qui ne prouve pas ce qu'il annonce est pire que pas de test du tout.

* **Aucun test ne crée ni ne supprime une table du site.** C'est la règle la
  plus importante de ce fichier. Sur PostgreSQL, la fixture
  :func:`postgres_sessionmaker` travaille dans un **schéma jetable dédié**
  (:data:`TEST_SCHEMA`), créé vide au début du test et détruit à la fin, avec un
  ``search_path`` verrouillé dessus : ``public`` — où vivent ``users``,
  ``article``, ``statistiques``, ``equipages`` et ``iles`` — n'est jamais dans le
  chemin de recherche, donc jamais lu, jamais écrit, jamais supprimé. Aucun
  ``DROP TABLE`` ni ``CREATE TABLE`` de cette suite ne peut atteindre une table
  du site, même si ``OPM_TEST_POSTGRES_URL`` désignait la production.

  Trois garde-fous s'ajoutent à cet isolement structurel, vérifiés **avant** le
  premier test (:func:`pytest_configure`) : le nom de la base doit contenir
  « test », l'hôte doit être local, et l'URL doit différer de celle héritée de
  l'environnement (``OPM_DATABASE_URL``, typiquement un ``.env`` de production
  chargé par mégarde). Une seule de ces conditions non remplie et pytest refuse
  de démarrer, avant d'ouvrir la moindre connexion.

* **Mots de passe au format Werkzeug, coût abaissé.** Le format reste celui du
  site (``pbkdf2:sha256:<itérations>$sel$hex``) — c'est tout l'enjeu de
  ``docs/DATA.md`` §3 — mais à 1 000 itérations : hacher trente mots de passe à
  600 000 itérations rendrait la suite insupportable. Le test de compatibilité
  Werkzeug, lui, remonte volontairement à 260 000 puis 600 000 : c'est son sujet.

* **Clés jetables** — les clés Ed25519 sont générées dans un dossier temporaire,
  jamais dans le dépôt.

* **Limiteur de débit neuf à chaque test** — les règles réelles de
  ``docs/API.md`` §4.4 restent appliquées ; la fixture ``unlimited`` les lève
  pour les tests qui enchaînent plus de connexions qu'un joueur n'en fera jamais.
"""

from __future__ import annotations

import hashlib
import os
import secrets
import shutil
import string
import tempfile
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

# --------------------------------------------------------------------------- #
# 1. Environnement de test — AVANT le premier import de opm_auth
# --------------------------------------------------------------------------- #

#: Dossier de travail jetable : clés, textures, base éventuelle.
_WORKSPACE = Path(tempfile.mkdtemp(prefix="opm-auth-tests-"))

#: Base PostgreSQL jetable pour les tests qui exigent le vrai moteur.
#: Vide = ces tests sont ignorés (voir la marque ``postgres``).
POSTGRES_URL: str = os.environ.get("OPM_TEST_POSTGRES_URL", "").strip()

#: URL de base **héritée de l'environnement**, relevée avant que la suite ne la
#: remplace par SQLite. Si elle est renseignée, c'est presque toujours celle d'un
#: ``.env`` réel : ``OPM_TEST_POSTGRES_URL`` ne doit surtout pas lui être égale.
INHERITED_DATABASE_URL: str = os.environ.get("OPM_DATABASE_URL", "").strip()

#: Schéma PostgreSQL jetable où vivent les tables des tests marqués ``postgres``.
#: Il est créé vide puis détruit à chaque test : les tables du site, qui vivent
#: dans ``public``, restent hors de portée.
TEST_SCHEMA = "opm_launcher_tests"

#: Hôtes considérés comme locaux. Une chaîne vide désigne une socket Unix locale.
LOCAL_HOSTS = frozenset({"", "localhost", "localhost.localdomain", "127.0.0.1", "::1"})

#: Itérations PBKDF2 utilisées par la suite. Le format reste celui du site,
#: seul le coût change — exactement le réglage ``OPM_PASSWORD_ITERATIONS``.
TEST_ITERATIONS = 1_000

#: Ce que le site Flask écrit aujourd'hui (Werkzeug < 2.3).
LEGACY_ITERATIONS = 260_000

#: Ce que le serveur d'authentification doit écrire à la place.
TARGET_ITERATIONS = 600_000

os.environ.update(
    {
        "OPM_ENV": "test",
        "OPM_DATABASE_URL": "sqlite+aiosqlite:///:memory:",
        "OPM_PUBLIC_URL": "http://testserver",
        # Secrets jetables, tirés au hasard à chaque exécution.
        "OPM_SECRET_KEY": secrets.token_urlsafe(48),
        "OPM_MSA_TOKEN_KEY": secrets.token_hex(32),
        # Clés de signature générées dans le dossier temporaire.
        "OPM_JWT_PRIVATE_KEY_PATH": str(_WORKSPACE / "jwt_ed25519_private.pem"),
        "OPM_JWT_PUBLIC_KEY_PATH": str(_WORKSPACE / "jwt_ed25519_public.pem"),
        # La paire « ygg » signe les textures : c'est du RSA, pas de l'Ed25519
        # (voir opm_auth/security/keys.py), d'où le nom de fichier.
        "OPM_YGG_PRIVATE_KEY_PATH": str(_WORKSPACE / "ygg_rsa_private.pem"),
        "OPM_YGG_PUBLIC_KEY_PATH": str(_WORKSPACE / "ygg_rsa_public.pem"),
        "OPM_TEXTURES_DIR": str(_WORKSPACE / "textures"),
        # Politique d'authentification par défaut du projet : hybride imposé.
        "OPM_AUTH_MODE": "hybrid",
        "OPM_MICROSOFT_REQUIRED": "true",
        "OPM_REGISTRATION_OPEN": "true",
        "OPM_OWNERSHIP_TTL_DAYS": "30",
        # Format Werkzeug, coût abaissé (voir l'en-tête du module).
        "OPM_PASSWORD_ITERATIONS": str(TEST_ITERATIONS),
        "OPM_PASSWORD_MIN_LENGTH": "12",
        # Le ping du serveur Minecraft n'a rien à écrire pendant les tests.
        "OPM_STATS_WRITE": "false",
        # Limitation de débit active : les tests vérifient aussi ce contrat.
        "OPM_RATE_LIMIT_ENABLED": "true",
        "OPM_TRUST_PROXY_HEADERS": "false",
        "OPM_SMTP_ENABLED": "false",
    }
)

from fastapi import FastAPI  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker  # noqa: E402

from opm_auth import db  # noqa: E402
from opm_auth.config import Settings, get_settings  # noqa: E402
from opm_auth.models import User, utcnow  # noqa: E402
from opm_auth.routers.auth import router as auth_router  # noqa: E402
from opm_auth.security.deps import ApiError, api_error_handler  # noqa: E402
from opm_auth.security.ratelimit import (  # noqa: E402
    InMemoryRateLimiter,
    RateLimiterBackend,
    RateLimitResult,
    Rule,
    set_limiter,
)
from opm_auth.services import users  # noqa: E402

#: Racine de l'API launcher, telle que la monte l'application.
API_PREFIX = "/api/v1"

#: Mot de passe conforme à la politique de robustesse, réutilisé partout.
PASSWORD = "Grand-Line-2026!"

#: Identité par défaut des comptes de test.
EMAIL = "capitaine@exemple.fr"
USERNAME = "Melodia"


# --------------------------------------------------------------------------- #
# 2. Marque « postgres » et garde-fou sur la base visée
# --------------------------------------------------------------------------- #


def _asyncpg_url(url: str) -> str:
    """Force le pilote asynchrone : ``postgresql://`` seul ouvrirait psycopg2."""
    if url.startswith("postgresql+"):
        return url
    for prefixe in ("postgresql://", "postgres://"):
        if url.startswith(prefixe):
            return "postgresql+asyncpg://" + url[len(prefixe) :]
    return url


def _cible(url: str) -> tuple[str, int, str] | None:
    """(hôte, port, base) d'une URL, formes locales ramenées à une seule.

    ``localhost``, ``127.0.0.1``, ``::1`` et la socket Unix désignent la même
    machine : les distinguer laisserait passer exactement la comparaison qu'on
    cherche à faire.
    """
    try:
        analysee = make_url(url)
    except Exception:  # pragma: no cover - URL illisible : traitée ailleurs
        return None
    hote = (analysee.host or "").lower()
    return (
        "local" if hote in LOCAL_HOSTS else hote,
        analysee.port or 5432,
        (analysee.database or "").split("?")[0],
    )


def _meme_base(gauche: str, droite: str) -> bool:
    """Vrai si deux URL désignent le même (hôte, port, base), pilote mis à part."""
    if not gauche or not droite:
        return False
    une, autre = _cible(gauche), _cible(droite)
    if une is None or autre is None:
        return gauche.strip() == droite.strip()
    return une == autre


def verifier_base_de_test(url: str) -> None:
    """Refuse toute base qui n'est pas manifestement jetable, et le dit franchement.

    Trois conditions, toutes obligatoires — c'est la ceinture qui double les
    bretelles du schéma jetable (voir l'en-tête du module) :

    1. le moteur est PostgreSQL ;
    2. le **nom de la base** contient « test » et l'**hôte est local** ;
    3. l'URL ne désigne pas la même base que l'``OPM_DATABASE_URL`` héritée de
       l'environnement — le scénario du ``.env`` de production chargé par erreur.

    :raises pytest.UsageError: pytest s'arrête immédiatement, avant tout test et
        avant la moindre connexion.
    """
    try:
        analysee = make_url(_asyncpg_url(url))
    except Exception as erreur:
        raise pytest.UsageError(
            f"OPM_TEST_POSTGRES_URL est illisible ({erreur}). Format attendu : "
            "postgresql+asyncpg://utilisateur:secret@localhost/opm_test"
        ) from erreur

    if analysee.get_backend_name() != "postgresql":
        raise pytest.UsageError(
            "OPM_TEST_POSTGRES_URL doit désigner une base PostgreSQL, or elle "
            f"annonce « {analysee.get_backend_name()} »."
        )

    nom = (analysee.database or "").split("?")[0]
    if "test" not in nom.lower():
        raise pytest.UsageError(
            f"OPM_TEST_POSTGRES_URL vise la base « {nom or '(sans nom)'} » : refusé. "
            "Le nom de la base doit contenir « test » (par exemple « opm_test »). "
            "Cette suite ne s'exécute que sur une base jetable — jamais sur celle "
            "du site One Piece Minecraft."
        )

    hote = (analysee.host or "").lower()
    if hote not in LOCAL_HOSTS:
        raise pytest.UsageError(
            f"OPM_TEST_POSTGRES_URL vise l'hôte « {hote} » : refusé. Les tests ne "
            "s'exécutent que sur un PostgreSQL local (localhost, 127.0.0.1, ::1 ou "
            "une socket Unix). Publiez le port de votre conteneur sur localhost."
        )

    if _meme_base(url, INHERITED_DATABASE_URL):
        raise pytest.UsageError(
            "OPM_TEST_POSTGRES_URL désigne la même base que OPM_DATABASE_URL "
            f"(« {nom} ») : refusé. C'est la base de service, pas une base de test."
        )


def pytest_configure(config: pytest.Config) -> None:
    """Déclare la marque ``postgres`` et vérifie la base visée avant tout test."""
    config.addinivalue_line(
        "markers",
        "postgres: exige un vrai PostgreSQL (GREATEST, jsonb…) ; ignoré sans "
        "OPM_TEST_POSTGRES_URL.",
    )
    if POSTGRES_URL:
        verifier_base_de_test(POSTGRES_URL)


def pytest_collection_modifyitems(
    config: pytest.Config, items: list[pytest.Item]
) -> None:
    """Ignore les tests marqués ``postgres`` quand aucune base n'est fournie."""
    if POSTGRES_URL:
        return
    skip = pytest.mark.skip(
        reason=(
            "Ce test exige PostgreSQL (GREATEST, jsonb) : définissez "
            "OPM_TEST_POSTGRES_URL pour l'exécuter."
        )
    )
    for item in items:
        if "postgres" in item.keywords:
            item.add_marker(skip)


@pytest.fixture
async def postgres_sessionmaker() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    """Fabrique de sessions sur un **schéma PostgreSQL jetable**.

    Le déroulé, dans l'ordre :

    1. les trois garde-fous de :func:`verifier_base_de_test` sont revérifiés ;
    2. le schéma :data:`TEST_SCHEMA` est supprimé s'il traîne, puis recréé vide ;
    3. le moteur des tests est ouvert avec ``search_path`` **verrouillé sur ce
       seul schéma** : ``public`` n'y figure pas, donc aucune table du site n'est
       visible — ni pour la lire, ni pour l'écrire, ni pour la supprimer ;
    4. la réplique jetable (5 tables du site + 12 du launcher) y est créée : les
       clés étrangères vers ``users.id`` ont ainsi une cible, sans que la vraie
       table ``public.users`` soit approchée ;
    5. à la fin, le schéma entier part en ``DROP SCHEMA … CASCADE``.

    C'est la différence de fond avec l'ancienne fixture : il n'existe plus, nulle
    part dans cette suite, un ``drop_all`` capable d'atteindre une table du site.
    Le pire qu'une URL mal choisie puisse provoquer est la création et la
    suppression d'un schéma portant notre nom — et les garde-fous l'interdisent
    déjà.
    """
    from sqlalchemy.ext.asyncio import create_async_engine

    from opm_auth.db import Base
    from opm_auth.models import LAUNCHER_TABLES, SITE_TABLES

    if not POSTGRES_URL:  # pragma: no cover - la marque « postgres » filtre déjà
        pytest.skip("OPM_TEST_POSTGRES_URL n'est pas défini.")
    verifier_base_de_test(POSTGRES_URL)

    url = _asyncpg_url(POSTGRES_URL)
    creation = text(f'CREATE SCHEMA "{TEST_SCHEMA}"')
    suppression = text(f'DROP SCHEMA IF EXISTS "{TEST_SCHEMA}" CASCADE')

    # Moteur d'administration : il ne sert qu'à poser et à retirer le schéma.
    administration = create_async_engine(url)
    try:
        async with administration.begin() as connection:
            await connection.execute(suppression)
            await connection.execute(creation)

        engine = create_async_engine(
            url,
            # Le chemin de recherche ne contient QUE le schéma jetable : une
            # table non qualifiée y est créée, et « public.users » est hors de
            # portée de toute requête émise par les tests.
            connect_args={"server_settings": {"search_path": TEST_SCHEMA}},
        )
        try:
            async with engine.begin() as connection:
                await connection.run_sync(
                    Base.metadata.create_all,
                    tables=list(SITE_TABLES + LAUNCHER_TABLES),
                )
            yield async_sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)
        finally:
            await engine.dispose()
    finally:
        try:
            async with administration.begin() as connection:
                await connection.execute(suppression)
        finally:
            await administration.dispose()


# --------------------------------------------------------------------------- #
# 3. Cycle de vie : dossier de travail, base, limiteur
# --------------------------------------------------------------------------- #


@pytest.fixture(scope="session", autouse=True)
def workspace() -> Iterator[Path]:
    """Efface le dossier temporaire (clés comprises) à la fin de la session."""
    yield _WORKSPACE
    shutil.rmtree(_WORKSPACE, ignore_errors=True)


@pytest.fixture(scope="session")
def settings() -> Settings:
    """Configuration effective de la suite de tests."""
    return get_settings()


@pytest.fixture(autouse=True)
async def database() -> AsyncIterator[None]:
    """Base SQLite en mémoire, neuve pour chaque test.

    ``with_site_tables=True`` fabrique aussi la réplique jetable des tables du
    site : sur la vraie base, ces tables existent déjà et notre code n'a
    évidemment pas le droit de les créer — ``init_models`` refuse d'ailleurs
    l'option sur autre chose que SQLite.

    Le moteur est libéré à la fin : la base disparaît avec lui, ce qui garantit
    l'isolation et évite qu'une connexion créée dans une boucle d'évènements
    soit réutilisée dans la suivante.
    """
    await db.init_models(with_site_tables=True)
    try:
        yield
    finally:
        await db.dispose_engine()


@pytest.fixture(autouse=True)
def limiter() -> Iterator[None]:
    """Compteurs de limitation de débit remis à zéro avant chaque test."""
    set_limiter(InMemoryRateLimiter())
    yield
    set_limiter(None)


class _AlwaysAllow(RateLimiterBackend):
    """Limiteur permissif : autorise tout, sans rien mémoriser."""

    async def hit(self, key: str, rule: Rule) -> RateLimitResult:
        return RateLimitResult(
            allowed=True, limit=rule.limit, remaining=rule.limit, retry_after=0.0
        )

    async def reset(self, key: str) -> None:
        return None


@pytest.fixture
def unlimited() -> Iterator[None]:
    """Lève la limitation de débit le temps d'un test.

    À réserver aux tests qui enchaînent plus d'appels qu'un joueur n'en fera
    jamais (rotation de jetons, 2FA…). Les limites elles-mêmes sont vérifiées
    par leur propre test, qui n'utilise pas cette fixture.
    """
    set_limiter(_AlwaysAllow())
    yield
    set_limiter(InMemoryRateLimiter())


@pytest.fixture
def sessions() -> async_sessionmaker[AsyncSession]:
    """Fabrique de sessions courtes : ``async with sessions() as session: …``.

    La base en mémoire n'a qu'**une seule connexion** partagée : une session
    laissée ouverte pendant qu'une requête HTTP écrit de son côté mélangerait
    les deux transactions. Ouvrez donc une session juste le temps d'une
    vérification, et refermez-la avant l'appel HTTP suivant.
    """
    return db.get_sessionmaker()


@pytest.fixture
async def session(
    sessions: async_sessionmaker[AsyncSession],
) -> AsyncIterator[AsyncSession]:
    """Session unique, pratique pour un test qui ne fait pas d'appel HTTP ensuite."""
    async with sessions() as opened:
        yield opened


# --------------------------------------------------------------------------- #
# 4. Application et client HTTP
# --------------------------------------------------------------------------- #


@pytest.fixture
def app() -> FastAPI:
    """Application minimale montant le routeur des comptes OPM.

    Volontairement assemblée ici plutôt qu'importée : la fabrique d'application
    appartient à un autre module et les tests de ce fichier portent sur le
    routeur lui-même. Le montage reproduit celui attendu en production —
    préfixe ``/api/v1`` et gestionnaire d'erreurs normalisé.
    """
    application = FastAPI(title="OPM Auth (tests)")
    application.add_exception_handler(ApiError, api_error_handler)
    application.include_router(auth_router, prefix=API_PREFIX)
    return application


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    """Client HTTP asynchrone branché directement sur l'application ASGI."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as opened:
        yield opened


# --------------------------------------------------------------------------- #
# 5. Comptes de test
# --------------------------------------------------------------------------- #


def credentials(**overrides: Any) -> dict[str, Any]:
    """Corps d'inscription valide, personnalisable champ par champ."""
    payload: dict[str, Any] = {
        "email": EMAIL,
        "username": USERNAME,
        "password": PASSWORD,
    }
    payload.update(overrides)
    return payload


@dataclass(frozen=True, slots=True)
class Account:
    """Compte inscrit et connecté, avec ses jetons frais.

    ``id`` est un **entier** : c'est ``users.id`` de la base du site, une clé
    ``serial``, pas un UUID (``docs/DATA.md`` §1).
    """

    id: int
    email: str
    username: str
    password: str
    access_token: str
    refresh_token: str

    @property
    def auth(self) -> dict[str, str]:
        """En-tête ``Authorization`` prêt à l'emploi."""
        return {"Authorization": f"Bearer {self.access_token}"}


async def register(client: AsyncClient, **overrides: Any) -> dict[str, Any]:
    """Inscrit un compte et retourne l'objet ``user`` renvoyé par l'API."""
    response = await client.post(f"{API_PREFIX}/auth/register", json=credentials(**overrides))
    assert response.status_code == 201, response.text
    return response.json()


async def sign_in(client: AsyncClient, **overrides: Any) -> dict[str, Any]:
    """Connecte un compte et retourne le corps de la réponse."""
    payload: dict[str, Any] = {"email": EMAIL, "password": PASSWORD}
    payload.update(overrides)
    response = await client.post(f"{API_PREFIX}/auth/login", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
async def account(client: AsyncClient) -> Account:
    """Compte inscrit puis connecté : le point de départ de la plupart des tests."""
    user = await register(client)
    body = await sign_in(client)
    return Account(
        id=int(user["id"]),
        email=EMAIL,
        username=USERNAME,
        password=PASSWORD,
        access_token=body["access_token"],
        refresh_token=body["refresh_token"],
    )


def make_user(
    *,
    email: str = EMAIL,
    username: str = USERNAME,
    password_hash: str,
    **overrides: Any,
) -> User:
    """Fabrique une ligne ``users`` complète, sans passer par l'API.

    Reprend :data:`opm_auth.services.users.NEW_ACCOUNT_DEFAULTS` : toutes les
    colonnes ``NOT NULL`` du dump du site sont renseignées, sinon l'``INSERT``
    serait refusé. C'est le seul moyen de poser en base une empreinte de mot de
    passe choisie — celle du site, par exemple.
    """
    columns: dict[str, Any] = dict(users.NEW_ACCOUNT_DEFAULTS)
    columns.setdefault("datejoin", utcnow())
    columns.update(overrides)
    return User(
        name=username,
        email=email,
        password_hash=password_hash,
        **columns,
    )


# --------------------------------------------------------------------------- #
# 6. Empreintes Werkzeug fabriquées à la main
# --------------------------------------------------------------------------- #

_SALT_CHARS = string.ascii_letters + string.digits


def werkzeug_hash(
    password: str,
    *,
    iterations: int = LEGACY_ITERATIONS,
    hash_name: str = "sha256",
    salt: str | None = None,
) -> str:
    """Reproduit ``werkzeug.security.generate_password_hash``, à l'octet près.

    Écrite avec :mod:`hashlib` seul, **sans importer** ``opm_auth`` ni
    ``werkzeug`` : c'est ce qui donne sa valeur au test de compatibilité. Si
    notre vérification acceptait une empreinte produite par notre propre code,
    elle ne prouverait rien ; ici, elle accepte une empreinte produite par la
    formule de Flask.

    Format : ``pbkdf2:<hash>:<itérations>$<sel>$<empreinte hexadécimale>``.
    """
    chosen_salt = salt or "".join(secrets.choice(_SALT_CHARS) for _ in range(16))
    digest = hashlib.pbkdf2_hmac(
        hash_name,
        password.encode("utf-8"),
        chosen_salt.encode("utf-8"),
        iterations,
    )
    return f"pbkdf2:{hash_name}:{iterations}${chosen_salt}${digest.hex()}"


# --------------------------------------------------------------------------- #
# 7. Remise des liens de réinitialisation
# --------------------------------------------------------------------------- #


@pytest.fixture
def reset_links() -> Iterator[list[tuple[int, str]]]:
    """Capture les liens de réinitialisation au lieu de les envoyer par courriel.

    Chaque entrée vaut ``(identifiant du compte, jeton en clair)``. C'est la
    seule façon d'obtenir le jeton : il n'est jamais journalisé ni renvoyé dans
    une réponse HTTP (``docs/API.md`` §4.8).
    """
    captured: list[tuple[int, str]] = []

    async def sender(user: User, token: str, _expires_at: Any) -> None:
        captured.append((user.id, token))

    users.set_password_reset_sender(sender)
    yield captured
    users.set_password_reset_sender(None)
