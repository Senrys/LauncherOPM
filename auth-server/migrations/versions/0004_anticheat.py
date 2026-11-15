"""Anti-triche : empreinte des fichiers du jeu, rapports du mod, alertes.

Révision ID : 0004_anticheat
Révise      : 0003_ygg_session_origin

- ``ygg_session.attestation`` : ce que le launcher a déclaré des fichiers du jeu
  au clic sur JOUER (``ok`` / ``refused`` / ``unverified``) ;
- ``game_report`` : les empreintes du launcher et les rapports du mod OPM en jeu
  (mods chargés, packs de ressources, X-ray) ;
- ``opm_alerte`` : les soupçons de triche, écrits aussi par le serveur Minecraft
  (``minecraft/anticheat.sk``, via skript-db) et relayés au staff.

Strictement additive : rien ne touche aux tables du site.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004_anticheat"
down_revision: str | None = "0003_ygg_session_origin"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("ygg_session", sa.Column("attestation", sa.String(length=12), nullable=True))
    op.create_table(
        "game_report",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=12), nullable=False),
        sa.Column("ok", sa.Boolean(), nullable=False),
        sa.Column("details", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], ondelete="CASCADE", name="fk_game_report_user"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_game_report"),
    )
    op.create_index("ix_game_report_user_id", "game_report", ["user_id"])
    op.create_table(
        "opm_alerte",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("joueur", sa.String(length=32), nullable=False),
        sa.Column("uuid", sa.String(length=36), nullable=True),
        sa.Column("type", sa.String(length=24), nullable=False),
        sa.Column("detail", sa.String(length=280), nullable=True),
        sa.Column("source", sa.String(length=12), server_default="serveur", nullable=False),
        sa.Column("relayee", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("cree_le", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_opm_alerte"),
    )
    op.create_index("ix_opm_alerte_relayee", "opm_alerte", ["relayee"])


def downgrade() -> None:
    op.drop_index("ix_opm_alerte_relayee", table_name="opm_alerte")
    op.drop_table("opm_alerte")
    op.drop_index("ix_game_report_user_id", table_name="game_report")
    op.drop_table("game_report")
    op.drop_column("ygg_session", "attestation")
