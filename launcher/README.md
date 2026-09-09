# OPM Launcher

Le launcher officiel de **One Piece Minecraft** : une application Electron qui authentifie
le joueur auprès du serveur OPM, télécharge le jeu et le lance.

Il ne parle jamais directement à Microsoft ni à Mojang. Tout passe par
`auth-server/`, qui détient seul les secrets et rend un profil Yggdrasil maison —
c'est ce que le launcher passe à `minecraft-java-core`.

---

## 1. Démarrer

```bash
cd New/launcher
npm install
npm run fonts     # télécharge Anton + Space Grotesk dans src/assets/fonts/ (une fois)
npm start         # lance le launcher
```

`npm run fonts` n'est à faire qu'une fois : les fichiers sont ensuite versionnés avec le
projet. Le launcher démarre sans eux, mais avec les polices de repli de
`src/assets/css/base/fonts.css` — proches, pas identiques.

| Commande | Effet |
|---|---|
| `npm start` | Lance le launcher en mode développement |
| `npm run dev` | Idem, avec rechargement à chaud (`nodemon`) et outils Chromium ouverts |
| `npm run fonts` | Récupère les polices ; ne fait rien si elles sont déjà là |
| `npm run icon` | Régénère `icon.ico`, `icon.icns`, `icon.png` depuis `logo-opm.png` |
| `npm run build` | Compile pour la plateforme courante, **sans obfuscation** |
| `npm run build:dir` | Paquet non installable, pour vérifier en quelques secondes |
| `npm run build:obf` | Compile **avec** obfuscation — à éviter, voir § 5 |

En mode développement, les données (comptes, coffre chiffré, journaux, jeu téléchargé)
vivent dans `./data` à côté des sources, jamais dans le profil utilisateur : on peut tout
effacer d'un coup sans toucher à une installation réelle.

Pour travailler contre un serveur d'authentification local :

```bash
OPM_API_URL=http://127.0.0.1:8000 npm start        # bash / zsh
$env:OPM_API_URL="http://127.0.0.1:8000"; npm start # PowerShell
```

Toutes les variables reconnues sont documentées dans [`.env.example`](.env.example).

---

## 2. Arborescence

```
launcher/
├── build.js                    compilation (electron-builder), signature, empreintes
├── entitlements.mac.plist      dérogations « hardened runtime » exigées par Electron
├── scripts/
│   ├── fetch-fonts.js          télécharge les polices Google, une fois pour toutes
│   └── make-icons.js           logo-opm.png → icon.ico / icon.icns / icon.png
└── src/
    ├── app.js                  processus principal : sécurité, instance unique, démarrage
    ├── preload.js              seule passerelle renderer ↔ principal (contextBridge)
    ├── launcher.html           coque de l'application : splash, connexion, shell
    ├── panels/                 fragments HTML chargés à la demande
    │   ├── home.html  ·  donation.html  ·  settings.html
    ├── windows/
    │   └── mainWindow.js       fenêtre 1280 × 764 sans cadre
    ├── main/
    │   ├── ipc.js              tous les canaux IPC — miroir exact de docs/IPC.md
    │   ├── auth/
    │   │   ├── api.js          client HTTP du serveur d'authentification
    │   │   ├── accounts.js     comptes locaux, jetons, rafraîchissement
    │   │   └── microsoft.js    fenêtre du code d'appareil Microsoft
    │   └── services/
    │       ├── paths.js        source unique de vérité des chemins
    │       ├── store.js        configuration locale, validée à la lecture
    │       ├── vault.js        refresh_token chiffrés (safeStorage, repli AES-256-GCM)
    │       ├── game.js         lancement du jeu (minecraft-java-core)
    │       ├── content.js      actualités, statut serveur, cagnotte — avec cache
    │       ├── updater.js      mise à jour du launcher (electron-updater)
    │       └── logger.js       journal tournant
    └── assets/
        ├── css/                tokens → fonts → reset → layout → components → panels
        ├── js/                 renderer (modules ES natifs)
        ├── fonts/              WOFF2 produits par `npm run fonts`
        ├── images/             logo, icônes applicatives, illustrations
        │   └── svg/            icônes monochromes réutilisables (voir § 3)
        └── videos/             fond animé de la coque
```

Le dossier `src/` garde son nom **jusque dans le paquet compilé** :
`src/main/services/paths.js` résout les panneaux comme `<appPath>/src/panels`. Le
renommer casserait le chargement des panneaux — c'est pour ça que `build.js` recopie
l'arborescence à l'identique au lieu de la renommer en `app/` comme le faisait
l'ancien launcher.

---

## 3. Les icônes SVG

`src/assets/images/svg/` contient dix-sept icônes monochromes, tracées d'après la
maquette : `discord`, `twitch`, `youtube`, `web`, `close`, `minimize`, `maximize`,
`restore`, `chevron`, `eye`, `eye-off`, `copy`, `check`, `trash`, `refresh`, `folder`,
`warning`.

Elles n'ont **pas** vocation à remplacer les SVG déjà inscrits dans `launcher.html` :
celles-là sont en ligne, donc colorables et animables directement par le CSS. Ces
fichiers-ci servent partout où un SVG en ligne n'est pas possible — `background-image`
CSS, `<img>`, notification système, futur panneau chargé dynamiquement.

Toutes emploient `stroke="currentColor"` : elles prennent la couleur du texte
environnant. En `background-image`, `currentColor` ne s'applique plus (le fichier est
chargé comme document indépendant) ; passez alors par un `mask-image`, qui laisse la
couleur au CSS :

