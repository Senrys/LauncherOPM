# Compilation, icônes et signature

> Objectif : produire `OPMLauncher-win-x64.exe`, `OPMLauncher-mac-universal.dmg` et
> `OPMLauncher-linux-x64.AppImage`, à l'icône du serveur, signés, et qui ne déclenchent
> ni SmartScreen ni les antivirus.

---

## 1. Les commandes

```bash
cd New/launcher
npm install
npm run fonts        # embarque Anton + Space Grotesk (une seule fois)
npm run icon         # régénère icon.ico / icon.icns / icon.png depuis logo-opm.png
npm run build        # compile pour la plateforme courante
```

`npm run build` produit dans `dist/` la cible de **la machine sur laquelle il tourne** :

| Machine | Sortie |
|---|---|
| Windows | `OPMLauncher-win-x64.exe` (installeur NSIS) + `latest.yml` |
| macOS | `OPMLauncher-mac-universal.dmg` + `.zip` + `latest-mac.yml` |
| Linux | `OPMLauncher-linux-x64.AppImage` + `latest-linux.yml` |

**On ne peut pas tout compiler depuis Windows.** Un `.dmg` signé et notarisé exige un vrai macOS
(les outils `codesign` et `notarytool` sont Apple, sans équivalent). C'est pour ça que la
compilation des trois cibles passe par GitHub Actions (§5) : trois machines, une seule commande.

Les fichiers `latest*.yml` sont indispensables à `electron-updater` — c'est eux qui permettent
au launcher de se mettre à jour tout seul. Ils doivent être publiés à côté des exécutables.

---

## 2. Les icônes

Source unique : `src/assets/images/logo-opm.png`, **512 × 512 avec transparence**.
`npm run icon` en dérive les trois formats via `jimp` + `png2icons` :

| Fichier | Contenu | Usage |
|---|---|---|
| `icon.ico` | 16, 24, 32, 48, 64, 128, 256 | Windows : exécutable, installeur, barre des tâches |
| `icon.icns` | 16 → 1024 | macOS : Dock, Finder, dmg |
| `icon.png` | 512 | Linux : AppImage, lanceur de bureau |

> **Une remarque de graphiste :** 512 px suffit partout sauf sur les écrans Retina, où macOS
> réclame une variante 1024. Elle sera obtenue par agrandissement, donc légèrement molle sur
> le Dock d'un MacBook récent. Si vous avez le logo en vectoriel (`.ai`, `.svg`), exportez-le
> une fois en **1024 × 1024 PNG** et remplacez `logo-opm.png` : tout le reste se régénère seul.

L'icône du **dmg** et le fond de la fenêtre de montage sont configurés séparément dans
`build.js` (`dmg.background`, `dmg.iconSize`) — c'est la première chose que voit un joueur Mac.

---

## 3. Antivirus : les causes réelles, dans l'ordre

Avant de payer quoi que ce soit, sachez qu'**une bonne partie des faux positifs vient du build
lui-même**, pas de l'absence de signature.

### 3.1 L'obfuscation — la cause n°1

L'ancien `build.js` lançait `javascript-obfuscator` en preset `medium-obfuscation` sur tout
`src/`, et `npm run build` l'activait par défaut (`--obf=true`).

Du JavaScript obfusqué, empaqueté dans une archive `asar`, dans un installeur NSIS : c'est la
signature comportementale exacte d'un *dropper*. Les heuristiques d'Avast, McAfee et Defender
se déclenchent là-dessus, signature de code ou pas.

**Le nouveau `build.js` met donc `--obf=false` par défaut.** L'obfuscation d'un launcher Electron
ne protège de toute façon rien : n'importe qui peut ouvrir l'`asar` avec `npx asar extract`. Elle
coûte des faux positifs et n'achète aucune sécurité. Si vous y tenez, `npm run build:obf` existe,
mais attendez-vous à devoir déclarer des faux positifs à chaque version.

### 3.2 Les autres réflexes, tous gratuits

- **Aucun packer** (UPX, Themida…). Même effet que l'obfuscation, en pire.
- **Signer l'installeur *et* l'exécutable interne**, plus toute DLL embarquée. electron-builder
  le fait seul dès que le certificat est configuré.
