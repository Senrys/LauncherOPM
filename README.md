# One Piece Minecraft — launcher et serveur d'authentification

Deux composants, un seul compte, une seule base de données.

| Composant | Technologie | Rôle |
|---|---|---|
| [`launcher/`](launcher/) | Electron 32 | ce que le joueur installe : connexion, téléchargement du jeu, lancement, journal de bord, boutique, dons |
| [`auth-server/`](auth-server/) | Python 3.11+, FastAPI | délivre les comptes, vérifie la possession de Minecraft, **signe les sessions de jeu** et sert les skins |

Le montage rend le serveur Minecraft indépendant de Mojang à l'exécution : c'est
notre serveur qui autorise les joueurs à entrer, via un Yggdrasil maison et
authlib-injector. Les tenants et les aboutissants — et les limites — sont dans
[`docs/SOUVERAINETE.md`](docs/SOUVERAINETE.md).

> **La base de données est celle du site.** Le serveur d'authentification lit les
> comptes, le journal de bord et les statistiques déjà tenus par le site Flask, et
> y ajoute douze tables préfixées `auth_`, `ygg_`, `launcher_`. Il ne crée pas une
> seconde base et ne modifie aucune table du site. Les mots de passe restent au
> format Werkzeug pour qu'un compte créé depuis le launcher se connecte au site,
> et réciproquement.

---

## Arborescence

```
New/
├── README.md                      ← vous êtes ici
├── docs/                          les contrats : à lire avant d'écrire une ligne
│   ├── API.md                     contrat REST + Yggdrasil (source de vérité)
│   ├── DATA.md                    base réelle, tables, mots de passe, caches, ping
│   ├── IPC.md                     contrat IPC Electron (main ↔ renderer)
│   ├── UI-SPEC.md                 intégration visuelle, d'après la maquette
│   ├── BUILD.md                   compilation, icônes, signature, antivirus
│   └── SOUVERAINETE.md            pourquoi ce montage, et ce qu'il coûte
│
├── auth-server/
│   ├── opm_auth/
│   │   ├── main.py                assemblage FastAPI : routeurs, middlewares, lifespan
│   │   ├── cli.py                 outillage (keygen, initdb, createuser, ping…)
│   │   ├── config.py              toute la configuration (variables OPM_*)
│   │   ├── db.py                  moteur async, sessions, tables du launcher
│   │   ├── models.py              TABLES DU SITE (lecture) / TABLES DU LAUNCHER
│   │   ├── schemas.py             entrées et sorties Pydantic v2
│   │   ├── routers/               auth, microsoft, game, launcher, yggdrasil,
│   │   │                          sessionserver, textures
│   │   ├── services/              toute la logique métier
│   │   └── security/              mots de passe, clés, jetons, TOTP, limitation
│   ├── migrations/                migration Alembic additive (12 tables)
│   ├── tests/                     pytest, SQLite en mémoire
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── .env.example               90 réglages documentés un par un
│   └── README.md                  installation, migration, procédure serveur Minecraft
│
└── launcher/
    ├── src/
    │   ├── app.js                 processus principal Electron
    │   ├── preload.js             pont IPC (contextIsolation)
    │   ├── main/
    │   │   ├── ipc.js             tous les canaux de docs/IPC.md
    │   │   ├── auth/              api.js, accounts.js, microsoft.js
    │   │   └── services/          game, content, store, vault, updater, paths, logger
    │   ├── windows/mainWindow.js
    │   ├── launcher.html          coquille : splash, connexion, rail, panneaux
    │   ├── panels/                home.html, donation.html, settings.html
    │   └── assets/                css/ (tokens, layout, composants, panneaux),
    │                              js/ (renderer, panels, components, utils),
    │                              images/, fonts/, videos/
    ├── scripts/                   fetch-fonts.js, make-icons.js
    ├── build.js                   configuration electron-builder
    └── package.json
```

La maquette de référence, hors du dépôt applicatif :
`DesignMaquette/Launcher OPM.dc.html`. C'est la **référence visuelle absolue**.

---

## Démarrage rapide

### 1. Le serveur d'authentification

```bash
cd auth-server
python -m venv .venv && source .venv/bin/activate   # Windows : .venv\Scripts\activate
python -m pip install -r requirements.txt

cp .env.example .env
python -c "import secrets; print('OPM_SECRET_KEY=' + secrets.token_urlsafe(48))"
python -c "import secrets; print('OPM_MSA_TOKEN_KEY=' + secrets.token_hex(32))"
# → reportez les deux lignes dans .env

python -m opm_auth.cli keygen      # paires Ed25519 (jetons) et RSA-4096 (textures)
python -m opm_auth.cli initdb      # tables du launcher, sur la SQLite de développement
python -m opm_auth.main            # http://127.0.0.1:8000 — /docs pour explorer
```

