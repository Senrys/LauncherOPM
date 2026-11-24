"""Anti-triche : ce que déclarent le launcher et le jeu, et les alertes du serveur.

Trois sources, une seule règle : **rien n'est sanctionné automatiquement**. Un
écart est consigné (``game_report``, ``opm_alerte``, ``auth_audit``), relayé au
staff (``OPM_ANTICHEAT_WEBHOOK``), et la seule conséquence immédiate est un refus
d'entrer sur le serveur quand les fichiers du jeu ne sont pas ceux du modpack.

1. **L'empreinte du launcher** (``attest``) : au clic sur JOUER, une fois les
   fichiers vérifiés, le launcher déclare les mods (chemin, SHA-1) et les packs de
   ressources. Comparés au modpack officiel (``files.json``) : un mod en trop ou
   modifié → la session est marquée ``refused`` et ``join`` la refuse. Le mod
   OPM, que le launcher embarque lui-même, est attendu en plus (``opm-<version>.jar``,
   un seul).
2. **Le rapport du mod** (``report``) : en jeu, à l'arrivée, puis toutes les
   5 minutes, et à la demande du staff (``/controle``), le mod OPM liste les mods
   chargés (avec leur empreinte) et les packs actifs, et signale lui-même un pack
   « X-ray » (blocs courants rendus transparents).
3. **Les alertes du serveur** (``opm_alerte``) : le Skript ``anticheat.sk`` y écrit
   ses soupçons (vol, vitesse, portée, minerais, mod muet) ; ``relay_alerts``
   regroupe les répétitions et relaie.

Deux niveaux : une **preuve** (mod étranger, fichier modifié, pack X-ray) prévient le
staff *et* le joueur (Xenodys) ; un **soupçon** ne prévient que le staff.

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
from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from opm_auth.config import get_settings
from opm_auth.models import (
    Alerte,
    Arrivee,
    AuditAction,
    Controle,
    GameReport,
    McLink,
    ModpackFichier,
    User,
    YggSession,
    utcnow,
)
from opm_auth.services import audit

logger = logging.getLogger(__name__)

#: Le mod OPM embarqué par le launcher, accepté en plus du modpack.
OPM_MOD = re.compile(r"^mods/opm-\d[\w.+-]*\.jar$", re.IGNORECASE)
#: Durée de vie du modpack officiel en mémoire ; et âge au-delà duquel on le relit avant
#: de conclure à un écart (il vient peut-être de changer).
MANIFEST_TTL = 60.0
MANIFEST_FRESH = 10.0
#: Un mod retiré ou remplacé reste admis en jeu aussi longtemps qu'une session (24 h).
RECENT = timedelta(hours=24)
#: Le même motif, dans cette fenêtre, s'ajoute à l'alerte ouverte.
REGROUPEMENT = timedelta(hours=12)
PREUVE = "preuve"
SOUPCON = "soupcon"
#: Conservation : 12 mois pour une alerte ou un écart, 30 jours pour le reste.
GARDE_ALERTES = timedelta(days=365)
GARDE_CONTROLES = timedelta(days=30)
#: Mods intégrés au jeu, que le mod OPM liste sans fichier.
BUILTIN_MODS = frozenset({"minecraft", "neoforge"})
#: Sinytra Connector charge un mod Fabric depuis une copie convertie, rangée dans
#: ``mods/.connector/`` : ``continuity-3.0.0+1.21.neoforge.jar`` y devient
#: ``continuity-3.0.0+1.21.neoforge_mapped_moj_1.21.1.jar``. Le mod OPM rapporte le
#: nom de cette copie ; on le ramène à celui du fichier d'origine avant comparaison.
CONNECTOR_COPY = re.compile(r"_mapped_[a-z]+_[\w.+-]+\.jar$")

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


async def official_mods(*, max_age: float = MANIFEST_TTL) -> dict[str, str] | None:
    """Les mods du modpack officiel, ou ``None`` s'il est illisible."""
    global _manifest
    async with _manifest_lock:
        if _manifest and time.monotonic() - _manifest[0] < max_age:
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
    global _manifest, _remembered
    _manifest = None
    _remembered = None


_remembered: tuple[float, dict[str, str]] | None = None
_remember_lock = asyncio.Lock()


