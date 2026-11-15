"""Xenodys : l'état du monde partagé par le jeu, le launcher et le site.

Révision ID : 0002_launcher_xenodys
Révise      : 0001_launcher_auth

Une table d'une seule ligne, ``launcher_xenodys``, qui dit si Xenodys — l'entité
créatrice du monde — est elle-même (``creatrice``, couleur cyan) ou corrompue par
l'ennemi pendant un événement RP (``corrompue``, rouge et violet).

- **Écrite** par le staff depuis le jeu : commande Skript ``/xenodys``
  (``minecraft/xenodys.sk``), via la connexion skript-db déjà en place.
- **Lue** par le serveur d'authentification (``GET /api/v1/xenodys``, champ
  ``xenodys`` de ``/bootstrap``) et par le site, qui adapte son thème.

Strictement additive, comme 0001 : elle ne touche à aucune table du site. La
ligne ``id = 1`` est créée d'emblée, à l'état ``creatrice`` : personne n'a à
l'insérer à la main, et la commande du jeu n'a qu'à faire un ``UPDATE``.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_launcher_xenodys"
down_revision: str | None = "0001_launcher_auth"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Crée ``launcher_xenodys`` et sa ligne unique, à l'état « créatrice »."""
    table = op.create_table(
        "launcher_xenodys",
        sa.Column("id", sa.Integer(), autoincrement=False, nullable=False),
        sa.Column("etat", sa.String(length=16), server_default="creatrice", nullable=False),
        sa.Column("message", sa.String(length=280), nullable=True),
        sa.Column("par", sa.String(length=64), nullable=True),
        sa.Column(
            "depuis",
            sa.DateTime(),  # sans fuseau, en UTC : la convention du site (UTCTimestamp)
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "etat IN ('creatrice', 'corrompue')", name="ck_launcher_xenodys_etat"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_launcher_xenodys"),
    )
    op.bulk_insert(table, [{"id": 1, "etat": "creatrice"}])


def downgrade() -> None:
    """Supprime ``launcher_xenodys`` : le launcher et le site retombent sur « créatrice »."""
    op.drop_table("launcher_xenodys")
