#!/usr/bin/env python3
"""Génère le « files.json » d'une instance à partir d'un dossier de modpack.

Le launcher (minecraft-java-core) télécharge ce manifeste, puis compare chaque
entrée au disque du joueur : taille d'abord, SHA-1 ensuite. Ce qui diffère est
retéléchargé, ce qui n'y figure pas est SUPPRIMÉ — sauf les chemins déclarés
dans « ignored » côté instance.

Usage :

    python3 scripts/build-files-json.py DOSSIER URL_DE_BASE [-o SORTIE]

Exemple :

    python3 scripts/build-files-json.py ./modpack \\
        https://onepieceminecraft.fr/launcher \\
        -o ./modpack/files.json

Le dossier passé en argument est la RACINE DE L'INSTANCE : il contient
« mods/ », « config/ », « kubejs/ »… tels que le joueur les aura.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from urllib.parse import quote

#: Jamais listés : ce sont des fichiers de travail, pas du contenu à distribuer.
#: Le manifeste lui-même en fait partie — s'y référencer serait circulaire.
EXCLUS = {
    "files.json",
    ".files-json-cache",
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
}

#: Dossiers jamais parcourus : ils appartiennent au joueur ou au launcher.
DOSSIERS_EXCLUS = {
    ".git",
    "logs",
    "crash-reports",
    "saves",
    "screenshots",
    "backups",
    ".mixin.out",
    "loader",
    "runtime",
}


#: Empreintes déjà calculées, indexées par chemin relatif :
#: ``{"mods/x.jar": [taille, mtime_ns, sha1]}``. Un fichier dont la taille ET
#: la date de modification n'ont pas bougé garde son empreinte : régénérer
#: après l'ajout d'un seul mod ne relit que ce mod-là, pas les 500 Mio.
NOM_CACHE = ".files-json-cache"


def charger_cache(racine: Path) -> dict[str, list]:
    """Lit le cache d'empreintes. Un cache illisible est simplement ignoré."""
    fichier = racine / NOM_CACHE
    try:
        donnees = json.loads(fichier.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return donnees if isinstance(donnees, dict) else {}


def ecrire_cache(racine: Path, cache: dict[str, list]) -> None:
    """Écrit le cache. Son échec n'est pas fatal : on perd juste l'accélération."""
    try:
        (racine / NOM_CACHE).write_text(json.dumps(cache), encoding="utf-8")
    except OSError:
        pass


def sha1(chemin: Path) -> str:
    """Empreinte SHA-1 d'un fichier, lue par blocs (les .jar sont gros)."""
    digest = hashlib.sha1()
    with chemin.open("rb") as flux:
        for bloc in iter(lambda: flux.read(1024 * 1024), b""):
            digest.update(bloc)
    return digest.hexdigest()


def construire(racine: Path, base_url: str) -> list[dict[str, object]]:
    """Parcourt « racine » et rend la liste d'entrées du manifeste."""
    base_url = base_url.rstrip("/")
    entrees: list[dict[str, object]] = []
    ancien = charger_cache(racine)
    nouveau: dict[str, list] = {}
    recalcules = 0

    for chemin in sorted(racine.rglob("*")):
        if not chemin.is_file():
            continue
        relatif = chemin.relative_to(racine)
        if relatif.name in EXCLUS:
            continue
        if DOSSIERS_EXCLUS & set(relatif.parts[:-1]):
            continue

        # Toujours des « / » : le launcher compare des chaînes, y compris
        # depuis un Windows où Path rendrait des antislashs.
        chemin_relatif = relatif.as_posix()
        # quote() encode les espaces et les accents ; « / » reste un séparateur.
        url = f"{base_url}/{quote(chemin_relatif)}"

        infos = chemin.stat()
        connu = ancien.get(chemin_relatif)
        if connu and connu[0] == infos.st_size and connu[1] == infos.st_mtime_ns:
            empreinte = str(connu[2])
        else:
            empreinte = sha1(chemin)
            recalcules += 1
        nouveau[chemin_relatif] = [infos.st_size, infos.st_mtime_ns, empreinte]

        entrees.append(
            {
                "path": chemin_relatif,
                "hash": empreinte,
                "size": infos.st_size,
                "url": url,
            }
        )

    ecrire_cache(racine, nouveau)
    construire.recalcules = recalcules  # type: ignore[attr-defined]
    return entrees


def main() -> int:
    analyseur = argparse.ArgumentParser(
        description="Génère le files.json d'une instance OPM.",
        epilog="Le dossier est la racine de l'instance (il contient mods/, config/…).",
    )
    analyseur.add_argument("dossier", type=Path, help="racine de l'instance")
    analyseur.add_argument("base_url", help="URL publique de ce dossier")
    analyseur.add_argument(
        "-o",
        "--sortie",
        type=Path,
        default=None,
        help="fichier de sortie (défaut : <dossier>/files.json)",
    )
    args = analyseur.parse_args()

    if not args.dossier.is_dir():
        print(f"ÉCHEC  Dossier introuvable : {args.dossier}", file=sys.stderr)
        return 1

    entrees = construire(args.dossier, args.base_url)
    if not entrees:
        print(f"ÉCHEC  Aucun fichier trouvé dans {args.dossier}", file=sys.stderr)
        return 1

    sortie = args.sortie or (args.dossier / "files.json")
    sortie.write_text(
        json.dumps(entrees, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    total = sum(int(e["size"]) for e in entrees)
    recalcules = getattr(construire, "recalcules", len(entrees))
    print(
        f"OK    {len(entrees)} fichiers, {total / 1024 / 1024:.1f} Mio → {sortie}"
        f"  ({recalcules} empreinte(s) recalculée(s))"
    )

    # Un aperçu par dossier de tête : c'est là qu'une erreur de racine se voit.
    par_dossier: dict[str, int] = {}
    for entree in entrees:
        tete = str(entree["path"]).split("/")[0]
        par_dossier[tete] = par_dossier.get(tete, 0) + 1
    for nom, nombre in sorted(par_dossier.items(), key=lambda x: -x[1]):
        print(f"      {nombre:5d}  {nom}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
