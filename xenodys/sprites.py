#!/usr/bin/env python3
"""Planches de sprites de Xenodys et de ses assistants, en pixel art.

Le launcher (scène de chargement) et le mod OPM du jeu (écran de chargement,
envol, écran titre) dessinent les MÊMES images : c'est ce qui rend le passage
d'une fenêtre à l'autre invisible. Elles sont rendues ici, à partir du modèle
GeckoLib produit par ``generer.py`` (géométrie, animations, textures) :

    python3 xenodys/sprites.py

Le rendu est un petit rastériseur orthographique (tampon de profondeur, UV
« box », textures filtrées au plus proche, glowmask en pleine lumière), fidèle
à ``launcher/src/assets/js/components/xenodys3d.js`` : même repère, mêmes
conventions de rotation, mêmes animations. Deux pixels de sprite par unité du
modèle — un texel fait 2 × 2 pixels, le grain cubique de Minecraft.

Sorties (créatrice et corrompue pour chaque planche) :

* ``mod/src/main/resources/assets/opm/textures/gui/sprites/*.png`` ;
* ``launcher/src/assets/sprites/*.png`` ;
* ``sprites.json`` à côté : taille des cases, nombre d'images, origine, points
  d'accroche (les mains de l'écran titre).
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
DEG = math.pi / 180

# Lumière : d'en haut, un peu de face et de gauche, comme dans le launcher.
LUMIERE = np.array([-0.35, 0.85, 0.55])
LUMIERE /= np.linalg.norm(LUMIERE)


# --------------------------------------------------------------------------- #
# Modèle
# --------------------------------------------------------------------------- #


def rot(rx: float, ry: float, rz: float) -> np.ndarray:
    """Matrice d'Euler en ordre « ZYX » de Three.js : Rz · Ry · Rx."""
    cx, sx = math.cos(rx), math.sin(rx)
    cy, sy = math.cos(ry), math.sin(ry)
    cz, sz = math.cos(rz), math.sin(rz)
    mx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    my = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    mz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return mz @ my @ mx


def affine(r: np.ndarray, t) -> np.ndarray:
    m = np.eye(4)
    m[:3, :3] = r
    m[:3, 3] = t
    return m


def translation(t) -> np.ndarray:
    return affine(np.eye(3), t)


