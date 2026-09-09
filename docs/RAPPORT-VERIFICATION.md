# Rapport de vérification — passe 2

Produit par 5 agents de revue adversariale. **8 bloquants, 26 majeurs, 25 mineurs.**

---

## BLOQUANTS

### B1 — `auth-server/opm_auth/services/audit.py` : 44  _[import inexistant]_

**Constat.** `from opm_auth.models import AuditAction, AuditLog` â€” le symbole `AuditLog` n'existe pas dans models.py : la classe s'appelle `Audit`.

**Symptôme.** Le serveur ne dÃ©marre pas du tout. `main.py` importe `routers.auth`, qui importe `services.users` et `services.audit` : `ImportError: cannot import name 'AuditLog' from 'opm_auth.models'` remonte avant mÃªme la crÃ©ation de l'application. `uvicorn opm_auth.main:app` Ã©choue, `python -m opm_auth.cli` Ã©choue dÃ¨s la premiÃ¨re commande qui touche aux services, et la suite de tests entiÃ¨re Ã©choue Ã  la collecte (tests/conftest.py:122 importe `opm_auth.routers.auth`). C'est le seul import cassÃ© du paquet, mais il est sur le chemin de tout le monde.

**Correction.** Remplacer par `from opm_auth.models import Audit, AuditAction` et corriger les deux usages de `AuditLog` dans le corps de `record()` (ligne 201) et l'annotation de retour (ligne 189).

### B2 — `auth-server/opm_auth/services/audit.py` : 201  _[modÃ¨le / colonnes inventÃ©es]_

**Constat.** `AuditLog(user_id=â€¦, success=â€¦, ip=â€¦, detail=â€¦)` construit la ligne avec trois colonnes qui n'existent pas dans `auth_audit`.

**Symptôme.** MÃªme aprÃ¨s avoir corrigÃ© le nom de la classe, chaque appel Ã  `audit.record()` lÃ¨ve `TypeError: 'success' is an invalid keyword argument for Audit`. Autrement dit : inscription, connexion, Ã©chec de connexion, rotation de jeton, rattachement Microsoft, 2FA â€” tout ce qui journalise, c'est-Ã -dire toutes les routes d'Ã©criture â€” rÃ©pond 500. Le modÃ¨le `Audit` (models.py:827-850) est conforme au dump/DATA.md Â§2 : colonnes `user_id, action, ip_hash char(64), user_agent, meta jsonb, created_at`. Il n'y a NI colonne `success`, NI colonne `ip`, NI colonne `detail`. Pire pour le contrat de confidentialitÃ© : le champ passÃ© est `ip=ip`, l'adresse IP EN CLAIR, alors que la colonne rÃ©elle est `ip_hash` et exige une empreinte SHA-256 salÃ©e (DATA.md Â§2, API.md Â§4.8). La docstring de `services/microsoft.py:1223-1227` dÃ©crit d'ailleurs dÃ©jÃ  le comportement correct (Â« auth_audit n'a pas de colonne rÃ©ussi Â», Â« hache l'adresse IP Â») : ce fichier est celui de la passe prÃ©cÃ©dente, jamais rÃ©alignÃ©.

**Correction.** RÃ©Ã©crire `record()` : `Audit(user_id=user_id, action=str(action), ip_hash=_hash_ip(ip), user_agent=user_agent[:255] if user_agent else None, meta=sanitize(meta))`. Supprimer le paramÃ¨tre `success` de la signature (ou le replier dans `meta["success"]`, comme le fait dÃ©jÃ  `services/microsoft.py` avec `outcome`) et retirer les `success=False` des appelants. Ajouter `_hash_ip()` : `hashlib.sha256((settings.secret_key + ip).encode()).hexdigest()` si `ip` est non nul, sinon `None`. Corriger aussi l'annotation `user_id: str | None` en `int | None` : tous les appelants passent `user.id`, un entier.

### B3 — `auth-server/opm_auth/security/deps.py` : 206  _[type de clÃ© primaire]_

**Constat.** `session.get(User, claims.subject)` passe une chaÃ®ne comme clÃ© primaire alors que `users.id` est un `integer` â€” cassÃ© sur PostgreSQL, invisible sur le SQLite des tests.

**Symptôme.** `TokenClaims.subject` est un `str` (tokens.py:181, `subject=str(payload["sub"])`), et `create_access_token(str(user.id))` (users.py:863) le rend explicitement textuel. Le dialecte asyncpg de SQLAlchemy pose `render_bind_cast = True` sur `Integer` : la requÃªte Ã©mise est `WHERE users.id = $1::INTEGER`, PostgreSQL type donc `$1` en int4, et asyncpg refuse une chaÃ®ne â€” `DataError: invalid input for query argument $1: '7' (expected int, got str)`. ConcrÃ¨tement : en production, dÃ¨s qu'un joueur prÃ©sente son `access_token`, `GET /api/v1/auth/me`, `POST /api/v1/game/session`, `/game/session/close`, tout `/api/v1/link/microsoft/*`, `/api/v1/profile/rp`, `/api/v1/donations/checkout` et toutes les routes `/textures` authentifiÃ©es rÃ©pondent 500. Rien ne le rÃ©vÃ¨le en test : SQLite applique l'affinitÃ© de colonne et convertit '7' en 7 tout seul. Ã€ noter que `services/users.py:1144` fait bien `subject = int(claims.subject)` â€” la conversion a Ã©tÃ© faite lÃ , oubliÃ©e ici. Effet secondaire mÃªme sur SQLite : la clÃ© d'identitÃ© devient `(User, ('7',))` au lieu de `(User, (7,))`, donc l'objet est rechargÃ© au lieu d'Ãªtre repris dans l'identity map.

**Correction.** Dans `current_user` et `current_user_optional`, convertir avant l'accÃ¨s : `try: user_id = int(claims.subject)` / `except (TypeError, ValueError): raise invalid_credentials("Jeton d'accÃ¨s invalide.")`, puis `await session.get(User, user_id)`. Ne pas se contenter d'un `int()` nu : un `sub` fabriquÃ© non numÃ©rique ferait remonter un `ValueError` en 500.

### B4 — `auth-server/opm_auth/security/deps.py` : 276  _[signature divergente]_

**Constat.** `require_can_play` appelle `user.blocked_reason(microsoft_required=â€¦, email_verification_required=â€¦)` alors que le modÃ¨le n'accepte que `microsoft_required` et `now`.

**Symptôme.** `User.blocked_reason` (models.py:456-461) a la signature `(*, microsoft_required: bool, now: datetime | None = None)`. Toute route qui utilise la dÃ©pendance `PlayableUser` lÃ¨ve `TypeError: User.blocked_reason() got an unexpected keyword argument 'email_verification_required'` â†’ 500. Aucun routeur ne l'utilise aujourd'hui (`routers/game.py` passe par `CurrentUser` + la barriÃ¨re du service), donc le dÃ©faut est latent : il explosera au premier usage de `PlayableUser`, qui est pourtant exportÃ©, annotÃ© et donnÃ© en exemple dans la docstring du module (lignes 15-21). Second dÃ©faut sur la mÃªme ligne : `microsoft_required=settings.microsoft_required` lit le drapeau brut au lieu de la politique dÃ©rivÃ©e du mode. En `OPM_AUTH_MODE=microsoft` avec `OPM_MICROSOFT_REQUIRED=false`, cette barriÃ¨re laisserait passer un compte sans rattachement lÃ  oÃ¹ `services/users.microsoft_required()` et `services/yggdrasil.microsoft_required()` refusent â€” le bouton JOUER et la barriÃ¨re serveur divergeraient, exactement ce que la docstring promet d'Ã©viter.

**Correction.** Remplacer l'appel par `reason = user.blocked_reason(microsoft_required=users_service.microsoft_required(settings))` (import diffÃ©rÃ© de `opm_auth.services.users` pour Ã©viter le cycle, ou recopier les quatre lignes de politique comme le fait `services/yggdrasil.py:227-244`). Supprimer l'argument `email_verification_required` : la base du site n'a aucune colonne de vÃ©rification d'adresse, `blocked_reason` ne rend jamais `email_unverified`.

### B5 — `auth-server/tests/conftest.py` : 191  _[destruction des tables du site]_

**Constat.** La fixture `postgres_sessionmaker` exÃ©cute `drop_all` puis `create_all` sur `SITE_TABLES` â€” sans aucun garde-fou sur l'URL visÃ©e.

**Symptôme.** `tables = list(SITE_TABLES + LAUNCHER_TABLES)` puis `Base.metadata.drop_all(tables=tables)` sur le moteur construit depuis `OPM_TEST_POSTGRES_URL`. Si cette variable pointe â€” par copier-coller de `.env`, par erreur de shell, par CI mal configurÃ©e â€” sur le PostgreSQL du site, `pytest -m postgres` SUPPRIME `users`, `article`, `statistiques`, `equipages` et `iles`, comptes des joueurs compris, et les recrÃ©e vides. C'est le seul endroit du dÃ©pÃ´t oÃ¹ du code Ã©met un `DROP TABLE` ou un `CREATE TABLE` visant une table du site ; `init_models()` (db.py:255-260) est correctement bridÃ© (`with_site_tables=True` refusÃ© hors SQLite), la migration Alembic est strictement additive, mais cette fixture contourne les deux. La seule protection actuelle est un commentaire (Â« la base visÃ©e doit Ãªtre une base de test Â»).

**Correction.** Reproduire le garde-fou de `init_models` : refuser l'exÃ©cution si l'URL n'est pas explicitement jetable. Par exemple, en tÃªte de la fixture : `if not POSTGRES_URL: pytest.skip(...)` puis `db_name = POSTGRES_URL.rsplit("/", 1)[-1].split("?")[0]` et `assert "test" in db_name.lower(), "OPM_TEST_POSTGRES_URL doit dÃ©signer une base dont le nom contient Â« test Â»"`. Ajouter aussi un refus explicite si l'URL est Ã©gale Ã  `OPM_DATABASE_URL`.

### B6 — `launcher/src/assets/js/renderer.js` : 40  _[import ES non rÃ©solu]_

**Constat.** Les deux modules de coque sont importÃ©s depuis './layout/', dossier qui n'existe pas : ils vivent dans './panels/'.

**Symptôme.** SHELL_MODULES pointe sur './layout/titlebar.js' et './layout/bottombar.js'. Le disque ne contient que assets/js/components, assets/js/panels et assets/js/utils â€” aucun assets/js/layout. Les fichiers rÃ©els sont assets/js/panels/titlebar.js et assets/js/panels/bottombar.js. Le `import(spec.src)` dynamique de mountModule() (renderer.js:207) rÃ©sout relativement Ã  assets/js/renderer.js et Ã©choue donc systÃ©matiquement. mountModuleSafely avale l'erreur : le joueur voit deux notifications Â« Impossible de charger la barre de titre / la barre du bas Â», puis l'application s'affiche AMPUTÃ‰E de tout son poste de pilotage. enableTitlebarFallback() ne rattrape que la barre de titre (boutons fenÃªtre + version) ; la barre du bas n'a AUCUN repli. ConcrÃ¨tement : le bouton JOUER reste sur son Ã©tat initial du HTML (`disabled`, libellÃ© Â« PATIENTEZ Â») pour toujours, le bouton de compte n'ouvre plus le popover (aucun Popover n'est construit), l'avatar, le pseudo, le sous-titre, la jauge de progression, le pourcentage, la ligne d'Ã©tat, le bouton DÃ‰TAILS/console et la case LANCEMENT AUTO ne sont jamais cÃ¢blÃ©s ni remplis. Le launcher est inutilisable : on ne peut pas lancer le jeu.

**Correction.** Corriger les deux chemins en './panels/titlebar.js' et './panels/bottombar.js' (ou dÃ©placer les deux fichiers dans un vrai assets/js/layout/ et corriger leurs propres imports '../utils/...' en consÃ©quence). Les trois entrÃ©es de PANELS ('./panels/home.js', './panels/settings.js', './panels/donation.js') et LOGIN_MODULE ('./panels/login.js'), eux, sont corrects â€” c'est bien la seule constante SHELL_MODULES Ã  rÃ©parer.

