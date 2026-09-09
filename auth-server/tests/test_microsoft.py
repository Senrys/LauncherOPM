"""Tests du rattachement Microsoft et de l'import de skin.

Toute la chaîne Microsoft est **simulée** (``httpx.MockTransport``) : aucun test
ne sort sur le réseau, et les deux transports — celui de la chaîne d'oracle
(:mod:`opm_auth.services.microsoft`) et celui du téléchargement de textures
(:mod:`opm_auth.services.textures`) — sont posés par des fixtures ``autouse``.
Un appel sortant oublié se solde donc par une erreur bruyante, jamais par une
requête réelle vers Microsoft.

Ce qui est vérifié ici — et pourquoi
====================================

* **L'UUID est le vrai.** Le profil renvoyé par ``/minecraft/profile`` porte
  l'UUID premium, tirets compris ; c'est lui, normalisé en 32 caractères, qui
  atterrit dans ``auth_mc_link.minecraft_uuid``. Aucun UUID n'est fabriqué :
  c'est la condition pour qu'un joueur ne perde ni claims, ni permissions, ni
  progression (``docs/DATA.md`` §8).

* **Le skin suit tout seul.** Le rattachement importe l'apparence dans la foulée,
  la ré-encode, l'adresse par son ``sha256`` et la sert en cache immuable
  (``docs/DATA.md`` §6).

* **Un import raté ne bloque rien.** Serveur de textures en panne : le
  rattachement réussit quand même et le joueur garde le skin par défaut. C'est
  le test qui protège la règle la plus facile à casser par accident.

* **Un compte Minecraft, un seul compte OPM** — ``409 already_linked``, garanti
  par deux contraintes ``UNIQUE`` (``docs/DATA.md`` §8).

* **Le cache de 30 jours tient la souveraineté.** Une re-vérification dans la
  fenêtre n'émet **aucun** appel vers Microsoft : c'est exactement ce que l'on
  achète en hébergeant son propre Yggdrasil (``docs/DATA.md`` §7).

* **Aucun jeton Microsoft ne sort du serveur** : ni dans une réponse HTTP, ni en
  clair dans la base (``docs/API.md`` §0).
"""

from __future__ import annotations

import io
import re
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from datetime import timedelta

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from PIL import Image
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from opm_auth.config import get_settings
from opm_auth.models import Audit, McLink, Texture, TextureKind, UserTexture, utcnow
from opm_auth.routers.auth import router as auth_router
from opm_auth.routers.microsoft import router as microsoft_router
from opm_auth.routers.textures import router as textures_router
from opm_auth.security.deps import ApiError, api_error_handler
from opm_auth.services import microsoft, textures
from tests.conftest import (
    API_PREFIX,
    PASSWORD,
    USERNAME,
    Account,
    register,
    sign_in,
)

#: Racine du rattachement Microsoft.
LINK = f"{API_PREFIX}/link/microsoft"

#: Adresse du skin annoncée par Microsoft. L'hôte figure dans la liste blanche
#: de ``services/textures.py`` : c'est celui que Mojang utilise réellement.
SKIN_URL = "http://textures.minecraft.net/texture/9f8e7d6c5b4a"
CAPE_URL = "http://textures.minecraft.net/texture/0a1b2c3d4e5f"

#: Une adresse que la liste blanche doit refuser (défense contre le SSRF).
HOSTILE_SKIN_URL = "http://127.0.0.1:9/texture/interne"

#: UUID premium tel que Microsoft le renvoie — avec ses tirets.
PROFILE_UUID = "4f2a9c81-b0e6-4d7e-8b1c-2d3e4f5a6b7c"
#: Le même, tel qu'il doit être stocké : 32 caractères, sans tiret, en minuscules.
PROFILE_UUID_HEX = "4f2a9c81b0e64d7e8b1c2d3e4f5a6b7c"

#: Pseudo **en jeu** — volontairement différent de ``users.name`` (``USERNAME``),
#: pour prouver que les deux ne sont jamais confondus (``docs/DATA.md`` §8).
PROFILE_NAME = "MelodiaMC"

#: Jeton de rafraîchissement Microsoft : il ne doit apparaître nulle part.
MSA_REFRESH_TOKEN = "M.R3_BAY.refresh-microsoft-tres-secret"

#: ``XErr`` d'un compte Microsoft refusé par XSTS (compte sans profil Xbox /
#: rattaché à un groupe familial). Le code et le message viennent du service :
#: le test ne réécrit pas la table de Microsoft.
XERR_CHILD = 2148916233

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


# --------------------------------------------------------------------------- #
# Images de test
# --------------------------------------------------------------------------- #


#: Couleur par défaut des images de test (un rouge franc, sans signification).
RED: tuple[int, int, int, int] = (204, 34, 34, 255)


def png(
    width: int = 64,
    height: int = 64,
    colour: tuple[int, int, int, int] = RED,
) -> bytes:
    """Fabrique un vrai PNG, décodable par Pillow.

    Un fichier réel, et non une suite d'octets ressemblant à un PNG : c'est la
    seule façon de prouver que la validation décode vraiment l'image.
    """
    buffer = io.BytesIO()
    Image.new("RGBA", (width, height), colour).save(buffer, format="PNG")
    return buffer.getvalue()


# --------------------------------------------------------------------------- #
# Chaîne Microsoft simulée
# --------------------------------------------------------------------------- #


