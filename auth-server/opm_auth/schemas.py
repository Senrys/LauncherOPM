"""Schémas Pydantic v2 : tout ce qui entre et sort du serveur.

Ce module est la traduction exécutable de ``docs/API.md``. Il ne contient aucune
logique métier et n'importe rien de la base de données à l'exécution : c'est
volontaire, ces objets doivent rester des contrats purs. Les quelques
constructeurs ``from_*`` qu'on y trouve sont du **mappage pur** — renommer une
colonne, dériver un ``kind``, convertir des euros en centimes — et prennent
volontairement un ``Any`` en entrée pour ne créer aucune dépendance vers ``models``.

Deux familles de conventions cohabitent :

* l'**API launcher** (``/api/v1``) est en ``snake_case`` ;
* l'**API Yggdrasil** (``/yggdrasil``) suit le protocole Mojang, en ``camelCase``.
  Les champs y portent donc un alias ; les modèles acceptent les deux écritures
  et FastAPI sérialise avec l'alias.

Rappel de ``docs/DATA.md`` : ``users.id`` est un **entier**, le pseudo du launcher
est ``users.name``, et la cagnotte du site est tenue en **euros entiers** alors
que l'API parle en **centimes**.
"""

from __future__ import annotations

import html
import re
import unicodedata
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    EmailStr,
    Field,
    StringConstraints,
)

# ---------------------------------------------------------------------------
# 0. Types communs
# ---------------------------------------------------------------------------


def _normalize_email(value: Any) -> Any:
    """Une adresse e-mail est comparée en minuscules, sans espaces."""
    return value.strip().lower() if isinstance(value, str) else value


Email = Annotated[EmailStr, BeforeValidator(_normalize_email), Field(max_length=320)]

#: ``users.name`` est un ``varchar(50)`` unique côté site, mais il sert aussi de
#: pseudo de connexion Yggdrasil : on reste sur le jeu de caractères sûr.
Username = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=3,
        max_length=50,
        pattern=r"^[A-Za-z0-9_]+$",
    ),
]

#: Mot de passe **présenté** (connexion, confirmation d'une action sensible).
#: Aucune borne basse : les comptes existants du site n'ont pas été créés sous
#: notre politique et ne doivent pas être invalidés rétroactivement
#: (``docs/DATA.md`` §3). Le refus se joue à la vérification, pas à la validation.
Password = Annotated[str, StringConstraints(min_length=1, max_length=128)]

#: Mot de passe **choisi** (inscription, réinitialisation) : 12 caractères minimum.
NewPassword = Annotated[str, StringConstraints(min_length=12, max_length=128)]

TotpCode = Annotated[str, StringConstraints(strip_whitespace=True, pattern=r"^\d{6}$")]

# Le champ « totp » de la connexion accepte aussi un code de secours (XXXXX-XXXXX).
TotpOrRecovery = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        pattern=r"^(?:\d{6}|[A-Za-z0-9]{4,6}-[A-Za-z0-9]{4,6})$",
    ),
]

#: UUID de profil Minecraft : l'UUID premium réel, sans tirets (``docs/DATA.md`` §8).
ProfileUuid = Annotated[str, StringConstraints(pattern=r"^[0-9a-fA-F]{32}$")]

Sha256Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-fA-F]{64}$")]

OpaqueToken = Annotated[str, StringConstraints(min_length=16, max_length=512)]

NewsKind = Literal["news", "event", "update"]
AuthModeOut = Literal["sovereign", "hybrid", "microsoft"]
MicrosoftFlowOut = Literal["embedded", "device"]
TierState = Literal["locked", "near", "unlocked"]
SkinModel = Literal["classic", "slim"]
TextureKindOut = Literal["skin", "cape"]

#: Valeurs possibles de ``user.blocked_reason`` (``docs/API.md`` §1.2).
BlockedReasonOut = Literal[
    "microsoft_required",
    "microsoft_expired",
    "ownership_missing",
    "banned",
    "email_unverified",
]


class ApiModel(BaseModel):
    """Base des objets de sortie : lisibles depuis un modèle SQLAlchemy."""

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


class ApiInput(BaseModel):
    """Base des objets d'entrée : tout champ inconnu est refusé."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class YggModel(BaseModel):
    """Base des objets Yggdrasil : alias camelCase, champs inconnus tolérés.

    Les clients Minecraft et les moddeurs ajoutent parfois des champs : les
    refuser casserait la connexion pour rien.
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")


