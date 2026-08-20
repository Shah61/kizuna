/**
 * SynthEngine — every sound in the game, built from oscillators and noise.
 *
 * There are no audio files anywhere in this project. Drums are pitch-enveloped
 * sines plus filtered noise; the koto is additive synthesis with per-partial
 * decay; the shakuhachi is a breathy sine with delayed vibrato; bells use
 * inharmonic partial ratios. Everything shares one generated convolution
 * reverb so the mix sits in a single room.
 *
 * Voices are fire-and-forget: each call builds its nodes, schedules them
 * against the AudioContext clock, and lets them garbage-collect on `ended`.
 * Scheduling ahead of time is the caller's job (see conductor.ts).
 */

import { midiToHz } from '../game/composer';
import { PianoBank } from './piano';

export interface MixLevels {
  master: number;
  music: number;
  sfx: number;
}

export class SynthEngine {
  readonly ctx: AudioContext;

  private masterGain: GainNode;
  private musicGain: GainNode;
  private sfxGain: GainNode;
  private reverbSend: GainNode;
  private convolver: ConvolverNode;
  private compressor: DynamicsCompressorNode;
  /** Reused noise source buffer — allocating one per hi-hat would thrash GC. */
  private noiseBuffer: AudioBuffer;
  private started = false;

  /** Pre-rendered piano wavetables, plus the bus they play into. */
  private pianoBank: PianoBank;
  private pianoBus: GainNode;

  /** Imported tracks play dry through here — no synth reverb on real audio. */
  private trackBus: GainNode;
  private trackSource: AudioBufferSourceNode | null = null;

  constructor() {
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;

    this.ctx = new Ctor({ latencyHint: 'interactive' });

    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.knee.value = 22;
    this.compressor.ratio.value = 5;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.16;

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.85;

    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.8;

    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 0.75;

    this.convolver = this.ctx.createConvolver();
    this.convolver.buffer = this.makeImpulse(2.4, 2.6);

    this.reverbSend = this.ctx.createGain();
    this.reverbSend.gain.value = 1;

    const reverbReturn = this.ctx.createGain();
    reverbReturn.gain.value = 0.62;

    // Roll the top off the tail so reverb never gets hissy.
    const tailTone = this.ctx.createBiquadFilter();
    tailTone.type = 'lowpass';
    tailTone.frequency.value = 4200;

    this.reverbSend.connect(this.convolver);
    this.convolver.connect(tailTone);
    tailTone.connect(reverbReturn);
    reverbReturn.connect(this.compressor);

    this.musicGain.connect(this.compressor);
    this.sfxGain.connect(this.compressor);
    this.compressor.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);

    this.noiseBuffer = this.makeNoise(2);

    // One persistent bus for the piano: every note is a single buffer source
    // hung off this, rather than building a routing graph per note.
    this.pianoBus = this.ctx.createGain();
    this.pianoBus.gain.value = 1;
    this.connectVoice(this.pianoBus, 0.32);
    this.pianoBank = new PianoBank(this.ctx);