class Modele:
    """Géométrie Bedrock et animations d'un modèle GeckoLib."""

    def __init__(self, nom: str, prefixe: str, geo: dict | None = None, textures: dict | None = None) -> None:
        if geo is None:
            geo = json.loads((GECKO / "geo" / f"{nom}.geo.json").read_text())["minecraft:geometry"][0]
        self.tw = geo["description"]["texture_width"]
        self.th = geo["description"]["texture_height"]
        self.os = {}
        self.ordre = []
        for d in geo["bones"]:
            pivot = np.array([-d["pivot"][0], d["pivot"][1], d["pivot"][2]], float)
            parent = d.get("parent")
            base = self.os[parent]["pivot"] if parent else np.zeros(3)
            r = d.get("rotation", [0, 0, 0])
            self.os[d["name"]] = {
                "parent": parent,
                "pivot": pivot,
                "position": pivot - base,
                "rotation": np.array([-r[0] * DEG, -r[1] * DEG, r[2] * DEG]),
                "cubes": d.get("cubes", []),
            }
            self.ordre.append(d["name"])
        fichier = GECKO / "animations" / f"{nom}.animation.json"
        anim = json.loads(fichier.read_text()) if fichier.exists() else {"animations": {}}
        self.anims = {
            k.removeprefix(prefixe + "."): self._compiler(v) for k, v in anim["animations"].items()
        }
        self.textures = dict(textures or {})
        for etat in ETATS:
            for suffixe in ("", "_blink"):
                f = GECKO / "textures" / f"{nom}_{etat}{suffixe}.png"
                g = GECKO / "textures" / f"{nom}_{etat}{suffixe}_glowmask.png"
                if f.exists():
                    self.textures[etat + suffixe] = (
                        np.asarray(Image.open(f).convert("RGBA"), dtype=np.float32) / 255,
                        np.asarray(Image.open(g).convert("RGBA"), dtype=np.float32)[..., 3] / 255
                        if g.exists()
                        else None,
                    )

    @staticmethod
    def _piste(canal):
        if isinstance(canal, list):
            return ([0.0], [np.array(canal, float)], [False])
        temps = sorted(canal, key=float)
        valeurs, doux = [], []
        for t in temps:
            brut = canal[t]
            v = brut if isinstance(brut, list) else brut.get("post", brut.get("pre"))
            valeurs.append(np.array([float(x) for x in v]))
            doux.append(isinstance(brut, dict) and brut.get("lerp_mode") == "catmullrom")
        return ([float(t) for t in temps], valeurs, doux)

    def _compiler(self, d):
        os_ = {}
        for nom, canaux in d.get("bones", {}).items():
            os_[nom] = {k: self._piste(v) for k, v in canaux.items() if k in ("rotation", "position")}
        return {"longueur": float(d.get("animation_length", 1)), "os": os_}

    @staticmethod
    def echantillon(piste, t):
        temps, valeurs, doux = piste
        if t <= temps[0]:
            return valeurs[0]
        der = len(temps) - 1
        if t >= temps[der]:
            return valeurs[der]
        i = 0
        while t > temps[i + 1]:
            i += 1
        k = (t - temps[i]) / (temps[i + 1] - temps[i])
        a, b = valeurs[i], valeurs[i + 1]
        if not doux[i] and not doux[i + 1]:
            return a + (b - a) * k
        p0 = valeurs[max(0, i - 1)]
        p3 = valeurs[min(der, i + 2)]
        k2, k3 = k * k, k * k * k
        return 0.5 * (
            2 * a + (-p0 + b) * k + (2 * p0 - 5 * a + 4 * b - p3) * k2 + (-p0 + 3 * a - 3 * b + p3) * k3
        )

    def pose(self, anim: str | None, t: float, extra: dict | None = None, deplacement: dict | None = None):
        """Rotation et position de chaque os : repos + animation + décalages (degrés, Bedrock)."""
        rots = {n: o["rotation"].copy() for n, o in self.os.items()}
        poss = {n: o["position"].copy() for n, o in self.os.items()}

        def appliquer(nom, r, q):
            if nom not in rots:
                return
            if r is not None:
                rots[nom] += np.array([-r[0] * DEG, -r[1] * DEG, r[2] * DEG])
            if q is not None:
                poss[nom] += np.array([-q[0], q[1], q[2]])

        if anim:
            a = self.anims[anim]
            tt = t % a["longueur"] if a["longueur"] else 0
            for nom, canaux in a["os"].items():
                appliquer(
                    nom,
                    self.echantillon(canaux["rotation"], tt) if "rotation" in canaux else None,
                    self.echantillon(canaux["position"], tt) if "position" in canaux else None,
                )
        for nom, r in (extra or {}).items():
            appliquer(nom, r, None)
        for nom, q in (deplacement or {}).items():
            appliquer(nom, None, q)
        return rots, poss

    def monde(self, pose, racine: np.ndarray):
        """Matrices monde de chaque os."""
        rots, poss = pose
        mats = {}
        for nom in self.ordre:
            o = self.os[nom]
            local = affine(rot(*rots[nom]), poss[nom])
            mats[nom] = (mats[o["parent"]] if o["parent"] else racine) @ local
        return mats

    def descendants(self, noms) -> set:
        res = set(noms)
        change = True
        while change:
            change = False
            for n, o in self.os.items():
                if n not in res and o["parent"] in res:
                    res.add(n)
                    change = True
        return res


# --------------------------------------------------------------------------- #
# Rendu
# --------------------------------------------------------------------------- #

