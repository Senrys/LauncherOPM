# Contrat IPC — Electron (main ↔ renderer)

> **Source de vérité.** Le renderer n'a **ni** `nodeIntegration` **ni** accès à `require`.
> Tout passe par `window.opm`, exposé par `src/preload.js` via `contextBridge`.
> Aucun secret (mot de passe, jeton, `refresh_token`) ne doit être stocké côté renderer.

`webPreferences` obligatoire : `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: false` (nécessaire au preload qui charge `electron`), `webSecurity: true`.

---

## Surface exposée : `window.opm`

```ts
window.opm = {
  /* -------------------------------------------------- FENÊTRE (invoke/send) */
  window: {
    minimize(): void
    maximize(): void            // bascule maximiser/restaurer
    close(): void
    hide(): void
    show(): void
    isMaximized(): Promise<boolean>
    onMaximizeChange(cb: (max: boolean) => void): () => void
    setProgress(ratio: number): void   // -1 = off, 2 = indéterminé
  },
  // `setProgress` a **un seul pilote à la fois**. Pendant une préparation, une vérification
  // ou une partie, la barre des tâches appartient au processus principal
  // (`services/game.js`, qui l'écrit à chaque progression) : les valeurs envoyées par le
  // renderer sont alors ignorées. Le renderer ne doit donc pas recopier la progression du
  // jeu ; ce canal lui reste ouvert hors exécution.

  /* ------------------------------------------------------------ APPLICATION */
  app: {
    version(): Promise<string>
    platform(): Promise<'win32' | 'darwin' | 'linux'>
    openExternal(url: string): Promise<void>   // https/http uniquement, validé côté main
    openPath(path: string): Promise<void>
    gameDir(): Promise<string>
    totalMemoryGb(): Promise<number>
    freeMemoryGb(): Promise<number>
    pickJava(): Promise<string | null>         // dialogue natif, filtre java/javaw
    panel(name: 'home'|'settings'|'donation'|'login'): Promise<string>  // HTML d'un panneau
    fetchImage(url: string): Promise<string | null>   // image → « data:image/…;base64,… »
    devtools(): void
  },
  // `fetchImage` existe parce que le document est chargé en `file://` — il n'a donc pas
  // d'origine — et que `/textures/` n'ouvre CORS pour personne : une texture chargée
  // directement teinte le canevas, dont les pixels deviennent illisibles. Le processus
  // principal télécharge à la place (https uniquement, 2 Mo au plus, 8 s au plus, type MIME
  // d'image exigé) et rend une `data:` URL, que le renderer peut lire au canevas sans
  // restriction. Un échec vaut `null` — jamais d'exception : l'appelant retombe sur son
  // image de repli (`steve.png` / `silhouette.png`).

  /* ------------------------------------------------- CONFIGURATION LOCALE */
  config: {
    get(): Promise<LauncherConfig>
    set(patch: DeepPartial<LauncherConfig>): Promise<LauncherConfig>
    reset(): Promise<LauncherConfig>
  },

  /* ------------------------------------------------------------- COMPTES */
  auth: {
    bootstrap(): Promise<Bootstrap>                     // GET /api/v1/bootstrap
    list(): Promise<Account[]>                          // comptes locaux connus
    current(): Promise<Account | null>
    select(id: string): Promise<Account>
    remove(id: string): Promise<void>
    login(p: {email, password, totp?}): Promise<LoginResult>
    register(p: {email, password, username}): Promise<LoginResult>
    logout(id?: string): Promise<void>
    refresh(id?: string): Promise<Account>              // silencieux au démarrage
    forgotPassword(email: string): Promise<void>
    totpSetup(): Promise<{secret, otpauth_uri, recovery_codes}>
    totpEnable(code: string): Promise<void>
    totpDisable(p: {password, code}): Promise<void>
    linkMicrosoft(): Promise<Account>                   // ouvre la fenêtre MS, boucle complète
    cancelLink(): Promise<void>                         // renonce au rattachement en cours
    unlinkMicrosoft(password: string): Promise<void>
    verifyOwnership(): Promise<Account>                 // re-vérification de possession
    onChange(cb: (accounts: Account[], current: Account|null) => void): () => void
  },
  // Flux Microsoft « device » : `linkMicrosoft()` ne rend la main qu'à la fin de la
  // scrutation (jusqu'à 15 min). Le code à saisir arrive donc AVANT, par `onChange` :
  // le compte concerné porte alors `link_device`, remis à `null` dès que le flux se
  // termine, quelle qu'en soit l'issue. C'est cette valeur — et non le résultat de
  // `linkMicrosoft()` — que l'écran de connexion doit afficher.
  //
  // `cancelLink()` est la sortie de secours de ce flux : elle libère le verrou sur-le-champ
  // (un nouveau rattachement est possible immédiatement, sans attendre le quart d'heure),
  // interrompt la scrutation et la requête en vol, remet `link_device` à `null` et publie
  // `auth:changed`. L'appel `linkMicrosoft()` en cours se solde alors par `link_cancelled`.
  // Sans rattachement en cours : sans effet, sans exception. Toute vue qui affiche le code
  // doit offrir ce renoncement.

  /* --------------------------------------------------------------- JEU */
  game: {
    instances(): Promise<Instance[]>
    launch(instanceName?: string): Promise<void>
    cancel(): Promise<void>
    isRunning(): Promise<boolean>
    verifyFiles(): Promise<void>
    clearCache(): Promise<{ freed_bytes: number }>
    filesStat(): Promise<{ files: number, bytes: number, checked_at: string }>
    on(cb: (e: GameEvent) => void): () => void
  },

  /* ----------------------------------------------------------- CONTENU */
  content: {
    news(): Promise<News>
    status(): Promise<ServerStatus>
    nextEvent(): Promise<NextEvent | null>
    votes(): Promise<Votes>
    donations(): Promise<Donations>
    donate(amountCents: number): Promise<void>          // ouvre l'URL de paiement
  },

  /* --------------------------------------------------------- MISE À JOUR */
  updater: {
    check(): Promise<void>
    on(cb: (e: UpdaterEvent) => void): () => void
  },

  /* ------------------------------------------------------------ JOURNAL */
  log: {
    on(cb: (line: LogLine) => void): () => void
    history(): Promise<LogLine[]>
  }
}
```

---

## Types

```ts
type LauncherConfig = {
  account_selected: string | null
  instance_selected: string | null
  java: { path: string | null, memory: { min: number, max: number }, args: string }
  game: { width: number, height: number, fullscreen: boolean, remember_size: boolean }
  launcher: {
    close_on_launch: boolean      // « Fermer le launcher au lancement du jeu »
    keep_console: boolean         // « Garder la console de jeu ouverte »
    auto_update: boolean          // « Mises à jour automatiques »
    rp_notifications: boolean     // « Notifications d'événements RP »
    music: boolean                // « Ambiance sonore du launcher »
    volume: number                // 0–100, pas de 5
    auto_launch: boolean          // case « LANCEMENT AUTO » de la barre du bas
    download_multi: number        // téléchargements simultanés (défaut 5)
  }
}

