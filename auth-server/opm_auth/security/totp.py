"""Double authentification TOTP (RFC 6238) et codes de secours.

Le secret fait 160 bits encodés en base32 (32 caractères), conformément à la
recommandation de la RFC 4226 §4 et compatible avec toutes les applications
d'authentification courantes.

La vérification tolère une fenêtre de ±1 pas (±30 s) pour absorber la dérive
d'horloge du téléphone. :func:`verify_totp_step` retourne le pas validé afin
que le service puisse mémoriser le dernier pas consommé et empêcher le rejeu
d'un code intercepté pendant sa fenêtre de validité.

Les dix codes de secours sont générés une seule fois, affichés une seule fois,
et stockés **hachés** : le serveur ne peut plus les relire. Le format d'empreinte
est celui de tout le projet — ``pbkdf2:sha256`` au format Werkzeug, produit par
:func:`opm_auth.security.passwords.hash_secret` — et **jamais Argon2id**, qui
couperait la compatibilité avec le site Flask (``docs/DATA.md`` §3). Le coût de
dérivation de ces empreintes est volontairement plus bas que celui d'un mot de
passe : voir :data:`opm_auth.security.passwords.SECRET_ITERATIONS`.

Appel depuis une coroutine
==========================

Hacher dix codes de secours, ou en vérifier un contre dix empreintes, coûte une
demi-seconde de processeur, verrou global tenu. Depuis un service asynchrone,
appelez donc :func:`generate_recovery_codes_async` et
:func:`verify_recovery_code_async` : elles déportent chaque dérivation dans un
fil. Les fonctions synchrones restent la référence, et l'API des scripts et des
tests.
"""

from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass
from urllib.parse import quote

import pyotp

from opm_auth.security import setting
from opm_auth.security.passwords import (
    hash_secret,
    hash_secret_async,
    verify_secret,
    verify_secret_async,
)

__all__ = [
    "RECOVERY_CODE_COUNT",
    "RecoveryCodes",
    "format_secret",
    "generate_recovery_codes",
    "generate_recovery_codes_async",
    "generate_totp_secret",
    "normalize_code",
    "provisioning_uri",
    "verify_recovery_code",
    "verify_recovery_code_async",
    "verify_totp",
    "verify_totp_step",
]

#: Longueur du secret en caractères base32 (32 × 5 bits = 160 bits).
SECRET_LENGTH = 32
#: Nombre de chiffres d'un code TOTP.
DIGITS = 6
#: Durée d'un pas de temps, en secondes.
PERIOD = 30
#: Fenêtre de tolérance, en pas de temps (±1 pas = ±30 s).
VALID_WINDOW = 1
#: Nombre de codes de secours délivrés lors de l'activation
#: (``OPM_RECOVERY_CODES_COUNT``, 10 par défaut — contrat de ``docs/API.md``).
RECOVERY_CODE_COUNT = setting("recovery_codes_count", 10)
#: Alphabet des codes de secours : base32 sans les caractères ambigus 0/O/1/I.
_RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
#: Longueur d'un bloc d'un code de secours (deux blocs séparés par un tiret).
_RECOVERY_BLOCK = 4


def issuer() -> str:
    """Nom affiché dans l'application d'authentification (``OPM_SERVER_NAME``)."""
    return setting("totp_issuer", setting("server_name", "One Piece Minecraft"))


def generate_totp_secret() -> str:
    """Génère un secret TOTP de 160 bits encodé en base32."""
    return pyotp.random_base32(length=SECRET_LENGTH)


def format_secret(secret: str) -> str:
    """Découpe le secret en groupes de quatre, pour la saisie manuelle."""
    cleaned = secret.strip().replace(" ", "").upper()
    return " ".join(cleaned[i : i + 4] for i in range(0, len(cleaned), 4))


def provisioning_uri(secret: str, account_label: str) -> str:
    """Construit l'URI ``otpauth://`` à encoder en QR code.

    :param secret: secret base32 renvoyé par :func:`generate_totp_secret`.
    :param account_label: identifiant lisible du compte (e-mail ou pseudonyme).
    """
    if not secret:
        raise ValueError("Le secret TOTP est obligatoire.")
    if not account_label:
        raise ValueError("Le libellé du compte est obligatoire.")

    name = issuer()
    # pyotp encode déjà le libellé ; on préfixe par l'émetteur pour obtenir le
    # format « Émetteur:compte » attendu par Google Authenticator et Aegis.
    return (
        f"otpauth://totp/{quote(name)}:{quote(account_label)}"
        f"?secret={secret}&issuer={quote(name)}"
        f"&algorithm=SHA1&digits={DIGITS}&period={PERIOD}"
    )


def normalize_code(code: str) -> str:
    """Nettoie un code saisi : retire espaces, tirets et caractères parasites."""
    if not isinstance(code, str):
        return ""
    return "".join(character for character in code if character.isdigit())


def _totp(secret: str) -> pyotp.TOTP:
    return pyotp.TOTP(secret, digits=DIGITS, interval=PERIOD)


def verify_totp_step(secret: str, code: str, *, for_time: int | None = None) -> int | None:
    """Vérifie un code TOTP et retourne le pas de temps validé.

    :return: le numéro de pas (``timestamp // 30``) si le code est bon, sinon
        ``None``. Le service doit refuser un pas déjà consommé pour ce compte,
        ce qui interdit le rejeu d'un code volé dans sa fenêtre de validité.
    """
    if not secret:
        return None
    candidate = normalize_code(code)
    if len(candidate) != DIGITS:
        return None

    totp = _totp(secret)
    reference = for_time if for_time is not None else int(time.time())
    current_step = reference // PERIOD

    for offset in range(-VALID_WINDOW, VALID_WINDOW + 1):
        step = current_step + offset
        expected = totp.at(step * PERIOD)
        if secrets.compare_digest(expected, candidate):
            return step
    return None


