# Souveraineté — ce que nous gagnons, ce que nous risquons

> Note pour l'équipe. Aucune ligne de code ici : ce document explique **pourquoi**
> le launcher et le serveur d'authentification sont construits ainsi, ce qui se
> passe quand un maillon casse, et ce que nous ne pouvons pas faire.
> Il est écrit pour être lu par quelqu'un qui reprendrait le projet dans deux ans.

---

## 1. En trois phrases

Le serveur One Piece Minecraft ne demande plus à Mojang si un joueur a le droit
d'entrer : **c'est nous qui délivrons les sessions de jeu**, signées par notre
propre clé. Microsoft n'intervient qu'une fois, au moment du rattachement, pour
répondre à une seule question — « ce joueur possède-t-il Minecraft ? » — et sa
réponse est conservée trente jours. Le reste du temps, le serveur de jeu ne parle
qu'à nous.

---

## 2. Le montage

```
   Le joueur                Le launcher OPM              Notre serveur d'auth
  ───────────              ─────────────────            ──────────────────────
   e-mail + mot de passe ──────────►  POST /api/v1/auth/login
                                              │
                                              ▼  vérifie dans users (base du site)
                                        access_token (15 min)

   « Rattacher Microsoft »  ──────►  POST /api/v1/link/microsoft/…
                                              │
                                              ▼  UNE fois : Microsoft → Xbox Live
                                                 → XSTS → api.minecraftservices.com
                                              │
                                              ▼  auth_mc_link : UUID premium réel,
                                                 pseudo, possession, valable 30 jours

   « JOUER »                ──────►  POST /api/v1/game/session
                                              │
                                              ▼  session Yggdrasil signée Ed25519 (24 h)
                                              │
                                              ▼
                                     le jeu démarre avec ce jeton
                                              │
   Le serveur Minecraft ◄───── le client annonce son arrivée (join)
        │
        └──► GET /yggdrasil/sessionserver/…/hasJoined  ─────►  NOUS
             (authlib-injector a détourné l'appel qui allait chez Mojang)
```

