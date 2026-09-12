"""Configuration centrale du serveur d'authentification One Piece Minecraft.

Toute la configuration provient de variables d'environnement préfixées ``OPM_``
(ou d'un fichier ``.env`` placé à la racine de ``auth-server/``). Aucun secret
n'est écrit en dur : les valeurs par défaut présentes ici sont soit inoffensives,
soit des marqueurs de développement que la validation refuse en production.

La base de données est **celle du site**
=======================================

``OPM_DATABASE_URL`` pointe sur le PostgreSQL du site Flask, pas sur une seconde
base. Le launcher lit les comptes, le journal de bord et les statistiques déjà
tenus par le site, et y ajoute ses propres tables préfixées ``auth_``, ``ygg_``
et ``launcher_`` (voir ``docs/DATA.md`` §2).

Le rôle PostgreSQL utilisé ici a donc besoin, et de rien de plus :

* tous les droits (``SELECT``, ``INSERT``, ``UPDATE``, ``DELETE``) sur les
  tables du launcher — ``auth_*``, ``ygg_*``, ``launcher_instance``,
  ``texture``, ``user_texture`` — et sur leurs séquences ;
* ``SELECT`` sur les tables du site : ``users``, ``article``, ``statistiques``,
  ``equipages``, ``iles`` ;
* ``INSERT`` sur ``users`` (+ ``USAGE`` sur ``users_id_seq``) : le launcher
  crée des comptes, qui sont des comptes du site à part entière ;
* ``UPDATE`` **limité** à ``users.derniereconnexion``, ``users.tempsdejeu``,
  ``users.password_hash`` et aux colonnes de fréquentation de ``statistiques``
  (``joueurs_en_ligne``, ``record_joueurs``, ``record_date``).

``users.password_hash`` doit figurer dans les droits d'écriture : sans lui, le
renforcement transparent des empreintes (``docs/DATA.md`` §3) échoue au moment
du ``flush``, et **plus aucun compte historique ne peut se connecter**. Sans
``INSERT``, c'est ``POST /api/v1/auth/register`` qui répond « permission denied
for table users ».

Les colonnes RP (``prime``, ``berry``, ``niveau*``, ``faction``, ``equipage``…)
appartiennent au site et au serveur Minecraft : le launcher les lit, jamais
l'inverse. Restreindre le rôle au niveau de PostgreSQL est la meilleure garantie
qu'une erreur de code ne pourra pas les abîmer.

Mots de passe
=============

Il n'y a **pas** de réglage Argon2id ici, et c'est délibéré : le format des
empreintes est imposé par Werkzeug, que le site utilise. Seul le nombre
d'itérations est configurable (``OPM_PASSWORD_ITERATIONS``). Voir
``opm_auth/security/passwords.py`` pour le détail du raisonnement.

Utilisation :

    from opm_auth.config import get_settings

    settings = get_settings()
    if settings.is_prod:
        ...
"""

from __future__ import annotations

import base64
import binascii
import logging
from datetime import datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)

# Racine du projet : auth-server/ (ce fichier vit dans auth-server/opm_auth/).
BASE_DIR: Path = Path(__file__).resolve().parent.parent

# Valeurs de développement explicitement bannies en production.
DEV_SECRET_KEY = "dev-only-secret-change-me-avant-la-mise-en-production"
DEV_MSA_TOKEN_KEY = "6465762d6f6e6c792d6b65792d646f2d6e6f742d7573652d696e2d70726f6421"
_FORBIDDEN_FRAGMENTS = ("dev-only", "changeme", "change-me", "à-changer", "a-changer")

#: Plancher d'itérations PBKDF2 toléré en production (recommandation OWASP).
PRODUCTION_MIN_PASSWORD_ITERATIONS = 600_000

Environment = Literal["dev", "test", "prod"]
AuthMode = Literal["sovereign", "hybrid", "microsoft"]
MicrosoftFlow = Literal["embedded", "device"]
LogLevel = Literal["debug", "info", "warning", "error"]


