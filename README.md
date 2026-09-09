# Launcher OPM

Le launcher officiel du serveur **One Piece Minecraft**, et son serveur
d'authentification.

| Dossier | Rôle |
|---|---|
| [`launcher/`](launcher/) | l'application Electron installée par les joueurs |
| [`auth-server/`](auth-server/) | l'API FastAPI : comptes, vérification de possession, sessions de jeu, skins |

---

## Licences et attributions

### Le code de ce dépôt

Publié sous **CC BY-NC 4.0**. Le code source est public, comme l'exige la
licence de `minecraft-java-core` (voir ci-dessous).

### Bibliothèques tierces

**[`minecraft-java-core`](https://github.com/luuxis/minecraft-java-core)** —
Copyright © **Luuxis**, sous *Luuxis License v1.0*.

C'est la bibliothèque qui télécharge Minecraft, installe le chargeur de mods,
gère l'exécutable Java, vérifie l'intégrité des fichiers et lance le jeu. Le
launcher ne fonctionnerait pas sans elle.

Sa licence impose trois obligations que ce dépôt respecte :

- **l'attribution** — le nom de l'auteur est mentionné ici et dans le launcher
  lui-même, en bas du panneau Paramètres ;
- **un code source public et librement accessible** — c'est le cas de ce dépôt,
  et c'est ce qui autorise la vente de cosmétiques sur le serveur ;
- **la licence redistribuée sans altération** — `LICENSE.md` est embarqué tel
  quel dans les paquets produits par `launcher/build.js`.

Le texte complet est dans
[`launcher/node_modules/minecraft-java-core/LICENSE.md`](launcher/node_modules/minecraft-java-core/LICENSE.md)
après un `npm install`.

Le launcher embarque également **Electron** (MIT), **electron-updater** (MIT),
et les polices **Anton** et **Space Grotesk** (SIL Open Font License 1.1).

---

## Mentions

**NOT AN OFFICIAL MINECRAFT SERVICE.** Ce projet n'est ni approuvé par
Mojang Studios ou Microsoft, ni affilié à eux d'aucune manière. *Minecraft* est
une marque déposée de Mojang Studios. Le launcher ne dispense pas d'acheter le
jeu : la possession de *Minecraft : Java Edition* est vérifiée auprès de
Microsoft et reste obligatoire pour jouer.

**Projet de fans.** Sans lien avec Shueisha ni Toei Animation. L'univers du
serveur s'inspire de *One Piece* ; les visuels, les cosmétiques et les contenus
sont des créations originales.