@dataclass
class Chain:
    """Chaîne Microsoft complète, simulée étape par étape.

    Chaque attribut est un bouton : ``xsts_xerr`` fait échouer XSTS,
    ``profile_status = 404`` simule un compte Microsoft sans Minecraft,
    ``device_pending`` fait patienter le flux « device ».

    :ivar calls: étapes réellement appelées, dans l'ordre. C'est ce qui permet
        d'affirmer qu'une re-vérification servie depuis le cache n'a joint
        Microsoft **à aucun moment**.
    """

    msa_sub: str = "msa-melodia-0001"
    xuid: str = "2535412345678901"
    refresh_token: str = MSA_REFRESH_TOKEN
    profile_uuid: str = PROFILE_UUID
    profile_name: str = PROFILE_NAME
    skin_url: str | None = SKIN_URL
    skin_variant: str = "SLIM"
    cape_url: str | None = None
    xsts_xerr: int | None = None
    profile_status: int = 200
    entitlements: tuple[str, ...] = ("product_minecraft", "game_minecraft")
    device_pending: bool = False
    calls: list[str] = field(default_factory=list)

    def handle(self, request: httpx.Request) -> httpx.Response:
        """Répond à la place de Microsoft, selon l'URL demandée."""
        settings = get_settings()
        url = str(request.url).split("?", 1)[0]

        if url == settings.msa_device_code_url:
            self.calls.append("device_code")
            return httpx.Response(
                200,
                json={
                    "device_code": "device-code-microsoft",
                    "user_code": "H8KQ-2LMP",
                    "verification_uri": "https://microsoft.com/link",
                    "interval": 5,
                    "expires_in": 900,
                },
            )

        if url == settings.msa_device_token_url:
            self.calls.append("device_token")
            if self.device_pending:
                return httpx.Response(400, json={"error": "authorization_pending", "interval": 5})
            return httpx.Response(200, json=self._tokens())

        if url == settings.msa_token_url:
            self.calls.append("token")
            return httpx.Response(200, json=self._tokens())

        if url == settings.xbl_auth_url:
            self.calls.append("xbl")
            return httpx.Response(
                200,
                json={
                    "Token": "jeton-xbl",
                    "DisplayClaims": {"xui": [{"uhs": "uhs-melodia", "xid": self.xuid}]},
                },
            )

        if url == settings.xsts_auth_url:
            self.calls.append("xsts")
            if self.xsts_xerr is not None:
                return httpx.Response(401, json={"XErr": self.xsts_xerr})
            return httpx.Response(
                200,
                json={
                    "Token": "jeton-xsts",
                    "DisplayClaims": {"xui": [{"uhs": "uhs-melodia", "xid": self.xuid}]},
                },
            )

        if url == settings.mc_login_url:
            self.calls.append("mc_login")
            return httpx.Response(200, json={"access_token": "jeton-minecraft"})

        if url == settings.mc_entitlements_url:
            self.calls.append("entitlements")
            return httpx.Response(
                200, json={"items": [{"name": name} for name in self.entitlements]}
            )

        if url == settings.mc_profile_url:
            self.calls.append("profile")
            if self.profile_status != 200:
                return httpx.Response(self.profile_status, json={"error": "NOT_FOUND"})
            return httpx.Response(200, json=self._profile())

        # Une URL inattendue est une erreur de test, pas un cas à absorber.
        self.calls.append(f"inconnu:{url}")
        return httpx.Response(500, json={"error": "url_non_simulee"})

    def _tokens(self) -> dict[str, object]:
        """Réponse du point d'entrée OAuth de Microsoft."""
        return {
            "access_token": "jeton-microsoft",
            "refresh_token": self.refresh_token,
            "expires_in": 3600,
            "user_id": self.msa_sub,
        }

    def _profile(self) -> dict[str, object]:
        """Réponse de ``/minecraft/profile``, skin et cape compris."""
        skins = []
        if self.skin_url:
            skins.append(
                {
                    "id": "skin-actif",
                    "state": "ACTIVE",
                    "url": self.skin_url,
                    "variant": self.skin_variant,
                }
            )
        capes = []
        if self.cape_url:
            capes.append({"id": "cape-active", "state": "ACTIVE", "url": self.cape_url})
        return {
            "id": self.profile_uuid,
            "name": self.profile_name,
            "skins": skins,
            "capes": capes,
        }


@dataclass
class SkinServer:
    """Serveur de textures de Mojang, simulé.

    :ivar status: statut renvoyé — ``500`` simule la panne dont on veut prouver
        qu'elle ne bloque **rien**.
    :ivar overrides: contenu servi pour une URL précise (une cape n'a pas les
        mêmes dimensions qu'un skin).
    """

    status: int = 200
    payload: bytes = field(default_factory=png)
    overrides: dict[str, bytes] = field(default_factory=dict)
    calls: list[str] = field(default_factory=list)

    def handle(self, request: httpx.Request) -> httpx.Response:
        """Sert le PNG, ou l'erreur demandée par le test."""
        url = str(request.url)
        self.calls.append(url)
        if self.status != 200:
            return httpx.Response(self.status, text="indisponible")
        return httpx.Response(
            200,
            content=self.overrides.get(url, self.payload),
            headers={"Content-Type": "image/png"},
        )


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture(autouse=True)
def chain() -> Iterator[Chain]:
    """Branche la chaîne Microsoft simulée pour toute la durée du test."""
    stub = Chain()
    microsoft.set_transport(httpx.MockTransport(stub.handle))
    yield stub
    microsoft.set_transport(None)


