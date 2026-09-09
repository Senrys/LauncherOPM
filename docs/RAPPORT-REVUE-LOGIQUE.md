# Revue logique de bout en bout — launcher OPM

Lecture complète de `src/app.js`, `src/preload.js`, `src/main/**`, `src/windows/**`, `src/assets/js/**`, `src/launcher.html`, `src/panels/*.html`, croisée avec `docs/API.md`, `docs/DATA.md`, `docs/IPC.md`. Aucun fichier modifié. `node_modules/` n'est pas installé : les deux points marqués **(non vérifiable)** portent sur le contrat interne de `minecraft-java-core`.

---

## 1. Premier démarrage, aucun compte

**Le parcours nominal fonctionne.** `boot()` ?' `decideRoute(null)` ?' `{screen:'login', view:'login'}` ; `accounts.register()` enchaîne `api.register` puis `login()` et rend `{ok:true, account}` avec `can_play:false` / `blocked_reason:'microsoft_required'` ; `login.js:733 onAuthenticated()` bascule bien sur la vue `link`. Deux défauts sur la sortie de ce parcours.

### 1.1 — MAJEUR — La carte de confirmation du rattachement et le bouton EMBARQUER ne sont jamais vus
`src/assets/js/renderer.js:793-804` (`onAccountsChanged`) + `src/assets/js/panels/login.js:922-950` (`showLinkResult`)

Quand `absorb()` publie le compte rattaché, `emitChange()` ?' `auth:changed` ?' `onAccountsChanged` calcule `decideRoute(current)` = `{screen:'app'}`, compare à `state.screen` (`'login'`) et appelle `routeTo` ?' `setScreen('app')` ?' `ui.login.hidden = true`. Le renderer bascule donc sur l'application **dans la même micro-tâche** que l'affichage de la carte « Possession vérifiée · valable jusqu'au ? » par le souscripteur de `login.js`.

Symptôme : le joueur qui termine son rattachement Microsoft voit l'écran sauter directement sur l'accueil ; la confirmation (tête de skin + pseudo Minecraft) clignote au mieux une frame, et le bouton `data-el="link-continue"` (`launcher.html:603`) ainsi que `login.js:756 leave()` sont du code mort dans le parcours nominal.

Correction : dans `onAccountsChanged`, ne pas router automatiquement quand `state.loginView === 'link'` et que le compte vient de passer `can_play:true` — laisser `link-continue` déclencher `ctx.route()`. Ou, symétriquement, supprimer la carte de confirmation et le bouton EMBARQUER du balisage.

### 1.2 — MINEUR — `bootstrap.auth.registration_open` n'est jamais lu
Aucune occurrence dans `src/`. Le lien « Créer un compte » (`launcher.html:396`) reste offert même quand le serveur a fermé les inscriptions ; l'échec ne se manifeste qu'après saisie complète du formulaire. Correction : masquer `[data-action="view-register"]` quand `store.bootstrap.auth.registration_open === false`.

---

## 2. Démarrage avec un compte existant

Le refresh silencieux, la révocation et la panne serveur sont correctement câblés côté processus principal (`accounts.refreshAll` ?' `renew` ?' `translate` ?' `isRevoked` ?' `forget(id,{revoke:false})` pour un jeton mort ; compte conservé pour une erreur `network`/`timeout`). C'est le rendu côté interface qui casse.

### 2.1 — BLOQUANT — `online:false` n'est jamais remis à `true` : le launcher reste bloqué pour toute la session
`src/assets/js/renderer.js:518` (seule écriture `online:false`), `src/assets/js/renderer.js:514` (seule écriture `online:true`, dans `boot()`)

`online` n'est écrit qu'une fois, pendant le splash. `titlebar.loadLinks()` (`titlebar.js:335`) et `home.bootstrap()` (`home.js:342`) peuvent réussir plus tard : ils écrivent `bootstrap` et `maintenance` dans le magasin mais **jamais** `online: true`.

Symptôme : le joueur démarre pendant une coupure réseau de dix secondes ; la connexion revient ; `bottombar.phase()` (`bottombar.js:629`) renvoie `'blocked'` pour toujours, le bouton affiche INDISPONIBLE / « CONNEXION REQUISE », le sous-titre du compte reste « HORS LIGNE ». Seul un redémarrage du launcher débloque.

Correction : écrire `store.set({ online: true })` dans `titlebar.loadLinks()` et `home.bootstrap()` en cas de succès, et remettre `online:false` sur tout échec réseau ultérieur — ou dériver `online` d'un compteur d'échecs plutôt que d'un booléen posé une seule fois.

