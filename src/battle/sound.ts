// Geräusche ohne Audiodateien: alles wird mit der Web Audio API erzeugt. Der Kontext entsteht
// erst beim ersten Klick (Start), weil Browser Ton ohne Nutzeraktion sperren.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = true;

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  if (master) master.gain.value = on ? 0.55 : 0;
}

/** Muss aus einem Klick heraus aufgerufen werden. */
export function unlockAudio(): void {
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = enabled ? 0.55 : 0;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

function ready(): AudioContext | null {
  if (!ctx || !master || !enabled || ctx.state !== 'running') return null;
  return ctx;
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'triangle', gain = 0.3, slideTo?: number): void {
  const c = ready();
  if (!c || !master) return;
  const osc = c.createOscillator();
  const g = c.createGain();
  const t = c.currentTime + start;
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

function noise(start: number, dur: number, gain = 0.2, freq = 1800): void {
  const c = ready();
  if (!c || !master) return;
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buffer = c.createBuffer(1, len, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  const g = c.createGain();
  const t = c.currentTime + start;
  g.gain.setValueAtTime(gain, t);
  src.connect(filter).connect(g).connect(master);
  src.start(t);
}

// Tonleiter je Seltenheit: seltener = höher und mehr Töne
const SCALE = [392, 440, 523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.5];

export const sfx = {
  start(): void {
    tone(220, 0, 0.18, 'square', 0.12);
    tone(330, 0.1, 0.18, 'square', 0.12);
    tone(440, 0.2, 0.3, 'square', 0.12);
  },
  /** Trommelwirbel, der schneller wird, während die Kiste wackelt. */
  shake(): void {
    let t = 0;
    for (let i = 0; i < 14; i++) {
      noise(t, 0.05, 0.12 + i * 0.012, 900 + i * 60);
      t += Math.max(0.04, 0.11 - i * 0.006);
    }
  },
  reveal(rank: number): void {
    noise(0, 0.25, 0.25, 3000);
    const notes = 2 + Math.max(0, rank);
    const base = Math.max(0, rank);
    for (let i = 0; i < notes; i++) tone(SCALE[Math.min(SCALE.length - 1, base + i)], 0.05 + i * 0.07, 0.35, 'triangle', 0.22);
    if (rank >= 4) {
      tone(SCALE[base] / 2, 0.05, 1.2, 'sawtooth', 0.08);
      tone(SCALE[Math.min(SCALE.length - 1, base + notes)], 0.05 + notes * 0.07, 0.9, 'sine', 0.25);
    }
  },
  point(): void {
    tone(880, 0, 0.12, 'square', 0.12);
    tone(1318.5, 0.09, 0.32, 'square', 0.12);
  },
  tie(): void {
    tone(196, 0, 0.25, 'sine', 0.25, 150);
    tone(185, 0.18, 0.35, 'sine', 0.22, 140);
  },
  victory(): void {
    const seq: [number, number, number][] = [
      [523.25, 0, 0.18],
      [659.25, 0.16, 0.18],
      [783.99, 0.32, 0.18],
      [1046.5, 0.48, 0.5],
      [783.99, 0.9, 0.16],
      [1046.5, 1.05, 0.9],
    ];
    for (const [f, s, d] of seq) {
      tone(f, s, d, 'square', 0.1);
      tone(f / 2, s, d, 'triangle', 0.14);
    }
    noise(1.05, 0.6, 0.12, 5000);
  },
};
