"""Mots de passe — format **Werkzeug**, partagé avec le site Flask.

Pourquoi pas Argon2id ?
=======================

La base PostgreSQL est **celle du site**, pas la nôtre. La colonne
``users.password_hash`` est écrite par Flask via
``werkzeug.security.generate_password_hash``, qui produit aujourd'hui du
``pbkdf2:sha256:260000$<sel>$<empreinte hex>``.

Si le serveur d'authentification réécrivait ces empreintes en Argon2id, le site
ne saurait plus les vérifier — Werkzeug ne connaît pas ce format — et **les
joueurs ne pourraient plus se connecter au site**. Un compte, deux portes
d'entrée : le format d'empreinte doit rester commun aux deux.

On lit donc et on écrit le format Werkzeug, mais on refuse d'en dépendre :
``werkzeug`` n'est pas installé côté serveur d'authentification. Tout est
réimplémenté ici avec :mod:`hashlib` et :mod:`hmac`, à l'octet près.

Renforcement transparent
========================

À chaque connexion réussie, :func:`verify_and_update` regarde l'empreinte
stockée : si elle n'est pas en ``pbkdf2:sha256`` ou si son nombre d'itérations
est inférieur à la cible (600 000 par défaut, ``OPM_PASSWORD_ITERATIONS``), elle
est recalculée et l'appelant la persiste. Werkzeug lit le nombre d'itérations
**dans l'empreinte elle-même** : le site continue de fonctionner sans une ligne
de code à changer, et le parc se durcit tout seul, au fil des connexions.

Aucune invalidation rétroactive : un compte jamais reconnecté garde son
empreinte à 260 000 itérations et fonctionne toujours.

Migrer vers Argon2id plus tard
==============================

Le jour où le site migrera aussi, la bascule tient en trois points, tous dans ce
fichier :

1. :func:`hash_password` produit le nouveau format ;
2. :func:`parse_hash` et :func:`verify_password` apprennent à le relire, en
   gardant ``pbkdf2``/``scrypt`` pour le parc existant ;
3. :func:`needs_rehash` déclare obsolète tout ce qui n'est pas le nouveau format.

Le reste du serveur n'appelle que :func:`hash_password`,
:func:`verify_password`, :func:`verify_and_update` et
:func:`check_password_strength` : rien d'autre n'a à bouger. **Tant que le site
n'a pas migré, ne touchez pas à ces trois points.**

Appel depuis une coroutine
==========================

Une dérivation PBKDF2 est un calcul de plusieurs centaines de millisecondes,
verrou global tenu : appelée telle quelle dans une coroutine, elle fige tout le
processus. **Depuis un service asynchrone, appelez les variantes suffixées
``_async``** (:func:`verify_and_update_async`, :func:`hash_password_async`,
:func:`verify_password_async`, :func:`verify_secret_async`) : elles déportent le
calcul dans un fil et, pour les chemins de connexion, imposent le budget de
temps constant décrit sur :data:`DEFAULT_LOGIN_TIME_BUDGET_MS`. Les fonctions
synchrones restent la référence, et l'API des scripts et des tests.

Notes d'implémentation
======================

* ``users.password_hash`` est un ``character varying(255)``. Notre format le
  plus long fait 102 caractères (``pbkdf2:sha256:600000`` + ``$`` + 16 de sel +
  ``$`` + 64 d'hexadécimal) : la marge est confortable.
* Le mot de passe est encodé en **UTF-8 brut**, sans normalisation Unicode,
  exactement comme Werkzeug (voir :func:`_encode`). C'est une contrainte de
  compatibilité, pas un oubli.
* Le module ne journalise jamais un mot de passe ni une empreinte, même
  tronquée (``docs/API.md`` §4.8). Seule l'étiquette de méthode, qui n'est pas
  un secret, peut apparaître dans les journaux.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import secrets
import string
import time
import unicodedata
from dataclasses import dataclass
from typing import Any, Callable

from opm_auth.security import setting

logger = logging.getLogger(__name__)

__all__ = [
    "COMMON_PASSWORDS",
    "DEFAULT_ITERATIONS",
    "DEFAULT_LOGIN_TIME_BUDGET_MS",
    "InvalidPasswordHash",
    "LEGACY_SITE_ITERATIONS",
    "MALFORMED_TEST_HASHES",
    "MAX_PASSWORD_LENGTH",
    "MIN_PASSWORD_LENGTH",
    "PasswordHash",
    "SALT_LENGTH",
    "TEST_VECTORS",
    "TEST_VECTORS_NEEDING_REHASH",
    "TEST_VECTOR_PASSWORD",
    "WeakPasswordError",
    "check_password_strength",
    "check_strength",
    "generate_salt",
    "hash_password",
    "hash_password_async",
    "hash_secret",
    "hash_secret_async",
    "login_time_budget",
    "needs_rehash",
    "normalize_password",
    "parse_hash",
    "password_issues",
    "target_iterations",
    "verify",
    "verify_and_update",
    "verify_and_update_async",
    "verify_async",
    "verify_password",
    "verify_password_async",
    "verify_secret",
    "verify_secret_async",
]

# --------------------------------------------------------------------------- #
# Paramètres du format Werkzeug
# --------------------------------------------------------------------------- #

#: Alphabet du sel, identique à ``werkzeug.security.SALT_CHARS``.
SALT_CHARS: str = string.ascii_letters + string.digits

#: Longueur du sel, en caractères. Werkzeug utilise 16 par défaut.
SALT_LENGTH: int = 16

#: Fonction de hachage sous-jacente de notre format canonique.
PBKDF2_HASH_NAME: str = "sha256"

#: Cible d'itérations à l'écriture (recommandation OWASP 2023 pour PBKDF2-SHA256).
DEFAULT_ITERATIONS: int = 600_000

#: Ce que le site écrit aujourd'hui (Werkzeug < 2.3). Sert aussi de première
#: hypothèse quand une empreinte omet son nombre d'itérations.
LEGACY_SITE_ITERATIONS: int = 260_000

#: Défaut de Werkzeug ≥ 2.3, seconde hypothèse pour une empreinte ambiguë.
MODERN_WERKZEUG_ITERATIONS: int = 600_000

#: Garde-fous contre une ligne corrompue qui ferait travailler le serveur
#: pendant des heures ou saturerait sa mémoire.
MIN_ITERATIONS: int = 1_000
MAX_ITERATIONS: int = 10_000_000
_SCRYPT_MAX_MEMORY: int = 1 << 30  # 1 Gio

#: Coût des empreintes de secrets générés par nous (codes de secours TOTP).
#:
#: Un code de secours ``XXXX-XXXX`` pèse 40 bits d'entropie — bien plus qu'un
#: mot de passe humain, mais pas assez pour se passer de coût de dérivation :
#: en cas de fuite de la base, 2^40 essais hors ligne ne sont hors de portée que
#: si chaque essai coûte cher. 50 000 itérations placent cette attaque à ~5·10^16
#: opérations SHA-256, tout en gardant :func:`verify_secret` utilisable :
#: :mod:`opm_auth.security.totp` teste les dix empreintes à chaque tentative,
#: soit environ une demi-seconde — un coût payé sur un chemin rare (perte du
#: téléphone), déjà protégé par la limitation de débit ``auth.totp.account``.
SECRET_ITERATIONS: int = 50_000

#: Garde-fou absolu appliqué avant toute dérivation.
_HARD_LENGTH_LIMIT: int = 1024

#: Budget de temps constant d'une **vérification** de mot de passe, en
#: millisecondes (``OPM_LOGIN_TIME_BUDGET_MS``). Les fonctions asynchrones de ce
#: module attendent cette échéance avant de rendre la main, quel que soit le
#: chemin parcouru : compte inconnu, empreinte illisible, mot de passe faux ou
#: mot de passe juste.
#:
#: Sans ce plancher, le temps de réponse trahit l'existence du compte : une
#: empreinte du parc actuel (260 000 itérations) se vérifie en ~0,14 s alors
#: qu'un compte inconnu payait ~0,34 s de calcul factice — un écart de 2,4x,
#: parfaitement mesurable à travers le réseau, qui permettait d'énumérer les
#: adresses e-mail inscrites (``docs/API.md`` §4.6). Égaliser par le nombre
#: d'itérations est illusoire : le parc mélange 260 000, 600 000 et scrypt.
#: Seule une échéance fixe rend les chemins indiscernables.
#:
#: 750 ms laissent une marge confortable au pire cas de vérification (600 000
#: itérations, ~0,55 s sur une machine modeste). Un dépassement est signalé une
#: fois dans les journaux. Mettre 0 désactive l'attente — pour les tests, ou
#: pour un parc plus coûteux que ce budget.
DEFAULT_LOGIN_TIME_BUDGET_MS: int = 750


def login_time_budget() -> float:
    """Budget de temps d'une vérification, en secondes (0 = désactivé)."""
    try:
        value = int(setting("login_time_budget_ms", DEFAULT_LOGIN_TIME_BUDGET_MS))
    except (TypeError, ValueError):
        logger.warning(
            "OPM_LOGIN_TIME_BUDGET_MS est illisible : repli sur %d ms.",
            DEFAULT_LOGIN_TIME_BUDGET_MS,
        )
        return DEFAULT_LOGIN_TIME_BUDGET_MS / 1000.0
    return max(0, value) / 1000.0