# ---------------------------------------------------------------------------
# 1. Erreurs normalisées (docs/API.md section 3)
# ---------------------------------------------------------------------------
ErrorCode = Literal[
    "invalid_credentials",
    "totp_required",
    "totp_invalid",
    "token_expired",
    "token_revoked",
    "microsoft_required",
    "microsoft_expired",
    "ownership_missing",
    "already_linked",
    "email_taken",
    "username_taken",
    "banned",
    "rate_limited",
    "maintenance",
    "invalid_request",
    "not_found",
    "internal_error",
]


class ErrorOut(ApiModel):
    """Corps d'erreur de l'API launcher."""

    error: ErrorCode | str = Field(description="Code machine, stable dans le temps.")
    message: str = Field(description="Message en français, affichable tel quel.")
    details: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# 2. Bootstrap (GET /api/v1/bootstrap — docs/API.md §1.1)
# ---------------------------------------------------------------------------
class LauncherInfoOut(ApiModel):
    """Version attendue du launcher et lien de téléchargement.

    ``download_url`` vient de ``statistiques.launcher_windows / _mac / _linux``
    selon la plateforme qui interroge le serveur (``docs/DATA.md`` §1).
    """

    version_min: str
    version_latest: str
    download_url: str | None = None


class MaintenanceOut(ApiModel):
    """État de maintenance : bloque le bouton JOUER quand il est actif."""

    active: bool = False
    message: str | None = None
    eta: datetime | None = None


class AuthInfoOut(ApiModel):
    """Politique d'authentification en vigueur."""

    mode: AuthModeOut = "hybrid"
    microsoft_required: bool = True
    registration_open: bool = True
    flow: MicrosoftFlowOut = "embedded"


class ServerInfoOut(ApiModel):
    """Adresse du serveur de jeu (``statistiques.server_ip``)."""

    host: str
    port: int = Field(default=25565, ge=1, le=65535)


class LinksOut(ApiModel):
    """Liens du rail social (Discord, Twitch, YouTube, site)."""

    discord: str | None = None
    twitch: str | None = None
    youtube: str | None = None
    website: str | None = None


class BootstrapOut(ApiModel):
    """Première réponse lue par le launcher, avant toute authentification."""

    launcher: LauncherInfoOut
    maintenance: MaintenanceOut
    auth: AuthInfoOut
    server: ServerInfoOut
    links: LinksOut


# ---------------------------------------------------------------------------
# 3. Comptes OPM (docs/API.md §1.2)
# ---------------------------------------------------------------------------
class MicrosoftOut(ApiModel):
    """Volet Microsoft d'un compte : uniquement la preuve de possession.

    Aucun jeton Microsoft ne figure ici — ni ailleurs dans l'API : le
    ``refresh_token`` MSA est chiffré au repos et ne quitte jamais le serveur.
    """

    linked: bool = False
    minecraft_uuid: str | None = None
    minecraft_username: str | None = None
    verified_at: datetime | None = None
    expires_at: datetime | None = None
    owns_minecraft: bool = False

    @classmethod
    def unlinked(cls) -> MicrosoftOut:
        """Volet d'un compte sans rattachement."""
        return cls()

    @classmethod
    def from_link(cls, link: Any) -> MicrosoftOut:
        """Construit le volet à partir d'un ``McLink``."""
        return cls(
            linked=True,
            minecraft_uuid=link.minecraft_uuid,
            minecraft_username=link.minecraft_username,
            verified_at=link.verified_at,
            expires_at=link.expires_at,
            owns_minecraft=link.owns_minecraft,
        )


class SkinOut(ApiModel):
    """Apparence active du joueur, telle que le launcher l'affiche.

    Extension au sens strict de ``docs/API.md`` : le launcher sait déjà la lire
    (``src/main/auth/accounts.js``) et retombe sur le skin par défaut quand elle
    est absente. ``url`` est relative à ``OPM_PUBLIC_URL``.
    """

    url: str | None = None
    sha256: Sha256Hex | None = None
    model: SkinModel | None = None


