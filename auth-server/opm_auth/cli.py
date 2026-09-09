"""Outillage en ligne de commande du serveur d'authentification One Piece Minecraft.

Invocation :

.. code-block:: sh

    python -m opm_auth.cli <commande> [options]
    python -m opm_auth.cli --help

Les commandes, dans l'ordre où on s'en sert la première fois :

=====================  =====================================================
Commande               Rôle
=====================  =====================================================
``keygen``             génère les paires Ed25519 (jetons) et RSA-4096 (textures)
``initdb``             crée les tables **du launcher**, et elles seules
``export-public-key``  affiche la clé publique RSA (authlib-injector)
``createuser``         crée un compte OPM depuis le serveur
``link-status``        état du rattachement Microsoft d'un compte
``revoke``             révoque toutes les sessions d'un compte
``ping``               interroge le serveur Minecraft (test de ``mcstatus``)
``import-instances``   charge ``launcher_instance`` depuis un fichier JSON
=====================  =====================================================

Toutes les commandes lisent la même configuration que le serveur
(``opm_auth/config.py``, variables ``OPM_*`` ou fichier ``.env``). Aucune ne
prend de mot de passe ni de secret en argument sans le dire : le mot de passe de
``createuser`` est demandé au clavier, sans écho.

**Ce que cet outil ne fera jamais** : créer, modifier ou supprimer une table du
site (``users``, ``article``, ``statistiques``, ``equipages``, ``iles``…). La
base est partagée ; ``initdb`` ne connaît que les douze tables du launcher, et
en production c'est Alembic qui a la main.

Code de retour : ``0`` en cas de succès, ``1`` sinon — utilisable dans un script.
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import logging
import sys
from collections.abc import Awaitable, Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy import delete, select, update

from opm_auth import APP_NAME, __version__
from opm_auth.config import Settings, get_settings

__all__ = ["build_parser", "main"]

logger = logging.getLogger("opm_auth.cli")

#: Largeur de la colonne de gauche des tableaux affichés.
_LABEL_WIDTH = 24


# --------------------------------------------------------------------------- #
# Affichage
# --------------------------------------------------------------------------- #


def _say(message: str = "") -> None:
    """Écrit une ligne sur la sortie standard."""
    print(message)


def _ok(message: str) -> None:
    """Confirme une opération réussie."""
    print(f"OK    {message}")


def _warn(message: str) -> None:
    """Avertit sans faire échouer la commande."""
    print(f"NOTE  {message}")


def _fail(message: str) -> int:
    """Signale un échec sur la sortie d'erreur et renvoie le code de retour 1."""
    print(f"ÉCHEC {message}", file=sys.stderr)
    return 1


def _field(label: str, value: Any) -> None:
    """Affiche une ligne « libellé : valeur » alignée."""
    shown = "—" if value is None or value == "" else value
    print(f"  {label.ljust(_LABEL_WIDTH)} {shown}")


def _moment(value: datetime | None) -> str | None:
    """Formate un horodatage pour l'affichage, ou ``None``."""
    return None if value is None else value.isoformat(timespec="seconds")


# --------------------------------------------------------------------------- #
# keygen
# --------------------------------------------------------------------------- #