En production, `initdb` laisse la place à la migration Alembic, appliquée sur la
base du site : la procédure complète est dans
[`auth-server/README.md`](auth-server/README.md) §5 et
[`auth-server/migrations/README.md`](auth-server/migrations/README.md).

### 2. Le launcher

```bash
cd launcher
npm install
npm run fonts                      # embarque Anton + Space Grotesk (une seule fois)
OPM_API_URL=http://127.0.0.1:8000 npm start
```

`OPM_API_URL` redirige le launcher vers un serveur local ; sans elle, il vise
`https://auth.onepieceminecraft.fr`. Compilation et signature :
[`docs/BUILD.md`](docs/BUILD.md).

### 3. Le serveur Minecraft

```bash
java -javaagent:authlib-injector.jar=https://auth.onepieceminecraft.fr/yggdrasil \
     -jar server.jar nogui
```

avec `online-mode=true` dans `server.properties` — oui, `true` : authlib-injector
détourne la vérification vers notre API au lieu de la supprimer. Le test de bout
en bout est décrit dans [`auth-server/README.md`](auth-server/README.md) §7.

---

## Variables d'environnement essentielles

Toutes préfixées `OPM_`, lues depuis l'environnement ou `auth-server/.env`.
Les 90 réglages sont documentés dans `.env.example` ; voici ceux sans lesquels
rien ne fonctionne.

| Variable | Rôle | Exemple de production |
|---|---|---|
| `OPM_ENV` | `dev`, `test` ou `prod` — en `prod`, la configuration est vérifiée au démarrage | `prod` |
| `OPM_PUBLIC_URL` | URL publique du serveur d'auth ; construit les URL de textures et l'`issuer` des jetons | `https://auth.onepieceminecraft.fr` |
| `OPM_DATABASE_URL` | **la base du site**, jamais une seconde base | `postgresql://opm_auth:…@127.0.0.1/opmdb` |
| `OPM_SECRET_KEY` | signature des enveloppes internes (48 octets aléatoires) | — |
| `OPM_MSA_TOKEN_KEY` | AES-256-GCM chiffrant le jeton Microsoft au repos (32 octets hex) | — |
| `OPM_MSA_CLIENT_ID` | application Azure utilisée pour la vérification de possession | à enregistrer |
| `OPM_MC_HOST` / `OPM_MC_PORT` | serveur Minecraft interrogé par le relevé de fréquentation | `play.onepieceminecraft.fr` / `25565` |
| `OPM_SKIN_DOMAINS` | domaines autorisés à servir des skins (exigé par authlib-injector) | `auth.onepieceminecraft.fr` |
| `OPM_STATS_WRITE` / `OPM_STATS_INTERVAL` | écriture de la fréquentation dans `statistiques`, et sa cadence | `true` / `20` |
| `OPM_TRUST_PROXY_HEADERS` | lire `X-Forwarded-For` — **uniquement** derrière nginx | `true` |
| `OPM_TRUSTED_PROXIES` | nombre de proxys devant le serveur ; la chaîne `X-Forwarded-For` est lue **par la droite** en sautant ce nombre d'entrées (1 = nginx seul, 2 = Cloudflare puis nginx) | `1` |
| `OPM_TRUSTED_PROXY_IPS` | adresses ou CIDR autorisés à poser ces en-têtes, séparés par des virgules ; vide = boucle locale et réseaux privés | `10.0.0.4,10.0.0.5` |
| `OPM_LOGIN_TIME_BUDGET_MS` | durée plancher d'une vérification de mot de passe, pour que compte inconnu et mot de passe faux répondent au même moment (0 = désactivé) | `750` |
| `OPM_MICROSOFT_REQUIRED` | rattachement Microsoft obligatoire pour jouer | `true` |
| `OPM_YGG_MOJANG_FALLBACK` | laisser entrer les joueurs premium hors launcher | `false` |
| `OPM_DONATION_URL` | page ouverte par le bouton « FAIRE UN DON » | `https://onepieceminecraft.fr/don` |
| `OPM_SMTP_*` | envoi des courriels (réinitialisation de mot de passe) | voir §14 de `.env.example` |
| `OPM_API_URL` *(launcher)* | redirige le launcher vers un autre serveur d'auth | `http://127.0.0.1:8000` |

---

## Ce qui reste à brancher avant la production

Rien de tout cela n'est un défaut de code : ce sont les valeurs et les comptes
qui n'existent pas encore. La liste est courte, et chaque ligne est bloquante.