type Account = {
  id: string                       // = user.id du serveur
  email: string
  username: string                 // pseudo OPM
  minecraft: { uuid: string, name: string } | null
  skin_url: string | null          // la tête 8×8 est rendue côté renderer (utils/skin.js)
  primary: boolean
  can_play: boolean
  blocked_reason: string | null
  session_expires_at: string | null
  totp_enabled: boolean
  profile: RpProfile | null        // fiche RP, source du sous-titre de l'accueil
  link_device: LinkDevice | null   // rattachement Microsoft « device » en cours
}

// `user.profile` du serveur (API.md § 1.2), recopié tel quel jusqu'au renderer.
// Champ absent côté serveur → `null` ; jamais 0 par défaut, l'absence de donnée doit se voir.
type RpProfile = {
  faction: string | null           // « Pirate », « Marine »…  (users.faction)
  metier: string | null
  equipage: string | null          // nom de l'équipage (equipages.nom)
  iles_tenues: number | null       // îles tenues par l'équipage (iles)
  prime: number | null
  berry: number | null
  niveau: number | null
  temps_de_jeu_s: number | null
}

type LinkDevice = {
  user_code: string                // code à saisir sur la page Microsoft
  verification_uri: string         // http(s) uniquement, validé côté main
  expires_at: string               // ISO 8601 : au-delà, le code ne vaut plus rien
}