@pytest.fixture(autouse=True)
def skin_server() -> Iterator[SkinServer]:
    """Branche le serveur de textures simulé pour toute la durée du test."""
    server = SkinServer()
    textures.set_transport(httpx.MockTransport(server.handle))
    yield server
    textures.set_transport(None)


@pytest.fixture
def app() -> FastAPI:
    """Application montant les trois surfaces utiles à ces tests.

    Remplace la fixture homonyme de ``conftest.py`` : il faut ici, en plus des
    comptes OPM, le rattachement Microsoft et le service des textures — c'est le
    trio que le launcher enchaîne au premier lancement.
    """
    application = FastAPI(title="OPM Microsoft (tests)")
    application.add_exception_handler(ApiError, api_error_handler)
    application.include_router(auth_router, prefix=API_PREFIX)
    application.include_router(microsoft_router, prefix=API_PREFIX)
    application.include_router(textures_router)
    return application


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    """Client HTTP asynchrone branché directement sur l'application ASGI."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as opened:
        yield opened


# --------------------------------------------------------------------------- #
# Utilitaires
# --------------------------------------------------------------------------- #


async def open_flow(client: AsyncClient, account: Account) -> str:
    """Ouvre un rattachement et retourne le ``state`` signé."""
    response = await client.post(f"{LINK}/start", headers=account.auth)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["flow"] == "embedded"
    return str(body["state"])


async def link(client: AsyncClient, account: Account) -> httpx.Response:
    """Déroule le rattachement complet et retourne la réponse de ``complete``."""
    state = await open_flow(client, account)
    return await client.post(
        f"{LINK}/complete",
        json={"state": state, "code": "code-autorisation-microsoft"},
        headers=account.auth,
    )


async def second_account(client: AsyncClient) -> Account:
    """Inscrit et connecte un deuxième compte OPM."""
    email = "second@exemple.fr"
    user = await register(client, email=email, username="Zorro")
    body = await sign_in(client, email=email)
    return Account(
        id=int(user["id"]),
        email=email,
        username="Zorro",
        password=PASSWORD,
        access_token=body["access_token"],
        refresh_token=body["refresh_token"],
    )


async def fetch_link(sessions: async_sessionmaker[AsyncSession], user_id: int) -> McLink | None:
    """Relit le rattachement d'un compte directement en base."""
    async with sessions() as session:
        row = (
            (await session.execute(select(McLink).where(McLink.user_id == user_id)))
            .scalars()
            .first()
        )
        await session.commit()
        return row


async def fetch_textures(sessions: async_sessionmaker[AsyncSession], user_id: int) -> list[Texture]:
    """Relit les textures actives d'un compte, directement en base."""
    async with sessions() as session:
        rows = (
            (
                await session.execute(
                    select(Texture)
                    .join(UserTexture, UserTexture.texture_id == Texture.id)
                    .where(UserTexture.user_id == user_id)
                )
            )
            .scalars()
            .all()
        )
        await session.commit()
        return list(rows)


async def fetch_actions(sessions: async_sessionmaker[AsyncSession], user_id: int) -> list[str]:
    """Liste les actions consignées dans ``auth_audit`` pour ce compte."""
    async with sessions() as session:
        rows = (
            (
                await session.execute(
                    select(Audit.action).where(Audit.user_id == user_id).order_by(Audit.id)
                )
            )
            .scalars()
            .all()
        )
        await session.commit()
        return [str(row) for row in rows]


# --------------------------------------------------------------------------- #
# 1. Ouverture du flux
# --------------------------------------------------------------------------- #


async def test_start_signe_un_state_de_dix_minutes(client: AsyncClient, account: Account) -> None:
    """``start`` remet une URL d'autorisation et un ``state`` signé.

    Le ``state`` porte sa propre péremption : le serveur ne garde aucun état
    entre ``start`` et ``complete`` (``docs/API.md`` §1.3).
    """
    response = await client.post(f"{LINK}/start", headers=account.auth)
    assert response.status_code == 200, response.text

    body = response.json()
    settings = get_settings()
    assert body["flow"] == "embedded"
    assert body["redirect_uri"] == settings.msa_redirect_uri
    assert body["authorize_url"].startswith(settings.msa_authorize_url)
    assert settings.msa_client_id in body["authorize_url"]
    assert len(body["state"]) > 16

    # La durée de vie est une décision de contrat, pas un réglage local.
    assert timedelta(minutes=10) == microsoft.STATE_TTL
    # Le state est vérifiable pour ce compte, et pour lui seul.
    microsoft.verify_state(str(account.id), body["state"])


async def test_start_exige_un_compte(client: AsyncClient) -> None:
    """Sans jeton d'accès, le rattachement ne s'ouvre pas."""
    response = await client.post(f"{LINK}/start")
    assert response.status_code == 401
    assert response.json()["error"] == "invalid_credentials"


async def test_state_d_un_autre_compte_est_refuse(client: AsyncClient, account: Account) -> None:
    """Un ``state`` volé est inutilisable sur un autre compte OPM."""
    etranger = microsoft.sign_state("999999")
    response = await client.post(
        f"{LINK}/complete",
        json={"state": etranger, "code": "code-autorisation-microsoft"},
        headers=account.auth,
    )
    assert response.status_code == 400
    assert response.json()["error"] == "microsoft_state_invalid"


