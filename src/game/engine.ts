/**
 * GameEngine — pure gameplay state. No rendering, no audio, no React.
 *
 * The screen drives it with `update(time)` once a frame and `press`/`release`
 * on input; it returns events describing what happened, which the renderer and
 * the audio layer then react to. Keeping it isolated means the whole scoring
 * model is testable and the frame loop stays readable.
 */

import type { Chart, ChartNote } from './composer';
import type { BreathingStyle } from '../data/breathing';

export type Judgement = 'kiwami' | 'zan' | 'kasuri' | 'shitsu';

export const JUDGEMENT_LABEL: Record<Judgement, { kanji: string; romaji: string }> = {
  kiwami: { kanji: '極', romaji: 'PERFECT' },
  zan: { kanji: '斬', romaji: 'GREAT' },
  kasuri: { kanji: '掠', romaji: 'GRAZE' },
  shitsu: { kanji: '失', romaji: 'MISS' },
};

/** Base timing windows in seconds, before a style's modifier is applied. */
const BASE_WINDOWS = { kiwami: 0.046, zan: 0.092, kasuri: 0.142 };

const POINTS: Record<Judgement, number> = {
  kiwami: 300,
  zan: 200,
  kasuri: 100,
  shitsu: 0,
};

const ACCURACY_WEIGHT: Record<Judgement, number> = {
  kiwami: 1,
  zan: 0.85,
  kasuri: 0.5,
  shitsu: 0,
};

/** Resolve delta per judgement — the song can be failed. */
const RESOLVE: Record<Judgement, number> = {
  kiwami: 1.1,
  zan: 0.6,
  kasuri: -1,
  shitsu: -4.5,
};

const GAUGE_GAIN: Record<Judgement, number> = {
  kiwami: 1.7,
  zan: 1.05,
  kasuri: 0.35,
  shitsu: -7,
};

export const ART_DURATION = 8.5;

export interface NoteState {
  note: ChartNote;
  judged: Judgement | null;
  /** Hold in progress: the frame the key went down. */
  holdStart: number | null;
  holdDone: boolean;
  holdBroken: boolean;
  /** 0..1 completion of a hold, for the renderer. */
  holdProgress: number;
}

export interface HitEvent {
  noteId: number;
  lane: number;
  judgement: Judgement;
  /** Signed timing error in seconds; negative = early. */
  delta: number;
  combo: number;
  /** True if a Stone guard absorbed what would have been a combo break. */
  guarded: boolean;
  /** True if the Breathing Art upgraded this judgement. */
  upgraded: boolean;
  /** Fired when a hold is released successfully at its end, for feedback only. */
  holdComplete?: boolean;
  /** Fired when a hold is dropped early. */
  holdBroken?: boolean;
  note: ChartNote;
}

export interface EngineSnapshot {
  score: number;
  combo: number;
  maxCombo: number;
  multiplier: number;
  accuracy: number;
  counts: Record<Judgement, number>;
  gauge: number;
  gaugeReady: boolean;
  artActive: boolean;
  artRemaining: number;
  guards: number;
  resolve: number;
  failed: boolean;
  judged: number;
  total: number;
}

export interface EngineOptions {
  noFail: boolean;
}

const UPGRADE: Record<Judgement, Judgement> = {
  kasuri: 'zan',
  zan: 'kiwami',
  kiwami: 'kiwami',
  shitsu: 'shitsu',
};

export class GameEngine {
  readonly chart: Chart;
  readonly style: BreathingStyle;
  readonly states: NoteState[];
  readonly windows: { kiwami: number; zan: number; kasuri: number };

  /** Per-lane index of the earliest note not yet resolved. */
  private cursor: number[];
  private byLane: NoteState[][];
  private options: EngineOptions;

  score = 0;
  combo = 0;
  maxCombo = 0;
  counts: Record<Judgement, number> = { kiwami: 0, zan: 0, kasuri: 0, shitsu: 0 };
  accuracySum = 0;
  judgedCount = 0;

  gauge = 0;
  gaugeWasReady = false;
  artActive = false;
  artEndsAt = 0;
  artsUsed = 0;

  guards = 0;
  private cleanRun = 0;

  resolve = 100;
  failed = false;

  /** Signed timing errors, kept for the results-screen histogram. */
  deltas: number[] = [];

  constructor(chart: Chart, style: BreathingStyle, options: EngineOptions) {
    this.chart = chart;
    this.style = style;
    this.options = options;

    const bonus = style.modifiers.windowBonus / 1000;
    this.windows = {
      kiwami: Math.max(0.028, BASE_WINDOWS.kiwami + bonus),
      zan: Math.max(0.055, BASE_WINDOWS.zan + bonus),
      kasuri: Math.max(0.085, BASE_WINDOWS.kasuri + bonus),
    };

    this.states = chart.notes.map((note) => ({
      note,
      judged: null,
      holdStart: null,
      holdDone: false,
      holdBroken: false,
      holdProgress: 0,
    }));

    this.byLane = Array.from({ length: chart.laneCount }, () => [] as NoteState[]);
    for (const st of this.states) {
      if (st.note.lane >= 0 && st.note.lane < this.byLane.length) {
        this.byLane[st.note.lane].push(st);
      }
    }
    this.cursor = this.byLane.map(() => 0);
  }