Trois familles de jetons, jamais mélangées : `access_token` (15 min, l'API),
`refresh_token` (30 jours, rotatif, le launcher), `yggdrasil.accessToken`
(24 h, le jeu). **Aucun jeton Microsoft n'atteint jamais le client Minecraft** ;
le `refresh_token` Microsoft est chiffré au repos et ne quitte pas le serveur.

---

## 3. Ce que ça change, concrètement

| | Avant (serveur classique) | Maintenant |
|---|---|---|
| Qui autorise un joueur à entrer | Mojang | **nous** |
| Panne de Mojang / Xbox Live | plus personne ne se connecte | aucun effet pendant 30 jours |
| Compte OPM et compte du site | deux mondes séparés | **un seul compte**, une seule table `users` |
| Pseudo affiché en jeu | celui de Mojang | celui de Mojang (inchangé — c'est voulu) |
| Skins | serveurs de Mojang | **les nôtres**, en contenu adressable |
| Bannir un joueur | plugin côté serveur uniquement | plugin **ou** compte, dès l'authentification |
| Launcher officiel de Minecraft | fonctionne | **ne fonctionne plus** sur notre serveur |
| Notre serveur d'auth tombe | — | **plus personne ne se connecte** |

Les deux dernières lignes sont le prix à payer. Elles sont détaillées plus bas.

---

## 4. Si Microsoft tombe

**Il ne se passe rien.** C'est exactement ce que la souveraineté achète.

La possession de Minecraft est une information *lente* : un joueur qui possédait
le jeu hier le possède encore aujourd'hui. Nous la vérifions donc une fois, nous
l'écrivons dans `auth_mc_link` avec une date d'expiration à trente jours, et une
tâche de fond la renouvelle **trois jours avant l'échéance**, sans réveiller
personne. Quand la panne survient, la marge est donc de trente-trois jours dans
le pire des cas.

| Pendant une panne Microsoft | État |
|---|---|
| Les joueurs déjà rattachés se connectent et jouent | oui, sans rien remarquer |
| Le launcher affiche compte, skin, journal, statistiques | oui |
| Un **nouveau** joueur rattache son compte Microsoft | non — c'est la seule chose bloquée |
| Une preuve de possession expire ce jour-là | la re-vérification échoue et **réessaie**, la preuve en place est conservée jusqu'à sa date |

Concrètement : une panne Azure de quelques heures — le cas réel — est totalement
invisible. Il faudrait une panne de **plus d'un mois** pour que les premiers
joueurs commencent à voir leur preuve expirer.

Si cela devait arriver, deux leviers, dans cet ordre :

1. `OPM_OWNERSHIP_TTL_DAYS=90` — prolonge le cache. Les preuves déjà expirées ne
   revivent pas, mais toutes les autres tiennent trois mois ;
2. `OPM_MICROSOFT_REQUIRED=false` — suspend l'exigence de rattachement, le temps
   que Microsoft revienne. Lisez d'abord le §6 : ce n'est pas anodin.

---

## 5. Si notre serveur d'authentification tombe

**Plus personne ne lance le jeu.** Il faut le dire franchement, car c'est le
risque que nous avons créé en prenant la main.

Ce qui continue de fonctionner :

- le launcher démarre, affiche le compte, le skin, le dernier journal de bord et
  les dernières statistiques **depuis son cache local** ;
- les joueurs **déjà connectés** en jeu ne sont pas déconnectés : le serveur
  Minecraft ne vérifie une session qu'à l'entrée.

Ce qui s'arrête :

- le bouton JOUER passe en « SERVEUR D'AUTHENTIFICATION INJOIGNABLE ». La session
  de jeu dure 24 h et doit être signée par nous : elle ne peut pas venir du cache ;
- personne ne peut **rejoindre** le serveur, ni se reconnecter après un
  redémarrage, puisque `hasJoined` n'a plus d'interlocuteur.

Le serveur d'authentification doit donc être **au moins aussi disponible que le
serveur Minecraft**. Il partage déjà la base PostgreSQL du site : le plus simple,
et le plus robuste, est de le déployer sur le même VPS, en second service nginx
(`auth.onepieceminecraft.fr`), à côté de gunicorn.

Ce qui rend la panne improbable, et courte quand elle arrive :

- `Restart=always` (systemd) ou `restart: unless-stopped` (Docker) : un processus
  qui meurt revient en cinq secondes ;
- `GET /health` interroge réellement la base et répond `503` sinon : c'est la
  sonde à brancher dans la supervision, et celle que Docker utilise déjà ;
- le service et la base sont sur la même machine : une panne réseau qui coupe
  l'un coupe de toute façon l'autre — et le serveur de jeu avec.

Le vrai scénario à préparer n'est pas la panne logicielle, c'est la **perte du
dossier `keys/`**. Sauvegardez-le : sans la clé RSA, les skins ne se vérifient
plus tant que le serveur Minecraft n'a pas redémarré ; sans la clé Ed25519,
toutes les sessions de jeu en cours deviennent invalides.

---

## 6. Basculer en mode souverain pur

Le mode « souverain pur » supprime complètement Microsoft : un compte OPM suffit
pour jouer, sans preuve de possession.

```bash
OPM_AUTH_MODE=sovereign
OPM_MICROSOFT_REQUIRED=false
```

C'est techniquement immédiat — et **c'est la décision la plus lourde de ce
document**. Trois conséquences, dans l'ordre de gravité :

**1. Les UUID changent, et la progression avec.** Sans rattachement Microsoft, il
n'y a plus d'UUID premium : le serveur en dérive un du pseudo
(`OfflinePlayer:<pseudo>`, la formule de Mojang pour les serveurs hors ligne).
Or mondes, LuckPerms, économie, claims, bans et statistiques sont **indexés sur
l'UUID**. Basculer un serveur existant en mode souverain pur, c'est repartir de
zéro pour chaque joueur — ou écrire une table de correspondance et migrer chaque
plugin, un par un. Les comptes déjà rattachés, eux, gardent leur UUID premium :
le serveur se retrouverait alors avec deux populations d'identifiants.

**2. Nous n'avons plus aucune preuve que le joueur possède Minecraft.** Le
serveur devient accessible aux copies non achetées du jeu. Ce n'est pas un
problème technique, c'est un problème de position : nous ne sommes plus en mesure
d'affirmer que notre communauté est composée de joueurs légitimes, et nous
perdons l'argument auprès de Mojang comme auprès des joueurs.

**3. Le pseudo n'est plus garanti unique côté Mojang.** Deux joueurs peuvent
choisir le même pseudo OPM qu'un joueur premium existant. La contrainte d'unicité
de `users.name` protège chez nous, pas ailleurs.

**Quand ce mode a du sens :** un serveur neuf, assumé « offline », ouvert à des
joueurs sans compte premium, et qui n'a jamais eu d'UUID premium à préserver.
**Quand il n'en a pas :** notre cas — un serveur existant, avec des mondes et des
plugins déjà peuplés.

Entre les deux, il existe un usage temporaire raisonnable : `MICROSOFT_REQUIRED=false`
seul, pendant une panne Microsoft longue, en laissant `AUTH_MODE=hybrid`. Les
comptes déjà rattachés continuent d'utiliser leur UUID premium ; seuls les
nouveaux venus obtiennent un UUID hors ligne — qu'il faudra corriger à la main
quand Microsoft reviendra. À réserver aux urgences, et à documenter dans le
journal d'exploitation.

---

## 7. Remplacer Microsoft par un autre oracle de possession

Microsoft n'occupe qu'une fonction dans ce montage : **répondre à une question
fermée**. Le reste — comptes, sessions, skins, autorisations — nous appartient
déjà. Le remplacer est donc une opération circonscrite.

Ce que doit fournir un oracle, quel qu'il soit :

| Donnée | Pourquoi | Colonne |
|---|---|---|
| un identifiant stable et unique du joueur chez le fournisseur | empêcher qu'un même compte externe serve deux comptes OPM | `auth_mc_link.msa_sub` |
| l'UUID Minecraft | c'est la clé de toute la progression en jeu | `auth_mc_link.minecraft_uuid` |
| le pseudo Minecraft | commandes, bans et journaux du serveur | `auth_mc_link.minecraft_username` |
| un booléen de possession | ce que l'oracle atteste | `auth_mc_link.owns_minecraft` |
| une date de validité | la durée du cache | `auth_mc_link.expires_at` |

Où brancher : **un seul module**, `opm_auth/services/microsoft.py`, qui produit un
objet `OwnershipProof`. Tout le reste du serveur ne connaît que cet objet et la
table `auth_mc_link`. Un oracle de remplacement écrit le même objet, et rien
d'autre ne bouge — ni les routeurs, ni Yggdrasil, ni le launcher.

Candidats plausibles, du plus simple au plus ambitieux :

- **une liste blanche tenue à la main** — pour un petit serveur, un fichier ou une
  table suffit ; l'oracle devient « le staff a vérifié ». Honnête, gratuit,
  ingérable au-delà de quelques centaines de joueurs ;
- **un autre fournisseur d'identité Minecraft** (Ely.by, Blessing Skin…) — même
  protocole Yggdrasil, mêmes concepts ; on remplace un tiers par un autre, sans
  gagner en indépendance ;
- **une preuve d'achat de notre côté** — si un jour la boutique OPM vend l'accès,
  le paiement devient l'oracle. C'est le seul chemin qui supprime réellement le
  tiers ;
- **aucun oracle** — c'est le mode souverain pur du §6, avec ses conséquences.

---

## 8. Les limites, honnêtement

Ce montage nous rend indépendants **à l'exécution**. Il ne nous rend pas
indépendants de tout, et il serait malhonnête de le laisser croire.

1. **Le rattachement initial dépend toujours de Microsoft.** Nous ne savons pas
   vérifier la possession de Minecraft sans lui. La souveraineté porte sur les
   trente jours qui suivent, pas sur la première seconde.
2. **Le client Minecraft ne nous appartient pas.** Le jeu reste la propriété de
   Mojang, et le joueur doit toujours l'avoir acheté. Ce montage ne rend rien
   légal qui ne l'était pas.
3. **Nous dépendons d'authlib-injector**, un agent Java tiers, libre mais
   maintenu par quelqu'un d'autre. S'il cessait d'être compatible avec une future
   version de Minecraft, le montage s'arrêterait le temps qu'un correctif sorte.
   C'est aujourd'hui le composant le plus exposé de la chaîne.
4. **Nous héritons d'un point de panne unique.** Avant, une panne de Mojang
   arrêtait tout le monde ; maintenant, c'est une panne de notre VPS. La
   différence est que celle-ci, nous pouvons agir dessus.
5. **La cryptographie des textures nous est imposée** : `SHA1withRSA`, parce que
   le client Minecraft vanilla ne sait vérifier que cela. C'est le seul endroit
   du projet où nous n'avons pas choisi, et SHA-1 n'est plus recommandé.
6. **Le cache de trente jours ne protège pas d'une panne longue.** Il est
   dimensionné pour des pannes de quelques heures à quelques jours — les seules
   qui se produisent réellement.
7. **L'identifiant d'application Microsoft utilisé par défaut est celui du
   launcher officiel.** C'est ce que font tous les launchers tiers, et c'est une
   zone grise vis-à-vis des conditions d'utilisation. Enregistrer notre propre
   application Azure (`OPM_MSA_CLIENT_ID`) est gratuit, prend dix minutes, et
   nous met en règle. **À faire avant l'ouverture publique.**
8. **Un mot de passe compromis donne accès au compte de jeu comme au compte du
   site** : il n'y en a qu'un. C'est ce qui rend la 2FA et la politique de douze
   caractères minimum non négociables.

---

## 9. Ce que nous recommandons

- garder le **mode hybride imposé** (`AUTH_MODE=hybrid`, `MICROSOFT_REQUIRED=true`) :
  c'est le seul qui préserve les UUID premium et l'exigence de possession ;
- **enregistrer une application Azure** avant l'ouverture publique (limite n° 7) ;
- **héberger le serveur d'authentification à côté du serveur Minecraft**, avec
  redémarrage automatique et une sonde sur `/health` ;
- **sauvegarder `keys/` et les textures** au même titre que la base ;
- laisser `OPM_YGG_MOJANG_FALLBACK=false` : c'est le réglage qui garantit que
  seuls les joueurs passant par le launcher OPM entrent sur le serveur ;
- relire ce document le jour où l'un de ces cinq points change.
