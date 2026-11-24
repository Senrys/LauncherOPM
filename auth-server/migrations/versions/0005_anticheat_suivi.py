"""Anti-triche : suivi des alertes, dernier contrôle, première arrivée.

Révision ID : 0005_anticheat_suivi
Révise      : 0004_anticheat

- ``opm_alerte`` : niveau (preuve / soupçon), regroupement des répétitions,
  traitement par le staff (administration du site) ;
- ``opm_controle`` : le dernier rapport du mod OPM, une ligne par compte ;
- ``opm_arrivee`` : les comptes qui ont déjà vu la scène de première arrivée. Les
  comptes ayant déjà joué y sont inscrits d'office : ils ne la reverront pas ;
- ``opm_modpack`` : les mods qui sont, ou ont été récemment, dans le modpack.

Additive : aucune table du site n'est créée, modifiée ni supprimée. Les nouvelles
colonnes ont toutes une valeur par défaut : l'ancien ``anticheat.sk`` et l'ancien
serveur continuent d'écrire dans ``opm_alerte`` sans rien changer.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005_anticheat_suivi"
down_revision: str | None = "0004_anticheat"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ALERTE_COLONNES = (
    "user_id",
    "niveau",
    "occurrences",
    "vu_le",
    "statut",
    "note",
    "traite_par",
    "traite_le",
)


def upgrade() -> None:
    with op.batch_alter_table("opm_alerte") as batch:
        batch.add_column(sa.Column("user_id", sa.Integer(), nullable=True))
        batch.add_column(
            sa.Column("niveau", sa.String(length=8), server_default="soupcon", nullable=False)
        )
        batch.add_column(
            sa.Column("occurrences", sa.Integer(), server_default=sa.text("1"), nullable=False)
        )
        batch.add_column(sa.Column("vu_le", sa.DateTime(), nullable=True))
        batch.add_column(
            sa.Column("statut", sa.String(length=12), server_default="nouvelle", nullable=False)
        )
        batch.add_column(sa.Column("note", sa.Text(), nullable=True))
        batch.add_column(sa.Column("traite_par", sa.String(length=64), nullable=True))
        batch.add_column(sa.Column("traite_le", sa.DateTime(), nullable=True))
        batch.create_foreign_key(
            "fk_opm_alerte_user", "users", ["user_id"], ["id"], ondelete="SET NULL"
        )
    op.create_index("ix_opm_alerte_user_id", "opm_alerte", ["user_id"])
    op.create_index("ix_opm_alerte_cree_le", "opm_alerte", ["cree_le"])

    op.create_table(
        "opm_controle",
        sa.Column("user_id", sa.Integer(), autoincrement=False, nullable=False),
        sa.Column("joueur", sa.String(length=32), nullable=False),
        sa.Column("uuid", sa.String(length=32), nullable=True),
        sa.Column("phase", sa.String(length=12), nullable=False),
        sa.Column("ok", sa.Boolean(), nullable=False),
        sa.Column("motifs", sa.String(length=500), nullable=True),
        sa.Column("mods", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("packs", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("launcher", sa.String(length=24), nullable=True),
        sa.Column("le", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], ondelete="CASCADE", name="fk_opm_controle_user"
        ),
        sa.PrimaryKeyConstraint("user_id", name="pk_opm_controle"),
    )
    op.create_index("ix_opm_controle_uuid", "opm_controle", ["uuid"])

    op.create_table(
        "opm_arrivee",
        sa.Column("user_id", sa.Integer(), autoincrement=False, nullable=False),
        sa.Column("vue_le", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], ondelete="CASCADE", name="fk_opm_arrivee_user"
        ),
        sa.PrimaryKeyConstraint("user_id", name="pk_opm_arrivee"),
    )
    # Ceux qui ont déjà joué ne reverront pas la scène : un rapport du mod en jeu, une
    # session de jeu, ou une partie consignée au journal. Le tout croisé avec
    # « users » : l'audit garde des comptes supprimés.
    op.execute(
        """
        INSERT INTO opm_arrivee (user_id)
        SELECT u.id FROM users u WHERE u.id IN (
            SELECT user_id FROM game_report
            UNION SELECT user_id FROM ygg_session
            UNION SELECT user_id FROM auth_audit
                   WHERE user_id IS NOT NULL
                     AND action IN ('ygg_join', 'game_session', 'game_session_end', 'game_report')
        )
        """
    )

    op.create_table(
        "opm_modpack",
        sa.Column("fichier", sa.String(length=255), nullable=False),
        sa.Column("sha1", sa.String(length=40), nullable=False),
        sa.Column("vu_le", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("fichier", "sha1", name="pk_opm_modpack"),
    )


def downgrade() -> None:
    op.drop_table("opm_modpack")
    op.drop_table("opm_arrivee")
    op.drop_index("ix_opm_controle_uuid", table_name="opm_controle")
    op.drop_table("opm_controle")
    op.drop_index("ix_opm_alerte_cree_le", table_name="opm_alerte")
    op.drop_index("ix_opm_alerte_user_id", table_name="opm_alerte")
    with op.batch_alter_table("opm_alerte") as batch:
        batch.drop_constraint("fk_opm_alerte_user", type_="foreignkey")
        for colonne in reversed(ALERTE_COLONNES):
            batch.drop_column(colonne)
