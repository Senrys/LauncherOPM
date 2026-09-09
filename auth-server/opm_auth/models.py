"""Modèles SQLAlchemy 2.0 du serveur d'authentification One Piece Minecraft.

Ce module décrit **deux familles de tables** qu'il ne faut jamais confondre :

1. **Les tables du site** (``users``, ``article``, ``statistiques``, ``equipages``,
   ``iles``). Elles appartiennent au site Flask, qui les a créées et les fait
   évoluer avec ses propres migrations Alembic. Nous les *mappons* pour les lire
   — et pour écrire les trois seules colonnes que ``docs/DATA.md`` §4 nous
   autorise (``users.derniereconnexion``, ``users.tempsdejeu`` et la ligne unique
   de ``statistiques``). Elles ne doivent **jamais** être créées, altérées ni
   supprimées par notre code.
2. **Les tables du launcher** (préfixes ``auth_``, ``ygg_``, ``launcher_``).
   Ce sont les onze tables additives de ``docs/DATA.md`` §2, plus ``user_texture``.
   Elles seules sont créées par notre migration Alembic et par
   :func:`opm_auth.db.init_models`.

La séparation n'est pas qu'un commentaire : :data:`SITE_TABLES` et
:data:`LAUNCHER_TABLES` sont deux listes explicites, contrôlées à l'import
(:func:`_check_table_ownership`), et ``init_models()`` ne reçoit que la seconde.
Créer ``users`` ou ``statistiques`` par mégarde en développement serait une faute
grave : ce garde-fou existe pour la rendre impossible.

Conventions :

* ``users.id`` est un **entier** (``serial``) : toutes les clés étrangères du
  launcher sont des ``integer``, jamais des UUID ;
* l'UUID de profil Minecraft est l'**UUID premium réel** renvoyé par Microsoft,
  stocké sans tirets (``char(32)``) dans :class:`McLink` ;
* les horodatages sont des ``timestamp without time zone`` (comme dans le dump du
  site) mais toujours manipulés en UTC côté Python, grâce à :class:`UTCTimestamp` ;
* aucun secret en clair : les jetons sont hachés (SHA-256) ou chiffrés (AES-256-GCM).
"""

from __future__ import annotations

import enum
import hashlib
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    CHAR,
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Table,
    Text,
    Uuid,
    false,
    func,
    text,
    true,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import TypeDecorator

from opm_auth.db import Base

__all__ = [
    "LAUNCHER_TABLES",
    "SITE_TABLES",
    "STATS_ROW_ID",
    "Article",
    "Audit",
    "AuditAction",
    "Ban",
    "BlockedReason",
    "Equipage",
    "Ile",
    "Instance",
    "LoaderType",
    "McLink",
    "PasswordReset",
    "RecoveryCode",
    "RefreshToken",
    "Statistiques",
    "Texture",
    "TextureKind",
    "TextureModel",
    "TextureSource",
    "Totp",
    "User",
    "UserRole",
    "UserTexture",
    "UTCTimestamp",
    "YggJoin",
    "YggSession",
    "new_family_id",
    "offline_profile_uuid",
    "sha256_hex",
    "utcnow",
]


# ═══════════════════════════════════════════════════════════════════════════
#   OUTILS COMMUNS
# ═══════════════════════════════════════════════════════════════════════════
class UTCTimestamp(TypeDecorator[datetime]):
    """``timestamp without time zone`` en base, ``datetime`` UTC conscient en Python.

    Le site stocke ses dates sans fuseau (c'est ce que fait Flask-SQLAlchemy avec
    ``datetime.utcnow``) ; nos tables font pareil pour rester homogènes avec le
    dump. Ce décorateur garantit que, côté Python, on ne manipule **que** des
    instants conscients en UTC : une date lue revient avec ``tzinfo=UTC`` et une
    date écrite est convertie en UTC avant d'être dépouillée de son fuseau.
    Sans lui, toute comparaison avec :func:`utcnow` lèverait un ``TypeError``.
    """

    impl = DateTime(timezone=False)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Any) -> datetime | None:
        """Python → base : ramène l'instant en UTC puis retire le fuseau."""
        if value is None:
            return None
        if value.tzinfo is not None:
            value = value.astimezone(UTC).replace(tzinfo=None)
        return value

    def process_result_value(self, value: datetime | None, dialect: Any) -> datetime | None:
        """Base → Python : la date naïve lue est déclarée UTC."""
        if value is None:
            return None
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


#: Instance unique réutilisée par toutes les colonnes d'horodatage.
TS = UTCTimestamp()

#: ``jsonb`` sur PostgreSQL, ``json`` ailleurs (SQLite en développement).
JSONB_OR_JSON = JSON().with_variant(JSONB, "postgresql")

#: ``bigserial`` sur PostgreSQL ; SQLite n'auto-incrémente que sur ``INTEGER``.
BIGINT_PK = BigInteger().with_variant(Integer, "sqlite")

#: La table ``statistiques`` n'a qu'une seule ligne, d'identifiant 1.
STATS_ROW_ID = 1


def utcnow() -> datetime:
    """Instant présent en UTC, avec fuseau explicite."""
    return datetime.now(UTC)


