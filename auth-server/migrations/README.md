# Migrations Alembic — serveur d'authentification OPM

> **Cette migration s'applique sur la base de production du site.**
> Elle est additive, mais elle se déroule sur la base qui fait vivre
> onepieceminecraft.fr. Lisez la page en entier avant de taper la première commande.

---

## 1. Ce que fait — et ne fait pas — la migration `0001_launcher_auth`

**Elle crée 12 tables**, toutes nouvelles, toutes préfixées de façon à ce que leur
propriétaire soit lisible d'un coup d'œil :

| Table | Rôle |
|---|---|
| `auth_mc_link` | rattachement Microsoft, UUID Minecraft premium, cache de possession (30 j) |
| `auth_refresh_token` | sessions du launcher (jeton opaque haché, rotation, familles) |
| `auth_totp` | secret TOTP chiffré (2FA facultative) |
| `auth_recovery_code` | codes de secours de la 2FA |
| `auth_password_reset` | jetons de réinitialisation de mot de passe |
| `auth_ban` | sanctions |
| `auth_audit` | journal d'audit |
| `ygg_session` | sessions de jeu Yggdrasil que nous signons |
| `ygg_join` | trace éphémère de `join` / `hasJoined` (TTL 30 s) |
| `texture` | skins et capes, adressés par leur SHA-256 |
| `user_texture` | texture active d'un joueur (skin, cape) |
| `launcher_instance` | profils de jeu administrables |

**Elle ne fait rien d'autre.** Aucune des onze tables du site
(`users`, `article`, `statistiques`, `equipages`, `iles`, `combats`, `produits`,
`equipe`, `securite`, `contact`, `alembic_version`) n'est modifiée : pas
d'`ALTER TABLE`, pas d'`ADD COLUMN`, pas de `DROP`, pas d'`UPDATE` de données.
Le SQL produit (étape 4) le prouve en une commande :

```bash
grep -icE "alter table|drop " 0001_launcher_auth.sql   # doit répondre 0
```

Les seules écritures que le serveur d'authentification fera **ensuite** sur les
tables du site, à l'exécution, sont (voir `docs/DATA.md` §3 et §4) :

* `INSERT` dans `users` — la création de compte depuis le launcher ;
* `UPDATE users.derniereconnexion` — la date de dernière connexion ;
* `UPDATE users.tempsdejeu` — le temps de jeu crédité en fin de partie ;
* `UPDATE users.password_hash` — le renforcement transparent de l'empreinte
  Werkzeug (260 000 → 600 000 itérations), **dans le même format**, pour que le
  site continue de vérifier le mot de passe ;
* `UPDATE statistiques.joueurs_en_ligne / record_joueurs / record_date`.

C'est une affaire de droits SQL, pas de migration : voir l'étape 7.

---

## 2. Avant de commencer

**Outillage.** Python 3.11 minimum, dépendances installées, commandes lancées
depuis `auth-server/` (le dossier qui contient `alembic.ini`) :

```bash
cd auth-server
python -m pip install -r requirements.txt
```