def target_iterations() -> int:
    """Nombre d'itérations visé à l'écriture (``OPM_PASSWORD_ITERATIONS``).

    Lu à chaque appel — et non figé à l'import — pour qu'une suite de tests
    puisse abaisser le coût sans réimporter le module. La valeur est bornée par
    :data:`MIN_ITERATIONS` et :data:`MAX_ITERATIONS` : une coquille dans la
    configuration ne peut donc ni affaiblir dangereusement le hachage, ni
    bloquer le serveur.
    """
    try:
        value = int(setting("password_iterations", DEFAULT_ITERATIONS))
    except (TypeError, ValueError):
        logger.warning(
            "OPM_PASSWORD_ITERATIONS est illisible : repli sur %d.", DEFAULT_ITERATIONS
        )
        return DEFAULT_ITERATIONS
    return max(MIN_ITERATIONS, min(value, MAX_ITERATIONS))


def generate_salt(length: int = SALT_LENGTH) -> str:
    """Tire un sel alphanumérique, à la manière de ``werkzeug.security.gen_salt``.

    Le sel voyage en clair dans l'empreinte : c'est une chaîne de caractères,
    pas des octets hexadécimaux, et il est encodé en UTF-8 tel quel au moment
    de la dérivation.
    """
    if length < 8:
        raise ValueError("Un sel de moins de 8 caractères est inacceptable.")
    return "".join(secrets.choice(SALT_CHARS) for _ in range(length))


# --------------------------------------------------------------------------- #
# Lecture d'une empreinte
# --------------------------------------------------------------------------- #


class InvalidPasswordHash(ValueError):
    """Empreinte stockée illisible.

    Levée uniquement par :func:`parse_hash`. Les fonctions publiques de
    vérification l'absorbent et renvoient ``False`` : une empreinte corrompue en
    base ne doit jamais provoquer une erreur 500 au moment de la connexion.

    :ivar reason: motif court, sans donnée sensible, destiné aux journaux.
    """

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


