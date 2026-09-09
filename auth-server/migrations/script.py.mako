"""${message}

Revision ID: ${up_revision}
Revises: ${down_revision | comma,n}
Date de création : ${create_date}

RAPPEL — base partagée avec le site Flask One Piece Minecraft :

* une migration ne crée, ne modifie et ne supprime QUE des tables du launcher
  (``auth_*``, ``ygg_*``, ``launcher_*``, ``texture``, ``user_texture``) ;
* aucune opération sur ``users``, ``article``, ``statistiques``, ``equipages``,
  ``iles``, ``combats``, ``produits``, ``equipe``, ``securite``, ``contact`` ni
  ``alembic_version`` : pas d'``alter_column``, pas de ``drop_*``, pas d'``add_column`` ;
* ``downgrade()`` doit défaire exactement ``upgrade()``, dans l'ordre inverse.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
${imports if imports else ""}

# Identifiants de révision, utilisés par Alembic.
revision: str = ${repr(up_revision)}
down_revision: str | None = ${repr(down_revision)}
branch_labels: str | Sequence[str] | None = ${repr(branch_labels)}
depends_on: str | Sequence[str] | None = ${repr(depends_on)}


def upgrade() -> None:
    """Applique la migration."""
    ${upgrades if upgrades else "pass"}


def downgrade() -> None:
    """Annule la migration."""
    ${downgrades if downgrades else "pass"}