# --------------------------------------------------------------------------- #
# 2. Rattachement réussi, skin compris
# --------------------------------------------------------------------------- #


async def test_rattachement_reussi_importe_le_skin(
    client: AsyncClient,
    account: Account,
    chain: Chain,
    skin_server: SkinServer,
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    """Le rattachement enregistre l'UUID premium **et** ramène l'apparence.

    C'est le scénario nominal de ``docs/DATA.md`` §6 et §8 : le joueur clique
    une fois, et il retrouve à la fois sa progression (l'UUID réel) et son
    apparence (le skin importé, désormais hébergé par nous).
    """
    chain.cape_url = CAPE_URL
    # Une cape est en 64×32 : servir un 64×64 la ferait, à juste titre, refuser.
    skin_server.overrides[CAPE_URL] = png(width=64, height=32, colour=(20, 20, 90, 255))

    response = await link(client, account)
    assert response.status_code == 200, response.text

    body = response.json()
    user = body["user"]

    # -- identité : l'UUID premier, normalisé, et le pseudo **en jeu** ---------
    assert user["microsoft"]["linked"] is True
    assert user["microsoft"]["minecraft_uuid"] == PROFILE_UUID_HEX
    assert user["microsoft"]["minecraft_username"] == PROFILE_NAME
    assert user["microsoft"]["owns_minecraft"] is True
    # Le pseudo OPM et le pseudo Minecraft restent deux choses distinctes.
    assert USERNAME != PROFILE_NAME
    assert user["username"] == USERNAME
    # La possession acquise, le bouton JOUER s'allume.
    assert user["can_play"] is True
    assert user["blocked_reason"] is None

    # -- apparence : importée, ré-encodée, adressée par son contenu ------------
    skin = user["skin"]
    assert skin is not None
    assert SHA256_RE.match(skin["sha256"])
    assert skin["model"] == "slim"
    assert skin["url"] == f"/textures/{skin['sha256']}.png"
    assert skin_server.calls == [SKIN_URL, CAPE_URL]

    stored = await fetch_textures(sessions, account.id)
    kinds = {texture.kind for texture in stored}
    assert kinds == {TextureKind.SKIN.value, TextureKind.CAPE.value}
    imported = next(t for t in stored if t.kind == TextureKind.SKIN.value)
    assert (imported.width, imported.height) == (64, 64)
    assert imported.source == "mojang_import"
    assert imported.bytes > 0

    # Le fichier existe vraiment sur le disque, à l'emplacement annoncé.
    assert textures.path_for(imported.sha256).is_file()

    # -- la texture est servie, publiquement et pour toujours ------------------
    served = await client.get(skin["url"])
    assert served.status_code == 200
    assert served.headers["content-type"] == "image/png"
    assert "immutable" in served.headers["cache-control"]
    assert "max-age=31536000" in served.headers["cache-control"]
    assert served.content.startswith(b"\x89PNG\r\n\x1a\n")


async def test_le_rattachement_ecrit_le_cache_de_trente_jours(
    client: AsyncClient,
    account: Account,
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    """``auth_mc_link`` porte la preuve, sa fenêtre et le jeton **chiffré**."""
    response = await link(client, account)
    assert response.status_code == 200, response.text

    stored = await fetch_link(sessions, account.id)
    assert stored is not None
    assert stored.minecraft_uuid == PROFILE_UUID_HEX
    assert stored.minecraft_username == PROFILE_NAME
    assert stored.owns_minecraft is True
    assert stored.expires_at - stored.verified_at == timedelta(days=30)

    # Le jeton Microsoft est en base, mais illisible : ni en clair dans le
    # chiffré, ni dans le nonce (``docs/API.md`` §0).
    assert stored.msa_refresh_enc
    assert stored.msa_refresh_nonce
    secret = MSA_REFRESH_TOKEN.encode("utf-8")
    assert secret not in bytes(stored.msa_refresh_enc)
    assert secret not in bytes(stored.msa_refresh_nonce)
    # ... et il se relit correctement, sinon la re-vérification silencieuse
    # serait impossible.
    assert microsoft._open_refresh_token(stored) == MSA_REFRESH_TOKEN


async def test_aucun_jeton_microsoft_dans_la_reponse(client: AsyncClient, account: Account) -> None:
    """Le launcher ne voit jamais un jeton Microsoft, même de loin."""
    response = await link(client, account)
    assert response.status_code == 200, response.text
    assert MSA_REFRESH_TOKEN not in response.text
    assert "jeton-microsoft" not in response.text
    assert "jeton-xsts" not in response.text
    assert "jeton-minecraft" not in response.text


async def test_le_rattachement_est_consigne(
    client: AsyncClient,
    account: Account,
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    """Chaque rattachement laisse une trace dans ``auth_audit``."""
    response = await link(client, account)
    assert response.status_code == 200, response.text

    actions = await fetch_actions(sessions, account.id)
    assert "microsoft_link" in actions


# --------------------------------------------------------------------------- #
# 3. Comptes Microsoft qui ne conviennent pas
# --------------------------------------------------------------------------- #


async def test_compte_sans_minecraft(
    client: AsyncClient,
    account: Account,
    chain: Chain,
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    """Un compte Microsoft sans Minecraft est refusé, et rien n'est enregistré.

    ``/minecraft/profile`` répond 404 : c'est la réponse de Microsoft pour un
    compte qui ne possède pas Java Edition.
    """
    chain.profile_status = 404

    response = await link(client, account)
    assert response.status_code == 403, response.text
    body = response.json()
    assert body["error"] == "ownership_missing"
    assert "Minecraft" in body["message"]

    assert await fetch_link(sessions, account.id) is None


async def test_compte_refuse_par_xbox(
    client: AsyncClient,
    account: Account,
    chain: Chain,
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    """Un ``XErr`` de XSTS devient un code stable et un message en français.

    Le code attendu est lu dans la table du service : c'est Microsoft qui
    publie ces numéros, le test n'a pas à les réinterpréter.
    """
    chain.xsts_xerr = XERR_CHILD
    expected_code, expected_message = microsoft.XSTS_ERRORS[XERR_CHILD]

    response = await link(client, account)
    assert response.status_code == 403, response.text
    body = response.json()
    assert body["error"] == expected_code
    assert body["message"] == expected_message
    assert body["details"] == {"xerr": XERR_CHILD}

    # La chaîne s'arrête net : on ne demande pas de jeton Minecraft.
    assert "mc_login" not in chain.calls
    assert await fetch_link(sessions, account.id) is None


async def test_un_compte_minecraft_un_seul_compte_opm(
    client: AsyncClient,
    account: Account,
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    """Le même compte Microsoft ne peut pas servir deux comptes OPM.

    C'est la contrainte ``UNIQUE`` de ``docs/DATA.md`` §8 : sans elle, deux
    joueurs entreraient en jeu sous le même UUID.
    """
    assert (await link(client, account)).status_code == 200

    autre = await second_account(client)
    response = await link(client, autre)

    assert response.status_code == 409, response.text
    body = response.json()
    assert body["error"] == "already_linked"
    assert body["details"] == {"conflict": "other_account"}

    assert await fetch_link(sessions, autre.id) is None
    # Le rattachement légitime, lui, n'a pas bougé.
    premier = await fetch_link(sessions, account.id)
    assert premier is not None and premier.minecraft_uuid == PROFILE_UUID_HEX


async def test_un_autre_compte_microsoft_exige_une_dissociation(
    client: AsyncClient, account: Account, chain: Chain
) -> None:
    """On ne remplace pas un compte Microsoft par un autre en silence."""
    assert (await link(client, account)).status_code == 200

    chain.msa_sub = "msa-quelqu-un-d-autre"
    chain.profile_uuid = "11112222333344445555666677778888"
    chain.profile_name = "AutreJoueur"

    response = await link(client, account)
    assert response.status_code == 409, response.text
    assert response.json()["details"] == {"conflict": "current_account"}


# --------------------------------------------------------------------------- #
# 4. Re-vérification : le cache de trente jours
# --------------------------------------------------------------------------- #


async def test_reverification_servie_depuis_le_cache(
    client: AsyncClient,
    account: Account,
    chain: Chain,
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    """Dans la fenêtre de 30 jours, **aucun** appel n'est émis vers Microsoft.

    C'est le test de la souveraineté : si Microsoft tombe, les joueurs déjà
    vérifiés continuent de jouer (``docs/DATA.md`` §7).
    """
    assert (await link(client, account)).status_code == 200
    avant = await fetch_link(sessions, account.id)
    assert avant is not None

    chain.calls.clear()
    response = await client.post(f"{LINK}/refresh", headers=account.auth)

    assert response.status_code == 200, response.text
    assert response.json()["user"]["can_play"] is True
    assert chain.calls == []

    apres = await fetch_link(sessions, account.id)
    assert apres is not None
    assert apres.verified_at == avant.verified_at
    assert apres.expires_at == avant.expires_at


async def expire_ownership(sessions: async_sessionmaker[AsyncSession], user_id: int) -> None:
    """Périme la fenêtre de possession pour forcer un vrai appel à Microsoft."""
    async with sessions() as session:
        await session.execute(
            update(McLink)
            .where(McLink.user_id == user_id)
            .values(expires_at=utcnow() - timedelta(days=1))
        )
        await session.commit()


async def test_reverification_hors_cache_interroge_microsoft(
    client: AsyncClient,
    account: Account,
    chain: Chain,
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    """Fenêtre écoulée : la chaîne est rejouée en silence, sans le joueur.

    Le ``refresh_token`` Microsoft conservé chiffré suffit : personne n'a à
    ressaisir quoi que ce soit (``docs/DATA.md`` §5).
    """
    assert (await link(client, account)).status_code == 200
    avant = await fetch_link(sessions, account.id)
    assert avant is not None

    await expire_ownership(sessions, account.id)
    chain.calls.clear()

    response = await client.post(f"{LINK}/refresh", headers=account.auth)

    assert response.status_code == 200, response.text
    assert response.json()["user"]["can_play"] is True
    assert chain.calls == ["token", "xbl", "xsts", "mc_login", "entitlements", "profile"]

    apres = await fetch_link(sessions, account.id)
    assert apres is not None
    assert apres.expires_at > avant.expires_at


async def test_reverification_retente_l_import_du_skin(
    client: AsyncClient,
    account: Account,
    skin_server: SkinServer,
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    """Un skin manqué au rattachement est rattrapé à la re-vérification.

    C'est la contrepartie du « jamais bloquant » : puisqu'on n'échoue pas sur un
    import raté, il faut bien le retenter un jour (``docs/DATA.md`` §6).
    """
    skin_server.status = 500
    assert (await link(client, account)).status_code == 200
    assert await fetch_textures(sessions, account.id) == []

    await expire_ownership(sessions, account.id)
    skin_server.status = 200
    skin_server.calls.clear()

    response = await client.post(f"{LINK}/refresh", headers=account.auth)

    assert response.status_code == 200, response.text
    assert skin_server.calls == [SKIN_URL]
    skin = response.json()["user"]["skin"]
    assert skin is not None and SHA256_RE.match(skin["sha256"])
    assert len(await fetch_textures(sessions, account.id)) == 1


async def test_reverification_sans_rattachement(client: AsyncClient, account: Account) -> None:
    """Re-vérifier sans rien à vérifier répond ``microsoft_required``."""
    response = await client.post(f"{LINK}/refresh", headers=account.auth)
    assert response.status_code == 403
    assert response.json()["error"] == "microsoft_required"


# --------------------------------------------------------------------------- #
# 5. L'import de skin n'est jamais bloquant
# --------------------------------------------------------------------------- #


async def test_echec_d_import_de_skin_non_bloquant(
    client: AsyncClient,
    account: Account,
    skin_server: SkinServer,
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    """Serveur de textures en panne : le rattachement réussit quand même.

    Refuser une possession pourtant prouvée parce qu'une image de quelques kilo-
    octets n'a pas pu être téléchargée serait absurde (``docs/DATA.md`` §6).
    """
    skin_server.status = 500

    response = await link(client, account)
    assert response.status_code == 200, response.text

    user = response.json()["user"]
    assert user["microsoft"]["linked"] is True
    assert user["can_play"] is True
    # Pas de skin : le launcher dessine la silhouette par défaut, il n'invente
    # aucune adresse.
    assert user["skin"] is None

    assert skin_server.calls == [SKIN_URL]
    assert await fetch_textures(sessions, account.id) == []
    # Le rattachement, lui, est bien en base.
    assert await fetch_link(sessions, account.id) is not None


async def test_skin_illisible_non_bloquant(
    client: AsyncClient,
    account: Account,
    skin_server: SkinServer,
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    """Un « PNG » qui n'en est pas un est ignoré, sans casser le rattachement.

    Le contrôle porte sur le **contenu** : l'en-tête ``Content-Type`` annoncé
    par le serveur distant ne vaut rien comme preuve.
    """
    skin_server.payload = b"GIF89a ceci n'est pas un PNG"

    response = await link(client, account)
    assert response.status_code == 200, response.text
    assert response.json()["user"]["skin"] is None
    assert await fetch_textures(sessions, account.id) == []


async def test_skin_aux_mauvaises_dimensions_ignore(
    client: AsyncClient,
    account: Account,
    skin_server: SkinServer,
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    """Un PNG valide mais hors format de skin est refusé, sans bloquer."""
    skin_server.payload = png(width=100, height=100)

    response = await link(client, account)
    assert response.status_code == 200, response.text
    assert response.json()["user"]["skin"] is None
    assert await fetch_textures(sessions, account.id) == []


async def test_skin_hors_liste_blanche_non_telecharge(
    client: AsyncClient,
    account: Account,
    chain: Chain,
    skin_server: SkinServer,
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    """Une adresse de skin hors liste blanche n'est même pas appelée.

    L'URL vient d'une réponse Microsoft, donc d'un tiers : la laisser désigner
    une adresse interne ferait de notre serveur un relais (SSRF).
    """
    chain.skin_url = HOSTILE_SKIN_URL

    response = await link(client, account)
    assert response.status_code == 200, response.text
    assert response.json()["user"]["skin"] is None
    assert skin_server.calls == []
    assert await fetch_textures(sessions, account.id) == []


# --------------------------------------------------------------------------- #
# 6. Flux « device »
# --------------------------------------------------------------------------- #


async def test_poll_en_attente(client: AsyncClient, account: Account, chain: Chain) -> None:
    """Tant que le joueur n'a pas validé, ``poll`` répond ``202``, pas une erreur."""
    chain.device_pending = True
    ticket = microsoft.sign_device_ticket(str(account.id), "device-code-microsoft", 900)

    response = await client.post(f"{LINK}/poll", json={"device_code": ticket}, headers=account.auth)

    assert response.status_code == 202, response.text
    assert response.json() == {"status": "pending", "interval": 5}


async def test_poll_aboutit(
    client: AsyncClient,
    account: Account,
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    """Une fois le code validé, ``poll`` rattache comme ``complete``."""
    ticket = microsoft.sign_device_ticket(str(account.id), "device-code-microsoft", 900)

    response = await client.post(f"{LINK}/poll", json={"device_code": ticket}, headers=account.auth)

    assert response.status_code == 200, response.text
    user = response.json()["user"]
    assert user["microsoft"]["minecraft_uuid"] == PROFILE_UUID_HEX
    assert user["skin"] is not None
    assert await fetch_link(sessions, account.id) is not None


async def test_ticket_d_appareil_d_un_autre_compte_refuse(
    client: AsyncClient, account: Account
) -> None:
    """Le ticket d'appareil est lié à un compte OPM : il n'est pas transférable."""
    etranger = microsoft.sign_device_ticket("999999", "device-code-microsoft", 900)

    response = await client.post(
        f"{LINK}/poll", json={"device_code": etranger}, headers=account.auth
    )

    assert response.status_code == 400
    assert response.json()["error"] == "device_invalid"


# --------------------------------------------------------------------------- #
# 7. Dissociation
# --------------------------------------------------------------------------- #


async def test_dissociation_exige_le_mot_de_passe(
    client: AsyncClient,
    account: Account,
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    """Une session volée ne suffit pas à libérer le compte Minecraft."""
    assert (await link(client, account)).status_code == 200

    response = await client.request(
        "DELETE",
        LINK,
        json={"password": "ce-n-est-pas-le-bon"},
        headers=account.auth,
    )

    assert response.status_code == 401, response.text
    assert response.json()["error"] == "invalid_credentials"
    assert await fetch_link(sessions, account.id) is not None


async def test_dissociation(
    client: AsyncClient,
    account: Account,
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    """Avec le mot de passe, le rattachement disparaît — jeton chiffré compris."""
    assert (await link(client, account)).status_code == 200

    response = await client.request(
        "DELETE", LINK, json={"password": PASSWORD}, headers=account.auth
    )

    assert response.status_code == 204, response.text
    assert await fetch_link(sessions, account.id) is None

    actions = await fetch_actions(sessions, account.id)
    assert "microsoft_unlink" in actions

    # Sans rattachement, le bouton JOUER s'éteint : c'est le mode hybride imposé.
    me = await client.get(f"{API_PREFIX}/auth/me", headers=account.auth)
    assert me.status_code == 200
    assert me.json()["can_play"] is False
    assert me.json()["blocked_reason"] == "microsoft_required"

    # Le skin importé, lui, reste : il appartient au compte OPM.
    assert await fetch_textures(sessions, account.id) != []


async def test_dissociation_sans_rattachement(client: AsyncClient, account: Account) -> None:
    """Dissocier ce qui n'existe pas répond ``microsoft_required``."""
    response = await client.request(
        "DELETE", LINK, json={"password": PASSWORD}, headers=account.auth
    )
    assert response.status_code == 403
    assert response.json()["error"] == "microsoft_required"


async def test_rattacher_de_nouveau_apres_dissociation(
    client: AsyncClient,
    account: Account,
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    """Un compte Minecraft libéré redevient rattachable — au même compte ou à un autre."""
    assert (await link(client, account)).status_code == 200
    unlink = await client.request("DELETE", LINK, json={"password": PASSWORD}, headers=account.auth)
    assert unlink.status_code == 204

    autre = await second_account(client)
    response = await link(client, autre)

    assert response.status_code == 200, response.text
    assert response.json()["user"]["microsoft"]["minecraft_uuid"] == PROFILE_UUID_HEX
    assert await fetch_link(sessions, autre.id) is not None


# --------------------------------------------------------------------------- #
# 8. Service des textures
# --------------------------------------------------------------------------- #


async def test_texture_inconnue(client: AsyncClient) -> None:
    """Une empreinte valide mais inconnue répond ``404``, proprement."""
    response = await client.get(f"/textures/{'a' * 64}.png")
    assert response.status_code == 404
    assert response.json()["error"] == "not_found"


async def test_empreinte_invalide_refusee(client: AsyncClient) -> None:
    """Une référence qui n'est pas un SHA-256 ne construit aucun chemin.

    Même réponse que pour une texture absente : rien, dans le code ni dans le
    message, ne renseigne un curieux sur ce que le serveur héberge.
    """
    for reference in ("z" * 64, "court", "..", "0" * 63, "0" * 65):
        response = await client.get(f"/textures/{reference}.png")
        assert response.status_code == 404, reference
        assert response.json()["error"] == "not_found", reference


async def test_texture_deja_connue_du_client(client: AsyncClient, account: Account) -> None:
    """Un contenu immuable déjà en cache répond ``304``, sans renvoyer l'image."""
    response = await link(client, account)
    assert response.status_code == 200, response.text
    skin = response.json()["user"]["skin"]
    etag = '"{}"'.format(skin["sha256"])

    served = await client.get(skin["url"], headers={"If-None-Match": etag})
    assert served.status_code == 304
    assert served.content == b""


async def test_textures_du_compte(client: AsyncClient, account: Account) -> None:
    """``GET /textures/me`` liste les textures actives, par type."""
    assert (await link(client, account)).status_code == 200

    response = await client.get("/textures/me", headers=account.auth)
    assert response.status_code == 200, response.text

    body = response.json()
    assert set(body) == {"skin"}
    assert body["skin"]["model"] == "slim"
    assert SHA256_RE.match(body["skin"]["sha256"])


async def test_retrait_du_skin(
    client: AsyncClient,
    account: Account,
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    """Le joueur peut revenir au skin par défaut ; le fichier, lui, reste."""
    response = await link(client, account)
    assert response.status_code == 200, response.text
    sha = response.json()["user"]["skin"]["sha256"]

    removed = await client.delete("/textures/skin", headers=account.auth)
    assert removed.status_code == 204

    me = await client.get(f"{API_PREFIX}/auth/me", headers=account.auth)
    assert me.status_code == 200
    assert me.json()["skin"] is None

    # Le blob survit : son URL a été annoncée immuable, et il peut être partagé.
    assert textures.path_for(sha).is_file()
    served = await client.get(f"/textures/{sha}.png")
    assert served.status_code == 200

    # L'association demeure, avec une texture nulle : c'est ainsi qu'on distingue
    # « il a choisi le skin par défaut » de « on n'a jamais rien importé ».
    async with sessions() as session:
        link_row = await session.get(UserTexture, (account.id, TextureKind.SKIN.value))
        assert link_row is not None
        assert link_row.texture_id is None
        await session.commit()


async def test_le_choix_du_joueur_survit_a_une_reverification(
    client: AsyncClient,
    account: Account,
    skin_server: SkinServer,
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    """Un skin retiré volontairement n'est pas réinstallé par un rattachement.

    Sans cette règle, le joueur qui retire son skin le verrait revenir à la
    première re-vérification de possession : ce qu'il choisit dans le launcher
    doit tenir.
    """
    assert (await link(client, account)).status_code == 200
    assert (await client.delete("/textures/skin", headers=account.auth)).status_code == 204

    skin_server.calls.clear()
    # Un nouveau passage complet, avec le même compte Microsoft.
    assert (await link(client, account)).status_code == 200

    assert skin_server.calls == []
    me = await client.get(f"{API_PREFIX}/auth/me", headers=account.auth)
    assert me.json()["skin"] is None

    async with sessions() as session:
        link_row = await session.get(UserTexture, (account.id, TextureKind.SKIN.value))
        assert link_row is not None and link_row.texture_id is None
        await session.commit()


def jpeg(width: int = 64, height: int = 64) -> bytes:
    """Un vrai JPEG — le fichier que l'on va tenter de faire passer pour un PNG."""
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (10, 20, 30)).save(buffer, format="JPEG")
    return buffer.getvalue()


async def test_televersement_d_un_skin(
    client: AsyncClient,
    account: Account,
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    """Le joueur peut déposer son propre skin, et choisir le modèle de bras."""
    response = await client.post(
        "/textures/skin",
        files={"file": ("mon-skin.png", png(colour=(9, 120, 200, 255)), "image/png")},
        data={"model": "slim"},
        headers=account.auth,
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["texture"]["kind"] == "skin"
    assert body["texture"]["model"] == "slim"
    assert SHA256_RE.match(body["texture"]["sha256"])
    assert textures.path_for(body["texture"]["sha256"]).is_file()

    stored = await fetch_textures(sessions, account.id)
    assert len(stored) == 1
    assert stored[0].source == "upload"

    me = await client.get(f"{API_PREFIX}/auth/me", headers=account.auth)
    assert me.json()["skin"]["sha256"] == body["texture"]["sha256"]


async def test_un_jpeg_renomme_est_refuse(client: AsyncClient, account: Account) -> None:
    """Le contrôle porte sur le **contenu**, jamais sur l'extension ni le type MIME.

    Le fichier s'appelle ``skin.png``, s'annonce ``image/png``… et reste un JPEG.
    Les huit octets magiques du format tranchent, et rien d'autre.
    """
    response = await client.post(
        "/textures/skin",
        files={"file": ("skin.png", jpeg(), "image/png")},
        headers=account.auth,
    )

    assert response.status_code == 400, response.text
    assert response.json()["error"] == "invalid_texture"


async def test_televersement_trop_volumineux(client: AsyncClient, account: Account) -> None:
    """Une image démesurée est refusée avant même d'être décodée."""
    limite = get_settings().texture_max_kib * 1024
    response = await client.post(
        "/textures/skin",
        files={"file": ("skin.png", b"\x00" * (limite * 2), "image/png")},
        headers=account.auth,
    )

    assert response.status_code == 413, response.text
    body = response.json()
    assert body["error"] == "texture_too_large"
    assert body["details"] == {"max_bytes": limite}


async def test_le_skin_televerse_survit_a_une_reverification(
    client: AsyncClient,
    account: Account,
    skin_server: SkinServer,
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    """Un skin choisi par le joueur n'est pas écrasé par un import Mojang.

    Sans cette règle, la première re-vérification de possession remettrait le
    skin Microsoft à la place de celui que le joueur vient de déposer.
    """
    assert (await link(client, account)).status_code == 200

    upload = await client.post(
        "/textures/skin",
        files={"file": ("mien.png", png(colour=(1, 2, 3, 255)), "image/png")},
        headers=account.auth,
    )
    assert upload.status_code == 200, upload.text
    choisi = upload.json()["texture"]["sha256"]

    await expire_ownership(sessions, account.id)
    skin_server.calls.clear()

    response = await client.post(f"{LINK}/refresh", headers=account.auth)

    assert response.status_code == 200, response.text
    assert skin_server.calls == []
    assert response.json()["user"]["skin"]["sha256"] == choisi


async def test_deux_joueurs_au_meme_skin_partagent_un_seul_fichier(
    client: AsyncClient,
    account: Account,
    chain: Chain,
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    """Le stockage est adressé par le contenu : un skin identique, une seule ligne."""
    assert (await link(client, account)).status_code == 200
    premier = await fetch_textures(sessions, account.id)
    assert len(premier) == 1

    # Un second joueur, un autre compte Microsoft, mais la même image.
    autre = await second_account(client)
    chain.msa_sub = "msa-zorro-0002"
    chain.profile_uuid = "aaaabbbbccccddddeeeeffff00001111"
    chain.profile_name = "ZorroMC"
    assert (await link(client, autre)).status_code == 200

    second = await fetch_textures(sessions, autre.id)
    assert len(second) == 1
    assert second[0].id == premier[0].id
    assert second[0].sha256 == premier[0].sha256

    async with sessions() as session:
        total = (await session.execute(select(Texture))).scalars().all()
        assert len(total) == 1
        await session.commit()
