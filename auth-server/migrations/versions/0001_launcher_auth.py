"""launcher : authentification souveraine (12 tables additives)

Revision ID: 0001_launcher_auth
Revises:
Date de création : 2026-09-08

Cette migration ajoute à la base du site One Piece Minecraft les tables dont le
launcher a besoin et que le site n'a pas : identité Minecraft, sessions,
double authentification, Yggdrasil, textures et profils de jeu.

Elle est **strictement additive**. Elle ne contient volontairement :

* aucun ``op.alter_column`` ;
* aucun ``op.add_column`` ;
* aucun ``op.drop_*`` visant une table du site ;
* aucune écriture de données.

Les onze tables du site (``users``, ``article``, ``statistiques``, ``equipages``,
``iles``, ``combats``, ``produits``, ``equipe``, ``securite``, ``contact``,
``alembic_version``) ressortent de cette migration exactement telles qu'elles y
sont entrées. Le site continue de fonctionner sans rien savoir de ces douze
nouvelles tables.

------------------------------------------------------------------------------
OÙ SE BRANCHE CETTE MIGRATION : ``down_revision`` n'est pas écrit en dur
------------------------------------------------------------------------------
Le fichier doit s'appliquer sur **deux bases très différentes** : la base de
production du site, qui possède déjà son propre historique Alembic dans
``alembic_version``, et une base neuve de développement, de tests ou
d'intégration continue, qui n'a aucun historique. Une valeur écrite en dur ne
peut pas convenir aux deux, et un fichier qu'il faut éditer à la main avant
chaque déploiement finit toujours par être livré non édité — c'est exactement ce
qui s'était produit.

``down_revision`` est donc **lu dans l'environnement** :

.. code-block:: sh

    # Base neuve (développement, CI) : rien à faire, la variable reste vide.
    alembic upgrade head

    # Base du site : on chaîne notre migration à son historique.
    export OPM_SITE_ALEMBIC_REVISION="$(psql -tAX opmdb -c 'SELECT version_num FROM alembic_version')"
    alembic upgrade head

Deux façons de faire cohabiter les historiques, décrites en détail dans
``migrations/README.md`` §3 et §5 :

* **A — historique partagé** (la variable ci-dessus) : notre révision se chaîne
  à celle du site dans ``alembic_version``. Alembic doit alors **voir les
  fichiers de révision du site** (``version_locations`` dans ``alembic.ini``, ou
  copie du fichier dans le dépôt du site), sans quoi il s'arrête sur
  ``Can't locate revision identified by '<révision du site>'``.
* **B — historiques séparés** : ``version_table = "alembic_version_launcher"``
  dans ``migrations/env.py``. ``OPM_SITE_ALEMBIC_REVISION`` reste alors vide pour
  toujours, les deux historiques s'ignorent, et rien n'est à copier.

:func:`_controles_prealables` refuse de créer quoi que ce soit si la
configuration ne correspond à aucun des deux cas — avec un message qui dit quoi
faire, plutôt qu'une erreur Alembic obscure.

Sur une base neuve, ``None`` est la valeur correcte : ne rien exporter. La
migration s'applique alors telle quelle sur le SQLite de développement.

------------------------------------------------------------------------------
Choix techniques, assumés
------------------------------------------------------------------------------
* **Horodatages** : ``timestamp without time zone``, comme toutes les colonnes de
  date du site (``users.derniereconnexion``, ``article.published_date``,
  ``combats.date``…). Les valeurs stockées sont en **UTC naïf**. Une base qui
  mélangerait ``timestamp`` et ``timestamptz`` serait une source d'erreurs
  permanente ; le couplage se paie côté modèles, pas côté schéma.
* **Clés étrangères vers ``users(id)``** : ``integer``, car ``users.id`` est un
  ``serial`` — jamais un UUID.
* **``ON DELETE CASCADE``** partout où la ligne n'a aucun sens sans son compte,
  ``ON DELETE SET NULL`` là où la trace doit survivre (``auth_audit.user_id``) ou
  la référence être simplement oubliée (``auth_refresh_token.replaced_by``,
  ``user_texture.texture_id``).
* **Types portables** : ``sa.Uuid`` devient ``uuid`` sur PostgreSQL et
  ``char(32)`` ailleurs ; ``JSON`` devient ``jsonb`` sur PostgreSQL. La migration
  reste ainsi applicable sur le SQLite de développement.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

logger = logging.getLogger("alembic.migration.0001_launcher_auth")

# Identifiants de révision, utilisés par Alembic.
revision: str = "0001_launcher_auth"

#: Révision courante de l'historique Alembic **du site**, lue dans
#: l'environnement (voir l'en-tête du module). Vide sur une base neuve.
REVISION_DU_SITE: str = os.environ.get("OPM_SITE_ALEMBIC_REVISION", "").strip()

down_revision: str | None = REVISION_DU_SITE or None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: Tables présentes sur la base du site et **absentes** de nos modèles : leur
#: présence est la signature d'une vraie base de production. Une base de
#: développement fabriquée par ``init_models(with_site_tables=True)`` possède
#: ``users`` et ``statistiques``, mais jamais celles-ci.
TABLES_SIGNATURE_DU_SITE: frozenset[str] = frozenset(
    {"combats", "produits", "equipe", "securite", "contact"}
)


# ---------------------------------------------------------------------------
# Types portables PostgreSQL / SQLite
# ---------------------------------------------------------------------------
#: ``jsonb`` sur PostgreSQL, ``json`` (texte) sur les autres moteurs.
JSON_PORTABLE = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")
#: ``bigserial`` sur PostgreSQL ; SQLite exige un ``INTEGER`` pour l'auto-incrément.
BIGINT_PORTABLE = sa.BigInteger().with_variant(sa.Integer(), "sqlite")
#: ``uuid`` natif sur PostgreSQL, ``char(32)`` ailleurs ; manipulé comme une chaîne.
UUID_PORTABLE = sa.Uuid(as_uuid=False)

#: Les douze tables créées par cette migration, dans l'ordre de création.
TABLES_LAUNCHER: tuple[str, ...] = (
    "auth_mc_link",
    "auth_refresh_token",
    "auth_totp",
    "auth_recovery_code",
    "auth_password_reset",
    "auth_ban",
    "auth_audit",
    "ygg_session",
    "ygg_join",
    "texture",
    "user_texture",
    "launcher_instance",
)


# ---------------------------------------------------------------------------
# Contrôles préalables
# ---------------------------------------------------------------------------
def _controles_prealables() -> None:
    """Vérifie que la base est en état de recevoir les douze tables.

    Une migration de production doit refuser de s'exécuter au mauvais endroit
    plutôt que de laisser un demi-schéma derrière elle — mais elle ne doit pas
    pour autant interdire une base neuve de développement ou d'intégration
    continue, où le site n'existe pas.

    Quatre contrôles, dans cet ordre :

    1. **``users`` absente.** Sur SQLite (développement, tests), c'est normal :
       simple avertissement, la migration continue. Sur PostgreSQL, refus — non
       par principe, mais parce que ``CREATE TABLE … REFERENCES users(id)``
       échouerait de toute façon sur ``relation « users » does not exist``, et
       qu'un message clair vaut mieux qu'une erreur du moteur.
    2. **``users.id`` non entier.** Refus : toutes nos clés étrangères sont des
       ``integer`` (``docs/DATA.md`` §1).
    3. **Chaînage de l'historique.** Sur la base du site, avec la table de
       versions du site, ``down_revision`` ne peut pas rester vide : notre
       révision écraserait l'historique du site.
    4. **Tables déjà présentes.** Refus : la migration a déjà été appliquée.

    Les contrôles sont ignorés en mode hors ligne (``--sql``), où aucune
    connexion n'est ouverte.
    """
    if context.is_offline_mode():
        return

    liaison = op.get_bind()
    dialecte = liaison.dialect.name
    inspecteur = sa.inspect(liaison)
    tables = set(inspecteur.get_table_names())

    # -- 1 et 2. La cible des clés étrangères ---------------------------------
    if "users" in tables:
        colonnes = {colonne["name"]: colonne for colonne in inspecteur.get_columns("users")}
        if "id" not in colonnes:
            raise RuntimeError("La table « users » n'a pas de colonne « id » : base inattendue.")
        if not isinstance(colonnes["id"]["type"], sa.Integer):
            raise RuntimeError(
                "« users.id » n'est pas un entier ({type}). Toutes les clés étrangères de "
                "cette migration sont des integer : arrêt avant toute création de "
                "table.".format(type=colonnes["id"]["type"])
            )
    elif dialecte == "sqlite":
        # SQLite n'exige pas que la table référencée existe au moment du CREATE :
        # la migration s'applique donc telle quelle sur une base de développement.
        logger.warning(
            "Table « users » absente : base neuve (SQLite). Les clés étrangères vers "
            "users.id sont créées sans cible ; c'est le cas prévu du développement et de "
            "l'intégration continue. Utilisez « opm-auth initdb » si vous voulez aussi une "
            "réplique jetable des tables du site."
        )
    else:
        raise RuntimeError(
            "Table « users » introuvable sur une base "
            f"{dialecte} : les douze tables du launcher déclarent des clés étrangères vers "
            "users(id), que le moteur refusera de créer sans cette table. Visez la base du "
            "site (OPM_DATABASE_URL), ou développez sur SQLite, où cette migration "
            "s'applique sur une base vide."
        )

    # -- 3. Chaînage à l'historique du site -----------------------------------
    table_versions = getattr(context.get_context(), "version_table", "alembic_version")
    base_du_site = bool(TABLES_SIGNATURE_DU_SITE & tables)
    if base_du_site and down_revision is None and table_versions == "alembic_version":
        raise RuntimeError(
            "Cette base est celle du site (tables "
            + ", ".join(sorted(TABLES_SIGNATURE_DU_SITE & tables))
            + ") et l'historique Alembic est partagé, mais « down_revision » est vide : "
            "la migration s'inscrirait comme première révision et casserait l'historique du "
            "site. Exportez OPM_SITE_ALEMBIC_REVISION avec le résultat de « SELECT "
            "version_num FROM alembic_version; », ou donnez à nos migrations leur propre "
            "table de versions (migrations/README.md §5). Aucune table n'a été touchée."
        )

    # -- 4. Migration déjà appliquée ? ----------------------------------------
    deja_presentes = sorted(set(TABLES_LAUNCHER) & tables)
    if deja_presentes:
        raise RuntimeError(
            "Ces tables du launcher existent déjà : "
            + ", ".join(deja_presentes)
            + ". La migration a probablement déjà été appliquée (vérifiez « SELECT "
            + f"version_num FROM {table_versions}; ») ; aucune table n'a été touchée."
        )


# ---------------------------------------------------------------------------
# upgrade
# ---------------------------------------------------------------------------
def upgrade() -> None:
    """Crée les douze tables du launcher, leurs contraintes et leurs index."""
    _controles_prealables()

    # -- 1. Identité Minecraft ---------------------------------------------
    # Cœur du rattachement : une ligne par compte OPM au plus. L'UUID stocké est
    # l'UUID *premium réel* renvoyé par Microsoft (sans tirets), jamais un UUID
    # généré : mondes, permissions, économie et bans du serveur sont indexés
    # dessus. Un compte Minecraft ne peut être rattaché qu'à un seul compte OPM.
    op.create_table(
        "auth_mc_link",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        # Identifiant Microsoft stable (claim « sub » ou XUID).
        sa.Column("msa_sub", sa.String(length=64), nullable=False),
        sa.Column("minecraft_uuid", sa.CHAR(length=32), nullable=False),
        sa.Column("minecraft_username", sa.String(length=16), nullable=False),
        sa.Column(
            "owns_minecraft", sa.Boolean(), server_default=sa.false(), nullable=False
        ),
        sa.Column("verified_at", sa.DateTime(), nullable=False),
        # verified_at + OPM_OWNERSHIP_TTL_DAYS (30 j par défaut) : tant que cette
        # date n'est pas dépassée, une panne de Microsoft n'empêche pas de jouer.
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        # Jeton de renouvellement Microsoft chiffré (AES-256-GCM) + son nonce.
        sa.Column("msa_refresh_enc", sa.LargeBinary(), nullable=True),
        sa.Column("msa_refresh_nonce", sa.LargeBinary(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_auth_mc_link"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_auth_mc_link_user_id_users",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("user_id", name="uq_auth_mc_link_user_id"),
        sa.UniqueConstraint("msa_sub", name="uq_auth_mc_link_msa_sub"),
        sa.UniqueConstraint("minecraft_uuid", name="uq_auth_mc_link_minecraft_uuid"),
    )

    # -- 2. Sessions du launcher -------------------------------------------
    # Jeton opaque remis au launcher, stocké haché (SHA-256 hexadécimal, 64
    # caractères). « family_id » permet de révoquer toute une lignée de jetons
    # d'un coup lorsqu'un rejeu est détecté.
    op.create_table(
        "auth_refresh_token",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("token_hash", sa.CHAR(length=64), nullable=False),
        sa.Column("family_id", UUID_PORTABLE, nullable=False),
        sa.Column("device_label", sa.String(length=120), nullable=True),
        sa.Column("issued_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.Column("replaced_by", sa.Integer(), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_auth_refresh_token"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_auth_refresh_token_user_id_users",
            ondelete="CASCADE",
        ),
        # Auto-référence : le jeton qui a succédé à celui-ci lors d'une rotation.
        # « SET NULL » pour qu'une purge des jetons expirés ne bute pas sur la
        # contrainte ; la chaîne de rotation est un confort d'audit, pas une donnée
        # dont dépend l'authentification.
        sa.ForeignKeyConstraint(
            ["replaced_by"],
            ["auth_refresh_token.id"],
            name="fk_auth_refresh_token_replaced_by_auth_refresh_token",
            ondelete="SET NULL",
        ),
        sa.UniqueConstraint("token_hash", name="uq_auth_refresh_token_token_hash"),
    )
    # Index de la requête la plus fréquente : « les sessions vivantes de ce compte ».
    op.create_index("idx_auth_refresh_user", "auth_refresh_token", ["user_id", "revoked_at"])

    # -- 3. Double authentification ----------------------------------------
    # Table séparée : activer la 2FA ne doit jamais imposer d'ALTER sur « users ».
    # La clé primaire est user_id (une configuration TOTP par compte).
    op.create_table(
        "auth_totp",
        sa.Column("user_id", sa.Integer(), nullable=False),
        # Secret TOTP chiffré au repos (AES-256-GCM) et son nonce.
        sa.Column("secret_enc", sa.LargeBinary(), nullable=False),
        sa.Column("nonce", sa.LargeBinary(), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("confirmed_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("user_id", name="pk_auth_totp"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_auth_totp_user_id_users",
            ondelete="CASCADE",
        ),
    )

    # Codes de secours de la 2FA : hachés comme des mots de passe, à usage unique.
    op.create_table(
        "auth_recovery_code",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("code_hash", sa.String(length=255), nullable=False),
        sa.Column("used_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_auth_recovery_code"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_auth_recovery_code_user_id_users",
            ondelete="CASCADE",
        ),
    )

    # -- 4. Réinitialisation de mot de passe --------------------------------
    op.create_table(
        "auth_password_reset",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("token_hash", sa.CHAR(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("used_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_auth_password_reset"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_auth_password_reset_user_id_users",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("token_hash", name="uq_auth_password_reset_token_hash"),
    )

    # -- 5. Modération -------------------------------------------------------
    # « until » à NULL signifie « définitif ».
    op.create_table(
        "auth_ban",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("until", sa.DateTime(), nullable=True),
        sa.Column("created_by", sa.String(length=80), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_auth_ban"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_auth_ban_user_id_users",
            ondelete="CASCADE",
        ),
    )

    # -- 6. Journal d'audit --------------------------------------------------
    # Le journal survit à la suppression d'un compte : la clé passe à NULL.
    # « ip_hash » : jamais l'adresse en clair, seulement son empreinte salée.
    op.create_table(
        "auth_audit",
        sa.Column("id", BIGINT_PORTABLE, autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("action", sa.String(length=60), nullable=False),
        sa.Column("ip_hash", sa.CHAR(length=64), nullable=True),
        sa.Column("user_agent", sa.String(length=255), nullable=True),
        sa.Column("meta", JSON_PORTABLE, nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_auth_audit"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_auth_audit_user_id_users",
            ondelete="SET NULL",
        ),
    )
    # « les dernières actions de ce compte » : l'ordre décroissant est dans l'index.
    op.create_index(
        "idx_auth_audit_user",
        "auth_audit",
        ["user_id", sa.text("created_at DESC")],
    )

    # -- 7. Yggdrasil : les sessions de jeu que nous signons ------------------
    # « access_token » stocke le SHA-256 du JWT émis, jamais le jeton lui-même.
    op.create_table(
        "ygg_session",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("access_token", sa.CHAR(length=64), nullable=False),
        sa.Column("client_token", sa.String(length=64), nullable=False),
        sa.Column("issued_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("invalidated_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_ygg_session"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_ygg_session_user_id_users",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("access_token", name="uq_ygg_session_access_token"),
    )

    # Trace éphémère du « join » : le serveur Minecraft la consomme dans les
    # secondes qui suivent (TTL 30 s), une tâche de fond purge le reste.
    op.create_table(
        "ygg_join",
        sa.Column("server_id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("ip", sa.String(length=45), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("server_id", name="pk_ygg_join"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_ygg_join_user_id_users",
            ondelete="CASCADE",
        ),
    )

    # -- 8. Textures : skins et capes, adressés par leur contenu --------------
    # Deux joueurs au même skin ne stockent qu'un seul fichier « <sha256>.png ».
    op.create_table(
        "texture",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("sha256", sa.CHAR(length=64), nullable=False),
        sa.Column("kind", sa.String(length=8), nullable=False),  # skin | cape
        sa.Column(
            "model", sa.String(length=8), server_default="classic", nullable=False
        ),  # classic | slim
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("bytes", sa.Integer(), nullable=False),
        # source : upload | mojang_import | default
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_texture"),
        sa.UniqueConstraint("sha256", name="uq_texture_sha256"),
    )

    # Texture active d'un joueur pour un type donné. « texture_id » à NULL
    # signifie « skin par défaut » : d'où le SET NULL plutôt qu'un CASCADE.
    op.create_table(
        "user_texture",
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=8), nullable=False),
        sa.Column("texture_id", sa.Integer(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("user_id", "kind", name="pk_user_texture"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_user_texture_user_id_users",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["texture_id"],
            ["texture.id"],
            name="fk_user_texture_texture_id_texture",
            ondelete="SET NULL",
        ),
    )

    # -- 9. Profils de jeu ----------------------------------------------------
    # Remplace l'URL de distribution figée de l'ancien launcher : les instances
    # sont désormais administrables en base.
    op.create_table(
        "launcher_instance",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(length=60), nullable=False),
        sa.Column("display_name", sa.String(length=80), nullable=False),
        sa.Column("url", sa.String(length=255), nullable=False),
        sa.Column("version", sa.String(length=20), nullable=False),
        sa.Column("loader_type", sa.String(length=20), server_default="none", nullable=False),
        sa.Column("loader_version", sa.String(length=40), nullable=True),
        sa.Column("verify", sa.Boolean(), server_default=sa.true(), nullable=False),
        # Le littéral « '[]' » est volontairement sans cast explicite : PostgreSQL
        # le convertit en jsonb, et l'expression reste valable sur SQLite.
        sa.Column("ignored", JSON_PORTABLE, server_default=sa.text("'[]'"), nullable=False),
        sa.Column(
            "whitelist_active", sa.Boolean(), server_default=sa.false(), nullable=False
        ),
        sa.Column("whitelist", JSON_PORTABLE, server_default=sa.text("'[]'"), nullable=False),
        sa.Column("status_host", sa.String(length=120), nullable=True),
        sa.Column("status_port", sa.Integer(), server_default=sa.text("25565"), nullable=True),
        sa.Column("sort_order", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_launcher_instance"),
        sa.UniqueConstraint("name", name="uq_launcher_instance_name"),
    )


# ---------------------------------------------------------------------------
# downgrade
# ---------------------------------------------------------------------------
def downgrade() -> None:
    """Supprime les douze tables du launcher, dans l'ordre inverse des dépendances.

    Le site retrouve exactement son schéma d'origine. Les données du launcher
    (rattachements Microsoft, sessions, textures, journal d'audit) sont perdues :
    c'est le prix d'un retour arrière, et c'est pourquoi le README impose une
    sauvegarde ``pg_dump`` avant l'``upgrade``.
    """
    op.drop_table("launcher_instance")
    op.drop_table("user_texture")
    op.drop_table("texture")
    op.drop_table("ygg_join")
    op.drop_table("ygg_session")
    op.drop_index("idx_auth_audit_user", table_name="auth_audit")
    op.drop_table("auth_audit")
    op.drop_table("auth_ban")
    op.drop_table("auth_password_reset")
    op.drop_table("auth_recovery_code")
    op.drop_table("auth_totp")
    op.drop_index("idx_auth_refresh_user", table_name="auth_refresh_token")
    op.drop_table("auth_refresh_token")
    op.drop_table("auth_mc_link")