class UserProfileOut(ApiModel):
    """Volet « VOTRE PERSONNAGE » : données RP, en **lecture seule**.

    Tout vient de la base du site (``users``, ``iles``) et appartient au serveur
    Minecraft : le launcher ne les écrit jamais (``docs/DATA.md`` §4).
    """

    faction: str | None = None
    metier: str | None = None
    equipage: str | None = None
    #: Nombre d'îles tenues par l'équipage du joueur (``COUNT`` sur ``iles``).
    iles_tenues: int = Field(default=0, ge=0)
    prime: int | None = None
    berry: int | None = None
    #: ``users.niveaubase``.
    niveau: int | None = None
    #: ``users.tempsdejeu``, en secondes.
    temps_de_jeu_s: int = Field(default=0, ge=0)

    @classmethod
    def from_user(cls, user: Any, *, iles_tenues: int = 0) -> UserProfileOut:
        """Extrait la fiche RP d'une ligne ``users``.

        Les chaînes vides du site (``faction`` et consorts sont ``NOT NULL`` mais
        souvent ``''``) deviennent ``None`` : l'interface préfère un tiret honnête
        à une étiquette vide.
        """

        def clean(value: Any) -> str | None:
            return value.strip() or None if isinstance(value, str) else None

        return cls(
            faction=clean(user.faction),
            metier=clean(user.metier),
            equipage=clean(user.equipage),
            iles_tenues=max(0, int(iles_tenues or 0)),
            prime=user.prime,
            berry=user.berry,
            niveau=user.niveaubase,
            temps_de_jeu_s=max(0, int(user.tempsdejeu or 0)),
        )


class UserOut(ApiModel):
    """Compte OPM tel que le launcher le connaît (``docs/API.md`` §1.2).

    ``id`` est l'**entier** ``users.id`` de la base du site, et ``username`` est
    ``users.name``. Le pseudo affiché *en jeu* n'est pas celui-ci : c'est
    ``microsoft.minecraft_username`` (``docs/DATA.md`` §8).

    ``email`` est typé ``str`` et non ``EmailStr`` : une adresse historique
    légèrement hors norme ne doit pas faire échouer la sérialisation d'un compte
    existant. La validation stricte s'applique en **entrée**, là où elle sert.
    """

    id: int
    email: str
    username: str
    role: str = "player"
    totp_enabled: bool = False
    #: ``users.datejoin`` — nullable dans la base du site.
    created_at: datetime | None = None

    profile: UserProfileOut = Field(default_factory=UserProfileOut)
    microsoft: MicrosoftOut = Field(default_factory=MicrosoftOut)
    skin: SkinOut | None = None

    #: Seule valeur regardée par le launcher pour activer le bouton JOUER.
    can_play: bool = False
    blocked_reason: BlockedReasonOut | None = None

    @classmethod
    def from_user(
        cls,
        user: Any,
        *,
        microsoft_required: bool,
        iles_tenues: int = 0,
        skin: SkinOut | None = None,
        now: datetime | None = None,
    ) -> UserOut:
        """Assemble la vue complète d'un compte, droit de jouer compris.

        Les règles dépendant de la configuration sont passées en paramètres : les
        schémas restent ainsi indépendants de ``config.py``. ``iles_tenues`` et
        ``skin`` viennent de requêtes que seule la couche service sait faire.
        """
        reason = user.blocked_reason(microsoft_required=microsoft_required, now=now)
        link = user.mc_link
        return cls(
            id=user.id,
            email=user.email,
            username=user.name,
            role=user.role,
            totp_enabled=user.totp_enabled,
            created_at=user.datejoin,
            profile=UserProfileOut.from_user(user, iles_tenues=iles_tenues),
            microsoft=MicrosoftOut.from_link(link) if link else MicrosoftOut.unlinked(),
            skin=skin,
            can_play=reason is None,
            blocked_reason=reason,
        )


class RegisterIn(ApiInput):
    """Création d'un compte OPM — le même compte que sur le site."""

    email: Email
    password: NewPassword
    username: Username


class LoginIn(ApiInput):
    """Connexion. ``totp`` est requis si la double authentification est active."""

    email: Email
    password: Password
    totp: TotpOrRecovery | None = None


class TokenPairOut(ApiModel):
    """Couple de jetons délivré par ``/auth/login`` et ``/auth/refresh``."""

    access_token: str
    refresh_token: str
    expires_in: int = Field(description="Durée de vie de l'access_token, en secondes.")
    token_type: Literal["Bearer"] = "Bearer"


class LoginOut(TokenPairOut):
    """Réponse de connexion : jetons + compte complet."""

    user: UserOut


class RefreshIn(ApiInput):
    """Renouvellement des jetons. Le refresh_token est à usage unique."""

    refresh_token: OpaqueToken


class RefreshOut(TokenPairOut):
    """Nouveau couple de jetons après rotation."""


class LogoutIn(ApiInput):
    """Révocation d'un refresh_token (et de toute sa famille)."""

    refresh_token: OpaqueToken


