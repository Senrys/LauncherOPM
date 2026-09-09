"""Routeur de la session de jeu — ``/api/v1/game`` (``docs/API.md`` §1.4).

Montage attendu par l'application :

.. code-block:: python

    from opm_auth.routers import game

    app.include_router(game.router, prefix="/api/v1")

Deux points d'entrée, aux deux bouts d'une partie :

``POST /game/session``
    Délivre la session Yggdrasil que le launcher passe **telle quelle** à
    ``minecraft-java-core`` : la réponse est l'objet ``authenticator`` attendu par
    la bibliothèque (``access_token``, ``client_token``, ``uuid``, ``name``,
    ``user_properties``, ``meta``). L'``uuid`` est l'UUID premium réel du joueur
    et ``name`` son pseudo Minecraft — pas ``users.name`` (``docs/DATA.md`` §8).
    Aucun jeton Microsoft ne figure dans la réponse : le jeu ne reçoit que ce que
    **nous** avons signé.

``POST /game/session/close``
    Le jeu s'est arrêté : la durée jouée s'ajoute à ``users.tempsdejeu`` et la
    session de jeu est fermée. C'est la seule écriture que cette surface effectue
    dans les tables du site, et ``docs/DATA.md`` §4 l'autorise explicitement.

La barrière ``can_play`` est appliquée par le service et non par une dépendance :
le motif de refus, son message français et son format d'erreur sont ainsi
produits au même endroit que ceux du protocole Yggdrasil, si bien que le bouton
JOUER du launcher, l'API et le serveur de jeu ne peuvent pas diverger.

Les erreurs suivent le format normalisé de ``docs/API.md`` §3 :
``403 microsoft_required`` / ``microsoft_expired`` / ``ownership_missing`` /
``banned`` (avec ``details.until``), ``429 rate_limited``.
"""

from __future__ import annotations

from fastapi import APIRouter, Response, status

from opm_auth.db import SessionDep
from opm_auth.schemas import GameSessionEndIn, GameSessionOut
from opm_auth.security.deps import CurrentUser
from opm_auth.services import yggdrasil as service

__all__ = ["router"]

router = APIRouter(prefix="/game", tags=["game"])


@router.post(
    "/session",
    response_model=GameSessionOut,
    status_code=status.HTTP_200_OK,
    summary="Délivrer la session Yggdrasil à passer au jeu",
)
async def open_session(user: CurrentUser, session: SessionDep) -> GameSessionOut:
    """Ouvre une session de jeu de 24 h pour le compte authentifié.

    Aucun corps de requête : le ``client_token`` est tiré par le serveur, et le
    launcher se contente de présenter son ``access_token``.
    """
    return await service.create_game_session(session, user)


@router.post(
    "/session/close",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    summary="Clore une session de jeu et créditer le temps joué",
)
async def close_session(
    payload: GameSessionEndIn, user: CurrentUser, session: SessionDep
) -> Response:
    """Ajoute ``duration_s`` secondes à ``users.tempsdejeu`` et ferme la session.

    ``client_token`` est facultatif au sens du schéma, mais **rien n'est crédité
    sans lui** : le temps annoncé n'est retenu que s'il correspond à une session
    ``ygg_session`` réellement ouverte par ce compte, et il est plafonné à la
    durée écoulée depuis son émission. C'est la barrière de ``docs/DATA.md`` §4 —
    sans elle, un launcher modifié annoncerait huit heures après dix secondes de
    jeu, et ``users.tempsdejeu`` est une colonne du **site**. Fournir le jeton
    invalide en outre la session sur-le-champ, pour qu'un accès de 24 h ne
    survive pas à la partie qu'il servait.

    Répond toujours 204, y compris pour une durée nulle, une session déjà close
    ou un jeton absent : fermer deux fois la même partie ne doit pas produire
    d'erreur côté launcher. Le refus de créditer est journalisé, pas remonté.
    """
    await service.close_game_session(
        session,
        user,
        duration_s=payload.duration_s,
        client_token=payload.client_token,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
