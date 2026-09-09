# Données, base et cache — adossé à la base réelle du site OPM

> **Remplace la version provisoire.** Écrit à partir du dump `opmdb.gz`
> (PostgreSQL 17, base du site Flask, 11 tables, migrations alembic).
> **Règle d'or : le launcher lit la base du site. Il n'en crée pas une deuxième.**

---

## 1. Ce qui existe déjà — et ce que le launcher en fait

La base du site couvre **presque tout** ce que la maquette affiche. Rien à réinventer.

| Table | Colonnes utiles au launcher | Écran du launcher |
|---|---|---|
| `users` | `id, name, email, password_hash, faction, metier, equipage, territoires, prime, berry, niveaubase, tempsdejeu, derniereconnexion, votes_mois, role_equipage, titres` | identité, « VOTRE PERSONNAGE », comptes |
| `article` | `id, title, content, published_date, url, image, categorie, auteur` | **JOURNAL DE BORD** (carte + liste) |
| `statistiques` | `joueurs_en_ligne, record_joueurs, evenement_nom, evenement_date, votes, votes_objectif, dons_collecte, dons_objectif, donateurs, server_ip, launcher_windows/mac/linux` | tuiles de l'accueil, compte à rebours, donation, mise à jour |
| `equipages` | `nom, reputation, membres, iles, caisse, jolly_roger, devise` | sous-titre du personnage |
| `iles` | `nom, equipage_id, detenteur, principale, statut` | « 3 îles tenues » |
| `combats` | `joueur_id, resultat, gain, date` | (réserve : statistiques de profil) |
| `produits` | `name, price, gigot` | paliers de la boutique |
| `equipe` | `name, titre, domaine` | (réserve : crédits) |
| `securite` | `tokenpaiement` | jeton de paiement |
| `contact` | — | non utilisé |
| `alembic_version` | — | **c'est par là que passeront nos migrations** |

Le mappage exact des valeurs de démonstration de la maquette :

