"""Routeur des textures — ``/textures`` (``docs/API.md`` §2.5).

Montage attendu côté application (le routeur porte déjà son préfixe) :

.. code-block:: python

    from opm_auth.routers import textures

    app.include_router(textures.router)

Chemins exposés :

============================  ========  ==================================================
Chemin                        Verbe     Rôle
============================  ========  ==================================================
``/textures/{sha256}.png``    GET       le blob lui-même, **public**, cache immuable
``/textures/me``              GET       textures actives du compte authentifié
``/textures/{kind}``          POST      téléverse un skin ou une cape (``multipart``)
``/textures/{kind}``          DELETE    revient à la texture par défaut
============================  ========  ==================================================

**Pourquoi la lecture est publique.** C'est le client Minecraft — celui de chaque
joueur présent sur le serveur — qui télécharge ces PNG pour afficher les autres
joueurs. Il n'a aucun jeton OPM à présenter. Le contenu n'est d'ailleurs pas
secret : une empreinte SHA-256 de 64 caractères n'est pas devinable, et le
fichier ne dit rien de son propriétaire.

**Pourquoi le cache est immuable.** L'URL contient l'empreinte du contenu : un
skin modifié change d'URL. On peut donc annoncer un an de validité et
``immutable`` sans jamais avoir à invalider quoi que ce soit — et le client
Minecraft, qui ne cache pas grand-chose, ne redemande le fichier qu'une fois.

**Pourquoi une classe de route.** Le plafond de taille ne peut pas être posé
dans la fonction de route : FastAPI lit — et Starlette déverse sur disque — le
corps d'un ``multipart`` **avant** d'appeler le gestionnaire. :class:`BodyLimitRoute`
s'intercale donc plus tôt encore, sur le canal ASGI lui-même : au premier octet
de trop, la lecture s'arrête et la requête est refusée, qu'elle annonce sa
taille ou non (``Transfer-Encoding: chunked``, HTTP/2).

Ce routeur reste un simple adaptateur HTTP : la validation du contenu, le calcul
de l'empreinte et l'écriture en base vivent dans
:mod:`opm_auth.services.textures`.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Coroutine
from typing import Annotated, Any

from fastapi import APIRouter, File, Form, Path, Request, Response, UploadFile, status
from fastapi.responses import FileResponse
from fastapi.routing import APIRoute

from opm_auth.config import get_settings
from opm_auth.db import SessionDep
from opm_auth.models import TextureKind, TextureModel
from opm_auth.schemas import TextureOut, TextureUploadOut
from opm_auth.security.deps import ApiError, CurrentUser
from opm_auth.services import textures as service

__all__ = ["BodyLimitRoute", "read_texture_payload", "router"]

logger = logging.getLogger(__name__)

#: Un an, en secondes : la durée conventionnelle d'un contenu immuable.
IMMUTABLE_MAX_AGE = 31_536_000

#: En-têtes de cache d'un contenu adressé par son empreinte (``docs/API.md`` §2.5).
CACHE_HEADERS: dict[str, str] = {
    "Cache-Control": f"public, max-age={IMMUTABLE_MAX_AGE}, immutable",
}

#: « Contenu trop volumineux ». Écrit en clair plutôt que pris dans ``status`` :
#: la constante y a été renommée entre deux versions de Starlette, le nombre non.
HTTP_CONTENT_TOO_LARGE = 413

#: Type de texture accepté dans un chemin. Le motif est vérifié par le routage :
#: une valeur fantaisiste n'atteint jamais le service.
KindPath = Annotated[str, Path(pattern="^(skin|cape)$", description="skin ou cape")]

#: Empreinte de la texture demandée, telle qu'elle apparaît dans l'URL.
ShaPath = Annotated[str, Path(min_length=1, max_length=128)]

#: Marge tolérée au-dessus du plafond d'une texture pour le corps **entier** :
#: un envoi ``multipart`` transporte, en plus du PNG, ses frontières, les
#: en-têtes de chaque partie et le champ ``model``. Quelques kilo-octets
#: suffisent largement.
MULTIPART_OVERHEAD = 4096

#: Verbes dont le corps est lu : les seuls à plafonner.
BODY_METHODS = frozenset({"POST", "PUT", "PATCH"})


def _max_bytes() -> int:
    """Plafond d'une texture, en octets (``OPM_TEXTURE_MAX_KIB``)."""
    return int(get_settings().texture_max_kib) * 1024