### 2.2 — MAJEUR — Le message de démarrage dégradé ment
`src/assets/js/renderer.js:520-524` vs `src/assets/js/panels/bottombar.js:629`

Le toast annonce : « Le launcher démarre en mode dégradé : le jeu reste lançable si votre session est encore valide. » Or `phase()` renvoie `'blocked'` **dès que `online === false`**, indépendamment de `can_play` et de la validité de la session. Le bouton JOUER est désactivé.

Symptôme : serveur d'auth injoignable, session locale valide ?' le joueur lit qu'il peut jouer et se trouve devant un bouton mort.

Correction : soit retirer `!this.online` de la condition de `phase()` et laisser `game.launch()` échouer proprement (il échouera de toute façon sur `POST /game/session`), soit corriger le texte du toast en « le jeu ne pourra pas être lancé tant que le serveur ne répond pas ».

### 2.3 — MAJEUR — Le cache « hors ligne » n'est jamais signalé au joueur
`src/main/services/content.js:196-202` (`decorate` pose `stale` et `fetched_at`) — **aucun consommateur**

`grep -rn "stale" src/assets` ne remonte que la méthode homonyme `home.stale(key, maxAge)`, sans rapport. `docs/DATA.md § 5` et l'en-tête de `content.js` promettent « un bandeau *données hors ligne* » : il n'existe nulle part dans `home.js`, `donation.js`, `launcher.html` ni les CSS.

Symptôme : serveur en panne, cache disque vieux de trois jours ?' l'accueil affiche « SERVEUR EN LIGNE · 42 joueurs » et un journal de bord périmé exactement comme s'ils étaient frais. C'est pire qu'un écran vide : c'est une fausse donnée présentée comme vraie, en contradiction avec la règle 1 du module.

Correction : dans `home.paintStatus/paintNews` et `donation.render`, lire `data.stale` et poser un bandeau (« Données hors ligne · relevées {relTime(fetched_at)} ») ; `nextEvent` renvoyant `null` n'est pas annotable, le prévoir.

### 2.4 — MINEUR — Course entre `accounts.init()` et les premiers appels IPC
`src/app.js:222-232`

`ipc.register()` puis `mainWindow.create()` sont exécutés **avant** `await accounts.init()`. Le renderer peut donc appeler `auth:current` pendant que `account_selected` pointe encore sur un compte disparu : `store.getAccount(id)` rend `null`, `current()` rend `null`, et `decideRoute` envoie sur l'écran de connexion alors qu'un compte existe. Fenêtre étroite mais réelle (le splash appelle `config:get` immédiatement). Correction : `await accounts.init()` avant `mainWindow.create()`, ou marquer les handlers `auth:*` en attente de l'initialisation.

### 2.5 — MINEUR — `syncCurrent()` renvoie un compte non décoré
`src/main/auth/accounts.js:932`

La branche d'échec renvoie `store.getAccount(id)` au lieu de `decorate(store.getAccount(id))` : le `profile` RP et `link_device` disparaissent silencieusement du retour. Sans conséquence aujourd'hui (les appelants ignorent la valeur), mais c'est un contrat `Account` violé.

### 2.6 — MINEUR — `POST /auth/refresh` est rejoué automatiquement
`src/main/auth/api.js:169-174, 295-303`

`isRetryable` accepte `network`, `timeout` et 5xx, et `refresh()` utilise `MAX_ATTEMPTS = 2`. Le `refresh_token` étant **rotatif** (`docs/API.md § 1.2`), une réponse perdue après traitement serveur (connexion coupée au retour, 502 d'un reverse-proxy après le POST) fait rejouer un jeton déjà consommé : la deuxième tentative échoue en 401 et le compte est **effacé** par `refreshAll` ?' `forget()`. Correction : `attempts: 1` sur `refresh()` et `logout()`, comme cela est déjà fait pour `linkPoll`.

---

## 3. Lancement du jeu

### 3.1 — MAJEUR — Aucune interface n'expose l'annulation ni la vérification des fichiers
`src/main/services/game.js:915 cancel()`, `:945 verifyFiles()` — canaux `game:cancel` / `game:verify` enregistrés (`ipc.js:427-429`), exposés par le preload (`preload.js:459-461`), **jamais appelés**.

`grep` sur `src/assets` et `src/panels` : aucun `data-action` de type `cancel-launch` ou `verify-files`. Toute la mécanique de sentinelle `CANCELLED` / `VERIFY_ONLY` de `createLauncher()` (`game.js:811-834`), soit une centaine de lignes, est inatteignable.

Symptôme : le joueur qui lance par erreur un téléchargement de 4 Go n'a aucun moyen d'y renoncer autrement qu'en tuant le launcher (et `game.js` n'a alors plus la main pour clore la session Yggdrasil). Il n'a pas non plus de bouton « vérifier les fichiers » alors que le service existe.

