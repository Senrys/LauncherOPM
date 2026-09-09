"""Tests du routeur des comptes OPM et du service ``users``.

Ce qui est vérifié ici — et pourquoi
====================================

* **Le compte est celui du site.** ``users.id`` est un entier, ``username`` est
  ``users.name``, toutes les colonnes ``NOT NULL`` du dump sont renseignées à
  l'inscription, et le volet RP (faction, équipage, îles tenues, niveau, temps
  de jeu) est lu — jamais écrit (``docs/DATA.md`` §1 et §4).

* **La compatibilité Werkzeug**, qui est le point le plus délicat du projet :
  une empreinte ``pbkdf2:sha256:260000`` fabriquée à la main — la formule exacte
  de ``werkzeug.security.generate_password_hash`` — doit être acceptée à la
  connexion, puis **renforcée** à 600 000 itérations dans le même format. Si ce
  test tombe, les joueurs ne peuvent plus se connecter au site : c'est le test
  le plus important du fichier (``docs/DATA.md`` §3).

* **La rotation et le rejeu des ``refresh_token``** : un jeton sert une fois, et
  sa réapparition révoque la famille entière (``docs/API.md`` §4.3).

* **``can_play``** : sans rattachement Microsoft valide, le bouton JOUER reste
  éteint, avec le bon motif (``docs/API.md`` §1.2).

* **L'anti-énumération** : même code, même message pour un compte inconnu et un
  mot de passe faux ; ``202`` systématique sur ``password/forgot``.
"""

from __future__ import annotations

import asyncio
import hashlib
import secrets
import string
from datetime import UTC, datetime, timedelta

import pyotp
import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from opm_auth.config import Settings
from opm_auth.models import (
    Equipage,
    Ile,
    McLink,
    RecoveryCode,
    RefreshToken,
    User,
    YggSession,
    utcnow,
)
from opm_auth.security import passwords
from opm_auth.security.deps import ApiError
from opm_auth.services import users
from tests.conftest import (
    API_PREFIX,
    EMAIL,
    LEGACY_ITERATIONS,
    PASSWORD,
    TARGET_ITERATIONS,
    TEST_ITERATIONS,
    USERNAME,
    Account,
    credentials,
    make_user,
    register,
    sign_in,
    werkzeug_hash,
)

AUTH = f"{API_PREFIX}/auth"


# --------------------------------------------------------------------------- #
# Petits utilitaires locaux
# --------------------------------------------------------------------------- #


async def fetch_user(
    sessions: async_sessionmaker[AsyncSession], email: str = EMAIL
) -> User:
    """Relit une ligne ``users`` dans une session courte, puis la referme."""
    async with sessions() as session:
        found = await users.get_by_email(session, email)
        assert found is not None
        return found


def totp_now(secret: str) -> str:
    """Code TOTP courant pour un secret base32."""
    return pyotp.TOTP(secret, digits=6, interval=30).now()


def another_code(code: str) -> str:
    """Un code à six chiffres différent de celui passé."""
    return "000000" if code != "000000" else "111111"


# --------------------------------------------------------------------------- #
# 1. Inscription
# --------------------------------------------------------------------------- #


async def test_inscription_cree_une_ligne_users_complete(
    client: AsyncClient, sessions: async_sessionmaker[AsyncSession]
) -> None:
    """L'inscription crée le compte du site, avec toutes ses colonnes NOT NULL."""
    body = await register(client)

    # -- ce que voit le launcher -------------------------------------------
    assert isinstance(body["id"], int), "users.id est un entier (serial), pas un UUID"
    assert body["username"] == USERNAME
    assert body["email"] == EMAIL
    assert body["role"] == "player"
    assert body["totp_enabled"] is False
    # Sans rattachement Microsoft, le bouton JOUER reste éteint.
    assert body["can_play"] is False
    assert body["blocked_reason"] == "microsoft_required"
    assert body["microsoft"]["linked"] is False
    # Fiche RP vide : le launcher n'invente ni faction, ni équipage, ni métier.
    assert body["profile"]["faction"] is None
    assert body["profile"]["equipage"] is None
    assert body["profile"]["metier"] is None
    assert body["profile"]["iles_tenues"] == 0
    assert body["profile"]["niveau"] == users.STARTING_LEVEL
    assert body["profile"]["temps_de_jeu_s"] == 0

    # -- ce qui est réellement écrit en base --------------------------------
    stored = await fetch_user(sessions)
    assert stored.name == USERNAME
    assert stored.datejoin is not None
    assert stored.derniereconnexion is None, "aucune connexion n'a encore eu lieu"
    assert stored.tempsdejeu == 0
    # Format Werkzeug, lisible par le site (docs/DATA.md §3).
    assert stored.password_hash.startswith(f"pbkdf2:sha256:{TEST_ITERATIONS}$")
    # Les colonnes NOT NULL sans valeur par défaut sont bien renseignées.
    for column in users.NEW_ACCOUNT_DEFAULTS:
        assert getattr(stored, column) is not None
    # Les colonnes nullables restent nulles : pas de fausse prime à zéro.
    assert stored.prime is None
    assert stored.berry is None


