"""Routeur ``sessionserver`` : la poignée de main entre le client et le serveur.

Montage attendu par l'application (``docs/API.md`` §2.3) :

.. code-block:: python

    app.include_router(sessionserver.router, prefix="/yggdrasil")

Les chemins obtenus sont ceux du protocole Mojang :
``/yggdrasil/sessionserver/session/minecraft/{join,hasJoined,profile/{uuid}}``.

Déroulé d'une connexion, côté serveur de jeu :

1. le client, une fois le chiffrement négocié, appelle ``join`` avec son
   ``accessToken`` et le ``serverId`` calculé à partir du secret partagé ;
2. le serveur Minecraft appelle aussitôt ``hasJoined`` avec le même ``serverId`` ;
   une réponse 200 vaut certificat d'identité, un 204 refuse la connexion ;
3. le serveur affiche ensuite le skin grâce à la propriété ``textures`` signée,
   qui pointe sur nos URL ``/textures/{sha256}.png``.

L'annonce d'arrivée ne vit que ``OPM_JOIN_TTL_SECONDS`` (30 s) et n'est pas
rejouable : le premier ``hasJoined`` la consomme, quel que soit son verdict.

Le pseudonyme échangé sur cette surface est celui du **jeu**
(``auth_mc_link.minecraft_username``), jamais ``users.name`` : commandes, bans et
journaux du serveur Minecraft doivent rester cohérents (``docs/DATA.md`` §8).

Comme pour :mod:`opm_auth.routers.yggdrasil`, les erreurs sortent au format
Mojang grâce à :class:`~opm_auth.routers.yggdrasil.MojangRoute`.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Path, Query, Request, Response, status
from fastapi.responses import JSONResponse

from opm_auth.db import SessionDep
from opm_auth.routers.yggdrasil import MojangRoute
from opm_auth.schemas import YggJoinIn, YggProfileOut
from opm_auth.security.ratelimit import client_ip
from opm_auth.services import yggdrasil as service

__all__ = ["router"]

router = APIRouter(prefix="/sessionserver", route_class=MojangRoute, tags=["yggdrasil"])

#: Pseudonyme Minecraft demandé par le serveur de jeu (16 caractères au plus,
#: comme ``auth_mc_link.minecraft_username``).
UsernameQuery = Annotated[str, Query(min_length=1, max_length=16)]
#: Identifiant de session calculé par le client à partir du secret partagé.
ServerIdQuery = Annotated[str, Query(alias="serverId", min_length=1, max_length=64)]
#: Adresse du joueur, transmise seulement si ``prevent-proxy-connections`` est actif.
ClientIpQuery = Annotated[str | None, Query(alias="ip", max_length=45)]
#: UUID de profil : 32 caractères sans tirets, ou 36 avec.
ProfileUuidPath = Annotated[str, Path(min_length=32, max_length=36)]


def _profile_response(profile: YggProfileOut) -> JSONResponse:
    """Sérialise un profil en JSON Mojang (``camelCase``, sans champ nul)."""
    return JSONResponse(content=profile.model_dump(by_alias=True, exclude_none=True))


@router.post(
    "/session/minecraft/join",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    summary="Le client annonce son arrivée sur le serveur",
)
async def join(payload: YggJoinIn, request: Request, session: SessionDep) -> Response:
    """Enregistre l'annonce d'arrivée pour 30 secondes (``OPM_JOIN_TTL_SECONDS``)."""
    await service.join(session, payload, ip=client_ip(request))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get(
    "/session/minecraft/hasJoined",
    response_model=None,
    summary="Le serveur de jeu vérifie l'identité du joueur",
)
async def has_joined(
    session: SessionDep,
    username: UsernameQuery,
    server_id: ServerIdQuery,
    ip: ClientIpQuery = None,
) -> Response:
    """Renvoie le profil **signé** du joueur, ou 204 si l'annonce est absente.

    Un 204 est un refus complet : annonce inconnue, périmée, déjà consommée,
    pseudonyme qui ne correspond pas, adresse différente de celle du ``join``, ou
    compte devenu inapte à jouer entre-temps.
    """
    profile = await service.has_joined(
        session, username=username, server_id=server_id, ip=ip
    )
    if profile is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    return _profile_response(profile)


@router.get(
    "/session/minecraft/profile/{profile_uuid}",
    response_model=None,
    summary="Consulter le profil d'un joueur par son UUID",
)
async def profile(
    session: SessionDep,
    profile_uuid: ProfileUuidPath,
    unsigned: bool = True,
) -> Response:
    """Profil complet, sans signature par défaut (``?unsigned=false`` pour l'obtenir).

    L'UUID attendu est l'UUID premium réel du joueur, celui que porte
    ``auth_mc_link``.
    """
    found = await service.profile_by_uuid(session, profile_uuid, unsigned=unsigned)
    if found is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    return _profile_response(found)
