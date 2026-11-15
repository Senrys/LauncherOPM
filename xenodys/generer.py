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
    # Éperons à la cheville de la flèche.
    for s in (1, -1):
        fleche.cubes.append(centre(5 * s, 17, 0, 6, 1, 1, "trim", (2 * s, 17.5, 0), (0, 0, 10 * s)))
    fleche.cubes.append(centre(0, 17, -4, 1, 1, 6, "trim"))

    # --------------------------------------------------------------------- bassin
    corps = bone("body", "xenodys", (0, 62, 0))
    corps.cubes += [
        centre(0, 56, 0, 18, 6, 12, "plate"),
        centre(0, 55, 0, 19, 1, 13, "trim"),
        centre(0, 62, 0, 8, 6, 6, "joint"),
    ]

    # ------------------------------------------------- la jupe d'armure (s'évase)
    devant = bone("skirt_front", "body", (0, 56, -6))
    devant.cubes += [
        centre(0, 30, -6.5, 10, 26, 2, "plate", (0, 56, -6), (-6, 0, 0)),
        centre(0, 34, -7.8, 2, 20, 1, "gem", (0, 56, -6), (-6, 0, 0)),
    ]
    for s in (1, -1):
        devant.cubes.append(centre(9 * s, 32, -5.5, 8, 24, 2, "plate", (5 * s, 56, -6), (-4, 18 * s, -10 * s)))
    dos = bone("skirt_back", "body", (0, 56, 6))
    dos.cubes.append(centre(0, 28, 6.5, 16, 28, 2, "drape", (0, 56, 6), (8, 0, 0)))
    for cote, s in (("left", 1), ("right", -1)):
        pan = bone(f"skirt_{cote}", "body", (9 * s, 56, 0))
        for k, (h, flare) in enumerate(((28, 22), (32, 32), (26, 44))):
            pan.cubes.append(centre((10 + k * 1.5) * s, 56 - h, (k - 1) * 3, 3, h, 10, "drape", (9 * s, 56, 0), (0, 0, -flare * s)))
        pan.cubes.append(centre(11 * s, 52, 0, 3, 4, 12, "trim", (9 * s, 56, 0), (0, 0, -22 * s)))

    # ------------------------------------------------------------------- buste
    buste = bone("chest", "body", (0, 68, 0))
    buste.cubes += [
        centre(0, 68, 0, 14, 12, 8, "chest"),
        centre(-3.5, 72, -4.5, 6, 5, 2, "plate", (-3.5, 74.5, -4), (0, 12, 0)),
        centre(3.5, 72, -4.5, 6, 5, 2, "plate", (3.5, 74.5, -4), (0, -12, 0)),
        centre(0, 79, 0, 12, 2, 9, "trim"),
        centre(0, 69, -4.5, 2, 3, 1, "gem"),
        centre(0, 64, -3.5, 2, 3, 1, "gem"),
    ]
    for cote, s in (("left", 1), ("right", -1)):
        epaule = bone(f"pauldron_{cote}", "chest", (8 * s, 78, 0))
        epaule.cubes += [
            centre(11 * s, 74, 0, 8, 7, 9, "plate", (8 * s, 78, 0), (0, 0, -14 * s)),
            centre(11 * s, 80, 0, 6, 2, 7, "trim", (8 * s, 78, 0), (0, 0, -14 * s)),
            centre(15.5 * s, 74, 0, 2, 6, 6, "disc"),
        ]

    # ------------------------------------------------------------------- tête
    cou = bone("neck", "chest", (0, 80, 0))
    cou.cubes.append(centre(0, 80, 0, 4, 4, 4, "joint"))
    tete = bone("head", "neck", (0, 84, 0))
    tete.cubes += [
        centre(0, 84, 0, 10, 12, 10, "head"),
        # Calotte de cheveux, mèches qui encadrent le visage.
        centre(0, 94, 0.5, 11, 3, 11, "hairtop"),
        centre(5.5, 84, 0.5, 1, 11, 9, "hair"),
        centre(-5.5, 84, 0.5, 1, 11, 9, "hair"),
        # Diadème : un bandeau de bronze au front, une gemme, une crête de cristal.
        centre(0, 93, -0.3, 11, 1, 11, "trim"),
        centre(0, 92.5, -5.6, 2, 2, 1, "gem"),
        centre(0, 95, -4.5, 1, 7, 1, "crest", (0, 95, -4.5), (-12, 0, 0)),
    ]
    for s in (1, -1):
        # Cornes-lames, balayées vers l'arrière et vers le haut.
        tete.cubes.append(centre(11 * s, 94, 2, 12, 2, 2, "blade", (5 * s, 95, 2), (0, -28 * s, -22 * s)))
        tete.cubes.append(centre(8 * s, 91, 3, 7, 1, 2, "trim", (5 * s, 92, 3), (0, -30 * s, -10 * s)))
    # La chevelure : de longues mèches qui tombent dans le dos.
    for k, x in enumerate((-4, -1.5, 1.5, 4)):
        meche = bone(f"cable_{k}", "head", (x, 92, 5))
        meche.cubes.append(centre(x, 58 - k % 2 * 5, 5.5, 3, 34 + k % 2 * 5, 2, "hairback"))

    # -------------------------------------------------------------------- halo
    halo = bone("halo", "head", (0, 92, 9))
    for k in range(24):
        a = k * math.pi / 12
        x, y = 15 * math.cos(a), 92 + 15 * math.sin(a)
        halo.cubes.append(centre(round(x, 2), round(y - 1.5, 2), 9, 3, 3, 1, "trim" if k % 2 else "glow"))
    interieur = bone("halo_inner", "head", (0, 92, 10))
    for k in range(16):
        a = k * math.pi / 8
        x, y = 11 * math.cos(a), 92 + 11 * math.sin(a)
        interieur.cubes.append(centre(round(x, 2), round(y - 1, 2), 10, 2, 2, 1, "glow"))

    # ------------------------------------------------------------------- bras
    for cote, s in (("left", 1), ("right", -1)):
        bras = bone(f"arm_{cote}", "chest", (15 * s, 77, 0), (0, 0, -24 * s))
        bras.cubes += [centre(15 * s, 63, 0, 4, 14, 4, "plate"), centre(15 * s, 69, 0, 6, 2, 6, "glowring")]
        avant = bone(f"forearm_{cote}", f"arm_{cote}", (15 * s, 63, 0), (-20, 0, 0))
        avant.cubes += [
            centre(15 * s, 49, 0, 4, 14, 4, "plate"),
            centre(15 * s, 53, 0, 6, 2, 6, "glowring"),
            centre(15 * s, 47, 0, 3, 2, 3, "joint"),
        ]
        # La main : une paume fine, quatre doigts de deux phalanges, un pouce.
        main = bone(f"hand_{cote}", f"forearm_{cote}", (15 * s, 47, 0))
        main.cubes.append(centre(15 * s, 42, 0, 2, 5, 4, "palm"))
        for k, (a, b) in enumerate(((3, 2), (3, 3), (3, 2), (2, 2))):
            z = -1.5 + k
            doigt = bone(f"finger_{cote}_{k}", f"hand_{cote}", (15 * s, 42, z))
            doigt.cubes.append(centre(15 * s, 42 - a, z, 1, a, 1, "finger"))
            bout = bone(f"finger_{cote}_{k}_tip", f"finger_{cote}_{k}", (15 * s, 42 - a, z))
            bout.cubes.append(centre(15 * s, 42 - a - b, z, 1, b, 1, "fingertip"))
        pouce = bone(f"thumb_{cote}", f"hand_{cote}", (15 * s, 45, -2), (-30, 0, 0))
        pouce.cubes.append(centre(15 * s, 42, -2.5, 1, 3, 1, "finger"))
        bout = bone(f"thumb_{cote}_tip", f"thumb_{cote}", (15 * s, 42, -2.5))
        bout.cubes.append(centre(15 * s, 40, -2.5, 1, 2, 1, "fingertip"))

    # ---------------------------------------------- ailerons, depuis le dos
    for cote, s in (("left", 1), ("right", -1)):
        aile = bone(f"wing_{cote}", "chest", (5 * s, 76, 5), (0, -18 * s, 0))
        for k, (tilt, longueur, y) in enumerate(((28, 26, 78), (8, 30, 74), (-14, 24, 70))):
            aile.cubes.append(
                Cube((5 * s if s > 0 else 5 * s - longueur, y, 5), (longueur, 4, 2), "fin", (5 * s, y + 2, 6), (0, 0, -tilt * s))
            )

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
        "eye": ["#FFFFFF", "#5FF5E6", "#B8FFF8"],
        "lips": ["#D79AA8", "#B97888"],
        "blush": "#F0CFCF",
        "lash": "#4A5568",
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
        "eye": ["#2A0A18", "#FF2E55", "#FFB3C2"],
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
    """Face nord de la tête (10 × 12) : un visage de porcelaine, fin, sous un
    diadème. Sourcils, cils, iris lumineux, une rougeur, des lèvres ; la
    jointure de la mâchoire rappelle qu'elle est une machine."""
    s, e = pal["skin"], pal["eye"]
    motif = [
        "HHHHHHHHHH",
        "HHhHHHHhHH",
        "HhSSSSSShH",
        "HbbbSSbbbH",
        "HSSSSSSSSH",
        "HLLLSSLLLH",
        "HWEISSIEWH",
        "HSsSSSSsSH",
        "HSSSSnSSSH",
        "HSrSSSSrSH",
        "HSSlmmlSSH",
        "JhSSSSSShJ",
    ]
    couleurs = {
        "H": pal["hair"][1], "h": pal["hair"][2], "S": s[0], "s": s[1], "n": s[1],
        "b": pal["hair"][3], "L": pal["lash"], "W": e[0], "r": pal["blush"],
        "l": pal["lips"][0], "m": pal["lips"][1], "J": pal["joint"][1],
    }
    for y, rangee in enumerate(motif):
        for x, ch in enumerate(rangee):
            if ch == "E":
                p.px(x, y, e[1], lum=True)
            elif ch == "I":
                p.px(x, y, e[2], lum=True)
            else:
                p.px(x, y, couleurs[ch])
    if etat == "corrompue":
        # Une fissure part de l'œil gauche et descend sur la joue ; l'œil coule.
        for x, y in ((7, 7), (7, 8), (8, 9), (7, 10), (7, 11)):
            p.px(x, y, pal["crack"][0], lum=True)
        p.px(2, 7, pal["crack"][1], lum=True)


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

    # --- Le penché (launcher) : elle se tient derrière le launcher, se penche
    # vers lui, regarde le joueur, et sa main droite agrippe le bord du cadre —
    # bras tendu, doigts repliés par-dessus l'arête.
    def penche(corrompue=False):
        os_ = mains_repos(1.0)
        # La main qui agrippe : doigts fortement repliés vers la paume.
        for k in range(4):
            os_[f"finger_right_{k}"] = {"rotation": cles({0: [0, 0, -(80 + 3 * k)], 6: [0, 0, -(80 + 3 * k)]})}
            os_[f"finger_right_{k}_tip"] = {"rotation": cles({0: [0, 0, -(55 + 4 * k)], 6: [0, 0, -(55 + 4 * k)]})}
        os_["thumb_right"] = {"rotation": cles({0: [0, 0, -40], 6: [0, 0, -40]})}
        os_.update({
            "xenodys": {"position": boucle([0, 0, 0], [0, 1.2, 0])},
            "body": {"rotation": boucle([8, 0, -10], [9, 0, -11])},
            "chest": {"rotation": boucle([6, 0, -6], [4, 0, -7])},
            "neck": {"rotation": cles({0: [6, 0, -4], 6: [6, 0, -4]})},
            "head": {"rotation": cles({0: [12, -28, 8], 3: [10, -24, 6], 6: [12, -28, 8]})},
            # Le bras vient de derrière vers l'avant, par-dessus l'arête du cadre ;
            # la main pivote, paume vers l'extérieur, et les doigts se replient
            # sur la face avant du launcher.
            "arm_right": {"rotation": cles({0: [-78, 0, 12], 3: [-77, 0, 11], 6: [-78, 0, 12]})},
            "forearm_right": {"rotation": cles({0: [16, 0, 0], 6: [16, 0, 0]})},
            "hand_right": {"rotation": cles({0: [0, 180, -10], 6: [0, 180, -10]})},
            "arm_left": {"rotation": boucle([10, 0, -4], [6, 0, -6])},
            "forearm_left": {"rotation": boucle([-10, 0, 0], [-18, 0, 0])},
            # Ailerons repliés vers l'arrière : elle se tient tout près du cadre.
            "wing_left": {"rotation": boucle([0, -34, 4], [0, -30, 0])},
            "wing_right": {"rotation": boucle([0, 34, -4], [0, 30, 0])},
            "halo": {"rotation": cles({0: [0, 0, 0], 6: [0, 0, -30]}, lisse=False)},
            "halo_inner": {"rotation": cles({0: [0, 0, 0], 6: [0, 0, 45]}, lisse=False)},
            "spire": {"rotation": boucle([-6, 0, 8], [-4, 0, 9])},
            "skirt_left": {"rotation": boucle([0, 0, 0], [0, 0, -4])},
            "skirt_right": {"rotation": boucle([0, 0, 4], [0, 0, 7])},
            "cable_0": {"rotation": boucle([4, 0, 6], [8, 0, 8])},
            "cable_1": {"rotation": boucle([4, 0, 6], [9, 0, 7])},
            "cable_2": {"rotation": boucle([4, 0, 6], [7, 0, 8])},
            "cable_3": {"rotation": boucle([4, 0, 6], [6, 0, 9])},
        })
        if corrompue:
            # Le regard se fige, puis la tête se tord ; la main se crispe.
            os_["head"] = {"rotation": cles({0: [16, -32, 10], 1.6: [16, -32, 10], 1.65: [26, -10, 24], 1.9: [26, -10, 24], 1.95: [16, -32, 10], 4.1: [16, -32, 10], 4.15: [8, -40, -6], 4.3: [8, -40, -6], 4.35: [16, -32, 10], 6: [16, -32, 10]}, lisse=False)}
            os_["arm_left"] = {"rotation": cles({0: [10, 0, -4], 3.0: [10, 0, -4], 3.05: [-30, 0, -26], 3.3: [-30, 0, -26], 3.35: [10, 0, -4], 6: [10, 0, -4]}, lisse=False)}
            os_["halo"] = {"rotation": cles({0: [0, 0, 0], 0.6: [10, 0, 50], 1.6: [-8, 0, 40], 1.7: [0, 0, 160], 6: [0, 0, 200]}, lisse=False)}
            os_["wing_left"] = {"rotation": boucle([0, 0, 18], [0, 8, 24])}
            os_["wing_right"] = {"rotation": boucle([0, 0, -18], [0, -8, -24])}
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


