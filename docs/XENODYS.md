# Xenodys — l'état du monde

Xenodys est l'entité qui a créé le monde de One Piece Minecraft. Elle a deux
états, et **le jeu, le launcher et le site** les partagent :

| État | Qui elle est | Couleurs |
|---|---|---|
| `creatrice` | elle-même : bienveillante, curieuse, elle observe ses « expériences » | cyan — la couleur du site |
| `corrompue` | contrôlée par l'ennemi pendant un événement RP ; c'est toujours elle, qui lutte, mais elle peut être cruelle | rouge et violet |

`creatrice` est l'état normal. **Toute valeur inconnue, toute absence, toute
panne vaut `creatrice`** : un incident technique ne doit jamais plonger les
joueurs dans le thème de l'invasion.

Elle parle d'elle **à la troisième personne** (« Xenodys te voit revenir »).

---

## La source unique : `launcher_xenodys`

Une table d'une seule ligne (`id = 1`), dans la base partagée. Créée par la
migration `0002_launcher_xenodys` du serveur d'authentification, qui insère
d'emblée la ligne à l'état `creatrice`.

| Colonne | Type | Rôle |
|---|---|---|
| `id` | `integer` | toujours `1` |
| `etat` | `varchar(16)` | `creatrice` ou `corrompue` — contrainte `CHECK` en base |
| `message` | `varchar(280)`, nullable | annonce du staff, affichée telle quelle aux joueurs |
| `par` | `varchar(64)`, nullable | qui a déclenché la bascule — trace interne, jamais affichée |
| `depuis` | `timestamp` (UTC, sans fuseau) | date de la dernière bascule |

## Qui écrit : le staff, depuis le jeu

```
/xenodys corrompue L'ennemi a pris le contrôle de Xenodys. Tenez vos positions.
/xenodys creatrice
/xenodys            → affiche l'état actuel
```

Script : `minecraft/xenodys.sk` (Skript + skript-db, permission
`opm.xenodys`). Requêtes paramétrées, jamais `execute unsafe` : une annonce ne
peut pas modifier la requête SQL.

## Qui lit

**Le launcher** — `GET /api/v1/xenodys` (public, sans jeton) et le champ
`xenodys` de `GET /api/v1/bootstrap` :

```json
{ "etat": "corrompue", "depuis": "2026-11-15T20:14:03", "message": "L'ennemi a pris le contrôle de Xenodys." }
```

Relu toutes les 60 secondes : les launchers ouverts basculent en moins d'une
minute, sans redémarrer. Hors ligne, le dernier état connu est conservé.
Cache serveur : 10 secondes.

**Le site** — au choix :

- lire la table directement (même base) :
  `SELECT etat, message, depuis FROM launcher_xenodys WHERE id = 1` ;
- ou appeler `https://auth.onepieceminecraft.fr/api/v1/xenodys`.

Puis poser l'état sur la page, par exemple `<html data-xenodys="corrompue">`,
et redéfinir les couleurs du site sous ce sélecteur. Le site **lit** la table ;
il ne la crée pas et n'y écrit pas.

## La palette

| | `creatrice` | `corrompue` |
|---|---|---|
| Accent principal | `#91D9D1` | `#F0506E` |
| Accent secondaire | `#A6E1DA` | `#C77DFF` |
| Lien / actif sur fond clair | `#1D5C51` | `#6A1F8F` |
| Fond le plus sombre | `#050D0C` | `#0C0510` |
| Surface claire | `#F2FAF8` | `#FAF3F8` |
| Texte clair | `#EAF8F6` | `#F8ECF3` |
| Vidéo de fond | telle quelle | `hue-rotate(115deg) saturate(1.35) contrast(1.06) brightness(.82)` |

Référence complète côté launcher : `launcher/src/assets/css/base/xenodys.css`.

## La bascule

Au moment où l'état change pendant que la page est ouverte, le launcher joue
un court parasitage (1,5 s), puis affiche l'annonce du staff — ou, à défaut,
une phrase de Xenodys. Jamais au premier affichage, jamais si le système
demande de réduire les animations.

## Du launcher au jeu