class ForgotPasswordIn(ApiInput):
    """Demande de réinitialisation. La réponse est toujours 202 (anti-énumération)."""

    email: Email


class ResetPasswordIn(ApiInput):
    """Réinitialisation effective, avec le jeton reçu par courriel."""

    token: OpaqueToken
    password: NewPassword


class TotpSetupOut(ApiModel):
    """Secret TOTP à afficher en QR code, et codes de secours à imprimer."""

    secret: str
    otpauth_uri: str
    recovery_codes: list[str]


class TotpEnableIn(ApiInput):
    """Activation de la 2FA : confirme que l'application génère le bon code."""

    code: TotpCode


class TotpDisableIn(ApiInput):
    """Désactivation de la 2FA : mot de passe **et** code valide exigés."""

    password: Password
    code: TotpOrRecovery


# ---------------------------------------------------------------------------
# 4. Rattachement Microsoft (docs/API.md §1.3)
# ---------------------------------------------------------------------------
class LinkStartEmbeddedOut(ApiModel):
    """Flux « embedded » : le launcher ouvre une fenêtre et récupère un code."""

    flow: Literal["embedded"] = "embedded"
    authorize_url: str
    redirect_uri: str
    state: str


class LinkStartDeviceOut(ApiModel):
    """Flux « device » : le joueur saisit un code sur microsoft.com/link."""

    flow: Literal["device"] = "device"
    verification_uri: str
    user_code: str
    device_code: str
    interval: int = Field(default=5, ge=1)
    expires_in: int = Field(default=900, ge=1)


LinkStartOut = Annotated[
    LinkStartEmbeddedOut | LinkStartDeviceOut,
    Field(discriminator="flow"),
]


class LinkCompleteIn(ApiInput):
    """Le launcher transmet le code d'autorisation : il ne l'échange jamais lui-même."""

    state: str = Field(min_length=8, max_length=256)
    code: str = Field(min_length=4, max_length=4096)


class LinkPollIn(ApiInput):
    """Interrogation périodique du flux « device »."""

    device_code: str = Field(min_length=4, max_length=4096)


class LinkPendingOut(ApiModel):
    """Réponse 202 tant que le joueur n'a pas validé côté Microsoft."""

    status: Literal["pending"] = "pending"
    interval: int = Field(default=5, ge=1)


class UnlinkIn(ApiInput):
    """Dissociation du compte Microsoft : mot de passe OPM exigé."""

    password: Password


# ---------------------------------------------------------------------------
# 5. Session de jeu (POST /api/v1/game/session — docs/API.md §1.4)
# ---------------------------------------------------------------------------
class GameSessionMetaOut(ApiModel):
    """Métadonnées transmises telles quelles à minecraft-java-core."""

    type: str = "OPM"
    demo: bool = False
    expires_at: datetime


class GameSessionOut(ApiModel):
    """Session Yggdrasil maison, directement exploitable par le launcher.

    La forme est calquée sur l'objet ``authenticator`` de minecraft-java-core.
    ``uuid`` est l'UUID premium réel et ``name`` le pseudo Minecraft : ce sont eux
    que le serveur de jeu connaît, pas ``users.name``.
    """

    access_token: str
    client_token: str
    uuid: ProfileUuid
    name: str
    user_properties: str = "{}"
    meta: GameSessionMetaOut


class GameSessionEndIn(ApiInput):
    """Fin d'une session de jeu : la durée vient s'ajouter à ``users.tempsdejeu``."""

    client_token: str | None = Field(default=None, max_length=64)
    duration_s: int = Field(ge=0, le=86_400, description="Durée jouée, en secondes.")


# ---------------------------------------------------------------------------
# 6. Contenu du launcher (docs/API.md §1.5)
# ---------------------------------------------------------------------------
#: Longueur maximale d'un chapô dérivé du corps d'un article.
EXCERPT_LENGTH = 200

_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")

#: ``article.categorie`` est un ``varchar(50)`` libre : on le replie (minuscules,
#: accents retirés) avant de le traduire en ``kind`` d'API. Toute valeur inconnue
#: retombe sur ``news`` — ajouter une catégorie ne demande aucune migration.
NEWS_KIND_BY_CATEGORIE: dict[str, NewsKind] = {
    "actualite": "news",
    "actualites": "news",
    "news": "news",
    "journal": "news",
    "evenement": "event",
    "evenements": "event",
    "event": "event",
    "mise a jour": "update",
    "mises a jour": "update",
    "maj": "update",
    "update": "update",
    "patch note": "update",
}


