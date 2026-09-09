"""Tests du protocole Yggdrasil maison et de la session de jeu.

Couvre le contrat de ``docs/API.md`` §1.4 et §2, et les décisions structurantes
de ``docs/DATA.md`` §8 :

* ``authenticate`` / ``refresh`` / ``validate`` / ``invalidate`` / ``signout`` ;
* connexion par adresse e-mail **ou** par pseudonyme OPM (``users.name``) ;
* identité en jeu prise dans ``auth_mc_link`` — UUID premium réel et
  ``minecraft_username`` — jamais ``users.name``, jamais un UUID fabriqué ;
* cycle complet ``join`` → ``hasJoined``, TTL de 30 s, annonce non rejouable ;
* refus explicite, en français, quand la possession Microsoft a expiré ;
* propriété ``textures`` signée, vérifiable avec la clé publique publiée par
  ``GET /yggdrasil`` ;
* ``POST /api/v1/game/session`` et sa fermeture, qui crédite ``users.tempsdejeu``.

Les comptes sont créés directement en base : le routeur d'inscription appartient
à une autre surface, et ces tests doivent pouvoir échouer pour une seule raison.
"""

from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, update

from opm_auth import db
from opm_auth.config import get_settings
from opm_auth.models import (
    Ban,
    McLink,
    Texture,
    TextureKind,
    TextureModel,
    TextureSource,
    User,
    UserTexture,
    YggJoin,
    YggSession,
    utcnow,
)
from opm_auth.routers.game import router as game_router
from opm_auth.routers.sessionserver import router as sessionserver_router
from opm_auth.routers.yggdrasil import router as yggdrasil_router
from opm_auth.security.deps import ApiError, api_error_handler, current_user
from opm_auth.services import yggdrasil as service

#: Racine de l'API launcher, telle que la monte l'application.
API_PREFIX = "/api/v1"
#: Racine du protocole Mojang.
YGG = "/yggdrasil"
#: Racine du sessionserver.
SESSION = f"{YGG}/sessionserver/session/minecraft"

#: Mot de passe des comptes de test.
PASSWORD = "Grand-Line-2026!"

#: Empreinte SHA-256 d'un skin factice (64 caractères hexadécimaux).
SKIN_SHA256 = "a" * 64


def werkzeug_hash(password: str, *, iterations: int = 1_000) -> str:
    """Empreinte au format Werkzeug, exactement comme le site Flask l'écrit.

    ``pbkdf2:sha256:<itérations>$<sel>$<hexadécimal>`` — c'est ce que produit
    ``werkzeug.security.generate_password_hash`` (``docs/DATA.md`` §3). Le nombre
    d'itérations est volontairement bas ici : le site en écrit 260 000 et notre
    serveur 600 000, mais une suite de tests qui vérifie vingt mots de passe à
    600 000 itérations passerait son temps à dériver des clés. Le **format**
    testé est bien celui de production, et c'est ce qui compte.
    """
    salt = "opmSelDeTest1234"
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), iterations, dklen=32
    )
    return f"pbkdf2:sha256:{iterations}${salt}${digest.hex()}"


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture(autouse=True)
async def site_schema() -> None:
    """Ajoute les tables du site à la base SQLite jetable.

    ``init_models()`` ne crée que les tables du launcher — c'est le garde-fou qui
    empêche ce projet de créer ``users`` dans la vraie base. Sur une base en
    mémoire, il faut pourtant bien une table ``users`` pour que les clés
    étrangères de ``auth_mc_link`` et ``ygg_session`` aient une cible.

    L'appel est idempotent (``create_all`` vérifie l'existence) : l'ordre dans
    lequel il s'intercale avec la fixture de base de données n'a pas d'importance.
    """
    await db.init_models(with_site_tables=True)