async def cmd_keygen(args: argparse.Namespace) -> int:
    """Génère les deux paires de clés du serveur si elles manquent.

    Deux paires, deux usages (voir ``opm_auth/security/keys.py``) :

    * **Ed25519** — signature de nos jetons (``access_token`` et session
      Yggdrasil). C'est nous qui définissons le format, donc nous choisissons ;
    * **RSA-4096** — signature des propriétés ``textures`` du sessionserver.
      Ici, aucun choix : le client Minecraft vanilla vérifie en ``SHA1withRSA``.

    ``--force`` régénère : les anciens fichiers sont mis de côté avec un suffixe
    daté, jamais effacés.
    """
    from opm_auth.security.keys import ensure_keys, key_paths, reset_keyring_cache

    settings = get_settings()
    settings.ensure_directories()
    jwt_private, jwt_public, ygg_private, ygg_public = key_paths()
    paths = (jwt_private, jwt_public, ygg_private, ygg_public)
    existing = [path for path in paths if path.exists()]

    if existing and args.force:
        _warn("Rotation demandée. Conséquences immédiates :")
        _say("      - clé Ed25519 : toutes les sessions de jeu en cours deviennent")
        _say("        invalides ; les joueurs devront relancer le jeu depuis le launcher ;")
        _say("      - clé RSA : les signatures de textures changent ; redémarrez le")
        _say("        serveur Minecraft pour qu'authlib-injector relise la clé publique.")
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        for path in existing:
            backup = path.with_suffix(path.suffix + f".bak-{stamp}")
            path.rename(backup)
            _say(f"      ancienne clé conservée sous {backup}")
        reset_keyring_cache()
    elif existing:
        _warn(
            f"{len(existing)} fichier(s) de clé existent déjà : ils sont conservés. "
            "Utilisez --force pour les remplacer."
        )

    keyring = ensure_keys()
    _ok(f"Trousseau prêt (clé de jetons {keyring.key_id}, RSA-{keyring.rsa_public.key_size}).")
    _field("Ed25519 privée", jwt_private)
    _field("Ed25519 publique", jwt_public)
    _field("RSA privée", ygg_private)
    _field("RSA publique", ygg_public)
    _say()
    _warn(
        "Les clés privées ne doivent jamais entrer dans un dépôt Git ni dans une "
        "image Docker : montez le dossier « keys/ » en volume."
    )
    return 0


# --------------------------------------------------------------------------- #
# initdb
# --------------------------------------------------------------------------- #


async def cmd_initdb(args: argparse.Namespace) -> int:
    """Crée les douze tables du launcher — **jamais** celles du site.

    En production, cette commande refuse de s'exécuter : le schéma y est géré
    par Alembic, qui garde une trace de ce qui a été appliqué. ``--force`` n'est
    là que pour une première installation volontaire.
    """
    from opm_auth.db import dispose_engine, init_models
    from opm_auth.models import LAUNCHER_TABLE_NAMES, SITE_TABLE_NAMES

    settings = get_settings()
    if settings.is_prod and not args.force:
        return _fail(
            "Interdit en production. Appliquez la migration :\n"
            "        cd auth-server && alembic upgrade head\n"
            "      (--force n'est là que pour une première installation assumée.)"
        )

    _say(f"Base ciblée : {_masked_url(settings)}")
    _say("Tables du site laissées intactes : " + ", ".join(sorted(SITE_TABLE_NAMES)) + ".")
    try:
        await init_models(force=args.force)
    finally:
        await dispose_engine()

    _ok(f"{len(LAUNCHER_TABLE_NAMES)} tables du launcher créées ou déjà présentes :")
    for name in sorted(LAUNCHER_TABLE_NAMES):
        _say(f"      - {name}")
    return 0


def _masked_url(settings: Settings) -> str:
    """URL de base sans mot de passe, pour l'affichage."""
    url = settings.sqlalchemy_url
    if "@" not in url or "://" not in url:
        return url
    scheme, _, rest = url.partition("://")
    credentials, _, host = rest.rpartition("@")
    user = credentials.split(":", 1)[0] if credentials else ""
    return f"{scheme}://{user}:***@{host}" if user else f"{scheme}://{host}"


# --------------------------------------------------------------------------- #
# createuser
# --------------------------------------------------------------------------- #


def _read_password(settings: Settings) -> str | None:
    """Demande le mot de passe deux fois, sans écho. ``None`` si abandon."""
    _say(
        f"Mot de passe ({settings.password_min_length} caractères minimum, "
        "la saisie ne s'affiche pas) :"
    )
    try:
        first = getpass.getpass("  Mot de passe : ")
        second = getpass.getpass("  Confirmation : ")
    except (EOFError, KeyboardInterrupt):
        _say()
        return None
    if first != second:
        _say("Les deux saisies diffèrent.")
        return None
    return first