async def _remember(db: AsyncSession, official: dict[str, str] | None) -> None:
    """Inscrit le modpack courant dans ``opm_modpack`` (au changement, sinon chaque heure)."""
    global _remembered
    if not official:
        return
    async with _remember_lock:
        if (
            _remembered
            and _remembered[1] == official
            and time.monotonic() - _remembered[0] < 3600
        ):
            return
        now = utcnow()
        for path, sha1 in official.items():
            row = await db.get(ModpackFichier, (path.removeprefix("mods/"), sha1))
            if row is None:
                db.add(ModpackFichier(fichier=path.removeprefix("mods/"), sha1=sha1, vu_le=now))
            else:
                row.vu_le = now
        await db.commit()
        _remembered = (time.monotonic(), dict(official))


async def _recent_files(db: AsyncSession) -> set[tuple[str, str]]:
    """``(fichier, sha1)`` de tout ce qui était officiel ces dernières 24 heures."""
    rows = await db.execute(
        select(ModpackFichier.fichier, ModpackFichier.sha1).where(
            ModpackFichier.vu_le > utcnow() - RECENT
        )
    )
    return {(f, h) for f, h in rows.all()}


def compare(declared: list[dict[str, Any]], official: dict[str, str]) -> dict[str, list[str]]:
    """Mods en trop, modifiés ou absents, par rapport au modpack officiel."""
    extra: list[str] = []
    modified: list[str] = []
    opm: list[str] = []
    seen: set[str] = set()
    for item in declared:
        path = str(item.get("path") or "").replace("\\", "/").lstrip("/")
        sha1 = str(item.get("sha1") or "").lower()
        if not path.startswith("mods/") or not path.endswith(".jar"):
            continue
        seen.add(path)
        if path not in official and OPM_MOD.match(path):
            opm.append(path)
        elif path not in official:
            extra.append(path)
        elif official[path] and sha1 and official[path] != sha1:
            modified.append(path)
    # Le launcher ne pose qu'un mod OPM : un second « opm-… .jar » est un intrus déguisé.
    if len(opm) > 1:
        extra.extend(opm)
    return {
        "extra": sorted(extra)[:50],
        "modified": sorted(modified)[:50],
        "missing": sorted(set(official) - seen)[:50],
    }


def _accepted_opm() -> frozenset[str]:
    return frozenset(
        h.strip().lower() for h in (get_settings().mod_sha1 or "").split(",") if h.strip()
    )


def _unknown_opm(entries: list[tuple[str, str]]) -> list[str]:
    """Mods OPM ``(fichier, sha1)`` dont l'empreinte n'est pas connue (si elles le sont)."""
    known = _accepted_opm()
    return [f for f, h in entries if known and h and h.lower() not in known]


async def _alert(
    db: AsyncSession, user: User, kind: str, detail: str, *, niveau: str = PREUVE
) -> None:
    """Une alerte en base (relayée ensuite au staff).

    Le même motif déjà ouvert dans les :data:`REGROUPEMENT` dernières heures : une
    occurrence de plus, sans nouvelle notification — sauf si le détail a changé.
    """
    link = getattr(user, "mc_link", None)
    name = _player_name(user)
    detail = detail[:280]
    now = utcnow()
    logger.warning("Anti-triche : %s — %s, %s (%s).", name, niveau, kind, detail)
    row = await _open_alert(db, kind, since=now - REGROUPEMENT, user_id=user.id, source="launcher")
    if row is not None:
        row.occurrences += 1
        row.vu_le = now
        if row.detail != detail:
            row.detail = detail
            row.relayee = False
        return
    db.add(
        Alerte(
            user_id=user.id,
            joueur=name[:32],
            uuid=getattr(link, "minecraft_uuid", None),
            type=kind[:24],
            niveau=niveau,
            detail=detail,
            source="launcher",
        )
    )


async def _open_alert(
    db: AsyncSession, kind: str, *, since: Any, source: str, **criteria: Any
) -> Alerte | None:
    """La dernière alerte du même motif, pas encore traitée et assez récente."""
    query = (
        select(Alerte)
        .where(
            Alerte.type == kind,
            Alerte.source == source,
            Alerte.statut == "nouvelle",
            func.coalesce(Alerte.vu_le, Alerte.cree_le) > since,
        )
        .order_by(Alerte.id.desc())
        .limit(1)
    )
    before = criteria.pop("before", None)
    if before is not None:
        query = query.where(Alerte.id < before)
    return (await db.execute(query.filter_by(**criteria))).scalars().first()


def _player_name(user: User) -> str:
    link = getattr(user, "mc_link", None)
    return getattr(link, "minecraft_username", None) or user.name or f"compte {user.id}"


