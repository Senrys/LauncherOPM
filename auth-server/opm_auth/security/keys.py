"""Trousseau cryptographique du serveur : Ed25519 (JWT) et RSA-4096 (textures).

Deux paires de clés cohabitent, pour deux usages incompatibles :

``Ed25519`` — chemins ``OPM_JWT_PRIVATE_KEY_PATH`` / ``OPM_JWT_PUBLIC_KEY_PATH``
    Signature de **nos** jetons : ``access_token`` de l'API launcher et
    ``accessToken`` Yggdrasil (algorithme JOSE ``EdDSA``). Rapide, courte,
    moderne — c'est nous qui définissons le format, donc nous choisissons.

``RSA-4096`` — chemins ``OPM_YGG_PRIVATE_KEY_PATH`` / ``OPM_YGG_PUBLIC_KEY_PATH``
    Signature des propriétés ``textures`` renvoyées par le sessionserver. Ici
    nous n'avons **aucun** choix : le client Minecraft vanilla vérifie cette
    signature en ``SHA1withRSA`` avec la clé publique publiée dans le champ
    ``signaturePublickey`` de ``GET /yggdrasil`` (``docs/API.md`` §2.1 et §2.3).
    SHA-1 et RSA sont imposés par le protocole, pas par nous — c'est le seul
    endroit du projet où l'on ne choisit pas sa cryptographie.

    .. note::
       Le nom de fichier par défaut livré dans ``config.py``
       (``ygg_ed25519_private.pem``) est trompeur : le contenu **est** une clé
       RSA. Utilisez de préférence ``OPM_YGG_PRIVATE_KEY_PATH=keys/ygg_rsa_private.pem``.

Les clés sont générées au premier démarrage si elles sont absentes, écrites
avec les permissions ``0600``, et jamais journalisées.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from opm_auth.security import setting

logger = logging.getLogger(__name__)

__all__ = [
    "Keyring",
    "ed25519_key_id",
    "ed25519_private_key",
    "ed25519_public_key",
    "ensure_keys",
    "get_keyring",
    "key_paths",
    "reset_keyring_cache",
    "rsa_public_key_pem",
    "sign_textures",
    "verify_textures_signature",
]

#: Taille de la clé RSA de signature des textures.
RSA_KEY_SIZE = 4096


def _path_setting(prop: str, field: str, default: str) -> Path:
    """Résout un chemin de clé.

    Cherche d'abord la propriété résolue de ``config.py`` (``jwt_private_key``,
    qui ancre déjà le chemin sur la racine du projet), puis le champ brut
    (``jwt_private_key_path`` / ``OPM_JWT_PRIVATE_KEY_PATH``), puis le défaut.
    """
    resolved = setting(prop, Path(""))
    if str(resolved):
        return Path(resolved).expanduser()
    return Path(setting(field, default)).expanduser()


def key_paths() -> tuple[Path, Path, Path, Path]:
    """Chemins des quatre fichiers de clés (Ed25519 privé/public, RSA privé/public)."""
    return (
        _path_setting(
            "jwt_private_key", "jwt_private_key_path", "keys/jwt_ed25519_private.pem"
        ),
        _path_setting(
            "jwt_public_key", "jwt_public_key_path", "keys/jwt_ed25519_public.pem"
        ),
        _path_setting(
            "ygg_private_key", "ygg_private_key_path", "keys/ygg_rsa_private.pem"
        ),
        _path_setting(
            "ygg_public_key", "ygg_public_key_path", "keys/ygg_rsa_public.pem"
        ),
    )


# --------------------------------------------------------------------------- #
# Écriture / lecture sécurisées
# --------------------------------------------------------------------------- #


def _write_private(path: Path, payload: bytes) -> None:
    """Écrit une clé privée avec des permissions restreintes dès la création.

    Le descripteur est ouvert avec ``O_EXCL`` et le mode ``0600`` : le fichier
    n'existe jamais, même une fraction de seconde, avec des droits plus larges.
    Sous Windows, ``os.chmod`` n'a qu'un effet limité ; on s'appuie alors sur
    les ACL héritées du répertoire, ce qui est signalé dans le journal.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    _harden(path)


