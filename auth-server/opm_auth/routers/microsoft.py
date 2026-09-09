"""Routeur du rattachement Microsoft — ``/api/v1/link/microsoft`` (``docs/API.md`` §1.3).

Montage attendu côté application :

.. code-block:: python

    from opm_auth.routers import microsoft

    app.include_router(microsoft.router, prefix="/api/v1")

Chemins exposés :

=====================================  ========  ==========================================
Chemin                                 Verbe     Réponse
=====================================  ========  ==========================================
``/link/microsoft/start``              POST      ``200 {flow, …}``
``/link/microsoft/complete``           POST      ``200 {user}``
``/link/microsoft/poll``               POST      ``200 {user}`` / ``202 {status:"pending"}``
``/link/microsoft``                    POST      ``200 {user}`` (chemin ``/refresh``)
``/link/microsoft``                    DELETE    ``204``
=====================================  ========  ==========================================

Ce que le launcher ne fait **jamais**
=====================================

Il n'échange pas le code d'autorisation, ne parle ni à XBL, ni à XSTS, ni aux
services Minecraft, et ne voit aucun jeton Microsoft. Il ouvre une fenêtre de
consentement, récupère un paramètre ``code`` dans l'URL de redirection, et le
transmet ici. Toute la chaîne — et le seul endroit où vivent les jetons
Microsoft — est dans :mod:`opm_auth.services.microsoft`.

Le ``state`` remis par ``start`` est une **enveloppe signée** valable dix
minutes et liée au compte OPM qui l'a demandée : le serveur ne conserve donc
aucun état entre les deux appels, et un ``state`` intercepté est inutilisable
sur un autre compte. Le flux « device » suit la même règle : le launcher reçoit
un ticket signé, jamais le ``device_code`` brut de Microsoft.

Unicité et audit
================

Un compte Minecraft ne peut être rattaché qu'à **un seul** compte OPM
(``409 already_linked``), et la dissociation exige le mot de passe OPM : sans
cela, une session launcher volée suffirait à reprendre le compte Minecraft d'un
joueur. Chaque rattachement, chaque re-vérification et chaque dissociation
laisse une entrée dans ``auth_audit`` — c'est le service qui l'écrit, dans la
transaction de l'opération.

Le routeur, lui, ne fait que trois choses : appliquer les limites de débit,
appeler le service, et traduire ses :class:`~opm_auth.services.microsoft.MicrosoftError`
en erreurs normalisées (``docs/API.md`` §3).
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager

from fastapi import APIRouter, Request, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from opm_auth.config import get_settings
from opm_auth.db import SessionDep
from opm_auth.models import User
from opm_auth.schemas import (
    LinkCompleteIn,
    LinkPendingOut,
    LinkPollIn,
    LinkStartDeviceOut,
    LinkStartEmbeddedOut,
    LinkStartOut,
    UnlinkIn,
    UserOut,
)
from opm_auth.security.deps import ApiError, CurrentUser
from opm_auth.security.ratelimit import enforce, rate_limit
from opm_auth.services import audit, microsoft, textures, users
from opm_auth.services.microsoft import MicrosoftError

__all__ = ["router"]

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/link/microsoft", tags=["Rattachement Microsoft"])

#: Limite par compte, appliquée une fois le porteur du jeton identifié.
#: La limite par IP, elle, est posée en dépendance de route.
ACCOUNT_RULE = "link.microsoft.account"

#: Code renvoyé par le service tant que le joueur n'a pas validé côté Microsoft.
#: Ce n'est pas une erreur : c'est le déroulement normal du flux « device ».
PENDING_CODE = "device_pending"


# --------------------------------------------------------------------------- #
# Traduction des erreurs
# --------------------------------------------------------------------------- #


def _to_api_error(exc: MicrosoftError) -> ApiError:
    """Traduit une erreur de la chaîne Microsoft en erreur normalisée.

    Le code et le message français viennent du service, qui les a rédigés pour
    être affichés tels quels par le launcher : on ne les réécrit pas ici.
    """
    return ApiError(
        exc.code,
        exc.message,
        status_code=exc.status_code,
        details=exc.details,
    )


@contextmanager
def _translated() -> Iterator[None]:
    """Convertit toute ``MicrosoftError`` levée dans le bloc en ``ApiError``."""
    try:
        yield
    except MicrosoftError as exc:
        raise _to_api_error(exc) from exc


# --------------------------------------------------------------------------- #
# Réponse commune
# --------------------------------------------------------------------------- #


async def _user_payload(session: AsyncSession, user: User) -> dict[str, UserOut]:
    """Enveloppe ``{"user": …}`` attendue par le launcher après un rattachement.

    Le compte est renvoyé **entier** — ``can_play``, ``blocked_reason``, fiche RP
    et apparence comprises : le launcher n'a rien à recalculer pour allumer le
    bouton JOUER, et le skin tout juste importé est visible dès cette réponse.
    """
    return {"user": await users.serialize_with_profile(session, user)}


# --------------------------------------------------------------------------- #
# 1. Démarrage du flux
# --------------------------------------------------------------------------- #


@router.post(
    "/start",
    summary="Ouvrir un rattachement Microsoft",
    response_model=LinkStartOut,
    dependencies=[rate_limit("link.microsoft.ip")],
)
async def start(user: CurrentUser) -> LinkStartEmbeddedOut | LinkStartDeviceOut:
    """Prépare le consentement Microsoft, selon le flux configuré.

    En mode ``embedded`` (défaut), le launcher ouvre ``authorize_url`` dans une
    fenêtre et guette ``redirect_uri`` pour y lire le paramètre ``code``.

    En mode ``device``, le joueur saisit ``user_code`` sur la page Microsoft
    pendant que le launcher interroge ``/poll`` au rythme d'``interval``. Le
    ``device_code`` renvoyé n'est **pas** celui de Microsoft : c'est un ticket
    signé, lié à ce compte OPM et périmable, que seul le serveur sait ouvrir.
    """
    await enforce(ACCOUNT_RULE, str(user.id))
    settings = get_settings()

    if settings.msa_flow == "device":
        with _translated():
            flow = await microsoft.start_device_flow()
        logger.info("Flux « device » ouvert pour le compte %s.", user.id)
        return LinkStartDeviceOut(
            verification_uri=flow.verification_uri,
            user_code=flow.user_code,
            device_code=microsoft.sign_device_ticket(
                str(user.id), flow.device_code, flow.expires_in
            ),
            interval=flow.interval,
            expires_in=flow.expires_in,
        )

    state = microsoft.sign_state(str(user.id))
    logger.info("Flux « embedded » ouvert pour le compte %s.", user.id)
    return LinkStartEmbeddedOut(
        authorize_url=microsoft.build_authorize_url(state),
        redirect_uri=settings.msa_redirect_uri,
        state=state,
    )


# --------------------------------------------------------------------------- #
# 2. Achèvement du flux
# --------------------------------------------------------------------------- #


@router.post(
    "/complete",
    summary="Terminer un rattachement (flux embedded)",
    dependencies=[rate_limit("link.microsoft.ip")],
)
async def complete(
    payload: LinkCompleteIn,
    user: CurrentUser,
    request: Request,
    session: SessionDep,
) -> dict[str, UserOut]:
    """Échange le code d'autorisation et enregistre la preuve de possession.

    Le ``state`` est vérifié en premier : une enveloppe fausse, périmée ou émise
    pour un autre compte OPM est rejetée avant tout appel sortant.

    Le skin est importé dans la foulée, dans la même transaction que le
    rattachement (``docs/DATA.md`` §6). Son échec ne remet jamais le
    rattachement en cause : le joueur garde le skin par défaut et l'import sera
    retenté plus tard.
    """
    await enforce(ACCOUNT_RULE, str(user.id))
    context = audit.request_context(request)

    with _translated():
        microsoft.verify_state(str(user.id), payload.state)
        proof = await microsoft.authenticate_with_code(payload.code)
        await microsoft.attach(
            session,
            user,
            proof,
            ip=context.ip,
            user_agent=context.user_agent,
        )

    await textures.import_from_mojang(session, user, proof.profile)
    await session.commit()
    return await _user_payload(session, user)


@router.post(
    "/poll",
    summary="Interroger un rattachement en cours (flux device)",
    response_model=None,
    responses={
        200: {"description": "Rattachement effectué ; le compte est renvoyé."},
        202: {"model": LinkPendingOut, "description": "En attente du joueur."},
    },
    dependencies=[rate_limit("link.microsoft.ip")],
)
async def poll(
    payload: LinkPollIn,
    user: CurrentUser,
    request: Request,
    session: SessionDep,
) -> dict[str, UserOut] | JSONResponse:
    """Demande à Microsoft si le joueur a validé le code affiché.

    Tant qu'il ne l'a pas fait, la réponse est un ``202`` porteur de l'intervalle
    à respecter — ce n'est pas une erreur, et le launcher se contente de
    reboucler. Une fois la validation faite, la réponse est identique à celle de
    ``/complete``.
    """
    await enforce(ACCOUNT_RULE, str(user.id))
    context = audit.request_context(request)

    try:
        device_code = microsoft.verify_device_ticket(str(user.id), payload.device_code)
        proof = await microsoft.authenticate_with_device(device_code)
        await microsoft.attach(
            session,
            user,
            proof,
            ip=context.ip,
            user_agent=context.user_agent,
        )
    except MicrosoftError as exc:
        if exc.code != PENDING_CODE:
            raise _to_api_error(exc) from exc
        pending = LinkPendingOut(interval=int((exc.details or {}).get("interval") or 5))
        return JSONResponse(
            status_code=status.HTTP_202_ACCEPTED,
            content=pending.model_dump(),
        )

    await textures.import_from_mojang(session, user, proof.profile)
    await session.commit()
    return await _user_payload(session, user)


# --------------------------------------------------------------------------- #
# 3. Re-vérification et dissociation
# --------------------------------------------------------------------------- #


@router.post(
    "/refresh",
    summary="Re-vérifier la possession de Minecraft",
    dependencies=[rate_limit("link.microsoft.ip")],
)
async def refresh(
    user: CurrentUser,
    request: Request,
    session: SessionDep,
) -> dict[str, UserOut]:
    """Repousse l'échéance de la preuve de possession.

    Tant que ``expires_at`` n'est pas dépassé, **aucun appel n'est émis vers
    Microsoft** : la réponse vient du cache de 30 jours, et une panne de leur
    côté n'a aucun effet. C'est exactement ce que la souveraineté achète
    (``docs/DATA.md`` §7).

    Quand la fenêtre est écoulée, la chaîne complète est rejouée en silence
    grâce au ``refresh_token`` Microsoft conservé chiffré : le joueur n'a rien à
    ressaisir.
    """
    await enforce(ACCOUNT_RULE, str(user.id))
    context = audit.request_context(request)

    async def reimport_skin(proof: microsoft.OwnershipProof) -> None:
        """Retente l'import de l'apparence, une re-vérification ayant eu lieu.

        Le service n'appelle ce rappel que lorsqu'il a réellement joint
        Microsoft : c'est le seul moment où le profil — et donc l'URL du skin —
        est disponible, et une réponse servie depuis le cache ne déclenche donc
        rien du tout (``docs/DATA.md`` §6).
        """
        await textures.import_from_mojang(session, user, proof.profile)

    with _translated():
        await microsoft.refresh_link(
            session,
            user,
            ip=context.ip,
            user_agent=context.user_agent,
            on_verified=reimport_skin,
        )

    return await _user_payload(session, user)


@router.delete(
    "",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Dissocier le compte Microsoft",
    dependencies=[rate_limit("link.microsoft.ip")],
)
async def unlink(
    payload: UnlinkIn,
    user: CurrentUser,
    request: Request,
    session: SessionDep,
) -> Response:
    """Détache le compte Microsoft. Le mot de passe OPM est exigé.

    En mode hybride, dissocier revient à renoncer à jouer tant qu'un nouveau
    rattachement n'a pas eu lieu : le launcher le rappelle avant d'appeler cette
    route. Le skin importé, lui, reste — il appartient au compte OPM.
    """
    await enforce(ACCOUNT_RULE, str(user.id))
    context = audit.request_context(request)

    with _translated():
        await microsoft.detach(
            session,
            user,
            payload.password,
            ip=context.ip,
            user_agent=context.user_agent,
        )

    return Response(status_code=status.HTTP_204_NO_CONTENT)
