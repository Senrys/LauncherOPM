"""Xenodys : l'état du monde, lu par le launcher (``/api/v1/xenodys``, ``/bootstrap``).

Ce qu'on vérifie :

- l'état par défaut est « créatrice », même sans ligne en base ;
- une bascule écrite en base (ce que fait la commande ``/xenodys`` du jeu) est
  servie au launcher, annonce du staff comprise ;
- ``/bootstrap`` transporte l'état, pour que le launcher démarre directement
  dans le bon thème ;
- une table absente ne casse rien : on reste « créatrice ».
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from opm_auth.models import Xenodys
from opm_auth.routers import launcher as launcher_routes
from opm_auth.security.deps import ApiError, api_error_handler

API_PREFIX = "/api/v1"


@pytest.fixture(autouse=True)
def fresh_cache() -> None:
    """Le cache de contenu est global au module : chaque test repart à vide."""
    launcher_routes._cache.clear()


@pytest.fixture
async def launcher_client() -> AsyncIterator[AsyncClient]:
    application = FastAPI(title="OPM Auth — launcher (tests)")
    application.add_exception_handler(ApiError, api_error_handler)
    application.include_router(launcher_routes.router, prefix=API_PREFIX)
    async with AsyncClient(
        transport=ASGITransport(app=application), base_url="http://test"
    ) as client:
        yield client


async def test_par_defaut_xenodys_est_la_creatrice(launcher_client: AsyncClient) -> None:
    response = await launcher_client.get(f"{API_PREFIX}/xenodys")
    assert response.status_code == 200
    assert response.json()["etat"] == "creatrice"
    assert response.json()["message"] is None


async def test_une_bascule_en_base_est_servie_au_launcher(
    launcher_client: AsyncClient, sessions
) -> None:
    async with sessions() as session:
        session.add(
            Xenodys(id=1, etat="corrompue", message="L'ennemi a pris le contrôle de Xenodys.", par="Senrys")
        )
        await session.commit()

    response = await launcher_client.get(f"{API_PREFIX}/xenodys")
    body = response.json()
    assert body["etat"] == "corrompue"
    assert body["message"] == "L'ennemi a pris le contrôle de Xenodys."
    assert body["depuis"] is not None
    # « par » est une trace pour le staff, pas une information publique.
    assert "par" not in body


async def test_le_bootstrap_transporte_l_etat(launcher_client: AsyncClient, sessions) -> None:
    async with sessions() as session:
        session.add(Xenodys(id=1, etat="corrompue"))
        await session.commit()

    response = await launcher_client.get(f"{API_PREFIX}/bootstrap")
    assert response.status_code == 200
    assert response.json()["xenodys"]["etat"] == "corrompue"


async def test_un_message_vide_n_est_pas_une_annonce(
    launcher_client: AsyncClient, sessions
) -> None:
    async with sessions() as session:
        session.add(Xenodys(id=1, etat="creatrice", message="   "))
        await session.commit()

    response = await launcher_client.get(f"{API_PREFIX}/xenodys")
    assert response.json()["message"] is None


async def test_sans_table_on_reste_creatrice(launcher_client: AsyncClient, sessions) -> None:
    async with sessions() as session:
        await session.execute(text("DROP TABLE launcher_xenodys"))
        await session.commit()

    response = await launcher_client.get(f"{API_PREFIX}/xenodys")
    assert response.status_code == 200
    assert response.json()["etat"] == "creatrice"

    # Et le démarrage du launcher n'en souffre pas non plus.
    launcher_routes._cache.clear()
    response = await launcher_client.get(f"{API_PREFIX}/bootstrap")
    assert response.status_code == 200
    assert response.json()["xenodys"]["etat"] == "creatrice"
