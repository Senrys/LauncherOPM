# Spécification d'intégration UI

> **Source de vérité visuelle :** `DesignMaquette/Launcher OPM.dc.html`.
> Ce document ne remplace pas la maquette : il la traduit en fichiers, classes et règles.
> En cas de doute sur une valeur, **la maquette gagne**.

---

## 1. Règles absolues

1. **Aucune couleur, ombre, rayon ou police en dur** hors de `assets/css/base/tokens.css`.
   Tout le reste utilise `var(--…)`.
2. Les deux polices sont **Anton** (titres, onglets, chiffres vedettes, bouton JOUER) et
   **Space Grotesk** (tout le reste, graisses 400/500/600/700). Aucune autre police.
3. Les `letter-spacing` des kickers/onglets/boutons sont **structurants** : les respecter.
   `.22em` sur les kickers 10 px, `.18em` sur les kickers 9 px, `.09em` sur les onglets Anton.
4. Les quatre `@keyframes` de la maquette (`opmPulse`, `opmShimmer`, `opmFloat`, `opmRise`)
   sont déjà dans `tokens.css` — les réutiliser, ne pas les redéclarer.
5. Convention de classes : `opm-<bloc>__<élément>--<état>`, préfixe `opm-` systématique.
   Pas de styles en attribut `style=` sauf valeurs calculées au runtime
   (largeur de jauge, position d'un curseur d'interrupteur, opacité).
6. Le HTML des panneaux est **statique et sémantique** ; le JS ne fait que peupler
   et basculer des classes. Pas de gros `innerHTML` de mise en page.
7. Accessibilité : tout élément cliquable non-`<button>`/`<a>` porte
   `role="button"` + `tabindex="0"` + gestion `Enter`/`Espace`.
   Les onglets utilisent `role="tab"` / `aria-selected`. Focus visible partout
   (`:focus-visible { box-shadow: var(--sh-focus) }`).
8. La fenêtre est **redimensionnable** (min 1100 × 700). La maquette est calée sur
   1280 × 764 : les hauteurs fixes (46 / 96) restent fixes, le reste est fluide.
   `.opm-news` passe de `flex: 0 0 620px` à `flex: 1 1 480px; min-width: 420px` sous 1240 px.

---

## 2. Arborescence des fichiers de style

| Fichier | Portée |
|---|---|
| `base/tokens.css` | variables, keyframes, `prefers-reduced-motion` *(déjà écrit)* |
| `base/fonts.css` | `@font-face` Anton + Space Grotesk (fichiers locaux `assets/fonts/`) |
| `base/reset.css` | reset, `box-sizing`, scrollbars, `input[type=range]`, focus |
| `layout/shell.css` | fenêtre, vidéo de fond, les deux voiles en dégradé, splash |
| `layout/titlebar.css` | barre de titre 46 px : logo, onglets, version, boutons fenêtre |
| `layout/rail.css` | rail social 60 px |
| `layout/bottombar.css` | barre du bas 96 px : compte, progression, auto, JOUER |
| `components/*.css` | `button`, `switch`, `card`, `chip`, `popover`, `field`, `toast` |
| `panels/home.css` | écran Accueil |
| `panels/settings.css` | écran Paramètres + ses 4 sous-écrans |
| `panels/donation.css` | écran Donation |
| `panels/login.css` | écran Connexion (**absent de la maquette — voir §6**) |

`launcher.html` charge dans cet ordre : `tokens → fonts → reset → layout/* → components/* → panels/*`.

---

## 3. Gabarit de la fenêtre

```
┌───────────────────────────────────────────────────── 1280 ──┐
│ barre de titre                                    46 px      │  --veil-90, bordure bas --line-dark-soft
├──────┬───────────────────────────────────────────────────────┤
│ rail │                                                       │
│ 60px │  écran actif (padding 26px 28px)          620 px      │  flex:1
│      │                                                       │
├──────┴───────────────────────────────────────────────────────┤
│ barre du bas                                      96 px      │  --veil-95, bordure haut --line-dark-soft
└──────────────────────────────────────────────────────────────┘
```