  /* ---------------------------------------------------------------- *
   * derived values
   * ---------------------------------------------------------------- */

  get multiplierCap(): number {
    return this.style.id === 'flame' ? 6 : 4;
  }

  get multiplier(): number {
    const cap = this.multiplierCap;
    const step = this.style.id === 'flame' ? 40 : 25;
    const m = 1 + Math.floor(this.combo / step);
    return Math.min(cap, m) * (this.artActive ? 2 : 1);
  }

  get accuracy(): number {
    return this.judgedCount ? this.accuracySum / this.judgedCount : 1;
  }

  get gaugeReady(): boolean {
    return this.gauge >= 100 && !this.artActive;
  }

  snapshot(time: number): EngineSnapshot {
    return {
      score: Math.round(this.score * this.style.modifiers.scoreMul),
      combo: this.combo,
      maxCombo: this.maxCombo,
      multiplier: this.multiplier,
      accuracy: this.accuracy,
      counts: { ...this.counts },
      gauge: this.gauge,
      gaugeReady: this.gaugeReady,
      artActive: this.artActive,
      artRemaining: this.artActive ? Math.max(0, this.artEndsAt - time) : 0,
      guards: this.guards,
      resolve: this.resolve,
      failed: this.failed,
      judged: this.judgedCount,
      total: this.states.length,
    };
  }

  /* ---------------------------------------------------------------- *
   * frame update — retires notes that fell past the window
   * ---------------------------------------------------------------- */

  update(time: number): HitEvent[] {
    const events: HitEvent[] = [];

    if (this.artActive && time >= this.artEndsAt) {
      this.artActive = false;
      this.gauge = 0;
    }

    for (let lane = 0; lane < this.byLane.length; lane++) {
      const list = this.byLane[lane];
      while (this.cursor[lane] < list.length) {
        const st = list[this.cursor[lane]];

        // A held note that is still being held is not yet resolvable.
        if (st.holdStart !== null && !st.holdDone) {
          const end = st.note.time + st.note.duration;
          st.holdProgress = Math.min(
            1,
            (time - st.note.time) / Math.max(0.001, st.note.duration),
          );
          if (time >= end) {
            st.holdDone = true;
            st.holdProgress = 1;
            // Feedback only — the head already scored, so no judgement here.
            events.push({
              noteId: st.note.id,
              lane,
              judgement: st.judged ?? 'zan',
              delta: 0,
              combo: this.combo,
              guarded: false,
              upgraded: false,
              holdComplete: true,
              note: st.note,
            });
            this.cursor[lane]++;
            continue;
          }
          break;
        }

        if (st.judged !== null) {
          this.cursor[lane]++;
          continue;
        }

        if (time > st.note.time + this.windows.kasuri) {
          events.push(this.applyJudgement(st, 'shitsu', this.windows.kasuri));
          this.cursor[lane]++;
          continue;
        }
        break;
      }
    }

    return events;
  }

  /* ---------------------------------------------------------------- *
   * input
   * ---------------------------------------------------------------- */

  /**
   * Returns the hit event, or null when the press hit nothing at all.
   *
   * Matching takes the *earliest* unjudged note still inside the hit window,
   * not the nearest one. Nearest-note matching looks reasonable until a player
   * drifts consistently late: in a 16th-note stream the next note is closer
   * than the one they are actually behind on, so the press steals it and the
   * original is retired as a miss — one late hand turns into a cascade of them.
   * Earliest-first keeps late play merely late, which is how it should feel.
   */
  press(lane: number, time: number): HitEvent | null {
    const list = this.byLane[lane];
    if (!list) return null;

    // Scan a short span from the cursor rather than the whole lane.
    for (let i = this.cursor[lane]; i < list.length && i < this.cursor[lane] + 8; i++) {
      const st = list[i];
      if (st.judged !== null) continue;

      const delta = time - st.note.time;
      // Already past its window; update() will retire it. Keep looking.
      if (delta > this.windows.kasuri) continue;
      // Too far ahead — and everything after it is further still.
      if (delta < -this.windows.kasuri) break;

      const abs = Math.abs(delta);
      const judgement: Judgement =
        abs <= this.windows.kiwami
          ? 'kiwami'
          : abs <= this.windows.zan
            ? 'zan'
            : 'kasuri';

      if (st.note.kind === 'hold') {
        // Holds resolve on release; the head is registered now for feedback.
        st.holdStart = time;
      }
      return this.applyJudgement(st, judgement, delta);
    }

    return null;
  }