async def attest(
    db: AsyncSession, user: User, *, client_token: str, mods: list[dict[str, Any]], packs: list[str]
) -> dict[str, Any]:
    """L'empreinte du launcher : marque la session ``ok``, ``refused`` ou ``unverified``."""
    official = await official_mods()
    if official is None:
        verdict, diff = "unverified", {"extra": [], "modified": [], "missing": []}
    else:
        diff = compare(mods, official)
        if any(diff.values()):
            # Le modpack vient peut-être de changer : on le relit avant de conclure.
            official = await official_mods(max_age=MANIFEST_FRESH) or official
            diff = compare(mods, official)
        verdict = "refused" if diff["extra"] or diff["modified"] else "ok"
        await _remember(db, official)

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
    strange = _unknown_opm(
        [
            (str(m.get("path") or ""), str(m.get("sha1") or ""))
            for m in mods
            if OPM_MOD.match(str(m.get("path") or ""))
        ]
    )
    if strange:
        await _alert(db, user, "mod OPM", f"empreinte inconnue : {strange[0]}", niveau=SOUPCON)
    if diff["missing"]:
        names = ", ".join(p.removeprefix("mods/") for p in diff["missing"][:5])
        detail = f"{len(diff['missing'])} mod(s) absent(s) : {names}"
        await _alert(db, user, "absents", detail, niveau=SOUPCON)
    if verdict == "refused":
        parts = [f"{len(diff['extra'])} mod(s) en trop"] if diff["extra"] else []
        if diff["modified"]:
            parts.append(f"{len(diff['modified'])} mod(s) modifié(s)")
        await _alert(
            db,
            user,
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
    mods: list[dict[str, Any]],
    packs: list[dict[str, Any]],
    official: dict[str, str] | None,
    recent: set[tuple[str, str]] | frozenset[tuple[str, str]] = frozenset(),
) -> list[str]:
    """Ce qui est prouvé par un rapport du mod : liste de motifs (vide : rien).

    :param recent: ``(fichier, sha1)`` qui étaient officiels dans les dernières 24 h.
    """
    reasons: list[str] = []
    for m in mods:
        mod_id = str(m.get("id") or "")
        file = str(m.get("file") or "")
        sha1 = str(m.get("sha1") or "").lower()
        if not file or mod_id in BUILTIN_MODS:
            continue
        if OPM_MOD.match(f"mods/{file}") and mod_id == "opm":
            continue
        converted = CONNECTOR_COPY.search(file) is not None
        file = CONNECTOR_COPY.sub(".jar", file)
        if official is None:
            continue
        # Les empreintes admises pour ce fichier : celle du modpack, et les récentes.
        known = {h for f, h in recent if f == file}
        if f"mods/{file}" in official:
            known.add(official[f"mods/{file}"])
        if not known:
            reasons.append(f"mod inconnu : {file} ({mod_id})")
        elif sha1 and not converted and "" not in known and sha1 not in known:
            reasons.append(f"mod modifié : {file} ({mod_id})")
    for p in packs:
        if p.get("xray"):
            reasons.append(f"pack X-ray : {str(p.get('title') or p.get('id'))[:60]}")
    return list(dict.fromkeys(reasons))[:20]


def _message(reasons: list[str]) -> str | None:
    """Ce que Xenodys dit au joueur."""
    if not reasons:
        return None
    pack = next((r for r in reasons if r.startswith("pack X-ray : ")), None)
    if pack:
        return f"Je te vois… « {pack.removeprefix('pack X-ray : ')} » ne te cachera rien."
    return "Je te vois… Ce que tu as ajouté au jeu ne passe pas inaperçu."