@dataclass(frozen=True, slots=True, repr=False)
class PasswordHash:
    """Empreinte Werkzeug décomposée.

    :ivar scheme: ``"pbkdf2"`` ou ``"scrypt"``.
    :ivar method: étiquette de méthode brute (``"pbkdf2:sha256:260000"``…),
                  seule partie de l'empreinte que l'on s'autorise à journaliser.
    :ivar salt: sel, tel qu'il apparaît dans l'empreinte (chaîne, pas des octets).
    :ivar digest: empreinte attendue, décodée depuis l'hexadécimal.
    :ivar hash_name: fonction de hachage PBKDF2 (``"sha256"``…), sinon ``None``.
    :ivar iterations: itérations PBKDF2, ou ``None`` si la méthode les omettait.
    :ivar n: coût CPU/mémoire scrypt, sinon ``None``.
    :ivar r: taille de bloc scrypt, sinon ``None``.
    :ivar p: parallélisme scrypt, sinon ``None``.
    """

    scheme: str
    method: str
    salt: str
    digest: bytes
    hash_name: str | None = None
    iterations: int | None = None
    n: int | None = None
    r: int | None = None
    p: int | None = None

    def __repr__(self) -> str:
        """Représentation volontairement muette : ni sel, ni empreinte."""
        return (
            f"<PasswordHash méthode={self.method!r} sel={len(self.salt)}c "
            f"empreinte={len(self.digest)}o>"
        )

    def iteration_candidates(self) -> tuple[int, ...]:
        """Itérations à essayer pour vérifier cette empreinte.

        Une méthode ``pbkdf2:sha256`` sans nombre d'itérations est **ambiguë** :
        Werkzeug < 2.3 sous-entendait 260 000, Werkzeug ≥ 2.3 sous-entend
        600 000. Plutôt que de parier et de refuser à tort une connexion
        légitime, on essaie les deux. Le cas est rare, et
        :func:`needs_rehash` marque ces empreintes comme à réécrire : la
        connexion suivante lèvera l'ambiguïté définitivement.
        """
        if self.scheme != "pbkdf2":
            return ()
        if self.iterations is not None:
            return (self.iterations,)
        return (LEGACY_SITE_ITERATIONS, MODERN_WERKZEUG_ITERATIONS)


def _parse_pbkdf2(args: list[str]) -> tuple[str, int | None]:
    """Décode les paramètres d'une méthode ``pbkdf2`` (``hash_name``, itérations).

    Trois formes acceptées, comme Werkzeug : ``pbkdf2`` (tout implicite),
    ``pbkdf2:sha256`` (itérations implicites) et ``pbkdf2:sha256:260000``.
    """
    if len(args) > 2:
        raise InvalidPasswordHash("méthode pbkdf2 à plus de deux paramètres")

    hash_name = args[0].strip().lower() if args and args[0].strip() else PBKDF2_HASH_NAME
    if hash_name not in hashlib.algorithms_available:
        raise InvalidPasswordHash(f"fonction de hachage inconnue ({hash_name})")

    if len(args) < 2:
        return hash_name, None

    try:
        iterations = int(args[1])
    except ValueError as exc:
        raise InvalidPasswordHash("nombre d'itérations non numérique") from exc
    if not 1 <= iterations <= MAX_ITERATIONS:
        raise InvalidPasswordHash("nombre d'itérations hors bornes")
    return hash_name, iterations


def _parse_scrypt(args: list[str]) -> tuple[int, int, int]:
    """Décode les paramètres d'une méthode ``scrypt`` (``n``, ``r``, ``p``).

    ``scrypt`` seul vaut les défauts de Werkzeug ≥ 2.3 : ``n=2**15, r=8, p=1``.
    """
    if not args:
        return 2**15, 8, 1
    if len(args) != 3:
        raise InvalidPasswordHash("méthode scrypt mal paramétrée")
    try:
        n, r, p = (int(value) for value in args)
    except ValueError as exc:
        raise InvalidPasswordHash("paramètres scrypt non numériques") from exc
    if n < 2 or n & (n - 1) or r < 1 or p < 1:
        raise InvalidPasswordHash("paramètres scrypt invalides")
    if 132 * n * r * p > _SCRYPT_MAX_MEMORY:
        raise InvalidPasswordHash("paramètres scrypt trop gourmands en mémoire")
    return n, r, p


def parse_hash(stored_hash: str) -> PasswordHash:
    """Décompose une empreinte au format Werkzeug ``méthode$sel$hexadécimal``.

    Formats reconnus :

    * ``pbkdf2:sha256:260000$<sel>$<hex>`` — ce que le site écrit aujourd'hui ;
    * ``pbkdf2:sha256:600000$<sel>$<hex>`` — ce que **nous** écrivons ;
    * ``pbkdf2:sha256$<sel>$<hex>`` et ``pbkdf2$<sel>$<hex>`` — paramètres omis ;
    * ``scrypt:32768:8:1$<sel>$<hex>`` et ``scrypt$<sel>$<hex>`` — Werkzeug ≥ 2.3 ;
    * une étiquette de méthode vide (``$<sel>$<hex>``) est traitée comme
      ``pbkdf2:sha256`` à itérations implicites, par simple tolérance.

    Les méthodes historiques retirées de Werkzeug 2.3 (``sha1$…``, ``md5$…``)
    ne sont **pas** reconnues : le site lui-même ne saurait plus les vérifier.

    :raises InvalidPasswordHash: format inexploitable. Les appelants publics
        absorbent cette erreur ; ne l'utilisez directement que dans les tests.
    """
    if not isinstance(stored_hash, str):
        raise InvalidPasswordHash("empreinte absente ou non textuelle")

    candidate = stored_hash.strip()
    if not candidate:
        raise InvalidPasswordHash("empreinte vide")

    parts = candidate.split("$", 2)
    if len(parts) != 3:
        raise InvalidPasswordHash("séparateurs « $ » manquants")

    method, salt, digest_hex = parts
    if not salt or len(salt) > 128:
        raise InvalidPasswordHash("sel absent ou démesuré")
    if not digest_hex:
        raise InvalidPasswordHash("empreinte hexadécimale absente")

    try:
        digest = bytes.fromhex(digest_hex)
    except ValueError as exc:
        raise InvalidPasswordHash("empreinte non hexadécimale") from exc

    scheme, *args = method.strip().split(":")
    scheme = scheme.strip().lower() or "pbkdf2"

    if scheme == "pbkdf2":
        hash_name, iterations = _parse_pbkdf2(args)
        return PasswordHash(
            scheme="pbkdf2",
            method=method,
            salt=salt,
            digest=digest,
            hash_name=hash_name,
            iterations=iterations,
        )
    if scheme == "scrypt":
        n, r, p = _parse_scrypt(args)
        return PasswordHash(
            scheme="scrypt", method=method, salt=salt, digest=digest, n=n, r=r, p=p
        )

    raise InvalidPasswordHash(f"méthode non prise en charge ({scheme})")


