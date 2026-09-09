"""Dépendances FastAPI d'authentification et erreurs normalisées.

Ce module fournit :

* :class:`ApiError` et :func:`api_error_handler` — le format d'erreur unique de
  ``docs/API.md`` §3 (``{"error", "message", "details"}``) ;
* l'extraction et la vérification du jeton ``Authorization: Bearer`` ;
* les dépendances :func:`current_user`, :func:`current_user_optional`,
  :func:`require_admin`, :func:`require_can_play`, :func:`require_scopes`.

Les routeurs n'utilisent normalement que les alias annotés de la fin du module :

.. code-block:: python

    from opm_auth.security.deps import CurrentUser, PlayableUser

    @router.get("/auth/me")
    async def me(user: CurrentUser) -> UserOut: ...

    @router.post("/game/session")
    async def session(user: PlayableUser) -> GameSessionOut: ...

L'utilisateur est chargé dans **la session de base de données de la requête**
(``opm_auth.db.SessionDep``) : l'objet reste donc attaché et utilisable par le
routeur sans requête supplémentaire. Pour les tests, on remplace la dépendance
avec ``app.dependency_overrides``, comme il est d'usage avec FastAPI.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any, Awaitable, Callable, Mapping

from fastapi import Depends, Request
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.exceptions import HTTPException as StarletteHTTPException

from opm_auth.config import get_settings
from opm_auth.db import SessionDep
from opm_auth.models import User, UserRole
from opm_auth.security.tokens import TokenClaims, TokenError, decode_access_token

logger = logging.getLogger(__name__)

__all__ = [
    "AccessClaims",
    "AdminUser",
    "ApiError",
    "CurrentUser",
    "OptionalUser",
    "PlayableUser",
    "StaffUser",
    "access_claims",
    "access_claims_optional",
    "api_error_handler",
    "bearer_scheme",
    "current_user",
    "current_user_optional",
    "invalid_credentials",
    "require_admin",
    "require_can_play",
    "require_role",
    "require_scopes",
]


# --------------------------------------------------------------------------- #
# Erreurs normalisées
# --------------------------------------------------------------------------- #


class ApiError(StarletteHTTPException):
    """Erreur applicative au format normalisé de ``docs/API.md`` §3.

    .. code-block:: json

        { "error": "invalid_credentials",
          "message": "Adresse e-mail ou mot de passe incorrect.",
          "details": null }

    Hérite de ``HTTPException`` pour rester interceptable par n'importe quel
    gestionnaire, tout en transportant le code métier et les détails.
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = 400,
        details: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        self.code = code
        self.message = message
        self.details: dict[str, Any] | None = dict(details) if details else None
        super().__init__(
            status_code=status_code,
            detail=self.payload(),
            headers=dict(headers) if headers else None,
        )

    def payload(self) -> dict[str, Any]:
        """Corps JSON à renvoyer au client."""
        return {"error": self.code, "message": self.message, "details": self.details}


def api_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """Gestionnaire à enregistrer sur l'application FastAPI.

    .. code-block:: python

        app.add_exception_handler(ApiError, api_error_handler)

    Sans lui, le gestionnaire par défaut de FastAPI envelopperait le corps dans
    une clé ``detail``, ce qui romprait le contrat d'API.
    """
    if not isinstance(exc, ApiError):  # pragma: no cover - garde-fou
        raise exc
    return JSONResponse(
        status_code=exc.status_code, content=exc.payload(), headers=exc.headers
    )


def invalid_credentials(message: str = "Identifiants invalides.") -> ApiError:
    """Erreur 401 générique, volontairement peu bavarde (anti-énumération)."""
    return ApiError(
        "invalid_credentials",
        message,
        status_code=401,
        headers={"WWW-Authenticate": "Bearer"},
    )


# --------------------------------------------------------------------------- #
# Extraction du jeton
# --------------------------------------------------------------------------- #

#: Schéma de sécurité déclaré pour OpenAPI. ``auto_error`` est désactivé afin de
#: produire nos propres erreurs normalisées plutôt que celles de FastAPI.
bearer_scheme = HTTPBearer(
    auto_error=False,
    scheme_name="Jeton OPM",
    description="access_token délivré par POST /api/v1/auth/login",
)