# Plans de BoxGeometry (Three.js) : axes u, v, w, sens, dimensions.
PLANS = [
    ("east", 2, 1, 0, -1, -1, "d", "h", "w"),
    ("west", 2, 1, 0, 1, -1, "d", "h", "-w"),
    ("up", 0, 2, 1, 1, 1, "w", "d", "h"),
    ("down", 0, 2, 1, 1, -1, "w", "d", "-h"),
    ("south", 0, 1, 2, 1, -1, "w", "h", "d"),
    ("north", 0, 1, 2, -1, -1, "w", "h", "-d"),
]


def rects_uv(u, v, w, h, d):
    return {
        "east": (u, v + d, d, h),
        "north": (u + d, v + d, w, h),
        "west": (u + d + w, v + d, d, h),
        "south": (u + 2 * d + w, v + d, w, h),
        "up": (u + d, v, w, d),
        "down": (u + d + w, v, w, d),
    }


class Toile:
    """Une image en cours de rendu : couleur, profondeur, et os visible par pixel."""

    def __init__(self, largeur: int, hauteur: int) -> None:
        self.l, self.h = largeur, hauteur
        self.rgba = np.zeros((hauteur, largeur, 4), np.float32)
        self.z = np.full((hauteur, largeur), -np.inf, np.float32)
        self.os = np.full((hauteur, largeur), -1, np.int32)

    def image(self) -> Image.Image:
        return Image.fromarray((np.clip(self.rgba, 0, 1) * 255).astype(np.uint8))

    def masque(self, indices: set[int]) -> Image.Image:
        """Seulement les pixels où l'un de ces os est au premier plan."""
        garde = np.isin(self.os, list(indices))
        rgba = self.rgba.copy()
        rgba[~garde] = 0
        return Image.fromarray((np.clip(rgba, 0, 1) * 255).astype(np.uint8))


def rendre(
    toile: Toile,
    modele: Modele,
    pose,
    texture: str,
    vue: np.ndarray,
    echelle: float,
    origine: tuple[float, float],
    seulement: set | None = None,
    exclure: set | None = None,
    teinte: float = 1.0,
) -> dict:
    """Dessine le modèle dans la toile. `vue` : matrice 4×4 monde → caméra."""
    tex, glow = modele.textures[texture]
    th, tw = tex.shape[:2]
    mats = modele.monde(pose, np.eye(4))
    index = {n: i for i, n in enumerate(modele.ordre)}
    for nom in modele.ordre:
        if seulement is not None and nom not in seulement:
            continue
        if exclure is not None and nom in exclure:
            continue
        o = modele.os[nom]
        m_os = vue @ mats[nom]
        for cube in o["cubes"]:
            sx, sy, sz = cube["size"]
            m = matrice_cube(o, cube, m_os)
            dims = {"w": sx, "h": sy, "d": sz}
            rects = rects_uv(*cube["uv"], sx, sy, sz)
            for face, ua, va, wa, udir, vdir, W, H, D in PLANS:
                Wv = dims[W]
                Hv = dims[H]
                Dv = -dims[D[1:]] if D.startswith("-") else dims[D]
                rx, ry, rw, rh = rects[face]
                coins = []
                uvs = []
                for iy in (0, 1):
                    for ix in (0, 1):
                        p = np.zeros(3)
                        p[ua] = (ix * Wv - Wv / 2) * udir
                        p[va] = (iy * Hv - Hv / 2) * vdir
                        p[wa] = Dv / 2
                        coins.append(m @ np.append(p, 1))
                        ty = (ry + (1 - iy) * rh) if face in ("up", "down") else (ry + iy * rh)
                        uvs.append((rx + ix * rw, ty))
                c = np.array(coins)[:, :3]
                # Three.js : la face avant est celle dont la normale regarde la
                # caméra (+z). La normale suit l'axe w, signe compris — même pour
                # un cube d'épaisseur nulle (halo, crête).
                sens = np.zeros(3)
                sens[wa] = -1.0 if D.startswith("-") else 1.0
                vraie = m[:3, :3] @ sens
                vraie /= np.linalg.norm(vraie)
                if vraie[2] <= 1e-6:
                    continue
                lum = 0.5 + 0.5 * max(0.0, float(vraie @ LUMIERE))
                ecran = np.array([[p[0] * echelle + origine[0], -p[1] * echelle + origine[1], p[2]] for p in c])
                uvs = np.array(uvs, float)
                for tri in ((0, 1, 2), (1, 3, 2)):
                    raster(toile, ecran[list(tri)], uvs[list(tri)], tex, glow, lum * teinte, index[nom])
    return mats