@pytest.fixture
def app() -> FastAPI:
    """Application montant les trois surfaces testées ici.

    Volontairement assemblée sur place plutôt qu'importée : la fabrique
    d'application appartient à un autre module, et ces tests portent sur les
    routeurs eux-mêmes. Le montage reproduit celui attendu en production.
    """
    application = FastAPI(title="OPM Yggdrasil (tests)")
    application.add_exception_handler(ApiError, api_error_handler)
    application.include_router(yggdrasil_router, prefix=YGG)
    application.include_router(sessionserver_router, prefix=YGG)
    application.include_router(game_router, prefix=API_PREFIX)
    return application


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    """Client HTTP asynchrone branché directement sur l'application ASGI."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as opened:
        yield opened


# --------------------------------------------------------------------------- #
# Comptes de test
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class Player:
    """Un compte du site, éventuellement rattaché à un compte Microsoft."""

    id: int
    email: str
    name: str
    password: str
    mc_uuid: str | None
    mc_name: str | None


#: Colonnes ``NOT NULL`` sans valeur par défaut de la table ``users`` du site.
#: Elles n'ont aucun intérêt ici, mais la base les exige.
_RP_DEFAULTS: dict[str, Any] = {
    "genre": "",
    "provenance": "",
    "faction": "Pirate",
    "race": "",
    "specialisation": "",
    "equipage": "Les Cœurs Brisés",
    "territoires": "",
    "metier": "Charpentier",
    "nomfdd": "",
    "niveaubase": 47,
    "niveaumetier": 0,
    "niveaucrochetage": 0,
    "niveauminage": 0,
    "niveaubuchage": 0,
    "niveaucueillette": 0,
    "niveauchasse": 0,
    "niveaupeche": 0,
}


async def create_player(
    *,
    email: str = "capitaine@exemple.fr",
    name: str = "Melodia",
    password: str = PASSWORD,
    linked: bool = True,
    mc_uuid: str = "4f2a9c81b0e64d7e8b1c2d3e4f5a6b7c",
    mc_name: str = "MelodiaMC",
    owns_minecraft: bool = True,
    ownership_ttl: timedelta = timedelta(days=30),
    skin_sha256: str | None = None,
    skin_model: str = TextureModel.CLASSIC.value,
) -> Player:
    """Crée un compte du site, son rattachement Microsoft et son skin.

    :param linked: si faux, aucune ligne ``auth_mc_link`` — le compte est dans
        l'état d'un joueur qui n'a pas encore rattaché Microsoft.
    :param ownership_ttl: durée restante de la vérification de possession ; une
        valeur négative simule une vérification périmée.
    """
    factory = db.get_sessionmaker()
    async with factory() as session:
        user = User(
            name=name,
            email=email,
            password_hash=werkzeug_hash(password),
            datejoin=utcnow(),
            **_RP_DEFAULTS,
        )
        session.add(user)
        await session.flush()

        if linked:
            now = utcnow()
            session.add(
                McLink(
                    user_id=user.id,
                    msa_sub=f"msa-{user.id}",
                    minecraft_uuid=mc_uuid,
                    minecraft_username=mc_name,
                    owns_minecraft=owns_minecraft,
                    verified_at=now,
                    expires_at=now + ownership_ttl,
                )
            )

        if skin_sha256:
            texture = Texture(
                sha256=skin_sha256,
                kind=TextureKind.SKIN.value,
                model=skin_model,
                width=64,
                height=64,
                bytes=1024,
                source=TextureSource.MOJANG_IMPORT.value,
            )
            session.add(texture)
            await session.flush()
            session.add(
                UserTexture(
                    user_id=user.id,
                    kind=TextureKind.SKIN.value,
                    texture_id=texture.id,
                )
            )

        await session.commit()
        return Player(
            id=user.id,
            email=email,
            name=name,
            password=password,
            mc_uuid=mc_uuid if linked else None,
            mc_name=mc_name if linked else None,
        )


async def load_user(user_id: int) -> User:
    """Recharge un compte avec ses relations (rattachement, skin, sanctions)."""
    factory = db.get_sessionmaker()
    async with factory() as session:
        user = (
            await session.execute(select(User).where(User.id == user_id))
        ).scalars().one()
        await session.commit()
        return user


def sign_in_as(app: FastAPI, user: User) -> None:
    """Fait passer l'API launcher pour authentifiée sous ce compte.

    On remplace la dépendance ``current_user`` plutôt que d'émettre un vrai
    ``access_token`` : ces tests portent sur la session de jeu, pas sur la
    vérification des jetons de l'API, qui a sa propre suite.
    """
    app.dependency_overrides[current_user] = lambda: user


# --------------------------------------------------------------------------- #
# Raccourcis de protocole
# --------------------------------------------------------------------------- #


async def authenticate(
    client: AsyncClient, identifier: str, password: str = PASSWORD, **extra: Any
) -> dict[str, Any]:
    """``POST /yggdrasil/authserver/authenticate``, réponse déjà décodée."""
    payload: dict[str, Any] = {
        "username": identifier,
        "password": password,
        "agent": {"name": "Minecraft", "version": 1},
    }
    payload.update(extra)
    response = await client.post(f"{YGG}/authserver/authenticate", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def textures_property(profile: dict[str, Any]) -> dict[str, Any]:
    """Extrait la propriété ``textures`` d'un profil Mojang."""
    properties = profile.get("properties") or []
    matching = [item for item in properties if item["name"] == "textures"]
    assert matching, f"Aucune propriété « textures » dans {profile}"
    return matching[0]