def _fold(value: str) -> str:
    """Replie une chaîne : minuscules, accents retirés, espaces normalisés."""
    decomposed = unicodedata.normalize("NFKD", value)
    stripped = "".join(char for char in decomposed if not unicodedata.combining(char))
    return _WHITESPACE_RE.sub(" ", stripped).strip().lower()


def news_kind_of(categorie: str | None) -> NewsKind:
    """Traduit ``article.categorie`` en ``kind`` d'API (défaut : ``news``)."""
    if not categorie:
        return "news"
    return NEWS_KIND_BY_CATEGORIE.get(_fold(categorie), "news")


def make_excerpt(content: str | None, *, limit: int = EXCERPT_LENGTH) -> str | None:
    """Dérive un chapô du corps d'un article : balises retirées, texte tronqué.

    Le contenu du site est du HTML : on retire les balises, on décode les
    entités, on écrase les blancs, puis on coupe à ``limit`` caractères — sur un
    mot entier quand c'est possible, pour ne pas afficher une syllabe orpheline.
    """
    if not content:
        return None

    text = html.unescape(_TAG_RE.sub(" ", content))
    text = _WHITESPACE_RE.sub(" ", text).strip()
    if not text:
        return None
    if len(text) <= limit:
        return text

    cut = text[:limit].rstrip()
    space = cut.rfind(" ")
    if space > limit * 0.6:  # ne coupe sur un mot que si ça ne mutile pas la phrase
        cut = cut[:space]
    return cut.rstrip(" ,;:.–—-") + "…"


def article_url(raw: str | None, site_url: str | None = None) -> str | None:
    """Rend l'adresse ouvrable d'un article à partir de ce que stocke le site.

    La colonne ``article.url`` contient un **slug** (« la-v7-une-version-
    nostalgique »), que le site sert à sa racine. Livré tel quel au launcher,
    il était refusé par le garde-fou « http(s) seulement » de l'ouverture des
    liens, et le joueur lisait « Le navigateur n'a pas pu être lancé ».

    Une valeur déjà absolue est rendue telle quelle : si le site change un jour
    de convention et stocke des adresses complètes, rien ne casse.
    """
    slug = (raw or "").strip()
    if not slug:
        return None
    if slug.startswith(("http://", "https://")):
        return slug
    if site_url is None:
        from opm_auth.config import get_settings  # import différé : schemas.py reste sans dépendance

        site_url = get_settings().site_url
    return f"{site_url.rstrip('/')}/{slug.lstrip('/')}"


class NewsItemOut(ApiModel):
    """Entrée du **JOURNAL DE BORD**, dérivée d'une ligne ``article``."""

    id: int
    kind: NewsKind = "news"
    title: str
    excerpt: str | None = None
    body_html: str | None = None
    published_at: datetime | None = None
    url: str | None = None
    image: str | None = None
    author: str | None = None

    @classmethod
    def from_article(
        cls, article: Any, *, with_body: bool = False, site_url: str | None = None
    ) -> NewsItemOut:
        """Construit une entrée à partir d'un ``Article``.

        ``kind`` est dérivé de ``article.categorie`` et ``excerpt`` du contenu :
        la table du site n'a ni l'un ni l'autre, et il n'est pas question de lui
        ajouter des colonnes pour ça.

        :param with_body: joint le HTML complet (vue détaillée). La liste ne le
            transporte pas : trois articles suffisent à alourdir la réponse.
        :param site_url: base publique du site, pour transformer le slug de
            ``article.url`` en adresse. ``None`` = lue dans la configuration.
        """
        return cls(
            id=article.id,
            kind=news_kind_of(article.categorie),
            title=article.title,
            excerpt=make_excerpt(article.content),
            body_html=article.content if with_body else None,
            published_at=article.published_date,
            url=article_url(article.url, site_url),
            image=article.image or None,
            author=(article.auteur or None),
        )


class NewsOut(ApiModel):
    """Une actualité mise en avant, puis la liste des suivantes."""

    featured: NewsItemOut | None = None
    items: list[NewsItemOut] = Field(default_factory=list)

    @classmethod
    def from_articles(cls, articles: list[Any], *, site_url: str | None = None) -> NewsOut:
        """Assemble le journal : la plus récente en vedette, les autres en liste.

        Les articles sont attendus **déjà triés** ``published_date DESC`` par le
        service ; le tri est une décision SQL, pas une décision de schéma.
        """
        if not articles:
            return cls()
        return cls(
            featured=NewsItemOut.from_article(articles[0], site_url=site_url),
            items=[NewsItemOut.from_article(article, site_url=site_url) for article in articles[1:]],
        )