Correction : ajouter un bouton d'annulation dans la barre du bas, visible quand `phase() === 'busy'`, câblé sur `opm.game.cancel()`, et une entrée « V?RIFIER LES FICHIERS » dans Paramètres ?' Launcher, câblée sur `opm.game.verifyFiles()`.

### 3.2 — MAJEUR — Une session Yggdrasil est ouverte et jamais close en cas d'annulation ou d'échec
`src/main/services/game.js:692-699` (`reportPlaytime`), appelé depuis `finish()` (`:729`)

`launch()` obtient la session (`game.js:877 gameSession()`) **avant** de créer le `run`. `reportPlaytime` sort immédiatement si `run.startedAt === 0`, c'est-à-dire tant qu'aucune ligne de sortie du jeu n'est arrivée. Donc `POST /game/session/close` n'est **jamais** appelé quand :
- la préparation est annulée (sentinelle `CANCELLED`) ;
- la préparation échoue (`onFatal`) ;
- la JVM meurt avant d'écrire une ligne sur stdout.

Symptôme : à chaque tentative avortée, un `yggdrasil.accessToken` valable 24 h reste actif côté serveur, et le `client_token` qui devait l'invalider n'est jamais transmis. Dix essais ratés = dix sessions de jeu vivantes.

Correction : découper `reportPlaytime` — appeler `closeGameSession({duration_s: 0, client_token, account_id})` dès que `run.clientToken` est renseigné, même quand `startedAt === 0`, et ne conditionner que la durée créditée à `startedAt`.

### 3.3 — MAJEUR — Le double lancement n'est empêché qu'accidentellement
`src/assets/js/panels/bottombar.js:596-616`

`play()` pose `this.launching = true` mais le remet à `false` dans le `finally`, or `game.launch()` rend la main dès que `launcher.Launch(options)` retourne — c'est-à-dire avant le téléchargement (commentaire assumé, `game.js:840-843`). Le verrou effectif est donc `this.phase() !== 'ready'`, qui dépend de `this.game.state`. ?a tient tant que `setGame({state:'launching'})` précède l'appel, mais il n'y a **aucune protection** contre l'entrelacement `play()` (auto-launch) + clic manuel dans la même frame : `maybeAutoLaunch()` (`:815`) est appelé depuis `render()`, lui-même appelé par `setGame()`.

Le vrai filet est côté processus principal (`game.js:849 if (busy) throw fail('already_running')`), qui remonte alors un toast d'erreur au lieu d'être un no-op silencieux.

Correction : garder `this.launching` vrai jusqu'à réception du premier `game:event` (ou d'un `closed`/`error`), et faire de `already_running` un cas silencieux dans `bottombar.play()`.

### 3.4 — MAJEUR — La progression de la barre des tâches est pilotée deux fois
`src/main/services/game.js:212 taskbar()` et `src/assets/js/renderer.js:884 updateTaskbarProgress()`

Chaque événement de progression déclenche `win.setProgressBar()` dans le main **et** un `window:progress` depuis le renderer, avec la même valeur. Doublement du trafic IPC sur un canal déjà limité à 120 ms (`PROGRESS_THROTTLE_MS`), et risque d'incohérence si l'un des deux évolue. Correction : supprimer `updateTaskbarProgress` (le main est déjà maître) ou retirer `taskbar()` de `game.js`.

### 3.5 — MINEUR — `close_on_launch` : comportement correct, mais reposant sur un signal fragile
`src/main/services/game.js:570-601` (`onData`), `:761 hideForGame`, `:771 restoreWindow`, `:732`

Le masquage n'intervient qu'au passage à `run.running`, c'est-à-dire à la **première ligne de sortie du jeu qui n'est pas la bannière** `Launching with arguments`. La restauration est bien faite dans `finish()` pour toutes les issues (`closed`, `error`, sentinelles), et `app.on('second-instance')` ?' `focusWindow()` sert de secours si la fenêtre reste cachée. Correct.