Sous la fenêtre, deux couches empilées, toujours présentes :
1. `<video>` `assets/videos/opmback2.mp4`, `object-fit: cover`, `muted loop autoplay playsinline`.
2. Voile A : `linear-gradient(102deg, rgba(6,16,15,.88) 0%, rgba(6,16,15,.66) 42%, rgba(6,16,15,.18) 70%, rgba(6,16,15,.5) 100%)`
3. Voile B : `linear-gradient(180deg, rgba(6,16,15,.45) 0%, rgba(6,16,15,0) 20%, rgba(6,16,15,0) 60%, rgba(6,16,15,.86) 100%)`

Repli si la vidéo échoue (`error` / `videoBackground:false`) :
`linear-gradient(180deg, #7FB6D8 0%, #A9CFE2 45%, #2C6C86 100%)`.

**Zone de glissement** : la barre de titre est `-webkit-app-region: drag`, sauf onglets et
boutons qui sont `no-drag`.

---

## 4. Écran par écran

### 4.1 Barre de titre
- Logo 28×28 + « ONE PIECE MINECRAFT » (Anton 15 px, `.06em`, `--text-light`)
  + badge « LAUNCHER » (Space Grotesk 700 9 px, `.2em`, fond `--aqua`, texte `--ink`, r 3 px).
- Onglets **ACCUEIL / PARAMÈTRES / DONATION** : Anton 15 px, `.09em`, pleine hauteur,
  actif = fond `rgba(145,217,209,.16)` + texte blanc + barre 3 px `--aqua` en bas
  (`left:14px; right:14px; border-radius:3px 3px 0 0`), inactif = `--text-light-62`.
  Survol : `rgba(145,217,209,.14)`.
- À droite : pastille `--aqua` 6 px en `opmPulse 2.4s` + version (Space Grotesk 500 10.5 px, `.14em`,
  `--text-light-50`) — **la version vient de `window.opm.app.version()`**, pas en dur.
- Boutons fenêtre : 38×44 / 38×44 / 44×44, icônes SVG trait 1.4, couleur `--text-light-60`.
  Survol : `rgba(255,255,255,.08)` ; le bouton fermer vire à `--danger` avec `border-radius: 0 12px 0 0`.

### 4.2 Rail social (60 px)
4 tuiles 38×38, r 9 px, fond `rgba(255,255,255,.05)`, bordure `rgba(145,217,209,.18)`,
icône `--aqua` 18–19 px. Survol : fond `--aqua`, icône `--ink`, `translateY(-2px)`.
Séparateur 20×1 px `--line-dark` entre la 3ᵉ et la 4ᵉ.
Ordre : Discord, Twitch, YouTube, ─, Site. URLs issues de `bootstrap.links`.

### 4.3 Accueil
Deux colonnes, `gap: 24px`.

**Gauche — carte « journal de bord »** (620 px, `--paper`, bordure `--line-2`, r 10 px, `--sh-card`) :
- Kicker : carré 9×9 `--aqua` + « JOURNAL DE BORD » + date de mise à jour à droite.
- `h1` Anton 37 px, `line-height:.96` — 2ᵉ ligne en `--teal`.
- Paragraphe 13.5px/1.55 `--text-body`, `max-width:520px`, `text-wrap:pretty`.
- 2 liens : le 1ᵉʳ `--teal` 700 12 px souligné 2 px `--aqua`, le 2ᵉ `--muted` 500 12 px.
- Séparateur 1 px `#DEEDE9` avec marge latérale 28 px.
- Liste de 3 news : étiquette (`ACTUALITÉ` = `--chip`/`--teal`, `ÉVÉNEMENT` = `--aqua`/`--ink`),
  titre 600 13 px tronqué, date `--muted-2`. Survol de ligne : `--mist-2`, r 7 px, `margin:0 -10px`.