async def cmd_createuser(args: argparse.Namespace) -> int:
    """Crée un compte OPM — c'est-à-dire une ligne ``users`` de la base du site.

    Le compte créé ici se connecte **aussi** au site : l'empreinte est au format
    Werkzeug, celui que le site sait relire (``docs/DATA.md`` §3).
    """
    from opm_auth.db import dispose_engine, get_sessionmaker
    from opm_auth.security.deps import ApiError
    from opm_auth.services import users

    settings = get_settings()

    if args.password:
        password = args.password
        _warn(
            "Mot de passe passé en argument : il reste dans l'historique du shell. "
            "Préférez la saisie interactive."
        )
    else:
        read = _read_password(settings)
        if read is None:
            return _fail("Création annulée.")
        password = read

    if args.admin:
        _warn(
            "L'option --admin ne peut rien écrire : la table « users » du site ne "
            "porte aucune colonne de rôle (docs/DATA.md §1). Le compte est créé "
            "comme joueur ; l'administration se règle côté site."
        )

    if not settings.registration_open:
        _warn(
            "Les inscriptions sont fermées (OPM_REGISTRATION_OPEN=false) : la "
            "création en ligne de commande est une action d'administration et "
            "passe outre, une seule fois, pour ce processus."
        )
        settings.registration_open = True

    factory = get_sessionmaker()
    try:
        async with factory() as session:
            try:
                user = await users.create_user(
                    session,
                    email=args.email,
                    username=args.username,
                    password=password,
                )
            except ApiError as exc:
                return _fail(f"{exc.code} — {exc.message}")
            _ok(f"Compte créé (users.id = {user.id}).")
            _field("Pseudonyme", user.name)
            _field("Adresse e-mail", user.email)
            _field("Inscrit le", _moment(user.datejoin))
            _field("Peut jouer", "non — rattachement Microsoft à faire depuis le launcher")
    finally:
        await dispose_engine()
    return 0


# --------------------------------------------------------------------------- #
# link-status
# --------------------------------------------------------------------------- #


async def cmd_link_status(args: argparse.Namespace) -> int:
    """Affiche l'état du rattachement Microsoft d'un compte.

    C'est la commande à lancer quand un joueur dit « je ne peux plus jouer » :
    elle montre l'UUID premium, le pseudo en jeu, la possession et la date
    d'expiration de la preuve (trente jours par défaut).
    """
    from opm_auth.db import dispose_engine, get_sessionmaker
    from opm_auth.models import utcnow
    from opm_auth.services import users

    settings = get_settings()
    factory = get_sessionmaker()
    try:
        async with factory() as session:
            user = await users.get_by_email(session, args.email)
            if user is None:
                return _fail(f"Aucun compte pour {args.email}.")

            _say(f"Compte {user.name} (users.id = {user.id})")
            _field("Adresse e-mail", user.email)
            _field("Dernière connexion", _moment(user.derniereconnexion))
            _field("Temps de jeu", f"{user.tempsdejeu} s")
            _field("2FA", "activée" if user.totp_enabled else "désactivée")

            ban = user.active_ban()
            if ban is not None:
                until = _moment(ban.until) or "définitive"
                _field("Sanction", f"{ban.reason} ({until})")
            else:
                _field("Sanction", None)

            link = user.mc_link
            _say()
            if link is None:
                _say("  Aucun compte Microsoft rattaché.")
            else:
                remaining = link.expires_at - utcnow()
                _field("UUID Minecraft", link.minecraft_uuid)
                _field("Pseudo en jeu", link.minecraft_username)
                _field("Possède Minecraft", "oui" if link.owns_minecraft else "NON")
                _field("Vérifié le", _moment(link.verified_at))
                _field(
                    "Preuve valable jusqu'au",
                    f"{_moment(link.expires_at)} ({int(remaining.total_seconds() // 86400)} j)",
                )
                _field("Jeton Microsoft", "chiffré en base" if link.msa_refresh_enc else "absent")

            reason = user.blocked_reason(microsoft_required=settings.microsoft_required)
            _say()
            _field("Bouton JOUER", "actif" if reason is None else f"bloqué — {reason}")
    finally:
        await dispose_engine()
    return 0


# --------------------------------------------------------------------------- #
# revoke
# --------------------------------------------------------------------------- #