async def test_inscription_hors_defauts_refusee_par_la_base(
    session: AsyncSession,
) -> None:
    """Sans :data:`NEW_ACCOUNT_DEFAULTS`, l'``INSERT`` viole les contraintes du site.

    C'est la démonstration que ces valeurs ne sont pas décoratives : la table
    ``users`` du dump déclare dix-sept colonnes ``NOT NULL`` sans valeur par
    défaut, et une ligne incomplète est rejetée.
    """
    session.add(
        User(name="Incomplet", email="incomplet@exemple.fr", password_hash="x")
    )
    with pytest.raises(IntegrityError):
        await session.flush()
    await session.rollback()


async def test_inscription_refuse_les_doublons(
    client: AsyncClient, unlimited: None
) -> None:
    """Adresse et pseudonyme sont uniques, sans égard à la casse."""
    await register(client)

    same_email = await client.post(
        f"{AUTH}/register", json=credentials(email=EMAIL.upper(), username="Zoro")
    )
    assert same_email.status_code == 409
    assert same_email.json()["error"] == "email_taken"

    same_username = await client.post(
        f"{AUTH}/register",
        json=credentials(email="second@exemple.fr", username=USERNAME.lower()),
    )
    assert same_username.status_code == 409
    assert same_username.json()["error"] == "username_taken"


async def test_inscription_refuse_un_mot_de_passe_faible(client: AsyncClient) -> None:
    """Douze caractères minimum, et pas un mot de passe notoire."""
    trop_court = await client.post(f"{AUTH}/register", json=credentials(password="Court-1234"))
    # Le refus peut venir du schéma Pydantic (422) ou de check_password_strength
    # (400 « weak_password ») selon l'endroit où la borne est portée ; ce que ce
    # test garantit, c'est qu'un mot de passe de dix caractères n'ouvre pas de
    # compte, et que le joueur reçoit une explication.
    assert trop_court.status_code in (400, 422), trop_court.text
    if trop_court.status_code == 400:
        assert trop_court.json()["error"] == "weak_password"
        assert trop_court.json()["details"]["reasons"]

    notoire = await client.post(f"{AUTH}/register", json=credentials(password="motdepasse123"))
    assert notoire.status_code == 400
    body = notoire.json()
    assert body["error"] == "weak_password"
    assert body["details"]["reasons"], "le refus doit être expliqué en français"


# --------------------------------------------------------------------------- #
# 2. Connexion
# --------------------------------------------------------------------------- #


async def test_connexion_delivre_les_jetons_et_date_la_visite(
    client: AsyncClient, sessions: async_sessionmaker[AsyncSession]
) -> None:
    """Une connexion réussie écrit ``users.derniereconnexion``, et rien d'autre."""
    await register(client)
    before = await fetch_user(sessions)
    assert before.derniereconnexion is None
    tempsdejeu_avant = before.tempsdejeu

    body = await sign_in(client)
    assert body["token_type"] == "Bearer"
    assert body["expires_in"] > 0
    assert body["access_token"] and body["refresh_token"]
    assert body["user"]["email"] == EMAIL

    after = await fetch_user(sessions)
    assert after.derniereconnexion is not None
    assert after.tempsdejeu == tempsdejeu_avant, "la connexion ne touche pas au temps de jeu"


async def test_connexion_insensible_a_la_casse_de_l_adresse(client: AsyncClient) -> None:
    """Un joueur inscrit sur le site sous « Capitaine@… » se connecte quand même."""
    await register(client)
    body = await sign_in(client, email=EMAIL.upper())
    assert body["user"]["email"] == EMAIL


