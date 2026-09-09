"""Routeur des comptes OPM — ``/api/v1/auth`` (``docs/API.md`` §1.2).

Chemins exposés :

===========================  ======  =========================================
Chemin                       Verbe   Réponse
===========================  ======  =========================================
``/auth/register``           POST    ``201 {user}``
``/auth/login``              POST    ``200 {access_token, refresh_token, …}``
``/auth/refresh``            POST    ``200 {access_token, refresh_token, …}``
``/auth/logout``             POST    ``204``
``/auth/me``                 GET     ``200 {user}``
``/auth/password/forgot``    POST    ``202`` (toujours, anti-énumération)
``/auth/password/reset``     POST    ``204``
``/auth/totp/setup``         POST    ``200 {secret, otpauth_uri, recovery_codes}``
``/auth/totp/enable``        POST    ``204``
``/auth/totp/disable``       POST    ``204``
===========================  ======  =========================================

Le routeur est volontairement mince : il valide l'entrée (Pydantic), applique
les limites de débit à portée « IP » (``docs/API.md`` §4.4), délègue à
``opm_auth.services.users`` et met en forme la sortie. Aucune règle métier n'est
écrite ici — pas même le calcul de ``can_play``, qui doit rester identique
partout.

Le compte renvoyé est celui de la base **du site** : ``id`` est l'entier
``users.id``, ``username`` est ``users.name``, et le volet ``profile`` (faction,
équipage, îles tenues, prime, niveau, temps de jeu) est en lecture seule
(``docs/DATA.md`` §1 et §4). Les limites à portée « compte » — 10 connexions par
heure et par adresse, 3 demandes de réinitialisation par jour — sont appliquées
dans le service, qui seul connaît l'adresse visée.

Montage attendu côté application :

.. code-block:: python

    from opm_auth.routers import auth

    app.include_router(auth.router, prefix="/api/v1")
"""

from __future__ import annotations

from fastapi import APIRouter, Request, Response, status

from opm_auth.db import SessionDep
from opm_auth.schemas import (
    ForgotPasswordIn,
    LoginIn,
    LoginOut,
    LogoutIn,
    RefreshIn,
    RefreshOut,
    RegisterIn,
    ResetPasswordIn,
    TotpDisableIn,
    TotpEnableIn,
    TotpSetupOut,
    UserOut,
)
from opm_auth.security.deps import CurrentUser
from opm_auth.security.ratelimit import rate_limit
from opm_auth.services import audit, users

router = APIRouter(prefix="/auth", tags=["Comptes OPM"])


# --------------------------------------------------------------------------- #
# Inscription et connexion
# --------------------------------------------------------------------------- #


@router.post(
    "/register",
    response_model=UserOut,
    status_code=status.HTTP_201_CREATED,
    summary="Créer un compte OPM",
    dependencies=[rate_limit("auth.register.ip")],
)
async def register(payload: RegisterIn, request: Request, session: SessionDep) -> UserOut:
    """Crée un compte OPM et le renvoie tel que le launcher l'affiche.

    Le compte créé ici **est** le compte du site : la même ligne ``users``, la
    même empreinte au format Werkzeug. Le joueur pourra se connecter à
    ``onepieceminecraft.fr`` avec ces identifiants (``docs/DATA.md`` §3).

    Sa fiche de personnage naît vide — ni faction, ni équipage, ni métier : ces
    colonnes appartiennent au site et au serveur Minecraft, le launcher ne les
    invente pas. Le compte naît aussi sans rattachement Microsoft : en mode
    hybride il sort donc avec ``can_play = false`` et
    ``blocked_reason = "microsoft_required"``. C'est voulu — le launcher
    enchaîne aussitôt sur l'écran de rattachement.
    """
    context = audit.request_context(request)
    user = await users.create_user(
        session,
        email=payload.email,
        username=payload.username,
        password=payload.password,
        ip=context.ip,
        user_agent=context.user_agent,
    )
    return await users.serialize_with_profile(session, user)


@router.post(
    "/login",
    response_model=LoginOut,
    summary="Ouvrir une session launcher",
    dependencies=[rate_limit("auth.login.ip")],
)
async def login(payload: LoginIn, request: Request, session: SessionDep) -> LoginOut:
    """Vérifie les identifiants et délivre le couple de jetons.

    Si la double authentification est active, ``totp`` est obligatoire :
    ``401 totp_required`` quand il manque, ``401 totp_invalid`` quand il est
    faux. Un code de secours à usage unique est accepté au même endroit.

    Deux écritures accompagnent une connexion réussie, et deux seulement :
    ``users.derniereconnexion`` passe à l'instant courant, et l'empreinte du mot
    de passe est **renforcée** si elle date encore des 260 000 itérations du
    site (``docs/DATA.md`` §3). Le format reste du Werkzeug, le site continue de
    lire sans rien changer.
    """
    context = audit.request_context(request)
    user, pair = await users.login(
        session,
        email=payload.email,
        password=payload.password,
        totp=payload.totp,
        ip=context.ip,
        user_agent=context.user_agent,
    )
    return LoginOut(
        access_token=pair.access_token,
        refresh_token=pair.refresh_token,
        expires_in=pair.expires_in,
        user=await users.serialize_with_profile(session, user),
    )