def decode_textures(prop: dict[str, Any]) -> dict[str, Any]:
    """Décode la charge utile base64 de la propriété ``textures``."""
    return json.loads(base64.b64decode(prop["value"]).decode("utf-8"))


# --------------------------------------------------------------------------- #
# Métadonnées ALI
# --------------------------------------------------------------------------- #


async def test_metadata_annonce_la_connexion_par_pseudo(client: AsyncClient) -> None:
    """``GET /yggdrasil`` publie la clé de signature et ses options."""
    response = await client.get(YGG)
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["meta"]["implementationName"] == "opm-yggdrasil"
    assert body["meta"]["feature.non_email_login"] is True
    assert body["meta"]["links"]["homepage"]
    assert body["signaturePublickey"].startswith("-----BEGIN PUBLIC KEY-----")
    assert isinstance(body["skinDomains"], list)


# --------------------------------------------------------------------------- #
# authenticate
# --------------------------------------------------------------------------- #


async def test_authenticate_par_email_rend_identite_minecraft(
    client: AsyncClient,
) -> None:
    """Le profil porte l'UUID premium et le pseudo Minecraft, pas ``users.name``."""
    player = await create_player()

    body = await authenticate(client, player.email)

    profile = body["selectedProfile"]
    assert profile["id"] == player.mc_uuid
    assert profile["name"] == player.mc_name
    assert profile["name"] != player.name  # jamais users.name en jeu
    assert body["availableProfiles"] == [profile]
    assert body["accessToken"] and body["clientToken"]
    # Ni authenticate ni refresh ne transportent les textures.
    assert "properties" not in profile


async def test_authenticate_par_pseudo_opm(client: AsyncClient) -> None:
    """``feature.non_email_login`` : ``users.name`` est un identifiant valable."""
    player = await create_player()

    body = await authenticate(client, player.name)

    assert body["selectedProfile"]["id"] == player.mc_uuid


async def test_authenticate_conserve_le_client_token_et_rend_user(
    client: AsyncClient,
) -> None:
    """``clientToken`` fourni est repris tel quel ; ``requestUser`` ajoute ``user``."""
    player = await create_player()

    body = await authenticate(
        client, player.email, clientToken="jeton-client-du-launcher", requestUser=True
    )

    assert body["clientToken"] == "jeton-client-du-launcher"
    assert body["user"]["id"] == str(player.id)  # users.id est un entier


async def test_authenticate_refuse_un_mot_de_passe_faux(client: AsyncClient) -> None:
    """Erreur au format Mojang, message français, aucun détail révélateur."""
    player = await create_player()

    response = await client.post(
        f"{YGG}/authserver/authenticate",
        json={"username": player.email, "password": "mauvais-mot-de-passe"},
    )

    assert response.status_code == 403
    body = response.json()
    assert body["error"] == "ForbiddenOperationException"
    assert body["errorMessage"] == "Identifiant ou mot de passe incorrect."


async def test_authenticate_refuse_un_compte_inconnu_avec_le_meme_message(
    client: AsyncClient,
) -> None:
    """Un compte inexistant est indiscernable d'un mot de passe faux."""
    await create_player()

    response = await client.post(
        f"{YGG}/authserver/authenticate",
        json={"username": "fantome@exemple.fr", "password": PASSWORD},
    )

    assert response.status_code == 403
    assert response.json()["errorMessage"] == "Identifiant ou mot de passe incorrect."


async def test_authenticate_refuse_quand_la_possession_a_expire(
    client: AsyncClient,
) -> None:
    """Vérification Microsoft périmée : refus explicite, en français."""
    player = await create_player(ownership_ttl=timedelta(days=-1))

    response = await client.post(
        f"{YGG}/authserver/authenticate",
        json={"username": player.email, "password": PASSWORD},
    )

    assert response.status_code == 403
    body = response.json()
    assert body["cause"] == "microsoft_expired"
    assert "expiré" in body["errorMessage"]
    assert "launcher" in body["errorMessage"]


