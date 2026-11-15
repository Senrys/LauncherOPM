"""Origine des sessions de jeu : le serveur ne s'ouvre qu'au launcher OPM.

Révision ID : 0003_ygg_session_origin
Révise      : 0002_launcher_xenodys

Ajoute ``ygg_session.origin`` : ``launcher`` pour une session délivrée au clic
sur JOUER (``POST /api/v1/game/session``), ``yggdrasil`` pour une session
ouverte par ``/authserver/authenticate`` (un launcher tiers). Avec
``OPM_JOIN_LAUNCHER_ONLY`` (actif par défaut), seul un ``join`` porté par une
session ``launcher`` est accepté.

Strictement additive : la colonne ne concerne qu'une table du serveur
d'authentification, jamais une table du site. Les sessions déjà ouvertes
prennent l'origine ``yggdrasil`` : elles vivent au plus 24 h, et le prochain
JOUER en délivre une nouvelle.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_ygg_session_origin"
down_revision: str | None = "0002_launcher_xenodys"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Ajoute ``ygg_session.origin`` (``yggdrasil`` pour les lignes existantes)."""
    op.add_column(
        "ygg_session",
        sa.Column(
            "origin", sa.String(length=16), server_default="yggdrasil", nullable=False
        ),
    )


def downgrade() -> None:
    """Retire ``ygg_session.origin`` : toutes les sessions redeviennent égales."""
    op.drop_column("ygg_session", "origin")
