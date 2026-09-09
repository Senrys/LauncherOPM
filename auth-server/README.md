# Serveur d'authentification One Piece Minecraft

Serveur FastAPI qui délivre les comptes du launcher **et** les sessions de jeu.
Il expose trois surfaces :

| Racine | Contenu | Consommateur |
|---|---|---|
| `/api/v1` | comptes OPM, rattachement Microsoft, sessions de jeu, contenu | le launcher Electron |
| `/yggdrasil` | protocole Mojang | authlib-injector, côté serveur Minecraft |
| `/textures` | skins et capes en contenu adressable | le client Minecraft de chaque joueur |

Plus deux routes de service hors contrat : `GET /health` (interroge réellement
la base) et `GET /version`.

> **La base de données est celle du site.** Le serveur d'authentification lit les
> comptes, le journal de bord et les statistiques déjà tenus par le site Flask, et
> y ajoute ses douze tables préfixées `auth_`, `ygg_`, `launcher_`. Il ne crée pas
> une seconde base, ne modifie aucune table du site, et hache les mots de passe au
> format Werkzeug pour que le site continue de savoir les vérifier.
> Tout est expliqué dans [`../docs/DATA.md`](../docs/DATA.md).

---

## 1. Prérequis

- **Python 3.11 minimum** (3.12 recommandé — c'est la version de l'image Docker) ;
- **PostgreSQL** : celui du site, joignable depuis la machine qui héberge ce service ;
- pour la partie jeu : le serveur Minecraft, Java 17+, et `authlib-injector.jar` (§7) ;
- en production : un nginx (ou équivalent) en façade, avec un certificat TLS.

Le serveur d'authentification doit être **au moins aussi disponible que le serveur
Minecraft** : s'il tombe, le jeu ne se lance plus (voir
[`../docs/SOUVERAINETE.md`](../docs/SOUVERAINETE.md) §3). Le plus simple est de
l'héberger sur le même VPS que le site et le serveur de jeu.

---

## 2. Installation

