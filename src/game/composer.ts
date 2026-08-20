/**
 * The composer turns a SongSpec into two synchronised outputs:
 *
 *   backing[] — everything the synth plays unconditionally (drums, bass, pad)
 *   notes[]   — the lead line, which is ONLY heard when the player hits it
 *
 * That split is the whole design: play well and the melody completes over the
 * groove; miss and you hear the hole you left. Both arrays are derived from the
 * same bar-by-bar walk, so they are sample-locked by construction.
 *
 * Generation is deterministic — seeded from song id + difficulty — so a chart
 * is identical on every machine and every replay, which is what makes scores
 * comparable at all.
 */

import type {
  SongSpec,
  Difficulty,
  ScaleName,
  DrumStyle,
  LeadStyle,
  Section,
} from '../data/songs';
import { DEFAULT_LANE_COUNT, type LaneCount } from './lanes';

/** Silence before the first bar, so the player can settle. */
export const PRE_ROLL = 2.2;
/** Trailing silence so the last note's reverb tail is not cut off. */
const TAIL = 2.6;

export type LeadInstrument = 'piano' | 'koto' | 'shakuhachi' | 'bell';
export type BackingInstrument =
  | 'taiko'
  | 'kotsuzumi'
  | 'hat'
  | 'rim'
  | 'bass'
  | 'pad'
  | 'piano'
  | 'chime';

export interface ChartNote {
  id: number;
  /** Seconds from the start of playback. */
  time: number;
  beat: number;
  lane: number;
  kind: 'tap' | 'hold';
  /** Seconds; 0 for taps. */
  duration: number;
  midi: number;
  instrument: LeadInstrument;
  /** 0..1, section intensity at this moment — drives brightness and size. */
  intensity: number;
  /** True when another note shares this exact timestamp. */
  chord: boolean;
}

export interface BackingEvent {
  time: number;
  instrument: BackingInstrument;
  midi: number;
  duration: number;
  gain: number;
  intensity: number;
}

export interface SectionSpan {
  name: string;
  startBeat: number;
  endBeat: number;
  startTime: number;
  endTime: number;
  intensity: number;
}

export interface Chart {
  songId: string;
  difficultyId: string;
  /** Number of playable columns. Stored on the chart so every subsystem agrees. */
  laneCount: LaneCount;
  bpm: number;
  secPerBeat: number;
  notes: ChartNote[];
  backing: BackingEvent[];
  sections: SectionSpan[];
  /** Total playable length in seconds, including pre-roll and tail. */
  duration: number;
  noteCount: number;
  /** Longest run of notes inside one second — used for the difficulty graph. */
  peakDensity: number;
  /** Per-second note counts, for the song-select intensity sparkline. */
  densityCurve: number[];
}

/* ------------------------------------------------------------------ *
 * deterministic RNG
 * ------------------------------------------------------------------ */

function hashSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * modes
 * ------------------------------------------------------------------ */

const SCALES: Record<ScaleName, number[]> = {
  hirajoshi: [0, 2, 3, 7, 8],
  insen: [0, 1, 5, 7, 10],
  yo: [0, 2, 5, 7, 9],
  iwato: [0, 1, 5, 6, 10],
  kumoi: [0, 2, 3, 7, 9],
  ryukyu: [0, 4, 5, 7, 11],
};

function degToMidi(root: number, scale: number[], deg: number): number {
  const n = scale.length;
  const oct = Math.floor(deg / n);
  const idx = ((deg % n) + n) % n;
  return root + oct * 12 + scale[idx];
}

export const midiToHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

/* ------------------------------------------------------------------ *
 * rhythm tables — 16 steps per bar (sixteenth notes in 4/4)
 * ------------------------------------------------------------------ */

/** Which 16th steps each drum voice fires on. */
interface DrumPattern {
  taiko: number[];
  rim: number[];
  hat: number[];
  kotsuzumi: number[];
}

