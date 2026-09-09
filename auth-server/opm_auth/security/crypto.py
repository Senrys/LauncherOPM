"""Chiffrement symétrique au repos et primitives d'appoint.

Deux secrets ne doivent jamais toucher le disque en clair :

``MicrosoftLink.msa_refresh_token_enc``
    Le ``refresh_token`` Microsoft. Il permet de re-vérifier la possession de
    Minecraft sans redemander au joueur de se connecter ; il ne quitte **jamais**
    le serveur (``docs/API.md`` §0). Clé : ``OPM_MSA_TOKEN_KEY``.

``User.totp_secret_enc``
    Le secret TOTP. Clé dérivée de ``OPM_SECRET_KEY`` par HKDF-SHA256, comme
    annoncé dans ``models.py`` : une base volée ne suffit donc pas à générer
    les codes à six chiffres des joueurs.

Format de l'enveloppe produite dans les deux cas :

.. code-block:: text

    base64url( b"\\x01" || nonce (12 octets) || ciphertext || tag )

L'octet de version permettra de changer d'algorithme sans casser les données
existantes. Les données associées (AAD) contiennent l'usage et l'identifiant de
l'utilisateur : un chiffré volé dans la ligne de Nami ne peut être recollé ni
dans celle de Zoro, ni dans une autre colonne.

Rotation de clé : ``OPM_MSA_TOKEN_KEY`` est la clé courante ;
``OPM_MSA_TOKEN_KEYS_PREVIOUS`` (liste séparée par des virgules) contient les
anciennes clés, encore acceptées au déchiffrement. Après avoir re-chiffré les
enregistrements, on retire l'ancienne clé.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import os
import secrets

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from opm_auth.security import setting

__all__ = [
    "CryptoError",
    "MissingKeyError",
    "b64u_decode",
    "b64u_encode",
    "constant_time_equals",
    "decode_key",
    "decrypt",
    "decrypt_msa_token",
    "decrypt_totp_secret",
    "derive_key",
    "encrypt",
    "encrypt_msa_token",
    "encrypt_totp_secret",
    "generate_key_b64",
    "generate_key_hex",
    "random_token",
    "sha256_hex",
]

#: Taille de la clé AES-256 en octets.
KEY_SIZE = 32
#: Taille du nonce GCM en octets (96 bits, recommandation du NIST).
NONCE_SIZE = 12
#: Version du format d'enveloppe.
ENVELOPE_VERSION = 1


class CryptoError(Exception):
    """Erreur de chiffrement ou de déchiffrement."""


class MissingKeyError(CryptoError):
    """La clé de chiffrement n'est pas configurée ou est invalide."""


# --------------------------------------------------------------------------- #
# Primitives d'appoint
# --------------------------------------------------------------------------- #


def b64u_encode(raw: bytes) -> str:
    """Encode en base64url sans remplissage."""
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def b64u_decode(value: str) -> bytes:
    """Décode une chaîne base64url, avec ou sans remplissage."""
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def sha256_hex(value: str | bytes) -> str:
    """Empreinte SHA-256 hexadécimale.

    Utilisée pour stocker les ``refresh_token`` en base : ce sont des secrets de
    512 bits tirés aléatoirement, donc hors de portée d'une attaque par
    dictionnaire ; un simple SHA-256 suffit et reste rapide à indexer
    (``docs/API.md`` §4.3).
    """
    data = value.encode("utf-8") if isinstance(value, str) else value
    return hashlib.sha256(data).hexdigest()


def constant_time_equals(left: str | bytes, right: str | bytes) -> bool:
    """Comparaison à temps constant, qui ne trahit pas la longueur du préfixe commun."""
    left_bytes = left.encode("utf-8") if isinstance(left, str) else left
    right_bytes = right.encode("utf-8") if isinstance(right, str) else right
    return hmac.compare_digest(left_bytes, right_bytes)


def random_token(size: int = 32) -> str:
    """Jeton aléatoire base64url de ``size`` octets d'entropie."""
    return b64u_encode(secrets.token_bytes(size))


def generate_key_hex() -> str:
    """Génère une clé AES-256 en hexadécimal (format attendu par ``config.py``)."""
    return secrets.token_bytes(KEY_SIZE).hex()