- 3 tuiles 178 px en bas : « EN LIGNE MAINTENANT » (blanche, 8 segments), « PROCHAIN ÉVÉNEMENT RP »
  (`--ink`, compte à rebours Anton 23 px), « VOTES DU MOIS » (`--aqua`, bouton « VOTER · COFFRE »).

**Droite — scène du personnage** :
- Badge « SERVEUR EN LIGNE » en haut à droite (`--veil-84`, pastille `opmPulse 2s`, TPS + host).
- Halo : cercle 400 px `radial-gradient(closest-side, rgba(145,217,209,.32), transparent)` en bas à droite.
- `melodia.webp` hauteur 404 px, `image-rendering:pixelated`,
  `filter: drop-shadow(-22px 16px 34px rgba(0,0,0,.55))`, `animation: opmFloat 7s ease-in-out infinite`.
  **Remplacé par le rendu du skin du joueur connecté quand il est disponible** ; `silhouette.png` sinon.
- En bas à gauche : kicker « VOTRE PERSONNAGE », pseudo Anton 26 px, sous-titre `--text-light-66`.

### 4.4 Paramètres
Colonne de navigation 206 px + carte claire `flex:1` (`--paper`, r 10 px, `overflow: hidden auto`, padding 26/30).
- Titre « PARAMÈTRES » Anton 24 px `--text-light`.
- 4 entrées 44 px, r 7 px, Space Grotesk 700 12.5 px `.12em`, bordure `--line-dark` :
  active = fond `--aqua` + texte `--ink` ; inactive = fond `--veil-55` + texte `rgba(234,248,246,.8)`.
  Survol : `border-color: var(--aqua)`.
  **Ordre : COMPTES, JAVA & MÉMOIRE, RÉSOLUTION, LAUNCHER.**
- Encart « ÉTAT DES FICHIERS » + bouton « TOUT RÉINITIALISER » (40 px, bordure `rgba(234,248,246,.22)`).
- Chaque sous-écran s'ouvre en `animation: opmRise .28s ease both`.

Sous-écrans — structure commune : kicker (carré 9 px + libellé) → `h2` Anton 29 px → paragraphe → contrôles.

- **COMPTES** : cartes de compte (avatar 56 px r 9, pseudo 700 16 px, badge PRINCIPAL `--aqua`,
  méta `--muted`, bouton « DÉFINIR PRINCIPAL »), carte active cerclée `box-shadow: 0 0 0 2px var(--aqua)`.
  Bloc pointillé « + AJOUTER UN COMPTE ». **Adapter la mention légale au modèle réel :**
  « Le launcher ne stocke jamais vos mots de passe : seuls les jetons de session délivrés par
  One Piece Minecraft sont conservés localement, chiffrés par votre système. »
  Ajouter ici le bloc **rattachement Microsoft** (voir §6.3).
- **JAVA & MÉMOIRE** : jauge à rayures `repeating-linear-gradient(90deg,#91D9D1 0 8px,#A6E1DA 8px 16px)`
  (utiliser `--aqua`/`--aqua-alt`), repère central 1 px, échelle `0 GO / moitié / total`.
  Les bornes **viennent de `app.totalMemoryGb()`** — pas de 31,9 en dur.
  2 sliders min/max liés (min ≤ max), note contextuelle colorée `--teal` ou `--warn`.
  Chemin de Java + boutons CHANGER / PAR DÉFAUT, champ « Arguments JVM ».
- **RÉSOLUTION** : 4 puces preset (actif = fond `--ink`, texte `--aqua`), largeur × hauteur,
  aperçu de ratio 96 px de large, 2 interrupteurs (plein écran, se souvenir de la taille).