**Connexion.** Aucune URL n'est écrite dans `alembic.ini` : Alembic lit
`OPM_DATABASE_URL` (fichier `.env` ou variable d'environnement), exactement
comme le serveur. Vérifiez que vous visez la bonne base **avant** tout :

```bash
OPM_DATABASE_URL=postgresql://opm_owner:…@127.0.0.1/opmdb alembic current
```

**Rôle PostgreSQL.** L'`upgrade` a besoin du droit `CREATE` sur le schéma
`public` : utilisez le rôle **propriétaire** de la base (celui du site), pas le
rôle applicatif `opm_auth`, qui n'aura jamais le droit de créer une table.

**Fenêtre d'intervention.** La migration ne pose que des `CREATE TABLE` : elle ne
verrouille aucune table existante et dure moins d'une seconde. Le site peut
rester en ligne. Elle s'exécute dans **une seule transaction** : soit les
12 tables apparaissent, soit aucune.

---

## 3. Procédure d'application

### Étape 1 — Sauvegarde (non négociable)

```bash
pg_dump --format=custom --file="opmdb-avant-launcher-$(date +%Y%m%d-%H%M).dump" opmdb
# Vérification immédiate : la sauvegarde doit être lisible
pg_restore --list "opmdb-avant-launcher-$(date +%Y%m%d-%H%M).dump" | head
```

Gardez le fichier hors du serveur (copie locale) tant que la migration n'est pas
validée en production.

### Étape 2 — Relever la révision courante du site

```bash
psql opmdb -c "SELECT version_num FROM alembic_version;"
```

Notez la valeur, par exemple `a1b2c3d4e5f6`. Si la requête renvoie **zéro ligne**,
arrêtez-vous : la base n'est pas dans l'état attendu, prenez contact avec la
personne qui gère les migrations du site.

### Étape 3 — Chaîner la migration à l'historique du site

**Le fichier de migration ne se modifie pas.** Son `down_revision` est lu dans
l'environnement, précisément pour qu'un déploiement ne dépende pas d'une édition
manuelle oubliée :

```bash
export OPM_SITE_ALEMBIC_REVISION=a1b2c3d4e5f6      # la valeur relevée à l'étape 2
```

> **Pourquoi c'est obligatoire.** Laisser la variable vide déclarerait notre
> migration comme « première migration de l'historique ». Alembic se retrouverait
> avec deux racines, et toute migration future du site échouerait. La migration
> refuse d'ailleurs de s'exécuter dans ce cas : elle détecte la base du site
> (présence de `combats`, `produits`, `equipe`, `securite`, `contact`) et
> s'arrête avec le message qui renvoie à cette page.
> Sur une base neuve (développement, tests, intégration continue), la variable
> reste **vide** : c'est la valeur correcte, ne l'exportez pas.

Rendez ensuite les fichiers de révision du site visibles d'Alembic — sans quoi la
commande suivante s'arrête, y compris pour lire la révision courante de la base,
sur `Can't locate revision identified by 'a1b2c3d4e5f6'` (ou, selon la version
d'Alembic, sur une trace se terminant par `KeyError: 'a1b2c3d4e5f6'`) :

```ini
# auth-server/alembic.ini
version_locations = migrations/versions /chemin/du/site/migrations/versions
version_path_separator = space
```

C'est le sujet de la section 5, **Cohabitation avec l'Alembic du site** : lisez-la
avant de continuer, elle décrit aussi l'alternative (historiques séparés) qui
dispense entièrement de cette étape.

### Étape 4 — Relire le SQL avant de l'exécuter

```bash
alembic upgrade "$OPM_SITE_ALEMBIC_REVISION:head" --sql > 0001_launcher_auth.sql
less 0001_launcher_auth.sql
```

Le fichier attendu contient, entre un `BEGIN;` et un `COMMIT;` :

* 12 `CREATE TABLE` ;
* 2 `CREATE INDEX` (`idx_auth_refresh_user`, `idx_auth_audit_user`) ;
* 1 `UPDATE alembic_version SET version_num='0001_launcher_auth' WHERE … = 'a1b2c3d4e5f6';`
* **rien d'autre.**

> Indiquez toujours la révision de départ (`a1b2c3d4e5f6:head`). Sans elle,
> Alembic ne sait pas où en est la base et ajoute un `CREATE TABLE alembic_version`
> parasite, qui échouerait en production.

Ce fichier est directement applicable par un administrateur de base
(`psql opmdb -v ON_ERROR_STOP=1 -f 0001_launcher_auth.sql`) si vous préférez que
la migration passe par vos outils habituels plutôt que par Alembic.

### Étape 5 — Appliquer

```bash
alembic upgrade head
```

Sortie attendue :

```
INFO  [alembic.runtime.migration] Running upgrade a1b2c3d4e5f6 -> 0001_launcher_auth, launcher : authentification souveraine (12 tables additives)
```

La migration commence par quatre contrôles ; en cas de doute elle s'arrête
**avant** de créer quoi que ce soit, avec un message explicite :

* la table `users` doit exister **sur PostgreSQL** — non par principe, mais parce
  que le moteur refuserait les clés étrangères vers `users(id)`. Sur SQLite
  (développement, intégration continue) son absence n'est qu'un avertissement, et
  la migration s'applique normalement sur une base vide ;
* `users.id` doit être un entier, si la table est là (sinon : schéma inattendu) ;
* sur la base du site avec l'historique partagé, `OPM_SITE_ALEMBIC_REVISION` doit
  être renseignée (sinon : l'historique du site serait cassé) ;
* aucune des 12 tables ne doit déjà exister (sinon : migration déjà appliquée).

Ces contrôles sont ignorés en mode hors ligne (`--sql`), où aucune connexion n'est
ouverte : l'étape 4 relit le SQL, elle ne vérifie pas la base.

### Étape 6 — Vérifier

```bash
psql opmdb
```

```sql
-- 1. La révision a avancé
SELECT version_num FROM alembic_version;          -- 0001_launcher_auth

-- 2. Les 12 tables sont là
\dt auth_*
\dt ygg_*
\dt texture
\dt user_texture
\dt launcher_instance

-- 3. Le détail d'une table, au hasard
\d auth_mc_link

-- 4. Le site est intact : 11 tables, aucune colonne ajoutée
SELECT count(*) FROM information_schema.columns WHERE table_name = 'users';   -- 40
SELECT count(*) FROM users;                                                    -- inchangé
SELECT count(*) FROM article;                                                  -- inchangé
```

Puis, côté site : rechargez une page de profil et une page du journal. Rien ne
doit avoir bougé — le site ignore l'existence des nouvelles tables.

### Étape 7 — Accorder les droits au rôle applicatif

Le serveur d'authentification tourne sous un rôle dédié, **sans** droit de
création ni de suppression de table, et en lecture seule sur presque tout le site.
À exécuter une fois, en tant que propriétaire de la base :

```sql
-- Le rôle applicatif (à créer s'il n'existe pas ; mot de passe hors de ce dépôt)
-- CREATE ROLE opm_auth LOGIN PASSWORD '…';

GRANT CONNECT ON DATABASE opmdb TO opm_auth;
GRANT USAGE   ON SCHEMA public  TO opm_auth;

-- 1. Tables du launcher : lecture et écriture complètes
GRANT SELECT, INSERT, UPDATE, DELETE ON
    auth_mc_link, auth_refresh_token, auth_totp, auth_recovery_code,
    auth_password_reset, auth_ban, auth_audit, ygg_session, ygg_join,
    texture, user_texture, launcher_instance
  TO opm_auth;

-- Les séquences des colonnes « serial » / « bigserial »
GRANT USAGE, SELECT ON SEQUENCE
    auth_mc_link_id_seq, auth_refresh_token_id_seq, auth_recovery_code_id_seq,
    auth_password_reset_id_seq, auth_ban_id_seq, auth_audit_id_seq,
    ygg_session_id_seq, texture_id_seq, launcher_instance_id_seq
  TO opm_auth;

-- 2. Tables du site : LECTURE SEULE
GRANT SELECT ON
    users, article, statistiques, equipages, iles, combats, produits, equipe, securite
  TO opm_auth;

-- 3. Les seules écritures autorisées sur le site (docs/DATA.md §3 et §4),
--    accordées colonne par colonne : PostgreSQL refusera tout le reste.
--
--    « password_hash » est indispensable : à chaque connexion réussie, une
--    empreinte du site encore à 260 000 itérations est réécrite à 600 000 dans
--    le MÊME format Werkzeug. Sans ce droit, plus aucun compte historique ne
--    peut se connecter (échec au flush du renforcement).
GRANT UPDATE (derniereconnexion, tempsdejeu, password_hash)      ON users        TO opm_auth;
GRANT UPDATE (joueurs_en_ligne, record_joueurs, record_date)     ON statistiques TO opm_auth;

-- 4. Création de compte depuis le launcher : INSERT sur users, et la séquence
--    qui alimente users.id. Sans cela, POST /api/v1/auth/register répond
--    « permission denied for table users ».
GRANT INSERT             ON users        TO opm_auth;
GRANT USAGE, SELECT ON SEQUENCE users_id_seq TO opm_auth;
```

Volontairement **non accordés** : `CREATE` sur `public`, `DELETE` sur `users`,
toute écriture sur `alembic_version`, sur `contact`, et sur les colonnes RP de
`users` (`prime`, `berry`, `niveau*`, `faction`, `equipage`…). Si un jour une
régression tentait d'écrire une prime depuis le launcher, la base la refuserait.
C'est la ceinture en plus des bretelles.

> **Note.** Le nom de la séquence (`users_id_seq`) est celui d'une colonne
> `serial` classique ; vérifiez-le sur votre base avec
> `SELECT pg_get_serial_sequence('users', 'id');` avant de copier la commande.

Contrôle :

```sql
SET ROLE opm_auth;
UPDATE users SET prime = 1 WHERE id = 1;   -- doit échouer : permission denied
DELETE FROM users WHERE id = 1;            -- doit échouer : permission denied
RESET ROLE;
```

---

## 4. Retour arrière

### Cas 1 — La migration vient de passer et pose problème

```bash
alembic downgrade "$OPM_SITE_ALEMBIC_REVISION"   # la révision relevée à l'étape 2
# (historiques séparés : « alembic downgrade base »)
```

Les 12 tables sont supprimées dans l'ordre inverse des dépendances, la ligne
`alembic_version` revient à la révision du site, et le schéma retrouve son état
d'origine à l'octet près. **Les données du launcher sont perdues**
(rattachements Microsoft, sessions, textures, audit) : sur une base déjà en
service, prévenez avant.

Vérification :

```sql
SELECT version_num FROM alembic_version;                    -- a1b2c3d4e5f6
SELECT count(*) FROM information_schema.tables
 WHERE table_schema = 'public' AND table_name LIKE 'auth\_%';  -- 0
```

### Cas 2 — La migration a échoué en cours de route

Il n'y a rien à faire : Alembic et PostgreSQL exécutent la migration dans une
transaction unique. Un échec annule tout. Lisez le message d'erreur, corrigez,
recommencez à l'étape 4.

### Cas 3 — La base est dans un état incohérent

Restauration de la sauvegarde de l'étape 1, site arrêté :

```bash
sudo systemctl stop opm-site opm-auth
dropdb opmdb && createdb opmdb
pg_restore --dbname=opmdb --no-owner "opmdb-avant-launcher-….dump"
sudo systemctl start opm-site
```

---

## 5. Cohabitation avec l'Alembic du site

**Le point le plus important de cette page**, et le seul qui demande une décision.
La base du site possède déjà une table `alembic_version` contenant *sa* révision
courante. Notre `migrations/env.py` utilise aujourd'hui **cette même table**
(`"version_table": "alembic_version"`). Deux historiques, une seule table : il
faut trancher entre les faire cohabiter (option A) ou les séparer (option B).

### Option A — Historique partagé

`OPM_SITE_ALEMBIC_REVISION` chaîne notre révision à celle du site (étape 3). Deux
conséquences, toutes deux obligatoires :

**A1. Alembic, chez nous, doit voir les fichiers de révision du site.** Sinon la
moindre commande échoue, y compris `alembic current` : Alembic lit la révision
courante dans la base et ne sait pas l'identifier.

```ini
# auth-server/alembic.ini
version_locations = migrations/versions /chemin/du/site/migrations/versions
version_path_separator = space
```

**A2. Le dépôt du site doit voir notre fichier.** Une fois `alembic_version` passé
à `0001_launcher_auth`, la prochaine commande lancée depuis le dépôt du site
échouerait sur `Can't locate revision identified by '0001_launcher_auth'` :

```bash
cp migrations/versions/0001_launcher_auth.py /chemin/du/site/migrations/versions/
```

Le site reprend alors la main sur son historique (`alembic current`,
`alembic history`, `alembic upgrade head` fonctionnent comme avant) et sa
prochaine migration se chaînera naturellement sur `0001_launcher_auth`. Une
migration appliquée ne se modifie plus : la copie ne divergera pas.

### Option B — Historiques séparés *(la plus simple à exploiter)*

Donner à nos migrations leur propre table de versions, en changeant **une ligne**
de `migrations/env.py` :

```python
"version_table": "alembic_version_launcher",
```

`OPM_SITE_ALEMBIC_REVISION` reste alors vide pour toujours, `down_revision` vaut
`None`, les deux historiques n'interfèrent jamais, rien n'est à copier d'un dépôt
à l'autre, et le site n'a strictement rien à savoir de nous. Le prix à payer :
deux tables de version dans la base, et un `pg_dump` qui ne raconte plus une
histoire unique.

> **État actuel du dépôt : option A.** `env.py` vise `alembic_version`. Si vous
> préférez l'option B, faites la bascule **avant** la première application en
> production : après coup, il faudrait défaire à la main la ligne écrite dans
> `alembic_version`.

Dans les deux cas, la migration vérifie la cohérence au démarrage et refuse de
s'exécuter sur une configuration bancale (étape 5, troisième contrôle).

---

## 6. Notes techniques

**Horodatages.** Toutes les colonnes de date sont en `timestamp without time zone`,
comme celles du site (`users.derniereconnexion`, `article.published_date`,
`combats.date`). Les valeurs stockées sont en **UTC naïf**. Les modèles
SQLAlchemy du serveur doivent donc utiliser `DateTime()` **sans** fuseau et
écrire des `datetime` naïfs en UTC : une base qui mélangerait `timestamp` et
`timestamptz` produirait des décalages silencieux entre le site et le launcher.

**`char(n)` plutôt que `varchar(n)`** pour les empreintes de longueur fixe
(`token_hash`, `sha256`, `access_token`, `ip_hash` : 64 caractères hexadécimaux ;
`minecraft_uuid` : 32). La longueur est structurelle, autant que la base le dise.

**`jsonb`** pour `launcher_instance.ignored` et `whitelist`, avec `DEFAULT '[]'`
(PostgreSQL convertit le littéral tout seul ; l'expression reste valable sur le
SQLite de développement).

**Portabilité.** La migration s'applique aussi sur SQLite (développement, tests) :
`sa.Uuid` devient `uuid` sur PostgreSQL et `char(32)` ailleurs, `bigserial`
devient un `INTEGER` auto-incrémenté, `jsonb` devient `json`. Le schéma de
production reste celui décrit dans `docs/DATA.md` §2.

**Autogénération.** `migrations/env.py` filtre les tables du site
(`include_name` / `include_object`) : un `alembic revision --autogenerate` ne
verra jamais `users` ni `statistiques`, et ne pourra donc pas proposer de les
supprimer parce qu'elles n'ont pas de modèle en face. Le filtre est la liste
`TABLES_LAUNCHER` en tête de `env.py` : toute nouvelle table du launcher doit y
être ajoutée en même temps qu'à son modèle.

---

## 7. Aide-mémoire

```bash
cd auth-server

# Base du site, historique partagé (option A) : la variable désigne le point
# d'accrochage. Base neuve (dev, CI) : ne pas l'exporter.
export OPM_SITE_ALEMBIC_REVISION=a1b2c3d4e5f6

alembic current                        # révision appliquée dans la base
alembic history --verbose              # historique connu des fichiers
alembic heads                          # têtes (doit en afficher UNE seule)
alembic upgrade <rev_site>:head --sql  # SQL de la migration, pour relecture
alembic upgrade head                   # application
alembic downgrade <rev_site>           # retour arrière
alembic revision -m "…"                # nouvelle migration, à écrire à la main
```

**Ne jamais utiliser en production :** `alembic stamp` (ment sur l'état réel de la
base), `alembic downgrade base` (détruirait aussi l'historique du site), et
`init_models()` / `Base.metadata.create_all()` côté application, qui refusent
d'ailleurs de s'exécuter quand `OPM_ENV=prod`.
