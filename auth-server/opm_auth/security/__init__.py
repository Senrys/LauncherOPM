"""Couche de sécurité du serveur d'authentification OPM.

Ce paquet regroupe tout ce qui touche aux secrets et aux jetons :

* :mod:`passwords` — hachage au **format Werkzeug** (``pbkdf2:sha256``), celui
  du site Flask, et politique de robustesse. Jamais d'Argon2id : le site ne
  saurait plus vérifier les empreintes (``docs/DATA.md`` §3) ;
* :mod:`keys`      — paires de clés Ed25519 (JWT) et RSA-4096 (textures Yggdrasil) ;
* :mod:`tokens`    — access_token JWT EdDSA, refresh_token opaques, jetons Yggdrasil ;
* :mod:`totp`      — double authentification TOTP et codes de secours ;
* :mod:`crypto`    — AES-256-GCM pour le jeton Microsoft au repos ;
* :mod:`ratelimit` — limitation de débit à fenêtre glissante ;
* :mod:`deps`      — dépendances FastAPI et erreurs normalisées.

Aucun secret n'est écrit en dur : toute valeur configurable est lue via
:func:`setting`, qui interroge dans l'ordre :

1. l'objet de configuration exposé par ``opm_auth.config``
   (``get_settings()``, ``settings`` ou ``Settings``) ;
2. la variable d'environnement ``OPM_<NOM>`` ;
3. la valeur par défaut fournie par l'appelant.

Cette indirection permet à la couche de sécurité de rester utilisable et
testable sans dépendre de la forme exacte du module de configuration.

Les sous-modules sont importés paresseusement (PEP 562) : ils peuvent donc
importer :func:`setting` depuis ce paquet sans créer d'import circulaire.
"""

from __future__ import annotations

import importlib
import logging
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, TypeVar

logger = logging.getLogger(__name__)

#: Préfixe des variables d'environnement du projet.
ENV_PREFIX = "OPM_"

_T = TypeVar("_T")


class _Missing:
    """Sentinelle interne : distingue « absent » de « vaut None »."""

    __slots__ = ()

    def __repr__(self) -> str:  # pragma: no cover - confort de débogage
        return "<absent>"


_MISSING = _Missing()


@lru_cache(maxsize=1)
def _settings_object() -> Any | None:
    """Retourne l'objet de configuration du projet, ou ``None`` s'il n'existe pas.

    On accepte les trois conventions habituelles de *pydantic-settings* :
    une fabrique ``get_settings()``, un singleton ``settings`` ou la classe
    ``Settings`` elle-même.
    """
    try:
        module = importlib.import_module("opm_auth.config")
    except ImportError:
        return None
    except Exception:  # pragma: no cover - configuration invalide
        logger.exception("Le module opm_auth.config est illisible.")
        return None

    for attribute in ("get_settings", "settings", "Settings"):
        candidate = getattr(module, attribute, None)
        if candidate is None:
            continue
        try:
            return candidate() if callable(candidate) else candidate
        except Exception:  # pragma: no cover - configuration invalide
            logger.exception(
                "Impossible d'instancier opm_auth.config.%s.", attribute
            )
    return None


def _coerce(raw: Any, default: _T) -> _T:
    """Convertit ``raw`` (souvent une chaîne d'environnement) au type de ``default``."""
    if isinstance(default, bool):
        if isinstance(raw, bool):
            return raw  # type: ignore[return-value]
        return str(raw).strip().lower() in {"1", "true", "yes", "on", "oui"}  # type: ignore[return-value]
    if isinstance(default, int):
        return int(str(raw).strip())  # type: ignore[return-value]
    if isinstance(default, float):
        return float(str(raw).strip())  # type: ignore[return-value]
    if isinstance(default, Path):
        return Path(str(raw)).expanduser()  # type: ignore[return-value]
    if isinstance(default, (tuple, list, frozenset, set)):
        if isinstance(raw, str):
            parts = [part.strip() for part in raw.split(",") if part.strip()]
        else:
            parts = list(raw)
        return type(default)(parts)  # type: ignore[return-value, call-arg]
    if isinstance(default, str):
        return str(raw)  # type: ignore[return-value]
    return raw  # type: ignore[return-value]


def setting(
    name: str,
    default: _T,
    *,
    cast: Callable[[Any], _T] | None = None,
) -> _T:
    """Lit un réglage : configuration applicative, puis environnement, puis défaut.

    :param name: nom du réglage (``"server_name"``, ``"access_ttl_minutes"``…) ;
                 les propriétés dérivées de ``Settings`` (``access_ttl``,
                 ``jwt_private_key``…) sont accessibles de la même façon.
                 L'attribut est cherché en minuscules puis en majuscules sur
                 l'objet de configuration, et sous ``OPM_<NOM>`` dans l'environnement.
    :param default: valeur de repli ; son type pilote la conversion automatique.
    :param cast: convertisseur explicite, prioritaire sur la conversion automatique.
    """
    raw: Any = _MISSING

    config = _settings_object()
    if config is not None:
        raw = getattr(config, name.lower(), _MISSING)
        if raw is _MISSING:
            raw = getattr(config, name.upper(), _MISSING)

    if raw is _MISSING or raw is None:
        from_env = os.environ.get(f"{ENV_PREFIX}{name.upper()}")
        if from_env:
            raw = from_env

    if raw is _MISSING or raw is None:
        return default

    if cast is not None:
        return cast(raw)
    return _coerce(raw, default)