def generate_key_b64() -> str:
    """Génère une clé AES-256 encodée en base64."""
    return base64.b64encode(secrets.token_bytes(KEY_SIZE)).decode("ascii")


# --------------------------------------------------------------------------- #
# Clés
# --------------------------------------------------------------------------- #


def decode_key(raw: str, *, label: str = "la clé") -> bytes:
    """Décode une clé de 32 octets, en hexadécimal ou en base64.

    Les deux formats sont acceptés, comme le fait ``config.py`` : 64 caractères
    hexadécimaux, ou 44 caractères base64 (standard ou url-safe).
    """
    cleaned = raw.strip()
    key: bytes | None = None

    if len(cleaned) == 2 * KEY_SIZE:
        try:
            key = bytes.fromhex(cleaned)
        except ValueError:
            key = None
    if key is None:
        try:
            key = b64u_decode(cleaned.replace("+", "-").replace("/", "_"))
        except (binascii.Error, ValueError):
            key = None
    if key is None or len(key) != KEY_SIZE:
        raise MissingKeyError(
            f"{label} doit contenir {KEY_SIZE} octets, en hexadécimal "
            f"({2 * KEY_SIZE} caractères) ou en base64. Générez-en une avec : "
            "python -m opm_auth.security.crypto"
        )
    return key


def _current_key() -> bytes:
    """Clé de chiffrement du jeton Microsoft (``OPM_MSA_TOKEN_KEY``)."""
    # ``config.py`` expose déjà la clé décodée et validée : on la préfère.
    decoded: bytes = setting("msa_token_key_bytes", b"")
    if decoded:
        if len(decoded) != KEY_SIZE:
            raise MissingKeyError(
                f"OPM_MSA_TOKEN_KEY doit contenir {KEY_SIZE} octets."
            )
        return decoded

    raw = setting("msa_token_key", "")
    if not raw:
        raise MissingKeyError(
            "OPM_MSA_TOKEN_KEY n'est pas définie : impossible de chiffrer le "
            "jeton Microsoft. Générez une clé avec : "
            "python -m opm_auth.security.crypto"
        )
    return decode_key(raw, label="OPM_MSA_TOKEN_KEY")


def _previous_keys() -> tuple[bytes, ...]:
    """Anciennes clés encore acceptées au déchiffrement.

    Lue uniquement dans l'environnement (``OPM_MSA_TOKEN_KEYS_PREVIOUS``) : ce
    réglage n'existe que le temps d'une rotation, il n'a pas sa place dans la
    configuration permanente.
    """
    raw: tuple[str, ...] = setting("msa_token_keys_previous", ())
    return tuple(
        decode_key(item, label="OPM_MSA_TOKEN_KEYS_PREVIOUS") for item in raw if item
    )


def derive_key(purpose: str, *, master: str | None = None) -> bytes:
    """Dérive une clé AES-256 depuis ``OPM_SECRET_KEY`` par HKDF-SHA256.

    Chaque usage possède son ``purpose`` : deux usages ne partagent donc jamais
    la même clé effective, même si le secret maître est unique.
    """
    secret = master if master is not None else setting("secret_key", "")
    if not secret:
        raise MissingKeyError(
            "OPM_SECRET_KEY n'est pas définie : impossible de dériver une clé de "
            "chiffrement."
        )
    return HKDF(
        algorithm=hashes.SHA256(),
        length=KEY_SIZE,
        salt=b"opm-auth-hkdf-v1",
        info=purpose.encode("utf-8"),
    ).derive(secret.encode("utf-8"))


# --------------------------------------------------------------------------- #
# Chiffrement générique
# --------------------------------------------------------------------------- #


def encrypt(
    plaintext: bytes | str,
    *,
    aad: bytes | str = b"",
    key: bytes | None = None,
) -> str:
    """Chiffre des données en AES-256-GCM et retourne l'enveloppe base64url.

    :param plaintext: donnée à protéger.
    :param aad: données associées authentifiées — non chiffrées, mais liées au
        chiffré : toute modification fait échouer le déchiffrement.
    :param key: clé explicite ; par défaut celle du jeton Microsoft.
    """
    data = plaintext.encode("utf-8") if isinstance(plaintext, str) else plaintext
    associated = aad.encode("utf-8") if isinstance(aad, str) else aad
    aead = AESGCM(key if key is not None else _current_key())
    nonce = os.urandom(NONCE_SIZE)
    return b64u_encode(bytes([ENVELOPE_VERSION]) + nonce + aead.encrypt(nonce, data, associated))