def sha256_hex(value: str) -> str:
    """Empreinte SHA-256 hexadécimale, utilisée pour stocker les jetons opaques."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def new_family_id() -> uuid.UUID:
    """Identifiant de famille d'un jeton de renouvellement (détection de rejeu)."""
    return uuid.uuid4()


def offline_profile_uuid(username: str) -> str:
    """UUID « hors ligne » dérivé du pseudo, exactement comme le fait Mojang.

    Reproduit ``UUID.nameUUIDFromBytes("OfflinePlayer:<pseudo>")`` : MD5 des
    octets, puis pose des bits de version 3 et de variante RFC 4122.

    **Jamais utilisé en mode hybride** : ``docs/DATA.md`` §8 impose l'UUID premium
    réel (:attr:`McLink.minecraft_uuid`) pour ne perdre ni progression, ni claims,
    ni permissions. Cette fonction n'a de sens qu'en mode ``sovereign``, où aucun
    compte Microsoft n'est rattaché. MD5 sert ici de dérivation d'identifiant, pas
    de primitive de sécurité.
    """
    digest = bytearray(
        hashlib.md5(f"OfflinePlayer:{username}".encode(), usedforsecurity=False).digest()
    )
    digest[6] = (digest[6] & 0x0F) | 0x30  # version 3
    digest[8] = (digest[8] & 0x3F) | 0x80  # variante RFC 4122
    return uuid.UUID(bytes=bytes(digest)).hex


# ═══════════════════════════════════════════════════════════════════════════
#   ÉNUMÉRATIONS (valeurs, pas types SQL : les colonnes restent des varchar)
# ═══════════════════════════════════════════════════════════════════════════
class UserRole(enum.StrEnum):
    """Rôle applicatif d'un compte.

    La table ``users`` du site **ne porte aucune colonne de rôle** : le launcher
    considère donc tout le monde comme joueur (voir :attr:`User.role`).
    L'énumération reste ici parce que le contrat d'API expose le champ ``role``
    et que la modération s'appuiera dessus le jour où une source existera.
    """

    PLAYER = "player"
    VIP = "vip"
    MODERATOR = "moderator"
    ADMIN = "admin"


class BlockedReason(enum.StrEnum):
    """Motifs d'interdiction de jeu (champ ``blocked_reason`` de ``docs/API.md`` §1.2)."""

    MICROSOFT_REQUIRED = "microsoft_required"
    MICROSOFT_EXPIRED = "microsoft_expired"
    OWNERSHIP_MISSING = "ownership_missing"
    BANNED = "banned"
    EMAIL_UNVERIFIED = "email_unverified"


class TextureKind(enum.StrEnum):
    """Nature d'une texture de profil (colonne ``kind``, ``varchar(8)``)."""

    SKIN = "skin"
    CAPE = "cape"


class TextureModel(enum.StrEnum):
    """Modèle de bras d'un skin (colonne ``model``, ``varchar(8)``)."""

    CLASSIC = "classic"
    SLIM = "slim"


class TextureSource(enum.StrEnum):
    """Provenance d'une texture (colonne ``source``, ``varchar(16)``)."""

    UPLOAD = "upload"
    MOJANG_IMPORT = "mojang_import"
    DEFAULT = "default"


class LoaderType(enum.StrEnum):
    """Chargeur de mods d'une instance (colonne ``loader_type``, ``varchar(20)``)."""

    NONE = "none"
    FORGE = "forge"
    NEOFORGE = "neoforge"
    FABRIC = "fabric"
    QUILT = "quilt"
    LEGACYFABRIC = "legacyfabric"


class AuditAction(enum.StrEnum):
    """Actions consignées dans ``auth_audit.action`` (``varchar(60)``)."""

    REGISTER = "register"
    LOGIN = "login"
    LOGIN_FAILED = "login_failed"
    LOGOUT = "logout"
    TOKEN_REFRESH = "token_refresh"
    TOKEN_REPLAY = "token_replay"
    PASSWORD_FORGOT = "password_forgot"
    PASSWORD_RESET = "password_reset"
    PASSWORD_REHASH = "password_rehash"
    TOTP_SETUP = "totp_setup"
    TOTP_ENABLE = "totp_enable"
    TOTP_DISABLE = "totp_disable"
    RECOVERY_CODE_USED = "recovery_code_used"
    MICROSOFT_LINK = "microsoft_link"
    MICROSOFT_UNLINK = "microsoft_unlink"
    MICROSOFT_VERIFY = "microsoft_verify"
    MICROSOFT_VERIFY_FAILED = "microsoft_verify_failed"
    GAME_SESSION = "game_session"
    GAME_SESSION_END = "game_session_end"
    YGG_AUTHENTICATE = "ygg_authenticate"
    YGG_JOIN = "ygg_join"
    TEXTURE_UPLOAD = "texture_upload"
    TEXTURE_DELETE = "texture_delete"
    BAN = "ban"
    UNBAN = "unban"