Le point fragile : si Minecraft n'écrit rien sur stdout avant de planter, la fenêtre n'est jamais masquée (sans dommage) mais `startedAt` reste 0 ?' temps de jeu non crédité **et** session non close (cf. 3.2), tandis que le bouton reste sur « LANCEMENT? » jusqu'à l'événement `close`.

### 3.6 — (non vérifiable) — Le couplage à `minecraft-java-core` repose sur deux monkey-patches
`src/main/services/game.js:817-831`

`launcher.DownloadGame` et `launcher.start` sont remplacés après construction. Cela ne fonctionne que si la bibliothèque appelle bien `this.DownloadGame()` et `this.start()` sur l'instance (et non des références capturées). `node_modules/` n'étant pas installé, je ne peux pas le confirmer. Si la v4.2.3 change ce détail, l'annulation et le mode « vérification seule » deviennent silencieusement inopérants — le jeu démarrerait à la place. ? sécuriser par un test de fumée qui vérifie que `verifyFiles()` émet bien `{type:'closed', code:0}` sans lancer de JVM.

---

## 4. Paramètres

### 4.1 — Interrupteurs et clés : **correct**
Les huit `data-key` de `settings.html` (`game.fullscreen`, `game.remember_size`, `launcher.close_on_launch`, `keep_console`, `auto_update`, `rp_notifications`, `volume`, `music`) correspondent exactement aux chemins de `DEFAULT_CONFIG` (`store.js:55-79`). `readPath`/`patchPath`/`deepMerge` sont cohérents, `deepMerge` refuse `__proto__`/`constructor`/`prototype`.

### 4.2 — MAJEUR — Quatre réglages sont purement décoratifs
Aucun consommateur dans tout le projet (`grep -rn` sur `src/`) :

| Réglage | Balisage | Lu par |
|---|---|---|
| `game.remember_size` | `settings.html:322` | personne — `mainWindow.js:628` ouvre toujours en 1280-764, aucune sauvegarde de géométrie |
| `launcher.rp_notifications` | `settings.html:370` | personne — aucun `new Notification()` dans le projet |
| `launcher.music` | `settings.html:382` | personne — aucun `<audio>` ni `new Audio` |
| `launcher.volume` | `settings.html:377` | personne (affiché uniquement) |

Symptôme : le joueur active « Notifications d'événements RP » ou « Ambiance sonore », la valeur est bien écrite dans `config.json`, et rien ne se produit — jamais. Correction : implémenter, ou retirer les rangées du panneau.

### 4.3 — MAJEUR — La configuration normalisée par le main n'est jamais réaffichée
`src/assets/js/panels/settings.js:405-417` (`flushSave`)

`this.config = await config.set(patch)` remplace l'objet de travail par la version normalisée, puis `store.set({config})` — mais `applyConfig()` n'est appelé **que dans la branche d'erreur** (`:415`). Et le souscripteur du magasin (`:226`) sort explicitement quand `state.config === this.config`, ce qui est précisément le cas ici.

Symptôme concret : le champ Hauteur accepte `480` (attribut `min="480"`, `settings.html:293`) alors que `store.js:36 RESOLUTION_MIN = 640` s'applique aux deux dimensions. Le joueur saisit 500, le champ affiche 500, l'aperçu de ratio affiche 500, `config.json` contient 640, et le jeu se lance en 640. Divergence permanente et silencieuse entre écran et disque.

Correction : appeler `this.applyConfig()` après le succès de `flushSave()` (et aligner `min="640"` sur la hauteur dans `settings.html`).

### 4.4 — MAJEUR — Les curseurs de RAM n'ont pas de borne haute de repli
`src/panels/settings.html:231-238` — `<input type="range" min="1" step="1">` sans attribut `max`

L'attribut `max` n'est posé qu'au runtime par `loadMemory()` (`settings.js:840-842`). Si `app:memory` échoue (`settings.js:833` : `return` immédiat), le HTML retombe sur le `max` implicite de HTML5, **100**. `onRamInput` (`:883`) calcule alors `total = this.memory.total || Number(this.el.ramMax?.max)` = 100 et laisse écrire 100 Go, que `store.normalizeConfig` ramène à la RAM réelle — sans que l'affichage ne le reflète (cf. 4.3).

Correction : poser `max="1"` dans le balisage (repli minimal honnête) ou refuser toute interaction sur les curseurs tant que `this.memory.total === 0`.

