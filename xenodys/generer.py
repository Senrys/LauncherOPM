#!/usr/bin/env python3
"""Xenodys en cubes — générateur du modèle, des animations et des textures.

Une seule source pour le launcher ET le jeu : ce script écrit

- ``geckolib/geo/xenodys.geo.json``                 géométrie Bedrock 1.12.0 (GeckoLib, Blockbench)
- ``geckolib/animations/xenodys.animation.json``    animations Bedrock 1.8.0 (GeckoLib)
- ``geckolib/textures/xenodys_creatrice.png``       + ``_glowmask.png`` (AutoGlowingGeoLayer)
- ``geckolib/textures/xenodys_corrompue.png``       + ``_glowmask.png``

et recopie le tout pour le launcher :

- ``launcher/src/assets/xenodys/*.png``
- ``launcher/src/assets/js/data/xenodys-model.js``  (géométrie + animations en module ES : le
  launcher n'a pas le droit de ``fetch`` un fichier local, il importe un module)

Le modèle s'ouvre tel quel dans Blockbench (« Open Model », format GeckoLib ou Bedrock
Entity) pour être retouché à la main. Mais une retouche faite dans Blockbench sera écrasée
au prochain lancement de ce script : choisir l'un ou l'autre comme source.

Conventions Bedrock : unités = pixels (1/16 de bloc), y vers le haut, pieds en y = 0,
Xenodys regarde vers le nord (−z). UV « box » : un pixel de texture par unité, toutes les
tailles de cubes sont entières.

Dépendance : Pillow (``pip install pillow``), seulement pour ce script.

    python3 xenodys/generer.py
"""

from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image

RACINE = Path(__file__).resolve().parent
DEPOT = RACINE.parent
SORTIE_GECKO = RACINE / "geckolib"
SORTIE_LAUNCHER_PNG = DEPOT / "launcher" / "src" / "assets" / "xenodys"
SORTIE_LAUNCHER_JS = DEPOT / "launcher" / "src" / "assets" / "js" / "data" / "xenodys-model.js"

# --------------------------------------------------------------------------- modèle

# Xenodys : la déesse-machine créatrice du monde. Une silhouette immense et
# féminine — casque à crête et cornes-lames, visage de porcelaine, halo en
# engrenage, buste ciselé, taille fine, épaulières massives, bras longs aux
# lames courbes, ailerons dans le dos, large jupe d'armure en plaques — et pas
# de jambes : un corps en flèche. Elle flotte.
#
# Environ 104 pixels de haut (6,5 blocs). En jeu, elle doit mesurer sept fois
# un humain (1,8 bloc → ~12,6 blocs) : le moteur de rendu GeckoLib l'agrandit
# d'un facteur RENDU_ECHELLE (voir README).

RENDU_ECHELLE = 1.95


@dataclass
class Cube:
    origin: tuple[float, float, float]
    size: tuple[int, int, int]
    mat: str
    pivot: tuple[float, float, float] | None = None
    rotation: tuple[float, float, float] | None = None
    uv: tuple[int, int] = (0, 0)


@dataclass
class Bone:
    name: str
    parent: str | None
    pivot: tuple[float, float, float]
    rotation: tuple[float, float, float] | None = None
    cubes: list[Cube] = field(default_factory=list)


def centre(cx, y, cz, w, h, d, mat, pivot=None, rotation=None):
    """Un cube décrit par le centre de sa base (plus lisible pour un corps symétrique)."""
    return Cube((cx - w / 2, y, cz - d / 2), (w, h, d), mat, pivot, rotation)