const DRUMS: Record<DrumStyle, DrumPattern> = {
  none: { taiko: [], rim: [], hat: [], kotsuzumi: [] },
  sparse: { taiko: [0, 8], rim: [12], hat: [], kotsuzumi: [6] },
  taiko: {
    taiko: [0, 6, 8, 14],
    rim: [4, 12],
    hat: [2, 6, 10, 14],
    kotsuzumi: [3, 11],
  },
  driving: {
    taiko: [0, 3, 6, 8, 11, 14],
    rim: [4, 12],
    hat: [0, 2, 4, 6, 8, 10, 12, 14],
    kotsuzumi: [7, 15],
  },
  double: {
    taiko: [0, 2, 4, 6, 8, 10, 12, 14],
    rim: [4, 12],
    hat: [1, 3, 5, 7, 9, 11, 13, 15],
    kotsuzumi: [5, 13],
  },
  break: { taiko: [0], rim: [8], hat: [], kotsuzumi: [12, 14] },
  matsuri: {
    taiko: [0, 2, 3, 6, 8, 10, 11, 14],
    rim: [4, 12, 15],
    hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    kotsuzumi: [5, 7, 13],
  },
};

const ALL_STEPS = Array.from({ length: 16 }, (_, i) => i);

/**
 * Candidate 16th steps the lead line may occupy. Denser styles offer the whole
 * grid and let metrical weight do the thinning — that is what makes one
 * arrangement produce four genuinely different charts.
 */
const LEAD_STEPS: Record<LeadStyle, number[]> = {
  none: [],
  call: [0, 4, 8, 12],
  chant: [0, 6, 8, 12],
  phrase: [0, 2, 4, 6, 8, 10, 12, 14],
  run: ALL_STEPS,
  flurry: ALL_STEPS,
};

/**
 * Added to a candidate's metrical weight. A `call` needs a much stronger beat
 * to survive than a `flurry` does, so the same threshold yields a sparse intro
 * and a dense chorus.
 */
const LEAD_BIAS: Record<LeadStyle, number> = {
  none: 0,
  call: -0.22,
  chant: -0.18,
  phrase: -0.04,
  run: 0.06,
  flurry: 0.16,
};

/** Metrical weight of a 16th step: downbeats survive thinning, offbeats don't. */
function stepWeight(step: number): number {
  if (step % 16 === 0) return 1;
  if (step % 8 === 0) return 0.93;
  if (step % 4 === 0) return 0.82;
  if (step % 2 === 0) return 0.62;
  return 0.44;
}

/* ------------------------------------------------------------------ *
 * the composer
 * ------------------------------------------------------------------ */