- **Publier les empreintes SHA-256** à côté des binaires, et passer chaque version sur
  [VirusTotal](https://virustotal.com) avant publication. Vous saurez lequel des 70 moteurs
  râle, et sur quoi.
- **Déclarer les faux positifs** — c'est gratuit et ça marche, sous 24 à 72 h :
  Microsoft Defender via le portail *Submit a file for analysis*, puis Avast, Kaspersky,
  Bitdefender qui ont chacun un formulaire équivalent. À refaire à chaque version majeure
  tant que la réputation n'est pas établie.
- **Garder le même certificat et le même nom d'éditeur** d'une version à l'autre : la réputation
  SmartScreen s'accumule sur le couple certificat + éditeur. En changer la remet à zéro.
- **Installeur non silencieux.** L'ancienne config utilisait `oneClick: true` + `runAfterFinish`,
  c'est-à-dire un installeur qui s'exécute sans rien demander puis lance un programme — encore un
  motif classique de détection. Le nouveau build passe en `oneClick: false` avec une page de
  bienvenue et le choix du dossier. Un clic de plus pour le joueur, beaucoup moins d'alertes.

---

## 4. La signature de code

C'est la partie payante, et il n'existe **aucune option gratuite** qui fasse taire SmartScreen.
Voici le paysage réel, sans enrobage.

### 4.1 Windows

Depuis le 1ᵉʳ juin 2023, la clé privée d'un certificat de signature publiquement reconnu **doit
vivre dans un matériel certifié FIPS 140-2 niveau 2** : clé USB ou HSM dans le nuage. Les
fichiers `.pfx` posés sur le disque, c'est fini pour les nouveaux certificats.

| Option | Prix indicatif | Effet sur SmartScreen | Contrainte |
|---|---|---|---|
| **OV** (Sectigo, Certum, SSL.com) | 150–400 €/an | Enlève « Éditeur inconnu ». L'avertissement SmartScreen persiste jusqu'à ce que la réputation monte (quelques centaines de téléchargements) | Token USB physique |
| **EV** (DigiCert, Sectigo, SSL.com) | 300–700 €/an | **Réputation immédiate**, aucun avertissement dès la première version | Entité légale enregistrée + token |
| **Certum Open Source / individuel** | ~100–150 €/an | Comme l'OV | Le moins cher ; accessible à un particulier avec pièce d'identité |
| **Azure Trusted Signing** | ~10 $/mois | Comme l'EV | Signature dans le nuage, pratique en CI — mais exige 3 ans d'existence vérifiable de l'organisation, **et c'est du Microsoft** |

Ma recommandation pour OPM, dans l'ordre :

1. **Si l'association ou la société existe depuis 3 ans et plus** : un certificat **EV**, ou
   Azure Trusted Signing si le budget est serré. La réputation immédiate est ce qui compte —
   un joueur qui voit « Windows a protégé votre ordinateur » ne poursuit pas l'installation.
2. **Sinon** : **Certum**, l'option la moins chère, en acceptant quelques semaines d'avertissement
   le temps que la réputation se construise. Combiné aux réflexes du §3, ça passe.

> Sur la souveraineté : Azure Trusted Signing est un service Microsoft, ce qui jure un peu avec
> tout le travail fait sur l'authentification. Mais les deux sujets n'ont rien à voir — signer un
> binaire n'expose aucune donnée de joueur, et Certum, DigiCert ou SSL.com sont des solutions
> européennes ou indépendantes équivalentes. C'est votre choix, pas une contrainte technique.

La signature est lue par `electron-updater` : c'est elle qui lui permet de vérifier qu'une mise à
jour vient bien de vous (`verifyUpdateCodeSignature`). Sans certificat, il faut désactiver cette
vérification, et n'importe qui capable de détourner l'URL de mise à jour peut pousser du code
sur les machines de vos joueurs. **C'est le vrai argument pour signer, bien avant SmartScreen.**

### 4.2 macOS

Non négociable : sans signature **et** notarisation, Gatekeeper refuse purement et simplement
d'ouvrir l'application. Il n'y a pas de « continuer quand même » simple pour un joueur.

1. **Apple Developer Program** — 99 €/an, c'est le seul tarif.
2. Certificat **Developer ID Application** (et *Installer* si un `.pkg` est ajouté un jour).
3. `hardenedRuntime: true` + les *entitlements* nécessaires à Electron
   (`allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`).
4. **Notarisation** : `notarytool` envoie le paquet à Apple, qui l'analyse et le tamponne,
   puis `stapler` colle le tampon dans le `.dmg`. electron-builder ≥ 24 s'en charge avec
   `notarize: true` et les variables `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

Comptez 5 à 20 minutes de notarisation par version, à la charge d'Apple.

### 4.3 Linux

Il n'existe pas d'infrastructure de confiance équivalente, et les antivirus n'y sont pas un sujet.
La pratique consiste à publier, à côté de l'AppImage :

- un fichier `SHA256SUMS` ;
- une signature GPG détachée `SHA256SUMS.asc` avec la clé du serveur ;
- la clé publique GPG sur `onepieceminecraft.fr`.

`appimagetool --sign` permet aussi d'embarquer la signature dans l'AppImage.

---

## 5. Compilation des trois cibles en une fois

`.github/workflows/release.yml` — trois machines en parallèle, déclenché par un tag `v*` :

```yaml
strategy:
  matrix:
    include:
      - os: windows-latest   # → .exe + latest.yml
      - os: macos-latest     # → .dmg + .zip + latest-mac.yml
      - os: ubuntu-latest    # → .AppImage + latest-linux.yml
```

Secrets à déposer dans le dépôt (`Settings → Secrets and variables → Actions`) :

| Secret | Pour |
|---|---|
| `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | certificat Windows (ou variables Azure Trusted Signing) |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | notarisation macOS |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | certificat Developer ID |
| `GH_TOKEN` | publication de la *release* |

**Sans ces secrets, le build fonctionne quand même** : electron-builder produit simplement des
binaires non signés. Vous pouvez donc mettre la chaîne en place tout de suite et ajouter les
certificats plus tard, sans rien réécrire.

Dernière étape, une fois les binaires publiés : renseigner leurs URL dans
`statistiques.launcher_windows`, `launcher_mac` et `launcher_linux` — c'est ce que le site et le
launcher servent en page de téléchargement.

---

## 6. Ordre de mise en production conseillé

1. `npm run build` sans signature → vérifier que les trois binaires s'installent et se lancent.
2. Mettre en place GitHub Actions, publier une pré-version, la passer sur VirusTotal.
3. Acheter le certificat Windows et l'adhésion Apple, brancher les secrets.
4. Publier la première version signée, déclarer les éventuels faux positifs restants.
5. Activer `verifyUpdateCodeSignature` dans `electron-updater` — la mise à jour automatique
   devient alors vérifiée de bout en bout.