# --------------------------------------------------------------------------- #
# Dérivation et comparaison
# --------------------------------------------------------------------------- #


def _encode(password: str) -> bytes:
    """Encode un mot de passe en UTF-8 **brut**, comme ``password.encode()``.

    Surtout **ne pas** normaliser en NFKC ici : Flask hache la chaîne telle
    qu'elle arrive. Normaliser de notre côté produirait, pour certains mots de
    passe, une empreinte que le site ne saurait pas reproduire — précisément la
    panne que tout ce module cherche à éviter. La normalisation reste utilisée
    pour l'*analyse* de robustesse (voir :func:`normalize_password`), jamais
    pour la dérivation.

    :raises InvalidPasswordHash: mot de passe non encodable (surrogats isolés).
    """
    try:
        return password.encode("utf-8")
    except UnicodeEncodeError as exc:  # pragma: no cover - saisie exotique
        raise InvalidPasswordHash("mot de passe non encodable en UTF-8") from exc


def _derive(parsed: PasswordHash, password: bytes, iterations: int | None) -> bytes:
    """Recalcule l'empreinte d'un mot de passe selon les paramètres analysés.

    La longueur de clé dérivée n'est jamais imposée : on laisse les défauts de
    :mod:`hashlib`, qui sont ceux de Werkzeug (32 octets pour PBKDF2-SHA256,
    64 pour scrypt). Une empreinte stockée de longueur inattendue échouera donc
    à la comparaison, ce qui est le comportement voulu.
    """
    salt = parsed.salt.encode("utf-8")
    if parsed.scheme == "pbkdf2":
        assert parsed.hash_name is not None and iterations is not None
        return hashlib.pbkdf2_hmac(parsed.hash_name, password, salt, iterations)
    assert parsed.n is not None and parsed.r is not None and parsed.p is not None
    return hashlib.scrypt(
        password,
        salt=salt,
        n=parsed.n,
        r=parsed.r,
        p=parsed.p,
        maxmem=132 * parsed.n * parsed.r * parsed.p,
    )


def _matches(parsed: PasswordHash, password: str) -> bool:
    """Compare, en temps constant, un mot de passe à une empreinte analysée."""
    try:
        encoded = _encode(password)
    except InvalidPasswordHash:
        return False

    if parsed.scheme == "scrypt":
        attempts: tuple[int | None, ...] = (None,)
    else:
        attempts = parsed.iteration_candidates()

    found = False
    for iterations in attempts:
        try:
            computed = _derive(parsed, encoded, iterations)
        except (ValueError, MemoryError, OverflowError):
            # Paramètres refusés par OpenSSL (scrypt indisponible, n trop grand…).
            logger.warning(
                "Dérivation impossible pour une empreinte « %s ».", parsed.method
            )
            return False
        # Pas de sortie anticipée : toutes les hypothèses sont évaluées pour ne
        # pas transformer le nombre de dérivations en canal auxiliaire.
        found |= hmac.compare_digest(computed, parsed.digest)
    return found


def _burn_cpu() -> None:
    """Consomme le temps d'une vérification réelle, sans en faire une.

    Appelée quand aucun compte ne correspond ou que l'empreinte stockée est
    illisible. Sans elle, la réponse immédiate trahirait l'inexistence du compte
    (``docs/API.md`` §4.6, anti-énumération).

    Le coût imité est celui du **parc existant** — :data:`LEGACY_SITE_ITERATIONS`,
    soit les 260 000 itérations que le site écrit aujourd'hui — et non la cible
    d'écriture (600 000). Brûler la cible rendait un compte inconnu deux fois et
    demie plus lent qu'un compte réel : le calcul destiné à masquer l'absence de
    compte la désignait au contraire.

    Ce réglage ne referme pas l'écart à lui seul : le coût réel varie d'une ligne
    à l'autre (260 000, 600 000, scrypt). C'est le budget de temps constant des
    fonctions asynchrones (:func:`login_time_budget`) qui rend les trois chemins
    indiscernables ; ce calcul-ci garde simplement le chemin factice dans le même
    ordre de grandeur pour les appelants synchrones (CLI, tests).
    """
    hashlib.pbkdf2_hmac(
        PBKDF2_HASH_NAME,
        b"empreinte-factice-anti-enumeration",
        b"sel-factice-opm",
        LEGACY_SITE_ITERATIONS,
    )


def verify_password(stored_hash: str | None, password: str) -> bool:
    """Vérifie un mot de passe face à son empreinte stockée.

    Ne lève **jamais** : une empreinte absente, corrompue ou produite par un
    algorithme inconnu renvoie ``False`` et laisse une trace dans les journaux
    qui ne divulgue ni le sel, ni l'empreinte, ni le mot de passe.

    :param stored_hash: contenu de ``users.password_hash``.
    :param password: mot de passe en clair, tel que saisi.

    .. warning::
       L'ordre des arguments est ``(empreinte, mot de passe)``. La variante
       :func:`verify` prend l'ordre inverse, plus naturel à la lecture.
    """
    if not isinstance(stored_hash, str) or not stored_hash:
        _burn_cpu()
        return False
    if not isinstance(password, str) or len(password) > _HARD_LENGTH_LIMIT:
        _burn_cpu()
        return False

    try:
        parsed = parse_hash(stored_hash)
    except InvalidPasswordHash as exc:
        logger.warning("Empreinte de mot de passe inexploitable : %s.", exc.reason)
        _burn_cpu()
        return False

    return _matches(parsed, password)