async def test_mauvais_mot_de_passe_et_compte_inconnu_sont_indiscernables(
    client: AsyncClient, unlimited: None
) -> None:
    """Anti-énumération : même code, même message (``docs/API.md`` §4.6)."""
    await register(client)

    faux = await client.post(
        f"{AUTH}/login", json={"email": EMAIL, "password": "Mauvais-Mot-2026!"}
    )
    inconnu = await client.post(
        f"{AUTH}/login", json={"email": "personne@exemple.fr", "password": PASSWORD}
    )

    assert faux.status_code == inconnu.status_code == 401
    assert faux.json() == inconnu.json()
    assert faux.json()["error"] == "invalid_credentials"


async def test_me_renvoie_le_compte_courant(client: AsyncClient, account: Account) -> None:
    """``GET /auth/me`` relit le compte porté par l'``access_token``."""
    anonyme = await client.get(f"{AUTH}/me")
    assert anonyme.status_code == 401

    response = await client.get(f"{AUTH}/me", headers=account.auth)
    assert response.status_code == 200, response.text
    assert response.json()["id"] == account.id


async def test_limitation_de_debit_sur_la_connexion(client: AsyncClient) -> None:
    """Cinq tentatives par minute et par IP (``docs/API.md`` §4.4)."""
    await register(client)
    payload = {"email": EMAIL, "password": "Mauvais-Mot-2026!"}

    for attempt in range(5):
        refused = await client.post(f"{AUTH}/login", json=payload)
        assert refused.status_code == 401, f"tentative {attempt + 1}"

    limited = await client.post(f"{AUTH}/login", json=payload)
    assert limited.status_code == 429
    assert limited.json()["error"] == "rate_limited"
    assert limited.headers["Retry-After"]


# --------------------------------------------------------------------------- #
# 3. Compatibilité Werkzeug — le cœur du sujet
# --------------------------------------------------------------------------- #


