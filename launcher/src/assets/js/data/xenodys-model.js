/**
 * Xenodys en cubes : la géométrie et les animations GeckoLib (les mêmes que le jeu),
 * lues dans le paquet de ressources. `null` si le paquet est fermé.
 */

import { packJson } from '../utils/pack.js';

const [geo, animations, assistantGeo, assistantAnimations, joueur, joueurFin] = await Promise.all(
  ['geo/xenodys.geo', 'animations/xenodys.animation', 'geo/xenodys_assistant.geo', 'animations/xenodys_assistant.animation',
    'geo/joueur.geo', 'geo/joueur_fin.geo'].map((n) => packJson(`geckolib/${n}.json`).catch(() => null))
);

export const GEO = geo;
export const ANIMATIONS = animations;
export const ASSISTANT_GEO = assistantGeo;
export const ASSISTANT_ANIMATIONS = assistantAnimations;
export const JOUEUR_GEO = joueur;
export const JOUEUR_FIN_GEO = joueurFin;