def decrypt(
    envelope: str,
    *,
    aad: bytes | str = b"",
    key: bytes | None = None,
) -> bytes:
    """Déchiffre une enveloppe produite par :func:`encrypt`.

    Sans clé explicite, essaie la clé courante puis les clés précédentes
    déclarées dans ``OPM_MSA_TOKEN_KEYS_PREVIOUS`` (rotation en douceur).

    :raises CryptoError: enveloppe illisible, altérée, ou clé inconnue.
    """
    if not envelope:
        raise CryptoError("Enveloppe chiffrée vide.")
    try:
        raw = b64u_decode(envelope)
    except (binascii.Error, ValueError) as exc:
        raise CryptoError("Enveloppe chiffrée illisible.") from exc

    if len(raw) < 1 + NONCE_SIZE + 16:
        raise CryptoError("Enveloppe chiffrée tronquée.")
    version, nonce, ciphertext = raw[0], raw[1 : 1 + NONCE_SIZE], raw[1 + NONCE_SIZE :]
    if version != ENVELOPE_VERSION:
        raise CryptoError(f"Version d'enveloppe inconnue : {version}.")

    associated = aad.encode("utf-8") if isinstance(aad, str) else aad
    candidates = (key,) if key is not None else (_current_key(), *_previous_keys())

    for candidate in candidates:
        try:
            return AESGCM(candidate).decrypt(nonce, ciphertext, associated)
        except InvalidTag:
            continue
    raise CryptoError("Déchiffrement impossible : clé incorrecte ou données altérées.")


# --------------------------------------------------------------------------- #
# Jeton Microsoft
# --------------------------------------------------------------------------- #

_MSA_CONTEXT = "opm:msa-refresh-token:v1"
_TOTP_CONTEXT = "opm:totp-secret:v1"


def _aad(context: str, user_id: str) -> bytes:
    """Données associées : usage + identifiant de l'utilisateur propriétaire."""
    if not user_id:
        raise ValueError("L'identifiant utilisateur est requis pour l'AAD.")
    return f"{context}:{user_id}".encode("utf-8")


def encrypt_msa_token(refresh_token: str, user_id: str) -> str:
    """Chiffre le ``refresh_token`` Microsoft d'un utilisateur pour la base."""
    if not refresh_token:
        raise ValueError("Le jeton Microsoft à chiffrer est vide.")
    return encrypt(refresh_token, aad=_aad(_MSA_CONTEXT, str(user_id)))


def decrypt_msa_token(envelope: str, user_id: str) -> str:
    """Déchiffre le ``refresh_token`` Microsoft d'un utilisateur.

    :raises CryptoError: si l'enveloppe n'appartient pas à cet utilisateur, a
        été altérée, ou si aucune clé configurée ne convient.
    """
    return decrypt(envelope, aad=_aad(_MSA_CONTEXT, str(user_id))).decode("utf-8")


# --------------------------------------------------------------------------- #
# Secret TOTP
# --------------------------------------------------------------------------- #


def encrypt_totp_secret(secret: str, user_id: str) -> str:
    """Chiffre le secret TOTP d'un utilisateur (``User.totp_secret_enc``)."""
    if not secret:
        raise ValueError("Le secret TOTP à chiffrer est vide.")
    return encrypt(
        secret,
        aad=_aad(_TOTP_CONTEXT, str(user_id)),
        key=derive_key(_TOTP_CONTEXT),
    )


def decrypt_totp_secret(envelope: str, user_id: str) -> str:
    """Déchiffre le secret TOTP d'un utilisateur."""
    return decrypt(
        envelope,
        aad=_aad(_TOTP_CONTEXT, str(user_id)),
        key=derive_key(_TOTP_CONTEXT),
    ).decode("utf-8")


if __name__ == "__main__":  # pragma: no cover - petit utilitaire d'exploitation
    print(generate_key_hex())