async def test_empreinte_du_site_acceptee_puis_renforcee(
    client: AsyncClient,
    sessions: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Une empreinte ``pbkdf2:sha256:260000`` du site est acceptée, puis renforcée.

    L'empreinte est fabriquée par :func:`tests.conftest.werkzeug_hash`, qui
    n'utilise que :mod:`hashlib` : elle reproduit la formule de Flask sans
    passer par notre code. Le test prouve donc une **interopérabilité**, pas une
    cohérence interne.

    Après la connexion, l'empreinte stockée doit :

    * avoir changé, et porter 600 000 itérations ;
    * rester au **format Werkzeug**, sans quoi le site ne saurait plus vérifier
      le mot de passe et le joueur perdrait l'accès à ``onepieceminecraft.fr``.
    """
    monkeypatch.setattr(passwords, "target_iterations", lambda: TARGET_ITERATIONS)

    legacy = werkzeug_hash(PASSWORD, iterations=LEGACY_ITERATIONS)
    assert legacy.startswith(f"pbkdf2:sha256:{LEGACY_ITERATIONS}$")

    async with sessions() as session:
        session.add(make_user(password_hash=legacy))
        await session.commit()

    body = await sign_in(client)
    assert body["access_token"]

    renforcee = (await fetch_user(sessions)).password_hash
    assert renforcee != legacy, "l'empreinte devait être réécrite"
    assert renforcee.startswith(f"pbkdf2:sha256:{TARGET_ITERATIONS}$")
    assert renforcee.count("$") == 2, "format Werkzeug : méthode$sel$hexadécimal"
    # Le mot de passe fonctionne toujours, et l'empreinte est stable.
    assert passwords.verify_password(renforcee, PASSWORD) is True
    assert passwords.needs_rehash(renforcee) is False

    second = await sign_in(client)
    assert second["user"]["email"] == EMAIL
    assert (await fetch_user(sessions)).password_hash == renforcee


async def test_empreinte_scrypt_de_werkzeug_moderne_acceptee(
    client: AsyncClient, sessions: async_sessionmaker[AsyncSession]
) -> None:
    """Werkzeug ≥ 2.3 écrit du ``scrypt`` : il doit être lu, et réécrit en pbkdf2.

    Le jour où le site passera à une version récente de Flask, les empreintes
    changeront de forme sans prévenir. Le serveur d'authentification doit
    continuer d'ouvrir la porte — puis ramener l'empreinte à notre format
    canonique, que les deux camps savent lire.
    """
    salt = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(16))
    n, r, p = 2**15, 8, 1
    digest = hashlib.scrypt(
        PASSWORD.encode("utf-8"),
        salt=salt.encode("utf-8"),
        n=n,
        r=r,
        p=p,
        maxmem=132 * n * r * p,
    )
    stored = f"scrypt:{n}:{r}:{p}${salt}${digest.hex()}"

    async with sessions() as session:
        session.add(make_user(password_hash=stored))
        await session.commit()

    await sign_in(client)

    renforcee = (await fetch_user(sessions)).password_hash
    assert renforcee.startswith(f"pbkdf2:sha256:{TEST_ITERATIONS}$")


# --------------------------------------------------------------------------- #
# 4. Sessions : rotation et rejeu
# --------------------------------------------------------------------------- #


async def test_rotation_du_refresh_token(
    client: AsyncClient, account: Account, unlimited: None
) -> None:
    """Le jeton présenté est consommé et remplacé par un jeton neuf."""
    response = await client.post(f"{AUTH}/refresh", json={"refresh_token": account.refresh_token})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["refresh_token"] != account.refresh_token
    assert body["access_token"]

    encore = await client.post(f"{AUTH}/refresh", json={"refresh_token": body["refresh_token"]})
    assert encore.status_code == 200, "le nouveau jeton doit fonctionner une fois"


async def test_rejeu_du_refresh_token_revoque_la_famille(
    client: AsyncClient,
    account: Account,
    sessions: async_sessionmaker[AsyncSession],
    unlimited: None,
) -> None:
    """Un jeton déjà consommé qui ressurgit fait tomber toute la chaîne.

    C'est la contre-mesure de ``docs/API.md`` §4.3 : présenter un jeton déjà
    remplacé signifie qu'il a été volé — ou que le client légitime a été doublé.
    Dans les deux cas, la seule réponse sûre est de tout révoquer.
    """
    premier = await client.post(f"{AUTH}/refresh", json={"refresh_token": account.refresh_token})
    successeur = premier.json()["refresh_token"]

    rejeu = await client.post(f"{AUTH}/refresh", json={"refresh_token": account.refresh_token})
    assert rejeu.status_code == 401
    assert rejeu.json()["error"] == "token_revoked"

    # Le successeur, pourtant jamais utilisé, tombe avec la famille.
    apres = await client.post(f"{AUTH}/refresh", json={"refresh_token": successeur})
    assert apres.status_code == 401
    assert apres.json()["error"] == "token_revoked"

    async with sessions() as session:
        vivants = await session.scalars(
            select(RefreshToken).where(
                RefreshToken.user_id == account.id, RefreshToken.revoked_at.is_(None)
            )
        )
        assert list(vivants) == [], "plus aucun jeton vivant dans la famille"


async def test_deconnexion_ferme_la_famille(
    client: AsyncClient, account: Account, unlimited: None
) -> None:
    """``/auth/logout`` révoque la chaîne née de cette connexion, et reste idempotent."""
    response = await client.post(f"{AUTH}/logout", json={"refresh_token": account.refresh_token})
    assert response.status_code == 204

    encore = await client.post(f"{AUTH}/logout", json={"refresh_token": account.refresh_token})
    assert encore.status_code == 204, "un jeton déjà révoqué ne doit pas être un oracle"

    refuse = await client.post(f"{AUTH}/refresh", json={"refresh_token": account.refresh_token})
    assert refuse.status_code == 401
    assert refuse.json()["error"] == "token_revoked"


async def test_refresh_token_inconnu_refuse(client: AsyncClient) -> None:
    """Un jeton inventé ne renvoie ni 500, ni indice."""
    response = await client.post(
        f"{AUTH}/refresh", json={"refresh_token": secrets.token_urlsafe(48)}
    )
    assert response.status_code == 401
    assert response.json()["error"] == "token_revoked"


# --------------------------------------------------------------------------- #
# 5. Droit de jouer
# --------------------------------------------------------------------------- #


async def _link_microsoft(
    sessions: async_sessionmaker[AsyncSession],
    user_id: int,
    *,
    owns: bool = True,
    expires_in_days: int = 30,
) -> None:
    """Pose un rattachement Microsoft directement en base."""
    now = utcnow()
    async with sessions() as session:
        session.add(
            McLink(
                user_id=user_id,
                msa_sub=secrets.token_hex(8),
                minecraft_uuid=secrets.token_hex(16),
                minecraft_username="Melodia",
                owns_minecraft=owns,
                verified_at=now,
                expires_at=now + timedelta(days=expires_in_days),
            )
        )
        await session.commit()


async def test_can_play_exige_un_rattachement_microsoft(
    client: AsyncClient, account: Account, sessions: async_sessionmaker[AsyncSession]
) -> None:
    """Sans rattachement, le bouton JOUER reste éteint avec le bon motif."""
    avant = await client.get(f"{AUTH}/me", headers=account.auth)
    assert avant.json()["can_play"] is False
    assert avant.json()["blocked_reason"] == "microsoft_required"

    await _link_microsoft(sessions, account.id)

    apres = await client.get(f"{AUTH}/me", headers=account.auth)
    body = apres.json()
    assert body["can_play"] is True
    assert body["blocked_reason"] is None
    assert body["microsoft"]["linked"] is True
    assert body["microsoft"]["owns_minecraft"] is True
    assert len(body["microsoft"]["minecraft_uuid"]) == 32, "UUID premium, sans tirets"


async def test_can_play_refuse_une_possession_absente_ou_perimee(
    client: AsyncClient, account: Account, sessions: async_sessionmaker[AsyncSession]
) -> None:
    """``ownership_missing`` puis ``microsoft_expired`` selon l'état du rattachement."""
    await _link_microsoft(sessions, account.id, owns=False)
    sans_minecraft = await client.get(f"{AUTH}/me", headers=account.auth)
    assert sans_minecraft.json()["blocked_reason"] == "ownership_missing"

    async with sessions() as session:
        link = await session.scalar(select(McLink).where(McLink.user_id == account.id))
        assert link is not None
        link.owns_minecraft = True
        link.expires_at = utcnow() - timedelta(days=1)
        await session.commit()

    perime = await client.get(f"{AUTH}/me", headers=account.auth)
    assert perime.json()["blocked_reason"] == "microsoft_expired"


async def test_modes_d_authentification(
    account: Account, sessions: async_sessionmaker[AsyncSession]
) -> None:
    """``sovereign`` n'exige rien, ``microsoft`` exige toujours, ``hybrid`` obéit au réglage."""
    sovereign = Settings(auth_mode="sovereign", microsoft_required=False)
    hybrid = Settings(auth_mode="hybrid", microsoft_required=True)
    microsoft = Settings(auth_mode="microsoft", microsoft_required=False)

    assert users.microsoft_required(sovereign) is False
    assert users.microsoft_required(hybrid) is True
    # En mode « microsoft », l'identité EST Microsoft : le réglage ne peut pas
    # l'assouplir.
    assert users.microsoft_required(microsoft) is True

    user = await fetch_user(sessions)
    assert users.can_play(user, settings=sovereign) is True
    assert users.can_play(user, settings=hybrid) is False
    assert users.serialize(user, settings=sovereign).blocked_reason is None


# --------------------------------------------------------------------------- #
# 6. Profil RP lu dans la base du site
# --------------------------------------------------------------------------- #


async def test_profil_rp_et_iles_tenues(
    client: AsyncClient, account: Account, sessions: async_sessionmaker[AsyncSession]
) -> None:
    """« Pirate · Équipage des Cœurs Brisés · 3 îles tenues » vient bien de la base.

    Le lien entre le joueur et son équipage est **textuel** dans le schéma du
    site (``users.equipage`` ↔ ``equipages.nom``) : le compte des îles passe par
    cette jointure, faute de clé étrangère.
    """
    async with sessions() as session:
        crew = Equipage(nom="Les Cœurs Brisés", reputation=120, membres=8, iles="Trois")
        session.add(crew)
        await session.flush()
        session.add_all(
            Ile(nom=f"Île {index}", equipage_id=crew.id, principale=index == 1)
            for index in range(1, 4)
        )
        # Une île tenue par un autre équipage ne doit pas être comptée.
        session.add(Ile(nom="Île adverse", equipage_id=None))

        user = await session.get(User, account.id)
        assert user is not None
        user.faction = "Pirate"
        user.equipage = "Les Cœurs Brisés"
        user.metier = "Charpentier"
        user.prime = 42_000_000
        user.berry = 128_400
        user.niveaubase = 47
        user.tempsdejeu = 918_000
        await session.commit()

    response = await client.get(f"{AUTH}/me", headers=account.auth)
    profile = response.json()["profile"]
    assert profile["faction"] == "Pirate"
    assert profile["equipage"] == "Les Cœurs Brisés"
    assert profile["metier"] == "Charpentier"
    assert profile["iles_tenues"] == 3
    assert profile["prime"] == 42_000_000
    assert profile["berry"] == 128_400
    assert profile["niveau"] == 47
    assert profile["temps_de_jeu_s"] == 918_000


async def _ouvrir_session_de_jeu(
    sessions: async_sessionmaker[AsyncSession],
    user_id: int,
    *,
    client_token: str,
    il_y_a_s: int,
    duree_s: int = 86_400,
) -> None:
    """Pose une ligne ``ygg_session`` ouverte, émise il y a ``il_y_a_s`` secondes."""
    emission = utcnow() - timedelta(seconds=il_y_a_s)
    async with sessions() as session:
        session.add(
            YggSession(
                user_id=user_id,
                access_token=secrets.token_hex(32),
                client_token=client_token,
                issued_at=emission,
                expires_at=emission + timedelta(seconds=duree_s),
            )
        )
        await session.commit()


async def test_temps_de_jeu_s_ajoute_sans_lecture_prealable(
    account: Account, sessions: async_sessionmaker[AsyncSession]
) -> None:
    """``add_playtime`` incrémente ``users.tempsdejeu`` par addition en base.

    Jamais de lire-puis-écrire : le serveur Minecraft et le site touchent la
    même colonne (``docs/DATA.md`` §4). Deux parties successives s'additionnent
    donc, elles ne s'écrasent pas.
    """
    await _ouvrir_session_de_jeu(sessions, account.id, client_token="partie-1", il_y_a_s=3_600)
    async with sessions() as session:
        premiere = await users.add_playtime(
            session, account.id, 1_800, client_token="partie-1"
        )
    assert premiere == 1_800
    assert (await fetch_user(sessions)).tempsdejeu == 1_800

    await _ouvrir_session_de_jeu(sessions, account.id, client_token="partie-2", il_y_a_s=3_600)
    async with sessions() as session:
        seconde = await users.add_playtime(session, account.id, 1_200, client_token="partie-2")
    assert seconde == 1_200
    assert (await fetch_user(sessions)).tempsdejeu == 3_000

    # Une durée nulle ou négative clôt la session sans rien créditer.
    await _ouvrir_session_de_jeu(sessions, account.id, client_token="partie-3", il_y_a_s=60)
    async with sessions() as session:
        assert await users.add_playtime(session, account.id, 0, client_token="partie-3") == 0
    await _ouvrir_session_de_jeu(sessions, account.id, client_token="partie-4", il_y_a_s=60)
    async with sessions() as session:
        assert await users.add_playtime(session, account.id, -60, client_token="partie-4") == 0
    assert (await fetch_user(sessions)).tempsdejeu == 3_000


async def test_temps_de_jeu_plafonne_et_non_rejouable(
    account: Account, sessions: async_sessionmaker[AsyncSession]
) -> None:
    """La durée annoncée par le launcher n'est jamais crue sur parole.

    ``users.tempsdejeu`` est une colonne du **site**, affichée sur
    onepieceminecraft.fr : un launcher modifié ne doit pas pouvoir s'attribuer
    des années de jeu. Trois refus sont vérifiés ici : sans session ouverte, au
    delà du temps réellement écoulé, et au rejeu de la même clôture.
    """
    # 1. Aucune session ouverte : rien n'est crédité.
    async with sessions() as session:
        with pytest.raises(ApiError) as sans_session:
            await users.add_playtime(session, account.id, 600, client_token="jamais-ouverte")
    assert sans_session.value.code == "game_session_unknown"

    # 2. Vingt-quatre heures annoncées sur une session ouverte il y a vingt
    #    minutes : ramenées au temps écoulé.
    await _ouvrir_session_de_jeu(sessions, account.id, client_token="partie", il_y_a_s=1_200)
    async with sessions() as session:
        credite = await users.add_playtime(
            session, account.id, 86_400, client_token="partie"
        )
    assert 1_200 <= credite <= 1_210, "plafonné au temps écoulé depuis l'ouverture"
    assert (await fetch_user(sessions)).tempsdejeu == credite

    # 3. Rejeu de la même clôture : refusée, et le compteur ne bouge plus.
    async with sessions() as session:
        with pytest.raises(ApiError) as rejeu:
            await users.add_playtime(session, account.id, 1_200, client_token="partie")
    assert rejeu.value.code == "game_session_unknown"
    assert (await fetch_user(sessions)).tempsdejeu == credite


@pytest.mark.postgres
async def test_temps_de_jeu_atomique_sous_concurrence(
    postgres_sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    """Deux ajouts simultanés ne s'écrasent pas — vérifiable seulement sur PostgreSQL.

    SQLite en mémoire ne partage qu'une connexion : il ne peut pas prouver
    l'atomicité. Ce test exige donc une vraie base PostgreSQL
    (``OPM_TEST_POSTGRES_URL``) et reste ignoré sans elle.

    La ligne ``users`` écrite ici vit dans le **schéma jetable** monté par la
    fixture (``tests/conftest.py``, :data:`~tests.conftest.TEST_SCHEMA`), jamais
    dans ``public`` : la table ``users`` du site n'est ni lue, ni écrite, ni
    approchée par ce test.
    """
    async with postgres_sessionmaker() as session:
        user = make_user(
            email="concurrence@exemple.fr",
            username="Concurrence",
            password_hash=werkzeug_hash(PASSWORD, iterations=1_000),
        )
        session.add(user)
        await session.commit()
        user_id = user.id

    async def add(seconds: int) -> None:
        async with postgres_sessionmaker() as session:
            await users.add_playtime(session, user_id, seconds)

    await asyncio.gather(*(add(60) for _ in range(10)))

    async with postgres_sessionmaker() as session:
        total = await session.scalar(select(User.tempsdejeu).where(User.id == user_id))
    assert total == 600


# --------------------------------------------------------------------------- #
# 7. Mot de passe oublié
# --------------------------------------------------------------------------- #


async def test_mot_de_passe_oublie_ne_revele_rien(
    client: AsyncClient, account: Account, reset_links: list[tuple[int, str]]
) -> None:
    """``202`` que l'adresse existe ou non, et un seul lien vivant à la fois."""
    inconnue = await client.post(
        f"{AUTH}/password/forgot", json={"email": "personne@exemple.fr"}
    )
    assert inconnue.status_code == 202
    assert reset_links == [], "aucun courriel pour une adresse inconnue"

    connue = await client.post(f"{AUTH}/password/forgot", json={"email": EMAIL})
    assert connue.status_code == 202
    assert len(reset_links) == 1
    assert reset_links[0][0] == account.id


async def test_reinitialisation_change_le_mot_de_passe_et_ferme_les_sessions(
    client: AsyncClient,
    account: Account,
    reset_links: list[tuple[int, str]],
    sessions: async_sessionmaker[AsyncSession],
    unlimited: None,
) -> None:
    """Le jeton sert une fois, la nouvelle empreinte reste lisible par le site."""
    await client.post(f"{AUTH}/password/forgot", json={"email": EMAIL})
    _, token = reset_links[-1]
    nouveau = "Nouveau-Mot-2026!"

    response = await client.post(
        f"{AUTH}/password/reset", json={"token": token, "password": nouveau}
    )
    assert response.status_code == 204

    stored = await fetch_user(sessions)
    assert stored.password_hash.startswith(f"pbkdf2:sha256:{TEST_ITERATIONS}$")
    assert passwords.verify_password(stored.password_hash, nouveau) is True

    # Le jeton ne peut pas resservir.
    rejeu = await client.post(
        f"{AUTH}/password/reset", json={"token": token, "password": "Encore-Un-2026!"}
    )
    assert rejeu.status_code == 401

    # Les sessions ouvertes sont tombées : le mot de passe avait peut-être fuité.
    refuse = await client.post(f"{AUTH}/refresh", json={"refresh_token": account.refresh_token})
    assert refuse.status_code == 401

    # L'ancien mot de passe ne fonctionne plus, le nouveau oui.
    ancien = await client.post(f"{AUTH}/login", json={"email": EMAIL, "password": PASSWORD})
    assert ancien.status_code == 401
    await sign_in(client, password=nouveau)


# --------------------------------------------------------------------------- #
# 8. Double authentification
# --------------------------------------------------------------------------- #


async def _enable_totp(client: AsyncClient, account: Account) -> tuple[str, list[str]]:
    """Active la 2FA sur un compte et retourne ``(secret, codes de secours)``."""
    setup = await client.post(f"{AUTH}/totp/setup", headers=account.auth)
    assert setup.status_code == 200, setup.text
    body = setup.json()
    assert body["otpauth_uri"].startswith("otpauth://totp/")
    assert len(body["recovery_codes"]) >= 4

    enable = await client.post(
        f"{AUTH}/totp/enable", headers=account.auth, json={"code": totp_now(body["secret"])}
    )
    assert enable.status_code == 204, enable.text
    return body["secret"], list(body["recovery_codes"])


async def test_2fa_activation_puis_connexion(
    client: AsyncClient, account: Account, unlimited: None
) -> None:
    """Une fois la 2FA active, le code devient obligatoire à la connexion."""
    secret, _ = await _enable_totp(client, account)

    sans_code = await client.post(
        f"{AUTH}/login", json={"email": EMAIL, "password": PASSWORD}
    )
    assert sans_code.status_code == 401
    assert sans_code.json()["error"] == "totp_required"

    mauvais = await client.post(
        f"{AUTH}/login",
        json={"email": EMAIL, "password": PASSWORD, "totp": another_code(totp_now(secret))},
    )
    assert mauvais.status_code == 401
    assert mauvais.json()["error"] == "totp_invalid"

    body = await sign_in(client, totp=totp_now(secret))
    assert body["user"]["totp_enabled"] is True


async def test_2fa_code_de_secours_a_usage_unique(
    client: AsyncClient,
    account: Account,
    sessions: async_sessionmaker[AsyncSession],
    unlimited: None,
) -> None:
    """Un code de secours ouvre la porte une fois, et une seule."""
    _, codes = await _enable_totp(client, account)
    secours = codes[0]

    await sign_in(client, totp=secours)

    rejoue = await client.post(
        f"{AUTH}/login", json={"email": EMAIL, "password": PASSWORD, "totp": secours}
    )
    assert rejoue.status_code == 401
    assert rejoue.json()["error"] == "totp_invalid"

    async with sessions() as session:
        consommes = await session.scalars(
            select(RecoveryCode).where(
                RecoveryCode.user_id == account.id, RecoveryCode.used_at.is_not(None)
            )
        )
        assert len(list(consommes)) == 1


async def test_2fa_desactivation_exige_mot_de_passe_et_code(
    client: AsyncClient, account: Account, unlimited: None
) -> None:
    """Désactiver la 2FA demande les deux facteurs, puis efface tout."""
    secret, _ = await _enable_totp(client, account)

    mauvais_mot = await client.post(
        f"{AUTH}/totp/disable",
        headers=account.auth,
        json={"password": "Mauvais-Mot-2026!", "code": totp_now(secret)},
    )
    assert mauvais_mot.status_code == 401
    assert mauvais_mot.json()["error"] == "invalid_credentials"

    ok = await client.post(
        f"{AUTH}/totp/disable",
        headers=account.auth,
        json={"password": PASSWORD, "code": totp_now(secret)},
    )
    assert ok.status_code == 204, ok.text

    # La connexion redevient simple.
    body = await sign_in(client)
    assert body["user"]["totp_enabled"] is False


# --------------------------------------------------------------------------- #
# 9. Sérialisation
# --------------------------------------------------------------------------- #


async def test_serialisation_sans_iles_ne_requiete_pas(
    sessions: async_sessionmaker[AsyncSession], client: AsyncClient
) -> None:
    """``serialize`` est un mappage pur : elle n'émet aucune requête.

    La preuve tient à la fixture : :func:`fetch_user` referme sa session, donc
    le compte est **détaché**. La moindre lecture différée lèverait un
    ``DetachedInstanceError`` — et c'est bien ce qu'on veut garantir, puisque
    cette lecture différée serait de toute façon interdite en contexte
    asynchrone.
    """
    await register(client)
    user = await fetch_user(sessions)

    view = users.serialize(user)
    assert view.id == user.id
    assert view.username == user.name
    assert view.profile.iles_tenues == 0
    assert view.created_at is not None
    assert isinstance(view.created_at, datetime)
    assert view.created_at.tzinfo is not None, "les dates sortent en UTC conscient"
    assert view.created_at <= datetime.now(UTC) + timedelta(minutes=1)