def verify_totp(secret: str, code: str, *, for_time: int | None = None) -> bool:
    """Vérifie un code TOTP (fenêtre ±1 pas)."""
    return verify_totp_step(secret, code, for_time=for_time) is not None


# --------------------------------------------------------------------------- #
# Codes de secours
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class RecoveryCodes:
    """Codes de secours fraîchement générés.

    :ivar codes: valeurs en clair, à montrer **une seule fois** au joueur.
    :ivar hashes: empreintes ``pbkdf2:sha256`` au format Werkzeug, à stocker en
                  base (``auth_recovery_code.code_hash``) dans le même ordre.
    """

    codes: tuple[str, ...]
    hashes: tuple[str, ...]


def _random_recovery_code() -> str:
    """Tire un code de secours au format ``XXXX-XXXX`` (40 bits d'entropie)."""
    blocks = [
        "".join(secrets.choice(_RECOVERY_ALPHABET) for _ in range(_RECOVERY_BLOCK))
        for _ in range(2)
    ]
    return "-".join(blocks)


def _draw_recovery_codes(count: int) -> tuple[str, ...]:
    """Tire ``count`` codes de secours distincts, sans encore les hacher."""
    if count < 1:
        raise ValueError("Il faut générer au moins un code de secours.")
    codes: list[str] = []
    while len(codes) < count:
        candidate = _random_recovery_code()
        if candidate not in codes:  # évite un doublon improbable mais gênant
            codes.append(candidate)
    return tuple(codes)


def generate_recovery_codes(count: int = RECOVERY_CODE_COUNT) -> RecoveryCodes:
    """Génère ``count`` codes de secours à usage unique et leurs empreintes.

    .. warning::
       Bloquante : ``count`` dérivations PBKDF2 à la suite, soit environ une
       demi-seconde de processeur pour dix codes. Depuis une coroutine, appelez
       :func:`generate_recovery_codes_async`.
    """
    codes = _draw_recovery_codes(count)
    return RecoveryCodes(
        codes=codes,
        hashes=tuple(hash_secret(_canonical_recovery(code)) for code in codes),
    )


def _canonical_recovery(code: str) -> str:
    """Forme canonique d'un code de secours : majuscules, sans séparateurs."""
    return "".join(
        character
        for character in str(code).upper()
        if character in _RECOVERY_ALPHABET
    )


def verify_recovery_code(code: str, hashes: list[str] | tuple[str, ...]) -> int | None:
    """Cherche à quel code de secours stocké correspond la saisie.

    :return: l'index du code consommé dans ``hashes``, ou ``None``. L'appelant
        doit immédiatement supprimer ou marquer cette empreinte : les codes de
        secours sont à usage unique.

    Toutes les empreintes sont testées, même après une correspondance, pour ne
    pas révéler par le temps de réponse la position du code dans la liste.

    .. warning::
       Bloquante, comme :func:`generate_recovery_codes`. Depuis une coroutine,
       appelez :func:`verify_recovery_code_async`.
    """
    canonical = _canonical_recovery(code)
    if len(canonical) != 2 * _RECOVERY_BLOCK:
        return None

    found: int | None = None
    for index, stored in enumerate(hashes):
        if verify_secret(stored, canonical) and found is None:
            found = index
    return found


# --------------------------------------------------------------------------- #
# Variantes asynchrones — à utiliser depuis toute coroutine
# --------------------------------------------------------------------------- #
#
# Dix empreintes à SECRET_ITERATIONS itérations, c'est un demi-million
# d'itérations PBKDF2-SHA256 : environ une demi-seconde pendant laquelle la
# boucle d'évènements ne répond plus à personne. Les deux fonctions ci-dessous
# déportent chaque dérivation dans un fil ; PBKDF2 relâchant le verrou global,
# les dix avancent réellement de front.


async def generate_recovery_codes_async(
    count: int = RECOVERY_CODE_COUNT,
) -> RecoveryCodes:
    """:func:`generate_recovery_codes`, hors boucle d'évènements.

    ``asyncio.gather`` conserve l'ordre des tâches : la n-ième empreinte reste
    celle du n-ième code, ce sur quoi comptent l'affichage unique au joueur et
    l'insertion en base.
    """
    codes = _draw_recovery_codes(count)
    hashes = await asyncio.gather(
        *(hash_secret_async(_canonical_recovery(code)) for code in codes)
    )
    return RecoveryCodes(codes=codes, hashes=tuple(hashes))


async def verify_recovery_code_async(
    code: str, hashes: list[str] | tuple[str, ...]
) -> int | None:
    """:func:`verify_recovery_code`, hors boucle d'évènements.

    Toutes les empreintes sont vérifiées, même après une correspondance : ni le
    temps de réponse ni le nombre de dérivations ne disent à quelle position se
    trouvait le code consommé.
    """
    canonical = _canonical_recovery(code)
    if len(canonical) != 2 * _RECOVERY_BLOCK:
        return None

    matches = await asyncio.gather(
        *(verify_secret_async(stored, canonical) for stored in hashes)
    )
    for index, matched in enumerate(matches):
        if matched:
            return index
    return None