def verify(password: str, stored_hash: str | None) -> bool:
    """Vérifie un mot de passe — ordre ``(mot de passe, empreinte)``.

    Strict équivalent de :func:`verify_password`, arguments inversés. Les deux
    existent parce que le reste du serveur appelle historiquement
    :func:`verify_password`. Une inversion accidentelle échoue de façon sûre :
    un mot de passe ne s'analyse pas comme une empreinte, le résultat est
    ``False``, jamais ``True``.
    """
    return verify_password(stored_hash, password)


def hash_password(password: str) -> str:
    """Calcule l'empreinte d'un mot de passe, au format lisible par le site.

    Produit ``pbkdf2:sha256:<itérations>$<sel 16 caractères>$<64 hexadécimaux>``,
    soit exactement ce que ``werkzeug.security.generate_password_hash`` écrirait.
    Un compte créé depuis le launcher se connecte donc au site sans rien de plus.

    La robustesse n'est **pas** contrôlée ici : appelez
    :func:`check_strength` en amont, à l'inscription et au changement de mot
    de passe.

    :raises TypeError: ``password`` n'est pas une chaîne.
    :raises ValueError: mot de passe démesuré (déni de service par hachage).
    """
    if not isinstance(password, str):
        raise TypeError("Le mot de passe doit être une chaîne de caractères.")
    if len(password) > _HARD_LENGTH_LIMIT:
        raise ValueError("Mot de passe trop long.")

    iterations = target_iterations()
    salt = generate_salt()
    digest = hashlib.pbkdf2_hmac(
        PBKDF2_HASH_NAME, _encode(password), salt.encode("utf-8"), iterations, dklen=32
    )
    return f"pbkdf2:{PBKDF2_HASH_NAME}:{iterations}${salt}${digest.hex()}"


def needs_rehash(stored_hash: str | None) -> bool:
    """Indique si l'empreinte doit être réécrite à la prochaine connexion.

    Renvoie ``True`` quand l'empreinte :

    * est absente ou illisible ;
    * n'est pas du ``pbkdf2:sha256`` (scrypt, PBKDF2-SHA512…) ;
    * omet son nombre d'itérations, donc reste ambiguë entre deux versions de
      Werkzeug ;
    * compte moins d'itérations que la cible (:func:`target_iterations`) ;
    * porte un sel de moins de 8 caractères.

    Le format de sortie reste du Werkzeug : réécrire ne coupe jamais l'accès au
    site.
    """
    if not isinstance(stored_hash, str) or not stored_hash:
        return True
    try:
        parsed = parse_hash(stored_hash)
    except InvalidPasswordHash:
        return True
    if parsed.scheme != "pbkdf2" or parsed.hash_name != PBKDF2_HASH_NAME:
        return True
    if parsed.iterations is None:
        return True
    if len(parsed.salt) < 8:
        return True
    return parsed.iterations < target_iterations()


def verify_and_update(stored_hash: str | None, password: str) -> tuple[bool, str | None]:
    """Vérifie un mot de passe et, au besoin, calcule une empreinte renforcée.

    C'est la porte d'entrée de la connexion : elle réalise à elle seule le
    renforcement transparent décrit en tête de module.

    :return: ``(valide, nouvelle_empreinte)``. ``nouvelle_empreinte`` vaut
             ``None`` quand il n'y a rien à réécrire ; sinon l'appelant doit la
             persister dans ``users.password_hash`` au cours de la même
             transaction.
    """
    if not verify_password(stored_hash, password):
        return False, None
    if needs_rehash(stored_hash):
        try:
            return True, hash_password(password)
        except (TypeError, ValueError):  # pragma: no cover - garde-fou
            logger.warning("Renforcement d'empreinte impossible, ancien format gardé.")
            return True, None
    return True, None


# --------------------------------------------------------------------------- #
# Variantes asynchrones — à utiliser depuis toute coroutine
# --------------------------------------------------------------------------- #
#
# Une dérivation PBKDF2 à 600 000 itérations coûte 0,3 à 0,5 s de processeur,
# verrou global tenu. Appelée directement depuis une coroutine, elle **fige le
# processus entier** : pendant ce temps, ni ``/status``, ni le relevé de
# fréquentation, ni surtout le ``hasJoined`` du serveur Minecraft ne reçoivent
# de réponse — et un ``hasJoined`` en retard, c'est un joueur éjecté du serveur.
# Dix connexions simultanées suffisent à immobiliser le serveur plusieurs
# secondes ; dix connexions ratées aussi, chacune payant son calcul factice.
#
# Les variantes ci-dessous déportent le calcul dans un fil d'exécution
# (``asyncio.to_thread``, comme le font déjà ``services/mailer.py`` et
# ``services/textures.py``) et, pour les chemins de connexion, attendent une
# échéance commune. Les fonctions synchrones restent la référence : la CLI et
# les tests continuent de les appeler directement.


#: Vrai une fois le dépassement de budget signalé : un avertissement par
#: processus suffit, il n'y a rien à répéter à chaque connexion.
_budget_warned: bool = False


