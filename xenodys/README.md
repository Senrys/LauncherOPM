# Xenodys en cubes

La déesse-machine créatrice du monde de One Piece Minecraft, en modèle voxel :
une seule source pour **le launcher** et **le jeu** (GeckoLib).

```
xenodys/
├── generer.py                       ← la source : géométrie, animations, textures
└── geckolib/                        ← ce que le mod du jeu utilise (généré)
    ├── geo/xenodys.geo.json
    ├── animations/xenodys.animation.json
    └── textures/
        ├── xenodys_creatrice.png    + xenodys_creatrice_glowmask.png
        └── xenodys_corrompue.png    + xenodys_corrompue_glowmask.png
```

Le script recopie aussi les textures dans `launcher/src/assets/xenodys/` et écrit
`launcher/src/assets/js/data/xenodys-model.js` (géométrie et animations en module ES :
le launcher ne peut pas lire un fichier local avec `fetch`).

## Régénérer

```bash
pip install pillow
python3 xenodys/generer.py
```

Le modèle s'ouvre dans **Blockbench** (*File → Open Model*, `xenodys.geo.json`, format
GeckoLib ou Bedrock Entity) pour être regardé ou retouché. Attention : une retouche faite
dans Blockbench est écrasée au prochain `generer.py`. Choisir l'un ou l'autre comme source.

## Le modèle

- Environ **104 pixels** de haut (halo compris ~108), soit 6,5 blocs à l'échelle 1.
- Xenodys doit mesurer **sept fois un humain** (1,8 bloc → ~12,6 blocs) : dans le jeu, le
  renderer l'agrandit d'un facteur **1,95** (`RENDU_ECHELLE` dans `generer.py`).
- Pas de jambes : un corps en flèche. Elle flotte.
- Mains articulées : `hand_*`, `finger_*_{0..3}` (+ `_tip`), `thumb_*` (+ `_tip`).
- UV « box », un pixel de texture par unité, texture 256 × 256.

## Les animations

| Nom | Où | Boucle |
|---|---|---|
| `animation.xenodys.idle` | jeu | oui — elle flotte, la jupe ondule, les halos tournent |
| `animation.xenodys.greet` | jeu | non — elle tourne la tête vers le joueur, tend la main |
| `animation.xenodys.corrupted_idle` | jeu | oui — sursauts, halo erratique |
| `animation.xenodys.lean` | launcher | oui — penchée vers le launcher, la main agrippée à son bord |
| `animation.xenodys.corrupted_lean` | launcher | oui — la même, crispée, la tête qui se tord |

## Dans le mod (NeoForge 1.21.1 + GeckoLib)

À recopier dans les ressources du mod (`<modid>` = l'identifiant du mod) :

```
src/main/resources/assets/<modid>/geo/entity/xenodys.geo.json
src/main/resources/assets/<modid>/animations/entity/xenodys.animation.json
src/main/resources/assets/<modid>/textures/entity/xenodys_creatrice.png
src/main/resources/assets/<modid>/textures/entity/xenodys_creatrice_glowmask.png
src/main/resources/assets/<modid>/textures/entity/xenodys_corrompue.png
src/main/resources/assets/<modid>/textures/entity/xenodys_corrompue_glowmask.png
```

Côté code, l'essentiel :

- un `GeoModel` qui renvoie la texture `xenodys_creatrice` ou `xenodys_corrompue` selon
  l'état (le même que celui du launcher : table `launcher_xenodys`, commande `/xenodys`,
  voir `docs/XENODYS.md`) ;
- un `GeoEntityRenderer` avec `withScale(1.95f)` et un `AutoGlowingGeoLayer` (il trouve
  seul les fichiers `_glowmask`) ;
- un contrôleur d'animation qui joue `idle` ou `corrupted_idle`, et `greet` quand un
  joueur s'approche.

Le mod lui-même est un projet séparé, à écrire.
