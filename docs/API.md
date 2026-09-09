# Contrat d'API — OPM Auth & Launcher API

> **Source de vérité.** Le launcher Electron et le serveur Python doivent se conformer
> strictement à ce document. Toute divergence est un bug.

Base URL par défaut : `https://auth.onepieceminecraft.fr`
(en développement : `http://127.0.0.1:8000`)

Toutes les réponses sont en `application/json; charset=utf-8`.
Toutes les dates sont ISO-8601 UTC (`2026-09-08T11:34:00Z`).

---

## 0. Modèle d'authentification (mode HYBRIDE IMPOSÉ)

```
                    ┌──────────────────────────────────────────────┐
   1. Compte OPM    │  email + mot de passe (Werkzeug) + TOTP 2FA  │
                    └──────────────────────────────────────────────┘
                                       │
                    ┌──────────────────▼───────────────────────────┐
   2. Rattachement  │  Microsoft = simple ORACLE DE POSSESSION     │
      obligatoire   │  Vérifié UNE fois côté serveur Python,       │
                    │  puis mis en cache (TTL configurable).       │
                    └──────────────────┬───────────────────────────┘
                                       │
                    ┌──────────────────▼───────────────────────────┐
   3. Session de    │  Yggdrasil MAISON signé Ed25519 par NOUS.    │
      jeu           │  authlib-injector côté serveur Minecraft.    │
                    │  Aucun jeton Microsoft ne touche le jeu.     │
                    └──────────────────────────────────────────────┘
```

Trois familles de jetons, à ne jamais confondre :

| Jeton | Émetteur | Durée | Porté par | Usage |
|---|---|---|---|---|
| `access_token` (JWT EdDSA) | nous | 15 min | `Authorization: Bearer` | API launcher |
| `refresh_token` (opaque, 512 bits) | nous | 30 j, rotatif | corps JSON | renouvellement |
| `yggdrasil.accessToken` (JWT EdDSA) | nous | 24 h | ligne de commande Minecraft | session de jeu |

Le `refresh_token` Microsoft est **chiffré au repos** (AES-256-GCM, clé `MSA_TOKEN_KEY`)
et ne quitte **jamais** le serveur.

---

## 1. API Launcher — `/api/v1`

### 1.1 `GET /api/v1/bootstrap`

Appelé au démarrage, avant tout le reste. Non authentifié.

```json
{
  "launcher": {
    "version_min": "2.0.0",
    "version_latest": "2.0.0",
    "download_url": "https://.../OPMLauncher-win-x64.exe"
  },
  "maintenance": { "active": false, "message": null, "eta": null },
  "auth": {
    "mode": "hybrid",
    "microsoft_required": true,
    "registration_open": true,
    "flow": "embedded"
  },
  "server": { "host": "play.onepieceminecraft.fr", "port": 25565 },
  "links": {
    "discord": "https://discord.gg/ekDKBDFfda",
    "twitch":  "https://www.twitch.tv/onepieceminecraftfr",
    "youtube": "https://www.youtube.com/@onepieceminecraftfr457",
    "website": "https://onepieceminecraft.fr"
  }
}
```

`auth.mode` ∈ `sovereign | hybrid | microsoft`. `auth.flow` ∈ `embedded | device`.

### 1.2 Comptes OPM

| Méthode | Chemin | Corps | Réponse |
|---|---|---|---|
| `POST` | `/api/v1/auth/register` | `{email, password, username}` | `201 {user}` |
| `POST` | `/api/v1/auth/login` | `{email, password, totp?}` | `200 {access_token, refresh_token, expires_in, user}` ou `401 {error:"totp_required"}` |
| `POST` | `/api/v1/auth/refresh` | `{refresh_token}` | `200 {access_token, refresh_token, expires_in}` |
| `POST` | `/api/v1/auth/logout` | `{refresh_token}` | `204` |
| `GET`  | `/api/v1/auth/me` | — | `200 {user}` |
| `POST` | `/api/v1/auth/password/forgot` | `{email}` | `202` (toujours, anti-énumération) |
| `POST` | `/api/v1/auth/password/reset` | `{token, password}` | `204` |
| `POST` | `/api/v1/auth/totp/setup` | — | `200 {secret, otpauth_uri, recovery_codes[]}` |
| `POST` | `/api/v1/auth/totp/enable` | `{code}` | `204` |
| `POST` | `/api/v1/auth/totp/disable` | `{password, code}` | `204` |

Objet `user` :

> `id` est l'**entier** `users.id` de la base du site (clé primaire `serial`), pas un UUID.
> `username` est `users.name`. Voir `DATA.md`.