def modele() -> list[Bone]:
    """Xenodys : silhouette féminine (buste, taille fine, hanches larges), grande
    tête aux grands yeux, chevelure en mèches, mains immenses : c'est elle qui
    construit le monde."""
    os_: list[Bone] = []

    def bone(name, parent, pivot, rotation=None):
        b = Bone(name, parent, pivot, rotation)
        os_.append(b)
        return b

    bone("xenodys", None, (0, 0, 0))

    # ------------------------------------------------------------ le corps en flèche
    fleche = bone("spire", "xenodys", (0, 46, 0))
    fleche.cubes += [
        centre(0, 32, 0, 10, 14, 8, "plate"),
        centre(0, 30, 0, 12, 2, 10, "glowring"),
        centre(0, 18, 0, 7, 12, 6, "plate"),
        centre(0, 17, 0, 9, 1, 8, "trim"),
        centre(0, 8, 0, 4, 9, 4, "plate"),
        centre(0, 2, 0, 2, 6, 2, "crystal"),
    ]

    # --------------------------------------------------------------------- bassin
    corps = bone("body", "xenodys", (0, 62, 0))
    corps.cubes += [
        centre(0, 56, 0, 16, 6, 10, "plate"),
        centre(0, 55, 0, 17, 1, 11, "trim"),
        centre(0, 62, 0, 6, 6, 5, "joint"),
        centre(0, 63, -2.75, 2, 3, 1, "gem"),
    ]

    # ------------------------------------------------- la jupe d'armure (s'évase)
    devant = bone("skirt_front", "body", (0, 56, -5))
    devant.cubes += [
        centre(0, 30, -5.5, 10, 26, 2, "plate", (0, 56, -5), (-6, 0, 0)),
        centre(0, 34, -6.8, 2, 20, 1, "gem", (0, 56, -5), (-6, 0, 0)),
    ]
    for s in (1, -1):
        devant.cubes.append(centre(8 * s, 32, -4.5, 7, 24, 2, "plate", (5 * s, 56, -5), (-4, 18 * s, -10 * s)))
    dos = bone("skirt_back", "body", (0, 56, 5))
    dos.cubes.append(centre(0, 28, 5.5, 14, 28, 2, "drape", (0, 56, 5), (8, 0, 0)))
    for cote, s in (("left", 1), ("right", -1)):
        pan = bone(f"skirt_{cote}", "body", (8 * s, 56, 0))
        for k, (h, flare) in enumerate(((28, 22), (32, 32), (26, 44))):
            pan.cubes.append(centre((9 + k * 1.5) * s, 56 - h, (k - 1) * 3, 3, h, 9, "drape", (8 * s, 56, 0), (0, 0, -flare * s)))
        pan.cubes.append(centre(10 * s, 52, 0, 3, 4, 11, "trim", (8 * s, 56, 0), (0, 0, -22 * s)))

    # ------------------------------------------------------------------- buste
    buste = bone("chest", "body", (0, 68, 0))
    buste.cubes += [
        centre(0, 68, 0, 10, 9, 6, "chest"),
        centre(-2.6, 71, -3.6, 5, 4, 3, "bust"),
        centre(2.6, 71, -3.6, 5, 4, 3, "bust"),
        centre(0, 77, 0, 12, 2, 6, "trim"),
    ]
    for cote, s in (("left", 1), ("right", -1)):
        epaule = bone(f"pauldron_{cote}", "chest", (6 * s, 77, 0))
        epaule.cubes += [
            centre(8.5 * s, 75, 0, 5, 4, 6, "plate", (6 * s, 77, 0), (0, 0, -16 * s)),
            centre(11 * s, 74.5, 0, 1, 4, 4, "disc"),
        ]

    # ------------------------------------------------------------------- tête
    cou = bone("neck", "chest", (0, 79, 0))
    # Un cou de nacre, sans lumière : sous le menton, des points lumineux
    # passeraient pour une bouche.
    cou.cubes.append(centre(0, 79, 0, 3, 4, 3, "plate"))
    tete = bone("head", "neck", (0, 83, 0))
    tete.cubes += [
        centre(0, 83, 0, 12, 12, 12, "head"),
        centre(0, 95, 0.3, 13, 3, 13, "hairtop"),
        centre(6.5, 82, 0.8, 1, 13, 11, "hair"),
        centre(-6.5, 82, 0.8, 1, 13, 11, "hair"),
        # Mèches de devant : une frange en dents irrégulières.
        *[centre(x, 95 - h, -6.3, 2, h, 1, "hair") for x, h in ((-5, 4), (-3, 5), (-1, 3), (1, 4), (3, 5), (5, 3))],
        # Deux longues mèches qui encadrent le visage.
        centre(5.8, 74, -5.2, 2, 14, 2, "hair"),
        centre(-5.8, 74, -5.2, 2, 14, 2, "hair"),
        # Diadème, gemme et crête de cristal.
        centre(0, 96, 0.3, 14, 1, 14, "trim"),
        centre(0, 96, -6.9, 2, 2, 1, "gem"),
        centre(0, 97, -5.5, 1, 7, 1, "crest", (0, 97, -5.5), (-12, 0, 0)),
    ]
    for s in (1, -1):
        tete.cubes.append(centre(10 * s, 95, 1.5, 10, 2, 2, "blade", (6 * s, 96, 1.5), (0, -25 * s, -28 * s)))
    for k, x in enumerate((-4.5, -1.5, 1.5, 4.5)):
        meche = bone(f"cable_{k}", "head", (x, 93, 6))
        meche.cubes.append(centre(x, 60 - k % 2 * 5, 6.5, 3, 34 + k % 2 * 5, 2, "hairback"))

    # -------------------------------------------------------------------- halo
    halo = bone("halo", "head", (0, 90, 10))
    for k in range(24):
        a = k * math.pi / 12
        halo.cubes.append(centre(round(15 * math.cos(a), 2), round(90 + 15 * math.sin(a) - 1.5, 2), 10, 3, 3, 1, "trim" if k % 2 else "glow"))
    interieur = bone("halo_inner", "head", (0, 90, 11))
    for k in range(16):
        a = k * math.pi / 8
        interieur.cubes.append(centre(round(11 * math.cos(a), 2), round(90 + 11 * math.sin(a) - 1, 2), 11, 2, 2, 1, "glow"))

    # ------------------------------- bras longs et fins, mains immenses
    for cote, s in (("left", 1), ("right", -1)):
        x = 7.5 * s
        bras = bone(f"arm_{cote}", "chest", (x, 77, 0), (0, 0, -10 * s))
        bras.cubes += [centre(x, 59, 0, 3, 18, 3, "plate"), centre(x, 67, 0, 4, 1, 4, "glowring")]
        avant = bone(f"forearm_{cote}", f"arm_{cote}", (x, 59, 0), (-12, 0, 0))
        avant.cubes += [
            centre(x, 42, 0, 3, 17, 3, "plate"),
            centre(x, 47, 0, 4, 1, 4, "glowring"),
            centre(x, 40, 0, 3, 2, 3, "joint"),
        ]
        main = bone(f"hand_{cote}", f"forearm_{cote}", (x, 40, 0))
        main.cubes.append(centre(x, 33, 0, 3, 7, 8, "palm"))
        for k, (a, b) in enumerate(((4, 3), (5, 3), (4, 3), (3, 2))):
            z = -3 + 2 * k
            doigt = bone(f"finger_{cote}_{k}", f"hand_{cote}", (x, 33, z))
            doigt.cubes.append(centre(x, 33 - a, z, 2, a, 2, "finger"))
            bout = bone(f"finger_{cote}_{k}_tip", f"finger_{cote}_{k}", (x, 33 - a, z))
            bout.cubes.append(centre(x, 33 - a - b, z, 2, b, 2, "fingertip"))
        pouce = bone(f"thumb_{cote}", f"hand_{cote}", (x, 38, -4), (-30, 0, 0))
        pouce.cubes.append(centre(x, 34, -4.5, 2, 4, 2, "finger"))
        bout = bone(f"thumb_{cote}_tip", f"thumb_{cote}", (x, 34, -4.5))
        bout.cubes.append(centre(x, 31, -4.5, 2, 3, 2, "fingertip"))

    # ---------------------------------------------- ailerons, depuis le dos
    for cote, s in (("left", 1), ("right", -1)):
        aile = bone(f"wing_{cote}", "chest", (4 * s, 74, 3.5), (0, -18 * s, 0))
        for tilt, longueur, y in ((28, 26, 76), (8, 30, 72), (-14, 24, 68)):
            aile.cubes.append(
                Cube((4 * s if s > 0 else 4 * s - longueur, y, 3.5), (longueur, 4, 2), "fin", (4 * s, y + 2, 4.5), (0, 0, -tilt * s))
            )

    return os_