# --------------------------------------------------------------------- écriture


def geo(bones, tw, th):
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
                    "identifier": "geometry.xenodys",
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


def main():
    bones = modele()
    tw, th = ranger(bones)
    geometrie = geo(bones, tw, th)
    anims = animations()

    for dossier in ("geo", "animations", "textures"):
        (SORTIE_GECKO / dossier).mkdir(parents=True, exist_ok=True)
    SORTIE_LAUNCHER_PNG.mkdir(parents=True, exist_ok=True)
    SORTIE_LAUNCHER_JS.parent.mkdir(parents=True, exist_ok=True)

    (SORTIE_GECKO / "geo" / "xenodys.geo.json").write_text(json.dumps(geometrie, indent=2) + "\n")
    (SORTIE_GECKO / "animations" / "xenodys.animation.json").write_text(json.dumps(anims, indent=2) + "\n")

    for etat in ("creatrice", "corrompue"):
        img, glow = textures(bones, tw, th, etat)
        for cible in (SORTIE_GECKO / "textures", SORTIE_LAUNCHER_PNG):
            img.save(cible / f"xenodys_{etat}.png")
            glow.save(cible / f"xenodys_{etat}_glowmask.png")

    module = (
        "/**\n"
        " * Xenodys en cubes — FICHIER GÉNÉRÉ par xenodys/generer.py, ne pas modifier à la main.\n"
        " *\n"
        " * La même géométrie et les mêmes animations que xenodys/geckolib/ (GeckoLib, le jeu),\n"
        " * en module ES : le launcher ne peut pas lire un fichier local avec fetch().\n"
        " */\n\n"
        f"export const GEO = {json.dumps(geometrie, separators=(',', ':'))};\n\n"
        f"export const ANIMATIONS = {json.dumps(anims, separators=(',', ':'))};\n"
    )
    SORTIE_LAUNCHER_JS.write_text(module)
    nb = sum(len(b.cubes) for b in bones)
    print(f"Xenodys : {len(bones)} os, {nb} cubes, texture {tw} × {th}.")


if __name__ == "__main__":
    main()