```css
.mon-icone {
  background-color: var(--foam);
  mask-image: url('../images/svg/refresh.svg');
  mask-size: contain;
}
```

Les trois icônes de fenêtre (`close`, `minimize`, `maximize`) reprennent le gabarit
11 × 11 de la maquette ; `restore` a été dessiné dans le même trait pour compléter la
paire. Les autres sont en 24 × 24.

---

## 4. Compiler

```bash
npm run build
```

Produit dans `dist/` la cible de **la machine sur laquelle la commande tourne** :

| Machine | Sortie |
|---|---|
| Windows | `OPMLauncher-win-x64.exe` (installeur NSIS) + `latest.yml` |
| macOS | `OPMLauncher-mac-universal.dmg` + `.zip` + `latest-mac.yml` |
| Linux | `OPMLauncher-linux-x64.AppImage` + `latest-linux.yml` |

Plus un fichier `SHA256SUMS`, à publier à côté des binaires.

On ne peut pas tout compiler depuis une seule machine : un `.dmg` signé et notarisé
exige un vrai macOS, `codesign` et `notarytool` étant des outils Apple. C'est le rôle de
[`.github/workflows/release.yml`](../.github/workflows/release.yml) — trois machines,
déclenchées par un tag `vX.Y.Z`.

Les fichiers `latest*.yml` ne sont pas accessoires : c'est par eux qu'`electron-updater`
découvre qu'une nouvelle version existe. Sans eux, la mise à jour automatique est morte.

`build.js` accepte quelques options :

```bash
node build.js --build=linux      # forcer une cible
node build.js --dir              # paquet non installable, essai rapide
node build.js --publish=always   # publier la release GitHub (exige GH_TOKEN)
node build.js --obf=true         # obfusquer — lisez le § 5 d'abord
```

**La compilation réussit sans aucun certificat.** Elle produit alors des binaires non
signés et le dit clairement en console. Vous pouvez donc mettre toute la chaîne en place
avant d'acheter quoi que ce soit.

---

## 5. Pourquoi l'obfuscation est désactivée

L'ancien launcher obfusquait tout `src/` par défaut. C'est la première cause de faux
positifs antivirus : du JavaScript obfusqué, empaqueté dans une archive `asar`, dans un
installeur NSIS, c'est la signature comportementale exacte d'un *dropper*. Avast, McAfee
et Defender se déclenchent là-dessus, signature de code ou pas.

Et elle ne protège rien : `npx asar extract` ouvre le paquet en une commande.

`npm run build:obf` reste disponible pour qui y tient — avec un avertissement en console
et l'assurance de devoir déclarer des faux positifs à chaque version. `preload.js` n'est
jamais obfusqué : c'est la seule passerelle entre l'interface et le système, elle doit
rester auditable.

Le détail complet, et les autres réflexes gratuits qui font baisser les détections,
sont dans [`docs/BUILD.md`](../docs/BUILD.md) § 3.

---

## 6. À configurer avant la production

Rien de tout cela n'empêche de compiler ni de tester ; tout est nécessaire avant
d'ouvrir le launcher aux joueurs.

1. **Le serveur d'authentification.** `src/main/auth/api.js` pointe par défaut sur
   `https://auth.onepieceminecraft.fr`. Vérifiez que le domaine existe, répond en HTTPS
   et sert bien `auth-server/`.

2. **Le dépôt de publication.** `repository.url` du `package.json` détermine où
   `electron-updater` va chercher les mises à jour. S'il est faux, le launcher ne se
   mettra jamais à jour.

3. **`package-lock.json` versionné.** `npm ci`, dans GitHub Actions, en dépend. Lancez
   `npm install` une fois en local et commitez le fichier produit.

4. **Le logo en 1024 px.** `src/assets/images/logo-opm.png` fait 512 × 512 : les icônes
   Retina de macOS sont donc obtenues par agrandissement, et légèrement molles sur le
   Dock d'un Mac récent. Si le logo existe en vectoriel, exportez-le une fois en
   1024 × 1024 et relancez `npm run icon`.

5. **Les certificats de signature.** Windows et macOS, avec leurs coûts réels et le
   choix recommandé, dans [`docs/BUILD.md`](../docs/BUILD.md) § 4. Sans eux :
   SmartScreen avertit, Gatekeeper refuse d'ouvrir l'application, et `electron-updater`
   ne peut pas vérifier la provenance d'une mise à jour — c'est le vrai argument.

6. **Les secrets GitHub Actions.** À déposer dans `Settings → Secrets and variables →
   Actions`. Le workflow réussit sans eux ; chacun est commenté à l'endroit où il sert.

7. **Les URL de téléchargement.** Une fois la première release publiée, renseignez-les
   dans `statistiques.launcher_windows`, `launcher_mac` et `launcher_linux` de la base
   du site : c'est de là que le site et le launcher servent la page de téléchargement.

8. **Une pré-version sur VirusTotal** avant la première publication publique. Vous
   saurez lequel des soixante-dix moteurs râle, et sur quoi.

---

## 7. Documents de référence

| Document | Contenu |
|---|---|
| [`docs/API.md`](../docs/API.md) | Contrat REST et Yggdrasil du serveur d'authentification |
| [`docs/IPC.md`](../docs/IPC.md) | Contrat IPC Electron — `src/main/ipc.js` en est le miroir |
| [`docs/DATA.md`](../docs/DATA.md) | Base de données, caches, stratégie de mot de passe |
| [`docs/BUILD.md`](../docs/BUILD.md) | Compilation, icônes, antivirus, signature |
| [`docs/UI-SPEC.md`](../docs/UI-SPEC.md) | Intégration visuelle, d'après la maquette |
