/**
 * La musique de Xenodys — composée en direct, sans fichier audio (Web Audio).
 *
 * Un petit séquenceur joue une musique générative : une grille d'accords, et
 * sur elle des voix qui tirent leurs notes au hasard parmi celles de l'accord
 * — jamais deux fois la même phrase. Deux compositions, selon l'état de
 * Xenodys, qui passent de l'une à l'autre en fondu :
 *
 * Créatrice — un laboratoire calme, apaisé (ré lydien, ~70 BPM). Nappes douces
 * qui changent avec les accords, basse ronde, arpège de cloches de verre en
 * écho, « pings » de données, et le tic feutré d'une horloge de laboratoire.
 *
 * Corrompue — étrange, tendue, stressante (do phrygien, ~96 BPM). Basse en
 * ostinato qui pousse, clusters dissonants qui enflent et retombent, frappes
 * métalliques inharmoniques, tic-tac d'horloge, battement de cœur, montées de
 * souffle et coupures.
 *
 * Aucun son tenu en continu ni aucun « tremblement » : chaque note naît,
 * vit et s'éteint.
 *
 * Réglages : `launcher.ambiance` (marche/arrêt) et `launcher.volume` (0 → 100).
 * La musique se tait pendant une partie, et quand le launcher est réduit.
 */

/** Volume maximal réel (100 % du réglage) : une ambiance, pas un concert. */
const MASTER_MAX = 0.5;
/** Durée du fondu entre les deux compositions, en secondes. */
const MORPH = 3;
/** Niveau de chaque composition : la version corrompue, plus clairsemée, est remontée. */
const LEVEL = { creatrice: 1, corrompue: 1.8 };
/** Le séquenceur planifie les notes un peu à l'avance (secondes). */
const LOOKAHEAD = 0.25;

/** Fréquence d'une note MIDI. */
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

/**
 * Les deux compositions. `chords` : basse + voix de l'accord (notes MIDI),
 * chacun tenu `barsPerChord` mesures de 4 temps.
 */
const SONGS = {
  creatrice: {
    bpm: 70,
    barsPerChord: 2,
    chords: [
      { bass: 38, notes: [54, 57, 61, 64] }, // Ré maj9
      { bass: 47, notes: [50, 54, 57, 61] }, // Si m9
      { bass: 43, notes: [59, 62, 66, 69] }, // Sol maj9
      { bass: 45, notes: [61, 64, 66, 71] }, // La 6/9
    ],
  },
  corrompue: {
    bpm: 96,
    barsPerChord: 2,
    chords: [
      { bass: 36, notes: [51, 55, 60, 61] }, // Do m (b9)
      { bass: 37, notes: [53, 56, 61, 62] }, // Ré♭ (b9 en haut)
      { bass: 35, notes: [50, 53, 56, 59] }, // Si dim
      { bass: 36, notes: [51, 54, 60, 63] }, // Do m (quinte diminuée)
    ],
  },
};

/** Réponse impulsionnelle d'une grande salle : du bruit qui s'éteint. */
function impulse(ctx, seconds = 4) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2.8;
  }
  return buffer;
}

/**
 * @returns {{
 *   setEnabled: (on: boolean) => void,
 *   setVolume: (percent: number) => void,
 *   setEtat: (etat: 'creatrice'|'corrompue') => void,
 *   setSilenced: (silenced: boolean) => void,
 *   dispose: () => void,
 * }}
 */