class InstanceLoaderOut(ApiModel):
    """Chargeur de mods d'une instance.

    Les noms de champs (``loadder``) reprennent volontairement ceux de l'ancien
    launcher : minecraft-java-core les attend tels quels, faute de frappe comprise.
    """

    minecraft_version: str
    loadder_type: str = "none"
    loadder_version: str | None = None


class InstanceStatusOut(ApiModel):
    """Serveur associé à une instance, pour l'affichage du statut."""

    ip: str
    port: int = Field(default=25565, ge=1, le=65535)
    name_server: str | None = Field(default=None, alias="nameServer")


class InstanceOut(ApiModel):
    """Instance de jeu. Format identique à celui de l'ancien launcher."""

    name: str
    url: str
    verify: bool = False
    ignored: list[str] = Field(default_factory=list)
    loadder: InstanceLoaderOut
    status: InstanceStatusOut | None = None
    whitelist_active: bool = Field(default=False, alias="whitelistActive")
    whitelist: list[str] = Field(default_factory=list)

    @classmethod
    def from_instance(cls, instance: Any) -> InstanceOut:
        """Traduit une ligne ``launcher_instance`` en objet attendu par le launcher."""
        status = None
        if instance.status_host:
            status = InstanceStatusOut(
                ip=instance.status_host,
                port=instance.status_port or 25565,
                name_server=instance.display_name,
            )
        return cls(
            name=instance.name,
            url=instance.url,
            verify=bool(instance.verify),
            ignored=list(instance.ignored or []),
            loadder=InstanceLoaderOut(
                minecraft_version=instance.version,
                loadder_type=instance.loader_type,
                loadder_version=instance.loader_version,
            ),
            status=status,
            whitelist_active=bool(instance.whitelist_active),
            whitelist=list(instance.whitelist or []),
        )


class ServerStatusOut(ApiModel):
    """Statut temps réel du serveur Minecraft.

    ``tps`` et ``latency_ms`` n'existent pas dans le schéma du site : ils restent
    en cache mémoire côté serveur d'auth (``docs/DATA.md`` §4).
    """

    online: bool = False
    players_online: int = Field(default=0, ge=0)
    players_max: int = Field(default=0, ge=0)
    tps: float | None = Field(default=None, ge=0, le=20)
    motd: str | None = None
    latency_ms: int | None = Field(default=None, ge=0)
    #: Record de fréquentation (``statistiques.record_joueurs``).
    record_players: int | None = Field(default=None, ge=0)
    #: Date du record, telle que le site la stocke (texte libre).
    record_date: str | None = None


class NextEventOut(ApiModel):
    """Prochain événement RP, pour le compte à rebours de l'accueil."""

    title: str
    starts_at: datetime | None = None
    description: str | None = None

    @classmethod
    def from_stats(cls, stats: Any) -> NextEventOut:
        """Mappe ``statistiques.evenement_nom`` / ``evenement_date``."""
        return cls(
            title=(stats.evenement_nom or "").strip(),
            starts_at=stats.evenement_date,
        )


class VotesOut(ApiModel):
    """Compteur de votes du mois et récompense associée."""

    count: int = Field(default=0, ge=0)
    goal: int = Field(default=0, ge=0)
    reward: str | None = None
    reset_at: datetime | None = None
    #: Page de vote du site ; le launcher l'ouvre plutôt que la page d'accueil.
    url: str | None = None

    @classmethod
    def from_stats(
        cls,
        stats: Any,
        *,
        reward: str | None = None,
        url: str | None = None,
    ) -> VotesOut:
        """Mappe ``statistiques.votes`` / ``votes_objectif``."""
        return cls(
            count=max(0, int(stats.votes or 0)),
            goal=max(0, int(stats.votes_objectif or 0)),
            reward=reward,
            url=url,
        )


class DonationTierOut(ApiModel):
    """Palier de la cagnotte : verrouillé, à portée, ou débloqué.

    ``amount_cents`` est le **seuil** du palier, calculé depuis l'objectif
    (25 / 50 / 75 / 100 %). Le launcher recalcule l'état de son côté à partir du
    montant réellement collecté : les deux doivent concorder.
    """

    id: str
    label: str
    amount_cents: int = Field(ge=0)
    state: TierState = "locked"
    description: str | None = None