Le launcher et le **mod OPM** (`mod/`, voir `mod/README.md` ; embarqué dans le launcher,
qui l'installe lui-même dans le jeu) se passent le relais sans que rien ne se voie :

1. **JOUER** : la cinématique (ci-dessous). À l'éclair du passage, la **scène de
   chargement** du launcher apparaît (`components/loadingScene.js`), en **vraie 3D** à la
   résolution de l'écran, sur la salle de simulation. Chorégraphie en boucle de 10 s :
   Xenodys façonne un monde de blocs entre ses mains (il grandit avec le chargement) ;
   sur le circuit, un joueur de la galerie s'imprime, puis est aspiré dans son orbe
   (il tourne, s'étire, et un flot de lumière file vers l'orbe) ; elle vole jusqu'à
   lui, l'orbe est aspiré dans sa paume, elle le rapporte, et le monde l'avale dans
   une spirale. Ses mains visent ce
   qu'elles touchent (cinématique inverse des bras, lissée), sa tête suit ce qu'elle
   fait ; elle reste toujours derrière les autres modèles. Deux assistants : l'un au
   circuit, l'autre en ronde, qui trébuche parfois. La barre avance au prorata du
   chargement précédent (lignes du journal, durée). La fenêtre de chargement de
   NeoForge est désactivée (`config/fml.toml`). « Réduire » (ou Échap) rend la main à
   tout moment : la scène s'efface, le jeu continue de charger.
2. **L'écran de chargement du jeu** (le mod remplace celui de Mojang et de NeoForge) :
   la même scène, en 3D elle aussi (`client/Choreo`, shader `position_tex_color`), à la
   même horloge — `scene_debut` dans `opm/session.json` — et avec les mêmes skins dans
   le même ordre : la chorégraphie continue sans saut. Le launcher s'efface quand il
   s'affiche (`[OPM:READY]`) ; la barre reprend où il l'avait laissée.
3. **L'envol** : le chargement fini, Xenodys s'envole, un assistant salue, l'autre
   trébuche parfois et se relève, le skin du joueur s'imprime (« Bienvenue, … »), et le
   monde s'ouvre dans un éclair — connexion directe au serveur OPM. Passable (clic,
   Échap, Espace, Entrée).
4. **La musique** du launcher ne s'arrête pas : elle continue, fenêtre masquée, jusqu'à
   ce que le jeu la reprenne (`[OPM:MUSIC]`) — les mêmes compositions, enregistrées par
   `xenodys/musique/` — dans tous les menus.
5. **L'écran titre** (après une déconnexion, ou sans connexion directe) : le menu à
   gauche (rejoindre One Piece Minecraft — seul serveur possible —, options, mods,
   quitter ; statut du serveur, journal de bord) ; à droite, le joueur sur son socle et
   Xenodys en vraie 3D (le modèle GeckoLib). Créatrice, elle veille sur lui ; son regard
   suit la souris, regarde le bouton survolé, revient au joueur, et elle tend la main
   quand on rejoint le serveur. Corrompue, elle le tient sous son emprise : main en
   griffe au-dessus de lui, fils rouges, et lui qui se protège le visage.
