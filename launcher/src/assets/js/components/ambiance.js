/**
 * La musique de Xenodys : `ambiance2`, la musique du site, remixée en direct
 * (Web Audio) selon l'état de Xenodys.
 *
 * Créatrice — calme, comme dans une simulation. La musique, ralentie et
 * feutrée, baigne dans une grande réverbération, avec un léger miroitement
 * numérique (filtre en peigne, grain). Dessous, une nappe d'accords doux, et
 * de temps en temps des « pings » de données, lointains, qui se répètent en
 * écho.
 *
 * Corrompue — tendue, sous pression. La musique se durcit (voix mécanique :
 * modulation en anneau aiguë, grain marqué), descend, se hache de coupures.
 * Dessous, un bourdon grave et dissonant, un battement de cœur sourd, une
 * montée de souffle qui revient sans cesse, un sifflement aigu inquiétant.
 *
 * Le passage d'un état à l'autre est un fondu. Aucun effet de « tremblement »
 * (volume ou hauteur battus vite) : il gênait l'écoute.
 *
 * Réglages : `launcher.ambiance` (marche/arrêt) et `launcher.volume` (0 → 100).
 * La musique se tait pendant une partie, et quand le launcher est réduit.
 */

const TRACK = 'assets/audio/ambiance2.ogg';

/** Volume maximal réel (100 % du réglage) : une ambiance, pas un concert. */
const MASTER_MAX = 0.6;
/** Constante de temps des fondus, en secondes. */
const FADE = 1.2;

/** Les deux remix. Les niveaux des couches ajoutées sont dans `layers`. */
const PROFILES = {
  creatrice: {
    dry: 0.72, ring: 0, ringHz: 420, comb: 0.16, feedback: 0.42, crush: 0.05, steps: 14,
    rate: 0.94, cutoff: 2900, reverb: 0.5, glitch: false,
    layers: { pad: 0.045, blips: 1, drone: 0, heart: 0, riser: 0, whistle: 0 },
  },
  corrompue: {
    dry: 0.46, ring: 0.3, ringHz: 290, comb: 0.42, feedback: 0.7, crush: 0.28, steps: 7,
    rate: 0.9, cutoff: 3800, reverb: 0.24, glitch: true,
    layers: { pad: 0, blips: 0, drone: 0.11, heart: 1, riser: 0.05, whistle: 0.012 },
  },
};

/** Courbe en escalier : le signal ne prend plus que `steps` valeurs. */
function staircase(steps) {
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.round(x * steps) / steps;
  }
  return curve;
}

/** Réponse impulsionnelle d'une grande salle : du bruit qui s'éteint. */
function impulse(ctx, seconds = 3.6) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2.6;
  }
  return buffer;
}

