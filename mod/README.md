# Le mod One Piece Minecraft

Mod **client** NeoForge 1.21.1 (NeoForge 21.1.248, comme le serveur), **embarqué dans le
launcher** : la CI le compile à chaque version (`launcher/game-files.js`), et le launcher
l'installe lui-même dans le dossier du jeu avant chaque lancement, avec authlib-injector.
Rien à déposer sur le serveur ; une mise à jour du launcher met le mod à jour.

Ce qu'il fait (détail dans `docs/XENODYS.md`, « Du launcher au jeu ») :

- **l'écran de chargement** : le laboratoire de Xenodys en 3D (`client/LabScene`,
  `client/LabData` ; `mixin/MinecraftMixin` → `client/OpmLoadingOverlay`,
  `client/LoadingScene`). La salle s'assemble bloc par bloc, un joueur flotte dans la grande
  cuve, Xenodys va d'un poste à l'autre, construit et expérimente. À la fin, la cuve
  descend et la caméra glisse vers le menu, sans coupure ;
- **l'écran titre** (`client/OpmTitleScreen`) : la même salle, et le menu en terminal
  (`client/Terminal`, le style « circuit » d'OPMTech) ; ni solo, ni liste de serveurs, ni
  liste des mods ;
- **les menus hors partie** (`client/OpmBackground`, `client/MenuStyle`,
  `mixin/GuiGraphicsMixin`, `mixin/ScreenMixin`) — jamais en jeu ni par-dessus le pack de
  ressources du serveur, qui garde la main sur l'apparence de la partie — et la
  **musique** du launcher dans les menus (`client/OpmMusic`) ;
- **l'écran titre réagit au serveur** (`client/OpmLive`, relu toutes les 20 s) : hors
  ligne, Xenodys se détourne et cherche ; complet, elle lève la main (« patience ») ;
- **la connexion** (`client/ConnectFx`) : une porte s'ouvre en iris de gros pixels ;
- **la fluidité** : hors partie, l'affichage suit la limite d'images du joueur (Minecraft se
  bride sinon à 60 au minuteur), et une image en retard ne fait pas sauter la scène ;
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
force l'état du serveur ; `-PopmEtat=corrompue` force l'état de Xenodys ; `-PopmScene=1
-PopmDuration=60` joue le chargement au ralenti ; `-PopmProfile=1` mesure la fluidité ;
`-PopmJoin=5` rejoint ; `-PopmWorld=1` crée un monde de test en solo, y invoque Xenodys et
ouvre le menu pause. `run/opm/session.json` simule ce qu'écrit le launcher.

## Ressources

Textures, modèles, animations et laboratoire ne sont **pas** dans ce dépôt, qui est public :
ils vivent dans `xenodys/` (ignoré par git), et seul le paquet chiffré `assets/opm/opm.pak`
est versionné (`client/Pack`). Après une modification :

```bash
python3 xenodys/labo.py && python3 xenodys/sprites.py   # régénère les ressources
node scripts/paquet.js                                  # les chiffre
```

La clé vient de `.cle-ressources` (fichier local, ignoré) ou de `OPM_PACK_KEY` (secret GitHub
Actions). Sans clé, le mod se compile, mais ses scènes 3D restent vides et la musique des
menus se tait (`client/PackSounds`).

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