```json
{
  "id": 7,
  "email": "capitaine@exemple.fr",
  "username": "Melodia",
  "role": "player",
  "totp_enabled": true,
  "created_at": "2026-01-04T09:12:00Z",
  "profile": {
    "faction": "Pirate",
    "metier": "Charpentier",
    "equipage": "Les Cœurs Brisés",
    "iles_tenues": 3,
    "prime": 42000000,
    "berry": 128400,
    "niveau": 47,
    "temps_de_jeu_s": 918000
  },
  "microsoft": {
    "linked": true,
    "minecraft_uuid": "4f2a9c81b0e64d7e8b1c2d3e4f5a6b7c",
    "minecraft_username": "Melodia",
    "verified_at": "2026-09-01T18:22:00Z",
    "expires_at": "2026-10-01T18:22:00Z",
    "owns_minecraft": true
  },
  "can_play": true,
  "blocked_reason": null
}
```

`can_play` est **la** valeur que le launcher regarde pour activer le bouton JOUER.
`blocked_reason` ∈ `null | microsoft_required | microsoft_expired | ownership_missing | banned | email_unverified`.

### 1.3 Rattachement Microsoft

| Méthode | Chemin | Corps | Réponse |
|---|---|---|---|
| `POST` | `/api/v1/link/microsoft/start` | — | `200 {flow, ...}` |
| `POST` | `/api/v1/link/microsoft/complete` | `{state, code}` | `200 {user}` |
| `POST` | `/api/v1/link/microsoft/poll` | `{device_code}` | `200 {user}` / `202 {status:"pending"}` |
| `POST` | `/api/v1/link/microsoft/refresh` | — | `200 {user}` (re-vérification de possession) |
| `DELETE` | `/api/v1/link/microsoft` | `{password}` | `204` |

`start` en mode `embedded` :

```json
{ "flow": "embedded",
  "authorize_url": "https://login.live.com/oauth20_authorize.srf?client_id=…",
  "redirect_uri": "https://login.live.com/oauth20_desktop.srf",
  "state": "b3f1…" }
```

`start` en mode `device` :

```json
{ "flow": "device",
  "verification_uri": "https://microsoft.com/link",
  "user_code": "H8KQ-2LMP",
  "device_code": "…",
  "interval": 5,
  "expires_in": 900 }
```

> Le launcher **n'échange jamais** le code lui-même : il transmet `code` + `state`
> au serveur Python, qui exécute XBL → XSTS → Minecraft Services → `/minecraft/profile`.
> Un compte Minecraft ne peut être rattaché qu'à **un seul** compte OPM (`409 already_linked`).

### 1.4 Session de jeu

`POST /api/v1/game/session` → délivre la session Yggdrasil à passer au jeu.

```json
{ "access_token": "eyJhbGciOiJFZERTQSJ9…",
  "client_token": "1f4c…",
  "uuid": "4f2a9c81b0e64d7e8b1c2d3e4f5a6b7c",
  "name": "Melodia",
  "user_properties": "{}",
  "meta": { "type": "OPM", "demo": false, "expires_at": "2026-09-09T11:34:00Z" }
}
```

Réponse mappée telle quelle sur l'objet `authenticator` de `minecraft-java-core`.
Erreurs : `403 {"error":"microsoft_required"}`, `403 {"error":"banned","until":…}`.

### 1.5 Contenu du launcher

| Méthode | Chemin | Réponse |
|---|---|---|
| `GET` | `/api/v1/news?limit=10` | `{ "featured": {…}, "items": [{id,kind,title,excerpt,body_html,published_at,url}] }` |
| `GET` | `/api/v1/instances` | `[{name, url, verify, ignored[], loadder{…}, status{ip,port,nameServer}, whitelistActive, whitelist[]}]` |
| `GET` | `/api/v1/status` | `{online, players_online, players_max, tps, motd, latency_ms}` |
| `GET` | `/api/v1/events/next` | `{title, starts_at, description}` |
| `GET` | `/api/v1/votes` | `{count, goal, reward, reset_at}` |
| `GET` | `/api/v1/donations` | `{collected_cents, goal_cents, currency, donors_count, days_left, tiers[], top[]}` |
| `POST` | `/api/v1/donations/checkout` | `{amount_cents}` → `{checkout_url}` |

`kind` d'une news ∈ `news | event | update`. Le format `instances` est **volontairement
identique** à celui de l'ancien launcher pour rester compatible `minecraft-java-core`.

---

## 2. API Yggdrasil — `/yggdrasil`

Implémentation du protocole Mojang attendue par **authlib-injector**.
C'est ce qui rend le serveur Minecraft indépendant de Mojang.

### 2.1 `GET /yggdrasil` — métadonnées (ALI)

```json
{
  "meta": {
    "serverName": "One Piece Minecraft",
    "implementationName": "opm-yggdrasil",
    "implementationVersion": "1.0.0",
    "links": { "homepage": "https://onepieceminecraft.fr", "register": "https://onepieceminecraft.fr/register" },
    "feature.non_email_login": true
  },
  "skinDomains": ["auth.onepieceminecraft.fr", ".onepieceminecraft.fr"],
  "signaturePublickey": "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n"
}
```

### 2.2 Authserver — `/yggdrasil/authserver`

