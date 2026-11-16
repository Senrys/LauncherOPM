# ruff: noqa: F811 — les fixtures de test_yggdrasil, importées, sont redéfinies en paramètres
"""Anti-triche : empreinte du launcher, rapport du mod, refus au join, alertes."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from opm_auth import db
from opm_auth.config import get_settings
from opm_auth.models import Alerte, GameReport
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
