"""Routeur Yggdrasil : métadonnées ALI et ``authserver`` (protocole Mojang).

Montage attendu par l'application (``docs/API.md`` §2) :

.. code-block:: python

    from opm_auth.routers import sessionserver, yggdrasil

    app.include_router(yggdrasil.router, prefix="/yggdrasil")
    app.include_router(sessionserver.router, prefix="/yggdrasil")

On obtient alors exactement les chemins attendus par authlib-injector :
``GET /yggdrasil``, ``POST /yggdrasil/authserver/authenticate``,
``POST /yggdrasil/api/profiles/minecraft``,
``PUT``/``DELETE /yggdrasil/api/user/profile/{uuid}/{textureType}``, et — via
l'autre routeur — ``/yggdrasil/sessionserver/session/minecraft/…``.

Deux points à ne pas perdre de vue en lisant ce fichier :

* **l'identifiant de connexion est celui du site** — adresse e-mail ou
  ``users.name`` (c'est ce qu'annonce ``feature.non_email_login``) — alors que
  le profil rendu porte l'identité Minecraft du joueur : l'UUID premium réel et
  ``minecraft_username`` de ``auth_mc_link``. Les deux ne se confondent jamais ;
* **le format d'erreur n'est pas celui de l'API launcher.** Cette surface
  répond en Mojang : ``{"error", "errorMessage", "cause"}``. La conversion est
  assurée par :class:`MojangRoute`, une classe de route qui enveloppe la
  résolution des dépendances **et** l'exécution du gestionnaire : une limite de
  débit dépassée ou un corps JSON malformé ressortent donc, eux aussi, au format
  que le client Minecraft sait lire.

Aucune logique métier ici : tout est dans :mod:`opm_auth.services.yggdrasil`.
"""

from __future__ import annotations

from collections.abc import Callable, Coroutine
from typing import Annotated, Any