async def cmd_revoke(args: argparse.Namespace) -> int:
    """Révoque toutes les sessions d'un compte : launcher **et** jeu.

    À utiliser quand un joueur signale un vol de compte, juste après avoir
    changé son mot de passe. Le compte lui-même n'est pas touché : il se
    reconnecte normalement ensuite.

    Ce que la commande fait, précisément :

    * ``auth_refresh_token`` — tous les jetons encore actifs sont marqués
      révoqués (ils ne sont pas supprimés : la détection de rejeu s'appuie sur
      leur existence) ;
    * ``ygg_session`` — toutes les sessions de jeu sont invalidées ;
    * ``ygg_join`` — les annonces d'arrivée en attente sont supprimées.
    """
    from opm_auth.db import dispose_engine, get_sessionmaker
    from opm_auth.models import RefreshToken, YggJoin, YggSession, utcnow
    from opm_auth.services import users

    factory = get_sessionmaker()
    try:
        async with factory() as session:
            user = await users.get_by_email(session, args.email)
            if user is None:
                return _fail(f"Aucun compte pour {args.email}.")

            now = utcnow()
            tokens = await session.execute(
                update(RefreshToken)
                .where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
                .values(revoked_at=now)
                .execution_options(synchronize_session=False)
            )
            sessions = await session.execute(
                update(YggSession)
                .where(YggSession.user_id == user.id, YggSession.invalidated_at.is_(None))
                .values(invalidated_at=now)
                .execution_options(synchronize_session=False)
            )
            joins = await session.execute(
                delete(YggJoin)
                .where(YggJoin.user_id == user.id)
                .execution_options(synchronize_session=False)
            )
            await session.commit()

            _ok(f"Sessions révoquées pour {user.name} (users.id = {user.id}).")
            _field("Jetons de renouvellement", int(tokens.rowcount or 0))
            _field("Sessions de jeu", int(sessions.rowcount or 0))
            _field("Annonces d'arrivée", int(joins.rowcount or 0))
            _say()
            _warn(
                "Le rattachement Microsoft et le mot de passe ne sont pas touchés. "
                "En cas de compte volé, faites aussi changer le mot de passe."
            )
    finally:
        await dispose_engine()
    return 0


# --------------------------------------------------------------------------- #
# export-public-key
# --------------------------------------------------------------------------- #


async def cmd_export_public_key(args: argparse.Namespace) -> int:
    """Affiche la clé publique à donner au serveur de jeu.

    En temps normal, **rien à copier** : authlib-injector lit la clé dans
    ``GET /yggdrasil`` (champ ``signaturePublickey``) au démarrage du serveur.
    Cette commande sert à vérifier ce qui est publié, à archiver la clé, ou à
    l'installer sur un serveur qui ne peut pas joindre l'API au démarrage.
    """
    from opm_auth.security.keys import get_keyring

    keyring = get_keyring()
    pem = keyring.ed25519_public_pem() if args.kind == "ed25519" else keyring.rsa_public_pem()

    if args.output:
        target = Path(args.output)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(pem, encoding="ascii")
        _ok(f"Clé publique {args.kind} écrite dans {target}.")
    else:
        _say(pem.rstrip())

    if args.kind == "rsa":
        _say()
        _warn(
            "C'est la clé de signature des textures (champ signaturePublickey de "
            f"{get_settings().yggdrasil_base_url}). Elle est publique : la diffuser "
            "ne présente aucun risque."
        )
    return 0


# --------------------------------------------------------------------------- #
# ping
# --------------------------------------------------------------------------- #