### 4.5 — Invariant min ? max : **tenu, mais par un seul des deux mécanismes**
`onRamInput` (`settings.js:882-899`) tient bien l'invariant côté renderer et écrit **les deux** valeurs. Conséquence : `store.pinnedMemoryOf()` (`store.js:259-265`) renvoie toujours `null` puisqu'il exige que `min` **ou** `max` soit défini seul. Toute la logique de « curseur épinglé » (`store.js:216-220`) est donc du code mort, et si le renderer venait à envoyer un couple incohérent, c'est toujours `min` qui serait rabaissé. Mineur, mais à savoir avant de toucher à `onRamInput`.

### 4.6 — Bornes issues de la mémoire réelle : **correct**
`ipc.js:301-304` (`os.totalmem()/2^30`) ?' `settings.loadMemory` (`Math.floor`) ?' `slider.max` ; `store.totalMemoryGb()` (`store.js:119-121`) applique exactement le même calcul côté persistance. Cohérent.

### 4.7 — MAJEUR — L'échéance de vérification de possession ne s'affiche jamais
`src/assets/js/panels/settings.js:606` et `src/assets/js/panels/login.js:937`

```js
const expires = account.minecraft.expires_at ?? account.microsoft?.expires_at ?? null;
```

Aucun de ces deux chemins n'existe dans le type `Account` produit par `toAccount()` (`accounts.js:262-285`) : `minecraft` ne porte que `{uuid, name}`, et `microsoft` n'est pas projeté du tout. Le champ réel est **`account.session_expires_at`**.

Symptôme : la phrase « Possession vérifiée · valable jusqu'au ? » est systématiquement remplacée par « Possession vérifiée », et le bloc d'échéance des paramètres est toujours masqué (`hide(sentence)`), alors que la donnée est disponible. Correction : lire `account.session_expires_at` aux deux endroits.

### 4.8 — MAJEUR — La double authentification n'est administrable nulle part
`accounts.totpSetup/totpEnable/totpDisable`, canaux `auth:totp-*`, méthodes preload : tous présents et testés. Aucun balisage, aucun `data-action`, aucune vue ne les appelle (`grep -rn "totp" src/panels src/assets/js/panels/settings.js` ?' vide).

Symptôme : un joueur ne peut ni activer ni désactiver la 2FA depuis le launcher ; l'écran de connexion sait en revanche la réclamer. Correction : ajouter la section 2FA dans Paramètres ?' Comptes, ou documenter explicitement que c'est le site qui la gère et retirer les trois canaux.

---

## 5. Flux Microsoft

### 5.1 — BLOQUANT — En mode `device`, le rattachement lancé depuis les Paramètres n'affiche aucun code
`src/assets/js/panels/settings.js:621-636 linkMicrosoft()` ; le code n'est rendu que par `src/assets/js/panels/login.js:241-259` + `:867 showDevice`

Le souscripteur qui affiche `link_device` est doublement conditionné : `this.view !== 'link'` ?' `return` (`login.js:245`), et l'écran de connexion est de toute façon `hidden` tant que `store.screen === 'app'`. Les Paramètres, eux, ne possèdent aucun ancrage `ms-user-code`.

Symptôme : `bootstrap.auth.flow === 'device'`, le joueur clique RATTACHER dans Paramètres ?' Comptes ?' le navigateur s'ouvre sur `microsoft.com/link` et réclame un code affiché **nulle part**. `linkDevice` scrute pendant 15 minutes puis rend `link_timeout`. Le bouton est simplement `disabled` pendant tout ce temps.

Correction : soit faire déclencher par `settings.linkMicrosoft()` l'ouverture de l'écran de connexion en surimpression sur la vue `link` (`opm:request-login` avec `{view:'link'}`), soit dupliquer le bloc `link-device` dans `settings.html` et l'alimenter depuis le même `link_device`.

### 5.2 — MAJEUR — Aucune annulation possible du flux `device`
`src/main/auth/accounts.js:1022-1083` (`linkDevice`), `:1094-1119` (`linkMicrosoft`, verrou `linking`)

La boucle tourne jusqu'à `deadline` (jusqu'à 15 min, `DEVICE_EXPIRES_DEFAULT_S` borné à 3600 s). Il n'existe aucun `AbortSignal`, aucun canal `auth:cancel-link`. Le verrou `linking` (`:1097`) rejette toute nouvelle tentative avec `link_busy` tant que la boucle tourne.

Symptôme : le joueur renonce (mauvais compte Microsoft, code expiré côté Microsoft) ; il ne peut pas relancer un rattachement — « Un rattachement Microsoft est déjà en cours. » — pendant un quart d'heure, sans indication de la durée restante. La seule issue est de tuer le launcher.

