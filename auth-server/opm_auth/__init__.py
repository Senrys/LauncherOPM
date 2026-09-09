"""Serveur d'authentification et API du launcher One Piece Minecraft.

Le paquet expose trois surfaces HTTP :

* ``/api/v1``     — API du launcher : comptes OPM, rattachement Microsoft, contenu ;
* ``/yggdrasil``  — protocole Mojang attendu par authlib-injector côté serveur de jeu ;
* ``/textures``   — skins et capes, servis en contenu adressable (SHA-256).

Modèle d'authentification : **hybride imposé**. Le joueur possède un compte OPM
(e-mail + mot de passe Argon2id + TOTP facultatif) et rattache un compte Microsoft
qui sert uniquement d'oracle de possession de Minecraft, vérifié côté serveur puis
mis en cache. C'est ensuite *notre* serveur qui délivre la session de jeu, signée
Ed25519 : aucun jeton Microsoft n'atteint jamais le client Minecraft.

Seule ``config`` est ré-exportée ici : importer la base de données ou les modèles
au chargement du paquet obligerait les outils annexes (Alembic, scripts de clés)
à démarrer tout FastAPI pour rien.
"""

from __future__ import annotations

from opm_auth.config import Settings, get_settings

__all__ = ["APP_NAME", "Settings", "__version__", "get_settings"]

APP_NAME = "opm-auth"
__version__ = "1.0.0"