@router.post(
    "/refresh",
    response_model=RefreshOut,
    summary="Renouveler les jetons",
    dependencies=[rate_limit("auth.refresh.ip")],
)
async def refresh(payload: RefreshIn, request: Request, session: SessionDep) -> RefreshOut:
    """Échange un ``refresh_token`` contre un couple neuf.

    La rotation est obligatoire : le jeton présenté est consommé. Son retour
    ultérieur signe un vol et révoque toute la famille (``401 token_revoked``).
    """
    context = audit.request_context(request)
    _, pair = await users.rotate_session(
        session,
        refresh_token=payload.refresh_token,
        ip=context.ip,
        user_agent=context.user_agent,
    )
    return RefreshOut(
        access_token=pair.access_token,
        refresh_token=pair.refresh_token,
        expires_in=pair.expires_in,
    )


@router.post(
    "/logout",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Fermer la session",
)
async def logout(payload: LogoutIn, request: Request, session: SessionDep) -> Response:
    """Révoque la famille de jetons née de cette connexion.

    Volontairement idempotent : un jeton déjà révoqué ou inconnu répond ``204``
    lui aussi, pour ne pas transformer la déconnexion en oracle.
    """
    context = audit.request_context(request)
    await users.logout(
        session,
        refresh_token=payload.refresh_token,
        ip=context.ip,
        user_agent=context.user_agent,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/me", response_model=UserOut, summary="Compte courant")
async def me(user: CurrentUser, session: SessionDep) -> UserOut:
    """Renvoie le compte porté par l'``access_token``, ``can_play`` compris.

    C'est ici que le launcher relit le volet « VOTRE PERSONNAGE » : faction,
    équipage, îles tenues, prime, berrys, niveau et temps de jeu, tous lus dans
    la base du site.
    """
    return await users.serialize_with_profile(session, user)


# --------------------------------------------------------------------------- #
# Mot de passe
# --------------------------------------------------------------------------- #


@router.post(
    "/password/forgot",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Demander une réinitialisation de mot de passe",
    dependencies=[rate_limit("auth.password.forgot.ip")],
)
async def forgot_password(
    payload: ForgotPasswordIn, request: Request, session: SessionDep
) -> Response:
    """Prépare un lien de réinitialisation.

    Répond ``202`` que l'adresse existe ou non : rien, dans le code, le corps
    ou le délai de réponse, ne permet de savoir si un compte est associé à
    cette adresse (``docs/API.md`` §4.6).
    """
    context = audit.request_context(request)
    await users.request_password_reset(
        session,
        email=payload.email,
        ip=context.ip,
        user_agent=context.user_agent,
    )
    return Response(status_code=status.HTTP_202_ACCEPTED)


@router.post(
    "/password/reset",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Réinitialiser le mot de passe",
    dependencies=[rate_limit("auth.password.reset.ip")],
)
async def reset_password(
    payload: ResetPasswordIn, request: Request, session: SessionDep
) -> Response:
    """Change le mot de passe à partir du jeton reçu par courriel.

    Le jeton est à usage unique et toutes les sessions launcher du compte sont
    révoquées : un mot de passe réinitialisé est un mot de passe qui a peut-être
    fuité. La nouvelle empreinte reste lisible par le site.
    """
    context = audit.request_context(request)
    await users.reset_password(
        session,
        token=payload.token,
        password=payload.password,
        ip=context.ip,
        user_agent=context.user_agent,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------------- #
# Double authentification
# --------------------------------------------------------------------------- #


@router.post(
    "/totp/setup",
    response_model=TotpSetupOut,
    summary="Préparer la double authentification",
)
async def totp_setup(user: CurrentUser, request: Request, session: SessionDep) -> TotpSetupOut:
    """Génère un secret TOTP, son URI ``otpauth`` et les codes de secours.

    La 2FA n'est pas encore active : elle attend un premier code correct,
    présenté à ``/auth/totp/enable``. Les codes de secours ne sont montrés
    qu'ici, une seule fois.
    """
    context = audit.request_context(request)
    return await users.start_totp_enrollment(
        session, user, ip=context.ip, user_agent=context.user_agent
    )


@router.post(
    "/totp/enable",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Activer la double authentification",
)
async def totp_enable(
    payload: TotpEnableIn, user: CurrentUser, request: Request, session: SessionDep
) -> Response:
    """Active la 2FA après vérification d'un code de l'application."""
    context = audit.request_context(request)
    await users.confirm_totp(
        session, user, code=payload.code, ip=context.ip, user_agent=context.user_agent
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/totp/disable",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Désactiver la double authentification",
)
async def totp_disable(
    payload: TotpDisableIn, user: CurrentUser, request: Request, session: SessionDep
) -> Response:
    """Désactive la 2FA : mot de passe **et** second facteur valides exigés."""
    context = audit.request_context(request)
    await users.disable_totp(
        session,
        user,
        password=payload.password,
        code=payload.code,
        ip=context.ip,
        user_agent=context.user_agent,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
