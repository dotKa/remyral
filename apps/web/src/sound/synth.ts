/**
 * p9-notification-sound (docs/design/p9-notification-sound.md §2): the console's "robotic" chimes, synthesised with
 * the Web Audio API at play time — no audio file, no fetch, nothing for the CSP to allow.
 *
 * Each beep: a square / sawtooth oscillator with a short upward glide → a stepped wave shaper (bit-crush) →
 * amplitude modulation by a sine at an inharmonic ratio of the pitch (the ring-mod "robot" colour) → an envelope
 * with a few-millisecond attack and release (no clicks) → a shared low-pass filter (takes the edge off) → the
 * volume gain → the speakers. Three variants differ in rhythm, pitch steps and wave so they are told apart by ear.
 */

export type SoundVariant = 'message' | 'notification' | 'urgent';

export interface Beep {
  /** Start, seconds after the chime starts. */
  readonly at: number;
  /** Length in seconds (attack + hold + release). */
  readonly dur: number;
  /** Pitch at the start (Hz); glides to `freq * glide` over the beep. */
  readonly freq: number;
  readonly glide: number;
}

export interface Pattern {
  readonly wave: OscillatorType;
  /** Modulator frequency as a multiple of the beep's pitch (inharmonic = metallic, "robotic"). */
  readonly modRatio: number;
  /** Relative loudness (the urgent chime is a little louder). */
  readonly gain: number;
  readonly beeps: readonly Beep[];
}

export const PATTERNS: Readonly<Record<SoundVariant, Pattern>> = {
  // Chat message: two rising blips (~300 ms).
  message: {
    wave: 'square',
    modRatio: 0.5,
    gain: 0.9,
    beeps: [
      { at: 0, dur: 0.1, freq: 880, glide: 1.06 },
      { at: 0.14, dur: 0.16, freq: 1175, glide: 1.03 },
    ],
  },
  // In-app notification: three stepped beeps, up a fourth then an octave (~360 ms).
  notification: {
    wave: 'square',
    modRatio: 0.71,
    gain: 1,
    beeps: [
      { at: 0, dur: 0.08, freq: 659, glide: 1.02 },
      { at: 0.11, dur: 0.08, freq: 880, glide: 1.02 },
      { at: 0.22, dur: 0.14, freq: 1319, glide: 0.97 },
    ],
  },
  // Approval waiting: four fast alternating sawtooth beeps (~460 ms) — the "act on this" one.
  urgent: {
    wave: 'sawtooth',
    modRatio: 1.41,
    gain: 1.15,
    beeps: [
      { at: 0, dur: 0.08, freq: 1047, glide: 1 },
      { at: 0.1, dur: 0.08, freq: 784, glide: 1 },
      { at: 0.2, dur: 0.08, freq: 1047, glide: 1 },
      { at: 0.3, dur: 0.16, freq: 1397, glide: 1.04 },
    ],
  },
};

/** Peak output at volume 100 (moderate: square waves are loud). */
export const PEAK = 0.22;
const ATTACK = 0.006;
const RELEASE = 0.025;
const CRUSH_STEPS = 8;

/** Length of a variant's chime in seconds. */
export function chimeDuration(variant: SoundVariant): number {
  return Math.max(...PATTERNS[variant].beeps.map((b) => b.at + b.dur));
}

/** Volume 0..100 → peak gain (squared: a slider feels even to the ear). */
export function peakGain(volume: number, variant: SoundVariant): number {
  const v = Math.min(100, Math.max(0, Number.isFinite(volume) ? volume : 0)) / 100;
  return PEAK * v * v * PATTERNS[variant].gain;
}

let crushCurve: Float32Array<ArrayBuffer> | null = null;

/** A staircase transfer curve: the signal is quantised to a few levels (the bit-crushed edge). */
export function bitCrushCurve(): Float32Array<ArrayBuffer> {
  if (crushCurve) return crushCurve;
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.round(x * CRUSH_STEPS) / CRUSH_STEPS;
  }
  crushCurve = curve;
  return curve;
}

/**
 * Schedules one chime on `ctx` starting now. Returns the chime length in seconds. All nodes are disconnected when the
 * last oscillator ends. Does nothing (returns 0) at volume 0.
 */
export function playChime(ctx: BaseAudioContext, variant: SoundVariant, volume: number): number {
  const pattern = PATTERNS[variant];
  const peak = peakGain(volume, variant);
  if (peak <= 0) return 0;
  const t0 = ctx.currentTime + 0.01;
  const master = ctx.createGain();
  master.gain.setValueAtTime(peak, t0);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(3800, t0);
  filter.Q.setValueAtTime(0.7, t0);
  filter.connect(master);
  master.connect(ctx.destination);
  const nodes: AudioNode[] = [master, filter];
  let pendingEnds = 0;
  const onEnded = (): void => {
    pendingEnds--;
    if (pendingEnds > 0) return;
    for (const n of nodes) {
      try {
        n.disconnect();
      } catch {
        // already disconnected
      }
    }
  };
  for (const b of pattern.beeps) {
    const start = t0 + b.at;
    const end = start + b.dur;
    const osc = ctx.createOscillator();
    osc.type = pattern.wave;
    osc.frequency.setValueAtTime(b.freq, start);
    osc.frequency.linearRampToValueAtTime(b.freq * b.glide, end);
    const crush = ctx.createWaveShaper();
    crush.curve = bitCrushCurve();
    // AM: gain = 0.5 + 0.5·sin(mod) — full-depth amplitude modulation keeps the pitch and adds side bands.
    const am = ctx.createGain();
    am.gain.setValueAtTime(0.5, start);
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.setValueAtTime(b.freq * pattern.modRatio, start);
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(0.5, start);
    mod.connect(depth);
    depth.connect(am.gain);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(1, start + ATTACK);
    env.gain.setValueAtTime(1, end - RELEASE);
    env.gain.linearRampToValueAtTime(0, end);
    osc.connect(crush);
    crush.connect(am);
    am.connect(env);
    env.connect(filter);
    nodes.push(osc, crush, am, mod, depth, env);
    for (const o of [osc, mod]) {
      pendingEnds++;
      o.onended = onEnded;
      o.start(start);
      o.stop(end + 0.01);
    }
  }
  return chimeDuration(variant);
}