async def _timed(func: Callable[..., Any], *args: Any) -> Any:
    """Exécute une dérivation hors de la boucle, puis attend l'échéance commune.

    L'attente a lieu même lorsque la fonction lève : un mot de passe démesuré ne
    doit pas répondre plus vite qu'un mot de passe ordinaire. Si le calcul a
    déjà dépassé le budget, on rend la main immédiatement — le budget est un
    plancher, jamais un plafond — et on le signale **une fois** : un budget trop
    court laisse réapparaître l'écart de temps qu'il devait effacer.
    """
    global _budget_warned
    budget = login_time_budget()
    started = time.monotonic()
    try:
        return await asyncio.to_thread(func, *args)
    finally:
        elapsed = time.monotonic() - started
        remaining = budget - elapsed
        if remaining > 0:
            await asyncio.sleep(remaining)
        elif budget and not _budget_warned:
            _budget_warned = True
            logger.warning(
                "Une vérification de mot de passe a duré %.0f ms, au-delà du budget "
                "de %.0f ms : le temps de réponse redevient révélateur. Augmentez "
                "OPM_LOGIN_TIME_BUDGET_MS ou baissez OPM_PASSWORD_ITERATIONS.",
                elapsed * 1000,
                budget * 1000,
            )


async def verify_password_async(stored_hash: str | None, password: str) -> bool:
    """:func:`verify_password`, hors boucle d'évènements et à temps constant."""
    return await _timed(verify_password, stored_hash, password)


async def verify_async(password: str, stored_hash: str | None) -> bool:
    """:func:`verify`, hors boucle d'évènements et à temps constant."""
    return await _timed(verify, password, stored_hash)


async def verify_and_update_async(
    stored_hash: str | None, password: str
) -> tuple[bool, str | None]:
    """:func:`verify_and_update`, hors boucle d'évènements et à temps constant.

    C'est **la** fonction que doit appeler la couche service à la connexion.

    Le budget de temps couvre exactement la partie sensible : la **vérification**,
    dont la durée dirait autrement si le compte existe. Les trois issues qui
    précèdent l'authentification — compte inconnu, empreinte illisible, mot de
    passe faux — durent donc rigoureusement le même temps.

    Le renforcement éventuel se fait **après** cette fenêtre, sans coussin : il
    n'a lieu qu'une fois le mot de passe reconnu juste, c'est-à-dire face à
    quelqu'un qui connaît déjà le mot de passe et n'apprend donc rien. L'inclure
    dans le budget aurait obligé à doubler ce dernier — et à faire attendre une
    seconde entière chaque joueur, y compris pour une tentative ratée.
    """
    valid = await _timed(verify_password, stored_hash, password)
    if not valid:
        return False, None
    if not needs_rehash(stored_hash):
        return True, None
    try:
        return True, await asyncio.to_thread(hash_password, password)
    except (TypeError, ValueError):  # pragma: no cover - garde-fou
        logger.warning("Renforcement d'empreinte impossible, ancien format gardé.")
        return True, None


async def hash_password_async(password: str) -> str:
    """:func:`hash_password`, hors boucle d'évènements.

    Pas de budget de temps ici : à l'inscription ou au changement de mot de
    passe, le compte est déjà connu de l'appelant, il n'y a rien à masquer.
    """
    return await asyncio.to_thread(hash_password, password)


# --------------------------------------------------------------------------- #
# Secrets à forte entropie (codes de secours TOTP, jetons à usage unique)
# --------------------------------------------------------------------------- #


def hash_secret(secret: str) -> str:
    """Empreinte d'un secret **généré par le serveur**, pas saisi par un humain.

    Même format Werkzeug que les mots de passe — une seule fonction de lecture à
    maintenir — mais à :data:`SECRET_ITERATIONS` itérations, pour la raison
    détaillée sur cette constante. Ces empreintes ne quittent jamais les tables
    du launcher (``auth_recovery_code.code_hash``) : le site ne les lit pas, et
    leur format pourrait donc changer sans rien casser chez lui.
    """
    if not isinstance(secret, str) or not secret:
        raise ValueError("Le secret à hacher ne peut pas être vide.")
    if len(secret) > _HARD_LENGTH_LIMIT:
        raise ValueError("Secret trop long.")

    salt = generate_salt()
    digest = hashlib.pbkdf2_hmac(
        PBKDF2_HASH_NAME,
        _encode(secret),
        salt.encode("utf-8"),
        SECRET_ITERATIONS,
        dklen=32,
    )
    return f"pbkdf2:{PBKDF2_HASH_NAME}:{SECRET_ITERATIONS}${salt}${digest.hex()}"


def verify_secret(stored_hash: str | None, secret: str) -> bool:
    """Vérifie un secret généré par le serveur face à son empreinte.

    Contrairement à :func:`verify_password`, aucune consommation de temps
    factice : un code de secours inexistant n'apprend rien à un attaquant, et
    l'appelant en teste plusieurs d'affilée.
    """
    if not isinstance(stored_hash, str) or not stored_hash:
        return False
    if not isinstance(secret, str) or not secret or len(secret) > _HARD_LENGTH_LIMIT:
        return False
    try:
        parsed = parse_hash(stored_hash)
    except InvalidPasswordHash as exc:
        logger.warning("Empreinte de secret inexploitable : %s.", exc.reason)
        return False
    return _matches(parsed, secret)


async def hash_secret_async(secret: str) -> str:
    """:func:`hash_secret`, hors boucle d'évènements."""
    return await asyncio.to_thread(hash_secret, secret)


async def verify_secret_async(stored_hash: str | None, secret: str) -> bool:
    """:func:`verify_secret`, hors boucle d'évènements.

    **Sans** budget de temps, à la différence des mots de passe :
    :mod:`opm_auth.security.totp` essaie les dix codes de secours à la suite ;
    un plancher par appel se paierait dix fois. Ces empreintes ne coûtent que
    :data:`SECRET_ITERATIONS` itérations, et l'existence d'un code de secours
    n'apprend rien à un attaquant.
    """
    return await asyncio.to_thread(verify_secret, stored_hash, secret)


# --------------------------------------------------------------------------- #
# Politique de robustesse
# --------------------------------------------------------------------------- #