    this.trackBus = this.ctx.createGain();
    this.trackBus.gain.value = 1;
    this.trackBus.connect(this.musicGain);
  }

  /**
   * Play an imported track. Returns the source so the caller can hold it; only
   * one track plays at a time, and starting a new one stops the old.
   */
  playTrack(buffer: AudioBuffer, when: number, offset = 0): AudioBufferSourceNode {
    this.stopTrack();
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.trackBus);
    src.start(when, offset);
    this.trackSource = src;
    return src;
  }

  stopTrack(): void {
    if (!this.trackSource) return;
    try {
      this.trackSource.stop();
    } catch {
      // already stopped — starting a source twice throws, stopping twice does not
    }
    this.trackSource.disconnect();
    this.trackSource = null;
  }

  /**
   * Render the piano wavetables. Costs a few hundred milliseconds, so it runs
   * once behind the title screen rather than at the start of a song.
   */
  async preparePiano(onProgress?: (done: number, total: number) => void): Promise<void> {
    await this.pianoBank.build(onProgress);
  }

  get pianoReady(): boolean {
    return this.pianoBank.ready;
  }

  /* ---------------------------------------------------------------- *
   * lifecycle
   * ---------------------------------------------------------------- */

  /** Browsers require a user gesture before audio starts. Call on first input. */
  async unlock(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (!this.started) {
      // A silent tick forces the graph to spin up before the first real note.
      const g = this.ctx.createGain();
      g.gain.value = 0;
      const o = this.ctx.createOscillator();
      o.connect(g);
      g.connect(this.ctx.destination);
      o.start();
      o.stop(this.ctx.currentTime + 0.02);
      this.started = true;
    }
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  /** Output latency in seconds, used to keep visuals honest about audio time. */
  get outputLatency(): number {
    const c = this.ctx as AudioContext & { outputLatency?: number };
    return c.outputLatency ?? c.baseLatency ?? 0;
  }

  setLevels(levels: Partial<MixLevels>): void {
    const t = this.ctx.currentTime;
    if (levels.master !== undefined)
      this.masterGain.gain.setTargetAtTime(levels.master, t, 0.02);
    if (levels.music !== undefined)
      this.musicGain.gain.setTargetAtTime(levels.music, t, 0.02);
    if (levels.sfx !== undefined)
      this.sfxGain.gain.setTargetAtTime(levels.sfx, t, 0.02);
  }

  /** Fade the music bus, e.g. when a song is aborted mid-play. */
  duckMusic(to: number, seconds: number): void {
    const t = this.ctx.currentTime;
    this.musicGain.gain.cancelScheduledValues(t);
    this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, t);
    this.musicGain.gain.linearRampToValueAtTime(Math.max(0.0001, to), t + seconds);
  }

  /* ---------------------------------------------------------------- *
   * buffers
   * ---------------------------------------------------------------- */

  private makeNoise(seconds: number): AudioBuffer {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Exponentially-decaying stereo noise makes a serviceable hall. */
  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // Slight pre-delay keeps transients readable against the tail.
        const preDelay = i < rate * 0.012 ? 0 : 1;
        data[i] =
          (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * preDelay * 0.7;
      }
    }
    return buf;
  }

  private noiseSource(): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    return src;
  }

  /** Route a voice to the music bus plus a reverb send. */
  private connectVoice(node: AudioNode, send: number, toSfx = false): void {
    node.connect(toSfx ? this.sfxGain : this.musicGain);
    if (send > 0) {
      const s = this.ctx.createGain();
      s.gain.value = send;
      node.connect(s);
      s.connect(this.reverbSend);
    }
  }

  /* ---------------------------------------------------------------- *
   * percussion
   * ---------------------------------------------------------------- */

  /** Big festival drum: fast downward pitch sweep + skin noise. */
  taiko(t: number, gain = 1, midi = 36): void {
    const f0 = midiToHz(midi) * 3.4;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(28, f0 * 0.32), t + 0.09);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain * 0.95, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);

    osc.connect(g);
    this.connectVoice(g, 0.1);
    osc.start(t);
    osc.stop(t + 0.5);

    // skin
    const n = this.noiseSource();
    const nf = this.ctx.createBiquadFilter();
    nf.type = 'lowpass';
    nf.frequency.setValueAtTime(2600, t);
    nf.frequency.exponentialRampToValueAtTime(340, t + 0.07);
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(gain * 0.32, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    n.connect(nf);
    nf.connect(ng);
    this.connectVoice(ng, 0.08);
    n.start(t);
    n.stop(t + 0.14);
  }

  /** Small hand drum — the bright "po" that answers the taiko. */
  kotsuzumi(t: number, midi = 64, gain = 0.5): void {
    const f = midiToHz(midi) * 2;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f * 1.6, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.05);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);

    osc.connect(g);
    this.connectVoice(g, 0.22);
    osc.start(t);
    osc.stop(t + 0.3);
  }

  /** Rim / clave click. */
  rim(t: number, gain = 0.5): void {
    const n = this.noiseSource();
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1900;
    bp.Q.value = 3.4;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    n.connect(bp);
    bp.connect(g);
    this.connectVoice(g, 0.2);
    n.start(t);
    n.stop(t + 0.14);

    const click = this.ctx.createOscillator();
    click.type = 'triangle';
    click.frequency.value = 420;
    const cg = this.ctx.createGain();
    cg.gain.setValueAtTime(gain * 0.5, t);
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    click.connect(cg);
    this.connectVoice(cg, 0.05);
    click.start(t);
    click.stop(t + 0.06);
  }

  hat(t: number, gain = 0.2): void {
    const n = this.noiseSource();
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7200;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    n.connect(hp);
    hp.connect(g);
    this.connectVoice(g, 0.06);
    n.start(t);
    n.stop(t + 0.06);
  }

  /* ---------------------------------------------------------------- *
   * pitched voices
   * ---------------------------------------------------------------- */

  bass(t: number, midi: number, duration: number, gain = 0.6): void {
    const f = midiToHz(midi);
    const saw = this.ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.value = f;
    const sub = this.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = f * 0.5;

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 6;
    lp.frequency.setValueAtTime(Math.min(4200, f * 9), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(90, f * 1.5), t + duration * 0.7);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    const subG = this.ctx.createGain();
    subG.gain.value = 0.55;

    saw.connect(lp);
    lp.connect(g);
    sub.connect(subG);
    subG.connect(g);
    this.connectVoice(g, 0.04);

    saw.start(t);
    sub.start(t);
    saw.stop(t + duration + 0.06);
    sub.stop(t + duration + 0.06);
  }

  /** Slow, wide, heavily reverbed — the bed everything else sits on. */
  pad(t: number, midi: number, duration: number, gain = 0.2): void {
    const f = midiToHz(midi);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + duration * 0.35);
    g.gain.linearRampToValueAtTime(0.0001, t + duration);

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1500;
    lp.Q.value = 0.7;

    for (const detune of [-7, 0, 7]) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = detune;
      const og = this.ctx.createGain();
      og.gain.value = 0.32;
      o.connect(og);
      og.connect(lp);
      o.start(t);
      o.stop(t + duration + 0.2);
    }

    lp.connect(g);
    this.connectVoice(g, 0.85);
  }

  /**
   * Piano. The heavy lifting happened at startup — see piano.ts — so this is
   * just a buffer source with a pitch offset and an optional damper.
   */
  piano(t: number, midi: number, gain = 0.5, damp = 0): void {
    if (!this.pianoBank.ready) {
      // Bank still rendering: fall back so the note is never silent.
      this.koto(t, midi, gain);
      return;
    }
    this.pianoBank.play(this.pianoBus, t, midi, gain, damp);
  }

  /**
   * Koto / shamisen pluck. Additive: higher partials decay faster, which is
   * what makes a plucked string sound plucked rather than organ-like.
   */
  koto(t: number, midi: number, gain = 0.5, sustain = 1): void {
    const f = midiToHz(midi);
    const partials: Array<[ratio: number, amp: number, decay: number]> = [
      [1, 1, 1],
      [2, 0.42, 0.6],
      [3.01, 0.2, 0.42],
      [4.15, 0.1, 0.3],
      [5.4, 0.05, 0.22],
    ];

    const out = this.ctx.createGain();
    out.gain.value = gain * 0.5;

    for (const [ratio, amp, decayScale] of partials) {
      const freq = f * ratio;
      if (freq > 17000) continue;
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq;
      // A touch of downward drift: real strings go slightly flat as they ring.
      o.frequency.exponentialRampToValueAtTime(freq * 0.998, t + 0.4);

      const g = this.ctx.createGain();
      const dur = 1.5 * decayScale * sustain;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(amp, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      o.connect(g);
      g.connect(out);
      o.start(t);
      o.stop(t + dur + 0.05);
    }

    // pick transient
    const n = this.noiseSource();
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = Math.min(9000, f * 5);
    bp.Q.value = 1.2;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(gain * 0.3, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(out);
    n.start(t);
    n.stop(t + 0.05);

    this.connectVoice(out, 0.34);
  }

  /** Breathy bamboo flute for held notes. */
  shakuhachi(t: number, midi: number, duration: number, gain = 0.45): void {
    const f = midiToHz(midi);
    const dur = Math.max(0.35, duration);

    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;

    const o2 = this.ctx.createOscillator();
    o2.type = 'triangle';
    o2.frequency.value = f * 2;
    const o2g = this.ctx.createGain();
    o2g.gain.value = 0.12;

    // vibrato arrives late, the way a real player adds it
    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 5.2;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.setValueAtTime(0, t);
    lfoGain.gain.setValueAtTime(0, t + Math.min(0.22, dur * 0.4));
    lfoGain.gain.linearRampToValueAtTime(9, t + dur * 0.8);
    lfo.connect(lfoGain);
    lfoGain.connect(o.detune);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.07);
    g.gain.setValueAtTime(gain, t + dur * 0.75);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    // breath
    const n = this.noiseSource();
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f * 2.2;
    bp.Q.value = 1.6;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.linearRampToValueAtTime(gain * 0.22, t + 0.05);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    o.connect(g);
    o2.connect(o2g);
    o2g.connect(g);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(g);

    this.connectVoice(g, 0.5);
    o.start(t);
    o2.start(t);
    lfo.start(t);
    n.start(t);
    const stop = t + dur + 0.1;
    o.stop(stop);
    o2.stop(stop);
    lfo.stop(stop);
    n.stop(stop);
  }

  /** Temple bell — inharmonic partial ratios are what make it read as metal. */
  bell(t: number, midi: number, gain = 0.35, decay = 3): void {
    const f = midiToHz(midi);
    const ratios: Array<[number, number]> = [
      [1, 1],
      [2.76, 0.6],
      [5.4, 0.32],
      [8.93, 0.18],
      [11.34, 0.1],
    ];
    const out = this.ctx.createGain();
    out.gain.value = gain * 0.45;

    for (const [r, amp] of ratios) {
      const freq = f * r;
      if (freq > 17500) continue;
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq;
      const g = this.ctx.createGain();
      const d = decay / (1 + (r - 1) * 0.35);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(amp, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g);
      g.connect(out);
      o.start(t);
      o.stop(t + d + 0.05);
    }
    this.connectVoice(out, 0.7);
  }

  /* ---------------------------------------------------------------- *
   * SFX — these route to the sfx bus so players can balance them apart
   * ---------------------------------------------------------------- */

  /** The sound of a clean cut. `tier` 0..2 = good / great / perfect. */
  slash(t: number, tier = 2): void {
    const bright = 4200 + tier * 2600;
    const n = this.noiseSource();
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(bright, t);
    bp.frequency.exponentialRampToValueAtTime(900, t + 0.1);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16 + tier * 0.07, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);

    n.connect(bp);
    bp.connect(g);
    this.connectVoice(g, 0.24, true);
    n.start(t);
    n.stop(t + 0.16);

    if (tier >= 2) {
      // steel ring on a perfect hit only — it becomes the reward signal
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(3200, t);
      o.frequency.exponentialRampToValueAtTime(2400, t + 0.18);
      const og = this.ctx.createGain();
      og.gain.setValueAtTime(0.07, t);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.connect(og);
      this.connectVoice(og, 0.5, true);
      o.start(t);
      o.stop(t + 0.22);
    }
  }

  /** Dull, wrong, a little sickening — you should not want to hear this. */
  miss(t: number): void {
    for (const f of [92, 97]) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * 0.6, t + 0.18);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 620;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.15, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
      o.connect(lp);
      lp.connect(g);
      this.connectVoice(g, 0.1, true);
      o.start(t);
      o.stop(t + 0.28);
    }
  }

  /** Rising shriek + impact for a Breathing Art activation. */
  artActivate(t: number): void {
    const n = this.noiseSource();
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.4;
    bp.frequency.setValueAtTime(700, t);
    bp.frequency.exponentialRampToValueAtTime(9000, t + 0.42);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.22, t + 0.36);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    n.connect(bp);
    bp.connect(g);
    this.connectVoice(g, 0.6, true);
    n.start(t);
    n.stop(t + 0.55);

    this.bell(t + 0.4, 84, 0.5, 2.4);
    this.taiko(t + 0.4, 1.1, 33);
  }

  /* --- UI ---------------------------------------------------------- */

  uiHover(): void {
    const t = this.now;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 1720;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.035, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    o.connect(g);
    this.connectVoice(g, 0.3, true);
    o.start(t);
    o.stop(t + 0.09);
  }

  uiSelect(): void {
    const t = this.now;
    this.bell(t, 81, 0.22, 1.4);
    this.rim(t, 0.22);
  }

  uiBack(): void {
    const t = this.now;
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(520, t);
    o.frequency.exponentialRampToValueAtTime(240, t + 0.13);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g);
    this.connectVoice(g, 0.3, true);
    o.start(t);
    o.stop(t + 0.18);
  }

  /** Struck once when the concentration gauge fills. */
  gaugeReady(): void {
    const t = this.now;
    this.bell(t, 88, 0.3, 2);
    this.bell(t + 0.09, 93, 0.2, 1.6);
  }
}

/** One engine per app. Created lazily so no context exists before first input. */
let engine: SynthEngine | null = null;

export function getSynth(): SynthEngine {
  if (!engine) engine = new SynthEngine();
  return engine;
}