6. **Les autres menus, hors partie** (options depuis l'écran titre, connexion,
   déconnexion) : la salle de simulation en fond, boutons et curseurs aux couleurs du
   launcher. **En jeu, rien ne change** : le menu pause et les écrans de la partie gardent
   l'apparence que leur donne le pack de ressources du serveur (le style OPM ne
   s'applique ni dans le monde, ni dès qu'un pack du serveur est actif). Le pack du serveur,
   mis en cache par Minecraft (`downloads/`), n'est plus effacé par la vérification des
   fichiers : il n'est pas retéléchargé à chaque connexion. Dans le menu pause, « Donner son avis »
   et « Signaler un bug » deviennent le site et le Discord d'OPM. Dans le menu pause,
   Xenodys passe parfois la tête par le coin bas-droit et dit un mot (l'annonce du staff
   s'il y en a une).
7. **La connexion** : le joueur, sur son socle, se défait en pixels qui filent vers un
   orbe, qu'un anneau entoure jusqu'à l'entrée dans le monde.
8. **La première arrivée** sur le serveur : un éclair, et Xenodys, immense, tout près, la
   main tendue — elle dépose le joueur sur Grand Line, puis s'envole.
9. **Xenodys en jeu** : `/xenodys apparaitre [anim]` (staff) — elle apparaît à 8 blocs,
   immense, et suit les joueurs du regard. Aucune installation sur le serveur.
10. **L'écran titre suit le serveur** : hors ligne, elle se détourne et cherche le monde ;
    complet, elle lève la main. L'état de Xenodys et l'annonce du staff se relisent en
    jeu toutes les minutes, sans redémarrer.

**Anti-triche, de bout en bout** (rien n'est sanctionné automatiquement : le staff juge) :
le launcher refuse de lancer un jeu dont les mods ne sont pas ceux du modpack, et en
déclare l'empreinte au serveur d'authentification, qui n'ouvre le serveur de jeu qu'à une
session conforme ; en jeu, le mod OPM rapporte mods et packs (X-ray repérés) ; le serveur
Minecraft surveille vol, vitesse, portée et minerais (`minecraft/anticheat.sk`). Chaque
soupçon arrive au staff (en jeu, `/alertes`, et sur Discord) et le joueur voit Xenodys
corrompue surgir au coin de son écran : « Je te vois… ». `/surveiller <joueur>` la fait
apparaître près de lui, immense.

Le launcher écrit pour le mod `opm/session.json` (état, pseudo, serveur, galerie,
liens ; jamais de jeton) ; le mod n'en a pas besoin pour fonctionner (valeurs par
défaut). Réglages du launcher : « Rejoindre directement le serveur » et « Chargement
animé par Xenodys ».

## Dans le launcher

- **Fenêtre ouverte** (réglage `launcher.window_open`, Windows et macOS, écran assez
  grand) : la fenêtre est transparente et plus grande que le launcher. Autour du cadre, un
  décor en pixel art (`components/surround.js`) : nappe sombre tramée, circuits (ou
  fissures), cubes, bords du cadre qui s'effritent. Les clics sur la marge vide traversent
  jusqu'au bureau. Sinon, mode compact : la fenêtre classique.
- **Xenodys elle-même** (`components/xenodys3d.js`) : le modèle de `xenodys/`, immense,
  courbée derrière le launcher (`lean` / `corrupted_lean`), le bas du corps caché par lui ;
  elle regarde le joueur. Sa main gauche agrippe le bord droit du cadre, sa main droite
  son coin haut-droit (les boutons de la fenêtre s'en écartent) ; seuls ses doigts passent
  devant. Les mains ne bougent pas. Deux assistants l'accompagnent : l'un se cache au
  coin bas-gauche du cadre et passe la tête, l'autre se tient près d'elle et salue.
- **Son arrivée** : à l'ouverture, le cadre se construit d'abord, ligne à ligne
  (`components/intro.js`), puis elle arrive. Créatrice : elle descend du haut, se penche ;
  chaque main approche ouverte, se pose sur sa prise et se referme (un « clac », le cadre
  qui tressaille) ; ses assistants accourent. Corrompue : elle surgit en glitch à deux ou
  trois endroits, se fige, et ses mains griffues s'abattent sur le cadre — des fissures
  partent de ses doigts. Rejouée au retour d'une partie.
- **Sa vie** : sa tête suit la souris (jamais ses mains) ; elle cligne des yeux (textures
  `*_blink`) ; au survol de JOUER, elle regarde le bouton et ses lumières s'avivent ; un
  lancement raté : elle détourne la tête avec mépris (corrompue : un rire haché). Quand
  son état bascule launcher ouvert, l'onde part de son cœur et le thème change à son
  passage ; la grille du fond se casse un instant, le bocal tombe sur le joueur (ou
  remonte).
- **Le fond : une salle de simulation** (`components/lab.js`) : sol quadrillé en
  perspective, mur de calibration, impulsions de données, balayage de scan, repères ; la
  grille bat sur les temps de la musique. Corrompue : magenta, pans décalés, cases
  éteintes, scan d'alerte. Par-dessus, les circuits de Xenodys (`components/circuits.js`)
  et un voile de teinte selon l'état.
- **La musique** (`components/ambiance.js`, réglages `launcher.ambiance` et
  `launcher.volume`) : composée en direct par le launcher, sans fichier audio — une
  musique générative sur une grille d'accords. Créatrice : un laboratoire calme (ré
  lydien, ~70 BPM ; nappes, basse ronde, cloches de verre en écho, pings de données).
  Corrompue : étrange, tendue, stressante (do phrygien, ~96 BPM ; ostinato de basse,
  clusters dissonants, frappes métalliques, tic-tac, battement de cœur, montées,
  coupures). Fondu de l'une à l'autre ; silence pendant une partie et launcher réduit.
- **Les sons de l'interface** (`components/sfx.js`, réglage `launcher.sfx`) : petits
  bruits mécaniques et électroniques synthétisés (survol, clic, onglet, interrupteur,
  cinématique).
- **Le personnage du joueur** (`components/character3d.js`, `components/socle.js`) :
  exposé sur un socle de circuit imprimé en voxels, tourné vers la droite, il respire ; les
  circuits de Xenodys se dessinent autour de lui. Corrompue : il est enfermé dans un bocal
  d'expérience, et il a peur.
- **La cinématique du lancement** (fenêtre ouverte) : dès le clic sur JOUER, Xenodys lâche
  le cadre, vole devant lui, nous tourne le dos ; le joueur se défait en pixels et file
  entre ses mains (corrompue : son bocal éclate) ; le launcher rétrécit jusqu'à n'être
  qu'un orbe. Pendant la préparation des fichiers, l'orbe attend : un anneau et une
  étiquette en disent l'avancement, et le cliquer ramène le launcher. Quand le jeu
  démarre, elle ouvre les bras et une onde de lumière (ou de blocs rouges et violets)
  envahit la fenêtre. Le launcher reste au premier plan pendant ce temps (la fenêtre du
  jeu s'ouvre derrière lui) et ne se masque qu'à la fin. Au retour du jeu, le cadre se
  reconstruit et elle revient.