type LoginResult =
  | { ok: true, account: Account }
  | { ok: false, error: 'totp_required' | 'microsoft_required' | string, message: string }

type GameEvent =
  | { type: 'check',    progress: number, size: number }
  | { type: 'progress', progress: number, size: number, speed_bps?: number, eta_s?: number }
  | { type: 'extract',  file: string }
  | { type: 'patch',    message: string }
  | { type: 'launching' }
  | { type: 'running' }
  | { type: 'closed',   code: number }
  | { type: 'error',    message: string }

type UpdaterEvent =
  | { type: 'checking' }
  | { type: 'available',  version: string }
  | { type: 'none' }
  | { type: 'progress',   transferred: number, total: number, percent: number }
  | { type: 'downloaded' }
  | { type: 'error',      message: string }

type LogLine = { ts: string, level: 'info'|'warn'|'error'|'game', text: string }
```

---

## Canaux IPC réels (`ipcMain`)

Nommage : `domaine:action`. Tout ce qui renvoie une valeur utilise `invoke/handle`.

```
window:minimize      window:maximize        window:close        window:hide
window:show          window:is-maximized    window:progress     window:maximized (→ renderer)

app:version          app:platform           app:open-external   app:open-path
app:game-dir         app:memory             app:pick-java       app:panel
app:fetch-image      app:devtools

config:get           config:set             config:reset

auth:bootstrap       auth:list              auth:current        auth:select
auth:remove          auth:login             auth:register       auth:logout
auth:refresh         auth:forgot-password   auth:totp-setup     auth:totp-enable
auth:totp-disable    auth:link-microsoft    auth:cancel-link    auth:unlink-microsoft
auth:verify-ownership                       auth:changed (→ renderer)

game:instances       game:launch            game:cancel         game:is-running
game:verify          game:clear-cache       game:files-stat     game:event (→ renderer)

content:news         content:status         content:next-event  content:votes
content:donations    content:donate

updater:check        updater:event (→ renderer)

log:history          log:line (→ renderer)
```

---

## Amorçage : verdict de version

`auth.bootstrap()` rend la réponse de `GET /api/v1/bootstrap` (docs/API.md § 1.1) **enrichie
de deux champs calculés par le processus principal**, seul à connaître la version installée :

```ts
bootstrap.launcher = {
  version_min: string          // du serveur
  version_latest: string       // du serveur
  download_url: string         // du serveur
  version_current: string      // calculé : la version qui tourne (app.getVersion())
  update_required: boolean     // calculé : version_current < version_min
}
```

`update_required` vaut `false` quand l'un des deux numéros est illisible : on ne bloque pas un
joueur sur un doute. Quand il vaut `true`, le launcher est trop ancien pour que le serveur lui
réponde correctement : l'interface doit présenter un écran bloquant et renvoyer vers
`download_url`, plutôt que de laisser le joueur buter sur des erreurs inexplicables.

---

## Stockage local (main uniquement)

`app.getPath('userData')/opm-launcher/` :

| Fichier | Contenu | Protection |
|---|---|---|
| `config.json` | `LauncherConfig` | aucune (non sensible) |
| `accounts.json` | comptes **sans** jeton | aucune |
| `vault.bin` | `refresh_token` OPM par compte | `safeStorage` d'Electron (DPAPI/Keychain/libsecret) **uniquement**. Sans trousseau système, aucun fichier n'est écrit : les jetons restent en mémoire vive pour la durée de l'exécution et une reconnexion est demandée au démarrage suivant. |
| `cache/` | news, statut, têtes de skin | TTL |
| `logs/launcher.log` | journal tournant, 5 × 2 Mo | jetons masqués |

Le `refresh_token` **ne transite jamais** vers le renderer : les appels réseau
authentifiés se font exclusivement dans le processus main.