async def test_authenticate_refuse_sans_rattachement_microsoft(
    client: AsyncClient,
) -> None:
    """En mode hybride imposé, pas de rattachement, pas de session."""
    player = await create_player(linked=False)

    response = await client.post(
        f"{YGG}/authserver/authenticate",
        json={"username": player.email, "password": PASSWORD},
    )

    assert response.status_code == 403
    assert response.json()["cause"] == "microsoft_required"


async def test_authenticate_refuse_un_compte_sans_minecraft(
    client: AsyncClient,
) -> None:
    """Compte Microsoft rattaché mais sans licence Minecraft."""
    player = await create_player(owns_minecraft=False)

    response = await client.post(
        f"{YGG}/authserver/authenticate",
        json={"username": player.email, "password": PASSWORD},
    )

    assert response.status_code == 403
    assert response.json()["cause"] == "ownership_missing"


async def test_authenticate_refuse_un_compte_sanctionne(client: AsyncClient) -> None:
    """Une sanction prime sur tout le reste, rattachement Microsoft compris."""
    player = await create_player()
    factory = db.get_sessionmaker()
    async with factory() as session:
        session.add(
            Ban(user_id=player.id, reason="Abordage sauvage", created_by="Mélodia")
        )
        await session.commit()

    response = await client.post(
        f"{YGG}/authserver/authenticate",
        json={"username": player.email, "password": PASSWORD},
    )

    assert response.status_code == 403
    body = response.json()
    assert body["cause"] == "banned"
    assert "suspendu" in body["errorMessage"]


async def test_authenticate_refuse_un_corps_incomplet(client: AsyncClient) -> None:
    """Une requête malformée sort elle aussi au format Mojang, en 400."""
    response = await client.post(f"{YGG}/authserver/authenticate", json={"username": "x"})

    assert response.status_code == 400
    assert response.json()["error"] == "IllegalArgumentException"


# --------------------------------------------------------------------------- #
# refresh, validate, invalidate, signout
# --------------------------------------------------------------------------- #


async def test_refresh_remplace_le_jeton_et_tue_le_precedent(
    client: AsyncClient,
) -> None:
    """Le jeton rafraîchi vit, l'ancien meurt : jamais deux sessions parallèles."""
    player = await create_player()
    opened = await authenticate(client, player.email)

    response = await client.post(
        f"{YGG}/authserver/refresh",
        json={"accessToken": opened["accessToken"], "clientToken": opened["clientToken"]},
    )
    assert response.status_code == 200, response.text
    renewed = response.json()

    assert renewed["accessToken"] != opened["accessToken"]
    assert renewed["clientToken"] == opened["clientToken"]
    assert renewed["selectedProfile"]["id"] == player.mc_uuid

    assert (
        await client.post(
            f"{YGG}/authserver/validate", json={"accessToken": renewed["accessToken"]}
        )
    ).status_code == 204
    assert (
        await client.post(
            f"{YGG}/authserver/validate", json={"accessToken": opened["accessToken"]}
        )
    ).status_code == 403


async def test_refresh_refuse_un_client_token_different(client: AsyncClient) -> None:
    """Sémantique Mojang : le ``clientToken`` fait partie de la session."""
    player = await create_player()
    opened = await authenticate(client, player.email)

    response = await client.post(
        f"{YGG}/authserver/refresh",
        json={"accessToken": opened["accessToken"], "clientToken": "un-autre-client"},
    )

    assert response.status_code == 403


async def test_refresh_refuse_un_profil_impose(client: AsyncClient) -> None:
    """``selectedProfile`` n'a pas de sens au rafraîchissement : 400."""
    player = await create_player()
    opened = await authenticate(client, player.email)

    response = await client.post(
        f"{YGG}/authserver/refresh",
        json={
            "accessToken": opened["accessToken"],
            "selectedProfile": {"id": player.mc_uuid, "name": player.mc_name},
        },
    )

    assert response.status_code == 400
    assert response.json()["error"] == "IllegalArgumentException"


async def test_validate_puis_invalidate(client: AsyncClient) -> None:
    """``invalidate`` ferme la session ; il reste silencieux même deux fois."""
    player = await create_player()
    opened = await authenticate(client, player.email)
    token = opened["accessToken"]

    assert (
        await client.post(f"{YGG}/authserver/validate", json={"accessToken": token})
    ).status_code == 204

    assert (
        await client.post(f"{YGG}/authserver/invalidate", json={"accessToken": token})
    ).status_code == 204
    assert (
        await client.post(f"{YGG}/authserver/validate", json={"accessToken": token})
    ).status_code == 403
    # Deuxième invalidation : toujours 204, le client n'apprend rien.
    assert (
        await client.post(f"{YGG}/authserver/invalidate", json={"accessToken": token})
    ).status_code == 204


