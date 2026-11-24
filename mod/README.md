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
- **les menus hors partie** aux couleurs du launcher (`client/MenuStyle`,
  `mixin/GuiGraphicsMixin`, `mixin/ScreenMixin`) — jamais en jeu ni par-dessus le pack de
  ressources du serveur, qui garde la main sur l'apparence de la partie — et la
  **musique** du launcher dans les menus (`client/OpmMusic`) ;
- **l'écran titre réagit au serveur** (`client/OpmLive`, relu toutes les 20 s) : hors
  ligne, Xenodys se détourne et cherche ; complet, elle lève la main (« patience ») ;
- **la connexion** (`client/ConnectFx`) : le joueur se défait en pixels vers un orbe ;
- **le menu pause** : les liens vers le site et le Discord d'OPM. Xenodys n'y vient plus ;
- **Xenodys dans le monde** (`client/WorldXenodys`) : partout où le serveur pose un marqueur
  nommé `opm:xenodys[:animation]` (`/xenodys apparaitre`, minecraft/xenodys.sk), immense,
  la tête vers le joueur ; et **la première arrivée** de chaque compte (une seule fois, retenue
  par le serveur d'authentification : `GET`/`POST /api/v1/game/arrivee`). Rien à installer sur le serveur : le marqueur est un support d'armure
  invisible, c'est le mod des joueurs qui la dessine.

Il dialogue avec le launcher par `opm/session.json` (écrit par
`launcher/src/main/services/bridge.js`) et par trois signaux, `hello`, `ready`, `music`
(`client/Signal`) : écrits dans `opm/signaux.properties` (que le launcher relit), sur la
sortie standard et dans le journal. Le fichier est la voie sûre : avec certains modpacks
(Sinytra Connector), le journal d'un mod n'atteint jamais la console.

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
sprites (`assets/opm/scene/`), le modèle GeckoLib (`assets/opm/geckolib/`,
`assets/opm/textures/entity/`) et les textures des menus (`assets/opm/textures/gui/sprites/widget/`, `assets/minecraft/textures/gui/`). La
musique (`assets/opm/sounds/music/`) vient de `xenodys/musique/`.

## Anti-triche

- `client/AntiCheat` : à l'arrivée sur le serveur, puis toutes les 5 minutes, et quand le
  staff le demande (`/controle`), les mods chargés (avec l'empreinte de leur fichier) et les
  packs actifs partent au serveur d'authentification (`POST /api/v1/game/report`, jeton de
  jeu). Le mod repère lui-même un pack X-ray (pierre, ardoise, terre, netherrack… rendus
  transparents).
- `client/XenodysWarning` : « Je te vois… » — Xenodys corrompue au coin bas-droit, le bord
  de l'écran qui rougit. Déclenchée par un rapport refusé (une fois par motif et par
  connexion) ou par le staff (`/surveiller`). Un soupçon du Skript ne la fait pas venir.
- `client/ServerCalls` : les messages système `[OPM:XENODYS]`, `[OPM:CONTROLE]` et
  `[OPM:ARRIVEE]` du serveur, cachés au joueur.

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
/xenodys arrivee <joueur>                                 rejoue sa première arrivée
```

Ou à la main : un support d'armure `Invisible`, `Marker`, `NoGravity`, nommé
`opm:xenodys:<anim>` (son orientation est la sienne).
