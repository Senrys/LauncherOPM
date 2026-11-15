/**
 * La musique de Xenodys.
 *
 * Deux pistes du site, jouées en boucle : `ambiance2` (la musique) et `wave`
 * (la mer), plus discrète, dessous. La musique passe par une chaîne Web Audio
 * qui lui donne une voix MÉCANIQUE — celle de Xenodys :
 *
 *   - modulation en anneau (la musique multipliée par une sinusoïde aiguë,
 *     quelques centaines de hertz) : le timbre métallique d'une voix de robot.
 *     Grave (sous ~100 Hz), elle s'entendrait comme un tremblement ;
 *   - filtre en peigne (un écho de quelques millisecondes, réinjecté, dont la
 *     longueur ondule) : une résonance de machine ;
 *   - quantification (« bitcrusher ») : le grain numérique ;
 *   - un léger ralenti : la musique descend, plus grave ;
 *   - le tout mêlé au son d'origine, qui reste reconnaissable ;
 *   - et dessous, le bourdonnement grave de la machine.
 *
 * Corrompue, la machine prend le dessus : plus d'anneau, plus de grain, la
 * musique ralentit et descend, et des coupures brèves la hachent.
 *
 * Réglages : `launcher.ambiance` (marche/arrêt) et `launcher.volume` (0 → 100).
 * La musique se tait pendant une partie, et quand le launcher est réduit.
 */

const TRACKS = {
  music: 'assets/audio/ambiance2.ogg',
  sea: 'assets/audio/wave.ogg',
};

/** Part de la mer dans le mélange : un murmure, loin sous la musique. */
const SEA_LEVEL = 0.12;
/** Volume maximal réel (100 % du réglage) : une ambiance, pas un concert. */
const MASTER_MAX = 0.6;
/** Constante de temps des fondus, en secondes. */
const FADE = 0.6;

