"""Suite de tests du serveur d'authentification One Piece Minecraft.

Ce paquet n'est pas importé par l'application : il existe pour que ``pytest``
et les outils d'analyse voient les tests comme un module cohérent, et pour que
deux fichiers de test puissent porter le même nom dans des sous-dossiers
différents sans se marcher dessus.

Les réglages de test (base SQLite en mémoire, clés jetables, paramètres Argon2
allégés) sont posés dans ``tests/conftest.py``, avant tout import de
``opm_auth`` : voir l'en-tête de ce fichier.
"""

from __future__ import annotations