def matrice_cube(o: dict, cube: dict, m_os: np.ndarray) -> np.ndarray:
    """Matrice du centre d'un cube (repère Three.js), comme buildModel du launcher."""
    ox, oy, oz = cube["origin"]
    sx, sy, sz = cube["size"]
    centre = np.array([-(ox + sx), oy, oz], float) + np.array([sx, sy, sz]) / 2
    if "rotation" in cube:
        cp = np.array([-cube["pivot"][0], cube["pivot"][1], cube["pivot"][2]], float)
        cr = cube["rotation"]
        return m_os @ affine(rot(-cr[0] * DEG, -cr[1] * DEG, cr[2] * DEG), cp - o["pivot"]) @ translation(centre - cp)
    return m_os @ translation(centre - o["pivot"])


def boite(modele: Modele, mats: dict, noms, vue_m, echelle, origine):
    """Boîte englobante à l'écran (min x, max x, min y, max y) des cubes de ces os."""
    xs, ys = [], []
    for nom in noms:
        o = modele.os[nom]
        m_os = vue_m @ mats[nom]
        for cube in o["cubes"]:
            sx, sy, sz = cube["size"]
            m = matrice_cube(o, cube, m_os)
            for dx in (-0.5, 0.5):
                for dy in (-0.5, 0.5):
                    for dz in (-0.5, 0.5):
                        p = m @ np.array([dx * sx, dy * sy, dz * sz, 1])
                        xs.append(p[0] * echelle + origine[0])
                        ys.append(-p[1] * echelle + origine[1])
    return min(xs), max(xs), min(ys), max(ys)


def ik(modele: Modele, anim, t, extra, cibles, vue_m, echelle, origine):
    """Place les mains : pour chaque bras, (os du bras, point de la main, cible).

    Comme `solveArm` du launcher : seuls l'épaule (3 axes) et le coude bougent,
    au plus près de la pose de l'animation (moindres carrés régularisés).
    """
    from scipy.optimize import least_squares

    def avec(p):
        ex = {k: list(v) for k, v in (extra or {}).items()}
        for i, (bras, _pt, _c) in enumerate(cibles):
            a = p[i * 4 : i * 4 + 3]
            ex[bras] = list(np.add(ex.get(bras, [0, 0, 0]), a))
            avant = bras.replace("arm", "forearm")
            ex[avant] = list(np.add(ex.get(avant, [0, 0, 0]), [p[i * 4 + 3], 0, 0]))
        return ex

    def residus(p):
        mats = modele.monde(modele.pose(anim, t, avec(p)), np.eye(4))
        r = []
        for bras, point, cible in cibles:
            main = "hand_" + bras.split("_")[1]
            x, y = point(boite(modele, mats, modele.descendants([main]), vue_m, echelle, origine))
            r += [x - cible[0], y - cible[1]]
        return r + list(np.asarray(p) * 0.03)

    sol = least_squares(residus, np.zeros(4 * len(cibles)), bounds=(-160, 160), x_scale=30)
    return avec(sol.x)