### B7 — `auth-server/opm_auth/security/deps.py` : 206  _[authentification]_

**Constat.** L'identifiant du porteur du jeton est passÃ© en chaÃ®ne Ã  session.get(User, ...) alors que users.id est un INTEGER : asyncpg refuse le paramÃ¨tre en production.

**Symptôme.** create_access_token(str(user.id)) Ã©crit sub="12" et TokenClaims.subject reste une str. sqlalchemy.Integer n'a AUCUN bind_processor (vÃ©rifiÃ© : Integer().dialect_impl(postgresql.dialect()).bind_processor(...) vaut None), donc la chaÃ®ne '12' est remise telle quelle Ã  asyncpg pour un paramÃ¨tre int4. asyncpg lÃ¨ve DataError: invalid input for query argument $1: '12' (expected int, got str). ConcrÃ¨tement : dÃ¨s que le serveur tourne sur le PostgreSQL du site, TOUTE route authentifiÃ©e â€” GET /api/v1/auth/me, POST /api/v1/game/session, tout /api/v1/link/microsoft/*, GET|POST|DELETE /textures/* â€” rÃ©pond 500 aprÃ¨s une connexion pourtant rÃ©ussie. Le launcher ne dÃ©passe jamais l'Ã©cran de connexion. Les tests ne le voient pas : tests/conftest.py:85 utilise sqlite+aiosqlite, qui convertit silencieusement la chaÃ®ne en entier. MÃªme dÃ©faut en deps.py:221 (current_user_optional).

**Correction.** Convertir le sujet en entier avant l'accÃ¨s Ã  la base, dans les deux fonctions : `try: user_id = int(claims.subject)` / `except (TypeError, ValueError): raise invalid_credentials("Jeton d'accÃ¨s invalide.")` puis `await session.get(User, user_id)`. C'est dÃ©jÃ  ce que fait services/users.py:1145 (reset_password) â€” aligner deps.py dessus.

### B8 — `auth-server/opm_auth/security/ratelimit.py` : 434  _[limitation de debit]_

**Constat.** client_ip() retient la PREMIÃˆRE valeur de X-Forwarded-For, celle que le client Ã©crit lui-mÃªme : toute la limitation de dÃ©bit est contournable derriÃ¨re un reverse-proxy.

