# Xenodys — l'état du monde

Xenodys est l'entité qui a créé le monde de One Piece Minecraft. Elle a deux
états, et **le jeu, le launcher et le site** les partagent :

| État | Qui elle est | Couleurs |
|---|---|---|
| `creatrice` | elle-même : bienveillante, curieuse, elle observe ses « expériences » | cyan — la couleur du site |
| `corrompue` | contrôlée par l'ennemi pendant un événement RP ; c'est toujours elle, qui lutte, mais elle peut être cruelle | rouge et violet |

`creatrice` est l'état normal. **Toute valeur inconnue, toute absence, toute
panne vaut `creatrice`** : un incident technique ne doit jamais plonger les
joueurs dans le thème de l'invasion.

Elle parle d'elle **à la troisième personne** (« Xenodys te voit revenir »).

---

## La source unique : `launcher_xenodys`

Une table d'une seule ligne (`id = 1`), dans la base partagée. Créée par la
migration `0002_launcher_xenodys` du serveur d'authentification, qui insère
d'emblée la ligne à l'état `creatrice`.

| Colonne | Type | Rôle |
|---|---|---|
| `id` | `integer` | toujours `1` |
| `etat` | `varchar(16)` | `creatrice` ou `corrompue` — contrainte `CHECK` en base |
| `message` | `varchar(280)`, nullable | annonce du staff, affichée telle quelle aux joueurs |
| `par` | `varchar(64)`, nullable | qui a déclenché la bascule — trace interne, jamais affichée |
| `depuis` | `timestamp` (UTC, sans fuseau) | date de la dernière bascule |

## Qui écrit : le staff, depuis le jeu

```
/xenodys corrompue L'ennemi a pris le Nexus. Tenez vos positions.
/xenodys creatrice
/xenodys            → affiche l'état actuel
```

Script : `minecraft/xenodys.sk` (Skript + skript-db, permission
`opm.xenodys`). Requêtes paramétrées, jamais `execute unsafe` : une annonce ne
peut pas modifier la requête SQL.

## Qui lit

**Le launcher** — `GET /api/v1/xenodys` (public, sans jeton) et le champ
`xenodys` de `GET /api/v1/bootstrap` :

```json
{ "etat": "corrompue", "depuis": "2026-11-15T20:14:03", "message": "L'ennemi a pris le Nexus." }
```

Relu toutes les 60 secondes : les launchers ouverts basculent en moins d'une
minute, sans redémarrer. Hors ligne, le dernier état connu est conservé.
Cache serveur : 10 secondes.

**Le site** — au choix :

- lire la table directement (même base) :
  `SELECT etat, message, depuis FROM launcher_xenodys WHERE id = 1` ;
- ou appeler `https://auth.onepieceminecraft.fr/api/v1/xenodys`.

Puis poser l'état sur la page, par exemple `<html data-xenodys="corrompue">`,
et redéfinir les couleurs du site sous ce sélecteur. Le site **lit** la table ;
il ne la crée pas et n'y écrit pas.

## La palette

| | `creatrice` | `corrompue` |
|---|---|---|
| Accent principal | `#91D9D1` | `#F0506E` |
| Accent secondaire | `#A6E1DA` | `#C77DFF` |
| Lien / actif sur fond clair | `#1D5C51` | `#6A1F8F` |
| Fond le plus sombre | `#050D0C` | `#0C0510` |
| Surface claire | `#F2FAF8` | `#FAF3F8` |
| Texte clair | `#EAF8F6` | `#F8ECF3` |
| Vidéo de fond | telle quelle | `hue-rotate(115deg) saturate(1.35) contrast(1.06) brightness(.82)` |

Référence complète côté launcher : `launcher/src/assets/css/base/xenodys.css`.

## La bascule

Au moment où l'état change pendant que la page est ouverte, le launcher joue
un court parasitage (1,5 s), puis affiche l'annonce du staff — ou, à défaut,
une phrase de Xenodys. Jamais au premier affichage, jamais si le système
demande de réduire les animations.