def raster(toile: Toile, pts, uvs, tex, glow, lum, os_index) -> None:
    (x0, y0, z0), (x1, y1, z1), (x2, y2, z2) = pts
    aire = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
    if abs(aire) < 1e-9:
        return
    xmin = max(0, int(math.floor(min(x0, x1, x2))))
    xmax = min(toile.l - 1, int(math.ceil(max(x0, x1, x2))))
    ymin = max(0, int(math.floor(min(y0, y1, y2))))
    ymax = min(toile.h - 1, int(math.ceil(max(y0, y1, y2))))
    if xmin > xmax or ymin > ymax:
        return
    xs, ys = np.meshgrid(np.arange(xmin, xmax + 1) + 0.5, np.arange(ymin, ymax + 1) + 0.5)
    w0 = ((x1 - xs) * (y2 - ys) - (x2 - xs) * (y1 - ys)) / aire
    w1 = ((x2 - xs) * (y0 - ys) - (x0 - xs) * (y2 - ys)) / aire
    w2 = 1 - w0 - w1
    eps = -1e-6
    dedans = (w0 >= eps) & (w1 >= eps) & (w2 >= eps)
    if not dedans.any():
        return
    z = w0 * z0 + w1 * z1 + w2 * z2
    u = w0 * uvs[0, 0] + w1 * uvs[1, 0] + w2 * uvs[2, 0]
    v = w0 * uvs[0, 1] + w1 * uvs[1, 1] + w2 * uvs[2, 1]
    th, tw = tex.shape[:2]
    ui = np.clip(np.floor(u).astype(int), 0, tw - 1)
    vi = np.clip(np.floor(v).astype(int), 0, th - 1)
    couleur = tex[vi, ui]
    sous = toile.z[ymin : ymax + 1, xmin : xmax + 1]
    garde = dedans & (couleur[..., 3] >= 0.5) & (z > sous)
    if not garde.any():
        return
    rgb = couleur[..., :3] * lum
    if glow is not None:
        g = glow[vi, ui][..., None]
        rgb = rgb * (1 - g) + couleur[..., :3] * g
    zone = toile.rgba[ymin : ymax + 1, xmin : xmax + 1]
    zone[garde, :3] = rgb[garde]
    zone[garde, 3] = 1
    sous[garde] = z[garde]
    toile.os[ymin : ymax + 1, xmin : xmax + 1][garde] = os_index


def vue(lacet: float, tangage: float = 0.0, roulis: float = 0.0) -> np.ndarray:
    """Monde → caméra : la caméra regarde vers −z ; `lacet` tourne le modèle autour de y."""
    return affine(rot(tangage * DEG, 0, roulis * DEG) @ rot(0, lacet * DEG, 0), [0, 0, 0])


def projeter(vue_m, mats, nom, point, echelle, origine):
    p = vue_m @ mats[nom] @ np.append(point, 1)
    return (p[0] * echelle + origine[0], -p[1] * echelle + origine[1])


# --------------------------------------------------------------------------- #
# Planches
# --------------------------------------------------------------------------- #

ECHELLE = 4
#: Pixels de sprite par pixel virtuel de la scène : les planches sont rendues deux
#: fois plus fines que la scène, et affichées à moitié — au plus près de la
#: résolution réelle de l'écran, nettes comme le launcher.
DENSITE = 2
#: Largeur maximale d'une planche (les cartes graphiques modestes plafonnent).
LARGEUR_MAX = 4096