def _write_public(path: Path, payload: bytes) -> None:
    """Écrit une clé publique (lisible par tous, ce n'est pas un secret)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


def _harden(path: Path) -> None:
    """Force les permissions ``0600`` sur un fichier de clé privée."""
    try:
        os.chmod(path, 0o600)
    except OSError:  # pragma: no cover - dépend du système de fichiers
        logger.warning(
            "Permissions non applicables sur %s : vérifiez les droits d'accès "
            "au répertoire de clés.",
            path,
        )


def _check_permissions(path: Path) -> None:
    """Avertit si une clé privée est lisible au-delà de son propriétaire."""
    if os.name == "nt":  # pragma: no cover - modèle de droits différent
        return
    try:
        mode = path.stat().st_mode & 0o777
    except OSError:  # pragma: no cover
        return
    if mode & 0o077:
        logger.warning(
            "La clé privée %s est accessible à d'autres utilisateurs (mode %o). "
            "Corrigez avec : chmod 600 %s",
            path,
            mode,
            path,
        )


# --------------------------------------------------------------------------- #
# Génération / chargement
# --------------------------------------------------------------------------- #


def _load_or_create_ed25519(private_path: Path, public_path: Path) -> Ed25519PrivateKey:
    """Charge la paire Ed25519, ou la génère au premier démarrage."""
    if private_path.exists():
        _check_permissions(private_path)
        key = serialization.load_pem_private_key(
            private_path.read_bytes(), password=None
        )
        if not isinstance(key, Ed25519PrivateKey):
            raise TypeError(f"{private_path} ne contient pas une clé privée Ed25519.")
        return key

    logger.info("Génération de la paire Ed25519 (signature des jetons OPM).")
    key = Ed25519PrivateKey.generate()
    _write_private(
        private_path,
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ),
    )
    _write_public(
        public_path,
        key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ),
    )
    return key


def _load_or_create_rsa(private_path: Path, public_path: Path) -> rsa.RSAPrivateKey:
    """Charge la paire RSA des textures, ou la génère au premier démarrage."""
    if private_path.exists():
        _check_permissions(private_path)
        key = serialization.load_pem_private_key(
            private_path.read_bytes(), password=None
        )
        if not isinstance(key, rsa.RSAPrivateKey):
            raise TypeError(
                f"{private_path} ne contient pas une clé privée RSA. La signature "
                "des textures exige RSA : voir l'en-tête de ce module."
            )
        if key.key_size < 2048:
            raise ValueError(
                f"La clé RSA de {private_path} est trop courte ({key.key_size} bits)."
            )
        return key

    logger.info(
        "Génération de la paire RSA-%d (signature des textures Yggdrasil). "
        "Cette opération prend quelques secondes.",
        RSA_KEY_SIZE,
    )
    key = rsa.generate_private_key(public_exponent=65537, key_size=RSA_KEY_SIZE)
    _write_private(
        private_path,
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ),
    )
    _write_public(
        public_path,
        key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ),
    )
    return key


@dataclass(frozen=True, slots=True)
class Keyring:
    """Les clés du serveur, chargées une fois pour toutes."""

    ed25519_private: Ed25519PrivateKey
    ed25519_public: Ed25519PublicKey
    rsa_private: rsa.RSAPrivateKey
    rsa_public: rsa.RSAPublicKey
    #: Identifiant court de la clé Ed25519, publié dans l'en-tête JWT ``kid``.
    key_id: str

    def rsa_public_pem(self) -> str:
        """Clé publique RSA au format PEM, pour ``signaturePublickey``."""
        return self.rsa_public.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode("ascii")

    def ed25519_public_pem(self) -> str:
        """Clé publique Ed25519 au format PEM (vérification externe des jetons)."""
        return self.ed25519_public.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode("ascii")


def _compute_key_id(public_key: Ed25519PublicKey) -> str:
    """Empreinte courte et stable de la clé publique Ed25519."""
    raw = public_key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return base64.urlsafe_b64encode(hashlib.sha256(raw).digest())[:16].decode("ascii")


@lru_cache(maxsize=1)
def get_keyring() -> Keyring:
    """Retourne le trousseau du serveur, en le générant au besoin."""
    jwt_private, jwt_public, ygg_private, ygg_public = key_paths()
    ed25519_private = _load_or_create_ed25519(jwt_private, jwt_public)
    rsa_private = _load_or_create_rsa(ygg_private, ygg_public)
    ed25519_public = ed25519_private.public_key()
    return Keyring(
        ed25519_private=ed25519_private,
        ed25519_public=ed25519_public,
        rsa_private=rsa_private,
        rsa_public=rsa_private.public_key(),
        key_id=_compute_key_id(ed25519_public),
    )


def reset_keyring_cache() -> None:
    """Oublie le trousseau mémorisé (rotation de clés, tests)."""
    get_keyring.cache_clear()


def ensure_keys() -> Keyring:
    """Prépare et vérifie le trousseau — à appeler au démarrage de l'application.

    Génère les clés manquantes puis effectue un aller-retour signature /
    vérification sur chaque paire : mieux vaut échouer au démarrage qu'à la
    première connexion d'un joueur.
    """
    keyring = get_keyring()

    probe = b"opm-verification-de-demarrage"
    signature = keyring.ed25519_private.sign(probe)
    keyring.ed25519_public.verify(signature, probe)  # lève si la paire est incohérente

    if not verify_textures_signature(probe, sign_textures(probe)):
        raise RuntimeError(
            "La paire RSA de signature des textures est incohérente : vérifiez "
            "les fichiers désignés par OPM_YGG_PRIVATE_KEY_PATH et "
            "OPM_YGG_PUBLIC_KEY_PATH."
        )

    logger.info(
        "Trousseau prêt — clé de jetons %s (Ed25519), clé de textures RSA-%d.",
        keyring.key_id,
        keyring.rsa_public.key_size,
    )
    return keyring


# --------------------------------------------------------------------------- #
# Accès directs
# --------------------------------------------------------------------------- #


def ed25519_private_key() -> Ed25519PrivateKey:
    """Clé privée de signature de nos jetons."""
    return get_keyring().ed25519_private


def ed25519_public_key() -> Ed25519PublicKey:
    """Clé publique de vérification de nos jetons."""
    return get_keyring().ed25519_public


def ed25519_key_id() -> str:
    """Identifiant de clé publié dans l'en-tête JWT ``kid``."""
    return get_keyring().key_id