async def report(
    db: AsyncSession,
    user: User,
    *,
    phase: str,
    mods: list[dict[str, Any]],
    packs: list[dict[str, Any]],
    launcher: str = "",
) -> dict[str, Any]:
    """Le rapport du mod OPM en jeu."""
    official = await official_mods()
    await _remember(db, official)
    recent = await _recent_files(db)
    reasons = evaluate_report(mods, packs, official, recent)
    if reasons and official is not None:
        # Le modpack vient peut-être de changer : on le relit avant d'accuser.
        official = await official_mods(max_age=MANIFEST_FRESH) or official
        await _remember(db, official)
        reasons = evaluate_report(mods, packs, official, recent)
    ok = not reasons
    link = getattr(user, "mc_link", None)

    row = await db.get(Controle, user.id)
    if row is None:
        row = Controle(user_id=user.id)
        db.add(row)
    row.joueur = _player_name(user)[:32]
    row.uuid = getattr(link, "minecraft_uuid", None)
    row.phase = phase[:12]
    row.ok = ok
    row.motifs = "; ".join(reasons)[:500] or None
    row.mods = len(mods)
    row.packs = len(packs)
    row.launcher = launcher[:24] or None
    row.le = utcnow()

    # Un contrôle périodique sans écart ne laisse pas de trace de plus.
    if not ok or phase != "periodic":
        details = {
            "phase": phase,
            "reasons": reasons,
            "mods": len(mods),
            "liste": [
                {"id": str(m.get("id") or ""), "version": str(m.get("version") or ""),
                 "file": str(m.get("file") or "")}
                for m in mods
            ],
            "packs": [str(p.get("id"))[:60] for p in packs][:30],
            "launcher": launcher,
        }
        db.add(GameReport(user_id=user.id, kind=phase[:12], ok=ok, details=json.dumps(details)))
        await audit.record(
            db,
            AuditAction.GAME_REPORT,
            user_id=user.id,
            success=ok,
            meta={"phase": phase, "reasons": len(reasons)},
        )
    strange = _unknown_opm(
        [
            (str(m.get("file") or ""), str(m.get("sha1") or ""))
            for m in mods
            if str(m.get("id") or "") == "opm"
        ]
    )
    if strange:
        await _alert(db, user, "mod OPM", f"empreinte inconnue : {strange[0]}", niveau=SOUPCON)
    if not ok:
        await _alert(db, user, "client", "; ".join(reasons))
    await db.commit()
    return {"ok": ok, "reasons": reasons, "message": _message(reasons)}


async def arrivee_vue(db: AsyncSession, user: User) -> bool:
    """Ce compte a-t-il déjà vu la scène de première arrivée ?"""
    return await db.get(Arrivee, user.id) is not None


async def marquer_arrivee(db: AsyncSession, user: User) -> None:
    """La scène a été jouée : elle ne le sera plus, quel que soit le PC."""
    if await arrivee_vue(db, user):
        return
    db.add(Arrivee(user_id=user.id))
    await db.commit()


async def _regrouper(db: AsyncSession) -> None:
    """Range les soupçons bruts du Skript : compte retrouvé, répétitions fusionnées."""
    rows = (
        (
            await db.execute(
                select(Alerte)
                .where(Alerte.source == "serveur", Alerte.relayee.is_(False))
                .order_by(Alerte.id)
                .limit(200)
            )
        )
        .scalars()
        .all()
    )
    for row in rows:
        row.uuid = (row.uuid or "").replace("-", "").lower() or None
        if row.user_id is None and row.uuid:
            row.user_id = await db.scalar(
                select(McLink.user_id).where(McLink.minecraft_uuid == row.uuid)
            )
        await db.flush()
        earlier = await _open_alert(
            db,
            row.type,
            since=row.cree_le - REGROUPEMENT,
            source="serveur",
            before=row.id,
            joueur=row.joueur,
            uuid=row.uuid,
        )
        if earlier is None:
            continue
        earlier.occurrences += row.occurrences
        earlier.vu_le = row.vu_le or row.cree_le
        earlier.detail = row.detail
        await db.delete(row)
        await db.flush()
    await db.commit()


async def purge(db: AsyncSession) -> None:
    """Efface ce qui a dépassé sa durée de conservation."""
    now = utcnow()
    await db.execute(
        delete(GameReport).where(
            GameReport.ok.is_(True), GameReport.created_at < now - GARDE_CONTROLES
        )
    )
    await db.execute(delete(GameReport).where(GameReport.created_at < now - GARDE_ALERTES))
    await db.execute(
        delete(Alerte).where(func.coalesce(Alerte.vu_le, Alerte.cree_le) < now - GARDE_ALERTES)
    )
    await db.execute(delete(ModpackFichier).where(ModpackFichier.vu_le < now - GARDE_CONTROLES))
    await db.commit()


async def relay_alerts(*, settings: Any = None) -> int:
    """Tâche de fond : relaie au staff les alertes pas encore relayées."""
    from opm_auth import db as database

    settings = settings or get_settings()
    hook = (settings.anticheat_webhook or "").strip()
    factory = database.get_sessionmaker()
    async with factory() as db:
        await _regrouper(db)
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
            lines = [
                f"{'🔴 Preuve' if r.niveau == PREUVE else '⚠️ Soupçon'} — **{r.joueur}** — "
                f"{r.type} ({r.source}) : {r.detail or '—'}"
                for r in rows
            ]
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
    "arrivee_vue",
    "attest",
    "compare",
    "evaluate_report",
    "marquer_arrivee",
    "official_mods",
    "purge",
    "relay_alerts",
    "report",
    "reset_cache",
    "utcnow",
]