#: Longueur minimale exigée à l'inscription (contrat : 12 caractères).
MIN_PASSWORD_LENGTH: int = setting("password_min_length", 12)
#: Longueur maximale acceptée, pour éviter le déni de service par hachage.
MAX_PASSWORD_LENGTH: int = setting("password_max_length", 128)

#: Liste courte de mots de passe notoires, écrite en clair pour rester lisible.
#: La comparaison porte sur la forme normalisée calculée par :func:`_fingerprint`
#: — minuscules, sans accents, sans substitutions « leet » — si bien que
#: ``M0nM0tD3P@sse`` et ``0n3P13c3M1n3cr@ft`` sont refusés au même titre que
#: ``monmotdepasse`` et ``onepieceminecraft``. Le filtre reste volontairement
#: modeste : il écarte les mots de passe notoires, il ne prétend pas remplacer
#: une liste de plusieurs millions d'entrées.
COMMON_PASSWORDS: frozenset[str] = frozenset(
    {
        "123456",
        "1234567890",
        "123456789012",
        "111111111111",
        "000000000000",
        "abcdefghijkl",
        "azerty",
        "azertyuiop",
        "azertyuiop123",
        "qwerty",
        "qwertyuiop",
        "qwertyuiop123",
        "motdepasse",
        "motdepasse1",
        "motdepasse123",
        "monmotdepasse",
        "password",
        "password1",
        "password123",
        "passwordpassword",
        "motdepassesecret",
        "administrateur",
        "administrator",
        "changemeplease",
        "changermotdepasse",
        "iloveyou",
        "iloveyouforever",
        "jetaimemonamour",
        "soleilsoleil",
        "bonjourbonjour",
        "coucoucoucou",
        "loulouloulou",
        "doudoudoudou",
        "footballfootball",
        "dragonballz123",
        "onepiece",
        "onepiece123",
        "onepiecelover",
        "onepieceminecraft",
        "onepieceminecraft1",
        "opmlauncher",
        "opmlauncher123",
        "minecraft",
        "minecraft123",
        "minecraftminecraft",
        "monkeydluffy",
        "monkeydluffy1",
        "roronoazoro",
        "chapeaudepaille",
        "grandline",
        "grandline123",
        "nakamanakama",
        "pirateking",
        "piratekingluffy",
        "gomugomunomi",
        "letmeinletmein",
        "trustno1trustno1",
        "welcomewelcome",
        "superman123",
        "starwars1977",
        "azerty123456",
        "qwerty123456",
        "1qaz2wsx3edc",
        "zaq12wsxcde3",
    }
)

#: Substitutions « leet » ramenées à la lettre d'origine avant comparaison.
_LEET_TABLE = str.maketrans(
    {
        "0": "o",
        "1": "i",
        "3": "e",
        "4": "a",
        "5": "s",
        "7": "t",
        "8": "b",
        "@": "a",
        "$": "s",
        "!": "i",
        "|": "i",
        "€": "e",
        "+": "t",
    }
)


class WeakPasswordError(ValueError):
    """Mot de passe refusé par la politique de robustesse.

    :ivar reasons: motifs de refus, rédigés en français et affichables tels
                   quels dans le launcher (``details.reasons`` de l'erreur
                   ``weak_password`` de ``docs/API.md``).
    """

    def __init__(self, reasons: list[str]) -> None:
        self.reasons: tuple[str, ...] = tuple(reasons)
        super().__init__(" ".join(self.reasons))


def normalize_password(password: str) -> str:
    """Normalise un mot de passe en NFKC — **pour l'analyse seulement**.

    Utilisée par :func:`password_issues` afin que ``ｐａｓｓｗｏｒｄ`` en pleine
    chasse soit reconnu comme ``password``. Elle n'intervient **jamais** avant
    une dérivation : voir :func:`_encode` pour la raison.
    """
    if not isinstance(password, str):
        raise TypeError("Le mot de passe doit être une chaîne de caractères.")
    return unicodedata.normalize("NFKC", password)


def _fingerprint(value: str) -> str:
    """Forme comparable d'un mot de passe : minuscules, sans accents ni « leet »."""
    decomposed = unicodedata.normalize("NFKD", value.strip().lower())
    without_accents = "".join(c for c in decomposed if not unicodedata.combining(c))
    return without_accents.translate(_LEET_TABLE)


#: Forme normalisée de :data:`COMMON_PASSWORDS`, calculée une seule fois.
_COMMON_FINGERPRINTS: frozenset[str] = frozenset(
    _fingerprint(entry) for entry in COMMON_PASSWORDS
)


def _is_monotonic_sequence(value: str) -> bool:
    """Vrai si la chaîne est une suite continue croissante ou décroissante.

    Attrape ``123456789012``, ``abcdefghijkl`` et leurs versions inversées.
    """
    if len(value) < 4:
        return False
    # strict=False assumé : on parcourt les paires voisines, la seconde
    # séquence est volontairement plus courte d'un élément.
    deltas = {ord(b) - ord(a) for a, b in zip(value, value[1:], strict=False)}
    return deltas in ({1}, {-1})