async def cmd_ping(args: argparse.Namespace) -> int:
    """Interroge le serveur Minecraft, comme le fait la tâche de fond.

    Sans argument, l'adresse vient de ``statistiques.server_ip`` (la source qui
    fait autorité, ``docs/DATA.md`` §1), avec repli sur ``OPM_MC_HOST``.
    N'écrit **rien** en base : c'est un test, pas un relevé.

    Code de retour ``1`` si le serveur ne répond pas — pratique en supervision.
    """
    from opm_auth.db import dispose_engine, get_sessionmaker
    from opm_auth.models import STATS_ROW_ID, Statistiques
    from opm_auth.services import mcstatus

    settings = get_settings()
    server_ip: str | None = None

    if args.host:
        host, port = args.host, args.port or settings.mc_port
    else:
        factory = get_sessionmaker()
        try:
            async with factory() as session:
                server_ip = await session.scalar(
                    select(Statistiques.server_ip).where(Statistiques.id == STATS_ROW_ID)
                )
        except Exception:
            _warn("statistiques.server_ip illisible : repli sur OPM_MC_HOST.")
        finally:
            await dispose_engine()
        host, port = mcstatus.resolve_target(server_ip, settings=settings)

    _say(f"Interrogation de {host}:{port} …")
    result = await mcstatus.ping(host, port, timeout=args.timeout)

    if not result.online:
        _say()
        _field("État", "HORS LIGNE")
        _field("Motif", result.error)
        _say()
        _warn(
            "La tâche de fond n'écrirait rien dans « statistiques » : sur un échec, "
            "on ne remplace pas une fréquentation connue par un zéro."
        )
        return 1

    _say()
    _field("État", "en ligne")
    _field("Joueurs", f"{result.players_online} / {result.players_max}")
    _field("Latence", f"{result.latency_ms} ms")
    _field("Version", result.version_name)
    _field("Protocole", result.protocol)
    _field("MOTD", result.motd)
    _say()
    _field(
        "Écriture en base",
        "activée (OPM_STATS_WRITE)" if settings.stats_write else "désactivée",
    )
    return 0


# --------------------------------------------------------------------------- #
# import-instances
# --------------------------------------------------------------------------- #

#: Champs acceptés dans le JSON, avec leur valeur par défaut.
_INSTANCE_DEFAULTS: dict[str, Any] = {
    "loader_type": "none",
    "loader_version": None,
    "verify": True,
    "ignored": [],
    "whitelist_active": False,
    "whitelist": [],
    "status_host": None,
    "status_port": 25565,
    "sort_order": 0,
    "enabled": True,
}


def _normalize_instance(raw: Any, index: int) -> dict[str, Any]:
    """Valide une entrée du fichier et la traduit en colonnes de ``launcher_instance``.

    Deux écritures du chargeur de mods sont acceptées : la forme plate
    (``loader_type`` / ``loader_version``) et la forme imbriquée de
    ``minecraft-java-core`` (``loadder: {loadder_type, loadder_version}``),
    pour qu'un fichier repris de l'ancien launcher passe sans réécriture.

    :raises ValueError: si un champ obligatoire manque.
    """
    if not isinstance(raw, dict):
        raise ValueError(f"entrée n° {index + 1} : un objet JSON était attendu.")

    entry: dict[str, Any] = dict(raw)
    loader = entry.pop("loadder", None) or entry.pop("loader", None)
    if isinstance(loader, dict):
        entry.setdefault("loader_type", loader.get("loadder_type") or loader.get("type") or "none")
        entry.setdefault("loader_version", loader.get("loadder_version") or loader.get("version"))

    name = str(entry.get("name") or "").strip()
    if not name:
        raise ValueError(f"entrée n° {index + 1} : le champ « name » est obligatoire.")
    url = str(entry.get("url") or "").strip()
    if not url:
        raise ValueError(f"instance « {name} » : le champ « url » est obligatoire.")
    version = str(entry.get("version") or "").strip()
    if not version:
        raise ValueError(f"instance « {name} » : le champ « version » est obligatoire.")

    values: dict[str, Any] = {
        "name": name,
        "display_name": str(entry.get("display_name") or entry.get("displayName") or name),
        "url": url,
        "version": version,
    }
    for field, default in _INSTANCE_DEFAULTS.items():
        values[field] = entry.get(field, default)
    return values