def modele_assistant() -> list[Bone]:
    """Les assistants de Xenodys : de petits robots chibi, grosse tête à visière,
    grands yeux, une crête et un halo comme elle — et deux jambes."""
    os_: list[Bone] = []

    def bone(name, parent, pivot, rotation=None):
        b = Bone(name, parent, pivot, rotation)
        os_.append(b)
        return b

    bone("assistant", None, (0, 0, 0))
    for cote, s in (("left", 1), ("right", -1)):
        jambe = bone(f"leg_{cote}", "assistant", (1.25 * s, 4, 0))
        jambe.cubes += [centre(1.25 * s, 1, 0, 2, 3, 2, "plate"), centre(1.25 * s, 0, -0.5, 2, 1, 3, "joint")]
    corps = bone("body", "assistant", (0, 4, 0))
    corps.cubes += [
        centre(0, 4, 0, 5, 5, 4, "plate"),
        centre(0, 3, 0, 6, 1, 5, "trim"),
        centre(0, 6, -2.25, 1, 2, 1, "gem"),
    ]
    for cote, s in (("left", 1), ("right", -1)):
        bras = bone(f"arm_{cote}", "body", (3 * s, 8.5, 0), (0, 0, -8 * s))
        bras.cubes += [centre(3 * s, 5, 0, 1, 4, 1, "plate"), centre(3 * s, 3.5, 0, 2, 2, 2, "palm")]
    tete = bone("head", "body", (0, 9, 0))
    tete.cubes += [
        centre(0, 9, 0, 9, 8, 8, "chibihead"),
        centre(5, 11, 0.5, 1, 4, 4, "trim"),
        centre(-5, 11, 0.5, 1, 4, 4, "trim"),
        centre(0, 17, -1, 1, 3, 1, "crystal"),
    ]
    halo = bone("halo", "head", (0, 20, 0))
    for k in range(8):
        a = k * math.pi / 4
        halo.cubes.append(centre(round(3.5 * math.cos(a), 2), 19.5, round(3.5 * math.sin(a), 2), 1, 1, 1, "glow"))
    return os_


# ------------------------------------------------------------------------- palettes

PALETTES = {
    "creatrice": {
        "plate": ["#F4F6FA", "#D9DEE8", "#B9C1D0", "#8E98AC"],
        "trim": ["#F1D58A", "#C9A34E", "#97752F", "#5E4718"],
        "drape": ["#7D6A55", "#5E4D3C", "#463829", "#2E241A"],
        "joint": ["#3A4250", "#272D37", "#181C23"],
        "glow": ["#E9FFFC", "#7FF5E8", "#3FD0C2"],
        "skin": ["#F7EEEA", "#E8DAD5", "#C9B6B0"],
        "eye": ["#FFFFFF", "#3FE6D6", "#E9FFFC", "#1E9C92"],
        "lips": ["#D79AA8", "#B97888"],
        "blush": "#F0CFCF",
        "lash": "#2B3340",
        "hair": ["#FFFFFF", "#E6ECF2", "#C9D3DE", "#9AA8B8"],
        "crystal": ["#E2FFFB", "#8DE6DB", "#45B3A6", "#1F6E66"],
        "cable": ["#C9D1DE", "#9AA5B8", "#6B778C"],
        "crack": None,
    },
    "corrompue": {
        "plate": ["#4A3A55", "#2C2233", "#1E1724", "#120D17"],
        "trim": ["#A8324E", "#7A1F38", "#521326", "#2E0915"],
        "drape": ["#3A1630", "#2A0F23", "#1D0A18", "#12060F"],
        "joint": ["#1A0D18", "#0E0710", "#070308"],
        "glow": ["#FFD3DD", "#FF4D6D", "#C0284A"],
        "skin": ["#DCD0DA", "#BDAEBB", "#5A1F4A"],
        "eye": ["#2A0A18", "#FF2E55", "#FFD3DD", "#9E1032"],
        "lips": ["#6A1F3A", "#4A0F2E"],
        "blush": "#B98AA6",
        "lash": "#12060F",
        "hair": ["#E8E0EE", "#C9BFD0", "#A898B5", "#6E5A80"],
        "crystal": ["#FFD3DD", "#F0506E", "#9E1F5A", "#4A0F2E"],
        "cable": ["#5A4A66", "#3E3148", "#2A1F33"],
        "crack": ["#FF4D6D", "#7A1035"],
    },
}


def couleur(hexa: str, alpha: int = 255) -> tuple[int, int, int, int]:
    hexa = hexa.lstrip("#")
    return (int(hexa[0:2], 16), int(hexa[2:4], 16), int(hexa[4:6], 16), alpha)


# --------------------------------------------------------------------- peinture

COTES = ("north", "south", "east", "west")


def regions(cube: Cube) -> dict[str, tuple[int, int, int, int]]:
    """Régions UV « box » (x, y, largeur, hauteur) de chaque face, façon Blockbench."""
    w, h, d = cube.size
    u, v = cube.uv
    return {
        "east": (u, v + d, d, h),
        "north": (u + d, v + d, w, h),
        "west": (u + d + w, v + d, d, h),
        "south": (u + 2 * d + w, v + d, w, h),
        "up": (u + d, v, w, d),
        "down": (u + d + w, v, w, d),
    }


class Pinceau:
    """Peint une face : couleur, et éventuellement lumière propre (glowmask)."""

    def __init__(self, img, glow, x0, y0, w, h):
        self.img, self.glow, self.x0, self.y0, self.w, self.h = img, glow, x0, y0, w, h

    def px(self, x, y, hexa, lum=False):
        if 0 <= x < self.w and 0 <= y < self.h and hexa:
            c = couleur(hexa)
            self.img.putpixel((self.x0 + x, self.y0 + y), c)
            self.glow.putpixel((self.x0 + x, self.y0 + y), c if lum else (0, 0, 0, 0))


def fissures(p, pal, rng, chance=0.5):
    """Corrompue : une fissure rouge court sur la plaque."""
    if not pal["crack"] or p.h < 5 or rng.random() > chance:
        return
    x, y = rng.randrange(p.w), 0
    while y < p.h:
        p.px(x, y, pal["crack"][0] if rng.random() < 0.6 else pal["crack"][1], lum=True)
        y += 1
        x = max(0, min(p.w - 1, x + rng.choice((-1, 0, 0, 1))))


def plaque(p, pal, rng, face, filet=True):
    """Plaque d'armure nacrée : reflet en haut, ombre en bas, lignes de panneaux,
    et un filet lumineux qui court au milieu des grandes faces."""
    c = pal["plate"]
    for y in range(p.h):
        for x in range(p.w):
            col = c[1]
            if face in COTES:
                if y == 0:
                    col = c[0]
                elif y == p.h - 1 or x in (0, p.w - 1):
                    col = c[2]
                elif p.h >= 10 and y % 8 == 7:
                    col = c[3]  # joint entre deux panneaux
            r = rng.random()
            if r < 0.04:
                col = c[0]
            elif r < 0.07:
                col = c[2]
            p.px(x, y, col)
    if filet and face in COTES and p.h >= 6 and p.w >= 3:
        x = p.w // 2
        for y in range(1, p.h - 1):
            if y % 8 != 7:
                p.px(x, y, pal["glow"][1], lum=True)
    if face in COTES:
        fissures(p, pal, rng)