async def test_validate_refuse_un_jeton_fabrique(client: AsyncClient) -> None:
    """Un jeton qui n'a pas été signé par nous n'a aucune chance."""
    response = await client.post(
        f"{YGG}/authserver/validate", json={"accessToken": "eyJhbGciOiJub25lIn0..signature"}
    )

    assert response.status_code == 403
    assert response.json()["errorMessage"] == "Jeton de session invalide ou expiré."


async def test_signout_ferme_toutes_les_sessions(client: AsyncClient) -> None:
    """Le mot de passe à l'appui, toutes les sessions du compte tombent."""
    player = await create_player()
    first = await authenticate(client, player.email, clientToken="poste-fixe")
    second = await authenticate(client, player.email, clientToken="portable")

    response = await client.post(
        f"{YGG}/authserver/signout",
        json={"username": player.email, "password": PASSWORD},
    )
    assert response.status_code == 204

    for opened in (first, second):
        assert (
            await client.post(
                f"{YGG}/authserver/validate", json={"accessToken": opened["accessToken"]}
            )
        ).status_code == 403


# --------------------------------------------------------------------------- #
# join / hasJoined
# --------------------------------------------------------------------------- #


async def join(client: AsyncClient, opened: dict[str, Any], server_id: str) -> Any:
    """``POST /session/minecraft/join`` avec la session ouverte."""
    return await client.post(
        f"{SESSION}/join",
        json={
            "accessToken": opened["accessToken"],
            "selectedProfile": opened["selectedProfile"]["id"],
            "serverId": server_id,
        },
    )


async def test_cycle_join_puis_has_joined(client: AsyncClient) -> None:
    """Le cycle complet : le client annonce, le serveur confirme, le skin suit."""
    player = await create_player(skin_sha256=SKIN_SHA256, skin_model=TextureModel.SLIM.value)
    opened = await authenticate(client, player.email)

    assert (await join(client, opened, "serveur-abc")).status_code == 204

    response = await client.get(
        f"{SESSION}/hasJoined",
        params={"username": player.mc_name, "serverId": "serveur-abc"},
    )
    assert response.status_code == 200, response.text
    profile = response.json()

    assert profile["id"] == player.mc_uuid
    assert profile["name"] == player.mc_name

    payload = decode_textures(textures_property(profile))
    assert payload["profileId"] == player.mc_uuid
    assert payload["profileName"] == player.mc_name
    assert payload["signatureRequired"] is True
    assert payload["textures"]["SKIN"]["url"].endswith(f"/textures/{SKIN_SHA256}.png")
    assert payload["textures"]["SKIN"]["metadata"] == {"model": "slim"}


async def test_has_joined_n_est_pas_rejouable(client: AsyncClient) -> None:
    """Un ``serverId`` ne vaut qu'une fois : la seconde demande est refusée."""
    player = await create_player()
    opened = await authenticate(client, player.email)
    await join(client, opened, "serveur-unique")

    params = {"username": player.mc_name, "serverId": "serveur-unique"}
    assert (await client.get(f"{SESSION}/hasJoined", params=params)).status_code == 200
    assert (await client.get(f"{SESSION}/hasJoined", params=params)).status_code == 204


async def test_has_joined_sans_annonce_repond_204(client: AsyncClient) -> None:
    """Aucune annonce pour ce ``serverId`` : refus, sans corps."""
    player = await create_player()

    response = await client.get(
        f"{SESSION}/hasJoined",
        params={"username": player.mc_name, "serverId": "jamais-annonce"},
    )

    assert response.status_code == 204


async def test_has_joined_refuse_une_annonce_perimee(client: AsyncClient) -> None:
    """Passé ``OPM_JOIN_TTL_SECONDS``, la poignée de main est à recommencer."""
    player = await create_player()
    opened = await authenticate(client, player.email)
    await join(client, opened, "serveur-lent")

    factory = db.get_sessionmaker()
    async with factory() as session:
        await session.execute(
            update(YggJoin)
            .where(YggJoin.server_id == "serveur-lent")
            .values(created_at=utcnow() - timedelta(minutes=5))
        )
        await session.commit()

    response = await client.get(
        f"{SESSION}/hasJoined",
        params={"username": player.mc_name, "serverId": "serveur-lent"},
    )

    assert response.status_code == 204


