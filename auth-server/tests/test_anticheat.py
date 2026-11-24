# ruff: noqa: F811 — les fixtures de test_yggdrasil, importées, sont redéfinies en paramètres
"""Anti-triche : empreinte du launcher, rapport du mod, refus au join, alertes."""

from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from opm_auth import db
from opm_auth.config import get_settings
from opm_auth.models import Alerte, Controle, GameReport, utcnow
from opm_auth.services import anticheat
from sqlalchemy import select

from tests.test_yggdrasil import (  # noqa: F401 — fixtures et raccourcis partagés
    API_PREFIX,
    SESSION,
    app,
    client,
    create_player,
    join,
    launcher_session,
)

OFFICIAL = [
    {"path": "mods/create-6.0.jar", "hash": "a" * 40, "size": 1},
    {"path": "mods/jei-19.jar", "hash": "b" * 40, "size": 1},
    {"path": "config/jei/x.toml", "hash": "c" * 40, "size": 1},
]


@pytest.fixture(autouse=True)
def modpack(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Un modpack officiel local, et le verrou d'empreinte actif."""
    manifest = tmp_path / "files.json"
    manifest.write_text(json.dumps(OFFICIAL))
    monkeypatch.setattr(get_settings(), "modpack_manifest", str(manifest))
    monkeypatch.setattr(get_settings(), "join_require_attestation", True)
    monkeypatch.setattr(get_settings(), "join_launcher_only", True)
    anticheat.reset_cache()
    return manifest


async def attest(client: AsyncClient, opened: dict[str, Any], mods: list[dict[str, str]]) -> Any:
    return await client.post(
        f"{API_PREFIX}/game/attest",
        json={"client_token": opened["clientToken"], "mods": mods, "resourcepacks": ["Faithful"]},
    )


GOOD = [
    {"path": "mods/create-6.0.jar", "sha1": "a" * 40},
    {"path": "mods/jei-19.jar", "sha1": "b" * 40},
    {"path": "mods/opm-1.0.0.jar", "sha1": "f" * 40},
]


async def test_empreinte_conforme_ouvre_le_serveur(app: FastAPI, client: AsyncClient) -> None:
    player = await create_player()
    opened = await launcher_session(app, client, player)

    response = await attest(client, opened, GOOD)
    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True

    assert (await join(client, opened, "serveur-propre")).status_code == 204


async def test_sans_empreinte_le_serveur_reste_ferme(app: FastAPI, client: AsyncClient) -> None:
    """Un launcher trop ancien (rien de déclaré) : « mettez le launcher à jour »."""
    player = await create_player()
    opened = await launcher_session(app, client, player)

    response = await join(client, opened, "serveur-ancien")
    assert response.status_code == 403
    assert "à jour" in response.json()["errorMessage"]


async def test_mod_en_trop_refuse_et_alerte(app: FastAPI, client: AsyncClient) -> None:
    player = await create_player()
    opened = await launcher_session(app, client, player)

    response = await attest(client, opened, [*GOOD, {"path": "mods/wurst-7.jar", "sha1": "d" * 40}])
    body = response.json()
    assert body["ok"] is False
    assert body["extra"] == ["mods/wurst-7.jar"]
    assert "modpack" in body["message"]

    response = await join(client, opened, "serveur-triche")
    assert response.status_code == 403
    assert "modpack" in response.json()["errorMessage"]

    async with db.get_sessionmaker()() as session:
        alerts = (await session.execute(select(Alerte))).scalars().all()
        reports = (await session.execute(select(GameReport))).scalars().all()
    assert [a.type for a in alerts] == ["fichiers"]
    assert "wurst-7.jar" in alerts[0].detail
    assert reports and reports[0].ok is False


async def test_mod_modifie_refuse(app: FastAPI, client: AsyncClient) -> None:
    player = await create_player()
    opened = await launcher_session(app, client, player)

    mods = [{"path": "mods/create-6.0.jar", "sha1": "e" * 40}, GOOD[1]]
    body = (await attest(client, opened, mods)).json()
    assert body["ok"] is False
    assert body["modified"] == ["mods/create-6.0.jar"]


async def test_modpack_illisible_laisse_passer(
    app: FastAPI, client: AsyncClient, modpack: Path
) -> None:
    """Une panne de notre côté ne doit pas fermer le serveur à tout le monde."""
    modpack.unlink()
    anticheat.reset_cache()
    player = await create_player()
    opened = await launcher_session(app, client, player)

    assert (await attest(client, opened, GOOD)).json()["ok"] is True
    assert (await join(client, opened, "serveur-panne")).status_code == 204


async def test_rapport_du_mod_x_ray(app: FastAPI, client: AsyncClient) -> None:
    player = await create_player()
    opened = await launcher_session(app, client, player)

    response = await client.post(
        f"{API_PREFIX}/game/report",
        headers={"Authorization": f"Bearer {opened['accessToken']}"},
        json={
            "phase": "join",
            "mods": [
                {"id": "minecraft", "version": "1.21.1", "file": ""},
                {"id": "create", "version": "6.0", "file": "create-6.0.jar"},
                {"id": "opm", "version": "1.0.0", "file": "opm-1.0.0.jar"},
            ],
            "resourcepacks": [{"id": "file/xray.zip", "title": "XRay Ultimate", "xray": True}],
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is False
    assert any("X-ray" in r for r in body["reasons"])
    assert "Je te vois" in body["message"]


async def test_rapport_du_mod_propre(app: FastAPI, client: AsyncClient) -> None:
    player = await create_player()
    opened = await launcher_session(app, client, player)

    response = await client.post(
        f"{API_PREFIX}/game/report",
        headers={"Authorization": f"Bearer {opened['accessToken']}"},
        json={"phase": "periodic", "mods": [{"id": "jei", "file": "jei-19.jar"}], "resourcepacks": []},
    )
    assert response.json() == {"ok": True, "message": None, "reasons": [], "extra": [], "modified": []}


def test_copie_connector_reconnue() -> None:
    """Un mod Fabric chargé par Connector est rapporté sous le nom de sa copie convertie."""
    official = {"mods/continuity-3.0.0+1.21.neoforge.jar": "d" * 40}
    copy = {"id": "continuity", "file": "continuity-3.0.0+1.21.neoforge_mapped_moj_1.21.1.jar"}
    assert anticheat.evaluate_report([copy], [], official) == []
    stranger = {"id": "xray", "file": "xray-1.0_mapped_moj_1.21.1.jar"}
    assert anticheat.evaluate_report([stranger], [], official) == [
        "mod inconnu : xray-1.0.jar (xray)"
    ]


async def test_rapport_sans_jeton_de_jeu(client: AsyncClient) -> None:
    response = await client.post(f"{API_PREFIX}/game/report", json={"phase": "join"})
    assert response.status_code == 401


async def test_les_alertes_sont_relayees(monkeypatch: pytest.MonkeyPatch) -> None:
    """Le Skript écrit une alerte ; la tâche de fond la relaie puis la coche."""
    sent: list[dict[str, Any]] = []

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

    class FakeClient:
        def __init__(self, *a: Any, **k: Any) -> None: ...
        async def __aenter__(self) -> FakeClient:
            return self
        async def __aexit__(self, *a: Any) -> None: ...
        async def post(self, url: str, json: dict[str, Any]) -> FakeResponse:
            sent.append(json)
            return FakeResponse()

    monkeypatch.setattr(anticheat.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(get_settings(), "anticheat_webhook", "https://exemple.invalid/hook")
    async with db.get_sessionmaker()() as session:
        session.add(Alerte(joueur="Tricheur", type="vol", detail="5 s en l'air"))
        await session.commit()

    assert await anticheat.relay_alerts() == 1
    assert "Tricheur" in sent[0]["content"]
    assert await anticheat.relay_alerts() == 0


# ------------------------------------------------------------------ suivi (0005)
async def report(client: AsyncClient, opened: dict[str, Any], **body: Any) -> dict[str, Any]:
    response = await client.post(
        f"{API_PREFIX}/game/report",
        headers={"Authorization": f"Bearer {opened['accessToken']}"},
        json={"phase": "periodic", "mods": [], "resourcepacks": [], **body},
    )
    assert response.status_code == 200, response.text
    return response.json()


async def rows(model: Any) -> list[Any]:
    async with db.get_sessionmaker()() as session:
        return list((await session.execute(select(model).order_by(model.__table__.primary_key.columns[0]))).scalars())


async def test_le_mod_opm_deguise_est_refuse(app: FastAPI, client: AsyncClient) -> None:
    """Un cheat renommé « opm-9.jar » : le launcher n'en pose qu'un."""
    opened = await launcher_session(app, client, await create_player())
    body = (await attest(client, opened, [*GOOD, {"path": "mods/opm-9.jar", "sha1": "d" * 40}])).json()
    assert body["ok"] is False
    assert "mods/opm-9.jar" in body["extra"]


def test_le_mod_opm_deguise_est_vu_en_jeu() -> None:
    official = {"mods/jei-19.jar": "b" * 40}
    assert anticheat.evaluate_report([{"id": "opm", "file": "opm-1.0.0.jar"}], [], official) == []
    assert anticheat.evaluate_report([{"id": "wurst", "file": "opm-9.jar"}], [], official)
    assert anticheat.evaluate_report([{"id": "opm", "file": "wurst.jar"}], [], official)


def test_fichier_remplace_sous_le_meme_nom() -> None:
    official = {"mods/jei-19.jar": "b" * 40}
    swapped = {"id": "jei", "file": "jei-19.jar", "sha1": "9" * 40}
    assert anticheat.evaluate_report([swapped], [], official) == ["mod modifié : jei-19.jar (jei)"]
    # Le bon fichier, un ancien mod OPM sans empreinte : rien à dire.
    assert anticheat.evaluate_report([{**swapped, "sha1": "B" * 40}], [], official) == []
    assert anticheat.evaluate_report([{**swapped, "sha1": ""}], [], official) == []
    # L'ancienne version, officielle il y a moins de 24 h.
    assert anticheat.evaluate_report([swapped], [], official, {("jei-19.jar", "9" * 40)}) == []


async def test_modpack_change_pendant_la_partie(
    app: FastAPI, client: AsyncClient, modpack: Path
) -> None:
    """Un joueur en jeu garde ses mods : le modpack qui change ne l'accuse pas."""
    opened = await launcher_session(app, client, await create_player())
    jei = {"id": "jei", "file": "jei-19.jar", "sha1": "b" * 40}
    assert (await report(client, opened, mods=[jei]))["ok"] is True
    modpack.write_text(json.dumps([OFFICIAL[0], {"path": "mods/jei-20.jar", "hash": "c" * 40}]))
    anticheat.reset_cache()
    assert (await report(client, opened, mods=[jei]))["ok"] is True
    jei20 = {"id": "jei", "file": "jei-20.jar", "sha1": "c" * 40}
    assert (await report(client, opened, mods=[jei20]))["ok"] is True


async def test_modpack_relu_avant_d_accuser(
    app: FastAPI, client: AsyncClient, modpack: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Un mod tout juste ajouté au modpack, pas encore dans le cache."""
    monkeypatch.setattr(anticheat, "MANIFEST_FRESH", 0.0)
    opened = await launcher_session(app, client, await create_player())
    assert (await attest(client, opened, GOOD)).json()["ok"] is True
    modpack.write_text(json.dumps([*OFFICIAL, {"path": "mods/neuf.jar", "hash": "7" * 40}]))
    body = (await attest(client, opened, [*GOOD, {"path": "mods/neuf.jar", "sha1": "7" * 40}])).json()
    assert body["ok"] is True


async def test_les_repetitions_sont_regroupees(app: FastAPI, client: AsyncClient) -> None:
    player = await create_player()
    opened = await launcher_session(app, client, player)
    cheat = {"id": "wurst", "file": "wurst-7.jar"}
    for _ in range(3):
        assert (await report(client, opened, mods=[cheat]))["ok"] is False
    (alert,) = await rows(Alerte)
    assert (alert.niveau, alert.occurrences, alert.statut) == ("preuve", 3, "nouvelle")
    assert alert.user_id is not None and alert.vu_le is not None
    # Traitée par le staff : la suivante ouvre une nouvelle alerte.
    async with db.get_sessionmaker()() as session:
        (await session.get(Alerte, alert.id)).statut = "fausse"
        await session.commit()
    await report(client, opened, mods=[cheat])
    assert [a.statut for a in await rows(Alerte)] == ["fausse", "nouvelle"]


async def test_dernier_controle_et_traces(app: FastAPI, client: AsyncClient) -> None:
    opened = await launcher_session(app, client, await create_player())
    jei = {"id": "jei", "version": "19", "file": "jei-19.jar"}
    await report(client, opened, phase="join", mods=[jei], launcher="2.6.0")
    await report(client, opened, mods=[jei], launcher="2.6.0")
    (control,) = await rows(Controle)
    assert (control.ok, control.phase, control.mods, control.launcher) == (True, "periodic", 1, "2.6.0")
    assert "-" not in control.uuid
    # L'arrivée laisse une trace (avec la liste) ; le contrôle périodique conforme, non.
    (trace,) = await rows(GameReport)
    assert trace.kind == "join"
    assert json.loads(trace.details)["liste"] == [jei]
    await report(client, opened, phase="controle", mods=[jei])
    assert [r.kind for r in await rows(GameReport)] == ["join", "controle"]


async def test_mod_absent_et_empreinte_opm_inconnue_ne_refusent_pas(
    app: FastAPI, client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(get_settings(), "mod_sha1", f"{'1' * 40}, {'2' * 40}")
    opened = await launcher_session(app, client, await create_player())
    assert (await attest(client, opened, [GOOD[0], GOOD[2]])).json()["ok"] is True
    assert (await join(client, opened, "serveur-soupcon")).status_code == 204
    alerts = await rows(Alerte)
    assert {a.type for a in alerts} == {"absents", "mod OPM"}
    assert {a.niveau for a in alerts} == {"soupcon"}


async def test_premiere_arrivee_une_seule_fois(app: FastAPI, client: AsyncClient) -> None:
    opened = await launcher_session(app, client, await create_player())
    url, headers = f"{API_PREFIX}/game/arrivee", {"Authorization": f"Bearer {opened['accessToken']}"}
    assert (await client.get(url, headers=headers)).json() == {"vue": False}
    for _ in range(2):
        assert (await client.post(url, headers=headers)).status_code == 204
    assert (await client.get(url, headers=headers)).json() == {"vue": True}
    assert (await client.get(url)).status_code == 401


async def test_les_soupcons_du_skript_sont_regroupes(
    app: FastAPI, client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(get_settings(), "anticheat_webhook", "")
    player = await create_player()
    opened = await launcher_session(app, client, player)
    await report(client, opened, phase="join")
    (control,) = await rows(Controle)
    u = control.uuid
    dashed = f"{u[:8]}-{u[8:12]}-{u[12:16]}-{u[16:20]}-{u[20:]}"
    async with db.get_sessionmaker()() as session:
        for n in range(3):
            session.add(Alerte(joueur="Luffy", uuid=dashed, type="vol", detail=f"{n} s"))
        session.add(Alerte(joueur="Luffy", uuid=dashed, type="vitesse", detail="15 blocs/s"))
        await session.commit()
    assert await anticheat.relay_alerts() == 2
    flight, speed = await rows(Alerte)
    assert (flight.type, flight.occurrences, flight.detail) == ("vol", 3, "2 s")
    assert flight.niveau == "soupcon"
    assert flight.uuid == u and flight.user_id == control.user_id
    assert (speed.type, speed.occurrences) == ("vitesse", 1)
    # Une répétition plus tard : ajoutée à l'alerte déjà relayée, sans nouvelle notification.
    async with db.get_sessionmaker()() as session:
        session.add(Alerte(joueur="Luffy", uuid=dashed, type="vol", detail="9 s"))
        await session.commit()
    assert await anticheat.relay_alerts() == 0
    assert [a.occurrences for a in await rows(Alerte)] == [4, 1]


async def test_purge(app: FastAPI, client: AsyncClient) -> None:
    opened = await launcher_session(app, client, await create_player())
    await report(client, opened, phase="join")
    old = utcnow() - timedelta(days=40)
    async with db.get_sessionmaker()() as session:
        user_id = (await rows(Controle))[0].user_id
        session.add(GameReport(user_id=user_id, kind="join", ok=True, created_at=old))
        session.add(GameReport(user_id=user_id, kind="join", ok=False, created_at=old))
        session.add(Alerte(joueur="A", type="vol", cree_le=utcnow() - timedelta(days=400)))
        session.add(Alerte(joueur="B", type="vol", cree_le=old))
        await session.commit()
        await anticheat.purge(session)
    assert sorted(r.ok for r in await rows(GameReport)) == [False, True]
    assert [a.joueur for a in await rows(Alerte)] == ["B"]