# ╔═════════════════════════════════════════════════════════════════════════╗
# ║                                                                         ║
# ║   SECTION 1 — TABLES DU SITE                                            ║
# ║                                                                         ║
# ║   Propriétaire : le site Flask (dépôt du site, migrations Alembic du     ║
# ║   site). Fidèles au dump `reference/opm-site-schema.sql`.                ║
# ║                                                                         ║
# ║   NE JAMAIS CRÉER, ALTÉRER NI SUPPRIMER CES TABLES DEPUIS CE PROJET.     ║
# ║   Elles sont exclues de `init_models()` et de notre migration Alembic.   ║
# ║   Écritures autorisées (docs/DATA.md §4), et rien d'autre :              ║
# ║     • users.derniereconnexion  — à la connexion ;                        ║
# ║     • users.tempsdejeu         — += durée, en fin de session de jeu ;    ║
# ║     • statistiques.joueurs_en_ligne / record_joueurs / record_date       ║
# ║       — par UNE instruction atomique, jamais lire-puis-écrire.           ║
# ║   Les colonnes RP (prime, berry, niveau*, faction, equipage…) sont en    ║
# ║   LECTURE SEULE : elles appartiennent au serveur Minecraft et au site.   ║
# ║                                                                         ║
# ╚═════════════════════════════════════════════════════════════════════════╝
class User(Base):
    """Compte du site — **et** compte du launcher : il n'y en a qu'un seul.

    Table ``users`` du site. Un compte créé depuis le launcher se connecte au
    site, et réciproquement (``docs/DATA.md`` §3). C'est la raison pour laquelle
    ``password_hash`` reste au **format Werkzeug** (``pbkdf2:sha256:<iter>$sel$hex``)
    et non en Argon2id : le site doit continuer de savoir vérifier le mot de passe.

    Cette table n'a ni UUID Minecraft, ni rattachement Microsoft, ni skin, ni 2FA :
    tout cela vit dans les tables du launcher de la section 2.
    """

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    # -- identité --------------------------------------------------------------
    #: Pseudo affiché **dans le launcher et sur le site**. Le pseudo affiché
    #: **en jeu** est McLink.minecraft_username (docs/DATA.md §8).
    name: Mapped[str] = mapped_column(String(50), nullable=False, unique=True)
    email: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    #: Empreinte Werkzeug. Écriture en pbkdf2:sha256:600000, lecture tolérante
    #: (voir security/passwords.py). Jamais d'Argon2id ici.
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    datejoin: Mapped[datetime | None] = mapped_column(TS, nullable=True)

    # -- fiche de personnage (LECTURE SEULE pour le launcher) -------------------
    age: Mapped[int | None] = mapped_column(Integer, nullable=True)
    genre: Mapped[str] = mapped_column(String(50), nullable=False)
    provenance: Mapped[str] = mapped_column(String(50), nullable=False)
    faction: Mapped[str] = mapped_column(String(50), nullable=False)
    race: Mapped[str] = mapped_column(String(50), nullable=False)
    specialisation: Mapped[str] = mapped_column(String(50), nullable=False)
    equipage: Mapped[str] = mapped_column(String(120), nullable=False)
    territoires: Mapped[str] = mapped_column(String(120), nullable=False)
    prime: Mapped[int | None] = mapped_column(Integer, nullable=True)
    berry: Mapped[int | None] = mapped_column(Integer, nullable=True)
    metier: Mapped[str] = mapped_column(String(50), nullable=False)
    niveaubase: Mapped[int] = mapped_column(Integer, nullable=False)
    niveauhaki: Mapped[int | None] = mapped_column(Integer, nullable=True)
    niveaufdd: Mapped[int | None] = mapped_column(Integer, nullable=True)
    nomfdd: Mapped[str] = mapped_column(String(50), nullable=False)
    niveaumetier: Mapped[int] = mapped_column(Integer, nullable=False)
    niveaucrochetage: Mapped[int] = mapped_column(Integer, nullable=False)
    niveauminage: Mapped[int] = mapped_column(Integer, nullable=False)
    niveaubuchage: Mapped[int] = mapped_column(Integer, nullable=False)
    niveaucueillette: Mapped[int] = mapped_column(Integer, nullable=False)
    niveauchasse: Mapped[int] = mapped_column(Integer, nullable=False)
    niveaupeche: Mapped[int] = mapped_column(Integer, nullable=False)
    gigot: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tokenpaiement: Mapped[str | None] = mapped_column(String(50), nullable=True)

    # -- les deux seules colonnes que le launcher met à jour --------------------
    #: Temps de jeu cumulé, en secondes. Incrémenté en fin de session de jeu.
    tempsdejeu: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    #: Horodatage de la dernière connexion, écrit à chaque login réussi.
    derniereconnexion: Mapped[datetime | None] = mapped_column(TS, nullable=True)

    # -- réputation et palmarès (LECTURE SEULE) ---------------------------------
    role_equipage: Mapped[str] = mapped_column(
        String(50), nullable=False, default="", server_default=text("''")
    )
    titres: Mapped[str] = mapped_column(
        Text, nullable=False, default="", server_default=text("''")
    )
    victoires_pvp: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    defaites_pvp: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    serie_victoires: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    reputation_pirate: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    reputation_marine: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    reputation_civil: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    votes_mois: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )

    # -- relations vers les tables du launcher ---------------------------------
    # Les clés étrangères sont toutes du côté launcher : la table `users` du site
    # n'est modifiée en rien par ces relations.
    mc_link: Mapped[McLink | None] = relationship(
        back_populates="user", uselist=False, passive_deletes=True, lazy="selectin"
    )
    totp: Mapped[Totp | None] = relationship(
        back_populates="user", uselist=False, passive_deletes=True, lazy="selectin"
    )
    bans: Mapped[list[Ban]] = relationship(
        back_populates="user", passive_deletes=True, lazy="selectin"
    )
    textures: Mapped[list[UserTexture]] = relationship(
        back_populates="user", passive_deletes=True, lazy="selectin"
    )
    refresh_tokens: Mapped[list[RefreshToken]] = relationship(
        back_populates="user", passive_deletes=True, lazy="raise"
    )
    ygg_sessions: Mapped[list[YggSession]] = relationship(
        back_populates="user", passive_deletes=True, lazy="raise"
    )
    ygg_joins: Mapped[list[YggJoin]] = relationship(
        back_populates="user", passive_deletes=True, lazy="raise"
    )
    password_resets: Mapped[list[PasswordReset]] = relationship(
        back_populates="user", passive_deletes=True, lazy="raise"
    )
    recovery_codes: Mapped[list[RecoveryCode]] = relationship(
        back_populates="user", passive_deletes=True, lazy="raise"
    )
    audits: Mapped[list[Audit]] = relationship(
        back_populates="user", passive_deletes=True, lazy="raise"
    )

    # -- confort ---------------------------------------------------------------
    @property
    def username(self) -> str:
        """Alias de **lecture** de :attr:`name` (le contrat d'API dit ``username``).

        Volontairement en lecture seule : toute écriture doit passer par ``name``,
        qui est le nom réel de la colonne du site.
        """
        return self.name

    @property
    def role(self) -> str:
        """Rôle applicatif — toujours le plus faible, faute de source.

        La table ``users`` du site n'a pas de colonne de rôle. Renvoyer
        ``player`` est un choix *fail-closed* : aucune élévation de privilège ne
        peut naître d'une donnée absente. Une éventuelle liste d'administrateurs
        se règlera par la configuration, côté service, jamais ici.
        """
        return UserRole.PLAYER.value

    @property
    def totp_enabled(self) -> bool:
        """La double authentification est-elle active sur ce compte ?"""
        return self.totp is not None and self.totp.enabled

    def active_ban(self, now: datetime | None = None) -> Ban | None:
        """Renvoie la sanction en cours, ou ``None``."""
        moment = now or utcnow()
        for ban in self.bans:
            if ban.is_active(moment):
                return ban
        return None

    def active_texture(self, kind: str = TextureKind.SKIN.value) -> UserTexture | None:
        """Association ``user_texture`` du type demandé (``skin`` ou ``cape``)."""
        for link in self.textures:
            if link.kind == kind:
                return link
        return None

    def blocked_reason(
        self,
        *,
        microsoft_required: bool,
        now: datetime | None = None,
    ) -> str | None:
        """Motif empêchant de jouer, ou ``None`` si le joueur peut lancer le jeu.

        Les règles dépendant de la configuration sont passées en paramètres : les
        modèles restent ainsi indépendants de ``config.py``. L'ordre des tests est
        celui qu'attend l'interface du launcher.

        À noter : ``email_unverified`` n'est **jamais** renvoyé ici. La base du
        site ne porte aucune colonne de vérification d'adresse ; si cette règle
        est un jour activée, c'est la couche service qui devra la faire respecter,
        avec une source de vérité réelle.
        """
        moment = now or utcnow()

        if self.active_ban(moment) is not None:
            return BlockedReason.BANNED.value
        if microsoft_required:
            link = self.mc_link
            if link is None:
                return BlockedReason.MICROSOFT_REQUIRED.value
            if not link.owns_minecraft:
                return BlockedReason.OWNERSHIP_MISSING.value
            if link.is_expired(moment):
                return BlockedReason.MICROSOFT_EXPIRED.value
        return None

    def can_play(self, *, microsoft_required: bool, now: datetime | None = None) -> bool:
        """Valeur que le launcher regarde pour activer le bouton JOUER."""
        return self.blocked_reason(microsoft_required=microsoft_required, now=now) is None