from fastapi import (
    APIRouter,
    File,
    Form,
    Header,
    Path,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from opm_auth.db import SessionDep
# La lecture bornée du corps et la classe de route qui la garantit vivent dans
# le routeur des textures : une seule implémentation de la politique de taille,
# quelle que soit la surface qui reçoit un PNG.
from opm_auth.routers.textures import BodyLimitRoute, read_texture_payload
from opm_auth.schemas import (
    YggAuthenticateIn,
    YggAuthenticateOut,
    YggErrorOut,
    YggProfileNames,
    YggProfileOut,
    YggRefreshIn,
    YggRootOut,
    YggSignoutIn,
    YggValidateIn,
)
from opm_auth.security.deps import ApiError
from opm_auth.security.ratelimit import client_ip, rate_limit
from opm_auth.services import yggdrasil as service
from opm_auth.services.yggdrasil import FORBIDDEN, ILLEGAL_ARGUMENT, YggdrasilError

__all__ = ["MojangRoute", "mojang_response", "router"]


def mojang_response(exc: YggdrasilError) -> JSONResponse:
    """Sérialise une erreur au format attendu par le client Minecraft."""
    body = YggErrorOut(
        error=exc.error, error_message=exc.error_message, cause=exc.cause
    )
    return JSONResponse(
        status_code=exc.status_code,
        content=body.model_dump(by_alias=True, exclude_none=True),
        headers=exc.headers,
    )


def _from_api_error(exc: ApiError) -> YggdrasilError:
    """Traduit une erreur normalisée (limite de débit, maintenance…) en erreur Mojang.

    Le message français est conservé tel quel : il est déjà rédigé pour être
    affiché au joueur. Le code métier passe dans ``cause``, ce qui laisse une
    trace exploitable côté serveur de jeu.
    """
    return YggdrasilError(
        exc.message,
        error=ILLEGAL_ARGUMENT if exc.status_code == 400 else FORBIDDEN,
        cause=exc.code,
        status_code=exc.status_code,
        headers=dict(exc.headers) if exc.headers else None,
    )


class MojangRoute(BodyLimitRoute):
    """Classe de route qui rend toutes les erreurs au format Mojang.

    Elle enveloppe le gestionnaire complet de FastAPI : la validation du corps
    et les dépendances (limitation de débit) sont donc couvertes, alors qu'un
    simple ``try/except`` dans la fonction de route les manquerait.

    Elle hérite de :class:`~opm_auth.routers.textures.BodyLimitRoute` : le corps
    de **toutes** les routes de ce fichier est plafonné avant lecture. Le skin
    téléversé est le plus gros envoi légitime de cette surface ; un ``POST
    authserver/authenticate`` de deux gigaoctets, lui, n'a aucune raison d'être
    chargé en mémoire avant d'être refusé.
    """

    @staticmethod
    def body_rejected(ceiling: int) -> Exception:
        """Refus d'un corps trop volumineux, rendu au format Mojang.

        Le refus est levé **pendant** la lecture du corps, c'est-à-dire à
        l'intérieur du bloc où FastAPI parse la requête : seule une
        ``HTTPException`` en ressort intacte, tout le reste y devient un
        « error parsing the body » en 400. D'où le passage par :class:`ApiError`,
        que :func:`_from_api_error` traduira ensuite en erreur Mojang 413.
        """
        return ApiError(
            "payload_too_large",
            f"L'envoi dépasse la taille maximale autorisée ({ceiling // 1024} Kio).",
            status_code=413,
        )

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        original = super().get_route_handler()

        async def handler(request: Request) -> Response:
            try:
                return await original(request)
            except YggdrasilError as exc:
                return mojang_response(exc)
            except RequestValidationError as exc:
                return mojang_response(
                    YggdrasilError(
                        "Requête invalide : le client n'a pas envoyé les champs attendus.",
                        error=ILLEGAL_ARGUMENT,
                        cause=str(exc.errors()[0]["loc"][-1]) if exc.errors() else None,
                        status_code=400,
                    )
                )
            except ApiError as exc:
                return mojang_response(_from_api_error(exc))

        return handler


router = APIRouter(route_class=MojangRoute, tags=["yggdrasil"])


@router.get(
    "",
    response_model=YggRootOut,
    summary="Métadonnées ALI lues par authlib-injector",
)
async def metadata() -> YggRootOut:
    """Nom du serveur, clé publique de signature et domaines de textures."""
    return service.root_metadata()


@router.post(
    "/authserver/authenticate",
    response_model=YggAuthenticateOut,
    response_model_exclude_none=True,
    dependencies=[rate_limit("yggdrasil.authenticate.ip")],
    summary="Ouvrir une session de jeu (e-mail ou pseudonyme OPM)",
)
async def authenticate(
    payload: YggAuthenticateIn, request: Request, session: SessionDep
) -> YggAuthenticateOut:
    """Authentifie le joueur et délivre un ``accessToken`` de 24 h.

    Le champ ``username`` accepte l'adresse e-mail **ou** le pseudonyme OPM ; le
    profil renvoyé porte, lui, l'identité Minecraft du compte.
    """
    return await service.authenticate(session, payload, ip=client_ip(request))


@router.post(
    "/authserver/refresh",
    response_model=YggAuthenticateOut,
    response_model_exclude_none=True,
    summary="Échanger un accessToken encore valide contre un neuf",
)
async def refresh(
    payload: YggRefreshIn, request: Request, session: SessionDep
) -> YggAuthenticateOut:
    """Prolonge une session sans redemander le mot de passe."""
    return await service.refresh(session, payload, ip=client_ip(request))


@router.post(
    "/authserver/validate",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    summary="Vérifier qu'un accessToken est toujours valable",
)
async def validate(payload: YggValidateIn, session: SessionDep) -> Response:
    """Répond 204 si la session vit encore, 403 sinon."""
    await service.validate(session, payload)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/authserver/invalidate",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    summary="Fermer une session de jeu",
)
async def invalidate(payload: YggValidateIn, session: SessionDep) -> Response:
    """Révoque le jeton présenté. Toujours 204, même s'il était déjà mort."""
    await service.invalidate(session, payload)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/authserver/signout",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    dependencies=[rate_limit("yggdrasil.authenticate.ip")],
    summary="Fermer toutes les sessions de jeu d'un compte",
)
async def signout(
    payload: YggSignoutIn, request: Request, session: SessionDep
) -> Response:
    """Révoque toutes les sessions du compte, mot de passe à l'appui.

    Comme ``authenticate``, cette route vérifie un mot de passe : elle porte
    donc la même limitation par compte et consigne ses échecs dans
    ``auth_audit`` — d'où l'adresse transmise au service.
    """
    await service.signout(session, payload, ip=client_ip(request))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/api/profiles/minecraft",
    response_model=list[YggProfileOut],
    response_model_exclude_none=True,
    summary="Résoudre des pseudonymes Minecraft en profils",
)
async def profiles(names: YggProfileNames, session: SessionDep) -> list[YggProfileOut]:
    """Traduit une liste de pseudonymes de jeu en profils ``{id, name}``.

    Les pseudonymes cherchés sont ceux de ``auth_mc_link.minecraft_username`` :
    ce sont eux que le serveur Minecraft et ses plugins manipulent.
    """
    return await service.profiles_by_names(session, names)