_Credentials = Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)]


def _claims_from(credentials: HTTPAuthorizationCredentials | None) -> TokenClaims | None:
    """Décode l'en-tête ``Authorization`` s'il est présent.

    Retourne ``None`` quand aucun jeton n'est fourni ; lève une erreur
    normalisée quand un jeton est fourni mais invalide ou expiré — un jeton
    cassé ne doit jamais dégrader silencieusement vers l'anonymat.
    """
    if credentials is None:
        return None
    if (credentials.scheme or "").lower() != "bearer":
        raise invalid_credentials("Schéma d'autorisation non pris en charge.")
    try:
        return decode_access_token(credentials.credentials)
    except TokenError as exc:
        expired = exc.api_code == "token_expired"
        raise ApiError(
            exc.api_code,
            "Session expirée, veuillez rafraîchir votre jeton."
            if expired
            else "Jeton d'accès invalide.",
            status_code=401,
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


async def access_claims(credentials: _Credentials) -> TokenClaims:
    """Claims de l'``access_token``, sans toucher à la base.

    Utile pour les routes qui n'ont besoin que de l'identifiant du porteur.
    """
    claims = _claims_from(credentials)
    if claims is None:
        raise invalid_credentials("Jeton d'accès manquant.")
    return claims


async def access_claims_optional(credentials: _Credentials) -> TokenClaims | None:
    """Comme :func:`access_claims`, mais tolère l'absence de jeton."""
    return _claims_from(credentials)


# --------------------------------------------------------------------------- #
# Utilisateur courant
# --------------------------------------------------------------------------- #


def _subject_id(claims: TokenClaims) -> int:
    """Identifiant numérique du porteur, converti depuis le ``sub`` du jeton.

    ``users.id`` est un ``integer`` (séquence PostgreSQL), jamais un UUID, alors
    que le ``sub`` d'un JWT est toujours textuel (``create_access_token(str(...))``).
    Le dialecte asyncpg passe le paramètre tel quel à un ``int4`` et refuse une
    chaîne : sans cette conversion, **toute** route authentifiée répondrait 500
    en production. SQLite, lui, convertit tout seul — d'où l'invisibilité du
    défaut dans les tests.

    Un ``sub`` non numérique n'est pas une panne serveur : c'est un jeton
    fabriqué, donc un jeton invalide, traité comme tel (401 et non 500).
    """
    try:
        return int(claims.subject)
    except (TypeError, ValueError):
        logger.info("Jeton présenté avec un sujet non numérique.")
        raise invalid_credentials("Jeton d'accès invalide.") from None


async def current_user(
    claims: Annotated[TokenClaims, Depends(access_claims)],
    session: SessionDep,
) -> User:
    """Utilisateur authentifié, chargé dans la session de la requête.

    :raises ApiError: 401 si le jeton est absent, invalide, ou si le compte
        qu'il désigne n'existe plus.
    """
    user_id = _subject_id(claims)
    user = await session.get(User, user_id)
    if user is None:
        # Jeton authentique mais compte supprimé entre-temps.
        logger.info("Jeton orphelin présenté pour le compte %s.", user_id)
        raise invalid_credentials("Ce compte n'existe plus.")
    return user


async def current_user_optional(
    claims: Annotated[TokenClaims | None, Depends(access_claims_optional)],
    session: SessionDep,
) -> User | None:
    """Utilisateur authentifié, ou ``None`` si aucun jeton n'est présenté."""
    if claims is None:
        return None
    return await session.get(User, _subject_id(claims))


def require_role(*roles: str) -> Callable[..., Awaitable[User]]:
    """Fabrique une dépendance exigeant l'un des rôles donnés."""
    allowed = frozenset(roles)

    async def dependency(user: Annotated[User, Depends(current_user)]) -> User:
        if str(getattr(user, "role", UserRole.PLAYER.value)) not in allowed:
            raise ApiError(
                "forbidden",
                "Cette action est réservée à l'équipage d'administration.",
                status_code=403,
            )
        return user

    return dependency


async def require_admin(user: Annotated[User, Depends(current_user)]) -> User:
    """Exige le rôle ``admin``."""
    if str(getattr(user, "role", UserRole.PLAYER.value)) != UserRole.ADMIN.value:
        raise ApiError(
            "forbidden",
            "Cette action est réservée à l'équipage d'administration.",
            status_code=403,
        )
    return user


#: Messages associés aux motifs de blocage de ``docs/API.md`` §1.2.
_BLOCKED_MESSAGES: dict[str, str] = {
    "microsoft_required": (
        "Rattachez un compte Microsoft possédant Minecraft pour pouvoir jouer."
    ),
    "microsoft_expired": (
        "La vérification de votre compte Microsoft a expiré : relancez-la depuis "
        "les paramètres du launcher."
    ),
    "ownership_missing": (
        "Le compte Microsoft rattaché ne possède pas Minecraft : Java Edition."
    ),
    "banned": "Votre compte est suspendu.",
    "email_unverified": "Confirmez votre adresse e-mail pour pouvoir jouer.",
}


async def require_can_play(user: Annotated[User, Depends(current_user)]) -> User:
    """Exige un compte autorisé à lancer le jeu.

    S'appuie sur ``User.blocked_reason()``, la méthode même qui alimente le
    champ ``can_play`` de l'API : le bouton JOUER du launcher et cette barrière
    serveur ne peuvent donc jamais diverger.

    La politique « Microsoft obligatoire ? » vient de
    ``services.users.microsoft_required()`` et non du drapeau brut
    ``OPM_MICROSOFT_REQUIRED`` : en mode ``microsoft``, le rattachement est exigé
    même si le drapeau vaut faux (``docs/API.md`` §0). Lire le drapeau seul
    laisserait passer ici un compte que le service refuse.
    """
    # Import différé : opm_auth.services.users importe ce module (ApiError,
    # invalid_credentials). Le faire au niveau de la fonction évite l'import
    # circulaire tout en gardant UNE seule définition de la politique.
    from opm_auth.services import users as users_service

    settings = get_settings()
    # « email_verification_required » n'est pas un argument de blocked_reason() :
    # la base du site ne porte aucune colonne de vérification d'adresse, le motif
    # « email_unverified » n'est donc jamais rendu par le modèle.
    reason = user.blocked_reason(
        microsoft_required=users_service.microsoft_required(settings)
    )
    if reason is None:
        return user

    details: dict[str, Any] | None = None
    if reason == "banned":
        ban = user.active_ban()
        if ban is not None:
            details = {
                "until": ban.until.isoformat() if ban.until else None,
                "reason": ban.reason,
            }

    raise ApiError(
        reason,
        _BLOCKED_MESSAGES.get(reason, "Votre compte ne peut pas rejoindre le serveur."),
        status_code=403,
        details=details,
    )


def require_scopes(*scopes: str) -> Callable[..., Awaitable[TokenClaims]]:
    """Fabrique une dépendance exigeant des portées dans l'``access_token``.

    .. code-block:: python

        @router.post("/admin/news", dependencies=[Depends(require_scopes("admin"))])
    """
    expected = frozenset(scopes)

    async def dependency(
        claims: Annotated[TokenClaims, Depends(access_claims)],
    ) -> TokenClaims:
        if not expected.issubset(claims.scopes):
            raise ApiError(
                "forbidden",
                "Votre jeton n'accorde pas les droits nécessaires.",
                status_code=403,
                details={"required_scopes": sorted(expected)},
            )
        return claims

    return dependency


#: Annotations prêtes à l'emploi pour les routeurs.
AccessClaims = Annotated[TokenClaims, Depends(access_claims)]
CurrentUser = Annotated[User, Depends(current_user)]
OptionalUser = Annotated[User | None, Depends(current_user_optional)]
AdminUser = Annotated[User, Depends(require_admin)]
StaffUser = Annotated[
    User, Depends(require_role(UserRole.ADMIN.value, UserRole.MODERATOR.value))
]
PlayableUser = Annotated[User, Depends(require_can_play)]