class Article(Base):
    """Table ``article`` du site — le **JOURNAL DE BORD** du launcher.

    ``categorie`` est un ``varchar(50)`` libre : le launcher en dérive le ``kind``
    de l'API (``news`` / ``event`` / ``update``) et la couleur de l'étiquette.
    Ajouter une catégorie ne demande donc aucune migration.
    """

    __tablename__ = "article"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    published_date: Mapped[datetime | None] = mapped_column(TS, nullable=True)
    url: Mapped[str | None] = mapped_column(String(155), nullable=True)
    image: Mapped[str | None] = mapped_column(String(255), nullable=True)
    categorie: Mapped[str] = mapped_column(
        String(50), nullable=False, default="Actualité", server_default=text("'Actualité'")
    )
    auteur: Mapped[str] = mapped_column(
        String(50), nullable=False, default="Mélodia", server_default=text("'Mélodia'")
    )


class Statistiques(Base):
    """Table ``statistiques`` du site — **une seule ligne**, d'identifiant :data:`STATS_ROW_ID`.

    Elle alimente presque tout l'accueil du launcher : fréquentation, record,
    prochain événement, votes du mois, cagnotte, adresse du serveur et URL de
    téléchargement du launcher par plateforme.

    Le site et le serveur d'auth pingent tous deux le serveur Minecraft. Nos trois
    seules écritures (``joueurs_en_ligne``, ``record_joueurs``, ``record_date``)
    doivent donc passer par **une instruction atomique** avec ``GREATEST`` et un
    ``CASE`` (``docs/DATA.md`` §4), jamais par un lire-puis-écrire ORM, qui
    perdrait un record en cas de course. Et si le ping échoue : on n'écrit rien.
    """

    __tablename__ = "statistiques"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    joueurs_en_ligne: Mapped[int] = mapped_column(Integer, nullable=False)
    record_joueurs: Mapped[int] = mapped_column(Integer, nullable=False)
    #: Date du record, stockée en texte libre par le site (``varchar(50)``).
    record_date: Mapped[str] = mapped_column(String(50), nullable=False)

    evenement_nom: Mapped[str] = mapped_column(String(150), nullable=False)
    evenement_date: Mapped[datetime | None] = mapped_column(TS, nullable=True)

    votes: Mapped[int] = mapped_column(Integer, nullable=False)
    votes_objectif: Mapped[int] = mapped_column(Integer, nullable=False)

    #: Cagnotte en euros entiers, telle que le site la tient. Aucune table de dons
    #: n'existe : le classement des donateurs n'a pas de source (docs/DATA.md §2).
    dons_collecte: Mapped[int] = mapped_column(Integer, nullable=False)
    dons_objectif: Mapped[int] = mapped_column(Integer, nullable=False)
    donateurs: Mapped[int] = mapped_column(Integer, nullable=False)

    server_ip: Mapped[str] = mapped_column(String(120), nullable=False)
    launcher_windows: Mapped[str] = mapped_column(String(255), nullable=False)
    launcher_mac: Mapped[str] = mapped_column(String(255), nullable=False)
    launcher_linux: Mapped[str] = mapped_column(String(255), nullable=False)