### Serveur d'authentification

1. **Une application Azure à nous.** `OPM_MSA_CLIENT_ID` vaut par défaut
   l'identifiant public du launcher officiel : c'est ce que font tous les
   launchers tiers, et c'est une zone grise vis-à-vis des conditions
   d'utilisation. L'enregistrement est gratuit et prend dix minutes
   (`docs/SOUVERAINETE.md` §8, limite n° 7).
2. **Les secrets de production** — `OPM_SECRET_KEY` et `OPM_MSA_TOKEN_KEY`
   tirés au hasard, jamais ceux de `.env.example`. Le serveur refuse de démarrer
   en `prod` avec les valeurs d'exemple : c'est voulu.
3. **Les clés de signature**, générées une fois (`cli keygen`) puis
   **sauvegardées hors du serveur**. Perdre `keys/` coûte un redémarrage du
   serveur Minecraft et la déconnexion de tout le monde.
4. **Le rôle PostgreSQL restreint** (`auth-server/README.md` §3) : lecture seule
   sur les tables du site, sauf cinq colonnes. C'est la meilleure garantie qu'un
   bug ne pourra pas abîmer les données RP.
5. **La migration Alembic**, avec son `down_revision` chaîné à l'historique du
   site, et une sauvegarde vérifiée avant.
6. **Le SMTP** (`OPM_SMTP_*`). Sans lui, la réinitialisation de mot de passe crée
   bien un jeton mais ne le remet à personne : en développement il part dans le
   journal, en production il est perdu.
7. **Le certificat TLS** de `auth.onepieceminecraft.fr`, et nginx en façade. Le
   serveur refuse de démarrer en `prod` si `OPM_PUBLIC_URL` n'est pas en HTTPS.
8. **La supervision** branchée sur `GET /health` (il interroge réellement la base).

### Base du site

9. **`statistiques.launcher_windows`, `_mac`, `_linux`** — les trois URL de
   téléchargement du launcher. Elles sont vides aujourd'hui ; tant qu'elles le
   sont, l'écran de mise à jour n'a rien à proposer. Elles se remplissent après
   la première compilation (§ suivant), par un simple `UPDATE` de la ligne `id = 1`.
10. **`launcher_instance`** — au moins une instance de jeu, chargée par
    `python -m opm_auth.cli import-instances instances.json`. Sans elle, le
    launcher n'a rien à télécharger. C'est la table qui remplace l'URL statique
    de l'ancien launcher.
11. **`statistiques.server_ip`** — l'adresse réelle du serveur, celle que le
    relevé de fréquentation interroge et que l'accueil affiche.

### Launcher

12. **Les certificats de signature** : un certificat Windows (OV ou EV — l'EV
    seul supprime SmartScreen immédiatement) et un compte Apple Developer pour la
    notarisation macOS. Sans eux, l'installeur déclenche SmartScreen et une
    partie des antivirus (`docs/BUILD.md` §3 et §4).
13. **Les URL de publication** des mises à jour (`electron-updater`) : les
    fichiers `latest*.yml` doivent être publiés à côté des exécutables, sans quoi
    le launcher ne saura pas se mettre à jour.
14. **Les liens du rail social** (`OPM_LINK_DISCORD`, `_TWITCH`, `_YOUTUBE`,
    `_WEBSITE`) : ils sont servis par `/api/v1/bootstrap`, donc modifiables sans
    recompiler le launcher.

---

## Points de vigilance permanents

- **Ne jamais créer ni modifier une table du site.** `init_models()` et la
  migration ne connaissent que les douze tables du launcher ; un modèle ajouté et
  oublié dans l'une des deux familles fait échouer l'import, bruyamment. C'est
  volontaire.
- **Ne jamais réécrire les mots de passe en Argon2id** tant que le site n'a pas
  migré lui aussi : il ne saurait plus les vérifier, et les joueurs perdraient
  l'accès au site (`docs/DATA.md` §3).
- **Le relevé de fréquentation s'écrit en une seule instruction atomique.** Le
  site fait le même de son côté : `GREATEST` et le `CASE` garantissent qu'aucun
  des deux n'écrase le record de l'autre. Un ping en échec n'écrit rien.
- **Il n'y a aucune table de dons.** L'écran Donation lit `statistiques`, calcule
  ses quatre paliers, et affiche un état vide honnête pour le classement des
  donateurs — jamais de faux donateurs.
- **L'UUID en jeu est l'UUID premium réel.** Il porte les mondes, les claims, les
  permissions et l'économie : le pseudo affiché en jeu est
  `auth_mc_link.minecraft_username`, pas `users.name`.