class DonorOut(ApiModel):
    """Ligne du classement des donateurs.

    Conservée pour le jour où la partie paiement du site existera : aujourd'hui,
    **aucune** instance n'est jamais produite (voir :attr:`DonationsOut.top`).
    """

    rank: int = Field(ge=1)
    name: str
    tier: str | None = None
    amount_cents: int = Field(ge=0)


class DonationsOut(ApiModel):
    """État de la cagnotte du mois (``docs/API.md`` §1.5, ``docs/DATA.md`` §2).

    Tout vient de ``statistiques`` : il n'existe **aucune** table de dons, la
    partie paiement du site n'étant pas terminée.
    """

    collected_cents: int = Field(default=0, ge=0)
    goal_cents: int = Field(default=0, ge=0)
    currency: str = "EUR"
    donors_count: int = Field(default=0, ge=0)
    days_left: int | None = Field(default=None, ge=0)
    tiers: list[DonationTierOut] = Field(default_factory=list)
    #: **Toujours vide.** Le classement des donateurs n'a aucune source dans la
    #: base : le launcher affiche un état vide honnête (« Le classement des
    #: donateurs arrive bientôt ») plutôt que trois faux donateurs. Le champ
    #: reste au contrat pour le jour où une table de dons existera.
    top: list[DonorOut] = Field(default_factory=list)
    #: Page du site détaillant les avantages (bouton « AVANTAGES »).
    perks_url: str | None = None

    @classmethod
    def from_stats(
        cls,
        stats: Any,
        *,
        currency: str = "EUR",
        tiers: list[DonationTierOut] | None = None,
        days_left: int | None = None,
        perks_url: str | None = None,
    ) -> DonationsOut:
        """Mappe la cagnotte du site.

        **Attention aux unités** : ``statistiques.dons_collecte`` et
        ``dons_objectif`` sont des **euros entiers** (« 142 € / 200 € »), alors que
        l'API parle en **centimes**. La conversion se fait ici, une fois pour toutes.
        """
        return cls(
            collected_cents=max(0, int(stats.dons_collecte or 0)) * 100,
            goal_cents=max(0, int(stats.dons_objectif or 0)) * 100,
            currency=currency,
            donors_count=max(0, int(stats.donateurs or 0)),
            days_left=days_left,
            tiers=tiers or [],
            top=[],
            perks_url=perks_url,
        )


class DonateCheckoutIn(ApiInput):
    """Montant choisi, en centimes (les bornes sont vérifiées côté service)."""

    amount_cents: int = Field(ge=1)


class DonateCheckoutOut(ApiModel):
    """URL de don, ouverte dans le navigateur par le launcher.

    Aucun paiement n'a lieu dans le launcher : le serveur renvoie simplement
    ``OPM_DONATION_URL`` (``docs/DATA.md`` §2).
    """

    checkout_url: str


# ---------------------------------------------------------------------------
# 7. Protocole Yggdrasil (authlib-injector — docs/API.md §2)
# ---------------------------------------------------------------------------
class YggErrorOut(YggModel):
    """Erreur au format Mojang, renvoyée en HTTP 403 la plupart du temps."""

    error: str = "ForbiddenOperationException"
    error_message: str = Field(alias="errorMessage")
    cause: str | None = None


class YggPropertyOut(YggModel):
    """Propriété signée d'un profil (``textures`` en pratique)."""

    name: str
    value: str
    signature: str | None = None


class YggProfileOut(YggModel):
    """Profil Minecraft : UUID premium réel sans tirets, et pseudo Minecraft."""

    id: str
    name: str
    properties: list[YggPropertyOut] | None = None


class YggUserOut(YggModel):
    """Bloc ``user``, renvoyé seulement si ``requestUser`` vaut vrai."""

    id: str
    properties: list[YggPropertyOut] = Field(default_factory=list)


class YggAgentIn(YggModel):
    """Agent déclaré par le client (toujours « Minecraft », version 1)."""

    name: str = "Minecraft"
    version: int = 1


class YggAuthenticateIn(YggModel):
    """``POST /yggdrasil/authserver/authenticate``."""

    username: str = Field(max_length=320)
    password: str = Field(max_length=128)
    client_token: str | None = Field(default=None, alias="clientToken", max_length=128)
    request_user: bool = Field(default=False, alias="requestUser")
    agent: YggAgentIn | None = None


class YggAuthenticateOut(YggModel):
    """Réponse commune à ``authenticate`` et ``refresh``."""

    access_token: str = Field(alias="accessToken")
    client_token: str = Field(alias="clientToken")
    available_profiles: list[YggProfileOut] = Field(default_factory=list, alias="availableProfiles")
    selected_profile: YggProfileOut | None = Field(default=None, alias="selectedProfile")
    user: YggUserOut | None = None