class Equipage(Base):
    """Table ``equipages`` du site — alimente le sous-titre du personnage."""

    __tablename__ = "equipages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    nom: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    reputation: Mapped[int] = mapped_column(Integer, nullable=False)
    membres: Mapped[int] = mapped_column(Integer, nullable=False)
    #: Texte libre côté site (résumé des îles) ; le compte réel se fait sur `iles`.
    iles: Mapped[str] = mapped_column(Text, nullable=False)
    caisse: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default=text("0")
    )
    fondation: Mapped[datetime | None] = mapped_column(TS, nullable=True)
    jolly_roger: Mapped[str] = mapped_column(
        String(255), nullable=False, default="", server_default=text("''")
    )
    devise: Mapped[str] = mapped_column(
        String(150), nullable=False, default="", server_default=text("''")
    )

    iles_tenues: Mapped[list[Ile]] = relationship(back_populates="equipage", lazy="raise")


class Ile(Base):
    """Table ``iles`` du site — le « 3 îles tenues » du sous-titre d'accueil."""

    __tablename__ = "iles"
    __table_args__ = (Index("idx_iles_equipage", "equipage_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    nom: Mapped[str] = mapped_column(String(120), nullable=False)
    equipage_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("equipages.id", ondelete="SET NULL"), nullable=True
    )
    detenteur: Mapped[str] = mapped_column(
        String(120), nullable=False, default="", server_default=text("''")
    )
    image: Mapped[str] = mapped_column(
        String(255), nullable=False, default="", server_default=text("''")
    )
    taxe_jour: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    detenue_depuis: Mapped[datetime | None] = mapped_column(TS, nullable=True)
    assauts_repousses: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    fortifications: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    niveau_murs: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    statut: Mapped[str] = mapped_column(
        String(40), nullable=False, default="Sous contrôle", server_default=text("'Sous contrôle'")
    )
    principale: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )

    equipage: Mapped[Equipage | None] = relationship(back_populates="iles_tenues", lazy="raise")


