"""Routeurs HTTP du serveur d'authentification One Piece Minecraft.

Le serveur expose trois surfaces, décrites par ``docs/API.md`` :

* ``/api/v1``    — API du launcher (comptes OPM, rattachement Microsoft, contenu) ;
* ``/yggdrasil`` — protocole Mojang attendu par authlib-injector ;
* ``/textures``  — skins et capes servis en contenu adressable.

Chaque module de ce paquet expose un objet ``router`` (``fastapi.APIRouter``)
préfixé par sa propre section — ``/auth`` pour :mod:`auth`, par exemple. C'est
l'application qui les monte sous leur racine :

.. code-block:: python

    from opm_auth.routers import auth

    app.include_router(auth.router, prefix="/api/v1")

Aucun sous-module n'est importé ici, afin qu'ajouter un routeur reste une
opération locale et qu'un import du paquet ne charge pas toute l'API.
"""

from __future__ import annotations
