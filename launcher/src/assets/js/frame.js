/**
 * Cadre de la fenêtre — lu AVANT le premier rendu.
 *
 * Script classique et synchrone, chargé dans <head> : il doit poser le mode de
 * la fenêtre avant que la page ne se peigne, sans quoi le launcher
 * apparaîtrait un instant collé aux bords d'une fenêtre transparente.
 *
 * Le processus principal (windows/mainWindow.js) transmet le mode dans
 * l'adresse de la page : `?fenetre=ouvert&mt=72&mr=300&mb=56&ml=96`, ou
 * `?fenetre=compact`. On en tire `<html data-fenetre="…">` et les variables CSS
 * `--frame-mt/mr/mb/ml` (layout/frame.css). Tout le reste — clics traversants,
 * poignée, décor — vit dans les modules (components/frame.js, surround.js).
 */
(function () {
  'use strict';
  var params = new URLSearchParams(window.location.search);
  var mode = params.get('fenetre') === 'ouvert' ? 'ouvert' : 'compact';
  var root = document.documentElement;
  root.dataset.fenetre = mode;
  if (mode !== 'ouvert') return;

  // Marges bornées : une adresse bricolée ne doit pas faire disparaître le cadre.
  var sides = { mt: 'top', mr: 'right', mb: 'bottom', ml: 'left' };
  Object.keys(sides).forEach(function (key) {
    var value = parseInt(params.get(key), 10);
    if (!(value >= 0 && value <= 600)) value = 0;
    root.style.setProperty('--frame-' + key, value + 'px');
  });
})();