# ╔═════════════════════════════════════════════════════════════════════════╗
# ║                                                                         ║
# ║   SECTION 2 — TABLES DU LAUNCHER                                         ║
# ║                                                                         ║
# ║   Propriétaire : ce projet. Créées par notre migration Alembic additive  ║
# ║   (et par `init_models()` en développement), supprimées proprement par   ║
# ║   `alembic downgrade`. Le site continue de fonctionner sans rien savoir  ║
# ║   de leur existence.                                                     ║
# ║                                                                         ║
# ║   Le SQL de référence est `docs/DATA.md` §2 : colonnes, types, longueurs ║
# ║   et index sont repris à l'identique. Toutes les clés étrangères visent  ║
# ║   `users.id`, qui est un INTEGER.                                        ║
# ║                                                                         ║
# ╚═════════════════════════════════════════════════════════════════════════╝
class McLink(Base):
    """``auth_mc_link`` — identité Minecraft : le cœur du rattachement.

    Microsoft n'est qu'un **oracle de possession**, consulté une fois puis mis en
    cache 30 jours (``expires_at``). Tant que la vérification est valide, une panne
    de Microsoft n'empêche personne de jouer : c'est exactement ce qu'on achète
    avec la souveraineté.

    ``minecraft_uuid`` est l'**UUID premium réel**, sans tirets : mondes, LuckPerms,
    économie, claims, bans et statistiques du serveur sont déjà indexés dessus.
    Un compte Minecraft ne peut être rattaché qu'à un seul compte OPM (unicité sur
    ``msa_sub`` et ``minecraft_uuid``, sinon ``409 already_linked``).

    Le jeton de rafraîchissement Microsoft est chiffré au repos (AES-256-GCM,
    clé ``OPM_MSA_TOKEN_KEY``) : ``msa_refresh_enc`` porte le chiffré et le tag,
    ``msa_refresh_nonce`` le nonce. Il ne quitte jamais le serveur.
    """

    __tablename__ = "auth_mc_link"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True
    )

    msa_sub: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    minecraft_uuid: Mapped[str] = mapped_column(CHAR(32), nullable=False, unique=True)
    #: Pseudo affiché **en jeu**, resynchronisé à chaque re-vérification.
    minecraft_username: Mapped[str] = mapped_column(String(16), nullable=False)
    owns_minecraft: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    verified_at: Mapped[datetime] = mapped_column(TS, nullable=False, default=utcnow)
    #: ``verified_at + OPM_OWNERSHIP_TTL_DAYS`` (30 jours par défaut).
    expires_at: Mapped[datetime] = mapped_column(TS, nullable=False)

    msa_refresh_enc: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    msa_refresh_nonce: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        TS, nullable=False, default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        TS, nullable=False, default=utcnow, onupdate=utcnow, server_default=func.now()
    )

    user: Mapped[User] = relationship(back_populates="mc_link", lazy="raise")

    def is_expired(self, now: datetime | None = None) -> bool:
        """La vérification de possession doit-elle être refaite ?"""
        return (now or utcnow()) >= self.expires_at

    def is_valid(self, now: datetime | None = None) -> bool:
        """Possession confirmée et encore dans sa fenêtre de validité."""
        return self.owns_minecraft and not self.is_expired(now)


class RefreshToken(Base):
    """``auth_refresh_token`` — sessions du launcher, jetons opaques et rotatifs.

    Le jeton lui-même (64 octets aléatoires) n'est jamais stocké : seule son
    empreinte SHA-256 l'est (``token_hash``). À chaque usage, le jeton est
    remplacé : l'ancien reçoit ``revoked_at`` et ``replaced_by``. Présenter un
    jeton déjà remplacé ou révoqué trahit un vol — le service doit alors révoquer
    **toute la famille** ``family_id``.
    """

    __tablename__ = "auth_refresh_token"
    __table_args__ = (Index("idx_auth_refresh_user", "user_id", "revoked_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )

    token_hash: Mapped[str] = mapped_column(CHAR(64), nullable=False, unique=True)
    family_id: Mapped[uuid.UUID] = mapped_column(Uuid(), nullable=False, default=new_family_id)
    device_label: Mapped[str | None] = mapped_column(String(120), nullable=True)

    issued_at: Mapped[datetime] = mapped_column(
        TS, nullable=False, default=utcnow, server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)
    replaced_by: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("auth_refresh_token.id"), nullable=True
    )

    user: Mapped[User] = relationship(back_populates="refresh_tokens", lazy="raise")

    def is_active(self, now: datetime | None = None) -> bool:
        """Jeton encore utilisable : ni remplacé, ni révoqué, ni expiré."""
        moment = now or utcnow()
        return self.revoked_at is None and self.replaced_by is None and moment < self.expires_at


class Totp(Base):
    """``auth_totp`` — double authentification, séparée pour ne pas toucher ``users``.

    Le secret est chiffré au repos (AES-256-GCM) : ``secret_enc`` porte le chiffré
    et son tag, ``nonce`` le nonce. Une ligne existe dès la préparation de la 2FA ;
    ``enabled`` ne passe à vrai qu'une fois un premier code confirmé.
    """

    __tablename__ = "auth_totp"

    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    secret_enc: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    nonce: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    confirmed_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)

    user: Mapped[User] = relationship(back_populates="totp", lazy="raise")


class RecoveryCode(Base):
    """``auth_recovery_code`` — codes de secours de la 2FA.

    Un code de secours vaut un mot de passe : il est haché, jamais stocké en clair,
    et consommé une seule fois (``used_at``).
    """

    __tablename__ = "auth_recovery_code"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    code_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)

    user: Mapped[User] = relationship(back_populates="recovery_codes", lazy="raise")

    @property
    def is_used(self) -> bool:
        """Le code a-t-il déjà servi ?"""
        return self.used_at is not None


