"""Services métier du serveur d'authentification One Piece Minecraft.

Toute la logique vit ici : les routeurs de ``opm_auth.routers`` se contentent de
valider l'entrée (Pydantic), d'appeler un service et de renvoyer un schéma de
sortie. Cette séparation a deux effets concrets :

* un service est testable sans passer par HTTP ;
* une même règle métier ne peut pas diverger entre deux points d'entrée
  (l'API launcher et l'API Yggdrasil partagent par exemple le même calcul du
  droit de jouer).

Modules :

* :mod:`audit` — écriture du journal d'audit, expurgé de toute donnée sensible ;
* :mod:`users` — comptes OPM : création, authentification, sessions, mot de
  passe, double authentification et calcul de ``can_play``.

Aucun sous-module n'est importé ici : les services se chargent à la demande,
ce qui évite qu'un outil annexe (Alembic, scripts de clés) ne tire tout le
paquet pour rien.
"""

from __future__ import annotations
