# Le mod One Piece Minecraft

Mod **client** NeoForge 1.21.1 (NeoForge 21.1.248, comme le serveur), livré **par le
modpack** — jamais par le launcher : les joueurs ne peuvent pas installer d'autre modpack,
et le launcher vérifie les fichiers à chaque lancement.

Ce qu'il fait (détail dans `docs/XENODYS.md`, « Du launcher au jeu ») :

- **l'écran de chargement** de Xenodys, à la place de ceux de Mojang et de NeoForge
  (`mixin/MinecraftMixin` → `client/OpmLoadingOverlay`, `client/LoadingScene`), et son
  **envol** à la fin ;
- **l'écran titre** d'OPM (`client/OpmTitleScreen`) : Xenodys en 3D (`client/GeoModel`,
  le modèle GeckoLib sans GeckoLib), le joueur sur son socle (`client/PlayerRaster`) ;
  ni solo ni liste de serveurs ;
- **les menus** aux couleurs du launcher (`assets/minecraft/textures/gui/…`,
  `mixin/ScreenMixin`) et la **musique** du launcher (`client/OpmMusic`).

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

Captures de développement : `./gradlew runClient -PopmShots=0.5,2,4 -PopmOptions=6 -PopmQuit=9`
(dans `run/screenshots/`). `run/opm/session.json` simule ce qu'écrit le launcher.

## Ressources générées

Ne pas retoucher à la main : `python3 xenodys/sprites.py` régénère les planches de
sprites (`assets/opm/textures/gui/sprites/`), le modèle GeckoLib (`assets/opm/geckolib/`,
`assets/opm/textures/entity/`) et les textures des menus (`assets/minecraft/…`). La
musique (`assets/opm/sounds/music/`) vient de `xenodys/musique/`.

## Déployer

Sur le serveur du site (`/var/www/opm-launcher/`, servi par
`https://auth.onepieceminecraft.fr/launcher/`) :

1. `mods/opm-<version>.jar` (supprimer l'ancienne version) ;
2. `authlib-injector.jar` **à la racine** (la même version que celle du serveur
   Minecraft) : le launcher le passe au jeu, qui annonce alors son arrivée à notre
   serveur d'authentification et accepte nos skins signés. Sans lui, le launcher se
   rabat sur une redirection minimale (connexion possible, skins des autres joueurs
   absents) ;
3. `files.json` se régénère tout seul.

Le serveur Minecraft n'a pas besoin du mod.
