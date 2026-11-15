# Le mod One Piece Minecraft

Mod **client** NeoForge 1.21.1 (NeoForge 21.1.248, comme le serveur), **embarqué dans le
launcher** : la CI le compile à chaque version (`launcher/game-files.js`), et le launcher
l'installe lui-même dans le dossier du jeu avant chaque lancement, avec authlib-injector.
Rien à déposer sur le serveur ; une mise à jour du launcher met le mod à jour.

Ce qu'il fait (détail dans `docs/XENODYS.md`, « Du launcher au jeu ») :

- **l'écran de chargement** de Xenodys, à la place de ceux de Mojang et de NeoForge
  (`mixin/MinecraftMixin` → `client/OpmLoadingOverlay`, `client/LoadingScene`), et son
  **envol** à la fin ;
- **l'écran titre** d'OPM (`client/OpmTitleScreen`) : Xenodys en 3D (`client/GeoModel`,
  le modèle GeckoLib sans GeckoLib), le joueur sur son socle (`client/PlayerRaster`) ;
  ni solo ni liste de serveurs ;
- **les menus** aux couleurs du launcher (`assets/minecraft/textures/gui/…`,
  `mixin/ScreenMixin`) et la **musique** du launcher (`client/OpmMusic`) ;
- **l'écran titre réagit au serveur** (`client/OpmLive`, relu toutes les 20 s) : hors
  ligne, Xenodys se détourne et cherche ; complet, elle lève la main (« patience ») ;
- **la connexion** (`client/ConnectFx`) : le joueur se défait en pixels vers un orbe ;
- **le menu pause** (`client/PausePeek`) : Xenodys passe parfois la tête par le coin bas-droit
  et dit un mot — toujours l'annonce du staff quand il y en a une ;
- **Xenodys dans le monde** (`client/WorldXenodys`) : partout où le serveur pose un marqueur
  nommé `opm:xenodys[:animation]` (`/xenodys apparaitre`, minecraft/xenodys.sk), immense,
  la tête vers le joueur ; et **la première arrivée** de chaque joueur, qu'elle dépose
  dans le monde. Rien à installer sur le serveur : le marqueur est un support d'armure
  invisible, c'est le mod des joueurs qui la dessine.

Il dialogue avec le launcher par `opm/session.json` (écrit par
`launcher/src/main/services/bridge.js`) et par trois lignes du journal : `[OPM:HELLO]`,
`[OPM:READY]`, `[OPM:MUSIC]`.

## Compiler

Java 21. Le wrapper Gradle télécharge NeoForge au premier lancement.

```bash
cd mod
./gradlew build          # → build/libs/opm-<version>.jar
./gradlew runClient      # un client de développement (dossier run/)
```

Captures de développement (dans `run/screenshots/`) :
`./gradlew runClient -PopmShots=0.5,2,4 -PopmOptions=6 -PopmQuit=9`. `-PopmStatus=offline|full`
force l'état du serveur ; `-PopmWorld=1` crée un monde de test en solo, y invoque Xenodys et
ouvre le menu pause. `run/opm/session.json` simule ce qu'écrit le launcher.

## Ressources générées

Ne pas retoucher à la main : `python3 xenodys/sprites.py` régénère les planches de
sprites (`assets/opm/textures/gui/sprites/`), le modèle GeckoLib (`assets/opm/geckolib/`,
`assets/opm/textures/entity/`) et les textures des menus (`assets/minecraft/…`). La
musique (`assets/opm/sounds/music/`) vient de `xenodys/musique/`.

## Anti-triche

- `client/AntiCheat` : à l'arrivée sur le serveur, puis toutes les 5 minutes, les mods
  chargés et les packs actifs partent au serveur d'authentification
  (`POST /api/v1/game/report`, jeton de jeu). Le mod repère lui-même un pack X-ray (pierre,
  ardoise, terre, netherrack… rendus transparents).
- `client/XenodysWarning` : « Je te vois… » — Xenodys corrompue au coin bas-droit, le bord
  de l'écran qui rougit. Déclenchée par un pack X-ray, un rapport refusé, ou un message du
  serveur commençant par `[OPM:XENODYS]` (caché au joueur) : c'est ainsi que
  `minecraft/anticheat.sk` l'appelle.

## Livraison

Automatique : `launcher/game-files.js` (appelé par `build.js`, donc par la CI) compile ce
mod et récupère authlib-injector (version figée, SHA-256 vérifiée) dans
`launcher/src/game/`. Avant chaque lancement, le launcher les pose dans l'instance
(`mods/opm-<version>.jar`, `authlib-injector.jar`) et les protège de la vérification du
modpack. Rien à faire sur le serveur.

## Xenodys en jeu (staff)

```
/xenodys apparaitre [idle|greet|fly|cradle|unveil|lean]   devant soi, à 8 blocs
/xenodys animation <anim>                                 la plus proche
/xenodys disparaitre                                      la plus proche
```

Ou à la main : un support d'armure `Invisible`, `Marker`, `NoGravity`, nommé
`opm:xenodys:<anim>` (son orientation est la sienne).