**Symptôme.** En production, OPM_TRUST_PROXY_HEADERS doit valoir vrai (sinon toutes les requÃªtes portent l'IP du nginx local et 5 connexions/minute bloquent le serveur entier). Dans ce mode, la boucle `for candidate in forwarded.split(",")` retourne la premiÃ¨re entrÃ©e valide. Or nginx AJOUTE l'IP rÃ©elle Ã  la fin : un attaquant qui envoie `X-Forwarded-For: 203.0.113.7` obtient `203.0.113.7, <ip rÃ©elle>` et le serveur retient 203.0.113.7. En incrÃ©mentant cette valeur Ã  chaque requÃªte, il obtient un compartiment neuf Ã  chaque tentative : auth.login.ip (5/min), auth.register.ip (3/h), yggdrasil.authenticate.ip (10/min), link.microsoft.ip et auth.password.forgot.ip ne s'appliquent plus jamais. La force brute sur les mots de passe redevient illimitÃ©e cÃ´tÃ© Yggdrasil, et illimitÃ©e cÃ´tÃ© /auth/login pour la partie IP (seule auth.login.account, 10/h, subsiste).

**Correction.** Ne jamais lire la gauche de la chaÃ®ne. Ajouter un rÃ©glage OPM_TRUSTED_PROXY_HOPS (dÃ©faut 1) et prendre la (hops+1)-iÃ¨me entrÃ©e EN PARTANT DE LA DROITE : `parts = [p.strip() for p in forwarded.split(",") if p.strip()]` puis `candidate = parts[-hops]` si `len(parts) >= hops`, sinon retomber sur request.client.host. Valider ensuite avec ipaddress.ip_address et refuser silencieusement l'en-tÃªte si le compte de sauts ne correspond pas. Appliquer la mÃªme rÃ¨gle Ã  x-real-ip (une seule valeur, donc acceptable telle quelle) et Ã  RequestContextMiddleware, qui appelle la mÃªme fonction (main.py:298).

---

## MAJEURS

### M1 — `auth-server/migrations/versions/0001_launcher_auth.py` : 75  _[migration inapplicable]_

**Constat.** `down_revision = None` combinÃ© Ã  `version_table = "alembic_version"` (celle du site) rend la migration inapplicable en l'Ã©tat sur la base de production.

**Symptôme.** `migrations/env.py:182-184` impose `version_table="alembic_version"`, la table du site. Sur la base rÃ©elle, cette table contient dÃ©jÃ  la rÃ©vision courante du site (le dump la dÃ©clare, ligne 30 du schÃ©ma). Au `alembic upgrade head`, Alembic lit cette rÃ©vision, ne la trouve pas dans notre `versions/` et s'arrÃªte sur `Can't locate revision identified by '<rev du site>'` ; dans le meilleur des cas il dÃ©tecte deux tÃªtes et refuse. La migration est donc livrÃ©e dans un Ã©tat qui ne s'applique pas. Le fichier documente honnÃªtement la manÅ“uvre (lignes 24-43) mais aucune valeur n'a Ã©tÃ© renseignÃ©e, et rien n'Ã©choue avec un message parlant : l'exploitant tombe sur une erreur Alembic obscure.

**Correction.** Soit renseigner `down_revision` avec la rÃ©vision courante du site avant livraison, soit â€” plus robuste puisque le dÃ©pÃ´t du site n'est pas ici â€” donner Ã  notre historique sa propre table : dans `env.py:_options_communes`, remplacer `"version_table": "alembic_version"` par `"version_table": "alembic_version_launcher"`. Les deux historiques cohabitent alors sans se marcher dessus, et `down_revision = None` devient correct. Mettre Ã  jour en consÃ©quence la docstring du fichier de migration et `migrations/README.md`.

### M2 — `auth-server/migrations/versions/0001_launcher_auth.py` : 123  _[migration inapplicable]_

**Constat.** `_controles_prealables()` exige la prÃ©sence de la table `users`, ce qui interdit d'appliquer la migration sur une base neuve â€” que la docstring dÃ©clare pourtant supportÃ©e.

**Symptôme.** Lignes 123-127 : `if "users" not in tables: raise RuntimeError("Table Â« users Â» introuvable â€¦")`. Sur une base de dÃ©veloppement, de CI ou d'intÃ©gration oÃ¹ le site n'existe pas (le cas dÃ©crit lignes 42-43 : Â« Sur une base neuve â€¦ None est la valeur correcte : ne rien changer Â»), `alembic upgrade head` Ã©choue systÃ©matiquement. Le dÃ©veloppeur n'a alors aucun moyen de fabriquer le schÃ©ma par la voie officielle : il doit passer par `opm-auth initdb`, qui n'Ã©crit rien dans `alembic_version` â€” la base de dev et la base de prod divergent en silence.

**Correction.** Rendre le contrÃ´le conditionnel : n'exiger `users` que si la base contient dÃ©jÃ  des tables du site, ou n'exiger que la cohÃ©rence du type quand la table est prÃ©sente. Par exemple : `if "users" in tables: <vÃ©rifier que id est un Integer>` et remplacer le refus dur par un simple avertissement quand `users` est absent, en conservant le refus si `users` existe avec un `id` non entier.

### M3 — `auth-server/opm_auth/config.py` : 18  _[droits base de donnÃ©es]_

**Constat.** La liste des droits PostgreSQL documentÃ©e en tÃªte de config.py ne couvre ni l'INSERT sur `users`, ni l'UPDATE de `users.password_hash` â€” deux Ã©critures que le code rÃ©alise pourtant.

**Symptôme.** Lignes 18-25, la docstring prescrit au rÃ´le : Â« SELECT sur les tables du site Â» et Â« UPDATE limitÃ© Ã  users.derniereconnexion, users.tempsdejeu et aux colonnes de frÃ©quentation de statistiques Â». Or `services/users.create_user` (users.py:500-509) fait un `INSERT INTO users`, et `services/users.authenticate` (users.py:742) puis `reset_password` (users.py:1160) Ã©crivent `users.password_hash` â€” le renforcement transparent exigÃ© par DATA.md Â§3. Si l'exploitant applique littÃ©ralement ces droits, `POST /api/v1/auth/register` Ã©choue en `permission denied for table users`, et toute connexion d'un compte historique Ã  260 000 itÃ©rations Ã©choue au flush du renforcement, c'est-Ã -dire que le joueur ne peut plus se connecter du tout. Le mÃªme flottement existe dans `.env.example` et dans les docstrings de `services/users.py`, qui, elles, mentionnent bien l'INSERT et le password_hash (lignes 25-30).

**Correction.** Corriger la liste de droits de la docstring pour ajouter `INSERT` sur `users` et sa sÃ©quence `users_id_seq`, et Ã©tendre l'`UPDATE` limitÃ© Ã  `users.password_hash`. Formulation attendue : Â« UPDATE limitÃ© Ã  users.derniereconnexion, users.tempsdejeu, users.password_hash Â» et Â« INSERT sur users (+ USAGE sur users_id_seq) pour la crÃ©ation de compte depuis le launcher Â». RÃ©percuter dans `.env.example` et `README.md`.

### M4 — `auth-server/opm_auth/security/passwords.py` : 513  _[sync dans async]_

**Constat.** Toutes les dÃ©rivations PBKDF2 (600 000 itÃ©rations) sont exÃ©cutÃ©es en synchrone dans la boucle d'Ã©vÃ¨nements, sans `asyncio.to_thread`.

**Symptôme.** `hash_password` (l.513), `verify_password`â†’`_matches`â†’`_derive` (l.394), `_burn_cpu` (l.441) et `verify_secret` sont appelÃ©s directement depuis des coroutines : `services/users.create_user`, `authenticate`, `reset_password`, `disable_totp`, et `services/yggdrasil.authenticate`/`signout`. 600 000 itÃ©rations PBKDF2-SHA256 coÃ»tent 0,3 Ã  0,5 s de CPU pur, GIL tenu. Pendant ce temps le processus entier est figÃ© : le ping de la tÃ¢che de fond, `/status`, `/bootstrap`, `hasJoined` du serveur Minecraft â€” tout attend. Une salve de dix connexions simultanÃ©es, ou dix connexions ratÃ©es (chacune paie `_burn_cpu()` au tarif plein), gÃ¨le le serveur plusieurs secondes ; un `hasJoined` retardÃ© au-delÃ  du dÃ©lai du serveur de jeu se traduit par un joueur Ã©jectÃ©. Le reste du projet applique pourtant la bonne rÃ¨gle : `services/mailer.py:247` et `services/textures.py:325,354,360` passent tous par `asyncio.to_thread`.

**Correction.** Ajouter dans `passwords.py` des enveloppes asynchrones â€” `async def averify_and_update(stored, password): return await asyncio.to_thread(verify_and_update, stored, password)`, idem pour `hash_password`, `verify_password` et `verify_secret` â€” et remplacer les appels dans `services/users.py` et `services/yggdrasil.py`. Garder les fonctions synchrones pour la CLI et les tests.

### M5 — `auth-server/opm_auth/routers/yggdrasil.py` : 203  _[endpoint manquant]_

**Constat.** L'API Yggdrasil de `docs/API.md` Â§2.4 n'est implÃ©mentÃ©e qu'Ã  moitiÃ© : `/yggdrasil/api/user/profile/{uuid}/{textureType}` n'existe pas.

**Symptôme.** Le routeur n'expose que `POST /api/profiles/minecraft`. `docs/API.md` Â§2.4 (ligne 260) exige aussi `/user/profile/{uuid}/{textureType}` pour le tÃ©lÃ©versement et la suppression de skin authentifiÃ©s â€” c'est le point d'entrÃ©e standard d'authlib-injector. ConsÃ©quence : un joueur qui change de skin par un outil ou une commande passant par l'API ALI reÃ§oit un 404, et le message d'erreur sort au format normalisÃ© de l'API launcher et non au format Mojang (le gestionnaire de `main.py` bascule bien sur le format Mojang pour le prÃ©fixe `/yggdrasil`, donc ce point-lÃ  est correct, mais la fonctionnalitÃ© manque). Le launcher a sa propre route `/textures/{kind}`, la lacune ne casse donc pas le parcours nominal, mais le contrat n'est pas rempli.

**Correction.** Ajouter dans `routers/yggdrasil.py` un `PUT /api/user/profile/{profile_uuid}/{texture_type}` et un `DELETE` correspondant, protÃ©gÃ©s par `CurrentUser`, vÃ©rifiant que `profile_uuid` correspond bien Ã  `auth_mc_link.minecraft_uuid` du porteur, et dÃ©lÃ©guant Ã  `services.textures.store_upload` / `clear_texture`. Sinon, retirer explicitement cette ligne de `docs/API.md` Â§2.4 pour que le contrat cesse de promettre ce qui n'existe pas.

### M6 — `auth-server/opm_auth/security/passwords.py` : 441  _[securite / canal auxiliaire temporel]_

**Constat.** _burn_cpu() brule 600 000 iterations alors qu'un compte existant du site n'en coute que 260 000 : le temps de reponse trahit l'existence du compte.

**Symptôme.** Mesure sur cette machine : verify_password(hachage 260 000, mauvais mot de passe) = 0,142 s ; verify_password(None, ...) (compte inconnu) = 0,340 s. Un attaquant qui envoie une adresse e-mail avec un mot de passe bidon distingue donc Â« compte existant Â» (~140 ms) de Â« compte inexistant Â» (~340 ms) avec un ecart de 2,4x, largement mesurable a travers le reseau. Comme la totalite du parc du site est aujourd'hui en pbkdf2:sha256:260000, l'enumeration marche sur 100 % des comptes existants â€” precisement ce que le docstring de _burn_cpu et docs/API.md Â§4.6 pretendent empecher. L'ecart se referme seulement au fil du renforcement, donc jamais pour un compte qui ne se connecte pas au launcher.

**Correction.** Ne pas essayer d'egaliser par le nombre d'iterations (il varie d'une ligne a l'autre : 260 000, 600 000, scrypt, ambigu a 860 000). Imposer un budget de temps constant : relever time.monotonic() a l'entree de authenticate(), et apres l'issue (succes, echec, compte inconnu) attendre jusqu'a une echeance fixe (constante _LOGIN_TIME_BUDGET, ex. 700 ms, > au pire cas verif+rehash mesure a 0,648 s) avec await asyncio.sleep(deadline - now). Garder _burn_cpu uniquement pour ne pas laisser un cÅ“ur inactif n'apporte rien : c'est le padding jusqu'a l'echeance qui rend les trois chemins indiscernables.

### M7 — `auth-server/opm_auth/services/users.py` : 696  _[performance / disponibilite]_

**Constat.** Toutes les derivations PBKDF2 (0,14 a 0,65 s) sont executees en synchrone dans les coroutines FastAPI : la boucle d'evenements est bloquee a chaque connexion.

**Symptôme.** authenticate() est async et appelle verify_and_update() directement (aucun asyncio.to_thread / run_in_threadpool nulle part dans le serveur â€” seuls mailer.py et textures.py en utilisent). Mesures : connexion reussie sur un hachage 260 000 = verif 0,171 s + rehash 0,428 s = 0,648 s de CPU pur, tentative sur compte inconnu = 0,340 s. Si trois joueurs se connectent dans la meme seconde, le worker uvicorn est sature : pendant ~2 s il ne repond plus a RIEN â€” ni /yggdrasil/hasJoined (le serveur Minecraft refuse alors les entrees en jeu), ni le ping /statistiques, ni les rafraichissements de jeton. Un simple flux de POST /yggdrasil/authenticate avec des identifiants bidons, meme rate-limite par IP mais depuis plusieurs IP, coute 0,34 s de boucle par requete et suffit a un deni de service. Memes appels bloquants a users.py:487 (create_user), users.py:1160 (reset_password), users.py:1331 (disable_totp), yggdrasil.py:686 et 776, microsoft.py:1527, et totp.py:202 (verify_secret x10 = ~0,35 s).

**Correction.** Deporter systematiquement la derivation hors de la boucle : await asyncio.to_thread(verify_and_update, stored, password), await asyncio.to_thread(hash_password, password), await asyncio.to_thread(verify_password, ...), await asyncio.to_thread(verify_recovery_code, ...) dans les huit points d'appel cites. Les fonctions de passwords.py restent synchrones (c'est correct) ; ce sont les services qui doivent les appeler via un thread.

### M8 — `auth-server/pyproject.toml` : 42  _[dependances / residu Argon2id]_

**Constat.** argon2-cffi est encore une dependance obligatoire, avec le commentaire Â« hachage des mots de passe (Argon2id) Â», alors qu'aucun module ne l'importe.

**Symptôme.** pyproject.toml:42 ("argon2-cffi>=23.1.0",  # hachage des mots de passe (Argon2id)) et requirements.txt:23 (argon2-cffi==23.1.0). Aucun `import argon2` n'existe dans opm_auth/. Consequences concretes : (1) le Dockerfile (lignes 30-31, build-essential + libffi-dev, puis pip install -r requirements.txt) compile une extension C jamais chargee, ce qui rallonge chaque build et grossit l'image ; (2) le commentaire dit noir sur blanc que les mots de passe sont haches en Argon2id â€” un futur mainteneur qui le lit et Â« remet en service Â» la dependance reecrira les empreintes et coupera l'acces au site a tous les joueurs, le scenario exact que docs/DATA.md Â§3 interdit.

**Correction.** Supprimer la ligne 42 de pyproject.toml et la ligne 23 de requirements.txt. Verifier ensuite si build-essential/libffi-dev restent necessaires dans le Dockerfile (cryptography, asyncpg et pillow publient des wheels manylinux : ils ne le sont probablement plus).

### M9 — `launcher/src/assets/js/panels/bottombar.js` : 533  _[routage renderer]_

**Constat.** Â« + AJOUTER UN COMPTE Â» Ã©crit `screen: 'login'` dans le magasin au lieu d'Ã©mettre l'Ã©vÃ©nement 'opm:request-login' : rien ne s'affiche, et l'Ã©tat est corrompu pour la suite.

**Symptôme.** addAccount() fait `store.set({ screen: 'login', loginView: 'login' })`. Or c'est renderer.setScreen() (renderer.js:362) qui commute rÃ©ellement le DOM, et il commence par `if (store.get().screen === name) return;`. Le magasin passe donc Ã  'login' sans que la section [data-screen="login"] soit dÃ©masquÃ©e. Si l'utilisateur clique sur Â« + AJOUTER UN COMPTE Â» dans le popover de la barre du bas : (1) rien ne se passe Ã  l'Ã©cran ; (2) pire, tout routage ultÃ©rieur vers la connexion est neutralisÃ© â€” aprÃ¨s une dÃ©connexion, routeTo â†’ enterRoute â†’ setScreen('login') sort immÃ©diatement, la coque reste affichÃ©e et l'Ã©cran de connexion reste `hidden` : le joueur est bloquÃ© sur une application sans compte. panels/settings.js:573 fait pourtant la bonne chose pour le mÃªme bouton (`document.dispatchEvent(new CustomEvent('opm:request-login', { detail: { view: 'login' } }))`), Ã©coutÃ© par login.js:253.

**Correction.** Remplacer le `store.set({ screen: ... })` de addAccount() par le mÃªme dispatch que settings.js : `document.dispatchEvent(new CustomEvent('opm:request-login', { detail: { view: 'login' } }))` (en conservant l'appel Ã  ctx.setLoginView). Aucun module hors du renderer ne doit Ã©crire la clÃ© `screen` du magasin ; Ã  dÃ©faut, faire de setScreen() la seule Ã©criture autorisÃ©e et lui laisser piloter le DOM.

### M10 — `launcher/src/assets/js/utils/skin.js` : 41  _[CORS / rendu du skin]_

**Constat.** Les tÃªtes de skin sont chargÃ©es en `crossOrigin='anonymous'` depuis https://authâ€¦/textures/, alors que le serveur Python n'ouvre CORS pour personne : aucun skin ne s'affichera jamais.

**Symptôme.** loadImage() force `image.crossOrigin = 'anonymous'` (indispensable, sinon drawHead â†’ canvas.toDataURL() lÃ¨verait sur un canevas teintÃ©). L'URL vient de accounts.skinUrl() : `${api.baseUrl()}/textures/{sha}.png`. CÃ´tÃ© serveur, opm_auth/main.py:722-732 n'installe CORSMiddleware que si `settings.cors_origins_list` est non vide, et opm_auth/config.py:101 fixe `cors_origins = ""` par dÃ©faut (API.md Â§4.7 : Â« CORS fermÃ© par dÃ©faut Â»). La requÃªte part d'un document file:// (Origin: null) ; sans en-tÃªte Access-Control-Allow-Origin, l'image part en erreur. RÃ©sultat : headDataUrl() retombe sur FALLBACK_HEAD Ã  chaque appel â€” barre du bas, popover des comptes, cartes de compte des paramÃ¨tres, carte de confirmation du rattachement et scÃ¨ne de l'accueil affichent tous Steve, pour tous les joueurs, en permanence. La fonctionnalitÃ© Â« le joueur retrouve son apparence sans rien faire Â» (DATA.md Â§6) ne fonctionne pas.

**Correction.** Deux corrections possibles, l'une ou l'autre : (a) cÃ´tÃ© serveur, poser inconditionnellement `Access-Control-Allow-Origin: *` dans les CACHE_HEADERS de opm_auth/routers/textures.py (une texture publique adressÃ©e par son sha256 ne divulgue rien) ; ou (b) cÃ´tÃ© launcher, tÃ©lÃ©charger la texture dans le processus principal et la transmettre au renderer en `data:` URL via un nouveau canal IPC, ce qui supprime tout besoin de CORS. Ne pas se contenter de retirer `crossOrigin` : le canevas serait teintÃ© et toDataURL() Ã©chouerait.

### M11 — `launcher/src/main/auth/api.js` : 492  _[endpoint manquant cÃ´tÃ© launcher]_

**Constat.** Le launcher n'appelle jamais POST /api/v1/game/session/close : `users.tempsdejeu` n'est jamais crÃ©ditÃ© et la session Yggdrasil de 24 h n'est jamais invalidÃ©e.

**Symptôme.** opm_auth/routers/game.py:66 expose `POST /api/v1/game/session/close` avec `{duration_s, client_token?}` pour ajouter la durÃ©e jouÃ©e Ã  `users.tempsdejeu` et invalider la session â€” c'est l'Ã©criture exigÃ©e par DATA.md Â§4 (Â« Fin d'une session de jeu â†’ users.tempsdejeu += durÃ©e Â»). CÃ´tÃ© launcher, api.js n'a que `gameSession()` (POST /game/session) ; accounts.js n'expose rien pour la fermeture ; game.js:656 onClose()/finish() se contentent d'Ã©mettre `{type:'closed'}` sans mesurer ni rapporter la durÃ©e. Si un joueur joue trois heures et ferme Minecraft, le site continue d'afficher son ancien temps de jeu, et le jeton Yggdrasil Ã©mis reste valide 24 h aprÃ¨s la fin de la partie.

**Correction.** Ajouter dans api.js un `gameSessionClose({duration_s, client_token}, token)` sur `POST ${API}/game/session/close` ; dans accounts.js un `closeGameSession(payload)` passant par `withAuth`. Dans game.js, mÃ©moriser dans `run` le `client_token` renvoyÃ© par gameSession() et l'horodatage du passage Ã  `running`, puis appeler la fermeture depuis onClose() avec `duration_s = Math.round((Date.now() - run.startedAt)/1000)`. L'Ã©chec de cet appel ne doit pas Ãªtre fatal (simple avertissement au journal).

### M12 — `launcher/src/app.js` : 179  _[fonctionnalitÃ© morte]_

**Constat.** `updater.check()` n'est appelÃ© par personne : la mise Ã  jour du launcher ne se dÃ©clenche jamais.

**Symptôme.** Le canal `updater:check` est enregistrÃ© (ipc.js:457), exposÃ© par le preload (preload.js:207) et le renderer Ã©coute bien `updater:event` (renderer.js:775), mais aucun appel Ã  `opm.updater.check()` n'existe dans tout le renderer, et app.js ne lance rien au dÃ©marrage. ConsÃ©quence : aucun Ã©vÃ©nement de mise Ã  jour n'est jamais Ã©mis, l'Ã©tat `store.updater` reste 'idle' Ã  vie, et l'interrupteur Â« Mises Ã  jour automatiques Â» des paramÃ¨tres (data-key="launcher.auto_update") ne pilote rien. Un launcher publiÃ© ne se mettra jamais Ã  jour tout seul.

**Correction.** DÃ©clencher la vÃ©rification une fois l'application prÃªte â€” soit dans app.js start(), aprÃ¨s `mainWindow.create()`, par `updater.check().catch(() => {})` (electron-updater est dÃ©jÃ  neutralisÃ© hors paquet, updater.js:189), soit dans renderer.js boot() aprÃ¨s l'Ã©tape bootstrap par `opm.updater.check()`. Un seul des deux, pour ne pas vÃ©rifier deux fois.

### M13 — `launcher/src/main/auth/accounts.js` : 232  _[contrat IPC incomplet / Ã©cart maquette]_

**Constat.** toAccount() jette `user.profile` : le sous-titre Â« Pirate Â· Ã‰quipage des CÅ“urs BrisÃ©s Â· 3 Ã®les tenues Â» de la maquette est irrÃ©alisable, et GET /api/v1/profile/rp n'est jamais appelÃ©.

**Symptôme.** Le serveur renvoie sur /auth/login et /auth/me un objet `user.profile` complet (faction, metier, equipage, iles_tenues, prime, berry, niveau, temps_de_jeu_s â€” schemas.py:330, UserProfileOut) et expose en plus `GET /api/v1/profile/rp` (routers/launcher.py:791) dont la docstring dit explicitement qu'il Â« alimente le sous-titre de l'accueil â€” Pirate Â· Ã‰quipage des CÅ“urs BrisÃ©s Â· 3 Ã®les tenues Â». accounts.toAccount() ne recopie que id/email/username/minecraft/skin_url/can_play/blocked_reason/session_expires_at/totp_enabled ; le type Account de IPC.md n'a pas de champ profil ; aucune mÃ©thode `window.opm` ne donne accÃ¨s Ã  la fiche RP. RÃ©sultat : home.js:645 playerSub() affiche Â« Pseudo en jeu Â· Melodia Â» ou Â« Compte One Piece Minecraft Â» lÃ  oÃ¹ la maquette (DesignMaquette/Launcher OPM.dc.html:184) et DATA.md Â§1 exigent la ligne RP. La donnÃ©e est calculÃ©e par le serveur et jetÃ©e Ã  l'arrivÃ©e.

**Correction.** Ajouter au contrat IPC un `content.profileRp()` (ou un champ `profile` sur Account) : une mÃ©thode preload â†’ canal `content:profile-rp` â†’ handler â†’ nouveau `api.profileRp(token)` sur `GET ${API}/profile/rp`, avec cache 5 min dans services/content.js (TTL prÃ©vu par DATA.md Â§5). Puis, dans home.js playerSub(), composer `[faction, equipage ? \`Ã‰quipage des ${equipage}\` : null, iles_tenues ? \`${iles_tenues} Ã®les tenues\` : null].filter(Boolean).join(' Â· ')` et ne retomber sur le pseudo Minecraft qu'en l'absence de fiche RP.

### M14 — `launcher/src/assets/js/panels/login.js` : 814  _[flux Microsoft Â« device Â»]_

**Constat.** En mode `device`, le code Ã  saisir n'est jamais affichÃ© : deviceOf() est du code mort parce que auth.linkMicrosoft() ne rÃ©sout qu'Ã  la toute fin de la scrutation.

**Symptôme.** accounts.linkMicrosoft() (accounts.js:915) exÃ©cute le flux device de bout en bout : linkDevice() ouvre microsoft.com/link dans le navigateur, Ã©crit le user_code UNIQUEMENT dans le journal (accounts.js:865) et boucle jusqu'Ã  15 minutes avant de renvoyer le compte rattachÃ©. Le renderer, lui, `await this.ctx.opm.auth.linkMicrosoft()` puis teste `result.user_code` : la valeur rendue est un Account, elle n'a jamais de user_code. Donc showDevice() n'est jamais appelÃ©e, le bloc [data-el="link-device"] et son [data-bind="ms-user-code"] restent masquÃ©s, et le bouton reste sur Â« VÃ‰RIFICATION EN COURSâ€¦ Â» pendant tout ce temps. Si OPM_MSA_FLOW=device (config.py, prÃ©vu par API.md Â§1.1), le joueur voit s'ouvrir une page Microsoft qui lui rÃ©clame un code que le launcher ne lui montre nulle part : le rattachement est impossible sans aller lire le fichier de log.

**Correction.** Ouvrir un canal descendant pour le flux device â€” par exemple Ã©mettre `auth:link-device` depuis linkDevice() (avec user_code, verification_uri, expires_in) avant d'entrer dans la boucle de scrutation, l'exposer par un `auth.onLinkDevice(cb)` dans le preload et le documenter dans IPC.md, puis brancher login.js dessus Ã  la place de deviceOf(). Ã€ dÃ©faut, si le mode device n'est pas soutenu, retirer le bloc [data-el="link-device"] du HTML, deviceOf()/showDevice()/copyDeviceCode()/openDeviceLink() de login.js et forcer OPM_MSA_FLOW=embedded â€” mais ne pas laisser une UI qui ne se remplit jamais.

### M15 — `auth-server/opm_auth/services/yggdrasil.py` : 671  _[force brute]_

**Constat.** POST /yggdrasil/authserver/authenticate vÃ©rifie le mot de passe sans aucune limite par compte et sans consigner l'Ã©chec : c'est une porte de force brute parallÃ¨le Ã  /auth/login.

**Symptôme.** services/users.py:692 applique `enforce("auth.login.account", email)` â€” 10 tentatives par heure et par compte. yggdrasil.authenticate appelle directement verify_password (ligne 678) sans cet appel. Un attaquant vise donc /yggdrasil/authserver/authenticate : seule yggdrasil.authenticate.ip (10/minute) s'applique, soit 14 400 essais par jour et par IP sur un mÃªme compte, contre 240 par le chemin launcher â€” et zÃ©ro s'il exploite en plus la faille X-Forwarded-For ci-dessus. Aucune ligne LOGIN_FAILED n'est Ã©crite dans auth_audit : l'attaque est invisible dans le journal d'audit, et signout (ligne 770) prÃ©sente exactement le mÃªme dÃ©faut.

**Correction.** Dans yggdrasil.authenticate et yggdrasil.signout, appeler `await enforce("auth.login.account", users.normalize_email(payload.username))` avant la vÃ©rification du mot de passe (l'appel doit prÃ©cÃ©der la recherche du compte, comme dans users.authenticate, pour ne pas trahir les identifiants inconnus), et Ã©crire un audit.record(AuditAction.LOGIN_FAILED, ...) commit compris sur Ã©chec, comme le fait users._login_failure.

### M16 — `auth-server/opm_auth/services/users.py` : 1162  _[revocation de session]_

**Constat.** reset_password ne rÃ©voque que les refresh_token du launcher : les sessions de jeu Yggdrasil de 24 h de l'attaquant survivent Ã  la rÃ©initialisation du mot de passe.

**Symptôme.** _revoke_all_sessions ne touche que auth_refresh_token. Un compte volÃ©, dont le joueur lÃ©gitime reprend la main par Â« mot de passe oubliÃ© Â», laisse Ã  l'attaquant : (a) son accessToken Yggdrasil encore valable jusqu'Ã  24 h â€” il reste connectÃ© au serveur Minecraft, resolve_session ne consulte que ygg_session et l'expiration ; (b) son access_token API jusqu'Ã  15 min. Le commentaire du code dit pourtant Â« un mot de passe rÃ©initialisÃ© est un mot de passe qui a peut-Ãªtre fuitÃ© Â». MÃªme trou pour disable_totp et pour microsoft.detach.

**Correction.** Dans reset_password, aprÃ¨s _revoke_all_sessions, ajouter `await session.execute(update(YggSession).where(YggSession.user_id == user.id, YggSession.invalidated_at.is_(None)).values(invalidated_at=utcnow()))` â€” c'est exactement l'instruction dÃ©jÃ  Ã©crite dans yggdrasil.signout (ligne 781). IdÃ©alement, ajouter aussi une colonne users-side ou une table de coupure horodatÃ©e pour invalider les access_token Ã©mis avant la rÃ©initialisation.

### M17 — `auth-server/opm_auth/routers/textures.py` : 248  _[deni de service]_

**Constat.** _read_payload charge le corps entier en mÃ©moire sans plafond dÃ¨s que Content-Length est absent (Transfer-Encoding: chunked), malgrÃ© la docstring qui promet le contraire.

**Symptôme.** Le garde-fou de la ligne 237 ne s'applique que si `announced` existe et est numÃ©rique. Un client qui poste sur /textures/skin en HTTP/1.1 chunked (ou en HTTP/2, oÃ¹ Content-Length est optionnel) atteint `data = await request.body()` ligne 248, qui accumule le flux entier en RAM : quelques requÃªtes de 2 Gio suffisent Ã  faire tuer le processus par l'OOM killer, alors que OPM_TEXTURE_MAX_KIB vaut quelques centaines de Kio. Le contrÃ´le de taille de store_upload (services/textures.py:611) arrive trop tard, aprÃ¨s que la mÃ©moire est dÃ©jÃ  consommÃ©e. Sur le chemin multipart, le problÃ¨me se dÃ©place sur le disque : Starlette a dÃ©jÃ  dÃ©versÃ© la piÃ¨ce complÃ¨te dans un fichier temporaire avant que le gestionnaire ne s'exÃ©cute.

**Correction.** Ne jamais appeler request.body(). Lire par morceaux avec une borne dure : `total = 0; chunks = []; async for chunk in request.stream(): total += len(chunk); if total > limit: raise ApiError("texture_too_large", ..., status_code=413); chunks.append(chunk)`. Pour le multipart, limiter en amont via un middleware ASGI qui refuse toute requÃªte dont le corps dÃ©passe limit+4096 octets cumulÃ©s, et passer max_part_size au parseur multipart de Starlette.

### M18 — `launcher/src/main/auth/accounts.js` : 872  _[electron]_

**Constat.** linkDevice passe verification_uri Ã  shell.openExternal sans contrÃ´le de schÃ©ma, alors que ipc.js et app.js valident tous deux http(s).

**Symptôme.** `uri` vient de start.verification_uri, renvoyÃ© par notre serveur, qui le recopie tel quel depuis la rÃ©ponse device_code de Microsoft (services/microsoft.py:700 : `verification = str(payload.get("verification_uri") ...)` sans aucune validation, l'URL du point d'entrÃ©e Ã©tant elle-mÃªme configurable par OPM_MSA_DEVICE_CODE_URL). Seul `typeof === 'string'` est vÃ©rifiÃ© ligne 859. Une valeur `file:///C:/Windows/System32/...`, `ms-msdt:...` ou tout schÃ©ma enregistrÃ© sur la machine est donc lancÃ©e par le systÃ¨me d'exploitation du joueur au premier clic sur Â« rattacher un compte Â» en mode device. C'est prÃ©cisÃ©ment ce que les deux autres appels du projet interdisent (ipc.js:179-192 isHttpUrl, app.js:93-99 openExternal).

**Correction.** RÃ©utiliser le mÃªme filtre : dans accounts.js, avant l'appel, `const parsed = (() => { try { return new URL(uri); } catch { return null; } })(); if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) { logger.warn(...); }` et n'ouvrir que dans le cas contraire. CÃ´tÃ© serveur, valider aussi verification_uri dans start_device_flow (schÃ©ma https uniquement) avant de le renvoyer au launcher.

### M19 — `auth-server/opm_auth/services/yggdrasil.py` : 1142  _[integrite des donnees]_

**Constat.** close_game_session ajoute duration_s Ã  users.tempsdejeu sans le confronter Ã  une session rÃ©elle ni le limiter en frÃ©quence : un launcher modifiÃ© gonfle le temps de jeu Ã  volontÃ© dans la base du site.

**Symptôme.** Le service accepte n'importe quel duration_s entre 0 et 86 400 (schemas.py:538), n'exige pas de client_token, ne vÃ©rifie pas qu'une ygg_session correspondante existe, ne compare pas la durÃ©e Ã  (maintenant - session.issued_at), et aucune rÃ¨gle de limitation n'est appliquÃ©e (game.session.account ne couvre que l'ouverture, ligne 1122). Un joueur qui rejoue la requÃªte POST /api/v1/game/session/close en boucle avec duration_s=86400 s'attribue des annÃ©es de temps de jeu â€” colonne du site, affichÃ©e sur onepieceminecraft.fr et probablement adossÃ©e Ã  des rÃ©compenses RP. C'est aussi la seule Ã©criture que docs/DATA.md Â§4 nous autorise sur users : elle doit Ãªtre irrÃ©prochable.

**Correction.** Rendre client_token obligatoire, retrouver la ligne ygg_session correspondante (user_id + client_token), refuser 400 si elle n'existe pas ou est dÃ©jÃ  invalidÃ©e, et plafonner : `seconds = min(seconds, int((moment - session_row.issued_at).total_seconds()))`. Ajouter une rÃ¨gle `game.session.close.account` (par exemple 20/heure) et l'appliquer par enforce() en tÃªte de fonction.

### M20 — `launcher/src/main/services/vault.js` : 173  _[stockage local]_

**Constat.** Le repli AES-256-GCM du coffre dÃ©rive sa clÃ© de donnÃ©es publiques (nom de machine, nom d'utilisateur) et range le sel dans le mÃªme fichier : ce n'est pas du chiffrement, c'est de l'obscurcissement.

**Symptôme.** machineMaterial() vaut `opm-vault <os.hostname()> <username>` â€” deux valeurs lisibles par n'importe quel processus, et souvent devinables depuis l'extÃ©rieur. Le sel est Ã©crit en clair dans vault.bin (ligne 181). Quiconque obtient une copie de vault.bin â€” sauvegarde, dossier de profil sur un disque rÃ©cupÃ©rÃ©, autre compte administrateur de la machine, maliciel sans privilÃ¨ges â€” reconstitue la clÃ© en une ligne de code et lit tous les refresh_token OPM des comptes enregistrÃ©s, donc prend le contrÃ´le des comptes. L'avertissement journalisÃ© (ligne 133) sous-estime le risque : il ne mentionne que Â« un autre programme lancÃ© sous le mÃªme compte systÃ¨me Â», alors que la protection contre la copie du fichier ailleurs est elle aussi illusoire dÃ¨s que hostname et username sont connus. Le chemin est atteint sur toute machine Linux sans trousseau, et sur toute plateforme si safeStorage est interrogÃ© avant app.whenReady() (ligne 98 renvoie alors faux).

**Correction.** Deux options, Ã  trancher explicitement : (a) refuser de persister le refresh_token quand safeStorage.isEncryptionAvailable() est faux â€” le joueur se reconnecte Ã  chaque dÃ©marrage, et le launcher le lui dit ; (b) garder le repli mais dÃ©river la clÃ© d'un secret rÃ©ellement inaccessible (mot de passe demandÃ© au joueur, ou fichier de clÃ© hors du dossier du coffre avec ACL restreinte), et reformuler l'avertissement pour dire que ce mode ne protÃ¨ge contre RIEN d'autre qu'un coup d'Å“il. Dans les deux cas, garantir que safeStorage n'est interrogÃ© qu'aprÃ¨s app.whenReady() pour ne pas retomber sur le repli par accident.

### M21 — `launcher/src/assets/js/panels/home.js` : 632  _[fidelite-maquette]_

**Constat.** Le personnage de l'accueil est un rendu de TÃŠTE carrÃ©, pas un personnage en pied comme dans la maquette.

**Symptôme.** paintPlayer() fait `headDataUrl(account.skin_url, 256)` et pose le rÃ©sultat dans `[data-el="character"]`. utils/skin.js (drawHead, lignes 69-88) ne dessine QUE la face 8Ã—8 + le calque chapeau dans un canevas CARRÃ‰. panels/home.css:383-395 impose `height:404px; width:auto` : le carrÃ© 256Ã—256 est donc Ã©tirÃ© en 404Ã—404. Si l'utilisateur se connecte avec un skin, il voit un cube de tÃªte de 404 px de cÃ´tÃ© flotter en bas Ã  droite (avec opmFloat et le drop-shadow), lÃ  oÃ¹ la maquette (ligne 179) affiche `melodia.webp`, un rendu en pied de 404 px de haut pour environ 330 px de large. La scÃ¨ne est visuellement dÃ©truite : la tÃªte dÃ©borde vers la gauche sur la carte du journal et l'identitÃ© Â« VOTRE PERSONNAGE Â» passe derriÃ¨re.

**Correction.** Ne pas utiliser headDataUrl() pour `.opm-scene__char`. Ajouter dans utils/skin.js un rendu corps entier (composition des faces tÃªte/torse/bras/jambes du skin, ratio 16Ã—32 unitÃ©s â†’ 202Ã—404 px), ou consommer une URL de rendu corps entier fournie par le serveur de textures. headDataUrl() doit rester rÃ©servÃ© aux avatars carrÃ©s : barre du bas (46 px), popover (32 px), cartes de comptes (56 px), tÃªte Microsoft (48 px).

### M22 — `launcher/src/assets/js/panels/home.js` : 41  _[fausse-donnee]_

**Constat.** Le personnage par dÃ©faut de l'accueil est melodia.webp, la donnÃ©e de dÃ©monstration de la maquette.

**Symptôme.** `const DEFAULT_CHARACTER = new URL('../../images/melodia.webp', import.meta.url).href` et son usage ligne 626 : dÃ¨s qu'un compte n'a pas de `skin_url` (cas de tout compte fraÃ®chement crÃ©Ã©, ou de tout Ã©chec de rendu), le launcher affiche MÃ©lodia â€” le personnage nommÃ© de la maquette â€” sous le libellÃ© Â« VOTRE PERSONNAGE Â». Le joueur voit donc l'avatar de quelqu'un d'autre prÃ©sentÃ© comme le sien. Le balisage, lui, dÃ©clare bien `silhouette.png` (panels/home.html:140) : le JS le contredit dÃ¨s le premier paintPlayer().

**Correction.** Remplacer par `new URL('../../images/silhouette.png', import.meta.url).href`, la silhouette neutre 644Ã—790 dÃ©jÃ  prÃ©sente dans assets/images/, et qui est ce que le balisage annonce.

### M23 — `launcher/src/panels/home.html` : 140  _[fidelite-maquette]_

**Constat.** Chemin d'image faux : le personnage de l'accueil est une image cassÃ©e au premier rendu.

**Symptôme.** `src="../assets/images/silhouette.png"`. Le fragment est injectÃ© par innerHTML dans le document hÃ´te, qui est `src/launcher.html` (windows/mainWindow.js:117 : `win.loadFile(path.join(__dirname, '..', 'launcher.html'))`), pas `src/windows/launcher.html` comme l'affirme le commentaire de la ligne 5. L'URL relative se rÃ©sout donc en `<racine du launcher>/assets/images/silhouette.png`, qui n'existe pas : Ã  chaque ouverture de l'onglet ACCUEIL, l'utilisateur voit l'icÃ´ne d'image cassÃ©e Ã  la place du personnage, jusqu'Ã  ce que paintPlayer() Ã©crase le src. panels/settings.html:117 et 157 utilisent la bonne forme (`assets/images/steve.png`, sans `../`).

**Correction.** Ã‰crire `src="assets/images/silhouette.png"` et corriger le commentaire de la ligne 5 : le document hÃ´te est `src/launcher.html`, voisin de `panels/`, d'oÃ¹ le prÃ©fixe Â« assets/ Â» (formulation dÃ©jÃ  correcte dans panels/settings.html lignes 4-5).

### M24 — `launcher/src/assets/css/components/feedback.css` : 85  _[ecart-visuel]_

**Constat.** Les squelettes de chargement posÃ©s sur les surfaces sombres gardent la palette claire.

**Symptôme.** La palette sombre du squelette n'est dÃ©clenchÃ©e que par `.opm-card--dark` ou `.opm-popover`. Or aucune des surfaces sombres qui portent des squelettes ne possÃ¨de ces classes : `.opm-donors` (panels/donation.html:131, fond --veil-86), `.opm-scene__id` (panels/home.html:144-145, posÃ© sur la vidÃ©o), `.opm-settings__files` (panels/settings.html:86, fond --veil-60), et `.opm-give__proj` (panels/donation.html:61, encart --ink sur carte aqua). RÃ©sultat : au dÃ©marrage et Ã  chaque ouverture de l'onglet DONATION, l'utilisateur voit des pavÃ©s vert pÃ¢le #DFF1EE avec une bande blanche Ã  55 % clignoter sur un fond quasi noir â€” trois lignes de donateurs, le compteur de donateurs, le pseudo et le sous-titre du personnage, l'encart d'Ã©tat des fichiers. La maquette n'a rien de clair Ã  ces endroits.

**Correction.** Ajouter aux sÃ©lecteurs de la rÃ¨gle `.opm-card--dark .opm-skeleton, .opm-popover .opm-skeleton` (feedback.css:85-89) les quatre porteurs de squelette sur fond sombre : `.opm-donors .opm-skeleton`, `.opm-scene__id .opm-skeleton`, `.opm-settings__files .opm-skeleton`, `.opm-give__proj.opm-skeleton`.

### M25 — `launcher/src/assets/css/components/overlay.css` : 140  _[ecart-visuel]_

**Constat.** Le popover des comptes met le sous-titre Ã  droite du pseudo au lieu de l'empiler dessous, et ne marque pas le compte courant.

**Symptôme.** Deux Ã©carts. (a) Maquette lignes 495-499 : `[avatar 32] [ pseudo / Â« Compte principal Â» empilÃ©s, flex:1 ] [pastille aqua 7 px]`. Launcher : `.opm-popover .opm-account__name { flex:1 }` (overlay.css:127) et `.opm-popover .opm-account__meta { flex:none }` (overlay.css:140) sur un balisage plat (launcher.html:217-219) donnent `[avatar][pseudo ........][meta]` sur une seule ligne â€” le libellÃ© Â« Compte principal Â» se retrouve collÃ© au bord droit du popover. (b) panels/bottombar.js:830 pose `aria-current="true"` sur l'entrÃ©e du compte sÃ©lectionnÃ©, mais aucune rÃ¨gle CSS du projet ne cible `[aria-current]` (vÃ©rifiÃ© : zÃ©ro occurrence dans assets/css/). Si l'utilisateur ouvre le menu avec trois comptes, rien ne lui indique lequel est actif : la pastille aqua de la maquette est purement absente. (c) accessoirement, `.opm-account__name` conserve `display:flex` de panels/settings.css:229 (la rÃ¨gle du popover ne redÃ©clare pas `display`), donc son `text-overflow:ellipsis` est inopÃ©rant : un pseudo long est coupÃ© net, sans points de suspension.

**Correction.** Envelopper pseudo et meta dans un `.opm-account__body` (comme le fait dÃ©jÃ  panels/settings.html:118) ou passer `.opm-popover .opm-popover__item` en grille `auto 1fr auto` avec `.opm-account__name` en (1,2) et `.opm-account__meta` en (2,2) ; ajouter un `<span class="opm-account__dot">` dans le gabarit launcher.html:215-220, masquÃ© par dÃ©faut et rÃ©vÃ©lÃ© par `.opm-popover__item[aria-current="true"] .opm-account__dot { display:block }` (7 px, border-radius 50 %, background var(--aqua)) ; et redÃ©clarer `display:block` sur `.opm-popover .opm-account__name` pour rÃ©tablir l'ellipse.

### M26 — `launcher/src/assets/js/panels/home.js` : 645  _[fidelite-maquette]_

**Constat.** Le sous-titre RP du personnage de la maquette (faction Â· Ã©quipage Â· Ã®les tenues) n'est jamais affichÃ©.

**Symptôme.** La maquette (ligne 184) affiche sous le pseudo : Â« Pirate Â· Ã‰quipage des CÅ“urs BrisÃ©s Â· 3 Ã®les tenues Â», et le contexte de passe Â§1 dÃ©signe explicitement `users.faction`, `equipages` et `iles` comme la source de cette ligne. `playerSub()` ne renvoie que quatre chaÃ®nes possibles : un motif de blocage, Â« Pseudo en jeu Â· <nom> Â», Â« Compte One Piece Minecraft Â», ou Â« Aucun compte connectÃ© Â». Un joueur qui joue normalement voit donc Â« Pseudo en jeu Â· Melodia Â» â€” une redondance avec le pseudo affichÃ© juste au-dessus â€” au lieu de son identitÃ© RP. L'emplacement le plus caractÃ©ristique de l'Ã©cran d'accueil est vide de sa substance.

**Correction.** Construire le sous-titre Ã  partir des champs RP rÃ©els du compte : `[faction, equipage?.nom ? `Ã‰quipage ${equipage.nom}` : null, iles_tenues > 0 ? `${nf(iles_tenues)} ${plural(iles_tenues,'Ã®le tenue','Ã®les tenues')}` : null].filter(Boolean).join(' Â· ')`, et ne retomber sur le message actuel que si aucun de ces champs n'est renseignÃ©. Conserver la prioritÃ© au motif de blocage quand `can_play === false`.

---

## MINEURS

### M1 — `auth-server/opm_auth/services/users.py` : 336  _[incohÃ©rence de lecture]_

**Constat.** Deux comptages d'Ã®les tenues coexistent avec des rÃ¨gles de correspondance diffÃ©rentes.

**Symptôme.** `services/users.count_iles_tenues` joint sur `Equipage.nom == name` â€” comparaison exacte, sensible Ã  la casse et aux espaces. `routers/launcher._load_iles_tenues` (launcher.py:406-411) joint sur `func.lower(func.trim(Equipage.nom)) == needle`. Le premier alimente `/auth/me`, `/auth/login`, `/auth/register` et toutes les rÃ©ponses de `/link/microsoft/*` ; le second alimente `/profile/rp`. Si `users.equipage` vaut Â« les cÅ“urs brisÃ©s Â» lÃ  oÃ¹ `equipages.nom` vaut Â« Les CÅ“urs BrisÃ©s Â», l'accueil affiche Â« 0 Ã®le tenue Â» dans le bandeau du compte et Â« 3 Ã®les tenues Â» dans le volet PERSONNAGE, sur le mÃªme Ã©cran.

**Correction.** Faire de `services/users.count_iles_tenues` la seule implÃ©mentation, avec la normalisation la plus tolÃ©rante (`func.lower(func.trim(...))`), et faire appeler cette fonction par `routers/launcher._load_iles_tenues`, qui ne garde alors que le cache.

### M2 — `auth-server/opm_auth/models.py` : 963  _[modÃ¨le / migration divergents]_

**Constat.** Deux clÃ©s Ã©trangÃ¨res dÃ©clarent un `ondelete` dans la migration mais pas dans le modÃ¨le : le schÃ©ma crÃ©Ã© en dÃ©veloppement diffÃ¨re de celui de production.

**Symptôme.** `UserTexture.texture_id` est dÃ©clarÃ© `ForeignKey("texture.id")` sans `ondelete` (models.py:963-965) alors que la migration pose `ondelete="SET NULL"` (0001_launcher_auth.py:404-409) ; mÃªme Ã©cart sur `RefreshToken.replaced_by` (models.py:720-722 contre migration:220-225). En dÃ©veloppement, `init_models()` construit le schÃ©ma depuis le modÃ¨le : les contraintes y sont en `NO ACTION`. Un scÃ©nario qui passe en production (suppression d'une texture orpheline, purge de jetons) peut donc Ã©chouer sur `IntegrityError` en dÃ©veloppement, ou l'inverse â€” un bogue qui ne se reproduit que d'un cÃ´tÃ©.

**Correction.** Aligner les modÃ¨les sur la migration : `ForeignKey("texture.id", ondelete="SET NULL")` et `ForeignKey("auth_refresh_token.id", ondelete="SET NULL")`.

### M3 — `auth-server/pyproject.toml` : 43  _[dÃ©pendance obsolÃ¨te]_

**Constat.** `argon2-cffi` est encore dÃ©clarÃ©, commentÃ© Â« hachage des mots de passe (Argon2id) Â», et `slowapi` est dÃ©clarÃ© sans Ãªtre utilisÃ©.

**Symptôme.** Aucun module de `opm_auth/` n'importe `argon2` ni `slowapi` (la limitation de dÃ©bit est Ã©crite Ã  la main dans `security/ratelimit.py`). Les laisser installe deux paquets inutiles, alourdit l'image Docker et â€” plus gÃªnant â€” laisse croire au relecteur suivant que les mots de passe sont en Argon2id, ce que DATA.md Â§3 interdit formellement puisque le site ne saurait plus les vÃ©rifier. MÃªme problÃ¨me dans `requirements.txt`.

**Correction.** Retirer `argon2-cffi` et `slowapi` de `[project].dependencies` dans `pyproject.toml` et des lignes correspondantes de `requirements.txt`.

### M4 — `auth-server/opm_auth/__init__.py` : 11  _[documentation contredisant le contrat]_

**Constat.** Deux docstrings annoncent encore un hachage Argon2id.

**Symptôme.** `opm_auth/__init__.py:11` : Â« Le joueur possÃ¨de un compte OPM (e-mail + mot de passe Argon2id + TOTP facultatif) Â». `opm_auth/security/__init__.py:5` : Â« :mod:`passwords` â€” hachage Argon2id et politique de robustesse Â». Ce sont les deux premiÃ¨res docstrings que lit quelqu'un qui dÃ©couvre le paquet, et elles disent l'exact contraire de la rÃ¨gle structurante de cette passe (DATA.md Â§3, expliquÃ©e en dÃ©tail en tÃªte de `security/passwords.py`). Le risque n'est pas cosmÃ©tique : c'est ainsi qu'un futur contributeur rÃ©introduit Argon2id et coupe l'accÃ¨s au site Ã  tous les joueurs.

**Correction.** Remplacer par Â« mot de passe au format Werkzeug (pbkdf2:sha256), partagÃ© avec le site Flask Â» dans `opm_auth/__init__.py`, et par Â« :mod:`passwords` â€” vÃ©rification et Ã©criture du format Werkzeug (pbkdf2/scrypt) et politique de robustesse Â» dans `opm_auth/security/__init__.py`.

### M5 — `auth-server/opm_auth/config.py` : 338  _[amorÃ§age impossible]_

**Constat.** En production, la validation de configuration exige les fichiers de clÃ©s, mais la commande qui les gÃ©nÃ¨re commence par valider la configuration.

**Symptôme.** `_check_production` (lignes 338-345) ajoute un problÃ¨me bloquant pour chaque fichier de clÃ© absent. Sur une installation neuve avec `OPM_ENV=prod`, les quatre fichiers n'existent pas encore. `opm_auth/cli.py:820` appelle `get_settings()` avant de dispatcher : `opm-auth keygen` sort donc sur Â« Configuration invalide â€¦ fichier de clÃ© introuvable Â», sans jamais gÃ©nÃ©rer les clÃ©s. `create_app()` Ã©choue pour la mÃªme raison, et `ensure_keys()` â€” qui les fabriquerait â€” ne tourne que dans le `lifespan`, donc aprÃ¨s. L'exploitant doit deviner qu'il faut lancer keygen avec `OPM_ENV=dev` pour amorcer sa production.

**Correction.** Exempter `keygen` de la validation dans `cli.main()` : ne l'appeler que pour les autres commandes, ou attraper l'Ã©chec et poursuivre lorsque `args.command == "keygen"`. Alternative : dans `_check_production`, ne signaler l'absence des fichiers de clÃ©s qu'en avertissement, `ensure_keys()` les crÃ©ant de toute faÃ§on au dÃ©marrage.

### M6 — `auth-server/opm_auth/security/__init__.py` : 5  _[documentation mensongere]_

**Constat.** Trois docstrings affirment encore un hachage Argon2id qui n'existe pas dans le code.

**Symptôme.** security/__init__.py:5 (Â« :mod:`passwords` â€” hachage Argon2id et politique de robustesse Â»), totp.py:13 (Â« stockes **haches** (Argon2id) Â») et totp.py:146 (Â« :ivar hashes: empreintes Argon2id a stocker en base Â»). Or totp.py:26 importe hash_secret depuis passwords, qui produit du pbkdf2:sha256:50000 au format Werkzeug. Un mainteneur qui audite la 2FA en lisant ces docstrings conclut a tort que les codes de secours sont proteges par Argon2id et ne verra pas que leur cout de derivation est de 50 000 iterations.

**Correction.** Remplacer les trois mentions par Â« PBKDF2-HMAC-SHA256 au format Werkzeug Â» ; pour totp.py:146, preciser Â« empreintes pbkdf2:sha256:50000 (voir SECRET_ITERATIONS) Â».

### M7 — `auth-server/opm_auth/schemas.py` : 67  _[compatibilite site]_

**Constat.** Password (verification) est plafonne a 128 caracteres, alors que le site Flask n'impose aucune limite haute a l'inscription.

**Symptôme.** Password = Annotated[str, StringConstraints(min_length=1, max_length=128)] s'applique a LoginIn et a toutes les routes qui redemandent le mot de passe. Un joueur qui a cree son compte sur le site avec une phrase de passe de 140 caracteres (Werkzeug l'accepte et l'a hachee sans probleme) recoit un 422 de validation au lieu de se connecter : il est definitivement bloque hors du launcher alors que ses identifiants sont valides. passwords.py accepte pourtant jusqu'a _HARD_LENGTH_LIMIT = 1024.

**Correction.** Dissocier les deux plafonds : garder max_length=128 sur NewPassword (schemas.py:70, politique d'ecriture) et porter Password a 1024 pour coller a _HARD_LENGTH_LIMIT, la borne anti-DoS reelle.

### M8 — `auth-server/opm_auth/services/yggdrasil.py` : 686  _[ecart au contrat DATA.md Â§3]_

**Constat.** La connexion Yggdrasil utilise verify_password et non verify_and_update : aucun renforcement d'empreinte sur ce chemin.

**Symptôme.** yggdrasil.py:686 et 776 verifient le mot de passe sans jamais reecrire l'empreinte. DATA.md Â§3 dit Â« a chaque connexion reussie, si le hachage a moins de 600000 iterations [...] on le reecrit Â». Un joueur qui lance toujours le jeu par le launcher en mode Yggdrasil et ne repasse jamais par POST /auth/login garde indefiniment ses 260 000 iterations : le durcissement du parc ne se fera jamais pour lui.

**Correction.** Trancher explicitement et le documenter : soit appeler verify_and_update et persister user.password_hash ici aussi (troisieme ecriture dans users, a ajouter a la liste de DATA.md Â§4), soit ecrire dans le docstring de yggdrasil.py:47 que le renforcement est volontairement reserve au chemin /api pour respecter la limitation d'ecriture Â§4. En l'etat le code contredit silencieusement le document.

### M9 — `auth-server/opm_auth/schemas.py` : 70  _[configuration incoherente]_

**Constat.** La longueur minimale de 12 est codee en dur dans NewPassword alors que OPM_PASSWORD_MIN_LENGTH est declare configurable de 8 a 128.

**Symptôme.** config.py:126 autorise password_min_length entre 8 et 128 et passwords.py:625 le lit, mais schemas.py:70 impose min_length=12 dans le modele Pydantic. Si l'exploitant fixe OPM_PASSWORD_MIN_LENGTH=8, une inscription a 10 caracteres est rejetee par Pydantic avec un 422 de validation anglais au lieu de l'erreur documentee weak_password / details.reasons en francais que le launcher sait afficher : le joueur voit un message brut et le reglage n'a aucun effet.

**Correction.** Retirer la contrainte min_length de NewPassword (garder max_length) et laisser check_password_strength seul juge de la longueur minimale, ou construire la contrainte a partir de get_settings().password_min_length.

### M10 — `auth-server/opm_auth/services/users.py` : 696  _[travail inutile]_

**Constat.** Le rehash de 600 000 iterations est calcule avant le controle TOTP et jete si le second facteur manque ou est faux.

**Symptôme.** verify_and_update() calcule refreshed_hash des la ligne 696, mais l'affectation user.password_hash = refreshed_hash n'a lieu qu'a la ligne 742, apres le bloc TOTP. Pour un compte 2FA encore en 260 000 iterations, chaque tentative se soldant par totp_required ou totp_invalid consomme 0,43 s de derivation pour rien â€” et bloque la boucle d'autant (voir la constatation sur asyncio.to_thread).

**Correction.** Scinder : appeler verify_password() d'abord, puis, une fois le second facteur valide, needs_rehash() + hash_password() juste avant l'affectation ligne 742. Le budget de temps constant recommande plus haut absorbe la variation de duree ainsi introduite.

### M11 — `launcher/src/panels/home.html` : 140  _[chemin d'asset]_

**Constat.** `src="../assets/images/silhouette.png"` : le fragment est injectÃ© dans src/launcher.html, le chemin doit Ãªtre `assets/â€¦`.

**Symptôme.** Le commentaire d'en-tÃªte de home.html affirme que le document hÃ´te est Â« src/windows/launcher.html Â», ce qui est faux : launcher.html est Ã  src/launcher.html (mainWindow.js:117 le charge depuis path.join(__dirname,'..','launcher.html')). Le `../assets/images/silhouette.png` rÃ©sout donc vers launcher/assets/images/silhouette.png, qui n'existe pas â€” le fichier est Ã  launcher/src/assets/images/silhouette.png. L'image du personnage part en 404 Ã  chaque injection du panneau (icÃ´ne cassÃ©e le temps que home.js:626 remplace le src). settings.html:117 et :157, eux, utilisent la forme correcte `assets/images/steve.png`.

**Correction.** Remplacer par `src="assets/images/silhouette.png"` et corriger le commentaire d'en-tÃªte de home.html (et de donation.html, qui rÃ©pÃ¨te la mÃªme affirmation) : le document hÃ´te est src/launcher.html.

### M12 — `launcher/src/panels/donation.html` : 96  _[CSP]_

**Constat.** Deux attributs `style="width:0%"` sont bloquÃ©s par `style-src 'self'` (pas de 'unsafe-inline').

**Symptôme.** La CSP de launcher.html:6 dÃ©clare `style-src 'self'` sans 'unsafe-inline' : Chromium refuse les attributs `style` posÃ©s dans le balisage. Les lignes 96 et 97 de donation.html ([data-el="goal-fill"] et [data-el="goal-ghost"]) dÃ©clenchent donc deux violations CSP dans la console Ã  chaque ouverture de l'onglet DONATION, et les deux barres n'ont pas de largeur initiale tant que donation.js:244 / :365 ne les a pas posÃ©es par CSSOM (ce qui, lui, est autorisÃ©). Ce sont les deux seuls attributs style de tout le balisage.

**Correction.** Retirer les deux `style="width:0%"` et poser la largeur nulle dans assets/css/panels/donation.css (`.opm-goal__fill, .opm-goal__ghost { width: 0 }`) â€” le JS la remplacera ensuite par CSSOM comme aujourd'hui.

### M13 — `launcher/src/preload.js` : 165  _[surface IPC sans interface]_

**Constat.** Cinq mÃ©thodes du contrat n'ont aucun point d'appel : totpSetup, totpEnable, totpDisable, game.cancel, game.verifyFiles.

**Symptôme.** Aucun `data-action` de settings.html ni de launcher.html ne mÃ¨ne Ã  ces cinq mÃ©thodes (vÃ©rifiÃ© sur l'ensemble des appels window.opm.* du renderer). ConsÃ©quences concrÃ¨tes : un joueur dont la 2FA est active peut se connecter (vue `totp` de l'Ã©cran de connexion) mais ne peut ni l'activer ni la dÃ©sactiver depuis le launcher ; un tÃ©lÃ©chargement de mise Ã  jour du jeu ne peut pas Ãªtre annulÃ© alors que game.cancel() est implÃ©mentÃ© et fonctionnel (game.js:853) ; et Â« vÃ©rifier les fichiers Â» n'est proposÃ© nulle part alors que verifyFiles() existe (game.js:883) et que l'encart Â« Ã‰TAT DES FICHIERS Â» des paramÃ¨tres invite Ã  le faire.

**Correction.** Soit ajouter les commandes manquantes au balisage â€” un bloc Â« Double authentification Â» dans ParamÃ¨tres â†’ Comptes, un bouton Â« VÃ‰RIFIER LES FICHIERS Â» sous l'encart Ã‰TAT DES FICHIERS, et un bouton d'annulation sur la barre du bas pendant la phase `busy` â€” soit acter leur retrait dans docs/IPC.md. Ne pas laisser cinq canaux enregistrÃ©s que personne n'appelle.

### M14 — `launcher/src/main/auth/api.js` : 313  _[paramÃ¨tre d'API omis]_

**Constat.** bootstrap() n'envoie pas `?platform=` : sur macOS et Linux, le serveur renvoie l'URL de tÃ©lÃ©chargement Windows.

**Symptôme.** opm_auth/routers/launcher.py:464 (_platform_of) documente explicitement que Â« le launcher Electron annonce OPMLauncher/<version> sans mention de systÃ¨me : c'est bien ?platform= qu'il doit passer Â», et retombe sinon sur le reniflage d'User-Agent puis sur Windows. api.js:100 construit prÃ©cisÃ©ment un User-Agent sans plateforme et api.bootstrap() n'ajoute aucun paramÃ¨tre. Un joueur macOS ou Linux reÃ§oit donc `launcher.download_url` pointant sur statistiques.launcher_windows.

**Correction.** Dans api.js, `function bootstrap() { return request('GET', `${API}/bootstrap`, { query: { platform: process.platform === 'darwin' ? 'mac' : process.platform === 'linux' ? 'linux' : 'windows' } }); }` â€” en alignant les valeurs sur l'Ã©numÃ©ration Platform de opm_auth/routers/launcher.py.

### M15 — `launcher/src/main/ipc.js` : 33  _[contrat non tenu]_

**Constat.** `app:panel` accepte 'login' alors que src/panels/login.html n'existe pas.

**Symptôme.** La constante PANELS autorise 'login' (conformÃ©ment Ã  docs/IPC.md, qui type `panel(name: 'home'|'settings'|'donation'|'login')`), mais le dossier src/panels/ ne contient que donation.html, home.html et settings.html â€” le balisage de la connexion vit dans launcher.html. Tout appel Ã  `window.opm.app.panel('login')` Ã©chouerait en `panel_unreadable`. Personne ne l'appelle aujourd'hui, mais le contrat promet une chose que le disque ne tient pas.

**Correction.** Retirer 'login' de la constante PANELS de ipc.js et de la signature de `app.panel()` dans docs/IPC.md, en prÃ©cisant que l'Ã©cran de connexion est dÃ©jÃ  prÃ©sent dans launcher.html.

### M16 — `auth-server/opm_auth/security/ratelimit.py` : 341  _[limitation de debit]_

**Constat.** RedisRateLimiter.hit laisse passer toutes les requÃªtes quand Redis est injoignable (fail-open) : couper Redis suffit Ã  dÃ©sactiver la protection anti-force-brute.

**Symptôme.** Le `except Exception` retourne RateLimitResult(True, ...). Un attaquant qui sature ou fait tomber Redis (ou attend simplement une panne) obtient des tentatives de connexion illimitÃ©es sur /auth/login et /yggdrasil/authserver/authenticate, sans que rien ne bloque. Le service reste debout mais nu.

**Correction.** SÃ©parer les cas : fail-open acceptable pour les rÃ¨gles de confort (donations.checkout, game.session), fail-closed pour les rÃ¨gles d'authentification. Ajouter un attribut `fail_open: bool` Ã  Rule (faux pour auth.login.*, auth.register.ip, auth.password.*, yggdrasil.authenticate.ip, link.microsoft.*) et, en cas d'exception Redis, lever _too_many() avec un Retry-After court plutÃ´t que d'autoriser.

### M17 — `auth-server/opm_auth/services/users.py` : 908  _[concurrence]_

**Constat.** rotate_session lit la ligne auth_refresh_token sans verrou : deux prÃ©sentations simultanÃ©es du mÃªme refresh_token sont toutes deux acceptÃ©es et le rejeu n'est pas dÃ©tectÃ©.

**Symptôme.** Le SELECT ligne 908 n'a pas de FOR UPDATE. Deux requÃªtes POST /auth/refresh envoyÃ©es en parallÃ¨le avec le mÃªme jeton voient toutes deux revoked_at = NULL et replaced_by = NULL, passent le verdict ACCEPTED, insÃ¨rent chacune un successeur dans la mÃªme famille et Ã©crasent record.revoked_at/replaced_by. RÃ©sultat : un attaquant qui a volÃ© un refresh_token et le rejoue au mÃªme instant que le client lÃ©gitime obtient une session valide sans dÃ©clencher la rÃ©vocation de famille â€” c'est exactement le scÃ©nario que la rotation est censÃ©e dÃ©tecter.

**Correction.** Lire la ligne avec un verrou : `select(RefreshToken).where(RefreshToken.token_hash == ...).with_for_update()` et conserver la transaction ouverte jusqu'au commit final. Sur SQLite (tests), with_for_update est ignorÃ© sans erreur, la suite de tests reste valable.

### M18 — `auth-server/opm_auth/services/users.py` : 599  _[double authentification]_

**Constat.** Aucun anti-rejeu sur les codes TOTP : un code interceptÃ© reste utilisable pendant les 90 secondes de la fenÃªtre de tolÃ©rance.

**Symptôme.** _consume_second_factor appelle verify_totp(secret, code) et jette le rÃ©sultat de l'Ã©tape. security/totp.py:106 expose pourtant verify_totp_step, qui retourne le pas horaire acceptÃ© â€” signe que l'anti-rejeu Ã©tait prÃ©vu, mais la table auth_totp (models.py:732) n'a pas de colonne pour le mÃ©moriser. Avec VALID_WINDOW = 1, un code hameÃ§onnÃ© ou lu par-dessus l'Ã©paule vaut trois pas de 30 s : l'attaquant qui connaÃ®t dÃ©jÃ  le mot de passe se connecte avec le mÃªme code que le joueur lÃ©gitime, dans la mÃªme minute et demie. La rÃ¨gle auth.totp.account (10 essais / 5 min) n'empÃªche rien puisqu'il s'agit du bon code.

**Correction.** Ajouter une colonne `last_step: Mapped[int | None]` Ã  Totp (migration additive, table du launcher), utiliser verify_totp_step au lieu de verify_totp, refuser tout pas infÃ©rieur ou Ã©gal Ã  last_step, puis l'Ã©crire dans la mÃªme transaction.

### M19 — `auth-server/opm_auth/main.py` : 726  _[configuration]_

**Constat.** CORS est montÃ© avec allow_credentials=True Ã  partir d'une liste d'origines jamais validÃ©e : une entrÃ©e Â« * Â» dans OPM_CORS_ORIGINS ouvre l'API Ã  tous les sites.

**Symptôme.** cors_origins_list se contente d'un _split_csv (config.py:541) sans rejeter le joker. Avec allow_origins=["*"] et allow_credentials=True, CORSMiddleware renvoie l'origine de l'appelant dans Access-Control-Allow-Origin accompagnÃ©e de Access-Control-Allow-Credentials: true : n'importe quelle page web peut alors appeler /api/v1/* depuis le navigateur d'un joueur. Une simple faute de frappe dans le .env de production suffit, et rien ne l'empÃªche au dÃ©marrage alors que _check_production refuse dÃ©jÃ  bien d'autres approximations.

**Correction.** Ajouter dans _check_production : si "*" figure dans cors_origins_list, ajouter un problÃ¨me et refuser le dÃ©marrage. Et dans _install_middlewares, ne poser allow_credentials=True que pour une liste d'origines explicites.

### M20 — `launcher/src/main/auth/accounts.js` : 867  _[journalisation]_

**Constat.** Le user_code du flux Â« device Â» est Ã©crit en clair dans launcher.log, oÃ¹ les rÃ¨gles de masquage ne l'attrapent pas.

**Symptôme.** La ligne journalise Â« saisissez le code XXXX-XXXX Â». Les rÃ¨gles de logger.js ne masquent que les valeurs d'au moins 8 caractÃ¨res prÃ©cÃ©dÃ©es d'un sÃ©parateur = ou : ; Â« le code ABCD-EFGH Â» passe entre les mailles. Quiconque lit launcher.log pendant les quelques minutes de validitÃ© (support technique Ã  qui le joueur envoie son journal, maliciel, dossier partagÃ©) peut saisir ce code sur microsoft.com/link avec SON propre compte Microsoft : le rattachement se conclut alors sur le compte OPM du joueur avec l'identitÃ© Minecraft de l'attaquant.

**Correction.** Ne pas journaliser le code. Le contrat IPC n'ayant pas de canal dÃ©diÃ©, ouvrir simplement verification_uri et Ã©crire Â« saisissez le code affichÃ© dans le launcher Â» ; si le code doit rester visible, ajouter une rÃ¨gle de masquage `/\bcode\s+[A-Z0-9]{4,}(-[A-Z0-9]{4,})?\b/gi` dans logger.js et faire remonter le code au renderer plutÃ´t qu'au fichier.

### M21 — `launcher/src/assets/js/panels/donation.js` : 300  _[ecart-visuel]_

**Constat.** L'Ã©tiquette des paliers inverse l'ordre de la maquette et remplace le pourcentage par un montant.

**Symptôme.** `setText($('[data-bind="tier-tag"]', card), `${state.label}${amount}`)` avec `amount = ' Â· ' + euros(threshold)` (ligne 299) produit Â« DÃ‰BLOQUÃ‰ Â· 50 â‚¬ Â». La maquette (lignes 431, 436, 441, 446) Ã©crit Â« 25 % Â· DÃ‰BLOQUÃ‰ Â», Â« 50 % Â· Ã€ PORTÃ‰E Â», etc. : c'est le pourcentage qui ouvre la ligne, et le montant n'apparaÃ®t jamais. L'utilisateur ne peut plus lire les quatre paliers comme une Ã©chelle 25/50/75/100 % alignÃ©e sur la jauge et ses trois repÃ¨res juste au-dessus.

**Correction.** Composer `${pct(threshold, goal)} Â· ${state.label}` (le seuil rapportÃ© Ã  l'objectif), en repli sur `${pct(TIER_SHARES[index])} Â· ${state.label}` quand `goal <= 0`.

### M22 — `launcher/src/assets/js/panels/donation.js` : 237  _[ecart-visuel]_

**Constat.** La ligne Â« 58 â‚¬ restants Â· 11 jours Â» de la maquette perd sa moitiÃ© montant.

**Symptôme.** `this.bind(this.el.remaining, ...)` n'Ã©crit que Â« N jours restants Â». La maquette (ligne 417) affiche Â« 58 â‚¬ restants Â· 11 jours Â» : le reste Ã  rÃ©unir en euros ET l'Ã©chÃ©ance. L'utilisateur qui regarde la carte objectif ne voit nulle part combien il manque en valeur absolue â€” seuls le collectÃ©, l'objectif et le pourcentage sont lÃ .

**Correction.** Composer `[goal > collected ? `${euros(goal - collected)} restants` : null, days === null ? null : (days > 0 ? `${nf(days)} ${plural(days,'jour','jours')}` : 'dernier jour')].filter(Boolean).join(' Â· ')`.

### M23 — `launcher/src/assets/css/layout/bottombar.css` : 61  _[ecart-visuel]_

**Constat.** Le fond des vignettes d'avatar n'est pas la teinte de la maquette.

**Symptôme.** `background-color: var(--ink)` (#0F1A19) sur `.opm-bottom__avatar`, et idem `.opm-popover .opm-account__avatar` (components/overlay.css:117). La maquette utilise #12211F pour ces deux vignettes (lignes 496, 501, 512) â€” une encre lÃ©gÃ¨rement plus verte, choisie pour se dÃ©tacher du voile de la barre du bas. Pendant le rendu du skin (aller-retour canevas), le carrÃ© 46 Ã— 46 se fond dans la barre au lieu de se lire comme un cadre. Le rayon diffÃ¨re aussi : 8 px dans la maquette, `var(--r-md)` = 7 px ici.

**Correction.** Ajouter un jeton `--slot: #12211F;` dans base/tokens.css (famille sombre) et l'employer sur `.opm-bottom__avatar` et `.opm-popover .opm-account__avatar`. Si le rayon 8 px doit Ãªtre respectÃ© Ã  l'identique, ajouter Ã©galement `--r-lg-alt: 8px` plutÃ´t que de laisser 7.

### M24 — `launcher/src/assets/css/base/tokens.css` : 108  _[ecart-visuel]_

**Constat.** Le jeton --r-2xl (rayon de fenÃªtre, 14 px) est dÃ©clarÃ© mais jamais employÃ© : la fenÃªtre n'a ni coins arrondis ni liserÃ©.

**Symptôme.** La maquette encadre l'application dans `border-radius:14px; border:1px solid rgba(145,217,209,.2)` (ligne 34). Aucune rÃ¨gle du projet n'applique `--r-2xl` (vÃ©rifiÃ© : une seule occurrence, sa dÃ©claration). En revanche `.opm-titlebar__winbtn--close` conserve `border-radius: 0 12px 0 0` (layout/titlebar.css:180) : au survol, le bouton de fermeture peint un coin haut-droit arrondi de 12 px contre un angle de fenÃªtre parfaitement carrÃ©, ce qui laisse deux triangles rouges tronquÃ©s visibles.

**Correction.** Soit poser `border-radius: var(--r-2xl); border: 1px solid var(--line-dark);` sur `.opm-app` (avec `transparent:true` / `roundedCorners` cÃ´tÃ© windows/mainWindow.js pour que la dÃ©coupe soit rÃ©elle), soit ramener `.opm-titlebar__winbtn--close` Ã  `border-radius: 0` et retirer le jeton --r-2xl.

### M25 — `launcher/src/panels/donation.html` : 96  _[conformite]_

**Constat.** Deux attributs style= en dur violent la CSP dÃ©clarÃ©e et n'apportent rien.

**Symptôme.** `style="width:0%"` sur `.opm-goal__fill` (ligne 96) et `.opm-goal__ghost` (ligne 97). La CSP de launcher.html:6 est `style-src 'self'` sans `'unsafe-inline'` : Chromium refuse ces attributs et journalise une violation Ã  chaque injection du panneau DONATION. La valeur est de toute faÃ§on inutile â€” l'Ã©lÃ©ment est en `position:absolute` avec `left:0` et sans `width` en CSS, donc dÃ©jÃ  large de 0 â€” et panels/donation.js:244 et 365 posent la vraie largeur par CSSOM (non concernÃ©e par la CSP).

**Correction.** Supprimer les deux attributs `style` et dÃ©clarer `width: 0;` sur la rÃ¨gle groupÃ©e `.opm-goal__fill, .opm-goal__ghost` de panels/donation.css:236-244.

---

## Verdicts des cinq agents

- Les modÃ¨les sont, eux, irrÃ©prochables â€” colonne par colonne, `users`, `article`, `statistiques`, `equipages` et `iles` correspondent exactement au dump, `users.id` est bien un entier partout, l'INSERT de crÃ©ation de compte renseigne les dix-sept colonnes NOT NULL sans dÃ©faut, l'Ã©criture des statistiques est bien atomique et muette sur Ã©chec de ping, et la migration est strictement additive ; mais le serveur ne dÃ©marre pas â€” `services/audit.py` importe un modÃ¨le `AuditLog` qui n'existe pas et construit ses lignes avec trois colonnes inventÃ©es â€” et derriÃ¨re cette panne d'import attendent deux autres bloquants (`session.get(User, <str>)` incompatible asyncpg, `blocked_reason` appelÃ© avec un mot-clÃ© inconnu), une fixture de test capable de `DROP` les tables du site, et une migration Alembic livrÃ©e non applicable sur la base de production.

- La compatibilite Werkzeug elle-meme est juste â€” j'ai recalcule les cinq vecteurs de test avec hashlib et repasse la sortie de hash_password dans la formule de Flask : lecture, ecriture et renforcement 260 000 -> 600 000 sont corrects a l'octet pres, aucune empreinte malformee ne fait lever la route, et il ne reste d'Argon2id que dans les dependances et les docstrings ; ce qui est casse, c'est autour : un ecart de temps de 2,4x qui permet d'enumerer les comptes existants, et 0,14 a 0,65 s de derivation synchrone qui gele la boucle d'evenements a chaque connexion.

- Le contrat IPC lui-mÃªme est irrÃ©prochable â€” les 40 canaux du preload, les handlers ipcMain et les services correspondent un Ã  un, rien n'est non sÃ©rialisable et aucun secret ne franchit le pont â€” mais le renderer importe ses deux modules de coque depuis un dossier inexistant, ce qui rend le launcher inutilisable (bouton JOUER mort), et six autres Ã©carts majeurs (ajout de compte, skins, temps de jeu, mise Ã  jour, fiche RP, flux device) doivent Ãªtre repris avant toute compilation.

- L'architecture de sÃ©curitÃ© est solide sur ses fondations (JWT EdDSA Ã  algorithme verrouillÃ©, refresh_token opaques rotatifs avec rÃ©vocation de famille, jeton Microsoft chiffrÃ© en AES-256-GCM Ã  nonce unique, enveloppes HMAC pour le state OAuth, textures validÃ©es par contenu et adressÃ©es par SHA-256 sans traversÃ©e possible, fenÃªtre Microsoft sans preload ni exfiltration, build.js sans obfuscation par dÃ©faut et signature facultative), mais elle est neutralisÃ©e en production par trois dÃ©fauts : un identifiant de jeton passÃ© en chaÃ®ne Ã  une clÃ© primaire entiÃ¨re qui fait Ã©chouer toute route authentifiÃ©e sur PostgreSQL, une lecture de X-Forwarded-For par la gauche qui rend la limitation de dÃ©bit entiÃ¨rement contournable, et une porte de force brute non limitÃ©e par compte sur /yggdrasil/authserver/authenticate.

- La traduction CSS de la maquette est remarquablement fidÃ¨le â€” jetons complets, mesures 46/96/60/620/206/392/212 respectÃ©es, quatre Ã©tats du bouton JOUER, cinq animations et les deux voiles au pixel, et aucune valeur de dÃ©monstration en dur (le classement des donateurs affiche bien un Ã©tat vide honnÃªte) â€” mais la scÃ¨ne du personnage est cassÃ©e sur trois points cumulÃ©s (image au chemin faux, repli sur le personnage de dÃ©monstration MÃ©lodia, rendu de tÃªte carrÃ© Ã©tirÃ© en 404 px Ã  la place d'un corps entier), les squelettes clairs dÃ©posÃ©s sur les quatre surfaces sombres crÃ¨vent l'Ã©cran au chargement, et le popover des comptes perd Ã  la fois sa mise en page Ã  deux lignes et la marque du compte actif.