# --------------------------------------------------------------------------- #
# API étendue : textures d'un profil (docs/API.md §2.4)
# --------------------------------------------------------------------------- #

#: UUID de profil dans un chemin : 32 caractères hexadécimaux, tirets tolérés.
ProfileUuidPath = Annotated[
    str,
    Path(
        min_length=32,
        max_length=36,
        pattern="^[0-9a-fA-F-]{32,36}$",
        description="UUID premium du profil, avec ou sans tirets.",
    ),
]

#: Type de texture du protocole : ``skin`` ou ``cape``, en minuscules.
TextureTypePath = Annotated[
    str, Path(pattern="^(skin|cape)$", description="skin ou cape")
]

#: En-tête d'autorisation : ``Bearer <accessToken>``. Le jeton attendu est celui
#: d'``authserver/authenticate`` ; celui de l'API launcher est également accepté.
AuthorizationHeader = Annotated[
    str | None, Header(description="Bearer <accessToken>", alias="Authorization")
]


@router.put(
    "/api/user/profile/{profile_uuid}/{texture_type}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    summary="Téléverser le skin ou la cape d'un profil",
)
async def put_profile_texture(
    profile_uuid: ProfileUuidPath,
    texture_type: TextureTypePath,
    request: Request,
    session: SessionDep,
    authorization: AuthorizationHeader = None,
    file: Annotated[UploadFile | None, File(description="Le fichier PNG.")] = None,
    model: Annotated[str | None, Form(description="Vide, ou « slim ».")] = None,
) -> Response:
    """Pose une texture sur le profil du porteur du jeton.

    C'est le point d'entrée standard d'authlib-injector : un formulaire
    ``multipart/form-data`` portant ``file`` (le PNG) et ``model`` (vide pour le
    modèle classique, ``slim`` pour les bras fins). Le PNG brut dans le corps est
    également accepté, avec ``?model=slim`` s'il y a lieu — même souplesse que
    ``POST /textures/{kind}``.

    L'UUID de l'URL doit être celui du porteur : personne ne repeint le profil
    d'un autre. Réponse ``204`` ; en cas de refus, une erreur au format Mojang.
    """
    data = await read_texture_payload(request, file)
    await service.store_profile_texture(
        session,
        authorization=authorization,
        profile_uuid=profile_uuid,
        texture_type=texture_type,
        data=data,
        model=model if model is not None else request.query_params.get("model"),
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/api/user/profile/{profile_uuid}/{texture_type}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    summary="Retirer le skin ou la cape d'un profil",
)
async def delete_profile_texture(
    profile_uuid: ProfileUuidPath,
    texture_type: TextureTypePath,
    session: SessionDep,
    authorization: AuthorizationHeader = None,
) -> Response:
    """Ramène le profil à son apparence par défaut.

    Volontairement idempotent : retirer une texture déjà absente répond ``204``.
    Le fichier lui-même reste sur le disque — son URL a été annoncée immuable et
    d'autres joueurs le partagent peut-être.
    """
    await service.clear_profile_texture(
        session,
        authorization=authorization,
        profile_uuid=profile_uuid,
        texture_type=texture_type,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