- **LAUNCHER** : 5 interrupteurs (fermer au lancement, garder la console, mises à jour auto,
  notifications RP, ambiance sonore + volume), puis bloc « DOSSIER DU JEU »
  (chemin réel, OUVRIR, VIDER LE CACHE avec la taille réelle).

**Interrupteur** (composant partagé) : 46×26, r 99 px, curseur 20 px blanc `--sh-knob`,
`left: 3px` → `23px`, fond `--line-6` → `--teal`, transition `.18s`.

### 4.5 Donation
- Carte gauche 392 px, fond `--aqua`, r 10 px : kicker `--ink-4`, `h2` Anton 34 px (`--ink` puis `--ink-2`),
  4 montants (5/10/20/50 €, actif = `--ink`/`--aqua`), ligne de projection `rgba(15,26,25,.9)`,
  bouton « FAIRE UN DON » Anton 19 px + « AVANTAGES », mention « aucun avantage PvP ».
- Carte haut droite `--paper` : collecté / objectif, pourcentage Anton 38 px, jauge 14 px avec
  **barre fantôme** de projection `rgba(29,92,81,.35)` et 3 repères à 25/50/75 %,
  4 paliers (VERROUILLÉ / À PORTÉE / DÉBLOQUÉ).
- Carte bas droite `--veil-86` : classement des donateurs (rang 24 px, pseudo, palier, montant Anton 17 px)
  + mention de paiement sécurisé.

### 4.6 Barre du bas (96 px)
- Gauche : bouton compte (avatar 46 px, pseudo 700 15 px, « COMPTE PRINCIPAL · EN LIGNE » `--aqua`,
  chevron). Ouvre le **popover comptes** (272 px, `--deep`, ancré `left:26px; bottom:100px`).
- Centre (`max-width:520px`) : kicker d'état + bouton « DÉTAILS ▴/▾ » → **popover console**
  (600 px, `--deep`, ancré `left:322px; bottom:100px`, texte monospace 11px/1.75).
  Jauge 9 px r 99 px avec bande `opmShimmer 1.8s` visible seulement pendant un téléchargement.
  Pourcentage Anton 16 px à droite, ligne de détail `--text-light-60`.
- Case « LANCEMENT AUTO » : carré 18 px r 4 px, bordure 1.5 px `--aqua`, coché = fond `--aqua` + « ✓ ».
- Bouton **JOUER** : 212×62, r 9 px, Anton 27 px `.05em`.
  - prêt : fond `--aqua`, texte `--ink`, `--sh-play`, `translateY(-2px)` au survol ;
  - occupé : fond `rgba(145,217,209,.18)`, texte `--text-light-60`, curseur `not-allowed`, libellé « PATIENTEZ » ;
  - maintenance : fond `rgba(255,255,255,.08)`, texte `--text-light-55`, libellé « INDISPONIBLE » ;
  - en cours de lancement : libellé « LANCEMENT… », `opacity:.75`.

États du kicker : `MISE À JOUR EN COURS` / `VOTRE JEU EST À JOUR` / `LANCEMENT DU JEU` /
`MAINTENANCE EN COURS` / `CONNEXION REQUISE`.

### 4.7 Splash
Plein écran `z-index:80`, dégradé `180deg rgba(6,16,15,0) → .22 → .72`,
`bandeau-opm.png` 860 px (max 80 %) `drop-shadow(0 20px 44px rgba(0,0,0,.5))`,
libellé « CONNEXION AU SERVEUR D'AUTHENTIFICATION » (700 10.5 px, `.24em`),
barre 340×5 px r 99, remplissage `--aqua`, mention « CLIQUEZ POUR PASSER ».
Le corps de l'app est en `opacity:0 → 1` avec `transition: opacity .45s ease`.
**Le splash suit la progression réelle du démarrage**, il ne simule rien :
`10 %` config locale → `30 %` bootstrap → `60 %` rafraîchissement de session →
`85 %` instances → `100 %` prêt.

---

## 5. Composants partagés à écrire une seule fois