def password_issues(
    password: str,
    *,
    email: str | None = None,
    username: str | None = None,
) -> list[str]:
    """Retourne la liste des motifs de refus (vide si le mot de passe convient)."""
    candidate = normalize_password(password)
    issues: list[str] = []

    if len(candidate) < MIN_PASSWORD_LENGTH:
        issues.append(
            f"Le mot de passe doit contenir au moins {MIN_PASSWORD_LENGTH} caractères."
        )
    if len(candidate) > MAX_PASSWORD_LENGTH:
        issues.append(
            f"Le mot de passe ne doit pas dépasser {MAX_PASSWORD_LENGTH} caractères."
        )
    if candidate != candidate.strip():
        issues.append("Le mot de passe ne doit pas commencer ni finir par une espace.")

    fingerprint = _fingerprint(candidate)

    if fingerprint in _COMMON_FINGERPRINTS:
        issues.append("Ce mot de passe est trop courant, choisissez-en un autre.")
    if fingerprint and len(set(fingerprint)) == 1:
        issues.append("Le mot de passe ne peut pas être un seul caractère répété.")
    if _is_monotonic_sequence(fingerprint):
        issues.append(
            "Le mot de passe ne peut pas être une simple suite de touches ou de chiffres."
        )

    if username:
        needle = _fingerprint(username)
        if len(needle) >= 4 and needle in fingerprint:
            issues.append("Le mot de passe ne doit pas contenir votre pseudonyme.")
    if email:
        local_part = _fingerprint(email.split("@", 1)[0])
        if len(local_part) >= 4 and local_part in fingerprint:
            issues.append("Le mot de passe ne doit pas contenir votre adresse e-mail.")

    return issues


def check_strength(
    password: str,
    *,
    email: str | None = None,
    username: str | None = None,
) -> None:
    """Valide la robustesse d'un mot de passe à l'inscription ou au changement.

    Refuse notamment les mots de passe de moins de :data:`MIN_PASSWORD_LENGTH`
    caractères et ceux qui figurent dans :data:`COMMON_PASSWORDS`.

    Cette politique ne s'applique **qu'aux nouveaux mots de passe** : les
    comptes existants du site ne sont jamais invalidés rétroactivement.

    :raises WeakPasswordError: au moins une règle n'est pas respectée ; les
        motifs, en français, sont dans ``exc.reasons``.
    """
    issues = password_issues(password, email=email, username=username)
    if issues:
        raise WeakPasswordError(issues)


#: Nom historique, employé par :mod:`opm_auth.services.users`. Strict alias.
check_password_strength = check_strength


# --------------------------------------------------------------------------- #
# Vecteurs de test
# --------------------------------------------------------------------------- #
#
# Empreintes fabriquées ici, pour ce fichier, à partir d'un mot de passe connu
# et publié. Elles ne proviennent d'aucun compte réel et ne sont extraites
# d'aucune base : les recopier dans un test ne divulgue rien.
#
# Elles servent à prouver, sans installer Werkzeug, que nous relisons bien tous
# les formats que le site peut produire.

#: Mot de passe en clair dont dérivent tous les vecteurs ci-dessous.
TEST_VECTOR_PASSWORD: str = "MotDePasseDeTest-2026"

#: Étiquette lisible → empreinte correspondante.
TEST_VECTORS: dict[str, str] = {
    # Ce que le site Flask écrit aujourd'hui (Werkzeug < 2.3).
    "pbkdf2_sha256_260000": (
        "pbkdf2:sha256:260000$jKgmdtydyeibNQoc$"
        "6fb229e234b2c4ebc535ec657b51bb3de36b36614d6c729e39af53e9c9e8d32a"
    ),
    # Notre format canonique, celui que hash_password() produit.
    "pbkdf2_sha256_600000": (
        "pbkdf2:sha256:600000$A5RWRqbGI6HhZyIz$"
        "0217d4b3bb5d847bbeb7686c0d9a458f12f083bcc0b13cfaf01b4ce8166b1c6e"
    ),
    # Défaut de Werkzeug ≥ 2.3 : dérivée sur 64 octets, pas 32.
    "scrypt_32768_8_1": (
        "scrypt:32768:8:1$dmJ83Qy4oTfI6fYa$"
        "e62aa982034f0c66175bd8bd6f8240889d47e085721580886ecd720b6a4c0eed"
        "d9daf2d29cb2842841bd2031e5070c8930ca1b7003b61d670e9bec9b31284ef5"
    ),
    # Nombre d'itérations omis : ambigu, résolu par iteration_candidates().
    # Celle-ci a été calculée avec les 260 000 de Werkzeug < 2.3.
    "pbkdf2_sha256_sans_iterations": (
        "pbkdf2:sha256$0kO9Ws4bXVk2dN1C$"
        "20b140f70d75ee9c12e37bd0a218a1dd6a0ffd6f4fe4c352e61f8b43b88988ad"
    ),
    # PBKDF2 sur SHA-512 : lisible, mais hors format canonique donc à réécrire.
    "pbkdf2_sha512_260000": (
        "pbkdf2:sha512:260000$WbpMg86oRfrCFVI9$"
        "4ba64a2627c63cc1e0903ae2af08e1830f75a895bb4c65b7d912a1b21c6bb892"
        "0bd44e08129777b03e3143d1d59081aa1ca12f3b779ee8bced560eac41360652"
    ),
}

#: Vecteurs que :func:`needs_rehash` doit déclarer obsolètes, à la cible par
#: défaut de 600 000 itérations. Seul ``pbkdf2_sha256_600000`` y échappe.
TEST_VECTORS_NEEDING_REHASH: frozenset[str] = frozenset(
    {
        "pbkdf2_sha256_260000",
        "scrypt_32768_8_1",
        "pbkdf2_sha256_sans_iterations",
        "pbkdf2_sha512_260000",
    }
)

#: Empreintes volontairement cassées : :func:`verify_password` doit renvoyer
#: ``False`` pour chacune, sans jamais lever.
MALFORMED_TEST_HASHES: tuple[str, ...] = (
    "",
    "pas-du-tout-une-empreinte",
    "pbkdf2:sha256:600000$selsanssuite",
    "pbkdf2:sha256:600000$$abcdef",
    "pbkdf2:sha256:600000$sel$pas-de-l-hexadecimal",
    "pbkdf2:sha256:zero$sel$0011223344556677",
    "pbkdf2:blake3:600000$sel$0011223344556677",
    "bcrypt$2b$12$abcdefghijklmnopqrstuv",
    "$argon2id$v=19$m=65536,t=3,p=4$c2Vs$ZW1wcmVpbnRl",
    "scrypt:3:8:1$sel$0011223344556677",
)