| Maquette | Source réelle |
|---|---|
| « 47 joueurs » en ligne | `statistiques.joueurs_en_ligne` |
| « PROCHAIN ÉVÉNEMENT RP » + compte à rebours | `statistiques.evenement_nom`, `evenement_date` |
| « VOTES DU MOIS 812 / 1 000 » | `statistiques.votes`, `votes_objectif` |
| « 142 € / 200 € », « 14 donateurs » | `statistiques.dons_collecte`, `dons_objectif`, `donateurs` |
| `play.onepieceminecraft.fr` | `statistiques.server_ip` |
| Les 3 news + la grande carte | `article` triée sur `published_date DESC`, la plus récente en vedette |
| Étiquette `ACTUALITÉ` / `ÉVÉNEMENT` | `article.categorie` (aujourd'hui : 15 lignes, toutes `Actualité`) |
| « Pirate · Équipage des Cœurs Brisés · 3 îles tenues » | `users.faction` · `users.equipage` · `COUNT(iles)` du même équipage |
| Pseudo affiché | `users.name` dans le launcher, pseudo **Minecraft** en jeu |
| Téléchargement de mise à jour | `statistiques.launcher_windows / _mac / _linux` |

> `article.categorie` est un `varchar(50)` libre : le launcher colore l'étiquette selon la valeur
> (`Actualité` → fond `--chip`, `Événement` → fond `--aqua`, `Mise à jour` → fond `--ink`) et
> retombe sur un style neutre pour toute autre valeur. Aucune migration nécessaire pour en ajouter.

---

## 2. Ce qui manque — 11 tables à **ajouter**, jamais à modifier

Le site n'a ni UUID Minecraft, ni rattachement Microsoft, ni skin, ni 2FA, ni session.
On ajoute, on ne touche pas à l'existant. Préfixes explicites (`auth_`, `ygg_`, `launcher_`)
pour que la propriété de chaque table soit lisible d'un coup d'œil par n'importe qui reprend le projet.

```sql
-- Identité Minecraft : le cœur du rattachement (1 ligne par utilisateur au plus)
CREATE TABLE auth_mc_link (
    id                    serial PRIMARY KEY,
    user_id               integer NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    msa_sub               varchar(64)  NOT NULL UNIQUE,   -- identifiant Microsoft stable
    minecraft_uuid        char(32)     NOT NULL UNIQUE,   -- UUID PREMIUM RÉEL, sans tirets
    minecraft_username    varchar(16)  NOT NULL,
    owns_minecraft        boolean      NOT NULL DEFAULT false,
    verified_at           timestamp    NOT NULL,
    expires_at            timestamp    NOT NULL,          -- verified_at + 30 j
    msa_refresh_enc       bytea,                          -- AES-256-GCM
    msa_refresh_nonce     bytea,
    created_at            timestamp    NOT NULL DEFAULT now(),
    updated_at            timestamp    NOT NULL DEFAULT now()
);

-- Sessions du launcher
CREATE TABLE auth_refresh_token (
    id           serial PRIMARY KEY,
    user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   char(64) NOT NULL UNIQUE,     -- SHA-256 du jeton opaque
    family_id    uuid     NOT NULL,            -- détection de rejeu
    device_label varchar(120),
    issued_at    timestamp NOT NULL DEFAULT now(),
    expires_at   timestamp NOT NULL,
    revoked_at   timestamp,
    replaced_by  integer REFERENCES auth_refresh_token(id)
);
CREATE INDEX idx_auth_refresh_user ON auth_refresh_token (user_id, revoked_at);

-- 2FA (optionnelle, séparée pour ne pas toucher users)
CREATE TABLE auth_totp (
    user_id     integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_enc  bytea NOT NULL,
    nonce       bytea NOT NULL,
    enabled     boolean NOT NULL DEFAULT false,
    confirmed_at timestamp
);
CREATE TABLE auth_recovery_code (
    id        serial PRIMARY KEY,
    user_id   integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash varchar(255) NOT NULL,
    used_at   timestamp
);

CREATE TABLE auth_password_reset (
    id         serial PRIMARY KEY,
    user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash char(64) NOT NULL UNIQUE,
    expires_at timestamp NOT NULL,
    used_at    timestamp
);

CREATE TABLE auth_ban (
    id         serial PRIMARY KEY,
    user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason     text NOT NULL,
    until      timestamp,                      -- NULL = définitif
    created_by varchar(80),
    created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE auth_audit (
    id         bigserial PRIMARY KEY,
    user_id    integer REFERENCES users(id) ON DELETE SET NULL,
    action     varchar(60) NOT NULL,
    ip_hash    char(64),
    user_agent varchar(255),
    meta       jsonb,
    created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_audit_user ON auth_audit (user_id, created_at DESC);

-- Yggdrasil : les sessions de jeu que NOUS signons
CREATE TABLE ygg_session (
    id            serial PRIMARY KEY,
    user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    access_token  char(64) NOT NULL UNIQUE,    -- SHA-256 du JWT émis
    client_token  varchar(64) NOT NULL,
    issued_at     timestamp NOT NULL DEFAULT now(),
    expires_at    timestamp NOT NULL,
    invalidated_at timestamp
);
CREATE TABLE ygg_join (
    server_id  varchar(64) PRIMARY KEY,
    user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip         varchar(45),
    created_at timestamp NOT NULL DEFAULT now()   -- TTL 30 s
);

-- Skins et capes : blob adressé par son contenu
CREATE TABLE texture (
    id         serial PRIMARY KEY,
    sha256     char(64) NOT NULL UNIQUE,
    kind       varchar(8)  NOT NULL,            -- skin | cape
    model      varchar(8)  NOT NULL DEFAULT 'classic',   -- classic | slim
    width      integer NOT NULL,
    height     integer NOT NULL,
    bytes      integer NOT NULL,
    source     varchar(16) NOT NULL,            -- upload | mojang_import | default
    created_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE user_texture (
    user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       varchar(8) NOT NULL,
    texture_id integer REFERENCES texture(id),  -- NULL = skin par défaut
    updated_at timestamp NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, kind)
);

-- Profils de jeu (remplace l'URL statique de l'ancien launcher)
CREATE TABLE launcher_instance (
    id              serial PRIMARY KEY,
    name            varchar(60) NOT NULL UNIQUE,
    display_name    varchar(80) NOT NULL,
    url             varchar(255) NOT NULL,
    version         varchar(20) NOT NULL,
    loader_type     varchar(20) NOT NULL DEFAULT 'none',
    loader_version  varchar(40),
    verify          boolean NOT NULL DEFAULT true,
    ignored         jsonb NOT NULL DEFAULT '[]'::jsonb,
    whitelist_active boolean NOT NULL DEFAULT false,
    whitelist       jsonb NOT NULL DEFAULT '[]'::jsonb,
    status_host     varchar(120),
    status_port     integer DEFAULT 25565,
    sort_order      integer NOT NULL DEFAULT 0,
    enabled         boolean NOT NULL DEFAULT true
);
```

**Migration :** un seul fichier alembic additif dans le dépôt du site
(`alembic revision -m "launcher: auth souveraine"`), aucune colonne existante modifiée,
aucune donnée touchée. `alembic downgrade` supprime proprement les 11 tables.
Le site continue de fonctionner sans rien savoir de leur existence.

### Pas de table de dons — décision assumée

La partie paiement n'est pas terminée côté site. On ne crée donc **aucune** table de dons,
et le launcher ne s'invente pas de données :

- la carte « objectif du mois » lit uniquement `statistiques.dons_collecte`, `dons_objectif`
  et `donateurs` — chiffres réels, déjà tenus par le site ;
- les 4 paliers (25/50/75/100 %) sont calculés depuis ce ratio, avec leurs trois états ;
- le classement « MERCI À L'ÉQUIPAGE » n'a pas de source : il affiche un **état vide honnête**
  (« Le classement des donateurs arrive bientôt »), pas trois faux donateurs ;
- le bouton « FAIRE UN DON » ouvre la page de don du site dans le navigateur
  (`https://onepieceminecraft.fr/don`, configurable par `OPM_DONATION_URL`) au lieu de
  déclencher un paiement dans le launcher.

Le jour où la partie paiement sera prête, il suffira d'ajouter une table de dons et de brancher
`GET /api/v1/donations` dessus : le reste de l'écran est déjà en place.

---

## 3. Mots de passe — le point délicat

Votre site hache avec **Werkzeug `pbkdf2:sha256:260000`** (`generate_password_hash` de Flask).

Je renonce donc à Argon2id, et voici pourquoi c'est le bon choix ici : si le serveur d'auth
réécrivait les hachages en Argon2id, **le site ne saurait plus vérifier les mots de passe** —
Werkzeug ne connaît pas ce format. Vos joueurs ne pourraient plus se connecter au site.

La stratégie retenue :

1. Le serveur d'auth **lit et écrit le format Werkzeug**, exactement comme le site.
   Un compte créé depuis le launcher se connecte au site, et réciproquement. Un seul compte, partout.
2. **Renforcement transparent** : à chaque connexion réussie, si le hachage est encore à
   260 000 itérations, on le réécrit à **600 000** (`pbkdf2:sha256:600000`). Werkzeug lit le
   nombre d'itérations dans le hachage lui-même : le site continue de fonctionner sans
   une ligne de code à changer, et le parc se renforce tout seul au fil des connexions.
3. Le passage à Argon2id reste possible plus tard, **le jour où le site migrera aussi**
   (Werkzeug ≥ 2.3 sait faire `scrypt` ; Argon2id demanderait `passlib` des deux côtés).
   Le code isole la vérification dans `security/passwords.py` pour que ce soit une seule fonction à changer.

Contrainte de robustesse à l'inscription : 12 caractères minimum côté launcher. Les comptes
existants ne sont pas invalidés — on ne force rien rétroactivement.

---

## 4. Ce que le launcher écrit dans la base du site

Le launcher n'est pas un consommateur passif. Il enrichit le profil que le site affiche :

| Quand | Écriture |
|---|---|
| Connexion au launcher | `users.derniereconnexion = now()` |
| Fin d'une session de jeu | `users.tempsdejeu += durée` (en secondes) |
| Rattachement Microsoft | `auth_mc_link` + import du skin dans `texture` / `user_texture` |
| Re-vérification de possession | `auth_mc_link.verified_at`, `expires_at`, `minecraft_username` |
| Toutes les 20 s (tâche de fond) | `statistiques.joueurs_en_ligne`, `record_joueurs`, `record_date` |

Les colonnes RP (`prime`, `berry`, `niveau*`, `faction`, `equipage`…) restent la propriété du
serveur Minecraft et du site — le launcher les **lit** pour l'affichage, jamais l'inverse.

### Le ping du serveur écrit dans `statistiques`

Le site fera le même ping de son côté. Deux écrivains sur une ligne unique, donc **une seule
instruction atomique**, jamais de lecture-puis-écriture (qui perdrait un record en cas de course) :

```sql
UPDATE statistiques
   SET joueurs_en_ligne = :online,
       record_joueurs   = GREATEST(record_joueurs, :online),
       record_date      = CASE WHEN :online > record_joueurs THEN :today ELSE record_date END
 WHERE id = 1;
```

`GREATEST` et le `CASE` garantissent qu'aucun des deux écrivains ne peut écraser un record
établi par l'autre. Le dernier à écrire gagne sur `joueurs_en_ligne`, ce qui est sans
conséquence : les deux mesurent la même chose à 20 s près.

Réglages : `OPM_STATS_WRITE` (défaut `true`) coupe l'écriture d'un seul interrupteur si le site
reprend la main, et `OPM_STATS_INTERVAL` (défaut `20`) règle la cadence. Si le ping échoue,
on **n'écrit rien** — on ne remplace pas une valeur connue par un zéro sur un simple timeout.
Le TPS et la latence, absents du schéma, restent en cache mémoire côté serveur d'auth.

---

## 5. Durées de cache

| Donnée | Source | TTL serveur | TTL launcher | Repli hors ligne |
|---|---|---|---|---|
| Possession Microsoft | `auth_mc_link.expires_at` | **30 j** | — | ✅ le joueur joue |
| Compte, pseudo, UUID | `users` + `auth_mc_link` | — | permanent | ✅ |
| Blob de skin `{sha256}.png` | fichier | immuable | **illimité** | ✅ |
| Skin actif | `user_texture` | 60 s | **24 h** | ✅ |
| Journal | `article` | 5 min | 5 min | ✅ marqué « hors ligne » |
| Tuiles / évènement / votes / dons | `statistiques` | 60 s | 60 s | ✅ |
| Statut serveur (TPS, latence) | ping natif sur `statistiques.server_ip` | 20 s | 30 s | ✅ |
| Profil RP (équipage, îles) | `equipages`, `iles` | 5 min | 5 min | ✅ |
| Instances | `launcher_instance` | 60 s | 60 s | ✅ **obligatoire** |
| Session de jeu Yggdrasil | `ygg_session` | — | 24 h | ❌ voir §7 |

Une réponse servie depuis un cache périmé porte `"stale": true` + l'en-tête `X-OPM-Stale: 1`,
et le launcher affiche un bandeau discret « données hors ligne » plutôt qu'un écran vide.

---

## 6. Le skin

Au rattachement Microsoft, la réponse de `https://api.minecraftservices.com/minecraft/profile`
contient déjà le skin actif et son modèle. Le serveur, dans la même transaction : télécharge
(5 s, 200 Ko max), valide (PNG réel, 64×64 ou 64×32), ré-encode via Pillow, calcule le `sha256`,
insère dans `texture` si absent, pointe `user_texture` dessus.

**Le joueur retrouve son apparence sans rien faire**, et à partir de là c'est vous qui l'hébergez.
Un échec d'import n'est jamais bloquant : skin par défaut, nouvelle tentative à la
prochaine re-vérification. Service via `GET /textures/{sha256}.png`,
`Cache-Control: public, max-age=31536000, immutable`, URL signée RSA dans le profil Yggdrasil.

---

## 7. Ce que le cache ne peut pas faire

- **Microsoft indisponible** → aucun impact. La possession est en base pour 30 jours.
  *C'est exactement ce qu'on achète avec la souveraineté.*
- **Serveur d'auth OPM indisponible** → le launcher démarre, affiche compte, skin et dernier
  journal depuis son cache, mais **ne peut pas lancer le jeu** : la session Yggdrasil est courte
  et le serveur Minecraft doit joindre l'API pour valider la connexion.
  Le bouton passe en « SERVEUR D'AUTHENTIFICATION INJOIGNABLE ».

Le serveur d'auth doit donc être au moins aussi disponible que le serveur Minecraft.
Il partage déjà la base PostgreSQL du site : le plus simple est de le déployer sur le même VPS,
en second service nginx (`auth.onepieceminecraft.fr`), à côté de gunicorn.

---

## 8. Identité Minecraft — décision structurante

Le profil Yggdrasil utilise **l'UUID premium réel** (`auth_mc_link.minecraft_uuid`), jamais un
UUID généré : mondes, LuckPerms, économie, claims, bans et statistiques sont déjà indexés dessus,
donc **aucun joueur ne perd sa progression**. Un compte Minecraft ne peut être rattaché qu'à un
seul compte OPM (contrainte `UNIQUE` sur `minecraft_uuid` et `msa_sub`, sinon `409 already_linked`).

Le pseudo affiché **en jeu** est `auth_mc_link.minecraft_username` (resynchronisé à chaque
re-vérification), pas `users.name` — pour que commandes, bans et logs du serveur restent cohérents.

`OPM_YGG_MOJANG_FALLBACK` (défaut `false`) : si activé, `hasJoined` interroge le sessionserver
de Mojang quand le pseudo est inconnu, ce qui laisse entrer les joueurs premium venus du launcher
officiel. À laisser désactivé en mode « hybride imposé ».