def rsa_public_key_pem() -> str:
    """Clé publique RSA au format PEM pour le champ ``signaturePublickey``."""
    return get_keyring().rsa_public_pem()


# --------------------------------------------------------------------------- #
# Signature des textures (protocole Mojang)
# --------------------------------------------------------------------------- #


def sign_textures(payload: bytes | str) -> str:
    """Signe une propriété ``textures`` et retourne la signature en base64.

    :param payload: la **valeur** de la propriété, c'est-à-dire le JSON de
        textures déjà encodé en base64 — c'est cette chaîne, octet pour octet,
        que le client vérifie.
    """
    data = payload.encode("ascii") if isinstance(payload, str) else payload
    signature = get_keyring().rsa_private.sign(data, padding.PKCS1v15(), hashes.SHA1())
    return base64.b64encode(signature).decode("ascii")


def verify_textures_signature(payload: bytes | str, signature_b64: str) -> bool:
    """Vérifie une signature de textures produite par :func:`sign_textures`."""
    data = payload.encode("ascii") if isinstance(payload, str) else payload
    try:
        get_keyring().rsa_public.verify(
            base64.b64decode(signature_b64),
            data,
            padding.PKCS1v15(),
            hashes.SHA1(),
        )
    except (InvalidSignature, ValueError, TypeError):
        return False
    return True