  /** Releasing early on a hold downgrades it. */
  release(lane: number, time: number): HitEvent | null {
    const list = this.byLane[lane];
    if (!list) return null;
    for (let i = this.cursor[lane]; i < list.length && i < this.cursor[lane] + 4; i++) {
      const st = list[i];
      if (st.note.kind !== 'hold' || st.holdStart === null || st.holdDone) continue;
      const end = st.note.time + st.note.duration;
      if (time < end - 0.12) {
        st.holdBroken = true;
        st.holdDone = true;
        this.combo = 0;
        this.resolve = Math.max(0, this.resolve - 2);
        return {
          noteId: st.note.id,
          lane,
          judgement: 'kasuri',
          delta: 0,
          combo: 0,
          guarded: false,
          upgraded: false,
          holdBroken: true,
          note: st.note,
        };
      }
      st.holdDone = true;
      return null;
    }
    return null;
  }

  /* ---------------------------------------------------------------- *
   * Breathing Art
   * ---------------------------------------------------------------- */

  activateArt(time: number): boolean {
    if (!this.gaugeReady) return false;
    this.artActive = true;
    this.artsUsed++;
    const dur = this.style.id === 'wind' ? ART_DURATION * 0.62 : ART_DURATION;
    this.artEndsAt = time + dur;
    this.gauge = 0;
    return true;
  }

  /* ---------------------------------------------------------------- *
   * scoring
   * ---------------------------------------------------------------- */

  private applyJudgement(
    st: NoteState,
    raw: Judgement,
    delta: number,
  ): HitEvent {
    let judgement = raw;
    let upgraded = false;

    if (this.artActive && raw !== 'shitsu') {
      const up = UPGRADE[raw];
      if (up !== raw) {
        judgement = up;
        upgraded = true;
      }
    }

    st.judged = judgement;
    if (st.note.kind === 'hold' && judgement === 'shitsu') {
      st.holdBroken = true;
      st.holdDone = true;
    }

    let guarded = false;
    if (judgement === 'shitsu') {
      if (this.guards > 0) {
        this.guards--;
        guarded = true;
      } else {
        this.combo = 0;
        this.cleanRun = 0;
      }
    } else {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      this.cleanRun++;
      const per = this.style.modifiers.shieldPerCombo;
      if (per > 0 && this.cleanRun >= per) {
        this.cleanRun = 0;
        this.guards = Math.min(3, this.guards + 1);
      }
      this.deltas.push(delta);
    }

    // Holds are worth roughly double, since they occupy the lane longer.
    const weight = st.note.kind === 'hold' ? 1.9 : 1;
    this.score += POINTS[judgement] * this.multiplier * weight;

    this.counts[judgement]++;
    this.accuracySum += ACCURACY_WEIGHT[judgement];
    this.judgedCount++;

    if (!this.artActive) {
      this.gauge = Math.max(
        0,
        Math.min(
          100,
          this.gauge + GAUGE_GAIN[judgement] * this.style.modifiers.gaugeRate,
        ),
      );
    }

    if (!this.options.noFail) {
      this.resolve = Math.max(0, Math.min(100, this.resolve + RESOLVE[judgement]));
      if (this.resolve <= 0) this.failed = true;
    }

    return {
      noteId: st.note.id,
      lane: st.note.lane,
      judgement,
      delta,
      combo: this.combo,
      guarded,
      upgraded,
      note: st.note,
    };
  }
}

/* -------------------------------------------------------------------- *
 * ranks — the Demon Slayer Corps ladder, low to high
 * -------------------------------------------------------------------- */

export interface Grade {
  index: number;
  kanji: string;
  romaji: string;
  color: string;
  min: number;
}

export const GRADES: Grade[] = [
  { index: 0, kanji: '癸', romaji: 'MIZUNOTO', color: '#7c8699', min: 0 },
  { index: 1, kanji: '戊', romaji: 'TSUCHINOE', color: '#8fa3c4', min: 0.6 },
  { index: 2, kanji: '丁', romaji: 'HINOTO', color: '#6aa8ff', min: 0.72 },
  { index: 3, kanji: '丙', romaji: 'HINOE', color: '#5fd39a', min: 0.82 },
  { index: 4, kanji: '乙', romaji: 'OTSU', color: '#ffd93d', min: 0.9 },
  { index: 5, kanji: '甲', romaji: 'KINOE', color: '#ff9f43', min: 0.95 },
  { index: 6, kanji: '柱', romaji: 'HASHIRA', color: '#ff4d6a', min: 0.985 },
];

export function gradeFor(accuracy: number): Grade {
  let g = GRADES[0];
  for (const cand of GRADES) if (accuracy >= cand.min) g = cand;
  return g;
}

export interface ClearFlags {
  fullCombo: boolean;
  perfect: boolean;
  failed: boolean;
}

export function clearFlags(engine: GameEngine): ClearFlags {
  return {
    fullCombo: engine.counts.shitsu === 0 && engine.judgedCount > 0,
    perfect:
      engine.counts.shitsu === 0 &&
      engine.counts.kasuri === 0 &&
      engine.counts.zan === 0 &&
      engine.judgedCount > 0,
    failed: engine.failed,
  };
}