class PasswordReset(Base):
    """``auth_password_reset`` — jeton à usage unique de réinitialisation.

    Seule l'empreinte SHA-256 du jeton envoyé par courriel est conservée.
    """

    __tablename__ = "auth_password_reset"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(CHAR(64), nullable=False, unique=True)
    expires_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)

    user: Mapped[User] = relationship(back_populates="password_resets", lazy="raise")

    def is_active(self, now: datetime | None = None) -> bool:
        """Jeton encore consommable : ni utilisé, ni expiré."""
        return self.used_at is None and (now or utcnow()) < self.expires_at


class Ban(Base):
    """``auth_ban`` — sanction appliquée à un compte. ``until`` à ``NULL`` = définitif."""

    __tablename__ = "auth_ban"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    until: Mapped[datetime | None] = mapped_column(TS, nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(80), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TS, nullable=False, default=utcnow, server_default=func.now()
    )

    user: Mapped[User] = relationship(back_populates="bans", lazy="raise")

    def is_active(self, now: datetime | None = None) -> bool:
        """Sanction en cours : définitive, ou dont l'échéance n'est pas atteinte."""
        if self.until is None:
            return True
        return (now or utcnow()) < self.until


class Audit(Base):
    """``auth_audit`` — journal d'audit.

    Jamais de mot de passe, de jeton ni d'adresse IP en clair : ``ip_hash`` porte
    une empreinte SHA-256 salée de l'adresse. Le journal survit à la suppression
    d'un compte (``ON DELETE SET NULL``).
    """

    __tablename__ = "auth_audit"
    __table_args__ = (Index("idx_auth_audit_user", "user_id", text("created_at DESC")),)

    id: Mapped[int] = mapped_column(BIGINT_PK, primary_key=True, autoincrement=True)
    user_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    action: Mapped[str] = mapped_column(String(60), nullable=False)
    ip_hash: Mapped[str | None] = mapped_column(CHAR(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)
    meta: Mapped[dict[str, Any] | None] = mapped_column(JSONB_OR_JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TS, nullable=False, default=utcnow, server_default=func.now()
    )

    user: Mapped[User | None] = relationship(back_populates="audits", lazy="raise")


class YggSession(Base):
    """``ygg_session`` — sessions de jeu que **nous** signons.

    ``access_token`` ne contient pas le JWT : c'est son empreinte SHA-256, ce qui
    permet ``/validate`` et ``/invalidate`` sans jamais conserver un jeton
    utilisable en base.
    """

    __tablename__ = "ygg_session"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    access_token: Mapped[str] = mapped_column(CHAR(64), nullable=False, unique=True)
    client_token: Mapped[str] = mapped_column(String(64), nullable=False)
    issued_at: Mapped[datetime] = mapped_column(
        TS, nullable=False, default=utcnow, server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    invalidated_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)

    user: Mapped[User] = relationship(back_populates="ygg_sessions", lazy="raise")

    def is_active(self, now: datetime | None = None) -> bool:
        """Session encore valable : ni invalidée, ni expirée."""
        return self.invalidated_at is None and (now or utcnow()) < self.expires_at


class YggJoin(Base):
    """``ygg_join`` — trace éphémère d'un ``session/minecraft/join``.

    Le client annonce son arrivée, le serveur Minecraft confirme aussitôt via
    ``hasJoined``. La fenêtre est très courte (``OPM_JOIN_TTL_SECONDS``, 30 s par
    défaut) : les lignes périmées sont purgées par la tâche de fond.
    ``server_id`` est la clé primaire — un identifiant de session ne sert qu'une fois.
    """

    __tablename__ = "ygg_join"

    server_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    ip: Mapped[str | None] = mapped_column(String(45), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TS, nullable=False, default=utcnow, server_default=func.now()
    )

    user: Mapped[User] = relationship(back_populates="ygg_joins", lazy="raise")

    def is_expired(self, ttl_seconds: int, now: datetime | None = None) -> bool:
        """La fenêtre d'annonce est-elle dépassée ?"""
        return ((now or utcnow()) - self.created_at).total_seconds() >= ttl_seconds


class Texture(Base):
    """``texture`` — skin ou cape, blob adressé par son contenu.

    Deux joueurs au même skin ne stockent qu'un seul fichier : la clé est le
    ``sha256`` du PNG ré-encodé, qui sert aussi de nom de fichier sur disque et
    d'URL publique (``/textures/{sha256}.png``, immuable).
    """

    __tablename__ = "texture"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False, unique=True)
    #: ``skin`` ou ``cape`` (:class:`TextureKind`).
    kind: Mapped[str] = mapped_column(String(8), nullable=False)
    #: ``classic`` ou ``slim`` (:class:`TextureModel`).
    model: Mapped[str] = mapped_column(
        String(8),
        nullable=False,
        default=TextureModel.CLASSIC.value,
        server_default=text("'classic'"),
    )
    width: Mapped[int] = mapped_column(Integer, nullable=False)
    height: Mapped[int] = mapped_column(Integer, nullable=False)
    #: Taille du fichier en octets (nom de colonne repris tel quel de DATA.md §2).
    bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    #: ``upload``, ``mojang_import`` ou ``default`` (:class:`TextureSource`).
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TS, nullable=False, default=utcnow, server_default=func.now()
    )

    holders: Mapped[list[UserTexture]] = relationship(back_populates="texture", lazy="raise")

    @property
    def relative_url(self) -> str:
        """Chemin public de la texture, à préfixer par ``OPM_PUBLIC_URL``."""
        return f"/textures/{self.sha256}.png"