class Planche:
    """Une suite d'images de même taille, posées côte à côte."""

    def __init__(self, nom: str, largeur: int, hauteur: int, origine, fps: float = 8, boucle: bool = True,
                 densite: int = DENSITE):
        self.nom, self.l, self.h, self.origine = nom, largeur, hauteur, origine
        self.fps, self.boucle, self.densite = fps, boucle, densite
        self.images: list[Image.Image] = []
        self.points: dict = {}

    def ajouter(self, image: Image.Image) -> None:
        self.images.append(image)

    def recadrer(self, marge: int = 2) -> tuple[int, int]:
        """Rogne toutes les images à leur boîte commune ; renvoie le décalage."""
        boites = [im.getbbox() for im in self.images if im.getbbox()]
        x0 = max(0, min(b[0] for b in boites) - marge)
        y0 = max(0, min(b[1] for b in boites) - marge)
        x1 = min(self.l, max(b[2] for b in boites) + marge)
        y1 = min(self.h, max(b[3] for b in boites) + marge)
        self.images = [im.crop((x0, y0, x1, y1)) for im in self.images]
        self.l, self.h = x1 - x0, y1 - y0
        self.origine = (self.origine[0] - x0, self.origine[1] - y0)
        return x0, y0

    def ecrire(self, meta: dict) -> None:
        # En grille : colonnes tant que la largeur le permet, puis rangées.
        colonnes = max(1, min(len(self.images), LARGEUR_MAX // self.l))
        rangees = math.ceil(len(self.images) / colonnes)
        feuille = Image.new("RGBA", (self.l * colonnes, self.h * rangees), (0, 0, 0, 0))
        for i, im in enumerate(self.images):
            feuille.paste(im, ((i % colonnes) * self.l, (i // colonnes) * self.h))
        for dossier in SORTIES:
            dossier.mkdir(parents=True, exist_ok=True)
            feuille.save(dossier / f"{self.nom}.png", optimize=True)
        meta[self.nom] = {
            "largeur": self.l,
            "hauteur": self.h,
            "images": len(self.images),
            "origine": [round(self.origine[0]), round(self.origine[1])],
            "fps": self.fps,
            "boucle": self.boucle,
            "colonnes": colonnes,
            "densite": self.densite,
            **({"points": self.points} if self.points else {}),
        }


def ease(k: float) -> float:
    k = min(1.0, max(0.0, k))
    return k * k * (3 - 2 * k)


def centre_tete(xen, mats, v, S, O):
    return projeter(v, mats, "head", np.array([0, 6.0, 0]), S, O)


def planches_xenodys(xen: Modele, meta: dict) -> None:
    mains_os = xen.descendants(["hand_left", "hand_right"])
    mains_idx = {xen.ordre.index(n) for n in mains_os}
    milieu_bas = lambda b: ((b[0] + b[1]) / 2, b[3])  # noqa: E731
    gauche_milieu = lambda b: (b[0], (b[2] + b[3]) / 2)  # noqa: E731
    centre = lambda b: ((b[0] + b[1]) / 2, (b[2] + b[3]) / 2)  # noqa: E731

    for etat in ETATS:
        # ------------------------------------------------ « façonner » le monde
        # De face, penchée sur son ouvrage : ses mains tournent autour du monde
        # (un cube de blocs, dessiné par le code entre son corps et ses mains).
        S, O = 2 * DENSITE, (400, 600)
        v = vue(180 - 10, 10)
        n = 32
        base = xen.pose("cradle", 0.0, {"head": [16, 0, 0]})
        tete = centre_tete(xen, xen.monde(base, np.eye(4)), v, S, O)
        monde = (tete[0] + 2 * S, tete[1] + 30 * S)
        corps = Planche(f"xen_faconne_{etat}", 800, 680, O, fps=16)
        # Le clignement ne dure qu'un instant : une image sur quatre suffit.
        clin = Planche(f"xen_faconne_{etat}_blink", 800, 680, O, fps=4)
        devant = Planche(f"xen_faconne_mains_{etat}", 800, 680, O, fps=16)
        for i in range(n):
            ph = i / n * 2 * math.pi
            extra = {"head": [16 + 3 * math.sin(ph), 5 * math.sin(ph * 0.5), 0]}
            for k in range(4):
                extra[f"finger_left_{k}"] = [25 * max(0, math.sin(ph * 2 + k)), 0, 0]
                extra[f"finger_right_{k}"] = [25 * max(0, math.sin(ph * 2 + k + 2)), 0, 0]
            r = 11 * S
            cibles = [
                ("arm_left", centre, (monde[0] + r + 3 * S * math.cos(ph), monde[1] - 2 * S + 4 * S * math.sin(ph))),
                ("arm_right", centre, (monde[0] - r + 3 * S * math.cos(ph + math.pi), monde[1] - 2 * S + 4 * S * math.sin(ph + math.pi))),
            ]
            ex = ik(xen, "cradle", i / n, extra, cibles, v, S, O)
            pose = xen.pose("cradle", i / n, ex)
            t = Toile(corps.l, corps.h)
            rendre(t, xen, pose, etat, v, S, O)
            corps.ajouter(t.image())
            devant.ajouter(t.masque(mains_idx))
            if i % 4 == 0:
                t = Toile(clin.l, clin.h)
                rendre(t, xen, pose, etat + "_blink", v, S, O)
                clin.ajouter(t.image())
        for pl in (corps, clin, devant):
            dx, dy = pl.recadrer() if pl is corps else (dx0, dy0)
            if pl is corps:
                dx0, dy0 = dx, dy
            else:
                pl.images = [im.crop((dx0, dy0, dx0 + corps.l, dy0 + corps.h)) for im in pl.images]
                pl.l, pl.h, pl.origine = corps.l, corps.h, corps.origine
            pl.points = {"monde": [round(monde[0] - dx0), round(monde[1] - dy0)], "unite": S}
            pl.ecrire(meta)

        # ------------------------------------------------------------- l'envol
        f = Planche(f"xen_envol_{etat}", 800, 800, (400, 660), fps=20)
        for i in range(20):
            t = Toile(f.l, f.h)
            rendre(t, xen, xen.pose("fly", i / 20), etat, vue(180 + 8, -14), 2 * DENSITE, f.origine)
            f.ajouter(t.image())
        f.recadrer()
        f.ecrire(meta)

        # L'écran titre du jeu dessine Xenodys en vraie 3D (mod : client/GeoModel) :
        # aucune planche ici.


def planches_assistants(bot: Modele, meta: dict) -> None:
    """Les petits robots, de trois quarts, tournés vers la droite (le code les retourne)."""
    L, H, O = 192, 128, (96, 116)
    v = vue(180 + 50, 8)

    def cycle(nom, n, fps, poser, boucle=True, etat="creatrice"):
        p = Planche(f"bot_{nom}_{etat}", L, H, O, fps=fps, boucle=boucle)
        p.points = {"unite": ECHELLE}
        for i in range(n):
            pose, racine_rot, racine_dep = poser(i / n if boucle else i / max(1, n - 1))
            t = Toile(L, H)
            # La racine : rotation (chute) autour des pieds, et déplacement.
            m = affine(rot(racine_rot * DEG, 0, 0), racine_dep)
            rendre_racine(t, bot, pose, etat, v @ m, ECHELLE, O)
            p.ajouter(t.image())
        p.ecrire(meta)

    for etat in ETATS:
        def marche(k):
            ph = k * 2 * math.pi
            return (
                bot.pose("idle", 0, {
                    "leg_left": [35 * math.sin(ph), 0, 0],
                    "leg_right": [-35 * math.sin(ph), 0, 0],
                    "arm_left": [-30 * math.sin(ph), 0, 0],
                    "arm_right": [30 * math.sin(ph), 0, 0],
                }, {"body": [0, abs(math.sin(ph)) * 1.0, 0]}),
                0,
                [0, 0, 0],
            )

        def travail(k):
            ph = k * 2 * math.pi
            return (
                bot.pose("idle", 0, {
                    "arm_left": [-80 + 25 * math.sin(ph), 0, -10],
                    "arm_right": [-80 + 25 * math.sin(ph + math.pi), 0, 10],
                    "head": [10, 0, 0],
                }),
                0,
                [0, 0, 0],
            )

        def repos(k):
            return (bot.pose("idle", k * 2.0), 0, [0, 0, 0])

        def chute(k):
            # Trébuche : bascule en avant jusqu'à plat ventre, les bras qui battent.
            a = ease(k) * 88
            return (
                bot.pose("idle", 0, {
                    "arm_left": [-150 * k, 0, -20 * k],
                    "arm_right": [-150 * k, 0, 20 * k],
                    "leg_left": [-20 * k, 0, 0],
                }),
                -a,
                [0, 0, 0],
            )

        def releve(k):
            # Se relève : les bras poussent, le corps se redresse, petit sursaut.
            a = (1 - ease(k)) * 88
            return (
                bot.pose("idle", 0, {
                    "arm_left": [-90 * (1 - k), 0, -10],
                    "arm_right": [-90 * (1 - k), 0, 10],
                    "head": [-15 * math.sin(k * math.pi), 0, 0],
                }),
                -a,
                [0, math.sin(k * math.pi) * 2, 0],
            )

        def salut(k):
            return (bot.pose("wave", k * 2.4), 0, [0, 0, 0])

        cycle("marche", 16, 16, marche, etat=etat)
        cycle("travail", 16, 14, travail, etat=etat)
        cycle("repos", 16, 8, repos, etat=etat)
        cycle("chute", 10, 16, chute, boucle=False, etat=etat)
        cycle("releve", 12, 14, releve, boucle=False, etat=etat)
        cycle("salut", 24, 20, salut, etat=etat)


def rendre_racine(toile, modele, pose, etat, vue_m, echelle, origine):
    rendre(toile, modele, pose, etat, vue_m, echelle, origine)


def bloc_iso(meta: dict) -> None:
    """Un bloc de la simulation, en isométrie 2:1, dans les deux palettes."""
    teintes = {
        "creatrice": ((0x6F, 0xE3, 0xD3), (0x2C, 0x9E, 0x91), (0x1B, 0x6B, 0x63), (0xE9, 0xFF, 0xFC)),
        "corrompue": ((0xF0, 0x50, 0x6E), (0x9A, 0x2B, 0x6E), (0x5A, 0x1A, 0x55), (0xFF, 0xD3, 0xDD)),
    }
    for etat, (haut, gauche, droite, arete) in teintes.items():
        im = Image.new("RGBA", (12, 13), (0, 0, 0, 0))
        px = im.load()
        for y in range(13):
            for x in range(12):
                cx = x - 5.5
                # Losange du dessus : |x|/2 + |y - 3| <= 3
                if y < 6 and abs(cx) / 2 + abs(y - 2.5) <= 3:
                    px[x, y] = (*haut, 255)
                elif y >= 3 and abs(cx) <= 6:
                    bas = 6 + 3 - abs(cx) / 2 + 3
                    haut_face = 3 + (3 - abs(cx) / 2)
                    if haut_face <= y + 0.5 <= bas + 0.5:
                        px[x, y] = (*(gauche if cx < 0 else droite), 255)
        # Arêtes claires du dessus : le grain « circuit ».
        for x in range(12):
            for y in range(13):
                if px[x, y][3] and (y == 0 or px[x, y - 1][3] == 0):
                    px[x, y] = (*arete, 255)
        for dossier in SORTIES:
            im.save(dossier / f"bloc_{etat}.png")
        meta[f"bloc_{etat}"] = {"largeur": 12, "hauteur": 13, "images": 1, "origine": [6, 6], "fps": 0, "boucle": False,
                                "colonnes": 1, "densite": 1}


# --------------------------------------------------------------------------- #
# Le socle des joueurs imprimés : une carte de circuit imprimé, tournée de 30°
# --------------------------------------------------------------------------- #

#: La vue des joueurs imprimés (mod : client/PlayerRaster, launcher :
#: components/loadingScene.js) : tournés de 30° vers la droite, vus d'un peu haut.
VUE_JOUEUR = (180 + 30, 18)


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


def socle(meta: dict) -> None:
    geo = {
        "description": {"texture_width": 128, "texture_height": 64},
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
    for etat in ETATS:
        mod = Modele("socle", "", geo=geo, textures={etat: texture_socle(etat)})
        p = Planche(f"socle_{etat}", 240, 160, (120, 80), fps=0, boucle=False)
        t = Toile(p.l, p.h)
        rendre(t, mod, mod.pose(None, 0), etat, vue(*VUE_JOUEUR), ECHELLE, p.origine)
        p.ajouter(t.image())
        p.recadrer()
        p.points = {"unite": ECHELLE, "vue": list(VUE_JOUEUR)}
        p.ecrire(meta)


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
    xen = Modele("xenodys", "animation.xenodys")
    bot = Modele("xenodys_assistant", "animation.xenodys_assistant")
    planches_xenodys(xen, meta)
    planches_assistants(bot, meta)
    bloc_iso(meta)
    bandeau(meta)
    police(meta)
    socle(meta)
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
