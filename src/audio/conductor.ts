/**
 * Conductor — owns song time and feeds the synth.
 *
 * Two problems this solves:
 *
 * 1. Scheduling. A four-minute Hashira chart contains ~8,000 audio events.
 *    Creating 8,000 node graphs up front would stall the main thread and blow
 *    memory, so we run the standard lookahead loop: a coarse timer wakes every
 *    25ms and hands the synth only the events falling inside the next 180ms,
 *    scheduled against the sample-accurate AudioContext clock.
 *
 * 2. A smooth clock. `AudioContext.currentTime` only advances once per render
 *    quantum, so reading it directly makes notes visibly stutter. We track the
 *    offset between the audio clock and `performance.now()` and interpolate,
 *    which gives per-frame resolution while staying locked to audio.
 */

import type { Chart } from '../game/composer';
import { PRE_ROLL } from '../game/composer';
import type { SynthEngine } from './synth';

const LOOKAHEAD_MS = 25;
const SCHEDULE_WINDOW = 0.18;

export type ConductorState = 'idle' | 'playing' | 'paused' | 'finished';

export class Conductor {
  private synth: SynthEngine;
  private chart: Chart | null = null;
  private timer: number | null = null;

  /** AudioContext time corresponding to song time 0. */
  private startTime = 0;
  private backingIndex = 0;
  private clockOffset = NaN;

  state: ConductorState = 'idle';

  /** User calibration in seconds; positive means "my hits register late". */
  audioOffset = 0;

  constructor(synth: SynthEngine) {
    this.synth = synth;
  }

  /**
   * Interpolated audio clock. `AudioContext.currentTime` is quantised, so the
   * raw difference against performance.now() is a sawtooth whose peak is the
   * true offset — track the peak, decay slowly so real drift is still followed.
   */
  private clock(): number {
    const a = this.synth.ctx.currentTime;
    const p = performance.now() / 1000;
    const raw = a - p;
    if (!Number.isFinite(this.clockOffset)) {
      this.clockOffset = raw;
    } else {
      this.clockOffset =
        raw > this.clockOffset
          ? raw
          : this.clockOffset + (raw - this.clockOffset) * 0.02;
    }
    return p + this.clockOffset;
  }

  /** Seconds since the song began. Negative during the pre-roll. */
  get songTime(): number {
    if (this.state === 'idle') return 0;
    return this.clock() - this.startTime;
  }

  /** Song time adjusted by the player's calibration, for judging inputs. */
  get judgeTime(): number {
    return this.songTime - this.audioOffset;
  }

  get progress(): number {
    if (!this.chart) return 0;
    return Math.min(1, Math.max(0, this.songTime / this.chart.duration));
  }

  /**
   * Start playback. Pass `audio` for an imported track: the chart's note times
   * already include PRE_ROLL, so the file is scheduled to begin exactly there
   * and the two stay locked to the same AudioContext clock.
   */
  start(chart: Chart, countIn = 0.9, audio?: AudioBuffer | null): void {
    this.chart = chart;
    this.backingIndex = 0;
    this.clockOffset = NaN;
    this.startTime = this.clock() + countIn;
    this.state = 'playing';

    if (audio) {
      this.synth.playTrack(audio, this.startTime + PRE_ROLL);
    }

    this.schedule();
    this.timer = window.setInterval(() => this.schedule(), LOOKAHEAD_MS);
  }

  private schedule(): void {
    const chart = this.chart;
    if (!chart || this.state !== 'playing') return;

    const horizon = this.clock() + SCHEDULE_WINDOW;

    while (this.backingIndex < chart.backing.length) {
      const ev = chart.backing[this.backingIndex];
      const at = this.startTime + ev.time;
      if (at > horizon) break;
      this.backingIndex++;
      // Anything already in the past (tab was backgrounded) is dropped rather
      // than fired late in a clump.
      if (at < this.synth.ctx.currentTime - 0.05) continue;
      this.emit(ev.instrument, at, ev.midi, ev.duration, ev.gain);
    }

    if (this.songTime >= chart.duration) {
      this.state = 'finished';
      this.stopTimer();
    }
  }

  private emit(
    instrument: string,
    at: number,
    midi: number,
    duration: number,
    gain: number,
  ): void {
    switch (instrument) {
      case 'taiko':
        this.synth.taiko(at, gain, midi);
        break;
      case 'kotsuzumi':
        this.synth.kotsuzumi(at, midi, gain);
        break;
      case 'rim':
        this.synth.rim(at, gain);
        break;
      case 'hat':
        this.synth.hat(at, gain);
        break;
      case 'bass':
        this.synth.bass(at, midi, duration, gain);
        break;
      case 'pad':
        this.synth.pad(at, midi, duration, gain);
        break;
      case 'piano':
        this.synth.piano(at, midi, gain, duration);
        break;
      case 'chime':
        this.synth.bell(at, midi, gain, duration);
        break;
    }
  }

  /**
   * Play a lead note *now*, because the player hit it. This is the payoff of
   * splitting the score: the melody only exists if you earn it.
   */
  playLead(
    instrument: 'piano' | 'koto' | 'shakuhachi' | 'bell',
    midi: number,
    duration: number,
    strength = 1,
  ): void {
    const t = this.synth.now + 0.001;
    switch (instrument) {
      case 'shakuhachi':
        this.synth.shakuhachi(t, midi, Math.max(0.45, duration), 0.4 * strength);
        break;
      case 'bell':
        this.synth.bell(t, midi, 0.3 * strength, 2.2);
        break;
      case 'koto':
        this.synth.koto(t, midi, 0.55 * strength, duration > 0 ? 1.6 : 1);
        break;
      default:
        // Holds ring on; taps get damped so fast runs stay articulate.
        this.synth.piano(t, midi, 0.62 * strength, duration > 0 ? 0 : 0);
    }
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.stopTimer();
    void this.synth.ctx.suspend();
  }

  /** Resume assumes the caller already ran a visible count-in. */
  async resume(): Promise<void> {
    if (this.state !== 'paused') return;
    await this.synth.ctx.resume();
    // currentTime froze while suspended, so startTime is still correct.
    this.clockOffset = NaN;
    this.state = 'playing';
    this.schedule();
    this.timer = window.setInterval(() => this.schedule(), LOOKAHEAD_MS);
  }

  stop(): void {
    this.stopTimer();
    this.state = 'idle';
    this.chart = null;
    this.synth.stopTrack();
    if (this.synth.ctx.state === 'suspended') void this.synth.ctx.resume();
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }
}