class UserTexture(Base):
    """``user_texture`` — texture active d'un joueur, par type.

    ``texture_id`` à ``NULL`` signifie « skin par défaut » : c'est une association
    explicite, et non l'absence de ligne, pour distinguer « il a choisi le skin
    par défaut » de « on n'a jamais rien importé ».
    """

    __tablename__ = "user_texture"

    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    #: ``skin`` ou ``cape`` (:class:`TextureKind`).
    kind: Mapped[str] = mapped_column(String(8), primary_key=True)
    texture_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("texture.id"), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        TS, nullable=False, default=utcnow, onupdate=utcnow, server_default=func.now()
    )

    user: Mapped[User] = relationship(back_populates="textures", lazy="raise")
    texture: Mapped[Texture | None] = relationship(back_populates="holders", lazy="selectin")


class Instance(Base):
    """``launcher_instance`` — profils de jeu servis par ``GET /api/v1/instances``.

    Remplace l'URL statique de l'ancien launcher. Le format de sortie reste
    volontairement identique à celui qu'attend ``minecraft-java-core`` : c'est la
    couche schéma qui traduit ``loader_type`` en ``loadder.loadder_type``.
    """

    __tablename__ = "launcher_instance"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    #: Identifiant technique, celui que le launcher mémorise.
    name: Mapped[str] = mapped_column(String(60), nullable=False, unique=True)
    display_name: Mapped[str] = mapped_column(String(80), nullable=False)
    url: Mapped[str] = mapped_column(String(255), nullable=False)
    #: Version Minecraft (``1.20.1``…).
    version: Mapped[str] = mapped_column(String(20), nullable=False)
    loader_type: Mapped[str] = mapped_column(
        String(20), nullable=False, default=LoaderType.NONE.value, server_default=text("'none'")
    )
    loader_version: Mapped[str | None] = mapped_column(String(40), nullable=True)
    verify: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=true()
    )
    #: Chemins ignorés par la vérification d'intégrité.
    ignored: Mapped[list[str]] = mapped_column(
        JSONB_OR_JSON, nullable=False, default=list, server_default=text("'[]'")
    )
    whitelist_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    whitelist: Mapped[list[str]] = mapped_column(
        JSONB_OR_JSON, nullable=False, default=list, server_default=text("'[]'")
    )
    status_host: Mapped[str | None] = mapped_column(String(120), nullable=True)
    status_port: Mapped[int | None] = mapped_column(
        Integer, nullable=True, default=25565, server_default=text("25565")
    )
    sort_order: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=true()
    )


# ═══════════════════════════════════════════════════════════════════════════
#   PROPRIÉTÉ DES TABLES — le garde-fou
# ═══════════════════════════════════════════════════════════════════════════
#: Tables du site. Mappées en lecture (et écriture limitée, docs/DATA.md §4).
#: **Jamais** passées à ``create_all`` ni à une migration de ce dépôt.
SITE_TABLES: tuple[Table, ...] = (
    User.__table__,
    Article.__table__,
    Statistiques.__table__,
    Equipage.__table__,
    Ile.__table__,
)

#: Tables du launcher. Les seules que ``init_models()`` et notre migration créent.
LAUNCHER_TABLES: tuple[Table, ...] = (
    McLink.__table__,
    RefreshToken.__table__,
    Totp.__table__,
    RecoveryCode.__table__,
    PasswordReset.__table__,
    Ban.__table__,
    Audit.__table__,
    YggSession.__table__,
    YggJoin.__table__,
    Texture.__table__,
    UserTexture.__table__,
    Instance.__table__,
)

#: Noms des tables du launcher, pratiques pour la migration et les tests.
LAUNCHER_TABLE_NAMES: frozenset[str] = frozenset(table.name for table in LAUNCHER_TABLES)
#: Noms des tables du site.
SITE_TABLE_NAMES: frozenset[str] = frozenset(table.name for table in SITE_TABLES)


def _check_table_ownership() -> None:
    """Vérifie à l'import que chaque table est rangée dans exactement une famille.

    Un modèle ajouté plus tard et oublié dans les deux listes serait soit créé
    par erreur dans la base du site, soit absent de la migration. Mieux vaut un
    échec bruyant au démarrage qu'un ``CREATE TABLE users`` en production.
    """
    declared = SITE_TABLE_NAMES | LAUNCHER_TABLE_NAMES
    known = set(Base.metadata.tables)

    if overlap := SITE_TABLE_NAMES & LAUNCHER_TABLE_NAMES:
        raise RuntimeError(
            "Tables déclarées à la fois côté site et côté launcher : " + ", ".join(sorted(overlap))
        )
    if orphans := known - declared:
        raise RuntimeError(
            "Tables non rattachées à une famille dans models.py : "
            + ", ".join(sorted(orphans))
            + ". Ajoutez-les à SITE_TABLES ou à LAUNCHER_TABLES."
        )
    if missing := declared - known:
        raise RuntimeError(
            "Tables déclarées mais absentes de Base.metadata : " + ", ".join(sorted(missing))
        )


_check_table_ownership()