def _too_large(limit: int) -> ApiError:
    """413 normalisée, identique où que le plafond soit franchi."""
    return ApiError(
        "texture_too_large",
        f"Cette image dépasse la taille maximale autorisée ({limit // 1024} Kio).",
        status_code=HTTP_CONTENT_TOO_LARGE,
        details={"max_bytes": limit},
    )


class BodyLimitRoute(APIRoute):
    """Classe de route qui plafonne le corps **avant** toute lecture.

    Une fonction de route s'exécute trop tard pour protéger la mémoire : quand
    elle démarre, FastAPI a déjà résolu ses paramètres, donc appelé
    ``request.form()`` ou ``request.json()``, donc laissé Starlette accumuler le
    corps en mémoire ou déverser la pièce jointe complète dans un fichier
    temporaire. Et ``Content-Length`` ne se vérifie pas : il est absent en
    ``Transfer-Encoding: chunked`` comme en HTTP/2.

    La borne est donc posée un cran plus bas, sur le canal ASGI : chaque bloc
    reçu est compté et, au premier octet au-delà du plafond, la lecture est
    interrompue — le reste du flux n'est jamais lu, ni gardé en mémoire, ni
    écrit sur le disque.

    Deux crochets permettent de la réutiliser sur une autre surface (le routeur
    Yggdrasil s'en sert pour rendre un refus au format Mojang) :
    :meth:`body_ceiling` donne le plafond, :meth:`body_rejected` l'erreur à
    lever.
    """

    @staticmethod
    def body_ceiling() -> int:
        """Plafond du corps **entier**, enveloppe ``multipart`` comprise."""
        return _max_bytes() + MULTIPART_OVERHEAD

    @staticmethod
    def body_rejected(ceiling: int) -> Exception:
        """Erreur levée dès que le plafond est franchi."""
        return _too_large(_max_bytes())

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        original = super().get_route_handler()

        async def handler(request: Request) -> Response:
            if request.method not in BODY_METHODS:
                return await original(request)

            ceiling = self.body_ceiling()

            # La taille annoncée n'est qu'un aveu : on l'exploite quand elle est
            # là — cela évite de lire un corps déjà condamné — mais on ne s'y
            # fie jamais pour la borne réelle.
            announced = request.headers.get("content-length")
            if announced and announced.isdigit() and int(announced) > ceiling:
                raise self.body_rejected(ceiling)

            receive = request.receive
            received = 0

            async def guarded() -> Any:
                nonlocal received
                message = await receive()
                if message.get("type") == "http.request":
                    received += len(message.get("body") or b"")
                    if received > ceiling:
                        logger.info(
                            "Lecture interrompue : corps supérieur à %d octets.",
                            ceiling,
                        )
                        raise self.body_rejected(ceiling)
                return message

            return await original(Request(request.scope, guarded))

        return handler


router = APIRouter(prefix="/textures", tags=["Textures"], route_class=BodyLimitRoute)


def _not_found() -> ApiError:
    """404 unique : une empreinte invalide et une texture absente se ressemblent.

    Répondre différemment renseignerait un curieux sur ce que nous hébergeons.
    """
    return ApiError(
        "not_found",
        "Cette texture n'existe pas.",
        status_code=status.HTTP_404_NOT_FOUND,
    )


# --------------------------------------------------------------------------- #
# Lecture publique
# --------------------------------------------------------------------------- #


@router.get(
    "/{sha256}.png",
    summary="Télécharger une texture",
    response_class=FileResponse,
    responses={
        200: {"content": {"image/png": {}}, "description": "Le PNG demandé."},
        304: {"description": "Le client a déjà cette texture."},
        404: {"description": "Empreinte inconnue."},
    },
)
async def get_texture(sha256: ShaPath, request: Request) -> Response:
    """Sert le PNG d'un skin ou d'une cape, sans authentification.

    L'empreinte est validée (``^[0-9a-f]{64}$``) **avant** toute construction de
    chemin : aucune traversée de répertoire n'est possible, et un nom invalide
    répond 404 comme un nom simplement inconnu.
    """
    try:
        path = service.path_for(sha256)
    except service.TextureRejected as exc:
        logger.info("Texture refusée : empreinte invalide.")
        raise _not_found() from exc

    digest = sha256.strip().lower()
    etag = f'"{digest}"'

    # Contenu immuable : si le client annonce déjà cette empreinte, il l'a.
    if etag in {tag.strip() for tag in (request.headers.get("if-none-match") or "").split(",")}:
        return Response(
            status_code=status.HTTP_304_NOT_MODIFIED,
            headers={**CACHE_HEADERS, "ETag": etag},
        )

    if not await service.blob_exists(digest):
        raise _not_found()

    return FileResponse(
        path,
        media_type="image/png",
        headers={**CACHE_HEADERS, "ETag": etag},
    )