async def cmd_import_instances(args: argparse.Namespace) -> int:
    """Charge ``launcher_instance`` depuis un fichier JSON.

    Le fichier contient soit une liste d'objets, soit ``{"instances": [...]}``.
    L'import se fait **par nom** : une instance déjà présente est mise à jour,
    une nouvelle est créée. Rien n'est supprimé — pour retirer une instance de
    la liste servie au launcher, passez son champ ``enabled`` à ``false``.

    Exemple minimal :

    .. code-block:: json

        [
          {
            "name": "opm-main",
            "display_name": "Grand Line",
            "url": "https://cdn.onepieceminecraft.fr/instances/opm-main",
            "version": "1.20.1",
            "loader_type": "forge",
            "loader_version": "47.3.0",
            "status_host": "play.onepieceminecraft.fr",
            "status_port": 25565,
            "sort_order": 0
          }
        ]
    """
    from opm_auth.db import dispose_engine, get_sessionmaker
    from opm_auth.models import Instance

    source = Path(args.file)
    if not source.is_file():
        return _fail(f"Fichier introuvable : {source}")

    try:
        payload = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return _fail(f"JSON illisible ({source}) : {exc}")

    if isinstance(payload, dict):
        payload = payload.get("instances", [])
    if not isinstance(payload, list):
        return _fail("Le fichier doit contenir une liste d'instances.")

    try:
        entries = [_normalize_instance(raw, index) for index, raw in enumerate(payload)]
    except ValueError as exc:
        return _fail(str(exc))

    if not entries:
        _warn("Le fichier ne contient aucune instance : rien à faire.")
        return 0

    created = 0
    updated = 0
    factory = get_sessionmaker()
    try:
        async with factory() as session:
            for values in entries:
                existing = await session.scalar(
                    select(Instance).where(Instance.name == values["name"])
                )
                if existing is None:
                    session.add(Instance(**values))
                    created += 1
                    _say(f"  + {values['name']} — {values['display_name']}")
                else:
                    for field, value in values.items():
                        setattr(existing, field, value)
                    updated += 1
                    _say(f"  ~ {values['name']} — {values['display_name']}")

            if args.dry_run:
                await session.rollback()
                _warn("--dry-run : rien n'a été écrit.")
            else:
                await session.commit()
    finally:
        await dispose_engine()

    if not args.dry_run:
        _ok(f"{created} instance(s) créée(s), {updated} mise(s) à jour.")
        _warn(
            "Le launcher relit /api/v1/instances au plus tard 60 secondes après : "
            "aucun redémarrage n'est nécessaire."
        )
    return 0


# --------------------------------------------------------------------------- #
# Analyse des arguments
# --------------------------------------------------------------------------- #

#: Table de correspondance entre nom de commande et fonction.
_COMMANDS: dict[str, Callable[[argparse.Namespace], Awaitable[int]]] = {
    "keygen": cmd_keygen,
    "initdb": cmd_initdb,
    "createuser": cmd_createuser,
    "link-status": cmd_link_status,
    "revoke": cmd_revoke,
    "export-public-key": cmd_export_public_key,
    "ping": cmd_ping,
    "import-instances": cmd_import_instances,
}