def garniture(p, pal, rng, face):
    """Bronze ciselé : alternance de reflets, petits rivets."""
    c = pal["trim"]
    for y in range(p.h):
        for x in range(p.w):
            col = c[1] if (x + y) % 4 else c[0]
            if y == p.h - 1 and face in COTES:
                col = c[2]
            if rng.random() < 0.05:
                col = c[3]
            p.px(x, y, col)


def drape(p, pal, rng, face):
    """Plaques sombres en lames verticales, comme une étoffe d'armure."""
    c = pal["drape"]
    for x in range(p.w):
        bande = c[(x // 2) % 3]
        for y in range(p.h):
            col = bande
            if x % 2 == 1:
                col = c[3]
            if y == p.h - 1 and face in COTES:
                col = pal["trim"][1]
            p.px(x, y, col)
    if face in COTES and p.h > 6:
        # Une rainure dorée à mi-hauteur.
        y = p.h // 3
        for x in range(p.w):
            p.px(x, y, pal["trim"][2])
    fissures(p, pal, rng, 0.35)


def articulation(p, pal, rng, face):
    c = pal["joint"]
    for y in range(p.h):
        for x in range(p.w):
            p.px(x, y, c[0] if (x + y) % 3 == 0 else c[1])
    if face in COTES:
        for x in range(0, p.w, 2):
            p.px(x, p.h // 2, pal["glow"][2], lum=True)


def lumiere(p, pal, rng, face):
    g = pal["glow"]
    for y in range(p.h):
        for x in range(p.w):
            p.px(x, y, g[0] if (x + y) % 2 == 0 else g[1], lum=True)


def anneau(p, pal, rng, face):
    """Bague lumineuse : bronze dessus et dessous, lumière sur le pourtour."""
    if face in ("up", "down"):
        garniture(p, pal, rng, face)
        return
    for y in range(p.h):
        for x in range(p.w):
            p.px(x, y, pal["glow"][1] if x % 3 else pal["glow"][0], lum=True)


def gemme(p, pal, rng, face):
    """Chaîne de gemmes : losanges lumineux sertis de bronze."""
    for y in range(p.h):
        for x in range(p.w):
            p.px(x, y, pal["trim"][2])
    for y in range(p.h):
        if y % 3 == 2:
            continue
        for x in range(p.w):
            p.px(x, y, pal["glow"][0 if y % 3 == 0 else 1], lum=True)


def cristal(p, pal, rng, face):
    """Lame de cristal : sombre à la base, claire à la pointe ; la moitié haute brille."""
    c = pal["crystal"]
    for y in range(p.h):
        t = 1 - y / max(1, p.h - 1)
        col = c[0] if t > 0.85 else c[1] if t > 0.5 else c[2] if t > 0.2 else c[3]
        for x in range(p.w):
            p.px(x, y, col, lum=t > 0.4)


def lame(p, pal, rng, face):
    """Lame d'acier nacré : dos en bronze, fil lumineux."""
    c = pal["plate"]
    for y in range(p.h):
        for x in range(p.w):
            p.px(x, y, c[0] if (x + y) % 5 == 0 else c[1])
    if face in COTES:
        for y in range(p.h):
            p.px(0, y, pal["trim"][1])
            p.px(p.w - 1, y, pal["glow"][1], lum=True)
    elif p.w > 1 and p.h > 1:
        for x in range(p.w):
            p.px(x, 0, pal["glow"][1], lum=True)
    fissures(p, pal, rng, 0.4)


def aileron(p, pal, rng, face):
    """Ailerons du dos : longues plaques nacrées, bord de bronze, lignes lumineuses."""
    c = pal["plate"]
    for y in range(p.h):
        for x in range(p.w):
            col = c[1] if y not in (0, p.h - 1) else pal["trim"][1]
            if rng.random() < 0.04:
                col = c[0]
            p.px(x, y, col)
    if p.h >= 3:
        for x in range(2, p.w - 2, 1):
            if x % 6 < 4:
                p.px(x, p.h // 2, pal["glow"][1], lum=True)
    fissures(p, pal, rng, 0.4)


def cable(p, pal, rng, face):
    c = pal["cable"]
    for y in range(p.h):
        for x in range(p.w):
            col = c[(y // 2 + x) % 3]
            p.px(x, y, col)
        if y % 6 == 0:
            for x in range(p.w):
                p.px(x, y, pal["glow"][2], lum=True)


def casque(p, pal, rng, face):
    """Casque : nacre, bordure de bronze, deux lignes lumineuses sur le dessus."""
    plaque(p, pal, rng, face, filet=False)
    if face in COTES:
        for x in range(p.w):
            p.px(x, p.h - 1, pal["trim"][1])
    if face == "up":
        for y in range(p.h):
            p.px(p.w // 2 - 2, y, pal["glow"][1], lum=True)
            p.px(p.w // 2 + 1, y, pal["glow"][1], lum=True)


def visage(p, pal, etat):
    """Face nord de la tête (12 × 12). Un visage neutre, hautain : des yeux bien
    écartés, mi-clos sous des paupières lourdes, un reflet, des sourcils
    arqués — et pas de bouche. Le visage est une machine : coutures de plaques
    sous les yeux et au front, points de circuit aux pommettes, jointures de
    la mâchoire. Le haut est caché par la frange."""
    s_, e = pal["skin"], pal["eye"]
    motif = [
        "HHHHHHHHHHHH",
        "HHHHHHHHHHHH",
        "HhHHhHHhHHhH",
        "HSSSSkkSSSSH",
        "HSBBSSSSBBSH",
        "HBSSSSSSSSBH",
        "HLLLSSSSLLLH",
        "HWEISSSSIEWH",
        "HSEDSSSSDESH",
        "HSkSSSSSSkSH",
        "HckSSSSSSkcH",
        "JJSSSSSSSSJJ",
    ]
    couleurs = {
        "H": pal["hair"][1], "h": pal["hair"][2], "S": s_[0], "B": pal["lash"], "L": pal["lash"],
        "W": e[0], "k": s_[1], "J": pal["joint"][1],
    }
    for y, rangee in enumerate(motif):
        for x, ch in enumerate(rangee):
            if ch == "E":
                p.px(x, y, e[1], lum=True)
            elif ch == "D":
                p.px(x, y, e[3], lum=True)
            elif ch == "I":
                p.px(x, y, e[2], lum=True)
            elif ch == "c":
                p.px(x, y, pal["glow"][1], lum=True)
            else:
                p.px(x, y, couleurs[ch])
    if etat == "corrompue":
        # Une fissure part de l'œil droit et descend sur la joue ; l'autre œil coule.
        for x, y in ((8, 9), (8, 10), (9, 11)):
            p.px(x, y, pal["crack"][0], lum=True)
        p.px(2, 9, pal["crack"][1], lum=True)


def visage_chibi(p, pal, etat):
    """Visière d'un assistant (9 × 8) : deux petits yeux lumineux, écartés."""
    motif = [
        "PPPPPPPPP",
        "PVVVVVVVP",
        "PVIVVVIVP",
        "PVEVVVEVP",
        "PVVVVVVVP",
        "PVVVVVVVP",
        "PPPPgPPPP",
        "PPPPPPPPP",
    ]
    for y, rangee in enumerate(motif):
        for x, ch in enumerate(rangee):
            if ch == "P":
                p.px(x, y, pal["plate"][1 if y else 0])
            elif ch == "V":
                p.px(x, y, pal["joint"][2])
            elif ch == "E":
                p.px(x, y, pal["eye"][1], lum=True)
            elif ch == "D":
                p.px(x, y, pal["eye"][3], lum=True)
            elif ch == "I":
                p.px(x, y, pal["eye"][2], lum=True)
            elif ch == "g":
                p.px(x, y, pal["glow"][1], lum=True)


def tete_chibi(p, pal, rng, face, etat):
    if face == "north":
        visage_chibi(p, pal, etat)
    else:
        plaque(p, pal, rng, face, filet=face == "up")


def buste(p, pal, rng, face):
    """Plaques du buste : nacre bombée, liseré de bronze dessous, un éclat lumineux."""
    plaque(p, pal, rng, face, filet=False)
    if face in COTES:
        for x in range(p.w):
            p.px(x, p.h - 1, pal["trim"][1])
    if face == "north":
        p.px(1, 1, pal["plate"][0])
        p.px(p.w // 2, p.h // 2, pal["glow"][1], lum=True)


def tete(p, pal, rng, face, etat):
    if face == "north":
        visage(p, pal, etat)
    elif face == "down":
        for y in range(p.h):
            for x in range(p.w):
                p.px(x, y, pal["skin"][1])
    else:
        cheveux(p, pal, rng, face)


def cheveux(p, pal, rng, face, frange=False):
    """Cheveux argentés en mèches verticales, quelques reflets lumineux."""
    c = pal["hair"]
    for x in range(p.w):
        base = c[1 + (x * 7 + 3) % 3]
        for y in range(p.h):
            p.px(x, y, base if rng.random() > 0.12 else c[0])
        if face in ("south", "east", "west") and rng.random() < 0.1:
            for y in range(0, p.h, 2):
                p.px(x, y, pal["glow"][1], lum=True)
    if frange and face in COTES:
        for x in range(p.w):
            if rng.random() < 0.5:
                p.img.putpixel((p.x0 + x, p.y0 + p.h - 1), (0, 0, 0, 0))
                p.glow.putpixel((p.x0 + x, p.y0 + p.h - 1), (0, 0, 0, 0))


def doigt(p, pal, rng, face, bout=False):
    """Phalange nacrée, jointure sombre en haut ; l'extrémité luit à peine."""
    c = pal["plate"]
    for y in range(p.h):
        for x in range(p.w):
            p.px(x, y, c[1] if y else pal["joint"][0])
    if bout and face in COTES:
        p.px(0, p.h - 1, pal["glow"][2], lum=True)


PEINTRES = {
    "plate": lambda p, pal, rng, f, e: plaque(p, pal, rng, f),
    "chest": lambda p, pal, rng, f, e: plaque(p, pal, rng, f, filet=f != "north"),
    "trim": lambda p, pal, rng, f, e: garniture(p, pal, rng, f),
    "drape": lambda p, pal, rng, f, e: drape(p, pal, rng, f),
    "joint": lambda p, pal, rng, f, e: articulation(p, pal, rng, f),
    "glow": lambda p, pal, rng, f, e: lumiere(p, pal, rng, f),
    "glowring": lambda p, pal, rng, f, e: anneau(p, pal, rng, f),
    "disc": lambda p, pal, rng, f, e: anneau(p, pal, rng, f),
    "gem": lambda p, pal, rng, f, e: gemme(p, pal, rng, f),
    "crystal": lambda p, pal, rng, f, e: cristal(p, pal, rng, f),
    "crest": lambda p, pal, rng, f, e: cristal(p, pal, rng, f),
    "blade": lambda p, pal, rng, f, e: lame(p, pal, rng, f),
    "fin": lambda p, pal, rng, f, e: aileron(p, pal, rng, f),
    "cable": lambda p, pal, rng, f, e: cable(p, pal, rng, f),
    "helmet": lambda p, pal, rng, f, e: casque(p, pal, rng, f),
    "hair": lambda p, pal, rng, f, e: cheveux(p, pal, rng, f),
    "hairtop": lambda p, pal, rng, f, e: cheveux(p, pal, rng, f, frange=True),
    "hairback": lambda p, pal, rng, f, e: cheveux(p, pal, rng, f, frange=True),
    "palm": lambda p, pal, rng, f, e: plaque(p, pal, rng, f, filet=False),
    "finger": lambda p, pal, rng, f, e: doigt(p, pal, rng, f),
    "fingertip": lambda p, pal, rng, f, e: doigt(p, pal, rng, f, bout=True),
    "head": lambda p, pal, rng, f, e: tete(p, pal, rng, f, e),
    "chibihead": lambda p, pal, rng, f, e: tete_chibi(p, pal, rng, f, e),
    "bust": lambda p, pal, rng, f, e: buste(p, pal, rng, f),
}


def peindre(cube: Cube, img, glow, pal, etat, rng):
    peintre = PEINTRES[cube.mat]
    for face, (x0, y0, w, h) in regions(cube).items():
        if w > 0 and h > 0:
            peintre(Pinceau(img, glow, x0, y0, w, h), pal, rng, face, etat)
    if cube.mat == "chest":
        # Le buste : deux filets en V qui convergent vers la gemme du sternum.
        x0, y0, w, h = regions(cube)["north"]
        p = Pinceau(img, glow, x0, y0, w, h)
        for k in range(5):
            p.px(1 + k, 3 + k, pal["glow"][1], lum=True)
            p.px(w - 2 - k, 3 + k, pal["glow"][1], lum=True)


# --------------------------------------------------------------------- UV et image


def ranger(bones: list[Bone], largeur: int = 256) -> tuple[int, int]:
    """Range les régions UV de chaque cube en étagères ; renvoie la taille de texture."""
    cubes = [c for b in bones for c in b.cubes]
    ordre = sorted(cubes, key=lambda c: (c.size[2] + c.size[1], 2 * (c.size[2] + c.size[0])), reverse=True)
    x = y = haut = 0
    for c in ordre:
        w = 2 * (c.size[2] + c.size[0])
        h = c.size[2] + c.size[1]
        if x + w > largeur:
            x, y, haut = 0, y + haut, 0
        c.uv = (x, y)
        x += w
        haut = max(haut, h)
    total = y + haut
    hauteur = 64
    while hauteur < total:
        hauteur *= 2
    return largeur, hauteur


def textures(bones, tw, th, etat):
    img = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
    glow = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
    rng = random.Random(0x0DE5 + (7 if etat == "corrompue" else 0))
    for b in bones:
        for c in b.cubes:
            peindre(c, img, glow, PALETTES[etat], etat, rng)
    return img, glow


# --------------------------------------------------------------------- animations


def cles(points: dict[float, list[float]], lisse=True):
    """Images clés au format Bedrock ; lissage catmull-rom par défaut."""
    sortie = {}
    for t, v in sorted(points.items()):
        cle = f"{t:.4g}" if t % 1 else f"{t:.1f}"
        sortie[cle] = {"post": v, "lerp_mode": "catmullrom"} if lisse else v
    return sortie


def boucle(a, b, duree=6.0):
    """Aller-retour lissé entre deux poses, sur la durée de la boucle."""
    return cles({0: a, duree / 2: b, duree: a})


def animations():
    # Doigts au repos : légèrement repliés, chacun un peu différemment.
    def mains_repos(courbure=1.0):
        os_ = {}
        for cote, s in (("left", 1), ("right", -1)):
            for k in range(4):
                a = (14 + 4 * k) * courbure
                os_[f"finger_{cote}_{k}"] = {"rotation": cles({0: [0, 0, a * s], 6: [0, 0, a * s]})}
                os_[f"finger_{cote}_{k}_tip"] = {"rotation": cles({0: [0, 0, (18 + 3 * k) * courbure * s], 6: [0, 0, (18 + 3 * k) * courbure * s]})}
            os_[f"thumb_{cote}"] = {"rotation": cles({0: [0, 0, 10 * s], 6: [0, 0, 10 * s]})}
        return os_

    # --- Repos (jeu) : une lenteur de colosse. Elle flotte, sa jupe ondule,
    # ses ailerons respirent, ses deux halos tournent en sens contraires.
    idle = {
        "loop": True,
        "animation_length": 6.0,
        "bones": {
            **mains_repos(),
            "xenodys": {"position": boucle([0, 0, 0], [0, 2.5, 0])},
            "chest": {"rotation": boucle([0, 0, 0], [-2, 0, 0])},
            "head": {"rotation": cles({0: [0, 0, 0], 2: [4, 8, 0], 4: [-2, -6, 0], 6: [0, 0, 0]})},
            "halo": {"rotation": cles({0: [0, 0, 0], 6: [0, 0, -30]}, lisse=False)},
            "halo_inner": {"rotation": cles({0: [0, 0, 0], 6: [0, 0, 45]}, lisse=False)},
            "wing_left": {"rotation": boucle([0, 0, 0], [0, -6, -5])},
            "wing_right": {"rotation": boucle([0, 0, 0], [0, 6, 5])},
            "arm_left": {"rotation": boucle([0, 0, 0], [-4, 0, -4])},
            "arm_right": {"rotation": boucle([0, 0, 0], [-4, 0, 4])},
            "skirt_left": {"rotation": boucle([0, 0, 0], [0, 0, -4])},
            "skirt_right": {"rotation": boucle([0, 0, 0], [0, 0, 4])},
            "skirt_front": {"rotation": boucle([0, 0, 0], [-3, 0, 0])},
            "spire": {"rotation": boucle([0, 0, 0], [4, 0, 0])},
            "cable_0": {"rotation": boucle([0, 0, 0], [6, 0, -3])},
            "cable_1": {"rotation": boucle([2, 0, 0], [7, 0, 0])},
            "cable_2": {"rotation": boucle([0, 0, 0], [8, 0, 0])},
            "cable_3": {"rotation": boucle([3, 0, 0], [5, 0, 3])},
        },
    }

    # --- Le regard (jeu) : elle tourne la tête, ouvre ses ailerons, tend la
    # main, doigts ouverts. Pas un salut amical : une reconnaissance.
    greet = {
        "loop": False,
        "animation_length": 4.0,
        "bones": {
            "head": {"rotation": cles({0: [0, 0, 0], 0.8: [8, 22, 0], 3.2: [8, 22, 0], 4.0: [0, 0, 0]})},
            "wing_left": {"rotation": cles({0: [0, 0, 0], 0.8: [0, 10, -14], 3.2: [0, 10, -14], 4.0: [0, 0, 0]})},
            "wing_right": {"rotation": cles({0: [0, 0, 0], 0.8: [0, -10, 14], 3.2: [0, -10, 14], 4.0: [0, 0, 0]})},
            "arm_left": {"rotation": cles({0: [0, 0, 0], 1.0: [-40, 0, -30], 3.0: [-40, 0, -30], 4.0: [0, 0, 0]})},
            "forearm_left": {"rotation": cles({0: [0, 0, 0], 1.0: [-30, 0, 0], 3.0: [-30, 0, 0], 4.0: [0, 0, 0]})},
            **{f"finger_left_{k}": {"rotation": cles({0: [0, 0, 0], 1.0: [0, 0, -14 - 4 * k], 3.0: [0, 0, -14 - 4 * k], 4.0: [0, 0, 0]})} for k in range(4)},
            "halo": {"rotation": cles({0: [0, 0, 0], 1.0: [0, 0, -60], 4.0: [0, 0, -90]})},
        },
    }

    # --- Corrompue (jeu) : immobile… puis des sursauts, comme si quelqu'un
    # tirait les fils.
    def secousses(base, a, b, duree=4.0):
        return {0: base, a: base, a + 0.05: b, a + 0.22: b, a + 0.27: base, duree: base}

    corrupted = {
        "loop": True,
        "animation_length": 4.0,
        "bones": {
            **mains_repos(1.8),
            "xenodys": {"position": boucle([0, 0, 0], [0, 1.2, 0], 4.0)},
            "head": {"rotation": cles(secousses([6, 0, 0], 1.1, [14, -30, 10]), lisse=False)},
            "chest": {"rotation": cles(secousses([4, 0, 0], 2.7, [-6, 14, -5]), lisse=False)},
            "arm_left": {"rotation": cles(secousses([6, 0, 10], 2.7, [-35, 0, -20]), lisse=False)},
            "arm_right": {"rotation": cles(secousses([6, 0, -10], 1.1, [-20, 0, 40]), lisse=False)},
            "wing_left": {"rotation": cles({0: [0, 0, 18], 2: [0, 8, 24], 4: [0, 0, 18]})},
            "wing_right": {"rotation": cles({0: [0, 0, -18], 2: [0, -8, -24], 4: [0, 0, -18]})},
            "halo": {"rotation": cles({0: [0, 0, 0], 0.6: [10, 0, 50], 1.6: [-8, 0, 40], 1.7: [0, 0, 160], 4: [0, 0, 200]}, lisse=False)},
            "halo_inner": {"rotation": cles({0: [0, 0, 0], 1.1: [0, 0, -90], 1.15: [0, 0, 30], 4: [0, 0, -40]}, lisse=False)},
            "skirt_left": {"rotation": boucle([0, 0, -6], [0, 0, -10], 4.0)},
            "skirt_right": {"rotation": boucle([0, 0, 6], [0, 0, 10], 4.0)},
            "cable_1": {"rotation": cles(secousses([4, 0, 0], 2.7, [20, 0, 12]), lisse=False)},
            "cable_2": {"rotation": cles(secousses([4, 0, 0], 1.1, [18, 0, -14]), lisse=False)},
        },
    }

    # --- Le penché (launcher) : elle se tient derrière le launcher, à droite,
    # le bas du corps caché. Sa main gauche agrippe le bord droit du cadre,
    # sa main droite, bras levé, agrippe la bordure du haut ; elle penche le
    # buste et regarde le joueur. Ni le corps ni les bras ne bougent : les
    # mains tiennent. Seuls la tête, les cheveux, le halo, les ailerons vivent.
    def penche(corrompue=False):
        os_ = mains_repos(1.0)
        for cote, s in (("left", 1), ("right", -1)):
            for k in range(4):
                os_[f"finger_{cote}_{k}"] = {"rotation": cles({0: [0, 0, (80 + 3 * k) * s], 6: [0, 0, (80 + 3 * k) * s]})}
                os_[f"finger_{cote}_{k}_tip"] = {"rotation": cles({0: [0, 0, (55 + 4 * k) * s], 6: [0, 0, (55 + 4 * k) * s]})}
            os_[f"thumb_{cote}"] = {"rotation": cles({0: [0, 0, 40 * s], 6: [0, 0, 40 * s]})}
        os_.update({
            # Le corps ne bouge pas : ses mains tiennent le launcher.
            "body": {"rotation": cles({0: [-6, 0, 8], 6: [-6, 0, 8]})},
            "chest": {"rotation": cles({0: [4, 0, 4], 6: [4, 0, 4]})},
            "neck": {"rotation": cles({0: [4, 0, 0], 6: [4, 0, 0]})},
            "head": {"rotation": cles({0: [10, -26, 6], 3: [8, -22, 4], 6: [10, -26, 6]})},
            "arm_left": {"rotation": cles({0: [-70, 0, -18], 6: [-70, 0, -18]})},
            "forearm_left": {"rotation": cles({0: [-10, 0, 0], 6: [-10, 0, 0]})},
            "hand_left": {"rotation": cles({0: [0, -180, 10], 6: [0, -180, 10]})},
            "arm_right": {"rotation": cles({0: [-160, 0, 15], 6: [-160, 0, 15]})},
            "forearm_right": {"rotation": cles({0: [-15, 0, 0], 6: [-15, 0, 0]})},
            "hand_right": {"rotation": cles({0: [0, 180, -10], 6: [0, 180, -10]})},
            "wing_left": {"rotation": boucle([0, -34, 4], [0, -30, 0])},
            "wing_right": {"rotation": boucle([0, 34, -4], [0, 30, 0])},
            "halo": {"rotation": cles({0: [0, 0, 0], 6: [0, 0, -30]}, lisse=False)},
            "halo_inner": {"rotation": cles({0: [0, 0, 0], 6: [0, 0, 45]}, lisse=False)},
            "cable_0": {"rotation": boucle([4, 0, 6], [8, 0, 8])},
            "cable_1": {"rotation": boucle([4, 0, 6], [9, 0, 7])},
            "cable_2": {"rotation": boucle([4, 0, 6], [7, 0, 8])},
            "cable_3": {"rotation": boucle([4, 0, 6], [6, 0, 9])},
        })
        if corrompue:
            # Le regard se fige, puis la tête se tord ; le halo s'affole.
            os_["head"] = {"rotation": cles({0: [14, -30, 8], 1.6: [14, -30, 8], 1.65: [24, -8, 22], 1.9: [24, -8, 22], 1.95: [14, -30, 8], 4.1: [14, -30, 8], 4.15: [6, -38, -6], 4.3: [6, -38, -6], 4.35: [14, -30, 8], 6: [14, -30, 8]}, lisse=False)}
            os_["halo"] = {"rotation": cles({0: [0, 0, 0], 0.6: [10, 0, 50], 1.6: [-8, 0, 40], 1.7: [0, 0, 160], 6: [0, 0, 200]}, lisse=False)}
            os_["wing_left"] = {"rotation": boucle([0, -20, 18], [0, -12, 24])}
            os_["wing_right"] = {"rotation": boucle([0, 20, -18], [0, 12, -24])}
        return {"loop": True, "animation_length": 6.0, "bones": os_}

    return {
        "format_version": "1.8.0",
        "animations": {
            "animation.xenodys.idle": idle,
            "animation.xenodys.greet": greet,
            "animation.xenodys.corrupted_idle": corrupted,
            "animation.xenodys.lean": penche(),
            "animation.xenodys.corrupted_lean": penche(corrompue=True),
        },
    }


def animations_assistant():
    idle = {
        "loop": True,
        "animation_length": 2.0,
        "bones": {
            "assistant": {"position": boucle([0, 0, 0], [0, 0.4, 0], 2.0)},
            "head": {"rotation": cles({0: [0, 0, -5], 1: [0, 0, 5], 2: [0, 0, -5]})},
            "arm_left": {"rotation": boucle([0, 0, 0], [-8, 0, 0], 2.0)},
            "arm_right": {"rotation": boucle([-8, 0, 0], [0, 0, 0], 2.0)},
            "halo": {"rotation": cles({0: [0, 0, 0], 2: [0, 90, 0]}, lisse=False)},
        },
    }
    # Il se cache, se penche pour regarder, se cache de nouveau.
    peek = {
        "loop": True,
        "animation_length": 6.0,
        "bones": {
            "assistant": {
                "position": cles({0: [0, 0, 0], 0.8: [0, 0, 0], 1.4: [-5, 0, 0], 3.8: [-5, 0, 0], 4.4: [0, 0, 0], 6: [0, 0, 0]}),
                "rotation": cles({0: [0, 0, 0], 0.8: [0, 0, 0], 1.4: [0, 0, 16], 3.8: [0, 0, 16], 4.4: [0, 0, 0], 6: [0, 0, 0]}),
            },
            "head": {"rotation": cles({0: [0, 0, 0], 1.4: [0, 0, 0], 2.0: [0, 0, -14], 2.8: [0, 20, -10], 3.6: [0, 0, -14], 4.4: [0, 0, 0], 6: [0, 0, 0]})},
            "arm_left": {"rotation": cles({0: [0, 0, 0], 1.4: [-60, 0, 0], 3.8: [-60, 0, 0], 4.4: [0, 0, 0], 6: [0, 0, 0]})},
            "halo": {"rotation": cles({0: [0, 0, 0], 6: [0, 270, 0]}, lisse=False)},
        },
    }
    wave = {
        "loop": False,
        "animation_length": 2.4,
        "bones": {
            "arm_right": {"rotation": cles({0: [0, 0, 0], 0.3: [0, 0, 150], 0.6: [0, 0, 120], 0.9: [0, 0, 150], 1.2: [0, 0, 120], 1.5: [0, 0, 150], 2.0: [0, 0, 150], 2.4: [0, 0, 0]})},
            "head": {"rotation": cles({0: [0, 0, 0], 0.4: [0, 0, 10], 2.0: [0, 0, 10], 2.4: [0, 0, 0]})},
        },
    }
    return {
        "format_version": "1.8.0",
        "animations": {
            "animation.xenodys_assistant.idle": idle,
            "animation.xenodys_assistant.peek": peek,
            "animation.xenodys_assistant.wave": wave,
        },
    }


# --------------------------------------------------------------------- écriture


def geo(bones, tw, th, identifiant="geometry.xenodys"):
    sortie = []
    for b in bones:
        entree = {"name": b.name}
        if b.parent:
            entree["parent"] = b.parent
        entree["pivot"] = list(b.pivot)
        if b.rotation:
            entree["rotation"] = list(b.rotation)
        if b.cubes:
            entree["cubes"] = []
            for c in b.cubes:
                cube = {"origin": list(c.origin), "size": list(c.size), "uv": list(c.uv)}
                if c.rotation:
                    cube["pivot"] = list(c.pivot)
                    cube["rotation"] = list(c.rotation)
                entree["cubes"].append(cube)
        sortie.append(entree)
    return {
        "format_version": "1.12.0",
        "minecraft:geometry": [
            {
                "description": {
                    "identifier": identifiant,
                    "texture_width": tw,
                    "texture_height": th,
                    "visible_bounds_width": 4,
                    "visible_bounds_height": 4,
                    "visible_bounds_offset": [0, 1.5, 0],
                },
                "bones": sortie,
            }
        ],
    }


def ecrire(nom, bones, anims, identifiant, largeur):
    tw, th = ranger(bones, largeur)
    geometrie = geo(bones, tw, th, identifiant)
    for dossier in ("geo", "animations", "textures"):
        (SORTIE_GECKO / dossier).mkdir(parents=True, exist_ok=True)
    SORTIE_LAUNCHER_PNG.mkdir(parents=True, exist_ok=True)
    (SORTIE_GECKO / "geo" / f"{nom}.geo.json").write_text(json.dumps(geometrie, indent=2) + "\n")
    (SORTIE_GECKO / "animations" / f"{nom}.animation.json").write_text(json.dumps(anims, indent=2) + "\n")
    for etat in ("creatrice", "corrompue"):
        img, glow = textures(bones, tw, th, etat)
        for cible in (SORTIE_GECKO / "textures", SORTIE_LAUNCHER_PNG):
            img.save(cible / f"{nom}_{etat}.png")
            glow.save(cible / f"{nom}_{etat}_glowmask.png")
    nb = sum(len(b.cubes) for b in bones)
    print(f"{nom} : {len(bones)} os, {nb} cubes, texture {tw} × {th}.")
    return geometrie


def main():
    geo_x = ecrire("xenodys", modele(), animations(), "geometry.xenodys", 256)
    geo_a = ecrire("xenodys_assistant", modele_assistant(), animations_assistant(), "geometry.xenodys_assistant", 64)
    SORTIE_LAUNCHER_JS.parent.mkdir(parents=True, exist_ok=True)
    module = (
        "/**\n"
        " * Xenodys en cubes — FICHIER GÉNÉRÉ par xenodys/generer.py, ne pas modifier à la main.\n"
        " *\n"
        " * La même géométrie et les mêmes animations que xenodys/geckolib/ (GeckoLib, le jeu),\n"
        " * en module ES : le launcher ne peut pas lire un fichier local avec fetch().\n"
        " */\n\n"
        f"export const GEO = {json.dumps(geo_x, separators=(',', ':'))};\n\n"
        f"export const ANIMATIONS = {json.dumps(animations(), separators=(',', ':'))};\n\n"
        f"export const ASSISTANT_GEO = {json.dumps(geo_a, separators=(',', ':'))};\n\n"
        f"export const ASSISTANT_ANIMATIONS = {json.dumps(animations_assistant(), separators=(',', ':'))};\n"
    )
    SORTIE_LAUNCHER_JS.write_text(module)


if __name__ == "__main__":
    main()
