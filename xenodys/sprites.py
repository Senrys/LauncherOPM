#!/usr/bin/env python3
"""Les ressources partagées par le launcher et le mod OPM du jeu.

    python3 xenodys/sprites.py

* **les modèles 3D de la scène de chargement** (socle, joueur, bloc du monde) et
  leurs textures — Xenodys et ses assistants viennent de ``generer.py`` ; les deux
  côtés les dessinent en vraie 3D, à la résolution de l'écran ;
* **la police pixel** et **le bandeau** (``police.png``, ``bandeau_*.png``), et
  ``sprites.json`` qui les décrit (module ``data/sprites.js`` côté launcher) ;
* **les textures des menus** du jeu, hors partie (``menus``).
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

ICI = Path(__file__).resolve().parent
RACINE = ICI.parent
GECKO = ICI / "geckolib"
SORTIES = [
    # Hors de « textures/gui/sprites » : Minecraft assemble ce dossier dans l'atlas
    # de son interface, et ces planches n'ont rien à y faire (le mod les lit seul).
    RACINE / "mod" / "src" / "main" / "resources" / "assets" / "opm" / "scene",
    RACINE / "launcher" / "src" / "assets" / "sprites",
]
ETATS = ("creatrice", "corrompue")


# --------------------------------------------------------------------------- #
# Les modèles 3D de la scène de chargement
# --------------------------------------------------------------------------- #


def texture_socle(etat: str) -> np.ndarray:
    """La carte : fond sombre, pistes, pastilles, une puce ; les tranches plus sombres."""
    pal = {
        "creatrice": dict(fond=(22, 70, 63), piste=(52, 150, 135), pastille=(233, 255, 252), bord=(8, 26, 24),
                          puce=(20, 24, 26), cristal=(145, 217, 209)),
        "corrompue": dict(fond=(62, 20, 56), piste=(150, 44, 132), pastille=(255, 211, 221), bord=(22, 6, 20),
                          puce=(24, 18, 24), cristal=(240, 80, 110)),
    }[etat]
    import random

    rnd = random.Random(30)
    im = Image.new("RGBA", (128, 64), (0, 0, 0, 0))
    px = im.load()
    for y in range(64):
        for x in range(128):
            px[x, y] = (*pal["bord"], 255)
    # Dessus de la dalle haute (uv 0,0 ; dessus en (20,0) 20×20) et de la marche (uv 0,23 ; dessus (24,23) 24×24).
    for (x0, y0, n) in ((20, 0, 20), (24, 23, 24)):
        for y in range(n):
            for x in range(n):
                px[x0 + x, y0 + y] = (*pal["fond"], 255)
        for _ in range(7):
            x, y = rnd.randrange(1, n - 1), rnd.randrange(1, n - 1)
            dx, dy = rnd.choice([(1, 0), (0, 1), (-1, 0), (0, -1)])
            for _k in range(rnd.randrange(4, n)):
                if 0 <= x < n and 0 <= y < n:
                    px[x0 + x, y0 + y] = (*pal["piste"], 255)
                if rnd.random() < 0.2:
                    dx, dy = rnd.choice([(dy, dx), (-dy, -dx)])
                x, y = x + dx, y + dy
            if 0 <= x < n and 0 <= y < n:
                px[x0 + x, y0 + y] = (*pal["pastille"], 255)
    # La puce, au centre de la dalle haute (sous les pieds, en partie cachée).
    for y in range(7, 13):
        for x in range(26, 34):
            px[x, y] = (*pal["puce"], 255)
    # Cristaux (uv 96,0 : petits blocs 2×4×2, 3×6×3).
    for y in range(0, 20):
        for x in range(96, 128):
            c = pal["cristal"] if (x + y) % 5 else pal["pastille"]
            px[x, y] = (*c, 255)
    tex = np.asarray(im, dtype=np.float32) / 255
    # Pistes, pastilles et cristaux luisent (le glowmask de GeckoLib).
    clair = np.array(pal["piste"]) / 255
    lueur = (np.abs(tex[..., :3] - clair).sum(-1) < 0.05) | (tex[..., :3].sum(-1) > 2.4)
    lueur[:20, 96:] = True
    return tex, lueur.astype(np.float32)


#: Le socle des joueurs : une carte de circuit imprimé à étages, et ses cristaux.
SOCLE_GEO = {
    "description": {"identifier": "geometry.opm_socle", "texture_width": 128, "texture_height": 64},
    "bones": [
        {
            "name": "socle",
            "pivot": [0, 0, 0],
            "cubes": [
                {"origin": [-10, -3, -10], "size": [20, 3, 20], "uv": [0, 0]},
                {"origin": [-12, -5, -12], "size": [24, 2, 24], "uv": [0, 23]},
                {"origin": [7, 0, -9], "size": [2, 4, 2], "uv": [96, 0], "pivot": [8, 0, -8], "rotation": [0, 20, 8]},
                {"origin": [-10, -3, 5], "size": [3, 6, 3], "uv": [104, 0], "pivot": [-8, -3, 6], "rotation": [-6, 35, -10]},
                {"origin": [8, -3, 8], "size": [2, 3, 2], "uv": [96, 8], "pivot": [9, -3, 9], "rotation": [10, 50, 0]},
                {"origin": [-12, -5, -12], "size": [2, 5, 2], "uv": [116, 0], "pivot": [-11, -5, -11], "rotation": [0, 15, -12]},
            ],
        }
    ],
}


def joueur_geo(fin: bool) -> dict:
    """Le modèle du joueur de Minecraft (skin 64 × 64), bras fins ou larges, calques compris."""
    b = 3 if fin else 4
    return {
        "description": {"identifier": "geometry.opm_joueur" + ("_fin" if fin else ""), "texture_width": 64, "texture_height": 64},
        "bones": [
            {"name": "joueur", "pivot": [0, 0, 0]},
            {"name": "body", "parent": "joueur", "pivot": [0, 24, 0], "cubes": [
                {"origin": [-4, 12, -2], "size": [8, 12, 4], "uv": [16, 16]},
                {"origin": [-4, 12, -2], "size": [8, 12, 4], "uv": [16, 32], "inflate": 0.25}]},
            {"name": "head", "parent": "body", "pivot": [0, 24, 0], "cubes": [
                {"origin": [-4, 24, -4], "size": [8, 8, 8], "uv": [0, 0]},
                {"origin": [-4, 24, -4], "size": [8, 8, 8], "uv": [32, 0], "inflate": 0.5}]},
            {"name": "right_arm", "parent": "body", "pivot": [-5, 22, 0], "cubes": [
                {"origin": [-4 - b, 12, -2], "size": [b, 12, 4], "uv": [40, 16]},
                {"origin": [-4 - b, 12, -2], "size": [b, 12, 4], "uv": [40, 32], "inflate": 0.25}]},
            {"name": "left_arm", "parent": "body", "pivot": [5, 22, 0], "cubes": [
                {"origin": [4, 12, -2], "size": [b, 12, 4], "uv": [32, 48]},
                {"origin": [4, 12, -2], "size": [b, 12, 4], "uv": [48, 48], "inflate": 0.25}]},
            {"name": "right_leg", "parent": "joueur", "pivot": [-1.9, 12, 0], "cubes": [
                {"origin": [-3.9, 0, -2], "size": [4, 12, 4], "uv": [0, 16]},
                {"origin": [-3.9, 0, -2], "size": [4, 12, 4], "uv": [0, 32], "inflate": 0.25}]},
            {"name": "left_leg", "parent": "joueur", "pivot": [1.9, 12, 0], "cubes": [
                {"origin": [-0.1, 0, -2], "size": [4, 12, 4], "uv": [16, 48]},
                {"origin": [-0.1, 0, -2], "size": [4, 12, 4], "uv": [0, 48], "inflate": 0.25}]},
        ],
    }


#: Un bloc du monde que façonne Xenodys : 16 unités, UV « box » (texture 64 × 32).
BLOC_GEO = {
    "description": {"identifier": "geometry.opm_bloc", "texture_width": 64, "texture_height": 32},
    "bones": [{"name": "bloc", "pivot": [0, 0, 0], "cubes": [{"origin": [-8, -8, -8], "size": [16, 16, 16], "uv": [0, 0]}]}],
}


def texture_bloc(etat: str):
    """Un bloc de la simulation : faces sombres, arêtes et circuit lumineux (glowmask)."""
    import random

    pal = {
        "creatrice": ((22, 70, 63), (52, 150, 135), (145, 217, 209), (233, 255, 252)),
        "corrompue": ((62, 20, 56), (150, 44, 132), (240, 80, 110), (255, 211, 221)),
    }[etat]
    fond, ligne, vif, coeur = pal
    im = Image.new("RGBA", (64, 32), (0, 0, 0, 0))
    glow = Image.new("RGBA", (64, 32), (0, 0, 0, 0))
    rnd = random.Random(16)
    # Six faces 16 × 16 de la disposition « box » (u, v) : est, nord, ouest, sud, dessus, dessous.
    faces = [(0, 16), (16, 16), (32, 16), (48, 16), (16, 0), (32, 0)]
    for fx, fy in faces:
        for y in range(16):
            for x in range(16):
                bord = x in (0, 15) or y in (0, 15)
                c = ligne if bord else fond
                if not bord and rnd.random() < 0.06:
                    c = tuple(min(255, int(v * 1.25)) for v in fond)
                im.putpixel((fx + x, fy + y), (*c, 255))
        # Une piste qui traverse la face, et sa pastille : elles luisent.
        y0 = 4 + rnd.randrange(8)
        for x in range(2, 14):
            im.putpixel((fx + x, fy + y0), (*vif, 255))
            glow.putpixel((fx + x, fy + y0), (*vif, 255))
        px = 2 + rnd.randrange(12)
        for dy in (-1, 0, 1):
            im.putpixel((fx + px, fy + y0 + dy), (*coeur, 255))
            glow.putpixel((fx + px, fy + y0 + dy), (*coeur, 255))
    return im, glow


def scene_modeles() -> None:
    """Les modèles 3D de la scène de chargement, pour le mod et pour le launcher.

    Socle, joueur (bras larges et fins), bloc du monde : géométrie Bedrock (mod :
    `assets/opm/geckolib/geo/`, launcher : `assets/js/data/scene-models.js`) et
    textures (`assets/opm/textures/entity/`, `assets/xenodys/`).
    """
    mod = RACINE / "mod" / "src" / "main" / "resources" / "assets" / "opm"
    launcher = RACINE / "launcher" / "src" / "assets"
    geos = {"socle": SOCLE_GEO, "joueur": joueur_geo(False), "joueur_fin": joueur_geo(True), "bloc": BLOC_GEO}
    (mod / "geckolib" / "geo").mkdir(parents=True, exist_ok=True)
    for nom, geo in geos.items():
        doc = {"format_version": "1.12.0", "minecraft:geometry": [geo]}
        (mod / "geckolib" / "geo" / f"{nom}.geo.json").write_text(json.dumps(doc, indent=1) + "\n")
    for etat in ETATS:
        tex, lueur = texture_socle(etat)
        im = Image.fromarray((np.clip(tex, 0, 1) * 255).astype(np.uint8))
        gl = np.zeros(tex.shape, dtype=np.uint8)
        gl[lueur > 0] = (np.clip(tex[lueur > 0], 0, 1) * 255).astype(np.uint8)
        gl_im = Image.fromarray(gl)
        b_im, b_gl = texture_bloc(etat)
        # L'orbe d'un joueur : un petit cube de lumière (tout en glowmask).
        vif, coeur = ((145, 217, 209), (233, 255, 252)) if etat == "creatrice" else ((240, 80, 110), (255, 211, 221))
        o_im = Image.new("RGBA", (64, 32), (*vif, 255))
        for y in range(32):
            for x in range(64):
                if (x % 16) in range(5, 11) and (y % 16) in range(5, 11):
                    o_im.putpixel((x, y), (*coeur, 255))
                elif (x + y) % 7 == 0:
                    o_im.putpixel((x, y), (*coeur, 255))
        for dossier in (mod / "textures" / "entity", launcher / "xenodys"):
            dossier.mkdir(parents=True, exist_ok=True)
            im.save(dossier / f"socle_{etat}.png")
            gl_im.save(dossier / f"socle_{etat}_glowmask.png")
            b_im.save(dossier / f"bloc_{etat}.png")
            b_gl.save(dossier / f"bloc_{etat}_glowmask.png")
            o_im.save(dossier / f"orbe_{etat}.png")
            o_im.save(dossier / f"orbe_{etat}_glowmask.png")
    (launcher / "js" / "data" / "scene-models.js").write_text(
        "/**\n * Modèles 3D de la scène de chargement — FICHIER GÉNÉRÉ par xenodys/sprites.py.\n"
        " * Les mêmes que le mod du jeu (assets/opm/geckolib/geo/).\n */\n\n"
        + "".join(f"export const {nom.upper()}_GEO = {json.dumps({'format_version': '1.12.0', 'minecraft:geometry': [geo]})};\n"
                  for nom, geo in geos.items())
    )


def copier_modele() -> None:
    """Le modèle GeckoLib, dans les ressources du mod (écran titre 3D, et l'entité à venir)."""
    import shutil

    base = RACINE / "mod" / "src" / "main" / "resources" / "assets" / "opm"
    for sous in ("geo", "animations"):
        (base / "geckolib" / sous).mkdir(parents=True, exist_ok=True)
        for f in (GECKO / sous).glob("*.json"):
            shutil.copyfile(f, base / "geckolib" / sous / f.name)
    (base / "textures" / "entity").mkdir(parents=True, exist_ok=True)
    for f in (GECKO / "textures").glob("*.png"):
        shutil.copyfile(f, base / "textures" / "entity" / f.name)


def bandeau(meta: dict) -> None:
    """Le bandeau One Piece Minecraft, réduit une fois pour toutes (net à l'écran)."""
    src = Image.open(RACINE / "launcher" / "src" / "assets" / "images" / "bandeau-opm.png").convert("RGBA")
    import colorsys

    # Corrompue : le cyan du pavillon passe au rouge et violet de l'invasion.
    arr = np.asarray(src, dtype=np.float32) / 255
    rgb = arr[..., :3]
    teinte = (rgb[..., 1] - rgb[..., 0] > 0.12) & (rgb[..., 2] - rgb[..., 0] > 0.08)
    corr = arr.copy()
    for y, x in zip(*np.nonzero(teinte)):
        h_, l_, s_ = colorsys.rgb_to_hls(*rgb[y, x])
        corr[y, x, :3] = colorsys.hls_to_rgb(0.97 if l_ > 0.45 else 0.82, l_ * 0.82, min(1, s_ * 1.6))
    corr_im = Image.fromarray((corr * 255).astype(np.uint8))
    corr_im.save(SORTIES[1] / "bandeau_corrompue.png", optimize=True)
    for suffixe, image in (("", src), ("_corrompue", corr_im)):
        for largeur in (480, 240):
            h = round(image.height * largeur / image.width)
            im = image.resize((largeur, h), Image.LANCZOS)
            im.save(SORTIES[0] / f"bandeau_{largeur}{suffixe}.png", optimize=True)
            meta[f"bandeau_{largeur}{suffixe}"] = {"largeur": largeur, "hauteur": h, "images": 1, "origine": [0, 0], "fps": 0,
                                                    "boucle": False, "colonnes": 1, "densite": 1}


def main() -> None:
    meta: dict = {}
    bandeau(meta)
    police(meta)
    scene_modeles()
    copier_modele()
    menus()
    for dossier in SORTIES:
        (dossier / "sprites.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False) + "\n")
    # Le launcher ne lit pas de JSON local avec fetch() : un module ES.
    (RACINE / "launcher" / "src" / "assets" / "js" / "data" / "sprites.js").write_text(
        "/**\n * Planches de sprites de Xenodys — FICHIER GÉNÉRÉ par xenodys/sprites.py, ne pas\n"
        " * modifier à la main. Les images sont dans assets/sprites/ ; le mod du jeu a les mêmes.\n */\n\n"
        f"export const SPRITES = {json.dumps(meta, ensure_ascii=False)};\n"
    )
    print(f"{len(meta)} planches écrites dans :")
    for dossier in SORTIES:
        print(" ", dossier.relative_to(RACINE))




# --------------------------------------------------------------------------- #
# Police pixel (5 × 7, capitales, accents français)
# --------------------------------------------------------------------------- #

GLYPHES = {
    "A": ".###.|#...#|#...#|#####|#...#|#...#|#...#",
    "B": "####.|#...#|#...#|####.|#...#|#...#|####.",
    "C": ".###.|#...#|#....|#....|#....|#...#|.###.",
    "D": "####.|#...#|#...#|#...#|#...#|#...#|####.",
    "E": "#####|#....|#....|####.|#....|#....|#####",
    "F": "#####|#....|#....|####.|#....|#....|#....",
    "G": ".###.|#...#|#....|#.###|#...#|#...#|.####",
    "H": "#...#|#...#|#...#|#####|#...#|#...#|#...#",
    "I": "###|.#.|.#.|.#.|.#.|.#.|###",
    "J": "..###|...#.|...#.|...#.|#..#.|#..#.|.##..",
    "K": "#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#",
    "L": "#....|#....|#....|#....|#....|#....|#####",
    "M": "#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#",
    "N": "#...#|##..#|#.#.#|#..##|#...#|#...#|#...#",
    "O": ".###.|#...#|#...#|#...#|#...#|#...#|.###.",
    "P": "####.|#...#|#...#|####.|#....|#....|#....",
    "Q": ".###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#",
    "R": "####.|#...#|#...#|####.|#.#..|#..#.|#...#",
    "S": ".####|#....|#....|.###.|....#|....#|####.",
    "T": "#####|..#..|..#..|..#..|..#..|..#..|..#..",
    "U": "#...#|#...#|#...#|#...#|#...#|#...#|.###.",
    "V": "#...#|#...#|#...#|#...#|#...#|.#.#.|..#..",
    "W": "#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.",
    "X": "#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#",
    "Y": "#...#|#...#|.#.#.|..#..|..#..|..#..|..#..",
    "Z": "#####|....#|...#.|..#..|.#...|#....|#####",
    "0": ".###.|#...#|#..##|#.#.#|##..#|#...#|.###.",
    "1": ".#.|##.|.#.|.#.|.#.|.#.|###",
    "2": ".###.|#...#|....#|...#.|..#..|.#...|#####",
    "3": "####.|....#|....#|.###.|....#|....#|####.",
    "4": "...#.|..##.|.#.#.|#..#.|#####|...#.|...#.",
    "5": "#####|#....|####.|....#|....#|#...#|.###.",
    "6": ".###.|#....|#....|####.|#...#|#...#|.###.",
    "7": "#####|....#|...#.|..#..|..#..|..#..|..#..",
    "8": ".###.|#...#|#...#|.###.|#...#|#...#|.###.",
    "9": ".###.|#...#|#...#|.####|....#|....#|.###.",
    " ": "...|...|...|...|...|...|...",
    ".": ".|.|.|.|.|.|#",
    ",": "..|..|..|..|..|.#|#.",
    ":": ".|#|.|.|.|#|.",
    "'": "#|#|.|.|.|.|.",
    "’": "#|#|.|.|.|.|.",
    "-": "....|....|....|####|....|....|....",
    "!": "#|#|#|#|#|.|#",
    "?": ".###.|#...#|....#|...#.|..#..|.....|..#..",
    "%": "##..#|##..#|...#.|..#..|.#...|#..##|#..##",
    "/": "....#|...#.|...#.|..#..|.#...|.#...|#....",
    "(": ".#|#.|#.|#.|#.|#.|.#",
    ")": "#.|.#|.#|.#|.#|.#|#.",
    "…": ".....|.....|.....|.....|.....|.....|#.#.#",
    "+": ".....|..#..|..#..|#####|..#..|..#..|.....",
    "·": ".|.|.|#|.|.|.",
}
# Capitales accentuées : la lettre de base, et l'accent sur les deux lignes du dessus.
ACCENTS = {
    "É": ("E", "...#.|..#.."), "È": ("E", ".#...|..#.."), "Ê": ("E", "..#..|.#.#."), "Ë": ("E", ".#.#.|....."),
    "À": ("A", ".#...|..#.."), "Â": ("A", "..#..|.#.#."), "Ç": ("C", None),
    "Ù": ("U", ".#...|..#.."), "Û": ("U", "..#..|.#.#."), "Ü": ("U", ".#.#.|....."),
    "Ô": ("O", "..#..|.#.#."), "Î": ("I", ".#.|#.#"), "Ï": ("I", "#.#|..."),
}


def police(meta: dict) -> None:
    """Atlas 16 colonnes, cases de 6 × 11 (2 lignes d'accent, 7 de lettre, 2 de jambage)."""
    cw, ch = 6, 11
    caracteres = list(GLYPHES) + list(ACCENTS)
    rangs = math.ceil(len(caracteres) / 16)
    im = Image.new("RGBA", (16 * cw, rangs * ch), (0, 0, 0, 0))
    px = im.load()
    avances = {}

    def poser(i, lignes, dy):
        x0, y0 = (i % 16) * cw, (i // 16) * ch
        for y, ligne in enumerate(lignes):
            for x, c in enumerate(ligne):
                if c == "#":
                    px[x0 + x, y0 + dy + y] = (255, 255, 255, 255)

    for i, c in enumerate(caracteres):
        if c in GLYPHES:
            lignes = GLYPHES[c].split("|")
            poser(i, lignes, 2)
        else:
            base, accent = ACCENTS[c]
            lignes = GLYPHES[base].split("|")
            poser(i, lignes, 2)
            if accent:
                largeur = len(lignes[0])
                acc = [a[:largeur].ljust(largeur, ".") if len(a) >= largeur else a.center(largeur, ".") for a in accent.split("|")]
                poser(i, acc, 0)
            else:  # cédille
                x0, y0 = (i % 16) * cw, (i // 16) * ch
                px[x0 + 2, y0 + 9] = (255, 255, 255, 255)
                px[x0 + 1, y0 + 10] = (255, 255, 255, 255)
        avances[c] = len(GLYPHES[c if c in GLYPHES else ACCENTS[c][0]].split("|")[0]) + 1
    for dossier in SORTIES:
        im.save(dossier / "police.png")
    meta["police"] = {
        "largeur": cw, "hauteur": ch, "images": len(caracteres), "origine": [0, 2], "fps": 0, "boucle": False, "densite": 1,
        "points": {"caracteres": "".join(caracteres), "avances": [avances[c] for c in caracteres], "colonnes": 16},
    }




# --------------------------------------------------------------------------- #
# Les menus du jeu aux couleurs du launcher (pack de ressources du mod)
# --------------------------------------------------------------------------- #

def menus() -> None:
    """Boutons, curseurs, champs, séparateurs et fonds des menus, hors partie.

    **Le jeu sur le serveur garde son apparence** (et celle de son pack de
    ressources) : les boutons, curseurs et champs vont dans `assets/opm/…`, et le
    mod ne les substitue à ceux du jeu que hors du monde et sans pack du serveur
    (mixin/GuiGraphicsMixin). Les fonds et séparateurs remplacés sont ceux des
    menus hors partie seulement ; leurs variantes « inworld » (menu pause…) ne
    sont pas touchées. Palette « créatrice ».
    """
    base = RACINE / "mod" / "src" / "main" / "resources" / "assets" / "minecraft" / "textures" / "gui"
    widget = RACINE / "mod" / "src" / "main" / "resources" / "assets" / "opm" / "textures" / "gui" / "sprites" / "widget"
    import shutil

    # Anciennes substitutions directes (versions précédentes) : retirées.
    shutil.rmtree(base / "sprites", ignore_errors=True)
    for ancien in ("inworld_header_separator", "inworld_footer_separator", "inworld_menu_background",
                   "inworld_menu_list_background"):
        (base / f"{ancien}.png").unlink(missing_ok=True)
    widget.mkdir(parents=True, exist_ok=True)
    fond, fond_hi, fond_off = (14, 37, 34, 245), (29, 92, 81, 255), (10, 22, 21, 200)
    accent, core, terne = (145, 217, 209, 255), (233, 255, 252, 255), (60, 92, 88, 255)

    def bouton(fichier, couleur, bas, gauche=None, haut=None, w=200, h=20):
        im = Image.new("RGBA", (w, h), couleur)
        px = im.load()
        for x in range(w):
            px[x, h - 1] = bas
            if haut:
                px[x, 0] = haut
        for y in range(h):
            if gauche:
                px[0, y] = gauche
                px[1, y] = gauche
        im.save(widget / fichier)

    def meta(fichier, w, h, bord):
        (widget / f"{fichier}.mcmeta").write_text(json.dumps(
            {"gui": {"scaling": {"type": "nine_slice", "width": w, "height": h, "border": bord}}}) + "\n")

    bouton("button.png", fond, accent[:3] + (150,), haut=(145, 217, 209, 40))
    bouton("button_highlighted.png", fond_hi, accent, gauche=core, haut=(233, 255, 252, 70))
    bouton("button_disabled.png", fond_off, terne[:3] + (120,))
    for f in ("button.png", "button_highlighted.png"):
        meta(f, 200, 20, 3)
    meta("button_disabled.png", 200, 20, 1)
    bouton("slider.png", (7, 18, 17, 235), accent[:3] + (120,))
    bouton("slider_highlighted.png", (10, 28, 26, 245), accent)
    meta("slider.png", 200, 20, 1)
    meta("slider_highlighted.png", 200, 20, 1)
    bouton("slider_handle.png", accent, (29, 92, 81, 255), w=8, h=20)
    bouton("slider_handle_highlighted.png", core, accent, w=8, h=20)
    for f in ("slider_handle.png", "slider_handle_highlighted.png"):
        (widget / f"{f}.mcmeta").write_text(json.dumps({"gui": {"scaling": {"type": "nine_slice", "width": 8, "height": 20,
                                                          "border": {"left": 2, "top": 2, "right": 2, "bottom": 3}}}}) + "\n")
    for f, bord in (("text_field.png", accent[:3] + (120,)), ("text_field_highlighted.png", core)):
        im = Image.new("RGBA", (200, 20), (4, 11, 10, 235))
        px = im.load()
        for x in range(200):
            px[x, 0] = px[x, 19] = bord
        for y in range(20):
            px[0, y] = px[199, y] = bord
        im.save(widget / f)
        meta(f, 200, 20, 1)

    # Séparateurs (32 × 2) et fonds (16 × 16) : une trame de la salle de simulation.
    for nom, couleur in (("header_separator", accent), ("footer_separator", accent)):
        im = Image.new("RGBA", (32, 2), (0, 0, 0, 0))
        for x in range(32):
            im.putpixel((x, 0 if "header" in nom else 1), couleur[:3] + ((200 if x % 4 else 255),))
        im.save(base / f"{nom}.png")
    for nom, alpha in (("menu_background", 110), ("menu_list_background", 120)):
        # Un voile uni : la salle de simulation reste lisible dessous, sans grille en plus.
        im = Image.new("RGBA", (16, 16), (3, 9, 9, alpha))
        im.save(base / f"{nom}.png")


if __name__ == "__main__":
    main()
