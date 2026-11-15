"""Anti-triche : ce que déclarent le launcher et le jeu, et les alertes du serveur.

Trois sources, une seule règle : **rien n'est sanctionné automatiquement**. Un
écart est consigné (``game_report``, ``opm_alerte``, ``auth_audit``), relayé au
staff (``OPM_ANTICHEAT_WEBHOOK``), et la seule conséquence immédiate est un refus
d'entrer sur le serveur quand les fichiers du jeu ne sont pas ceux du modpack.

1. **L'empreinte du launcher** (``attest``) : au clic sur JOUER, une fois les
   fichiers vérifiés, le launcher déclare les mods (chemin, SHA-1) et les packs de
   ressources. Comparés au modpack officiel (``files.json``) : un mod en trop ou
   modifié → la session est marquée ``refused`` et ``join`` la refuse. Le mod
   OPM, que le launcher embarque lui-même, est attendu en plus (``opm-<version>.jar``).
2. **Le rapport du mod** (``report``) : en jeu, à l'arrivée puis toutes les
   5 minutes, le mod OPM liste les mods chargés et les packs actifs, et signale
   lui-même un pack « X-ray » (blocs courants rendus transparents).
3. **Les alertes du serveur** (``opm_alerte``) : le Skript ``anticheat.sk`` y écrit
   ses soupçons (vol, vitesse, portée, minerais) ; ``relay_alerts`` les relaie.

Limites, à connaître : tout ce qui vient du PC du joueur peut être imité par
quelqu'un de déterminé (le dépôt est public). C'est une barrière pour les cas
courants, pas une preuve. Les vérifications du serveur Minecraft restent la
défense sérieuse.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from opm_auth.config import get_settings
from opm_auth.models import Alerte, AuditAction, GameReport, User, YggSession, utcnow
from opm_auth.services import audit

logger = logging.getLogger(__name__)

#: Le mod OPM embarqué par le launcher, accepté en plus du modpack.
OPM_MOD = re.compile(r"^mods/opm-\d[\w.+-]*\.jar$")
#: Durée de vie du modpack officiel en mémoire.
MANIFEST_TTL = 300.0
#: Mods intégrés au jeu, que le mod OPM liste sans fichier.
BUILTIN_MODS = frozenset({"minecraft", "neoforge", "opm"})

_manifest: tuple[float, dict[str, str]] | None = None
_manifest_lock = asyncio.Lock()


def _manifest_source() -> str:
    settings = get_settings()
    return (
        settings.modpack_manifest or ""
    ).strip() or f"{settings.public_url.rstrip('/')}/launcher/files.json"


def _mods_of(entries: Any) -> dict[str, str]:
    """``{chemin: sha1}`` des mods (``mods/*.jar``) d'un ``files.json``."""
    out: dict[str, str] = {}
    if isinstance(entries, dict):
        entries = entries.get("files") or entries.get("items") or []
    for e in entries if isinstance(entries, list) else []:
        if not isinstance(e, dict):
            continue
        path = str(e.get("path") or "").replace("\\", "/").lstrip("/")
        if path.startswith("mods/") and path.endswith(".jar"):
            out[path] = str(e.get("hash") or e.get("sha1") or "").lower()
    return out


async def official_mods() -> dict[str, str] | None:
    """Les mods du modpack officiel, ou ``None`` s'il est illisible."""
    global _manifest
    async with _manifest_lock:
        if _manifest and time.monotonic() - _manifest[0] < MANIFEST_TTL:
            return _manifest[1]
        source = _manifest_source()
        try:
            if source.startswith(("http://", "https://")):
                async with httpx.AsyncClient(timeout=8) as client:
                    response = await client.get(source)
                    response.raise_for_status()
                    data = response.json()
            else:
                data = json.loads(await asyncio.to_thread(Path(source).read_text, "utf-8"))
        except Exception as exc:
            logger.warning("Modpack officiel illisible (%s) : %s", source, exc)
            return _manifest[1] if _manifest else None
        mods = _mods_of(data)
        _manifest = (time.monotonic(), mods)
        return mods


def reset_cache() -> None:
    """Tests : oublier le modpack mis en cache."""
    global _manifest
    _manifest = None


def compare(declared: list[dict[str, Any]], official: dict[str, str]) -> dict[str, list[str]]:
    """Mods en trop et mods modifiés, par rapport au modpack officiel."""
    extra: list[str] = []
    modified: list[str] = []
    for item in declared:
        path = str(item.get("path") or "").replace("\\", "/").lstrip("/")
        sha1 = str(item.get("sha1") or "").lower()
        if not path.startswith("mods/") or not path.endswith(".jar") or OPM_MOD.match(path):
            continue
        if path not in official:
            extra.append(path)
        elif official[path] and sha1 and official[path] != sha1:
            modified.append(path)
    return {"extra": sorted(extra)[:50], "modified": sorted(modified)[:50]}


async def _alert(db: AsyncSession, user: User | None, name: str, kind: str, detail: str) -> None:
    """Une alerte en base (relayée ensuite au staff)."""
    link = getattr(user, "mc_link", None) if user else None
    db.add(
        Alerte(
            joueur=name[:32],
            uuid=getattr(link, "minecraft_uuid", None),
            type=kind[:24],
            detail=detail[:280],
            source="launcher",
        )
    )
    logger.warning("Anti-triche : %s — %s (%s).", name, kind, detail)


def _player_name(user: User) -> str:
    link = getattr(user, "mc_link", None)
    return getattr(link, "minecraft_username", None) or user.name or f"compte {user.id}"


async def attest(
    db: AsyncSession, user: User, *, client_token: str, mods: list[dict[str, Any]], packs: list[str]
) -> dict[str, Any]:
    """L'empreinte du launcher : marque la session ``ok``, ``refused`` ou ``unverified``."""
    official = await official_mods()
    if official is None:
        verdict, diff = "unverified", {"extra": [], "modified": []}
    else:
        diff = compare(mods, official)
        verdict = "refused" if diff["extra"] or diff["modified"] else "ok"

    await db.execute(
        update(YggSession)
        .where(
            YggSession.user_id == user.id,
            YggSession.client_token == client_token,
            YggSession.invalidated_at.is_(None),
        )
        .values(attestation=verdict)
    )
    details = {"verdict": verdict, **diff, "mods": len(mods), "packs": packs[:30]}
    db.add(
        GameReport(
            user_id=user.id, kind="launch", ok=verdict != "refused", details=json.dumps(details)
        )
    )
    await audit.record(
        db,
        AuditAction.GAME_ATTEST,
        user_id=user.id,
        success=verdict != "refused",
        meta={"verdict": verdict, "extra": len(diff["extra"]), "modified": len(diff["modified"])},
    )
    if verdict == "refused":
        parts = [f"{len(diff['extra'])} mod(s) en trop"] if diff["extra"] else []
        if diff["modified"]:
            parts.append(f"{len(diff['modified'])} mod(s) modifié(s)")
        await _alert(
            db,
            user,
            _player_name(user),
            "fichiers",
            ", ".join(parts)
            + " : "
            + ", ".join([p.removeprefix("mods/") for p in (diff["extra"] + diff["modified"])[:5]]),
        )
    await db.commit()
    message = None
    if verdict == "refused":
        message = (
            "Vos fichiers de jeu ne correspondent pas au modpack One Piece Minecraft "
            "(mods ajoutés ou modifiés). Lancez « Vérifier les fichiers » dans les "
            "paramètres du launcher."
        )
    return {"ok": verdict != "refused", "verdict": verdict, **diff, "message": message}


def evaluate_report(
    mods: list[dict[str, Any]], packs: list[dict[str, Any]], official: dict[str, str] | None
) -> list[str]:
    """Ce qui cloche dans un rapport du mod : liste de motifs (vide : rien)."""
    reasons: list[str] = []
    names = {p.removeprefix("mods/") for p in official} if official is not None else None
    for m in mods:
        mod_id = str(m.get("id") or "")
        file = str(m.get("file") or "")
        if mod_id in BUILTIN_MODS or not file or re.match(r"^opm-\d", file):
            continue
        if names is not None and file not in names:
            reasons.append(f"mod inconnu : {file} ({mod_id})")
    for p in packs:
        if p.get("xray"):
            reasons.append(f"pack X-ray : {str(p.get('title') or p.get('id'))[:60]}")
    return reasons[:20]


async def report(
    db: AsyncSession,
    user: User,
    *,
    phase: str,
    mods: list[dict[str, Any]],
    packs: list[dict[str, Any]],
) -> dict[str, Any]:
    """Le rapport du mod OPM en jeu."""
    reasons = evaluate_report(mods, packs, await official_mods())
    ok = not reasons
    details = {
        "phase": phase,
        "reasons": reasons,
        "mods": len(mods),
        "packs": [str(p.get("id"))[:60] for p in packs][:30],
    }
    db.add(GameReport(user_id=user.id, kind=phase[:12], ok=ok, details=json.dumps(details)))
    await audit.record(
        db,
        AuditAction.GAME_REPORT,
        user_id=user.id,
        success=ok,
        meta={"phase": phase, "reasons": len(reasons)},
    )
    if not ok:
        await _alert(db, user, _player_name(user), "client", "; ".join(reasons))
    await db.commit()
    return {
        "ok": ok,
        "reasons": reasons,
        "message": None if ok else "Je te vois… Ce que tu as ajouté au jeu ne passe pas inaperçu.",
    }


async def relay_alerts(*, settings: Any = None) -> int:
    """Tâche de fond : relaie au staff les alertes pas encore relayées."""
    from opm_auth import db as database

    settings = settings or get_settings()
    hook = (settings.anticheat_webhook or "").strip()
    factory = database.get_sessionmaker()
    async with factory() as db:
        rows = (
            (
                await db.execute(
                    select(Alerte).where(Alerte.relayee.is_(False)).order_by(Alerte.id).limit(20)
                )
            )
            .scalars()
            .all()
        )
        if not rows:
            return 0
        if hook:
            lines = [f"⚠️ **{r.joueur}** — {r.type} ({r.source}) : {r.detail or '—'}" for r in rows]
            try:
                async with httpx.AsyncClient(timeout=6) as client:
                    response = await client.post(hook, json={"content": "\n".join(lines)[:1900]})
                    response.raise_for_status()
            except Exception as exc:
                logger.warning("Webhook anti-triche injoignable : %s", exc)
                return 0
        await db.execute(
            update(Alerte).where(Alerte.id.in_([r.id for r in rows])).values(relayee=True)
        )
        await db.commit()
        return len(rows)


__all__ = [
    "attest",
    "compare",
    "evaluate_report",
    "official_mods",
    "relay_alerts",
    "report",
    "reset_cache",
    "utcnow",
]