class YggRefreshIn(YggModel):
    """``POST /yggdrasil/authserver/refresh``."""

    access_token: str = Field(alias="accessToken", max_length=4096)
    client_token: str | None = Field(default=None, alias="clientToken", max_length=128)
    request_user: bool = Field(default=False, alias="requestUser")
    selected_profile: YggProfileOut | None = Field(default=None, alias="selectedProfile")


class YggValidateIn(YggModel):
    """``POST /yggdrasil/authserver/validate`` et ``/invalidate``."""

    access_token: str = Field(alias="accessToken", max_length=4096)
    client_token: str | None = Field(default=None, alias="clientToken", max_length=128)


class YggSignoutIn(YggModel):
    """``POST /yggdrasil/authserver/signout`` : invalide toutes les sessions."""

    username: str = Field(max_length=320)
    password: str = Field(max_length=128)


class YggJoinIn(YggModel):
    """``POST /yggdrasil/sessionserver/session/minecraft/join``."""

    access_token: str = Field(alias="accessToken", max_length=4096)
    selected_profile: ProfileUuid = Field(alias="selectedProfile")
    server_id: str = Field(alias="serverId", max_length=64)


class YggTextureMetadata(YggModel):
    """Métadonnées d'un skin : uniquement le modèle de bras."""

    model: Literal["slim"] | None = None


class YggTextureEntry(YggModel):
    """Une texture publiée dans la propriété ``textures``."""

    url: str
    metadata: YggTextureMetadata | None = None


class YggTexturesPayload(YggModel):
    """Charge utile encodée en base64 dans la propriété ``textures``."""

    timestamp: int = Field(description="Millisecondes depuis l'époque Unix.")
    profile_id: str = Field(alias="profileId")
    profile_name: str = Field(alias="profileName")
    signature_required: bool = Field(default=True, alias="signatureRequired")
    textures: dict[Literal["SKIN", "CAPE"], YggTextureEntry] = Field(default_factory=dict)


class YggMetaLinksOut(YggModel):
    """Liens affichés par authlib-injector dans le client.

    Le champ ``register`` est exposé sous son nom de protocole via un alias :
    l'attribut Python porte un autre nom pour ne pas masquer une méthode héritée.
    """

    homepage: str
    register_url: str = Field(alias="register")


class YggMetaOut(YggModel):
    """Bloc ``meta`` des métadonnées Yggdrasil."""

    server_name: str = Field(alias="serverName")
    implementation_name: str = Field(default="opm-yggdrasil", alias="implementationName")
    implementation_version: str = Field(default="1.0.0", alias="implementationVersion")
    links: YggMetaLinksOut
    # Autorise la connexion par pseudo en plus de l'adresse e-mail.
    feature_non_email_login: bool = Field(default=True, alias="feature.non_email_login")


class YggRootOut(YggModel):
    """``GET /yggdrasil`` : ce que lit authlib-injector au démarrage du serveur."""

    meta: YggMetaOut
    skin_domains: list[str] = Field(default_factory=list, alias="skinDomains")
    signature_publickey: str = Field(alias="signaturePublickey")


# ``POST /yggdrasil/api/profiles/minecraft`` reçoit un tableau JSON nu de pseudos
# (et non un objet) : le routeur annote directement son corps avec ce type.
YggProfileNames = Annotated[
    list[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=16)]],
    Field(max_length=100),
]


# ---------------------------------------------------------------------------
# 8. Textures (skins et capes — docs/API.md §2.5)
# ---------------------------------------------------------------------------
class TextureOut(ApiModel):
    """Texture active d'un joueur."""

    kind: TextureKindOut
    url: str
    model: SkinModel | None = None
    sha256: Sha256Hex
    uploaded_at: datetime | None = None

    @classmethod
    def from_texture(
        cls,
        texture: Any,
        *,
        kind: str,
        updated_at: datetime | None = None,
    ) -> TextureOut:
        """Construit la vue publique d'une ligne ``texture``."""
        return cls(
            kind=kind,  # type: ignore[arg-type]
            url=f"/textures/{texture.sha256}.png",
            model=texture.model,
            sha256=texture.sha256,
            uploaded_at=updated_at or texture.created_at,
        )


class TextureUploadOut(ApiModel):
    """Confirmation d'un téléversement de skin ou de cape."""

    texture: TextureOut
    message: str = "Texture enregistrée."