| Chemin | Corps | Réponse |
|---|---|---|
| `POST /authenticate` | `{username, password, clientToken?, requestUser?, agent}` | `{accessToken, clientToken, availableProfiles[], selectedProfile, user?}` |
| `POST /refresh` | `{accessToken, clientToken?, requestUser?}` | idem |
| `POST /validate` | `{accessToken, clientToken?}` | `204` |
| `POST /invalidate` | `{accessToken, clientToken?}` | `204` |
| `POST /signout` | `{username, password}` | `204` |

Erreurs au format Mojang, HTTP 403 :
`{"error":"ForbiddenOperationException","errorMessage":"Invalid credentials."}`

### 2.3 Sessionserver — `/yggdrasil/sessionserver`

| Chemin | Réponse |
|---|---|
| `POST /session/minecraft/join` `{accessToken, selectedProfile, serverId}` | `204` |
| `GET /session/minecraft/hasJoined?username=&serverId=&ip=` | `200 {profile}` ou `204` |
| `GET /session/minecraft/profile/{uuid}?unsigned=false` | `200 {profile}` |

`profile` :

```json
{ "id": "4f2a9c81b0e64d7e8b1c2d3e4f5a6b7c",
  "name": "Melodia",
  "properties": [
    { "name": "textures",
      "value": "<base64 du JSON de textures>",
      "signature": "<signature Ed25519/RSA base64, si unsigned=false>" }
  ] }
```

### 2.4 API — `/yggdrasil/api`

| Chemin | Réponse |
|---|---|
| `POST /profiles/minecraft` (corps `["Melodia","Senrys"]`) | `[{id,name}]` |
| `GET /user/profile/{uuid}/{textureType}` | téléversement/suppression de skin (authentifié) |

### 2.5 Textures — `/textures`

`GET /textures/{sha256}.png` → PNG du skin/cape, `Cache-Control: public, max-age=31536000, immutable`.

---

## 3. Codes d'erreur normalisés (API launcher)

```json
{ "error": "invalid_credentials",
  "message": "Adresse e-mail ou mot de passe incorrect.",
  "details": null }
```

| Code | HTTP | Sens |
|---|---|---|
| `invalid_credentials` | 401 | e-mail/mot de passe faux |
| `totp_required` | 401 | 2FA activée, code manquant |
| `totp_invalid` | 401 | code TOTP faux |
| `token_expired` | 401 | access token expiré → rafraîchir |
| `token_revoked` | 401 | refresh token révoqué → reconnexion |
| `microsoft_required` | 403 | rattachement obligatoire non fait |
| `microsoft_expired` | 403 | possession à re-vérifier |
| `ownership_missing` | 403 | le compte MS ne possède pas Minecraft |
| `already_linked` | 409 | ce compte MS est déjà rattaché ailleurs |
| `email_taken` / `username_taken` | 409 | — |
| `banned` | 403 | + `details.until` |
| `rate_limited` | 429 | + en-tête `Retry-After` |
| `maintenance` | 503 | + `details.message` |

---

## 4. Sécurité — règles non négociables

1. Mots de passe : **format Werkzeug** `pbkdf2:sha256:600000$<sel>$<hex>`, celui du
   site Flask, renforcé au fil des connexions. Jamais de SHA/bcrypt nus, et **jamais
   d'Argon2id** : le site ne saurait plus vérifier les empreintes (`docs/DATA.md` §3).
2. `access_token` : JWT **EdDSA (Ed25519)**. Jamais `HS256`, jamais `alg:none`.
3. `refresh_token` : opaque, 64 octets aléatoires, **haché SHA-256 en base**, rotation
   à chaque usage, détection de rejeu → révocation de toute la famille.
4. Limitation de débit : `login` 5/min/IP + 10/h/compte, `register` 3/h/IP,
   `yggdrasil/authenticate` 10/min/IP.
5. Aucun secret dans le code : tout par variables d'environnement (voir `.env.example`).
6. Réponses anti-énumération sur `register` et `password/forgot`.
7. CORS fermé par défaut ; le launcher Electron n'en a pas besoin.
8. Journalisation : jamais de mot de passe, de jeton ni de `refresh_token` en clair.
9. `X-Forwarded-For` n'est lu que si `OPM_TRUST_PROXY_HEADERS` est vrai **et** que la
   connexion arrive d'une adresse de `OPM_TRUSTED_PROXY_IPS` ; la chaîne est alors
   parcourue **par la droite**, en sautant `OPM_TRUSTED_PROXIES` entrées, parce que
   nginx *ajoute* l'adresse réelle à la fin — les entrées de gauche sont exactement
   celles que le client a écrites lui-même. Une configuration fausse se paie des deux
   côtés : `OPM_TRUSTED_PROXIES` trop bas fait compter une adresse forgée, et
   l'attaquant qui change son en-tête à chaque requête obtient un compartiment neuf,
   donc plus aucune limite de débit (§4.4) ; trop haut — ou une chaîne plus courte que
   le nombre de sauts annoncé — fait retomber sur l'adresse de connexion directe,
   c'est-à-dire celle du proxy, et tout le trafic se retrouve compté dans un seul
   compartiment, ce qui bloque tous les joueurs à la fois.