# --------------------------------------------------------------------------- #
# Textures du compte authentifié
# --------------------------------------------------------------------------- #


@router.get(
    "/me",
    response_model=dict[str, TextureOut],
    summary="Textures actives du compte",
)
async def my_textures(user: CurrentUser, session: SessionDep) -> dict[str, TextureOut]:
    """Renvoie les textures actives du joueur, indexées par type.

    Un type absent signifie « texture par défaut » : le launcher dessine alors
    la silhouette standard plutôt qu'une adresse inventée.
    """
    active = await service.current_textures(session, user.id)
    return {kind: service.texture_out(texture, kind=kind) for kind, texture in active.items()}


@router.post(
    "/{kind}",
    response_model=TextureUploadOut,
    summary="Téléverser un skin ou une cape",
)
async def upload_texture(
    kind: KindPath,
    user: CurrentUser,
    session: SessionDep,
    request: Request,
    file: Annotated[UploadFile | None, File(description="Le fichier PNG.")] = None,
    model: Annotated[str | None, Form(description="classic ou slim.")] = None,
) -> TextureUploadOut:
    """Enregistre la texture envoyée par le joueur et l'active sur son compte.

    Deux formes d'envoi sont acceptées : un formulaire ``multipart/form-data``
    (champs ``file`` et ``model``), ou le PNG brut dans le corps de la requête —
    le modèle de bras se donne alors par le paramètre d'URL ``?model=slim``.

    Dans les deux cas, **le contenu seul fait foi** : ni le nom du fichier, ni
    son extension, ni l'en-tête ``Content-Type`` ne sont regardés. Un JPEG
    renommé ``skin.png`` est refusé (``400 invalid_texture``), et un fichier trop
    volumineux l'est avant même d'être décodé (``413 texture_too_large``).
    """
    data = await read_texture_payload(request, file)
    chosen = model or request.query_params.get("model") or TextureModel.CLASSIC.value

    texture = await service.store_upload(
        session,
        user,
        data,
        kind=kind,
        model=chosen,
    )
    await session.commit()

    confirmation = "Cape enregistrée." if kind == TextureKind.CAPE.value else "Skin enregistré."
    return TextureUploadOut(
        texture=service.texture_out(texture, kind=kind),
        message=confirmation,
    )


@router.delete(
    "/{kind}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Revenir à la texture par défaut",
)
async def delete_texture(kind: KindPath, user: CurrentUser, session: SessionDep) -> Response:
    """Retire la texture active du joueur ; le fichier, lui, reste en place.

    Le blob peut être partagé avec d'autres joueurs et son URL a été annoncée
    immuable : on ne supprime que l'association. Le choix est explicite et
    durable — une re-vérification Microsoft ne réinstallera pas le skin ainsi
    retiré (voir ``services/textures.py``).

    Volontairement idempotent : retirer une texture déjà absente répond ``204``.
    """
    await service.clear_texture(session, user, kind)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------------- #
# Lecture du corps
# --------------------------------------------------------------------------- #


async def read_texture_payload(request: Request, file: UploadFile | None) -> bytes:
    """Extrait les octets envoyés, en refusant tôt ce qui est trop volumineux.

    Rien n'est jamais accumulé au-delà du plafond :

    * envoi ``multipart`` — on ne lit du fichier que ``plafond + 1`` octet, ce
      qui suffit à savoir qu'il est trop gros sans le charger ;
    * PNG brut — le flux est consommé bloc par bloc et la lecture s'arrête à
      l'octet de trop, **avant** que le corps entier ne soit en mémoire.

    ``request.body()`` n'est jamais appelée : c'est elle qui accumulait sans
    borne dès que ``Content-Length`` manquait. Le corps entier, ``multipart``
    compris, est de toute façon déjà borné par :class:`BodyLimitRoute`.
    """
    limit = _max_bytes()

    if file is not None:
        data = await file.read(limit + 1)
        if len(data) > limit:
            raise _too_large(limit)
    else:
        chunks: list[bytes] = []
        received = 0
        async for chunk in request.stream():
            received += len(chunk)
            if received > limit:
                raise _too_large(limit)
            chunks.append(chunk)
        data = b"".join(chunks)

    if not data:
        raise ApiError(
            "invalid_texture",
            "Aucune image n'a été reçue.",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    return data