def _split_csv(raw: str) -> list[str]:
    """Découpe une liste séparée par des virgules en ignorant les blancs."""
    return [item.strip() for item in raw.split(",") if item.strip()]


class Settings(BaseSettings):
    """Réglages du serveur, chargés une seule fois au démarrage."""

    model_config = SettingsConfigDict(
        env_prefix="OPM_",
        env_file=(BASE_DIR / ".env",),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ------------------------------------------------------------------ 1. Exécution
    env: Environment = "dev"
    host: str = "127.0.0.1"
    port: int = Field(default=8000, ge=1, le=65535)
    log_level: LogLevel = "info"
    debug_sql: bool = False
    public_url: str = "http://127.0.0.1:8000"
    cors_origins: str = ""
    trust_proxy_headers: bool = False
    #: Nombre de proxys de confiance placés DEVANT ce serveur. L'adresse du
    #: joueur est lue dans « X-Forwarded-For » en partant de la DROITE, en
    #: sautant autant d'entrées : nginx ajoute l'adresse réelle à la fin de la
    #: chaîne, alors que la gauche est écrite par le client lui-même. 1 = un
    #: nginx ; 2 = un service de bordure (Cloudflare…) puis nginx.
    trusted_proxies: int = Field(default=1, ge=1, le=16)
    #: Adresses ou préfixes CIDR autorisés à poser « X-Forwarded-For », séparés
    #: par des virgules. L'en-tête n'est lu que si la connexion vient de l'un
    #: d'eux. Vide = boucle locale et réseaux privés (le cas d'un nginx local).
    trusted_proxy_ips: str = ""

    # ------------------------------------------------------------ 2. Base de données
    # Développement et tests : SQLite jetable. Production : le PostgreSQL DU SITE
    # (voir la docstring du module pour les droits à accorder au rôle).
    database_url: str = "sqlite+aiosqlite:///./data/opm_auth.db"
    db_pool_size: int = Field(default=10, ge=1, le=100)
    db_max_overflow: int = Field(default=20, ge=0, le=200)

    # ---------------------------------------------------------- 3. Secrets et clés
    secret_key: str = DEV_SECRET_KEY
    jwt_private_key_path: str = "keys/jwt_ed25519_private.pem"
    jwt_public_key_path: str = "keys/jwt_ed25519_public.pem"
    ygg_private_key_path: str = "keys/ygg_ed25519_private.pem"
    ygg_public_key_path: str = "keys/ygg_ed25519_public.pem"
    msa_token_key: str = DEV_MSA_TOKEN_KEY
    #: Anciennes clés AES encore acceptées au déchiffrement, séparées par des
    #: virgules. Permet une rotation sans re-rattachement Microsoft massif.
    msa_token_keys_previous: str = ""

    # ------------------------------------------------------ 4. Mots de passe
    #: Itérations PBKDF2-SHA256 à l'écriture. Le format reste celui de Werkzeug :
    #: le site relit sans modification, il lit le compte dans l'empreinte.
    password_iterations: int = Field(default=600_000, ge=1_000, le=10_000_000)
    password_min_length: int = Field(default=12, ge=8, le=128)
    password_max_length: int = Field(default=128, ge=32, le=1024)
    #: Durée constante d'une vérification de mot de passe, en millisecondes.
    #: Sans ce plancher, un compte inconnu et un compte existant ne répondent
    #: pas en autant de temps, et l'écart permet d'énumérer les adresses
    #: inscrites. 0 désactive l'attente (tests). Voir security/passwords.py.
    login_time_budget_ms: int = Field(default=750, ge=0, le=5_000)

    # ------------------------------------------------- 5. Mode d'authentification
    auth_mode: AuthMode = "hybrid"
    microsoft_required: bool = True
    registration_open: bool = True
    email_verification_required: bool = False
    ownership_ttl_days: int = Field(default=30, ge=1, le=365)

    # ------------------------------------------------------------- 6. Microsoft
    msa_client_id: str = "00000000402b5328"
    msa_client_secret: str = ""
    msa_flow: MicrosoftFlow = "embedded"
    msa_redirect_uri: str = "https://login.live.com/oauth20_desktop.srf"
    msa_scope: str = "service::user.auth.xboxlive.com::MBI_SSL"
    msa_device_scope: str = "XboxLive.signin offline_access"
    msa_rps_prefix: str = "d="
    msa_authorize_url: str = "https://login.live.com/oauth20_authorize.srf"
    msa_token_url: str = "https://login.live.com/oauth20_token.srf"
    msa_device_code_url: str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode"
    msa_device_token_url: str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token"
    xbl_auth_url: str = "https://user.auth.xboxlive.com/user/authenticate"
    xsts_auth_url: str = "https://xsts.auth.xboxlive.com/xsts/authorize"
    mc_login_url: str = "https://api.minecraftservices.com/authentication/login_with_xbox"
    mc_profile_url: str = "https://api.minecraftservices.com/minecraft/profile"
    mc_entitlements_url: str = "https://api.minecraftservices.com/entitlements/mcstore"
    msa_timeout_seconds: float = Field(default=20.0, gt=0)

    # --------------------------------------------------- 7. Durées de vie des jetons
    access_ttl_minutes: int = Field(default=15, ge=1, le=1440)
    refresh_ttl_days: int = Field(default=30, ge=1, le=365)
    ygg_ttl_hours: int = Field(default=24, ge=1, le=720)
    join_ttl_seconds: int = Field(default=30, ge=5, le=300)
    password_reset_ttl_minutes: int = Field(default=30, ge=5, le=1440)
    recovery_codes_count: int = Field(default=10, ge=4, le=20)
    #: Émetteur et audiences des JWT. Vides = dérivés de public_url / server_name.
    jwt_issuer: str | None = None
    jwt_audience: str = "opm-launcher"
    jwt_game_audience: str = "opm-minecraft"
    jwt_leeway_seconds: int = Field(default=5, ge=0, le=300)
    totp_issuer: str | None = None

    # ------------------------------------------- 8. Serveur Minecraft et Yggdrasil
    server_name: str = "One Piece Minecraft"
    mc_host: str = "play.onepieceminecraft.fr"
    mc_port: int = Field(default=25565, ge=1, le=65535)
    skin_domains: str = "127.0.0.1,localhost"
    textures_dir: str = "data/textures"
    texture_max_kib: int = Field(default=256, ge=16, le=4096)
    #: Si vrai, ``hasJoined`` interroge le sessionserver de Mojang quand le pseudo
    #: est inconnu de notre base : les joueurs premium venus du launcher officiel
    #: entrent alors sur le serveur. À laisser FAUX en mode « hybride imposé »
    #: (``docs/DATA.md`` §8).
    ygg_mojang_fallback: bool = False

    # -------------------------------------- 9. Statistiques du serveur Minecraft
    #: Autorise l'écriture de la fréquentation dans ``statistiques`` (id = 1).
    #: Le site fait le même relevé de son côté : l'écriture est atomique et
    #: protégée par GREATEST, aucun des deux n'écrase le record de l'autre
    #: (``docs/DATA.md`` §4). Mettre à faux si le site reprend la main.
    stats_write: bool = True
    #: Cadence du ping du serveur Minecraft, en secondes.
    stats_interval: int = Field(default=20, ge=5, le=3600)

    # ------------------------------------------------- 10. Mises à jour du launcher
    #: Les URL de téléchargement réelles vivent dans ``statistiques.launcher_windows``,
    #: ``_mac`` et ``_linux`` : celle-ci n'est qu'un repli quand la ligne est vide.
    launcher_version_min: str = "2.0.0"
    launcher_version_latest: str = "2.0.0"
    launcher_download_url: str = ""
    maintenance_active: bool = False
    maintenance_message: str | None = None
    maintenance_eta: datetime | None = None

    # ------------------------------------------------------------ 11. Rail social
    link_discord: str = ""
    link_twitch: str = ""
    link_youtube: str = ""
    link_website: str = ""
    #: Adresse publique du site Flask. La table « article » ne stocke que le
    #: SLUG de chaque billet (« la-v7-une-version-nostalgique ») : c'est cette
    #: base qui en fait une adresse ouvrable par le launcher. Distincte de
    #: ``link_website`` (le rail social, facultatif) et de ``public_url`` (ce
    #: serveur-ci).
    site_url: str = "https://onepieceminecraft.fr"

    # -------------------------------------------------------------- 12. Contenu
    #: Nombre d'articles renvoyés par défaut par ``GET /api/v1/news``.
    news_limit: int = Field(default=10, ge=1, le=50)
    instances_url: str = ""
    content_cache_seconds: int = Field(default=120, ge=0, le=3600)

    # ----------------------------------------------------------------- 13. Dons
    #: Il n'y a **aucune** table de dons : la partie paiement du site n'est pas
    #: terminée. L'écran Donation lit ``statistiques.dons_collecte``,
    #: ``dons_objectif`` et ``donateurs``, et rien d'autre (``docs/DATA.md`` §2).
    #: Le bouton « FAIRE UN DON » ouvre simplement cette page dans le navigateur :
    #: aucun paiement n'a lieu dans le launcher.
    donation_url: str = "https://onepieceminecraft.fr/don"

    # -------------------------------------------------------------- 14. Courriel
    smtp_enabled: bool = False
    smtp_host: str = "localhost"
    smtp_port: int = Field(default=587, ge=1, le=65535)
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = "no-reply@onepieceminecraft.fr"
    smtp_from_name: str = "One Piece Minecraft"
    smtp_starttls: bool = True
    smtp_ssl: bool = False
    smtp_timeout_seconds: float = Field(default=15.0, gt=0)

    # ------------------------------------------------- 15. Limitation de débit
    rate_limit_enabled: bool = True
    rate_limit_storage_uri: str = "memory://"
    rate_limit_default: str = "120/minute"
    rate_limit_login_ip: str = "5/minute"
    rate_limit_login_account: str = "10/hour"
    rate_limit_register: str = "3/hour"
    rate_limit_forgot: str = "3/hour"
    rate_limit_yggdrasil: str = "10/minute"

    # ================================================================ Validateurs
    @field_validator(
        "maintenance_message",
        "maintenance_eta",
        "jwt_issuer",
        "totp_issuer",
        mode="before",
    )
    @classmethod
    def _blank_to_none(cls, value: Any) -> Any:
        """Traite une variable d'environnement vide comme absente.

        Indispensable pour ``jwt_issuer`` et ``totp_issuer`` : une chaîne vide
        écraserait le repli sur ``public_url`` et ``server_name``.
        """
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator(
        "public_url", "launcher_download_url", "donation_url", mode="after"
    )
    @classmethod
    def _strip_trailing_slash(cls, value: str) -> str:
        return value.rstrip("/")

    @field_validator("donation_url", mode="after")
    @classmethod
    def _check_donation_url(cls, value: str) -> str:
        """La page de don est ouverte dans le navigateur du joueur."""
        if value and not value.startswith(("http://", "https://")):
            raise ValueError(
                "OPM_DONATION_URL doit être une URL http(s) : elle est ouverte "
                "telle quelle dans le navigateur du joueur."
            )
        return value

    @model_validator(mode="after")
    def _check_coherence(self) -> Settings:
        """Contrôles transverses, appliqués à tous les environnements."""
        if self.password_min_length > self.password_max_length:
            raise ValueError(
                "OPM_PASSWORD_MIN_LENGTH doit être inférieur ou égal à "
                "OPM_PASSWORD_MAX_LENGTH."
            )
        if self.auth_mode == "sovereign" and self.microsoft_required:
            raise ValueError(
                "OPM_MICROSOFT_REQUIRED ne peut pas être vrai lorsque OPM_AUTH_MODE "
                "vaut « sovereign »."
            )
        if self.stats_write and not self.mc_host.strip():
            raise ValueError(
                "OPM_STATS_WRITE exige un OPM_MC_HOST : sans serveur à interroger, "
                "il n'y a aucune fréquentation à écrire dans « statistiques »."
            )
        # Vérifie dès le démarrage que la clé de chiffrement Microsoft est
        # exploitable (la propriété lève une ValueError explicite si besoin).
        _ = self.msa_token_key_bytes
        _ = self.msa_token_keys_previous_bytes
        return self

    @model_validator(mode="after")
    def _check_production(self) -> Settings:
        """Refuse de démarrer en production avec une configuration de développement.

        Le démarrage échoue franchement, avec la liste complète des problèmes :
        mieux vaut un service qui refuse de monter qu'un service qui tourne avec
        la clé de signature publiée dans ``.env.example``.
        """
        if self.env != "prod":
            return self

        problems: list[str] = []

        if self._is_placeholder(self.secret_key) or len(self.secret_key) < 32:
            problems.append(
                "OPM_SECRET_KEY est une valeur de développement ou trop courte "
                "(32 caractères minimum)."
            )
        if self._is_placeholder(self.msa_token_key):
            problems.append("OPM_MSA_TOKEN_KEY est encore la clé de développement.")
        if self.is_sqlite:
            problems.append(
                "SQLite est interdit en production : OPM_DATABASE_URL doit pointer "
                "sur le PostgreSQL du site."
            )
        if not self.public_url.startswith("https://"):
            problems.append("OPM_PUBLIC_URL doit être en HTTPS en production.")
        if not self.rate_limit_enabled:
            problems.append("OPM_RATE_LIMIT_ENABLED ne peut pas être faux en production.")
        if self.password_iterations < PRODUCTION_MIN_PASSWORD_ITERATIONS:
            problems.append(
                f"OPM_PASSWORD_ITERATIONS doit valoir au moins "
                f"{PRODUCTION_MIN_PASSWORD_ITERATIONS} en production."
            )
        # Fichiers de clés. Une installation neuve n'en a encore aucun : refuser
        # de démarrer rendrait la production impossible à amorcer, puisque
        # « opm-auth keygen » commence lui-même par charger cette configuration.
        # Un trousseau PARTIEL, en revanche, reste bloquant : la clé manquante
        # serait régénérée seule, et plus rien de ce qui a été signé avec
        # l'ancienne ne se vérifierait.
        keys = (
            ("OPM_JWT_PRIVATE_KEY_PATH", self.jwt_private_key),
            ("OPM_JWT_PUBLIC_KEY_PATH", self.jwt_public_key),
            ("OPM_YGG_PRIVATE_KEY_PATH", self.ygg_private_key),
            ("OPM_YGG_PUBLIC_KEY_PATH", self.ygg_public_key),
        )
        missing = [(label, path) for label, path in keys if not path.is_file()]
        if missing and len(missing) < len(keys):
            problems.extend(
                f"{label} : fichier de clé introuvable ({path}) alors que le reste "
                "du trousseau existe — régénérer cette seule clé invaliderait tout "
                "ce qui a été signé avec l'ancienne."
                for label, path in missing
            )
        elif missing:
            logger.warning(
                "Aucun fichier de clé n'existe encore : ils seront générés au "
                "démarrage (ensure_keys) ou par « opm-auth keygen ». Sauvegardez-les "
                "aussitôt : les perdre déconnecte tous les joueurs."
            )
        if not self.skin_domains_list:
            problems.append(
                "OPM_SKIN_DOMAINS ne peut pas être vide : authlib-injector rejetterait "
                "toutes les textures."
            )
        if self.email_verification_required and not self.smtp_enabled:
            problems.append(
                "OPM_EMAIL_VERIFICATION_REQUIRED exige un SMTP actif (OPM_SMTP_ENABLED)."
            )
        if self.smtp_enabled and self.smtp_starttls and self.smtp_ssl:
            problems.append(
                "OPM_SMTP_STARTTLS et OPM_SMTP_SSL s'excluent : choisissez STARTTLS "
                "(port 587) ou TLS implicite (port 465)."
            )
        if not self.donation_url:
            problems.append(
                "OPM_DONATION_URL est vide : le bouton « FAIRE UN DON » n'ouvrirait "
                "aucune page."
            )

        if problems:
            details = "\n  - ".join(problems)
            raise ValueError(
                "Configuration de production invalide, démarrage refusé :\n  - " + details
            )
        return self

    @staticmethod
    def _is_placeholder(value: str) -> bool:
        """Détecte les valeurs de démonstration livrées dans .env.example."""
        lowered = value.strip().lower()
        if lowered in {DEV_SECRET_KEY.lower(), DEV_MSA_TOKEN_KEY.lower()}:
            return True
        return any(fragment in lowered for fragment in _FORBIDDEN_FRAGMENTS)

    # ============================================================ Propriétés dérivées
    @property
    def is_prod(self) -> bool:
        return self.env == "prod"

    @property
    def is_dev(self) -> bool:
        return self.env == "dev"

    @property
    def is_test(self) -> bool:
        return self.env == "test"

    @property
    def base_dir(self) -> Path:
        """Racine de ``auth-server/``, base de tous les chemins relatifs."""
        return BASE_DIR

    def resolve_path(self, value: str) -> Path:
        """Résout un chemin de configuration, relatif à la racine du projet."""
        path = Path(value).expanduser()
        return path if path.is_absolute() else (BASE_DIR / path).resolve()

    @property
    def jwt_private_key(self) -> Path:
        return self.resolve_path(self.jwt_private_key_path)

    @property
    def jwt_public_key(self) -> Path:
        return self.resolve_path(self.jwt_public_key_path)

    @property
    def ygg_private_key(self) -> Path:
        return self.resolve_path(self.ygg_private_key_path)

    @property
    def ygg_public_key(self) -> Path:
        return self.resolve_path(self.ygg_public_key_path)

    @property
    def textures_path(self) -> Path:
        return self.resolve_path(self.textures_dir)

    @staticmethod
    def _decode_key(raw: str, label: str) -> bytes:
        """Décode une clé de 32 octets, en hexadécimal ou en base64."""
        raw = raw.strip()
        key: bytes | None = None
        if len(raw) == 64:
            try:
                key = bytes.fromhex(raw)
            except ValueError:
                key = None
        if key is None:
            try:
                key = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
            except (binascii.Error, ValueError):
                key = None
        if key is None or len(key) != 32:
            raise ValueError(
                f"{label} doit contenir 32 octets, en hexadécimal (64 caractères) "
                "ou en base64 (44 caractères)."
            )
        return key

    @property
    def msa_token_key_bytes(self) -> bytes:
        """Clé AES-256-GCM (32 octets) chiffrant le jeton Microsoft au repos."""
        return self._decode_key(self.msa_token_key, "OPM_MSA_TOKEN_KEY")

    @property
    def msa_token_keys_previous_bytes(self) -> tuple[bytes, ...]:
        """Anciennes clés AES encore acceptées au déchiffrement (rotation)."""
        return tuple(
            self._decode_key(item, "OPM_MSA_TOKEN_KEYS_PREVIOUS")
            for item in _split_csv(self.msa_token_keys_previous)
        )

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.strip().startswith("sqlite")

    @property
    def is_postgres(self) -> bool:
        """Vrai lorsque l'on parle bien à la base du site."""
        return self.database_url.strip().startswith(("postgres://", "postgresql"))

    @property
    def sqlalchemy_url(self) -> str:
        """URL de connexion normalisée vers un pilote asynchrone.

        ``sqlite://`` devient ``sqlite+aiosqlite://`` et ``postgresql://`` devient
        ``postgresql+asyncpg://``. Les chemins SQLite relatifs sont ancrés sur la
        racine du projet afin d'être indépendants du répertoire courant.
        """
        url = self.database_url.strip()

        if url.startswith("postgres://"):
            url = "postgresql://" + url[len("postgres://") :]
        if url.startswith("postgresql://"):
            url = "postgresql+asyncpg://" + url[len("postgresql://") :]
        if url.startswith("sqlite://") and not url.startswith("sqlite+"):
            url = "sqlite+aiosqlite://" + url[len("sqlite://") :]

        prefix = "sqlite+aiosqlite:///"
        if url.startswith(prefix):
            target = url[len(prefix) :]
            if target and target != ":memory:" and not Path(target).is_absolute():
                url = prefix + self.resolve_path(target).as_posix()
        return url

    @property
    def sqlite_file(self) -> Path | None:
        """Chemin du fichier SQLite, ou ``None`` (base en mémoire ou PostgreSQL)."""
        prefix = "sqlite+aiosqlite:///"
        url = self.sqlalchemy_url
        if not url.startswith(prefix):
            return None
        target = url[len(prefix) :]
        return None if not target or target == ":memory:" else Path(target)

    @property
    def access_ttl(self) -> timedelta:
        return timedelta(minutes=self.access_ttl_minutes)

    @property
    def refresh_ttl(self) -> timedelta:
        return timedelta(days=self.refresh_ttl_days)

    @property
    def ygg_ttl(self) -> timedelta:
        return timedelta(hours=self.ygg_ttl_hours)

    @property
    def join_ttl(self) -> timedelta:
        return timedelta(seconds=self.join_ttl_seconds)

    @property
    def ownership_ttl(self) -> timedelta:
        """Durée de validité d'une vérification de possession Minecraft.

        C'est le cœur de la souveraineté : tant qu'elle n'est pas expirée, le
        joueur joue même si Microsoft est injoignable (``docs/DATA.md`` §7).
        """
        return timedelta(days=self.ownership_ttl_days)

    @property
    def password_reset_ttl(self) -> timedelta:
        return timedelta(minutes=self.password_reset_ttl_minutes)

    @property
    def stats_ttl(self) -> timedelta:
        """Intervalle entre deux relevés de fréquentation du serveur Minecraft."""
        return timedelta(seconds=self.stats_interval)

    @property
    def skin_domains_list(self) -> list[str]:
        return _split_csv(self.skin_domains)

    @property
    def cors_origins_list(self) -> list[str]:
        return _split_csv(self.cors_origins)

    @property
    def textures_base_url(self) -> str:
        """Préfixe absolu des URL de textures (skins et capes)."""
        return f"{self.public_url}/textures"

    @property
    def yggdrasil_base_url(self) -> str:
        """Racine à donner à authlib-injector côté serveur Minecraft."""
        return f"{self.public_url}/yggdrasil"

    def texture_url(self, sha256: str) -> str:
        """URL publique d'une texture stockée en contenu adressable."""
        return f"{self.textures_base_url}/{sha256}.png"

    def ensure_directories(self) -> None:
        """Crée les dossiers de travail manquants (textures, base SQLite, clés)."""
        self.textures_path.mkdir(parents=True, exist_ok=True)
        sqlite_file = self.sqlite_file
        if sqlite_file is not None:
            sqlite_file.parent.mkdir(parents=True, exist_ok=True)
        self.jwt_private_key.parent.mkdir(parents=True, exist_ok=True)
        self.ygg_private_key.parent.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Renvoie l'instance unique de configuration (mise en cache)."""
    return Settings()


def reload_settings() -> Settings:
    """Vide le cache et relit l'environnement. Réservé aux tests et aux scripts."""
    get_settings.cache_clear()
    return get_settings()
