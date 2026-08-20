/**
 * Piano — physically-motivated additive synthesis, pre-rendered to wavetables.
 *
 * Synthesising a piano note live would cost ~24 oscillator nodes (two unison
 * strings x twelve inharmonic partials). At ten notes a second with long decay
 * tails that is hundreds of live nodes, which is not something to hand a
 * rhythm game's audio thread. Instead each note is rendered once into a raw
 * Float32Array at startup and played back as a single buffer source.
 *
 * The model covers the four things that actually make a piano sound like one:
 *
 *   inharmonicity  real strings are stiff, so partials land slightly sharp of
 *                  the harmonic series — steeply so in the bass. Without this
 *                  you get an organ.
 *   strike notch   the hammer hits about an eighth of the way along, which
 *                  suppresses every eighth partial.
 *   split decay    a fast initial decay over a slow aftersound, rather than
 *                  one exponential.
 *   unison beating two strings a couple of cents apart give the slow shimmer.
 *
 * Rendering uses a two-term sinusoid recurrence rather than Math.sin per
 * sample, which is roughly an order of magnitude faster and keeps the whole
 * bank under a few hundred milliseconds.
 */

const A4 = 440;
const midiToHz = (m: number) => A4 * Math.pow(2, (m - 69) / 12);

/** Lowest and highest notes the bank covers, and the spacing between roots. */
const LOW_MIDI = 28;
const HIGH_MIDI = 100;
const ROOT_STEP = 6;

export interface PianoVoiceOptions {
  /** 0..1 — harder strikes are brighter and louder, as on a real action. */
  velocity: number;
}

/**
 * Render one note into a mono Float32Array.
 * Exported so the tuning can be exercised from a test harness.
 */
export function renderPianoNote(
  sampleRate: number,
  midi: number,
  velocity = 0.8,
): Float32Array {
  const f0 = midiToHz(midi);
  const nyquist = sampleRate / 2;

  // Bass strings are short relative to their pitch, so they are much stiffer.
  const bassness = Math.max(0, (60 - midi) / 60);
  const B = 0.00028 + Math.pow(bassness, 3) * 0.0085;

  // High notes die quickly; bass notes ring. No point rendering silence — and
  // capping the bass keeps the whole bank inside a second of render time.
  const seconds = Math.min(3.0, Math.max(0.85, 3.6 - (midi - LOW_MIDI) * 0.038));
  const length = Math.floor(sampleRate * seconds);
  // Accumulate in float64: writing float32 in the inner loop costs a rounding
  // step per sample per partial, which is the hot path here.
  const acc = new Float64Array(length);

  const partialCount = Math.min(14, Math.max(5, Math.floor(1400 / (f0 / 10))));
  // Hammer strikes ~1/8 along the string, notching every 8th partial.
  const strikePos = 1 / 8;

  // Two strings per note, a couple of cents apart, for the unison beat.
  const unison = [-1.7, 1.9];

  for (const cents of unison) {
    const detune = Math.pow(2, cents / 1200);

    for (let n = 1; n <= partialCount; n++) {
      const fn = n * f0 * Math.sqrt(1 + B * n * n) * detune;
      if (fn >= nyquist * 0.92) break;

      // amplitude: rolloff, strike notch, and a brightness tilt from velocity
      const notch = Math.abs(Math.sin(Math.PI * n * strikePos));
      const tilt = Math.pow(velocity, 0.6 + n * 0.06);
      let amp = (1 / Math.pow(n, 1.18)) * notch * tilt;
      if (amp < 0.0006) continue;
      amp /= unison.length;

      // split decay: a fast component over a slow aftersound
      const baseFast = (0.42 + bassness * 1.5) / (1 + (n - 1) * 0.62);
      const baseSlow = baseFast * 3.4;
      const kFast = Math.exp(-1 / (baseFast * sampleRate));
      const kSlow = Math.exp(-1 / (baseSlow * sampleRate));
      let eFast = 0.74;
      let eSlow = 0.26;

      // sinusoid recurrence: s[k] = 2cos(w)s[k-1] - s[k-2]
      const w = (2 * Math.PI * fn) / sampleRate;
      const coeff = 2 * Math.cos(w);
      const phase = Math.random() * Math.PI * 2;
      let s2 = Math.sin(phase - w);
      let s1 = Math.sin(phase);

      // Precompute where this partial becomes inaudible rather than testing
      // the envelope sum on every sample.
      const audibleUntil = Math.min(
        length,
        Math.ceil(Math.log(1e-4 / (amp || 1e-9)) / Math.log(kSlow)),
      );
      for (let i = 0; i < audibleUntil; i++) {
        const s = coeff * s1 - s2;
        s2 = s1;
        s1 = s;
        acc[i] += amp * (eFast + eSlow) * s;
        eFast *= kFast;
        eSlow *= kSlow;
      }
    }
  }

  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = acc[i];

  /* ---- hammer thump: a short filtered noise burst at the attack ---- */
  const thumpLen = Math.floor(sampleRate * 0.028);
  let lp = 0;
  const thumpCut = Math.min(0.65, 0.12 + (f0 / nyquist) * 6);
  const thumpGain = 0.16 * velocity * (0.5 + bassness);
  for (let i = 0; i < thumpLen && i < length; i++) {
    const env = Math.pow(1 - i / thumpLen, 2.5);
    lp += ((Math.random() * 2 - 1) - lp) * thumpCut;
    out[i] += lp * env * thumpGain;
  }

  /* ---- attack ramp so the buffer never starts on a discontinuity ---- */
  const ramp = Math.floor(sampleRate * 0.0022);
  for (let i = 0; i < ramp && i < length; i++) out[i] *= i / ramp;

  /* ---- normalise, then a gentle soft-clip for body ---- */
  let peak = 0;
  for (let i = 0; i < length; i++) {
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
  }
  if (peak > 0) {
    const norm = 0.86 / peak;
    for (let i = 0; i < length; i++) out[i] = Math.tanh(out[i] * norm * 1.08) * 0.92;
  }

  /* ---- release fade so the tail cannot click ---- */
  const fade = Math.floor(sampleRate * 0.05);
  for (let i = 0; i < fade; i++) {
    out[length - 1 - i] *= i / fade;
  }

  return out;
}