export function compose(
  song: SongSpec,
  difficulty: Difficulty,
  laneCount: LaneCount = DEFAULT_LANE_COUNT,
): Chart {
  // Every field size shares the original seed, melody and timestamps.
  const rng = mulberry32(hashSeed(`${song.id}:${difficulty.id}:v4`));
  const scale = SCALES[song.scale];
  const secPerBeat = 60 / song.bpm;
  const secPerStep = secPerBeat / 4;

  const notes: ChartNote[] = [];
  const backing: BackingEvent[] = [];
  const sections: SectionSpan[] = [];

  /**
   * Notes survive thinning when their weight clears this bar. Tuned so that
   * Novice lands on quarters, Adept on eighths, and Elite/Pillar on sixteenths.
   */
  const keepThreshold = 1.06 - difficulty.density * 0.76;
  const allowChords = difficulty.density >= 0.8;
  const allowSixteenthRuns = difficulty.density >= 0.6;
  /** Elite keeps most sixteenths; only Pillar keeps all of them. */
  const sixteenthKeep = Math.min(
    1,
    0.25 + Math.max(0, (difficulty.density - 0.6) / 0.4) * 0.75,
  );

  let beat = 0;
  let noteId = 0;
  let deg = 2; // current scale degree of the lead
  let lastLane = -1;
  let sameLaneRun = 0;

  const timeAt = (b: number) => PRE_ROLL + b * secPerBeat;

  for (let si = 0; si < song.arrangement.length; si++) {
    const sec: Section = song.arrangement[si];
    const startBeat = beat;
    const transpose = sec.transpose ?? 0;
    const root = song.root + transpose;
    const pattern = DRUMS[sec.drums];
    const leadSteps = LEAD_STEPS[sec.lead];

    for (let bar = 0; bar < sec.bars; bar++) {
      const barBeat = startBeat + bar * 4;
      const isLastBar = bar === sec.bars - 1;
      const isFirstBar = bar === 0;

      /* ---- drums ------------------------------------------------- */
      for (const step of pattern.taiko) {
        const accent = step === 0 ? 1 : step % 4 === 0 ? 0.86 : 0.66;
        backing.push({
          time: timeAt(barBeat) + step * secPerStep,
          instrument: 'taiko',
          midi: step === 0 ? 36 : 38,
          duration: 0.4,
          gain: (0.5 + sec.intensity * 0.5) * accent,
          intensity: sec.intensity,
        });
      }
      for (const step of pattern.rim) {
        backing.push({
          time: timeAt(barBeat) + step * secPerStep,
          instrument: 'rim',
          midi: 60,
          duration: 0.18,
          gain: 0.42 + sec.intensity * 0.34,
          intensity: sec.intensity,
        });
      }
      for (const step of pattern.hat) {
        backing.push({
          time: timeAt(barBeat) + step * secPerStep,
          instrument: 'hat',
          midi: 70,
          duration: 0.07,
          gain: (step % 4 === 0 ? 0.3 : 0.17) * (0.6 + sec.intensity * 0.6),
          intensity: sec.intensity,
        });
      }
      for (const step of pattern.kotsuzumi) {
        backing.push({
          time: timeAt(barBeat) + step * secPerStep,
          instrument: 'kotsuzumi',
          midi: 64 + Math.floor(rng() * 5),
          duration: 0.22,
          gain: 0.3 + sec.intensity * 0.3,
          intensity: sec.intensity,
        });
      }

      /* ---- bass -------------------------------------------------- */
      if (sec.bass) {
        const bassDegs = [0, 0, 4, 2];
        const bassSteps = sec.intensity > 0.7 ? [0, 6, 8, 12] : [0, 8];
        bassSteps.forEach((step, i) => {
          const bd = bassDegs[(bar * 2 + i) % bassDegs.length];
          backing.push({
            time: timeAt(barBeat) + step * secPerStep,
            instrument: 'bass',
            midi: degToMidi(root - 24, scale, bd),
            duration: secPerBeat * (sec.intensity > 0.7 ? 0.9 : 1.7),
            gain: 0.5 + sec.intensity * 0.28,
            intensity: sec.intensity,
          });
        });
      }

      /* ---- pad --------------------------------------------------- */
      if (sec.pad && bar % 2 === 0) {
        const chordRoot = bar % 4 === 0 ? 0 : 3;
        for (const off of [0, 2, 4]) {
          backing.push({
            time: timeAt(barBeat),
            instrument: 'pad',
            midi: degToMidi(root - 12, scale, chordRoot + off),
            duration: secPerBeat * 8,
            gain: 0.16 + sec.intensity * 0.12,
            intensity: sec.intensity,
          });
        }
      }

      /* ---- piano comping ----------------------------------------- */
      if (sec.pad && sec.intensity > 0.3) {
        const chordDeg = bar % 4 === 0 ? 0 : bar % 4 === 2 ? 3 : 2;
        const compSteps = sec.intensity > 0.68 ? [0, 6, 8, 12] : [0, 8];
        const ring = secPerBeat * (sec.intensity > 0.68 ? 1.6 : 3);
        for (const step of compSteps) {
          for (const off of [0, 2, 4]) {
            backing.push({
              time: timeAt(barBeat) + step * secPerStep,
              instrument: 'piano',
              midi: degToMidi(root - 12, scale, chordDeg + off),
              duration: ring,
              gain: (0.2 + sec.intensity * 0.16) * (step === 0 ? 1 : 0.72),
              intensity: sec.intensity,
            });
          }
        }
      }

      /* ---- chimes at structural moments -------------------------- */
      if (sec.bell && (isFirstBar || bar % 4 === 0)) {
        backing.push({
          time: timeAt(barBeat),
          instrument: 'chime',
          midi: degToMidi(root + 12, scale, 4),
          duration: 3.2,
          gain: 0.3,
          intensity: sec.intensity,
        });
      }

      /* ---- lead line (the playable chart) ------------------------ */
      if (!leadSteps.length) continue;

      for (const step of leadSteps) {
        if (!allowSixteenthRuns && step % 2 !== 0) continue;

        const w = stepWeight(step) + LEAD_BIAS[sec.lead];
        if (w < keepThreshold) continue;
        // Sixteenths are the difference between Elite and Pillar.
        if (step % 2 !== 0 && rng() > sixteenthKeep) continue;

        /*
         * Holds: sustained notes marking the breathing sections. Half a bar
         * long, so a held lane never swallows the next note that lands in it.
         * Decided before the density gate — these are structural moments, not
         * filler, and should survive even in the quietest sections.
         */
        const wantHold =
          (sec.lead === 'chant' && (step === 0 || step === 8)) ||
          (sec.lead === 'call' && step === 8 && rng() < 0.55) ||
          (isLastBar && step === 8 && sec.intensity < 0.75 && rng() < 0.6);

        // Intensity gates the sparser offbeats so quiet sections stay quiet.
        const gate = 0.32 + sec.intensity * 0.78;
        if (!wantHold && w < 0.9 && rng() > gate) continue;

        /* melodic motion: mostly stepwise, occasional leap on strong beats */
        const leap = rng() < (step === 0 ? 0.34 : 0.12);
        const dir = rng() < 0.5 ? -1 : 1;
        deg += leap ? dir * (2 + Math.floor(rng() * 2)) : dir;
        // Keep the line inside a comfortable two-octave window.
        if (deg > 11) deg -= 5;
        if (deg < -3) deg += 5;

        let lane = ((deg % DEFAULT_LANE_COUNT) + DEFAULT_LANE_COUNT) % DEFAULT_LANE_COUNT;
        if (lane === lastLane) {
          sameLaneRun++;
          if (sameLaneRun >= 2 && step % 4 !== 0) {
            lane =
              (lane + (rng() < 0.5 ? 1 : DEFAULT_LANE_COUNT - 1)) %
              DEFAULT_LANE_COUNT;
            sameLaneRun = 0;
          }
        } else {
          sameLaneRun = 0;
        }
        lastLane = lane;

        const time = timeAt(barBeat) + step * secPerStep;
        const noteBeat = barBeat + step / 4;

        const holdBeats = wantHold ? 1.5 : 0;

        const instrument: LeadInstrument =
          sec.lead === 'chant'
            ? 'shakuhachi'
            : sec.intensity > 0.85 && step % 8 === 0
              ? 'bell'
              : 'piano';

        notes.push({
          id: noteId++,
          time,
          beat: noteBeat,
          lane,
          kind: holdBeats > 0 ? 'hold' : 'tap',
          duration: holdBeats * secPerBeat,
          midi: degToMidi(root, scale, deg),
          instrument,
          intensity: sec.intensity,
          chord: false,
        });

        /* chords: a second lane on big downbeats, elite charts only */
        if (
          allowChords &&
          step === 0 &&
          sec.intensity > 0.82 &&
          rng() < 0.45 &&
          !wantHold
        ) {
          const otherDeg = deg + (rng() < 0.5 ? 2 : -2);
          let otherLane =
            ((otherDeg % DEFAULT_LANE_COUNT) + DEFAULT_LANE_COUNT) %
            DEFAULT_LANE_COUNT;
          if (otherLane === lane) {
            otherLane = (otherLane + 2) % DEFAULT_LANE_COUNT;
          }
          notes.push({
            id: noteId++,
            time,
            beat: noteBeat,
            lane: otherLane,
            kind: 'tap',
            duration: 0,
            midi: degToMidi(root, scale, otherDeg),
            instrument,
            intensity: sec.intensity,
            chord: true,
          });
          notes[notes.length - 2].chord = true;
        }
      }
    }

    beat += sec.bars * 4;
    sections.push({
      name: sec.name,
      startBeat,
      endBeat: beat,
      startTime: timeAt(startBeat),
      endTime: timeAt(beat),
      intensity: sec.intensity,
    });
  }

  notes.sort((a, b) => a.time - b.time || a.lane - b.lane);

  if (laneCount !== DEFAULT_LANE_COUNT) {
    const extraChordNotes: ChartNote[] = [];
    let chordOrdinal = 0;

    for (let from = 0; from < notes.length; ) {
      let to = from + 1;
      while (to < notes.length && notes[to].time === notes[from].time) to++;
      const group = notes.slice(from, to);
      const used = new Set<number>();

      for (const note of group) {
        // Alternate four-lane hand shapes through lane banks. This uses every
        // column without changing a single musical or timing decision.
        const bank = Math.floor(note.beat) * DEFAULT_LANE_COUNT;
        let mapped = (note.lane + bank) % laneCount;
        while (used.has(mapped)) mapped = (mapped + 1) % laneCount;
        note.lane = mapped;
        used.add(mapped);
      }

      if (group.length > 1) {
        if (
          difficulty.density >= 1 &&
          laneCount >= 6 &&
          chordOrdinal % 3 === 0
        ) {
          let thirdLane = (group[0].lane + Math.ceil(laneCount / 2)) % laneCount;
          while (used.has(thirdLane)) thirdLane = (thirdLane + 1) % laneCount;
          extraChordNotes.push({
            ...group[0],
            id: noteId++,
            lane: thirdLane,
            kind: 'tap',
            duration: 0,
            midi: group[0].midi + 7,
            chord: true,
          });
        }
        chordOrdinal++;
      }

      from = to;
    }

    notes.push(...extraChordNotes);
    notes.sort((a, b) => a.time - b.time || a.lane - b.lane);
  }
  backing.sort((a, b) => a.time - b.time);

  const duration = timeAt(beat) + TAIL;

  /* density curve, one bucket per second */
  const buckets = Math.max(1, Math.ceil(duration));
  const densityCurve = new Array(buckets).fill(0);
  for (const n of notes) {
    const b = Math.min(buckets - 1, Math.floor(n.time));
    densityCurve[b]++;
  }
  const peakDensity = densityCurve.reduce((m, v) => Math.max(m, v), 0);

  return {
    songId: song.id,
    difficultyId: difficulty.id,
    laneCount,
    bpm: song.bpm,
    secPerBeat,
    notes,
    backing,
    sections,
    duration,
    noteCount: notes.length,
    peakDensity,
    densityCurve,
  };
}

/** Cheap memoised access — charts are pure functions of (song, difficulty, lanes). */
const chartCache = new Map<string, Chart>();

export function getChart(
  song: SongSpec,
  difficulty: Difficulty,
  laneCount: LaneCount = DEFAULT_LANE_COUNT,
): Chart {
  const key = `${song.id}:${difficulty.id}:${laneCount}`;
  let c = chartCache.get(key);
  if (!c) {
    c = compose(song, difficulty, laneCount);
    chartCache.set(key, c);
  }
  return c;
}