export function createAmbiance() {
  let ctx = null;
  let out = null; // { master, reverb, echo, buses: {creatrice, corrompue}, noise }
  let enabled = false;
  let silenced = false;
  let volume = 0.4;
  let etat = 'creatrice';
  let timer = 0;
  let pauseTimer = 0;
  // Position dans la musique : temps de la prochaine double-croche, et son rang.
  let nextStep = 0;
  /** Les derniers temps planifiés : `{at, strong}`, en temps du contexte audio. */
  const beats = [];
  let step = 0;

  const playing = () => enabled && !silenced && volume > 0;

  /* ------------------------------------------------------------ chaîne */

  function build() {
    ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = 0;
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -18;
    glue.ratio.value = 3;
    master.connect(glue).connect(ctx.destination);

    const reverb = ctx.createConvolver();
    reverb.buffer = impulse(ctx);
    const reverbOut = ctx.createGain();
    reverbOut.gain.value = 0.55;
    reverb.connect(reverbOut).connect(master);

    // Écho en croches pointées, pour les cloches.
    const echo = ctx.createDelay(2);
    echo.delayTime.value = 0.64;
    const echoBack = ctx.createGain();
    echoBack.gain.value = 0.38;
    const echoTone = ctx.createBiquadFilter();
    echoTone.type = 'lowpass';
    echoTone.frequency.value = 3200;
    echo.connect(echoTone).connect(echoBack).connect(echo);
    echoTone.connect(master);
    echoTone.connect(reverb);

    const buses = {};
    for (const name of Object.keys(SONGS)) {
      const g = ctx.createGain();
      g.gain.value = name === etat ? LEVEL[name] : 0;
      g.connect(master);
      buses[name] = g;
    }

    const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i += 1) nd[i] = Math.random() * 2 - 1;

    out = { master, reverb, echo, buses, noise: nb };
  }

  /* ---------------------------------------------------- instruments */

  /** Envoie un son dans le bus de la composition, et dans la réverbération. */
  function route(node, song, wet = 0.4) {
    node.connect(out.buses[song]);
    if (wet > 0) {
      const send = ctx.createGain();
      send.gain.value = wet;
      node.connect(send).connect(out.reverb);
    }
  }

  /** Une enveloppe : montée, maintien, chute. */
  function envelope(at, attack, hold, release, peak) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + attack);
    g.gain.setValueAtTime(peak, at + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + hold + release);
    return g;
  }

  /** Nappe : deux oscillateurs légèrement désaccordés, filtrés, qui enflent. */
  function pad(song, midi, at, dur, { type = 'triangle', peak = 0.03, cutoff = 1600, attack = 1.6, detune = 6 } = {}) {
    const env = envelope(at, attack, Math.max(0.1, dur - attack), 2.2, peak);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    for (const d of [-detune, detune]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = hz(midi);
      o.detune.value = d;
      o.connect(f);
      o.start(at);
      o.stop(at + dur + 2.5);
    }
    f.connect(env);
    route(env, song, 0.6);
  }

  /** Cloche FM : une porteuse modulée dont l'indice s'éteint. `ratio` inharmonique = métal. */
  function bell(song, midi, at, { peak = 0.05, ratio = 3.5, index = 2.4, decay = 1.6, echoSend = 0.35 } = {}) {
    const f0 = hz(midi);
    const carrier = ctx.createOscillator();
    carrier.frequency.value = f0;
    const mod = ctx.createOscillator();
    mod.frequency.value = f0 * ratio;
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(f0 * index, at);
    modGain.gain.exponentialRampToValueAtTime(1, at + decay);
    mod.connect(modGain).connect(carrier.frequency);
    const env = envelope(at, 0.005, 0.02, decay, peak);
    carrier.connect(env);
    route(env, song, 0.5);
    if (echoSend > 0) {
      const send = ctx.createGain();
      send.gain.value = echoSend;
      env.connect(send).connect(out.echo);
    }
    for (const o of [carrier, mod]) {
      o.start(at);
      o.stop(at + decay + 0.1);
    }
  }

  /** Basse douce : sinus et un soupçon de triangle. */
  function softBass(song, midi, at, dur, peak = 0.12) {
    const env = envelope(at, 0.3, Math.max(0.1, dur - 0.6), 1.2, peak);
    for (const [type, gain] of [['sine', 1], ['triangle', 0.25]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = hz(midi);
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(env);
      o.start(at);
      o.stop(at + dur + 1.3);
    }
    route(env, song, 0.15);
  }

  /** Basse d'ostinato : une scie dont le filtre s'ouvre et se referme à chaque note. */
  function pulseBass(song, midi, at, dur, peak = 0.11) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = hz(midi);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 6;
    f.frequency.setValueAtTime(180, at);
    f.frequency.exponentialRampToValueAtTime(900, at + 0.03);
    f.frequency.exponentialRampToValueAtTime(160, at + dur);
    const env = envelope(at, 0.005, dur * 0.5, dur * 0.5, peak);
    o.connect(f).connect(env);
    route(env, song, 0.1);
    o.start(at);
    o.stop(at + dur + 0.05);
  }

  /** Un clic d'horloge : bruit très court, filtré. */
  function tick(song, at, { peak = 0.02, freq = 5000, q = 8 } = {}) {
    const src = ctx.createBufferSource();
    src.buffer = out.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const env = envelope(at, 0.001, 0.004, 0.03, peak);
    src.connect(f).connect(env);
    route(env, song, 0.2);
    src.start(at, Math.random());
    src.stop(at + 0.06);
  }

  /** Battement de cœur : deux coups sourds. */
  function heartbeat(song, at) {
    for (const [d, peak] of [[0, 0.28], [0.24, 0.18]]) {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(72, at + d);
      o.frequency.exponentialRampToValueAtTime(34, at + d + 0.18);
      const env = envelope(at + d, 0.01, 0.01, 0.24, peak);
      o.connect(env);
      route(env, song, 0);
      o.start(at + d);
      o.stop(at + d + 0.3);
    }
  }

  /** Souffle qui monte : bruit filtré dont la bande s'élève. */
  function riser(song, at, dur, peak = 0.04) {
    const src = ctx.createBufferSource();
    src.buffer = out.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.6;
    f.frequency.setValueAtTime(200, at);
    f.frequency.exponentialRampToValueAtTime(2600, at + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(peak, at + dur * 0.95);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur + 0.15);
    src.connect(f).connect(env);
    route(env, song, 0.3);
    src.start(at);
    src.stop(at + dur + 0.2);
  }

  /** Coupure : la composition se tait un instant, une à trois fois. */
  function stutter(song, at) {
    const g = out.buses[song].gain;
    let t = at;
    const cuts = 1 + Math.floor(Math.random() * 3);
    for (let k = 0; k < cuts; k += 1) {
      const off = 0.04 + Math.random() * 0.07;
      g.setValueAtTime(0.08 * LEVEL[song], t);
      g.setValueAtTime(LEVEL[song], t + off);
      t += off + 0.04 + Math.random() * 0.05;
    }
  }

  /* ---------------------------------------------------- composition */

  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  /**
   * Joue la double-croche n° `s` (16 par mesure) au temps `at`.
   * @param {string} song
   */
  function playStep(song, s, at) {
    const S = SONGS[song];
    // Les temps, pour ceux qui veulent battre avec la musique (le fond).
    if (s % 4 === 0) {
      beats.push({ at, strong: s % 16 === 0 });
      if (beats.length > 16) beats.shift();
    }
    const sixteenth = 60 / S.bpm / 4;
    const perChord = 16 * S.barsPerChord;
    const chord = S.chords[Math.floor(s / perChord) % S.chords.length];
    const inChord = s % perChord;
    const inBar = s % 16;
    const chordDur = sixteenth * perChord;

    if (song === 'creatrice') {
      if (inChord === 0) {
        softBass(song, chord.bass, at, chordDur * 0.95);
        chord.notes.forEach((n, i) => pad(song, n, at + i * 0.08, chordDur * 0.9, { peak: 0.016 }));
      }
      // Arpège de cloches : croches, avec des silences, notes de l'accord.
      if (inBar % 2 === 0 && Math.random() < (inBar % 4 === 0 ? 0.7 : 0.35)) {
        const n = pick(chord.notes) + (Math.random() < 0.45 ? 12 : 0);
        bell(song, n, at, { peak: 0.035 + Math.random() * 0.02 });
      }
      // De temps en temps, une petite phrase aiguë de données.
      if (inBar === 8 && Math.random() < 0.25) {
        for (let k = 0; k < 3; k += 1) {
          bell(song, pick(chord.notes) + 24, at + k * sixteenth, { peak: 0.012, ratio: 2, index: 0.6, decay: 0.4, echoSend: 0.5 });
        }
      }
      // L'horloge du laboratoire, feutrée, sur les temps.
      if (inBar % 4 === 0) tick(song, at, { peak: 0.008, freq: 3200, q: 4 });
      return;
    }

    // --- corrompue
    // Ostinato de basse en croches : fondamentale, fondamentale, octave, fondamentale…
    if (inBar % 2 === 0) {
      const pattern = [0, 0, 12, 0, 0, 1, 12, 0];
      pulseBass(song, chord.bass + pattern[(inBar / 2) % 8], at, sixteenth * 1.8);
    }
    // Clusters dissonants qui enflent sur chaque accord.
    if (inChord === 0) {
      chord.notes.forEach((n) => pad(song, n, at, chordDur * 0.85, { type: 'sawtooth', peak: 0.011, cutoff: 1100, attack: 2.4, detune: 14 }));
      pad(song, chord.notes[chord.notes.length - 1] + 1, at + chordDur * 0.4, chordDur * 0.4, { type: 'sine', peak: 0.012, attack: 1.2 });
    }
    // Tic-tac sec sur chaque temps, plus discret entre les temps.
    if (inBar % 4 === 0) tick(song, at, { peak: 0.03, freq: 4200, q: 10 });
    else if (inBar % 4 === 2) tick(song, at, { peak: 0.012, freq: 6000, q: 10 });
    // Battement de cœur, une fois par mesure.
    if (inBar === 0) heartbeat(song, at);
    // Frappes métalliques inharmoniques, rares.
    if (inBar % 4 === 3 && Math.random() < 0.12) {
      bell(song, pick(chord.notes) + 12, at, { peak: 0.03, ratio: 1.414, index: 4, decay: 2.6, echoSend: 0.2 });
    }
    // Une montée toutes les quatre mesures, vers le changement d'accord.
    if (s % 64 === 32) riser(song, at, sixteenth * 32);
    // Des coupures.
    if (inBar === 12 && Math.random() < 0.18) stutter(song, at);
  }

  /** Le séquenceur : planifie les double-croches à venir. */
  function schedule() {
    if (!ctx || !playing()) return;
    const S = SONGS[etat];
    const sixteenth = 60 / S.bpm / 4;
    if (nextStep < ctx.currentTime) nextStep = ctx.currentTime + 0.05;
    while (nextStep < ctx.currentTime + LOOKAHEAD) {
      playStep(etat, step, nextStep);
      nextStep += sixteenth;
      step += 1;
    }
  }

  function startScheduler() {
    if (timer) return;
    timer = setInterval(schedule, 25);
    schedule();
  }

  function stopScheduler() {
    clearInterval(timer);
    timer = 0;
  }

  /* ---------------------------------------------------------- pilotage */

  async function update() {
    if (playing()) {
      clearTimeout(pauseTimer);
      if (!ctx) build();
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      out.master.gain.setTargetAtTime(volume * MASTER_MAX, ctx.currentTime, 0.8);
      startScheduler();
      return;
    }
    if (!ctx) return;
    out.master.gain.setTargetAtTime(0, ctx.currentTime, 0.4);
    // Les dernières notes s'éteignent, puis le séquenceur s'arrête.
    clearTimeout(pauseTimer);
    pauseTimer = setTimeout(() => {
      if (!playing()) stopScheduler();
    }, 2000);
  }

  // Si le navigateur a refusé de démarrer sans geste, le premier clic suffit.
  const unlock = () => {
    if (ctx?.state === 'suspended' && playing()) ctx.resume().catch(() => {});
  };
  window.addEventListener('pointerdown', unlock);

  return {
    /**
     * L'enveloppe du dernier temps joué, de 1 (le temps vient de tomber) à 0.
     * Les premiers temps des mesures comptent plus. 0 quand la musique se tait.
     */
    pulse() {
      if (!ctx || !playing() || volume <= 0) return 0;
      const now = ctx.currentTime;
      for (let i = beats.length - 1; i >= 0; i -= 1) {
        const b = beats[i];
        if (b.at > now) continue;
        return Math.exp(-(now - b.at) * 5) * (b.strong ? 1 : 0.55);
      }
      return 0;
    },
    setEnabled(on) {
      enabled = Boolean(on);
      update();
    },
    setVolume(percent) {
      const v = Number(percent);
      volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v / 100)) : volume;
      update();
    },
    setEtat(next) {
      const value = next === 'corrompue' ? 'corrompue' : 'creatrice';
      if (value === etat) return;
      etat = value;
      // Nouvelle composition : on repart en début de grille, en fondu.
      step = 0;
      if (out) {
        const t = ctx.currentTime;
        for (const [name, bus] of Object.entries(out.buses)) {
          bus.gain.cancelScheduledValues(t);
          bus.gain.setTargetAtTime(name === etat ? LEVEL[name] : 0, t, MORPH / 3);
        }
      }
    },
    setSilenced(value) {
      silenced = Boolean(value);
      update();
    },
    dispose() {
      stopScheduler();
      clearTimeout(pauseTimer);
      window.removeEventListener('pointerdown', unlock);
      ctx?.close().catch(() => {});
    },
  };
}