def build_parser() -> argparse.ArgumentParser:
    """Construit l'analyseur d'arguments complet, aide en français comprise."""
    parser = argparse.ArgumentParser(
        prog="python -m opm_auth.cli",
        description=(
            "Outillage du serveur d'authentification One Piece Minecraft. "
            "La configuration est celle du serveur (variables OPM_* ou .env)."
        ),
        epilog=(
            "Rappel : la base est celle du site. Aucune commande ne crée ni ne "
            "modifie une table du site."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--version", action="version", version=f"{APP_NAME} {__version__}")
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="affiche les journaux de l'application (niveau INFO).",
    )
    subparsers = parser.add_subparsers(dest="command", metavar="commande")

    keygen = subparsers.add_parser(
        "keygen", help="génère les paires de clés Ed25519 (jetons) et RSA-4096 (textures)."
    )
    keygen.add_argument(
        "--force",
        action="store_true",
        help="régénère les clés existantes (les anciennes sont conservées, datées).",
    )

    initdb = subparsers.add_parser(
        "initdb", help="crée les tables du launcher (jamais celles du site)."
    )
    initdb.add_argument(
        "--force",
        action="store_true",
        help="autorise la création en production (première installation seulement).",
    )

    createuser = subparsers.add_parser(
        "createuser", help="crée un compte OPM (une ligne « users » du site)."
    )
    createuser.add_argument("--email", required=True, help="adresse e-mail du compte.")
    createuser.add_argument("--username", required=True, help="pseudonyme (users.name).")
    createuser.add_argument(
        "--password",
        help="mot de passe ; à éviter, il resterait dans l'historique du shell.",
    )
    createuser.add_argument(
        "--admin",
        action="store_true",
        help="sans effet : la table « users » du site n'a pas de colonne de rôle.",
    )

    link_status = subparsers.add_parser(
        "link-status", help="état du rattachement Microsoft d'un compte."
    )
    link_status.add_argument("--email", required=True, help="adresse e-mail du compte.")

    revoke = subparsers.add_parser(
        "revoke", help="révoque toutes les sessions d'un compte (launcher et jeu)."
    )
    revoke.add_argument("--email", required=True, help="adresse e-mail du compte.")

    export_key = subparsers.add_parser(
        "export-public-key",
        help="affiche la clé publique RSA (celle qu'authlib-injector vérifie).",
    )
    export_key.add_argument(
        "--kind",
        choices=("rsa", "ed25519"),
        default="rsa",
        help="rsa (textures, par défaut) ou ed25519 (vérification de nos jetons).",
    )
    export_key.add_argument("--output", help="écrit la clé dans ce fichier au lieu de l'afficher.")

    ping = subparsers.add_parser("ping", help="interroge le serveur Minecraft.")
    ping.add_argument("--host", help="hôte à interroger (défaut : statistiques.server_ip).")
    ping.add_argument("--port", type=int, help="port (défaut : celui de l'adresse ou OPM_MC_PORT).")
    ping.add_argument(
        "--timeout", type=float, default=3.0, help="délai maximal en secondes (défaut : 3)."
    )

    instances = subparsers.add_parser(
        "import-instances", help="charge launcher_instance depuis un fichier JSON."
    )
    instances.add_argument("file", help="fichier JSON (liste, ou objet avec « instances »).")
    instances.add_argument(
        "--dry-run",
        action="store_true",
        help="affiche ce qui serait fait sans rien écrire.",
    )

    return parser


def _explain(exc: Exception) -> str:
    """Traduit une exception en message utile.

    Une erreur de base de données arrive ici avec la requête SQL complète en
    pièce jointe : illisible, et jamais ce que l'on cherche. On garde la
    première ligne — celle qui dit ce qui ne va pas — et on rappelle les deux
    causes réelles : mauvaise URL, ou tables absentes.
    """
    from sqlalchemy.exc import SQLAlchemyError

    if isinstance(exc, SQLAlchemyError):
        first_line = str(exc).splitlines()[0]
        return (
            f"Base de données : {first_line}\n"
            "      Vérifiez OPM_DATABASE_URL. Sur une base neuve, les tables du launcher\n"
            "      s'obtiennent par « alembic upgrade head » (production) ou\n"
            "      « python -m opm_auth.cli initdb » (développement SQLite).\n"
            "      Les tables du site (users, statistiques, article…) appartiennent au\n"
            "      site : cet outil ne les crée jamais."
        )
    return f"{type(exc).__name__} : {exc}"


def main(argv: list[str] | None = None) -> int:
    """Point d'entrée : analyse les arguments et exécute la commande.

    :returns: code de retour du processus (``0`` en cas de succès).
    """
    parser = build_parser()
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)-7s %(name)s — %(message)s",
    )

    if not args.command:
        parser.print_help()
        return 1

    try:
        get_settings()
    except Exception as exc:  # configuration invalide : le message dit quoi corriger
        return _fail(f"Configuration invalide.\n{exc}")

    handler = _COMMANDS[args.command]
    try:
        return asyncio.run(handler(args))
    except KeyboardInterrupt:  # pragma: no cover - interruption au clavier
        _say()
        return _fail("Interrompu.")
    except Exception as exc:
        logger.debug("Échec de la commande %s", args.command, exc_info=True)
        return _fail(_explain(exc))


if __name__ == "__main__":  # pragma: no cover - point d'entrée
    sys.exit(main())