async def test_has_joined_refuse_un_autre_pseudo(client: AsyncClient) -> None:
    """Le pseudonyme annoncé par le serveur doit être celui de la session."""
    player = await create_player()
    opened = await authenticate(client, player.email)
    await join(client, opened, "serveur-usurpe")

    response = await client.get(
        f"{SESSION}/hasJoined",
        params={"username": "Usurpateur", "serverId": "serveur-usurpe"},
    )

    assert response.status_code == 204


async def test_has_joined_refuse_une_adresse_differente(client: AsyncClient) -> None:
    """``prevent-proxy-connections`` : l'adresse doit être celle du ``join``."""
    player = await create_player()
    opened = await authenticate(client, player.email)
    await join(client, opened, "serveur-proxy")

    response = await client.get(
        f"{SESSION}/hasJoined",
        params={
            "username": player.mc_name,
            "serverId": "serveur-proxy",
            "ip": "203.0.113.7",
        },
    )

    assert response.status_code == 204


async def test_join_refuse_un_profil_qui_n_est_pas_le_sien(client: AsyncClient) -> None:
    """Annoncer l'UUID d'un autre joueur ne mène nulle part."""
    player = await create_player()
    opened = await authenticate(client, player.email)

    response = await client.post(
        f"{SESSION}/join",
        json={
            "accessToken": opened["accessToken"],
            "selectedProfile": "0" * 32,
            "serverId": "serveur-vol",
        },
    )

    assert response.status_code == 403
    assert response.json()["error"] == "ForbiddenOperationException"


async def test_join_refuse_une_session_invalidee(client: AsyncClient) -> None:
    """Une session fermée ne permet plus d'entrer sur le serveur."""
    player = await create_player()
    opened = await authenticate(client, player.email)
    await client.post(
        f"{YGG}/authserver/invalidate", json={"accessToken": opened["accessToken"]}
    )

    assert (await join(client, opened, "serveur-mort")).status_code == 403


async def test_has_joined_refuse_apres_expiration_de_la_possession(
    client: AsyncClient,
) -> None:
    """Une possession qui périme entre le ``join`` et le ``hasJoined`` ferme la porte."""
    player = await create_player()
    opened = await authenticate(client, player.email)
    await join(client, opened, "serveur-limite")

    factory = db.get_sessionmaker()
    async with factory() as session:
        await session.execute(
            update(McLink)
            .where(McLink.user_id == player.id)
            .values(expires_at=utcnow() - timedelta(seconds=1))
        )
        await session.commit()

    response = await client.get(
        f"{SESSION}/hasJoined",
        params={"username": player.mc_name, "serverId": "serveur-limite"},
    )

    assert response.status_code == 204


# --------------------------------------------------------------------------- #
# Repli Mojang (OPM_YGG_MOJANG_FALLBACK)
# --------------------------------------------------------------------------- #


@dataclass
class MojangSpy:
    """Compte les recours au sessionserver officiel, sans jamais y aller."""

    calls: list[tuple[str, str, str | None]]

    async def __call__(self, username: str, server_id: str, ip: str | None) -> None:
        self.calls.append((username, server_id, ip))
        return None


@pytest.fixture
def mojang(monkeypatch: pytest.MonkeyPatch) -> MojangSpy:
    """Remplace l'appel sortant vers Mojang par un mouchard."""
    spy = MojangSpy(calls=[])
    monkeypatch.setattr(service, "_mojang_has_joined", spy)
    return spy


async def test_repli_mojang_desactive_par_defaut(
    client: AsyncClient, mojang: MojangSpy
) -> None:
    """En « hybride imposé », un pseudonyme inconnu n'est jamais relayé."""
    response = await client.get(
        f"{SESSION}/hasJoined",
        params={"username": "JoueurPremium", "serverId": "serveur-inconnu"},
    )

    assert response.status_code == 204
    assert mojang.calls == []