Correction : exposer un canal `auth:cancel-link` qui pose un drapeau lu par la boucle de `linkDevice` (et abort l'appel `linkPoll` en vol), et ajouter un bouton ANNULER dans le bloc `link-device`.

### 5.3 — MINEUR — Changer de vue pendant la scrutation `device` efface le code
`src/assets/js/panels/login.js:359` — `if (name === 'link' && previous !== 'link') this.resetLinkView();`

`resetLinkView()` remet `this.device = null` et masque `link-device`. Comme aucun `auth:changed` n'est émis pendant la scrutation (le code n'est publié qu'une fois, avant la boucle), le code n'est **pas** réaffiché au retour sur la vue. Correction : ne pas réinitialiser tant que `store.account.link_device` est renseigné.

### 5.4 — Flux `embedded` et annulation par l'utilisateur : **correct**
`microsoft.js:219-345`. `finish()` est idempotent (`settled`), `win.destroy()` re-déclenche `closed` sans double résolution, `did-fail-load` ignore `ERR_ABORTED` et les états déjà réglés, la partition `persist:msa` est vidée avant **et** après. Les résultats sont bien traduits en codes stables par `embeddedFailure` (`accounts.js:943-950`) et les messages français viennent de `CLIENT_MESSAGES` (`link_cancelled`, `link_denied`, `link_timeout`, `link_failed`, `link_busy`). `login.messageFor` retombe sur `result.message`, donc le joueur lit bien « Rattachement Microsoft annulé. » et non un code.

### 5.5 — MAJEUR — Les skins ne s'afficheront jamais en pratique
`src/assets/js/utils/skin.js:86-105` (`viaBridge`) — `window.opm.textures.get` **n'existe pas** dans `preload.js`

Le module documente lui-même trois voies d'accès. La voie 1 (pont main) n'est pas implémentée ; la voie 2 (`crossOrigin="anonymous"`) exige `Access-Control-Allow-Origin` sur `/textures/`, que `docs/DATA.md` décrit comme désactivé par défaut ; la voie 3 produit un canevas teinté, détecté et rejeté. Le document étant chargé en `file://`, le résultat est le repli `steve.png` / `silhouette.png` **dans tous les cas**.

Symptôme : avatar de la barre du bas, popover des comptes, cartes de comptes, confirmation de rattachement et personnage en pied de l'accueil montrent tous la silhouette par défaut, quel que soit le skin réel du joueur. Correction : ajouter le canal `textures:get` au preload/IPC (téléchargement dans le main, retour en `data:` URL), ou ouvrir CORS sur `/textures/`.

---

## 6. Fuites et cycles de vie

### 6.1 — Ce qui marche
`home.startTimers/stopTimers` (`home.js:300-314`) coupe bien les trois `setInterval` (statut 30 s, tuiles 60 s, compte à rebours 1 s) dans `hide()`, et les réarme dans `show()` — c'est-à-dire à chaque bascule d'onglet via `renderer.setTab` (`renderer.js:316-352`), qui appelle bien `previous.instance.hide()` puis `next.instance.show()`. **La question posée est donc satisfaite pour le changement d'onglet.** Les minuteries du main (`renewTimer`, `scheduleUpdateCheck`) sont `unref()`. Les toasts nettoient leurs quatre écouteurs et leur timer dans `dismiss()`. `Popover` retire ses deux écouteurs document dans `close()`. `focusTrap` rend une fonction de libération que `modal.js` et `settings.askPassword` appellent systématiquement.

### 6.2 — MAJEUR — Les minuteries de l'accueil survivent au changement d'**écran**
`src/assets/js/renderer.js:366-392` (`setScreen`)

`setScreen` ne fait que basculer `hidden`/`inert`/classes. Il n'appelle jamais `panels.get(activeTab).hide()`. Donc au passage `app ?' login` (déconnexion, `microsoft_expired`, surimpression « + AJOUTER UN COMPTE »), l'accueil reste `activeTab` et ses trois `setInterval` continuent : `content.status()` est interrogé toutes les 30 s et le compte à rebours tourne à 1 Hz **derrière l'écran de connexion**. Cela contredit le commentaire `home.js:310` (« rien ne tourne derrière un panneau masqué »).

Effet miroir : au retour `login ?' app`, `show()` n'est pas rappelé non plus, donc aucun rafraîchissement à la réapparition.

Correction : dans `setScreen`, appeler `panels.get(activeTab)?.instance?.hide()` quand on quitte `'app'` et `.show()` quand on y entre.

### 6.3 — MAJEUR — `readStore` ne sait pas effacer
`src/assets/js/panels/bottombar.js:363-369`

```js
if (Array.isArray(state.accounts) && state.accounts.length > 0) this.accounts = state.accounts;
if (state.account) this.account = state.account;
```

Ni la liste vide ni `account === null` ne sont propagés. Aujourd'hui la barre s'en sort parce que son propre `opm.auth.onChange` (`:174-178`) écrit `current ?? null` de façon synchrone avant le flush micro-tâche du magasin — un ordre d'exécution non garanti par contrat.

Symptôme si l'ordre change (ou si `wireMainProcessEvents` est déplacé) : après la déconnexion du dernier compte, la barre du bas conserve le pseudo, l'avatar et un `can_play` périmé, et `phase()` peut renvoyer `'ready'` — bouton JOUER actif sans compte. Correction : `this.accounts = Array.isArray(state.accounts) ? state.accounts : []` et `this.account = state.account ?? null`.

### 6.4 — MAJEUR — ?criture synchrone du journal sur le processus principal, une par ligne
`src/main/services/logger.js:155` (`fs.appendFileSync`) + `:88 mask()` (7 expressions régulières, dont un scan global `\b[A-Za-z0-9_-]{48,}\b`)

Chaque ligne de sortie du jeu traverse `mask()` puis un `appendFileSync` bloquant, puis un `wc.send` IPC, puis — côté renderer — `pushLog` qui **recopie un tableau de 300 éléments** (`renderer.js:123-131`) et notifie tous les souscripteurs du magasin.

Symptôme : avec `launcher.keep_console` activé, le démarrage d'une instance moddée (plusieurs milliers de lignes en quelques secondes) fige visiblement l'interface et la barre de progression. Correction : bufferiser les écritures disque (`fs.createWriteStream` + flush périodique), regrouper les envois `log:line` par lot, et cesser de reconstruire le tableau `logs` du magasin à chaque ligne.

### 6.5 — MINEUR — L'accueil est abonné deux fois au même changement
`src/assets/js/panels/home.js:177-186` : un `store.subscribe` sur `account` **et** un `opm.auth.onChange`. Les deux appellent `paintPlayer()`, qui relance à chaque fois un rendu de skin (annulé par `skinSeq`, donc sans dégât visuel, mais deux compositions de canevas par changement de compte). Le doublon existe aussi dans `bottombar` (`:167` + `:174`) et `settings` (`:225` + `loadAccounts`). Choisir une seule source.

### 6.6 — MINEUR — Course entre `ready:true` et la fin du splash
`src/assets/js/renderer.js:608-611`

`store.set({ready:true})` précède `await waitSplashDwell(...)`. Pendant ces ? 900 ms, tout `auth:changed` (renouvellement anticipé, `emitChange` d'un `forget` tardif) passe le garde `if (!state.ready) return` et appelle `routeTo`, coupant le splash. Correction : poser `ready` après `enterRoute`.

---

## 7. Gestion d'erreur

### 7.1 — Ce qui est correct
Les **14 codes de `docs/API.md § 3`** sont couverts : `ERROR_MESSAGES` (`login.js:54-68`) en traduit 12, et les deux restants — `totp_required`, `microsoft_required` — sont traités comme des étapes de parcours dans `attempt()` (`login.js:715-723`), ce qui est le bon choix. `banned` compose `details.until` en date française, `maintenance` privilégie `details.message`. Les codes propres au client (`network`, `timeout`, `aborted`, `invalid_response`, `no_account`, `session_expired`, `link_*`) ont leurs messages français dans `accounts.CLIENT_MESSAGES` (`accounts.js:68-81`), et tous les codes fabriqués par `ipc.js` (`invalid_url`, `forbidden_path`, `invalid_java`, `unknown_panel`, `already_running`, `no_instance`, `checkout_unavailable`?) portent un message français. Aucune trace de pile ne remonte : `preload.call` reconstruit une `Error` à partir de `{error, message}` et `reportError` n'affiche que `error.message`.

### 7.2 — MAJEUR — Un code d'erreur brut est affiché tel quel dans un toast
`src/assets/js/renderer.js:402-411` (`decideRoute`) + `:435-441` (`enterRoute`)

```js
return { screen: 'login', view: 'login', message: account.blocked_reason ?? '' };
...
toast({ kind:'error', title:'Compte indisponible', message: decision.message });
```

Symptôme : un compte connecté dont la vérification de possession a expiré déclenche un toast « Compte indisponible — microsoft_expired ». Identique pour `ownership_missing`, `banned`, `email_unverified`. C'est le seul endroit du launcher où un identifiant technique atteint le joueur, alors que trois tables de traduction existent déjà (`login.js:54`, `bottombar.js:60`, `settings.js:60`, `home.js:58` — quatre tables redondantes, d'ailleurs).

Correction : centraliser les libellés de `blocked_reason` dans un module partagé et l'utiliser ici. Accessoirement, `view: 'login'` est le mauvais aiguillage pour `microsoft_expired` : le joueur est déjà connecté, c'est la vue `link` (re-vérification) qu'il faut ouvrir.

### 7.3 — MAJEUR — Le message technique de `fetch` remonte jusqu'au joueur
`src/main/auth/api.js:250` — `new ApiError('network', 0, \`Serveur injoignable (${err.message}).\`)`

`accounts.translate()` réécrit ce message via `CLIENT_MESSAGES.network`, mais **ni `game.js` ni `content.js` ne passent par `translate`** : ils laissent l'`ApiError` remonter telle quelle à `ipc.toError`, qui la sérialise avec son message d'origine.

Symptôme : réseau coupé, clic sur JOUER ?' toast « Lancement impossible — Serveur injoignable (fetch failed). » ; clic sur un montant de don ?' « Paiement indisponible — Serveur injoignable (getaddrinfo ENOTFOUND ?). » Fragment technique anglais dans une interface française.

Correction : construire le message d'`ApiError` sans interpoler `err.message` (le conserver dans `details` pour le journal), ou faire passer `game.js` et `content.js` par un traducteur équivalent à `accounts.translate`.

### 7.4 — MINEUR — `bootstrap.launcher.version_min` n'est jamais vérifié
`version_min`, `version_latest` et `download_url` sont récupérés par `api.bootstrap()` et rangés dans `store.bootstrap` — aucune lecture ailleurs. Le blocage documenté d'un launcher trop ancien n'existe pas : le client continue et n'échouera que sur des réponses serveur qu'il ne saura pas expliquer. Correction : comparer `store.version` à `version_min` en fin de `boot()` et présenter un écran bloquant avec `download_url`.

### 7.5 — MINEUR — La règle de masquage attrape trop large
`src/main/services/logger.js:63` — `/\b[A-Za-z0-9_-]{48,}\b/g`

Tout identifiant de 48 caractères devient `[masqué]` : chemins de classpath, empreintes SHA-256 de fichiers en erreur, noms de mods longs. La console « D?TAILS » perdra régulièrement l'information même utile au diagnostic. Compromis assumé côté sécurité, mais à noter.

---

## Récapitulatif par gravité

**Bloquant (2)**
- 2.1 `online:false` définitif ?' JOUER mort pour toute la session après la moindre coupure au démarrage.
- 5.1 Rattachement `device` depuis les Paramètres : aucun code affiché.

**Majeur (17)**
1.1 confirmation de rattachement inatteignable · 2.2 message de mode dégradé faux · 2.3 marqueur `stale` jamais consommé · 3.1 `cancel()`/`verifyFiles()` sans interface · 3.2 session Yggdrasil non close en cas d'échec · 3.3 verrou de double lancement fragile · 3.4 barre des tâches pilotée deux fois · 4.2 quatre réglages décoratifs · 4.3 config normalisée jamais réaffichée · 4.4 curseurs RAM sans `max` de repli · 4.7 `expires_at` lu sur un champ inexistant · 4.8 2FA non administrable · 5.2 flux `device` non annulable · 5.5 skins jamais affichés (CORS/pont absent) · 6.2 minuteries de l'accueil derrière l'écran de connexion · 6.3 `readStore` incapable d'effacer · 6.4 journal synchrone ligne à ligne · 7.2 `blocked_reason` brut dans un toast · 7.3 message `fetch` en anglais dans un toast.

**Mineur (9)**
1.2 · 2.4 · 2.5 · 2.6 · 4.5 · 5.3 · 6.5 · 6.6 · 7.4 · 7.5.

Les trois défauts que je corrigerais en premier, parce qu'ils cassent un parcours entier et non un détail : **2.1** (blocage permanent), **3.2** (fuite de sessions de jeu côté serveur) et **5.1** (rattachement impossible en mode `device` depuis les Paramètres).