/**
 * A bank of pre-rendered notes. Playback picks the nearest rendered root and
 * shifts by at most a couple of semitones, which is inaudible as a timbre
 * change but saves rendering all 72 notes.
 */
export class PianoBank {
  private ctx: BaseAudioContext;
  private buffers = new Map<number, AudioBuffer>();
  private roots: number[] = [];
  ready = false;

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    for (let m = LOW_MIDI; m <= HIGH_MIDI; m += ROOT_STEP) this.roots.push(m);
  }

  /** Renders the whole bank, yielding between notes so the UI never janks. */
  async build(onProgress?: (done: number, total: number) => void): Promise<void> {
    if (this.ready) return;
    const total = this.roots.length;
    for (let i = 0; i < total; i++) {
      const midi = this.roots[i];
      const data = renderPianoNote(this.ctx.sampleRate, midi, 0.85);
      const buf = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
      // set() rather than copyToChannel(): it sidesteps the Float32Array
      // ArrayBuffer/SharedArrayBuffer generic mismatch in the DOM lib.
      buf.getChannelData(0).set(data);
      this.buffers.set(midi, buf);
      onProgress?.(i + 1, total);
      // Hand the frame back so the title screen keeps animating.
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    this.ready = true;
  }

  private nearestRoot(midi: number): number {
    let best = this.roots[0];
    let bestD = Infinity;
    for (const r of this.roots) {
      const d = Math.abs(r - midi);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best;
  }

  /**
   * Schedule a note. `damp` cuts the tail short, the way lifting a finger with
   * no sustain pedal would.
   */
  play(
    destination: AudioNode,
    when: number,
    midi: number,
    gain: number,
    damp = 0,
  ): AudioBufferSourceNode | null {
    const clamped = Math.min(HIGH_MIDI + 4, Math.max(LOW_MIDI - 4, midi));
    const root = this.nearestRoot(clamped);
    const buf = this.buffers.get(root);
    if (!buf) return null;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.pow(2, (clamped - root) / 12);

    const g = (this.ctx as AudioContext).createGain();
    g.gain.value = gain;

    if (damp > 0) {
      const end = when + damp;
      g.gain.setValueAtTime(gain, end);
      g.gain.exponentialRampToValueAtTime(0.0001, end + 0.14);
      src.stop(end + 0.18);
    }

    src.connect(g);
    g.connect(destination);
    src.start(when);
    return src;
  }
}