`opm-btn` (variantes `--aqua`, `--ink`, `--ghost-light`, `--ghost-dark`, `--outline-teal`),
`opm-switch`, `opm-chip`, `opm-kicker`, `opm-card` (`--light`, `--dark`, `--aqua`),
`opm-field` (label + input + erreur), `opm-popover`, `opm-toast`, `opm-spinner`, `opm-progress`.

La popup modale de l'ancien launcher est remplacée par :
- `opm-toast` (coin bas droite, auto-masquage 6 s) pour l'information et les erreurs non bloquantes ;
- `opm-modal` (voile `rgba(6,14,13,.72)` + carte `--paper` 420 px) pour les confirmations
  (suppression de compte, réinitialisation, dissociation Microsoft).

---

## 6. Écran Connexion — à concevoir dans le même langage

La maquette n'en contient pas ; il doit être **indiscernable du reste**.

**Gabarit** : fenêtre sans onglets ni barre du bas (barre de titre réduite : logo + boutons fenêtre).
Vidéo + voiles identiques. Une carte `--paper` de 470 px centrée verticalement à gauche
(`margin-left: 88px`), `melodia.webp` à droite comme sur l'Accueil.

**Trois vues dans la carte**, transition `opmRise` :

### 6.1 Connexion
Kicker « ÉQUIPAGE » → `h1` Anton 37 px « PRENEZ LA MER » / « <span teal>AVEC VOTRE ÉQUIPAGE</span> ».
Champs `opm-field` : e-mail, mot de passe (avec bouton œil). Lien « Mot de passe oublié ? ».
Bouton pleine largeur `opm-btn--ink` Anton 19 px « SE CONNECTER ».
Séparateur « ou ». Lien « Pas encore de compte ? **Créer un compte** ».
Bandeau d'erreur `--warn` sur fond `--mist` en cas d'échec.

### 6.2 Code de sécurité (2FA)
Kicker « SÉCURITÉ » → `h2` « CODE DE VÉRIFICATION ».
6 cases de 1 chiffre (Space Grotesk 700 22 px, `--paper-2`, bordure `--line`, focus `--sh-focus`),
collage et navigation au clavier gérés. Lien « Utiliser un code de secours ».

### 6.3 Rattachement Microsoft (obligatoire)
Kicker « POSSESSION DU JEU » → `h2` « RATTACHEZ VOTRE COMPTE MINECRAFT ».
Paragraphe explicite :
> « One Piece Minecraft délivre lui-même votre session de jeu. Nous demandons une seule fois
> à Microsoft de confirmer que vous possédez Minecraft : votre mot de passe Microsoft ne
> transite jamais par le launcher, et aucun jeton Microsoft n'est envoyé au jeu. »

Bouton `opm-btn--aqua` « RATTACHER MON COMPTE MINECRAFT », état d'attente avec `opm-spinner`.
En mode `device` : affichage du `user_code` en Anton 34 px avec bouton « COPIER » et
« Ouvrir microsoft.com/link ». Après succès : carte de confirmation (tête de skin + pseudo
Minecraft + « possession vérifiée · valable jusqu'au … ») puis passage à l'Accueil.

Cette même vue est réutilisée dans **Paramètres → Comptes** pour re-vérifier ou dissocier.

---

## 7. Ce qui ne doit surtout pas rester

Toutes les valeurs de démonstration de la maquette sont à brancher sur des données réelles :
`47 joueurs`, `812/1 000 votes`, `142 €/200 €`, `TPS 19.8`, `V7.2.1`, `24 812 fichiers · 4,8 Go`,
`31,9 Go`, `1,2 Go de cache`, les 3 news, les 3 donateurs, les 2 comptes, le compte à rebours,
les lignes de console. Quand une donnée n'est pas encore disponible : squelette de chargement
(`opm-skeleton`, dégradé `opmShimmer`), jamais une fausse valeur.