def reset_settings_cache() -> None:
    """Oublie la configuration mémorisée (utile dans les tests)."""
    _settings_object.cache_clear()


# --------------------------------------------------------------------------- #
# Ré-exports paresseux : ``from opm_auth.security import hash_password`` marche
# sans que l'import du paquet ne tire argon2, cryptography, jwt, etc.
# --------------------------------------------------------------------------- #

_EXPORTS: dict[str, str] = {
    # passwords — les variantes ``*_async`` déportent la dérivation PBKDF2 dans
    # un fil : ce sont elles, et non les synchrones, qu'appelle toute coroutine.
    "WeakPasswordError": "passwords",
    "check_password_strength": "passwords",
    "hash_password": "passwords",
    "hash_password_async": "passwords",
    "hash_secret": "passwords",
    "hash_secret_async": "passwords",
    "needs_rehash": "passwords",
    "password_issues": "passwords",
    "verify_and_update": "passwords",
    "verify_and_update_async": "passwords",
    "verify_async": "passwords",
    "verify_password": "passwords",
    "verify_password_async": "passwords",
    "verify_secret": "passwords",
    "verify_secret_async": "passwords",
    # keys
    "Keyring": "keys",
    "ensure_keys": "keys",
    "get_keyring": "keys",
    "rsa_public_key_pem": "keys",
    "sign_textures": "keys",
    "verify_textures_signature": "keys",
    # tokens
    "NewRefreshToken": "tokens",
    "RefreshOutcome": "tokens",
    "RotationResult": "tokens",
    "TokenClaims": "tokens",
    "TokenError": "tokens",
    "TokenExpired": "tokens",
    "TokenInvalid": "tokens",
    "TokenTypeMismatch": "tokens",
    "create_access_token": "tokens",
    "create_password_reset_token": "tokens",
    "create_yggdrasil_token": "tokens",
    "decode_access_token": "tokens",
    "decode_password_reset_token": "tokens",
    "decode_yggdrasil_token": "tokens",
    "hash_refresh_token": "tokens",
    "new_client_token": "tokens",
    "new_refresh_token": "tokens",
    "rotate_refresh_token": "tokens",
    "verify_refresh_token": "tokens",
    # totp
    "RecoveryCodes": "totp",
    "generate_recovery_codes": "totp",
    "generate_recovery_codes_async": "totp",
    "generate_totp_secret": "totp",
    "provisioning_uri": "totp",
    "verify_recovery_code": "totp",
    "verify_recovery_code_async": "totp",
    "verify_totp": "totp",
    # crypto
    "CryptoError": "crypto",
    "constant_time_equals": "crypto",
    "decrypt_msa_token": "crypto",
    "decrypt_totp_secret": "crypto",
    "derive_key": "crypto",
    "encrypt_msa_token": "crypto",
    "encrypt_totp_secret": "crypto",
    "generate_key_hex": "crypto",
    "sha256_hex": "crypto",
    # ratelimit
    "RULES": "ratelimit",
    "RateLimit": "ratelimit",
    "RateLimitResult": "ratelimit",
    "Rule": "ratelimit",
    "enforce": "ratelimit",
    "get_limiter": "ratelimit",
    "limited": "ratelimit",
    "rate_limit": "ratelimit",
    "reload_rules": "ratelimit",
    "set_limiter": "ratelimit",
    # deps
    "AdminUser": "deps",
    "ApiError": "deps",
    "CurrentUser": "deps",
    "OptionalUser": "deps",
    "PlayableUser": "deps",
    "StaffUser": "deps",
    "api_error_handler": "deps",
    "current_user": "deps",
    "current_user_optional": "deps",
    "invalid_credentials": "deps",
    "require_admin": "deps",
    "require_can_play": "deps",
    "require_role": "deps",
    "require_scopes": "deps",
}

__all__ = ["ENV_PREFIX", "setting", "reset_settings_cache", *sorted(_EXPORTS)]


def __getattr__(name: str) -> Any:
    """Import paresseux des symboles publics des sous-modules (PEP 562)."""
    module_name = _EXPORTS.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} n'expose pas {name!r}")
    module = importlib.import_module(f"{__name__}.{module_name}")
    value = getattr(module, name)
    globals()[name] = value  # mémorisation : un seul import par symbole
    return value


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(_EXPORTS))