```bash
cd auth-server
python -m venv .venv
source .venv/bin/activate          # Windows : .venv\Scripts\activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

Pour développer (tests, ruff, mypy) :

```bash
python -m pip install -e ".[dev]"
```

---

## 3. Configuration

Toute la configuration passe par des variables d'environnement préfixées `OPM_`,
ou par un fichier `.env` à la racine de `auth-server/`. **Aucun secret n'est écrit
dans le code.**

```bash
cp .env.example .env
```

`.env.example` documente les 90 réglages un par un. Voici les seuls qu'il faut
avoir décidés avant de démarrer :

| Variable | Rôle | Valeur de production |
|---|---|---|
| `OPM_ENV` | environnement | `prod` |
| `OPM_PUBLIC_URL` | URL publique, sert à construire les URL de textures et l'`issuer` des jetons | `https://auth.onepieceminecraft.fr` |
| `OPM_DATABASE_URL` | **la base du site** | `postgresql://opm_auth:…@127.0.0.1/opmdb` |
| `OPM_SECRET_KEY` | clé de signature des enveloppes internes | 48 octets aléatoires |
| `OPM_MSA_TOKEN_KEY` | AES-256-GCM chiffrant le jeton Microsoft au repos | 32 octets en hexadécimal |
| `OPM_MSA_CLIENT_ID` | application Azure (ou l'identifiant public du launcher officiel) | à vous |
| `OPM_MC_HOST` / `OPM_MC_PORT` | serveur Minecraft à interroger | `play.onepieceminecraft.fr` / `25565` |
| `OPM_SKIN_DOMAINS` | domaines autorisés à servir des textures, exigé par authlib-injector | `auth.onepieceminecraft.fr` |
| `OPM_STATS_WRITE` | écriture de la fréquentation dans `statistiques` | `true` |
| `OPM_TRUST_PROXY_HEADERS` | lire `X-Forwarded-For` (indispensable derrière nginx) | `true` |
| `OPM_DONATION_URL` | page ouverte par le bouton « FAIRE UN DON » | `https://onepieceminecraft.fr/don` |

Générer les deux secrets :

```bash
python -c "import secrets; print('OPM_SECRET_KEY=' + secrets.token_urlsafe(48))"
python -c "import secrets; print('OPM_MSA_TOKEN_KEY=' + secrets.token_hex(32))"
```

En production, le serveur **refuse de démarrer** si un secret est resté à sa
valeur d'exemple, si l'URL publique n'est pas en HTTPS, si la base est en SQLite,
ou si un fichier de clé manque. Le message d'erreur liste tous les problèmes d'un
coup : c'est voulu.

### Droits du rôle PostgreSQL

Le rôle applicatif n'a besoin de presque rien, et cette restriction est votre
meilleure garantie qu'un bug ne pourra pas abîmer les données du site :

```sql
-- Tables du launcher : tous les droits.
GRANT SELECT, INSERT, UPDATE, DELETE ON
    auth_mc_link, auth_refresh_token, auth_totp, auth_recovery_code,
    auth_password_reset, auth_ban, auth_audit, ygg_session, ygg_join,
    texture, user_texture, launcher_instance
  TO opm_auth;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO opm_auth;

-- Tables du site : lecture seule…
GRANT SELECT ON users, article, statistiques, equipages, iles TO opm_auth;

-- …sauf ces cinq colonnes, les seules que le launcher écrit (docs/DATA.md §4).
GRANT UPDATE (derniereconnexion, tempsdejeu) ON users TO opm_auth;
GRANT UPDATE (joueurs_en_ligne, record_joueurs, record_date) ON statistiques TO opm_auth;
```

Les colonnes RP (`prime`, `berry`, `niveau*`, `faction`, `equipage`…) restent
inaccessibles en écriture. Le rôle **propriétaire** de la base, lui, n'est utilisé
que le temps de la migration.

---

## 4. Clés de signature

Deux paires, deux usages, générées en une commande :

```bash
python -m opm_auth.cli keygen
```

| Paire | Algorithme | Signe quoi | Pourquoi cet algorithme |
|---|---|---|---|
| `keys/jwt_ed25519_*.pem` | Ed25519 | nos `access_token` et les sessions Yggdrasil | c'est nous qui définissons le format, donc nous choisissons |
| `keys/ygg_rsa_*.pem` | RSA-4096 | les propriétés `textures` du sessionserver | **imposé** par le client Minecraft, qui vérifie en `SHA1withRSA` |

Le serveur les génère aussi tout seul au premier démarrage si elles manquent.
Sauvegardez le dossier `keys/` : perdre la clé RSA oblige à redémarrer le serveur
Minecraft, perdre la clé Ed25519 déconnecte tout le monde.

**Ne les mettez jamais dans Git ni dans une image Docker** — le `Dockerfile` monte
`keys/` en volume précisément pour ça.

---

## 5. Migration de la base

La migration est **additive** : douze `CREATE TABLE`, rien d'autre. Elle
s'applique cependant sur la base de production du site, et demande donc une
procédure. Elle est décrite pas à pas dans
[`migrations/README.md`](migrations/README.md) — **lisez-la en entier avant de
taper la première commande**. En résumé :

```bash
# 1. Sauvegarde (non négociable)
pg_dump --format=custom --file=opmdb-avant-launcher.dump opmdb

# 2. Relever la révision courante du site
psql opmdb -c "SELECT version_num FROM alembic_version;"

# 3. Reporter cette valeur dans migrations/versions/0001_launcher_auth.py
#    (down_revision = "…"), sans quoi l'historique Alembic du site se casse.

# 4. Relire le SQL qui sera exécuté, sans rien appliquer
alembic upgrade head --sql > 0001_launcher_auth.sql
grep -icE "alter table|drop " 0001_launcher_auth.sql   # doit répondre 0

# 5. Appliquer, avec le rôle propriétaire de la base
alembic upgrade head
```

En développement sur SQLite, rien de tout cela : `python -m opm_auth.cli initdb`
crée les douze tables du launcher (et jamais celles du site).

---

## 6. Lancement

### Développement

```bash
python -m opm_auth.main            # écoute sur OPM_HOST:OPM_PORT, rechargement auto
# ou, au choix :
uvicorn opm_auth.main:app --reload
```

La documentation interactive est alors sur `http://127.0.0.1:8000/docs`. Elle est
**désactivée en production** : elle décrit toute la surface d'attaque et n'a aucun
public légitime sur un serveur de jeu.

### Production — systemd

```ini
# /etc/systemd/system/opm-auth.service
[Unit]
Description=OPM Auth — serveur d'authentification One Piece Minecraft
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=exec
User=opm
WorkingDirectory=/srv/opm/auth-server
EnvironmentFile=/srv/opm/auth-server/.env
ExecStart=/srv/opm/auth-server/.venv/bin/uvicorn opm_auth.main:app \
          --host 127.0.0.1 --port 8000 --proxy-headers
Restart=always
RestartSec=5
# Le service n'écrit que dans keys/ et data/.
ProtectSystem=strict
ReadWritePaths=/srv/opm/auth-server/keys /srv/opm/auth-server/data
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now opm-auth
sudo journalctl -u opm-auth -f
```

### Production — nginx

```nginx
server {
    listen 443 ssl http2;
    server_name auth.onepieceminecraft.fr;

    ssl_certificate     /etc/letsencrypt/live/auth.onepieceminecraft.fr/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/auth.onepieceminecraft.fr/privkey.pem;

    # Un skin fait 8 Ko ; 2 Mo laissent de la marge et ferment la porte au reste.
    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
}
```

`X-Forwarded-For` n'est lu par l'application que si `OPM_TRUST_PROXY_HEADERS=true`.
Sans répartiteur devant vous, laissez ce réglage à `false` : cet en-tête est
trivialement falsifiable et permettrait de contourner toutes les limites de débit.

### Production — Docker

```bash
docker compose up -d --build
docker compose logs -f api
```

`docker-compose.yml` ne contient **pas** de service PostgreSQL : la base est celle
du site. Un service de développement est proposé en commentaire en bas du fichier.

### Vérifier que ça tourne

```bash
curl -s http://127.0.0.1:8000/health   | python -m json.tool
curl -s http://127.0.0.1:8000/version  | python -m json.tool
curl -s http://127.0.0.1:8000/api/v1/bootstrap | python -m json.tool
```

`/health` répond `200` quand la base répond, `503` sinon : c'est la sonde à
brancher dans votre supervision.

---

## 7. Procédure côté serveur Minecraft

C'est l'étape qui rend le montage réel : votre serveur cesse d'interroger Mojang
et interroge **votre** serveur d'authentification.

### 7.1 Installer authlib-injector

Téléchargez la dernière version depuis
<https://github.com/yushijinhun/authlib-injector/releases> et posez le `.jar` à
côté de celui du serveur :

```
/srv/minecraft/
├── server.jar
├── authlib-injector.jar
└── server.properties
```

### 7.2 Ajouter l'agent Java au démarrage

L'argument `-javaagent` doit venir **avant** `-jar`, et prend l'URL racine de
notre Yggdrasil :

```bash
java -Xms4G -Xmx8G \
     -javaagent:authlib-injector.jar=https://auth.onepieceminecraft.fr/yggdrasil \
     -jar server.jar nogui
```

Au démarrage, authlib-injector appelle `GET /yggdrasil` et y trouve le nom du
serveur, les domaines de skins autorisés et la clé publique RSA
(`signaturePublickey`) qui lui servira à vérifier les textures. **Rien à copier à
la main** : si vous voyez apparaître dans le journal du serveur

```
[authlib-injector] Fetching /yggdrasil
[authlib-injector] Authentication server: One Piece Minecraft
```

l'injection est faite.

> Sur un hébergeur qui ne laisse pas modifier la ligne de commande Java, cherchez
> le champ « JVM arguments » ou « Java flags » du panneau. C'est le même argument.

### 7.3 Laisser `online-mode=true`

```properties
# server.properties
online-mode=true
```

Contre-intuitif, et pourtant essentiel : `online-mode=true` demande au serveur de
**vérifier** la session de chaque joueur. authlib-injector détourne simplement
cette vérification vers notre API au lieu de celle de Mojang. Passer à
`online-mode=false` désactiverait la vérification tout court — n'importe qui
pourrait alors entrer sous n'importe quel pseudo.

### 7.4 Test de bout en bout

Dans l'ordre, chaque étape validant la précédente :

1. **Les métadonnées répondent** — depuis le serveur Minecraft lui-même :

   ```bash
   curl -s https://auth.onepieceminecraft.fr/yggdrasil | python -m json.tool
   ```

   Vous devez y lire `meta.serverName`, `skinDomains` et `signaturePublickey`.

2. **Un compte peut jouer** — l'état du compte, vu du serveur :

   ```bash
   python -m opm_auth.cli link-status --email joueur@exemple.fr
   ```

   La dernière ligne doit dire `Bouton JOUER : actif`. Sinon, elle donne le motif
   (`microsoft_required`, `ownership_missing`, `microsoft_expired`, `banned`).

3. **Le launcher lance le jeu** — connectez-vous dans le launcher OPM, cliquez
   sur JOUER. Le journal du serveur d'auth doit montrer, dans cet ordre :
   `POST /api/v1/game/session` (le launcher demande sa session), puis
   `POST /yggdrasil/sessionserver/session/minecraft/join` (le client annonce son
   arrivée), puis `GET …/hasJoined` (le serveur Minecraft vérifie).

4. **Le pseudo et le skin sont les bons** — en jeu, `/list` doit afficher le
   `minecraft_username` du compte Microsoft rattaché, et le skin importé lors du
   rattachement doit apparaître. Si le skin manque, le joueur a un skin par
   défaut : ce n'est jamais bloquant, l'import est retenté à la prochaine
   re-vérification.

5. **Un joueur non rattaché est refusé** — c'est le test qui prouve que la
   souveraineté fonctionne. Depuis le launcher Minecraft officiel, la connexion
   doit échouer avec le message français que renvoie notre API.

### 7.5 Ce que ce montage implique

**Seuls les joueurs passant par le launcher OPM peuvent se connecter.** C'est le
but, et c'est aussi la conséquence qu'il faut avoir acceptée :

- le launcher officiel de Minecraft ne fonctionne plus sur votre serveur ;
- les serveurs de proxy (BungeeCord, Velocity) doivent porter le même
  `-javaagent`, sur toutes les instances ;
- si le serveur d'authentification est injoignable, **personne ne se connecte** —
  même les joueurs déjà en jeu ne pourront pas se reconnecter après un
  redémarrage. D'où l'importance du §1 : hébergez-le à côté du serveur de jeu.

Le repli existe si vous changez d'avis : `OPM_YGG_MOJANG_FALLBACK=true` laisse
entrer les joueurs premium venus du launcher officiel quand leur pseudo est
inconnu de notre base. À laisser à `false` en mode « hybride imposé ».

---

## 8. Outillage en ligne de commande

```bash
python -m opm_auth.cli --help
```

| Commande | Rôle |
|---|---|
| `keygen [--force]` | génère les paires Ed25519 et RSA-4096 |
| `initdb [--force]` | crée les tables du launcher (jamais celles du site) |
| `export-public-key [--kind rsa\|ed25519] [--output F]` | affiche la clé publique |
| `createuser --email … --username … [--admin]` | crée un compte OPM |
| `link-status --email …` | état du rattachement Microsoft d'un compte |
| `revoke --email …` | révoque toutes les sessions (launcher et jeu) d'un compte |
| `ping [--host …] [--port …]` | interroge le serveur Minecraft, sans rien écrire |
| `import-instances FICHIER [--dry-run]` | charge `launcher_instance` depuis un JSON |

Deux précisions honnêtes :

- `createuser --admin` **n'écrit rien** : la table `users` du site ne porte aucune
  colonne de rôle. L'option existe, l'affiche, et crée un compte joueur ;
- `revoke` ne touche ni au mot de passe ni au rattachement Microsoft. En cas de
  compte volé, faites aussi changer le mot de passe.

Depuis Docker : `docker compose exec api python -m opm_auth.cli link-status --email …`.

---

## 9. Tests

```bash
pytest
```

La suite tourne sur une base SQLite en mémoire, recréée à chaque test. Deux
comportements du contrat exigent le vrai PostgreSQL — l'écriture atomique de la
fréquentation (`GREATEST`) et le type `jsonb` — et sont **ignorés** tant qu'aucune
base jetable n'est fournie :

```bash
OPM_TEST_POSTGRES_URL=postgresql+asyncpg://opm:opm@localhost:5433/opm_test pytest
```

Ils sont ignorés, jamais silencieusement transformés en tests SQLite : un test qui
ne prouve pas ce qu'il annonce est pire que pas de test du tout.

---

## 10. Exploitation courante

| Situation | Réponse |
|---|---|
| « Je ne peux plus jouer » | `python -m opm_auth.cli link-status --email …` — la dernière ligne donne le motif |
| Compte volé | changer le mot de passe, puis `revoke --email …` |
| Le serveur affiche 0 joueur | `python -m opm_auth.cli ping` ; sur un échec, rien n'est écrit en base, c'est normal |
| Microsoft en panne | rien à faire : la possession est en cache trente jours |
| Rotation de clés | `keygen --force`, puis redémarrer le serveur Minecraft (nouvelle clé RSA) |
| Nouvelle instance de jeu | éditer le JSON, `import-instances`, le launcher la voit sous 60 s |
| Journal | `journalctl -u opm-auth -f`, ou `docker compose logs -f api` |

En production, chaque ligne de journal est un objet JSON portant l'identifiant de
requête (`request_id`), que le client reçoit aussi dans l'en-tête `X-Request-ID` et
dans le corps d'une erreur 500 : un joueur qui vous donne cet identifiant vous
amène directement à la trace correspondante. Aucun mot de passe, aucun jeton et
aucune chaîne de requête n'entrent dans le journal.

---

## 11. À lire ensuite

- [`../docs/API.md`](../docs/API.md) — le contrat REST et Yggdrasil, source de vérité ;
- [`../docs/DATA.md`](../docs/DATA.md) — la base, les tables, les mots de passe, les caches ;
- [`../docs/SOUVERAINETE.md`](../docs/SOUVERAINETE.md) — pourquoi ce montage, et ses limites ;
- [`migrations/README.md`](migrations/README.md) — la procédure de migration, en détail.