/** Gamme des « pings » de la simulation : la mineure pentatonique, en haut. */
const PINGS = [880, 1046.5, 1174.7, 1318.5, 1568, 1760];

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
  let nodes = null;
  let enabled = false;
  let silenced = false;
  let volume = 0.4;
  let etat = 'creatrice';
  const timers = new Set();

  const audio = new Audio(TRACK);
  audio.loop = true;
  audio.preload = 'auto';
  // Le ralenti doit aussi faire descendre la hauteur.
  audio.preservesPitch = false;

  const playing = () => enabled && !silenced && volume > 0;

  /** Une minuterie qui se replanifie, annulée à la fermeture. */
  function every(fn, delay) {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, delay);
    timers.add(id);
  }

  /** La chaîne n'est construite qu'au premier besoin : aucun coût si la musique est coupée. */
  function build() {
    ctx = new AudioContext();
    const music = ctx.createMediaElementSource(audio);

    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    // Réverbération partagée : la musique et les couches y passent.
    const reverb = ctx.createConvolver();
    reverb.buffer = impulse(ctx);
    const reverbWet = ctx.createGain();
    reverb.connect(reverbWet).connect(master);

    // --- la musique remixée
    const bus = ctx.createGain(); // reçoit les coupures « glitch »
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.Q.value = 0.6;
    bus.connect(tone);
    tone.connect(master);
    tone.connect(reverb);

    const dry = ctx.createGain();
    music.connect(dry).connect(bus);

    // Modulation en anneau (voix mécanique) : un gain dont la valeur EST une sinusoïde aiguë.
    const ring = ctx.createGain();
    ring.gain.value = 0;
    const carrier = ctx.createOscillator();
    carrier.connect(ring.gain);
    carrier.start();
    const ringWet = ctx.createGain();
    music.connect(ring).connect(ringWet).connect(bus);

    // Filtre en peigne : un écho très court, réinjecté, qui ondule à peine.
    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = 0.007;
    const feedback = ctx.createGain();
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.1;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.0004;
    lfo.connect(lfoDepth).connect(delay.delayTime);
    lfo.start();
    const combWet = ctx.createGain();
    music.connect(delay);
    delay.connect(feedback).connect(delay);
    delay.connect(combWet).connect(bus);

    // Quantification : le grain numérique.
    const crusher = ctx.createWaveShaper();
    const crushWet = ctx.createGain();
    music.connect(crusher).connect(crushWet).connect(bus);

    // --- couche « simulation » : une nappe d'accords (la mineur 9), très douce
    const pad = ctx.createGain();
    pad.gain.value = 0;
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 1400;
    pad.connect(padFilter);
    padFilter.connect(master);
    padFilter.connect(reverb);
    for (const [f, detune] of [[220, -4], [261.6, 3], [329.6, -2], [392, 5], [493.9, -3]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.detune.value = detune;
      o.connect(pad);
      o.start();
    }

    // Les « pings » de données : envoyés dans un écho et dans la réverbération.
    const pingBus = ctx.createGain();
    const echo = ctx.createDelay(1);
    echo.delayTime.value = 0.42;
    const echoBack = ctx.createGain();
    echoBack.gain.value = 0.45;
    pingBus.connect(master);
    pingBus.connect(reverb);
    pingBus.connect(echo);
    echo.connect(echoBack).connect(echo);
    echo.connect(reverb);
    echo.connect(master);

    // --- couches « pression » : bourdon dissonant, cœur, souffle, sifflement
    const drone = ctx.createGain();
    drone.gain.value = 0;
    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 220;
    drone.connect(droneFilter).connect(master);
    for (const f of [41.2, 61.7, 58.3]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(drone);
      o.start();
    }

    const heart = ctx.createGain();
    heart.gain.value = 0;
    heart.connect(master);

    const riser = ctx.createGain();
    riser.gain.value = 0;
    const riserFilter = ctx.createBiquadFilter();
    riserFilter.type = 'bandpass';
    riserFilter.Q.value = 1.4;
    const noise = ctx.createBufferSource();
    const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i += 1) nd[i] = Math.random() * 2 - 1;
    noise.buffer = nb;
    noise.loop = true;
    noise.connect(riserFilter).connect(riser).connect(master);
    noise.start();

    const whistle = ctx.createGain();
    whistle.gain.value = 0;
    for (const f of [1760, 1864.7]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.connect(whistle);
      o.start();
    }
    whistle.connect(reverb);

    nodes = {
      master, bus, tone, dry, carrier, ringWet, feedback, combWet, crusher, crushWet, reverbWet,
      pad, pingBus, drone, heart, riser, riserFilter, whistle,
    };
    applyProfile(true);
    scheduleBlips();
    scheduleHeart();
    scheduleRiser();
    scheduleGlitch();
  }

  function applyProfile(instant = false) {
    if (!nodes) return;
    const p = PROFILES[etat];
    const t = ctx.currentTime;
    const set = (param, value) => (instant ? (param.value = value) : param.setTargetAtTime(value, t, FADE / 3));
    set(nodes.dry.gain, p.dry);
    set(nodes.ringWet.gain, p.ring);
    set(nodes.carrier.frequency, p.ringHz);
    set(nodes.combWet.gain, p.comb);
    set(nodes.feedback.gain, p.feedback);
    set(nodes.crushWet.gain, p.crush);
    set(nodes.tone.frequency, p.cutoff);
    set(nodes.reverbWet.gain, p.reverb);
    set(nodes.pad.gain, p.layers.pad);
    set(nodes.drone.gain, p.layers.drone);
    set(nodes.whistle.gain, p.layers.whistle);
    nodes.crusher.curve = staircase(p.steps);
    audio.playbackRate = p.rate;
  }

  /** Créatrice : de temps en temps, une à trois notes de données. */
  function scheduleBlips() {
    every(() => {
      if (nodes && playing() && PROFILES[etat].layers.blips) {
        const t = ctx.currentTime;
        const n = 1 + Math.floor(Math.random() * 3);
        for (let k = 0; k < n; k += 1) {
          const o = ctx.createOscillator();
          o.type = 'sine';
          o.frequency.value = PINGS[Math.floor(Math.random() * PINGS.length)];
          const env = ctx.createGain();
          const at = t + k * 0.16;
          env.gain.setValueAtTime(0.0001, at);
          env.gain.exponentialRampToValueAtTime(0.035, at + 0.01);
          env.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
          o.connect(env).connect(nodes.pingBus);
          o.start(at);
          o.stop(at + 0.55);
        }
      }
      scheduleBlips();
    }, 2500 + Math.random() * 4500);
  }

  /** Corrompue : un battement de cœur sourd, deux coups, un peu trop rapide. */
  function scheduleHeart() {
    every(() => {
      if (nodes && playing() && PROFILES[etat].layers.heart) {
        const t = ctx.currentTime;
        for (const [at, g] of [[0, 0.32], [0.24, 0.2]]) {
          const o = ctx.createOscillator();
          o.type = 'sine';
          o.frequency.setValueAtTime(70, t + at);
          o.frequency.exponentialRampToValueAtTime(34, t + at + 0.18);
          const env = ctx.createGain();
          env.gain.setValueAtTime(0.0001, t + at);
          env.gain.exponentialRampToValueAtTime(g, t + at + 0.012);
          env.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.26);
          o.connect(env).connect(nodes.heart);
          o.start(t + at);
          o.stop(t + at + 0.3);
        }
        nodes.heart.gain.setTargetAtTime(1, t, 0.05);
      } else if (nodes) {
        nodes.heart.gain.setTargetAtTime(0, ctx.currentTime, 0.2);
      }
      scheduleHeart();
    }, 1050);
  }

  /** Corrompue : un souffle qui monte pendant huit secondes, puis recommence. */
  function scheduleRiser() {
    every(() => {
      if (nodes && playing()) {
        const t = ctx.currentTime;
        const level = PROFILES[etat].layers.riser;
        nodes.riserFilter.frequency.cancelScheduledValues(t);
        nodes.riserFilter.frequency.setValueAtTime(180, t);
        nodes.riserFilter.frequency.exponentialRampToValueAtTime(2400, t + 8);
        nodes.riser.gain.cancelScheduledValues(t);
        nodes.riser.gain.setValueAtTime(0.0001, t);
        if (level > 0) {
          nodes.riser.gain.exponentialRampToValueAtTime(level, t + 7.6);
          nodes.riser.gain.exponentialRampToValueAtTime(0.0001, t + 8.4);
        }
      }
      scheduleRiser();
    }, 8500);
  }

  /** Corrompue : des coupures brèves, à intervalles irréguliers. */
  function scheduleGlitch() {
    every(() => {
      if (nodes && playing() && PROFILES[etat].glitch) {
        const t = ctx.currentTime;
        const g = nodes.bus.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(1, t);
        let at = t;
        const cuts = 1 + Math.floor(Math.random() * 3);
        for (let k = 0; k < cuts; k += 1) {
          const off = 0.04 + Math.random() * 0.08;
          g.setValueAtTime(0.05, at);
          g.setValueAtTime(1, at + off);
          at += off + 0.03 + Math.random() * 0.06;
        }
      }
      scheduleGlitch();
    }, 2500 + Math.random() * 6000);
  }

  async function update() {
    if (playing()) {
      if (!ctx) build();
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      if (audio.paused) audio.play().catch(() => {});
      nodes.master.gain.setTargetAtTime(volume * MASTER_MAX, ctx.currentTime, 0.6);
      return;
    }
    if (!ctx) return;
    nodes.master.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
    // On attend la fin du fondu avant de mettre en pause : pas de coupure sèche.
    every(() => {
      if (!playing()) audio.pause();
    }, 1800);
  }

  // Si le navigateur a refusé de démarrer sans geste, le premier clic suffit.
  const unlock = () => {
    if (ctx?.state === 'suspended' && playing()) ctx.resume().catch(() => {});
  };
  window.addEventListener('pointerdown', unlock);

  return {
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
      applyProfile();
    },
    setSilenced(value) {
      silenced = Boolean(value);
      update();
    },
    dispose() {
      for (const id of timers) clearTimeout(id);
      timers.clear();
      window.removeEventListener('pointerdown', unlock);
      audio.pause();
      ctx?.close().catch(() => {});
    },
  };
}