async def test_repli_mojang_consulte_pour_un_pseudo_inconnu(
    client: AsyncClient, mojang: MojangSpy, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Réglage actif : un pseudonyme absent de notre base part chez Mojang."""
    monkeypatch.setattr(get_settings(), "ygg_mojang_fallback", True)

    response = await client.get(
        f"{SESSION}/hasJoined",
        params={"username": "JoueurPremium", "serverId": "serveur-ext"},
    )

    assert response.status_code == 204  # le mouchard ne rend aucun profil
    assert mojang.calls == [("JoueurPremium", "serveur-ext", None)]


async def test_repli_mojang_ne_contourne_pas_nos_refus(
    client: AsyncClient, mojang: MojangSpy, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Un compte que nous refusons ne doit pas entrer par la porte de Mojang.

    C'est la garantie qui rend le réglage acceptable : le repli ne s'applique
    qu'aux pseudonymes **inconnus**. Un joueur banni, sans possession vérifiée ou
    dont l'annonce a expiré reste dehors, quelle que soit la réponse de Mojang.
    """
    monkeypatch.setattr(get_settings(), "ygg_mojang_fallback", True)
    player = await create_player(ownership_ttl=timedelta(days=-1))

    response = await client.get(
        f"{SESSION}/hasJoined",
        params={"username": player.mc_name, "serverId": "serveur-refuse"},
    )

    assert response.status_code == 204
    assert mojang.calls == []


# --------------------------------------------------------------------------- #
# Profils et signature
# --------------------------------------------------------------------------- #


async def test_signature_du_profil_verifiable_avec_la_cle_publique(
    client: AsyncClient,
) -> None:
    """La propriété ``textures`` est signée SHA1withRSA par la clé publiée.

    C'est le contrat que le client Minecraft applique : il vérifie la valeur
    base64, octet pour octet, avec la clé du champ ``signaturePublickey``.
    """
    player = await create_player(skin_sha256=SKIN_SHA256)

    metadata = (await client.get(YGG)).json()
    public_key = serialization.load_pem_public_key(
        metadata["signaturePublickey"].encode("ascii")
    )

    response = await client.get(
        f"{SESSION}/profile/{player.mc_uuid}", params={"unsigned": "false"}
    )
    assert response.status_code == 200, response.text
    prop = textures_property(response.json())

    assert prop["signature"], "Un profil signé doit porter sa signature."
    # Lève InvalidSignature si la vérification échoue : le test échoue alors ici.
    public_key.verify(  # type: ignore[union-attr]
        base64.b64decode(prop["signature"]),
        prop["value"].encode("ascii"),
        padding.PKCS1v15(),
        hashes.SHA1(),
    )


async def test_profil_non_signe_par_defaut(client: AsyncClient) -> None:
    """Sans ``unsigned=false``, ni signature ni ``signatureRequired``."""
    player = await create_player(skin_sha256=SKIN_SHA256)

    response = await client.get(f"{SESSION}/profile/{player.mc_uuid}")

    assert response.status_code == 200, response.text
    prop = textures_property(response.json())
    assert "signature" not in prop
    assert "signatureRequired" not in decode_textures(prop)


async def test_profil_avec_tirets_et_uuid_inconnu(client: AsyncClient) -> None:
    """L'UUID est accepté avec ou sans tirets ; un inconnu répond 204."""
    player = await create_player()
    raw = player.mc_uuid or ""
    dashed = f"{raw[:8]}-{raw[8:12]}-{raw[12:16]}-{raw[16:20]}-{raw[20:]}"

    assert (await client.get(f"{SESSION}/profile/{dashed}")).status_code == 200
    assert (await client.get(f"{SESSION}/profile/{'b' * 32}")).status_code == 204


async def test_profils_par_pseudonyme_minecraft(client: AsyncClient) -> None:
    """``/api/profiles/minecraft`` résout les pseudos **du jeu**, pas ceux du site."""
    player = await create_player()

    response = await client.post(
        f"{YGG}/api/profiles/minecraft",
        json=[player.mc_name, "PersonneIci", player.name],
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body == [{"id": player.mc_uuid, "name": player.mc_name}]


async def test_profil_sans_skin_n_expose_aucune_texture(client: AsyncClient) -> None:
    """Sans skin importé, la charge utile ne porte aucune entrée : Steve par défaut."""
    player = await create_player()

    response = await client.get(f"{SESSION}/profile/{player.mc_uuid}")

    payload = decode_textures(textures_property(response.json()))
    assert payload["textures"] == {}


# --------------------------------------------------------------------------- #
# Session de jeu de l'API launcher (docs/API.md §1.4)
# --------------------------------------------------------------------------- #


async def test_game_session_rend_l_objet_authenticator(
    app: FastAPI, client: AsyncClient
) -> None:
    """La réponse se mappe telle quelle sur ``minecraft-java-core``."""
    player = await create_player()
    sign_in_as(app, await load_user(player.id))

    response = await client.post(f"{API_PREFIX}/game/session")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["uuid"] == player.mc_uuid
    assert body["name"] == player.mc_name
    assert body["user_properties"] == "{}"
    assert body["meta"] == {
        "type": "OPM",
        "demo": False,
        "expires_at": body["meta"]["expires_at"],
    }
    assert datetime.fromisoformat(body["meta"]["expires_at"]) > datetime.now(UTC)

    # Le jeton délivré est une vraie session Yggdrasil, utilisable en jeu.
    validated = await client.post(
        f"{YGG}/authserver/validate", json={"accessToken": body["access_token"]}
    )
    assert validated.status_code == 204


async def test_game_session_refusee_si_la_possession_a_expire(
    app: FastAPI, client: AsyncClient
) -> None:
    """Refus au format normalisé de ``docs/API.md`` §3, pas au format Mojang."""
    player = await create_player(ownership_ttl=timedelta(days=-1))
    sign_in_as(app, await load_user(player.id))

    response = await client.post(f"{API_PREFIX}/game/session")

    assert response.status_code == 403
    body = response.json()
    assert body["error"] == "microsoft_expired"
    assert "expiré" in body["message"]


async def _antidater_la_partie(user_id: int, secondes: int) -> None:
    """Recule l'ouverture de la partie ouverte du compte, pour simuler du vrai jeu.

    Le service plafonne le temps crédité à la durée réellement écoulée depuis
    ``ygg_session.issued_at`` : c'est la barrière anti-triche de ``docs/DATA.md``
    §4, qui empêche un launcher modifié d'annoncer huit heures de jeu après une
    partie de dix secondes. Une partie ouverte puis refermée dans la même seconde
    ne crédite donc rien — ce qui est le comportement voulu, mais rend un test
    instantané irréaliste. On antidate l'ouverture, comme le font déjà les tests
    d'expiration de ce fichier.
    """
    factory = db.get_sessionmaker()
    async with factory() as session:
        await session.execute(
            update(YggSession)
            .where(
                YggSession.user_id == user_id,
                YggSession.invalidated_at.is_(None),
            )
            .values(issued_at=utcnow() - timedelta(seconds=secondes))
        )
        await session.commit()


async def test_fermeture_de_session_credite_le_temps_de_jeu(
    app: FastAPI, client: AsyncClient
) -> None:
    """``users.tempsdejeu`` augmente et la session de jeu est close."""
    player = await create_player()
    sign_in_as(app, await load_user(player.id))
    opened = (await client.post(f"{API_PREFIX}/game/session")).json()
    await _antidater_la_partie(player.id, 1800)

    response = await client.post(
        f"{API_PREFIX}/game/session/close",
        json={"duration_s": 1800, "client_token": opened["client_token"]},
    )
    assert response.status_code == 204

    factory = db.get_sessionmaker()
    async with factory() as session:
        played = await session.scalar(
            select(User.tempsdejeu).where(User.id == player.id)
        )
        closed = await session.scalar(
            select(YggSession.invalidated_at).where(YggSession.user_id == player.id)
        )
        await session.commit()

    assert played == 1800
    assert closed is not None

    # La session fermée ne vaut plus rien côté jeu.
    validated = await client.post(
        f"{YGG}/authserver/validate", json={"accessToken": opened["access_token"]}
    )
    assert validated.status_code == 403


async def test_fermeture_de_session_cumule_les_durees(
    app: FastAPI, client: AsyncClient
) -> None:
    """L'incrément est additif : deux parties s'additionnent, elles ne s'écrasent pas."""
    player = await create_player()
    sign_in_as(app, await load_user(player.id))

    for duration in (600, 900):
        # Chaque manche est une vraie partie : une session ouverte, jouée, puis
        # close avec son propre `client_token`. Sans lui, rien n'est crédité.
        opened = (await client.post(f"{API_PREFIX}/game/session")).json()
        await _antidater_la_partie(player.id, duration)
        response = await client.post(
            f"{API_PREFIX}/game/session/close",
            json={"duration_s": duration, "client_token": opened["client_token"]},
        )
        assert response.status_code == 204

    factory = db.get_sessionmaker()
    async with factory() as session:
        played = await session.scalar(
            select(User.tempsdejeu).where(User.id == player.id)
        )
        await session.commit()

    assert played == 1500
