/**
 * Les petits bruits de Xenodys : mécaniques, électroniques, discrets.
 *
 * Aucun fichier : chaque son est synthétisé à la volée (Web Audio) — bips,
 * relais, servomoteurs, souffles. Ils accompagnent les gestes du joueur (survol,
 * clic, onglet, interrupteur) et la cinématique du lancement.
 *
 * Réglages : `launcher.sfx` (marche/arrêt) et `launcher.volume`, partagé avec
 * la musique.
 */

/** Volume maximal réel des effets : sous la musique. */
const MASTER_MAX = 0.35;

/**
 * @returns {{
 *   play: (name: string, options?: {etat?: string}) => void,
 *   setEnabled: (on: boolean) => void,
 *   setVolume: (percent: number) => void,
 *   dispose: () => void,
 * }}
 */
export function createSfx() {
  let ctx = null;
  let master = null;
  let noiseBuffer = null;
  let enabled = true;
  let volume = 0.4;
  const lastPlayed = new Map();

  function context() {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = volume * MASTER_MAX;
      master.connect(ctx.destination);
      // Une seconde de bruit blanc, réutilisée par tous les souffles.
      noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  /** Une note brève : forme, fréquences de départ et d'arrivée, enveloppe. */
  function tone({ type = 'square', from, to = from, at = 0, dur = 0.05, gain = 0.3, filter = null }) {
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.01, dur / 4));
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = osc;
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = filter.type;
      f.frequency.value = filter.freq;
      f.Q.value = filter.q ?? 1;
      node = osc.connect(f);
    }
    node.connect(env).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** Un souffle de bruit filtré, dont le filtre glisse. */
  function noise({ at = 0, dur = 0.3, gain = 0.2, type = 'bandpass', from = 800, to = from, q = 1.2 }) {
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(from, t);
    if (to !== from) f.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.05, dur / 3));
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(env).connect(master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  /** Le catalogue. Chaque son tient en quelques notes. */
  const SOUNDS = {
    // Survol : un tic aigu, à peine audible.
    hover: () => tone({ type: 'sine', from: 2600, dur: 0.025, gain: 0.05 }),
    // Clic : un bip court et un claquement de relais.
    click: () => {
      tone({ type: 'square', from: 1150, to: 900, dur: 0.045, gain: 0.12, filter: { type: 'lowpass', freq: 3000 } });
      noise({ dur: 0.03, gain: 0.08, type: 'highpass', from: 3000 });
    },
    // Onglet : deux notes qui montent, comme un module qui s'enclenche.
    tab: () => {
      tone({ type: 'square', from: 620, dur: 0.05, gain: 0.08, filter: { type: 'lowpass', freq: 2400 } });
      tone({ type: 'square', from: 930, at: 0.055, dur: 0.06, gain: 0.08, filter: { type: 'lowpass', freq: 2400 } });
    },
    // Interrupteur : relais mécanique, double claquement.
    toggle: () => {
      noise({ dur: 0.025, gain: 0.14, type: 'bandpass', from: 2200, q: 3 });
      noise({ at: 0.045, dur: 0.02, gain: 0.1, type: 'bandpass', from: 1500, q: 3 });
      tone({ type: 'triangle', from: 1400, at: 0.01, dur: 0.04, gain: 0.05 });
    },
    // Notification : deux notes douces.
    notify: () => {
      tone({ type: 'triangle', from: 880, dur: 0.08, gain: 0.08 });
      tone({ type: 'triangle', from: 1320, at: 0.09, dur: 0.12, gain: 0.07 });
    },
    // Servomoteur : une scie qui monte, filtrée.
    servo: () => {
      tone({ type: 'sawtooth', from: 110, to: 260, dur: 0.32, gain: 0.07, filter: { type: 'lowpass', freq: 900 } });
      tone({ type: 'sawtooth', from: 260, to: 170, at: 0.3, dur: 0.18, gain: 0.05, filter: { type: 'lowpass', freq: 700 } });
    },
    // Vol de Xenodys : un souffle qui balaie, un bourdon qui monte.
    whoosh: () => {
      noise({ dur: 1.0, gain: 0.22, type: 'bandpass', from: 300, to: 2600, q: 0.9 });
      tone({ type: 'sawtooth', from: 70, to: 140, dur: 1.0, gain: 0.06, filter: { type: 'lowpass', freq: 400 } });
    },
    // Le launcher rétrécit : une chute, un grésillement.
    shrink: () => {
      tone({ type: 'sawtooth', from: 900, to: 70, dur: 1.3, gain: 0.08, filter: { type: 'lowpass', freq: 2200 } });
      tone({ type: 'sine', from: 1800, to: 120, dur: 1.3, gain: 0.05 });
      noise({ dur: 1.3, gain: 0.06, type: 'highpass', from: 4000, to: 1200 });
    },
    // Le passage s'ouvre — lumineux, ou déchiré.
    portal: ({ etat } = {}) => {
      if (etat === 'corrompue') {
        tone({ type: 'sawtooth', from: 220, to: 55, dur: 1.2, gain: 0.12, filter: { type: 'lowpass', freq: 1600 } });
        tone({ type: 'sawtooth', from: 233, to: 52, dur: 1.2, gain: 0.1, filter: { type: 'lowpass', freq: 1600 } });
        noise({ dur: 0.5, gain: 0.25, type: 'lowpass', from: 6000, to: 300 });
        for (let k = 0; k < 6; k += 1) noise({ at: 0.15 + k * 0.11, dur: 0.04, gain: 0.18, type: 'bandpass', from: 900 + k * 300, q: 4 });
        return;
      }
      [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, k) => {
        tone({ type: 'triangle', from: f, at: k * 0.07, dur: 0.9 - k * 0.08, gain: 0.07 });
      });
      noise({ dur: 1.1, gain: 0.12, type: 'highpass', from: 2000, to: 9000 });
    },
    // Le launcher revient : une montée courte.
    power: () => {
      tone({ type: 'sine', from: 160, to: 880, dur: 0.6, gain: 0.08 });
      tone({ type: 'square', from: 880, at: 0.6, dur: 0.05, gain: 0.06, filter: { type: 'lowpass', freq: 2500 } });
    },
    // Le cadre se construit, ligne à ligne : un balayage de petits bips.
    build: () => {
      for (let k = 0; k < 8; k += 1) {
        tone({ type: 'square', from: 700 + k * 90, at: k * 0.075, dur: 0.03, gain: 0.035, filter: { type: 'lowpass', freq: 2600 } });
      }
      noise({ dur: 0.6, gain: 0.04, type: 'highpass', from: 5000, to: 2500 });
    },
    // Une main de Xenodys se pose sur le cadre : un servo bref, un « clac » métallique.
    clamp: () => {
      tone({ type: 'sawtooth', from: 180, to: 320, dur: 0.12, gain: 0.06, filter: { type: 'lowpass', freq: 900 } });
      noise({ at: 0.11, dur: 0.05, gain: 0.2, type: 'bandpass', from: 1800, q: 5 });
      tone({ type: 'triangle', from: 2300, to: 1900, at: 0.11, dur: 0.12, gain: 0.05 });
      tone({ type: 'sine', from: 90, to: 55, at: 0.11, dur: 0.18, gain: 0.12 });
    },
    // Corrompue : ses mains s'écrasent sur le cadre.
    slam: () => {
      tone({ type: 'sine', from: 120, to: 38, dur: 0.5, gain: 0.3 });
      noise({ dur: 0.35, gain: 0.3, type: 'lowpass', from: 3000, to: 200 });
      noise({ at: 0.02, dur: 0.12, gain: 0.18, type: 'bandpass', from: 2400, q: 6 });
      for (let k = 0; k < 4; k += 1) noise({ at: 0.18 + k * 0.07, dur: 0.03, gain: 0.08, type: 'bandpass', from: 1200 + k * 500, q: 5 });
    },
    // Un grésillement court : l'image qui saute.
    glitch: () => {
      for (let k = 0; k < 3; k += 1) {
        tone({ type: 'square', from: 300 + Math.random() * 900, at: k * 0.045, dur: 0.03, gain: 0.04, filter: { type: 'bandpass', freq: 1800, q: 2 } });
      }
      noise({ dur: 0.12, gain: 0.07, type: 'highpass', from: 3500 });
    },
    // Un assistant touche le sol.
    land: () => {
      tone({ type: 'sine', from: 260, to: 120, dur: 0.09, gain: 0.07 });
      noise({ dur: 0.03, gain: 0.05, type: 'bandpass', from: 2600, q: 3 });
    },
    // Le joueur se défait en pixels : une pluie de bips qui montent.
    dissolve: () => {
      for (let k = 0; k < 14; k += 1) {
        tone({ type: 'square', from: 500 + k * 110 + Math.random() * 60, at: k * 0.05, dur: 0.035, gain: 0.025, filter: { type: 'lowpass', freq: 3500 } });
      }
      noise({ dur: 0.8, gain: 0.05, type: 'bandpass', from: 1500, to: 6000, q: 1.5 });
    },
    // Le bocal éclate.
    shatter: () => {
      noise({ dur: 0.08, gain: 0.3, type: 'highpass', from: 2500 });
      for (let k = 0; k < 9; k += 1) {
        tone({ type: 'sine', from: 2800 + Math.random() * 3500, at: 0.03 + Math.random() * 0.45, dur: 0.12, gain: 0.04 });
      }
      noise({ at: 0.05, dur: 0.5, gain: 0.08, type: 'bandpass', from: 5000, to: 2500, q: 2 });
    },
    // Un lancement raté, créatrice : deux notes qui descendent, dédaigneuses.
    deny: () => {
      tone({ type: 'triangle', from: 660, dur: 0.14, gain: 0.07 });
      tone({ type: 'triangle', from: 440, to: 415, at: 0.16, dur: 0.3, gain: 0.07 });
    },
    // Corrompue : un rire mécanique, haché, qui grésille.
    laugh: () => {
      for (let k = 0; k < 6; k += 1) {
        const f = 330 - k * 22;
        tone({ type: 'sawtooth', from: f * 1.15, to: f, at: k * 0.11, dur: 0.08, gain: 0.07, filter: { type: 'bandpass', freq: 1300, q: 1.6 } });
        noise({ at: k * 0.11, dur: 0.04, gain: 0.05, type: 'bandpass', from: 2500, q: 3 });
      }
    },
    // La corruption gagne Xenodys : un coup sourd, une onde qui se déchire.
    corrupt: () => {
      tone({ type: 'sine', from: 70, to: 32, dur: 0.9, gain: 0.25 });
      tone({ type: 'sawtooth', from: 110, to: 220, dur: 1.2, gain: 0.07, filter: { type: 'lowpass', freq: 1200 } });
      tone({ type: 'sawtooth', from: 116, to: 208, dur: 1.2, gain: 0.06, filter: { type: 'lowpass', freq: 1200 } });
      noise({ dur: 1.3, gain: 0.12, type: 'bandpass', from: 400, to: 3000, q: 1 });
    },
    // Elle redevient créatrice : un accord clair qui s'ouvre.
    purify: () => {
      [392, 493.88, 587.33, 783.99].forEach((f, k) => tone({ type: 'triangle', from: f, at: k * 0.09, dur: 1.1 - k * 0.12, gain: 0.06 }));
      noise({ dur: 1.0, gain: 0.07, type: 'highpass', from: 3000, to: 8000 });
    },
  };

  /** Délai minimal entre deux occurrences d'un même son, en secondes. */
  const MIN_GAP = { hover: 0.07, click: 0.03 };

  return {
    play(name, options) {
      if (!enabled || volume <= 0 || !SOUNDS[name]) return;
      try {
        context();
        const now = ctx.currentTime;
        const gap = MIN_GAP[name] ?? 0;
        if (gap && now - (lastPlayed.get(name) ?? -1) < gap) return;
        lastPlayed.set(name, now);
        SOUNDS[name](options);
      } catch {
        // Un son raté ne doit jamais gêner l'interface.
      }
    },
    setEnabled(on) {
      enabled = Boolean(on);
    },
    setVolume(percent) {
      const v = Number(percent);
      if (Number.isFinite(v)) volume = Math.min(1, Math.max(0, v / 100));
      if (master) master.gain.setTargetAtTime(volume * MASTER_MAX, ctx.currentTime, 0.05);
    },
    dispose() {
      ctx?.close().catch(() => {});
    },
  };
}