/** Les deux visages de la chaîne. */
const PROFILES = {
  creatrice: {
    dry: 0.55, ring: 0.26, ringHz: 420, comb: 0.4, feedback: 0.6, crush: 0.14, steps: 12,
    rate: 0.97, cutoff: 7600, hum: 0.06, humHz: [55, 82.5], glitch: false,
  },
  corrompue: {
    dry: 0.4, ring: 0.4, ringHz: 290, comb: 0.48, feedback: 0.72, crush: 0.3, steps: 7,
    rate: 0.92, cutoff: 4600, hum: 0.1, humHz: [52, 77.6], glitch: true,
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
  let glitchTimer = 0;

  const elements = {};
  for (const [name, src] of Object.entries(TRACKS)) {
    const audio = new Audio(src);
    audio.loop = true;
    audio.preload = 'auto';
    elements[name] = audio;
  }

  /** La chaîne n'est construite qu'au premier besoin : aucun coût si la musique est coupée. */
  function build() {
    ctx = new AudioContext();
    const music = ctx.createMediaElementSource(elements.music);
    const sea = ctx.createMediaElementSource(elements.sea);

    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    // --- musique
    const bus = ctx.createGain(); // reçoit les coupures « glitch »
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.Q.value = 0.7;
    bus.connect(tone).connect(master);

    // Le bourdonnement de la machine : deux scies graves, très filtrées.
    const humGain = ctx.createGain();
    humGain.gain.value = 0;
    const humFilter = ctx.createBiquadFilter();
    humFilter.type = 'lowpass';
    humFilter.frequency.value = 240;
    humFilter.connect(humGain).connect(master);
    const hums = [0, 1].map(() => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.connect(humFilter);
      o.start();
      return o;
    });

    const dry = ctx.createGain();
    music.connect(dry).connect(bus);

    // Modulation en anneau : un gain dont la valeur EST une sinusoïde.
    const ring = ctx.createGain();
    ring.gain.value = 0;
    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.connect(ring.gain);
    carrier.start();
    const ringWet = ctx.createGain();
    music.connect(ring).connect(ringWet).connect(bus);

    // Filtre en peigne : un écho très court, réinjecté, qui ondule.
    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = 0.007;
    const feedback = ctx.createGain();
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13;
    const lfoDepth = ctx.createGain();
    // Ondulation très faible : plus forte, elle fait « trembler » la hauteur.
    lfoDepth.gain.value = 0.0004;
    lfo.connect(lfoDepth).connect(delay.delayTime);
    lfo.start();
    const combWet = ctx.createGain();
    music.connect(delay);
    delay.connect(feedback).connect(delay);
    delay.connect(combWet).connect(bus);

    // Quantification.
    const crusher = ctx.createWaveShaper();
    crusher.curve = staircase(14);
    const crushWet = ctx.createGain();
    music.connect(crusher).connect(crushWet).connect(bus);

    // --- la mer, telle quelle
    const seaGain = ctx.createGain();
    seaGain.gain.value = SEA_LEVEL;
    sea.connect(seaGain).connect(master);

    nodes = { master, bus, tone, dry, carrier, ringWet, feedback, combWet, crusher, crushWet, humGain, hums };
    applyProfile(true);
  }

  function applyProfile(instant = false) {
    if (!nodes) return;
    const p = PROFILES[etat];
    const t = ctx.currentTime;
    const set = (param, value) => (instant ? (param.value = value) : param.setTargetAtTime(value, t, FADE));
    set(nodes.dry.gain, p.dry);
    set(nodes.ringWet.gain, p.ring);
    set(nodes.carrier.frequency, p.ringHz);
    set(nodes.combWet.gain, p.comb);
    set(nodes.feedback.gain, p.feedback);
    set(nodes.crushWet.gain, p.crush);
    set(nodes.tone.frequency, p.cutoff);
    set(nodes.humGain.gain, p.hum);
    nodes.hums.forEach((o, i) => set(o.frequency, p.humHz[i]));
    nodes.crusher.curve = staircase(p.steps);
    elements.music.playbackRate = p.rate;
    // Le ralenti doit aussi faire descendre la hauteur : la voix devient grave.
    elements.music.preservesPitch = false;
    scheduleGlitch();
  }

  /** Corrompue : des coupures brèves, à intervalles irréguliers. */
  function scheduleGlitch() {
    clearTimeout(glitchTimer);
    if (!nodes || !PROFILES[etat].glitch) return;
    glitchTimer = setTimeout(() => {
      if (!nodes || !playing()) return scheduleGlitch();
      const t = ctx.currentTime;
      const g = nodes.bus.gain;
      const cuts = 1 + Math.floor(Math.random() * 3);
      g.cancelScheduledValues(t);
      g.setValueAtTime(1, t);
      let at = t;
      for (let k = 0; k < cuts; k += 1) {
        const off = 0.04 + Math.random() * 0.08;
        g.setValueAtTime(0.05, at);
        g.setValueAtTime(1, at + off);
        at += off + 0.03 + Math.random() * 0.06;
      }
      scheduleGlitch();
    }, 2500 + Math.random() * 6000);
  }

  const playing = () => enabled && !silenced && volume > 0;

  async function update() {
    if (playing()) {
      if (!ctx) build();
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      for (const audio of Object.values(elements)) {
        if (audio.paused) audio.play().catch(() => {});
      }
      nodes.master.gain.setTargetAtTime(volume * MASTER_MAX, ctx.currentTime, FADE);
      return;
    }
    if (!ctx) return;
    nodes.master.gain.setTargetAtTime(0, ctx.currentTime, FADE / 2);
    // On attend la fin du fondu avant de mettre en pause : pas de coupure sèche.
    setTimeout(() => {
      if (playing()) return;
      for (const audio of Object.values(elements)) audio.pause();
    }, FADE * 3000);
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
      clearTimeout(glitchTimer);
      window.removeEventListener('pointerdown', unlock);
      for (const audio of Object.values(elements)) audio.pause();
      ctx?.close().catch(() => {});
    },
  };
}
