/**
 * Turns an arbitrary audio file into a playable chart.
 *
 * The detector is a multi-band SuperFlux (Böck & Widmer, 2013) rather than the
 * plain broadband spectral flux this started as. Three things changed and each
 * one matters for whether the notes feel like they follow the music:
 *
 *   log-spaced bands   Energy is measured in 24 bands across 40Hz-16kHz rather
 *                      than summed over the whole spectrum. A hi-hat no longer
 *                      disappears underneath a bass note.
 *
 *   max-filtered flux  Before differencing, the previous frame is maximum-
 *                      filtered across neighbouring bands. This is what stops
 *                      vibrato and tremolo — pitch wobbling back and forth
 *                      across a bin boundary — from registering as a stream of
 *                      false onsets, which plain flux does constantly on
 *                      vocals and strings.
 *
 *   per-band detection Onsets are picked independently in four band groups,
 *                      and the group *is* the lane. A kick lands in lane 1, a
 *                      snare in the middle, cymbals on the right. That single
 *                      change is most of why a chart reads as following the
 *                      track instead of being sprinkled over it.
 *
 * Timing resolution is 5.8ms (256-sample hop) with parabolic interpolation
 * around each peak for sub-frame precision, against a 46ms perfect window.
 */

import { FFT, hann } from './fft';
import type { Chart, ChartNote, SectionSpan } from '../game/composer';
import { PRE_ROLL } from '../game/composer';
import { DEFAULT_LANE_COUNT, type LaneCount } from '../game/lanes';
import type { Difficulty } from '../data/songs';

const FRAME = 1024;
const HOP = 256;

/**
 * Log-spaced analysis bands, and the four acoustic groups they collapse into:
 * bass, low-mid, high-mid, air. These groups are a property of the *audio*, not
 * of the play field — a six or eight lane chart spreads each group across
 * several columns rather than detecting differently.
 */
const BANDS = 24;
const GROUPS = 4;
const BANDS_PER_GROUP = BANDS / GROUPS;
const F_MIN = 40;
const F_MAX = 16000;

/** SuperFlux: compare against this many frames back, max-filtered over ±1 band. */
const FLUX_LAG = 2;
const FLUX_MU = 1;

const MIN_BPM = 70;
const MAX_BPM = 200;

/**
 * Bumped whenever detection changes in a way that makes cached results stale.
 * Tracks analysed under an older version are re-analysed on next launch.
 */
export const ANALYSIS_VERSION = 5;

export interface AnalyzedOnset {
  /** Seconds from the start of the audio. */
  t: number;
  /** 0..1 relative flux strength. */
  strength: number;
  /** 0..3 — which acoustic band group fired loudest. */
  group: number;
  /**
   * Relative energy in each of the four band groups at this instant, scaled so
   * the strongest is 1. High difficulties use this to fire several lanes for a
   * single musical moment — a kick and a cymbal together become a chord rather
   * than one note — which is what actually puts every finger to work.
   */
  groups: number[];
  /** 0..1 normalised spectral centroid, kept for pitching the piano layer. */
  centroid: number;
}

export interface TrackAnalysis {
  version: number;
  duration: number;
  bpm: number;
  /** Seconds from the start of the audio to the first beat of the grid. */
  beatOffset: number;
  onsets: AnalyzedOnset[];
  /** Per-second RMS, used to shape the background intensity. */
  energyCurve: number[];
  /** Estimated tonic as a pitch class, 0 = C. */
  key: number;
  /** True if the track reads as major rather than minor. */
  major: boolean;
}

export type AnalysisPhase = 'decoding' | 'scanning' | 'tempo' | 'charting';

export interface AnalysisProgress {
  phase: AnalysisPhase;
  /** 0..1 */
  value: number;
}

const yieldFrame = () => new Promise<void>((r) => setTimeout(r, 0));

/* ------------------------------------------------------------------ *
 * filterbank
 * ------------------------------------------------------------------ */

interface Band {
  start: number;
  end: number;
  weights: Float32Array;
}

/** Triangular log-spaced filters, mel-style but on a plain log axis. */
function buildFilterbank(sampleRate: number, bins: number): Band[] {
  const edges: number[] = [];
  for (let i = 0; i <= BANDS + 1; i++) {
    edges.push(F_MIN * Math.pow(F_MAX / F_MIN, i / (BANDS + 1)));
  }

  const binOf = (freq: number) => Math.round((freq * FRAME) / sampleRate);
  const out: Band[] = [];

  for (let b = 0; b < BANDS; b++) {
    const lo = Math.max(1, binOf(edges[b]));
    const mid = Math.max(lo + 1, binOf(edges[b + 1]));
    const hi = Math.min(bins - 1, Math.max(mid + 1, binOf(edges[b + 2])));
    const weights = new Float32Array(hi - lo + 1);
    for (let k = lo; k <= hi; k++) {
      weights[k - lo] =
        k <= mid ? (k - lo) / Math.max(1, mid - lo) : (hi - k) / Math.max(1, hi - mid);
    }
    out.push({ start: lo, end: hi, weights });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * analysis
 * ------------------------------------------------------------------ */

function downmix(buffer: AudioBuffer): Float32Array {
  const n = buffer.length;
  const out = new Float32Array(n);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += data[i];
  }
  if (channels > 1) {
    const inv = 1 / channels;
    for (let i = 0; i < n; i++) out[i] *= inv;
  }
  return out;
}

export async function analyzeTrack(
  buffer: AudioBuffer,
  onProgress?: (p: AnalysisProgress) => void,
): Promise<TrackAnalysis> {
  const sr = buffer.sampleRate;
  const mono = downmix(buffer);
  const duration = buffer.duration;

  const fft = new FFT(FRAME);
  const window = hann(FRAME);
  const bins = FRAME >>> 1;
  const filterbank = buildFilterbank(sr, bins);

  const frameCount = Math.max(1, Math.floor((mono.length - FRAME) / HOP));
  const framesPerSecond = sr / HOP;

  /* Band energies for every frame — the working surface for everything below. */
  const bandEnergy: Float32Array[] = [];
  for (let b = 0; b < BANDS; b++) bandEnergy.push(new Float32Array(frameCount));
  const centroid = new Float32Array(frameCount);

  const mag = new Float32Array(bins);
  const windowed = new Float32Array(FRAME);

  /*
   * Chroma, for the key estimate that pitches the optional piano layer.
   *
   * Sampled per semitone rather than per FFT bin. Bins are linearly spaced —
   * about 47Hz apart — so around 150Hz a whole semitone is narrower than one
   * bin while at 2kHz a bin spans a fraction of one. Histogramming bins into
   * pitch classes therefore measures the shape of the bin grid more than the
   * music, which is why every track came back as the same key. Reading each
   * semitone's own frequency, interpolated between neighbouring bins, removes
   * that bias.
   */
  const SEMITONE_LO = 36; // C2
  const SEMITONE_HI = 84; // C6
  const semitoneBin: number[] = [];
  for (let m = SEMITONE_LO; m <= SEMITONE_HI; m++) {
    semitoneBin.push((440 * Math.pow(2, (m - 69) / 12) * FRAME) / sr);
  }
  const chroma = new Float64Array(12);
  const frameChroma = new Float64Array(12);

  /* ---- 1. STFT into log-compressed band energies ------------------ */
  for (let f = 0; f < frameCount; f++) {
    const off = f * HOP;
    for (let i = 0; i < FRAME; i++) windowed[i] = mono[off + i] * window[i];
    fft.magnitudes(windowed, mag);

    for (let b = 0; b < BANDS; b++) {
      const band = filterbank[b];
      let sum = 0;
      for (let k = band.start; k <= band.end; k++) {
        sum += mag[k] * band.weights[k - band.start];
      }
      // Log compression: onsets are relative changes, not absolute ones.
      bandEnergy[b][f] = Math.log10(1 + sum * 20);
    }

    let total = 0;
    let weighted = 0;
    for (let k = 1; k < bins; k++) {
      total += mag[k];
      weighted += mag[k] * k;
    }
    centroid[f] = total > 1e-6 ? weighted / total / bins : 0;

    if ((f & 3) === 0) {
      let frameTotal = 0;
      for (let i = 0; i < semitoneBin.length; i++) {
        const pos = semitoneBin[i];
        const lo = Math.floor(pos);
        if (lo < 1 || lo + 1 >= bins) continue;
        // linear interpolation between the two bins straddling this semitone
        const frac = pos - lo;
        const amp = mag[lo] * (1 - frac) + mag[lo + 1] * frac;
        const v = Math.log1p(amp * 8);
        frameChroma[(SEMITONE_LO + i) % 12] += v;
        frameTotal += v;
      }
      if (frameTotal > 1e-9) {
        for (let pc = 0; pc < 12; pc++) {
          chroma[pc] += frameChroma[pc] / frameTotal;
          frameChroma[pc] = 0;
        }
      } else {
        frameChroma.fill(0);
      }
    }

    if ((f & 511) === 0) {
      onProgress?.({ phase: 'scanning', value: (f / frameCount) * 0.8 });
      await yieldFrame();
    }
  }

  /* ---- 2. SuperFlux per band ------------------------------------- */
  /*
   * Two copies of the flux are needed, and conflating them was a real bug.
   *
   * `bandFluxNorm` divides each band by its own average so a quiet hi-hat can
   * still trigger detection against a loud kick — necessary for *finding*
   * onsets. But attribution must use `bandFluxRaw`: high bands are quiet on
   * average, so normalising inflates them and an argmax over normalised values
   * puts almost every onset in the top band. Measured on real tracks that gave
   * a lane spread of 0/5/30/327 — the bass lane never fired once.
   */
  const bandFluxRaw: Float32Array[] = [];
  const bandFluxNorm: Float32Array[] = [];
  for (let b = 0; b < BANDS; b++) {
    bandFluxRaw.push(new Float32Array(frameCount));
    bandFluxNorm.push(new Float32Array(frameCount));
  }

  for (let b = 0; b < BANDS; b++) {
    const cur = bandEnergy[b];
    const dst = bandFluxRaw[b];

    for (let f = FLUX_LAG; f < frameCount; f++) {
      /*
       * Max-filter the reference frame across neighbouring bands. A partial
       * that has merely drifted sideways is still covered by the maximum, so
       * it produces no flux — only genuine new energy does. This is what keeps
       * vibrato and tremolo from reading as a stream of onsets.
       */
      let reference = -Infinity;
      for (let m = -FLUX_MU; m <= FLUX_MU; m++) {
        const nb = b + m;
        if (nb < 0 || nb >= BANDS) continue;
        const v = bandEnergy[nb][f - FLUX_LAG];
        if (v > reference) reference = v;
      }
      const rise = cur[f] - reference;
      dst[f] = rise > 0 ? rise : 0;
    }

    /*
     * Normalise each band against its own average activity before it is summed
     * in. Without this a loud kick band drowns out a quiet hi-hat band, and the
     * detector only ever hears the loudest instrument in the mix.
     */
    let sum = 0;
    for (let f = 0; f < frameCount; f++) sum += dst[f];
    const mean = sum / Math.max(1, frameCount);
    const norm = bandFluxNorm[b];
    if (mean > 1e-9) {
      for (let f = 0; f < frameCount; f++) norm[f] = dst[f] / mean;
    } else {
      norm.set(dst);
    }
  }

  /*
   * One detection envelope, not four.
   *
   * Detecting independently per band group looked appealing but was wrong: a
   * snare or a cymbal is broadband noise, so a single hit fires in every group
   * at once and the same musical event is emitted three or four times. Summing
   * first means one peak per event; the band groups are then only consulted to
   * decide *which* group that event belonged to.
   */
  const globalEnvelope = new Float32Array(frameCount);
  const groupEnergy: Float32Array[] = [];
  for (let g = 0; g < GROUPS; g++) groupEnergy.push(new Float32Array(frameCount));

  for (let b = 0; b < BANDS; b++) {
    const group = Math.min(GROUPS - 1, Math.floor(b / BANDS_PER_GROUP));
    const src = bandFluxNorm[b];
    const dst = groupEnergy[group];
    for (let f = 0; f < frameCount; f++) {
      globalEnvelope[f] += src[f];
      dst[f] += src[f];
    }
  }

  onProgress?.({ phase: 'scanning', value: 0.9 });
  await yieldFrame();

  /* ---- 3. peak picking on the combined envelope ------------------- */
  const smooth = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const a = globalEnvelope[Math.max(0, f - 1)];
    const b = globalEnvelope[f];
    const c = globalEnvelope[Math.min(frameCount - 1, f + 1)];
    smooth[f] = (a + b * 2 + c) / 4;
  }

  const W = Math.max(4, Math.round(framesPerSecond * 0.1));
  const minGapFrames = Math.max(2, Math.round(framesPerSecond * 0.045));
  const raw: AnalyzedOnset[] = [];

  /*
   * A peak-relative floor collapses on real music: one loud transient sets
   * `peak`, and everything quieter than 8% of it is discarded, which on these
   * tracks left barely one onset a second. A percentile of the envelope's own
   * distribution is robust to that — it describes typical activity rather than
   * the single loudest moment.
   */
  const ranked = Float32Array.from(smooth).sort();
  const percentile = (q: number) => ranked[Math.min(ranked.length - 1, Math.floor(q * ranked.length))];
  /*
   * Detect generously and let each difficulty thin afterwards. The onset list
   * is cached once per track but consumed by all four difficulties, so the
   * detector has to supply enough material for the hardest one — anything it
   * discards here is unavailable to every chart.
   */
  const floor = Math.max(1e-6, percentile(0.5) * 0.6);

  let lastPeak = -1e9;
  for (let f = 1; f < frameCount - 1; f++) {
    const v = smooth[f];
    if (v < floor) continue;
    if (v <= smooth[f - 1] || v < smooth[f + 1]) continue;

    let mean = 0;
    let count = 0;
    for (let k = Math.max(0, f - W); k <= Math.min(frameCount - 1, f + W); k++) {
      mean += smooth[k];
      count++;
    }
    mean /= count;
    if (v < mean * 1.18 + floor) continue;
    if (f - lastPeak < minGapFrames) continue;
    lastPeak = f;

    /*
     * Which band owned this event. Taking the single strongest band beats
     * summing each group: a snare and a cymbal are both broadband, so their
     * group totals look similar, but their *peak* band is squarely in the
     * low-mids and the air band respectively.
     */
    let bestBand = 0;
    let bestBandFlux = -Infinity;
    const groupMix = new Array<number>(GROUPS).fill(0);
    for (let b = 0; b < BANDS; b++) {
      // Transients smear over a frame or two, so look either side of the peak.
      let e = 0;
      for (let k = Math.max(0, f - 1); k <= Math.min(frameCount - 1, f + 1); k++) {
        e += bandFluxRaw[b][k];
      }
      groupMix[Math.min(GROUPS - 1, Math.floor(b / BANDS_PER_GROUP))] += e;
      if (e > bestBandFlux) {
        bestBandFlux = e;
        bestBand = b;
      }
    }
    const group = Math.min(GROUPS - 1, Math.floor(bestBand / BANDS_PER_GROUP));

    let mixPeak = 0;
    for (const v of groupMix) if (v > mixPeak) mixPeak = v;
    const groups = mixPeak > 0 ? groupMix.map((v) => v / mixPeak) : groupMix.map(() => 0);

    /* parabolic interpolation for sub-frame timing */
    const a = smooth[f - 1];
    const c = smooth[f + 1];
    const denom = a - 2 * v + c;
    const shift = Math.abs(denom) > 1e-9 ? (0.5 * (a - c)) / denom : 0;
    const frame = f + Math.max(-0.5, Math.min(0.5, shift));

    raw.push({
      t: (frame * HOP + FRAME / 2) / sr,
      strength: v,
      group,
      groups,
      centroid: centroid[f],
    });
  }

  let maxStrength = 0;
  for (const o of raw) if (o.strength > maxStrength) maxStrength = o.strength;
  if (maxStrength > 0) for (const o of raw) o.strength /= maxStrength;

  onProgress?.({ phase: 'tempo', value: 0 });
  await yieldFrame();

  /* ---- 4. tempo from the global envelope -------------------------- */
  const minLag = Math.floor((60 / MAX_BPM) * framesPerSecond);
  const maxLag = Math.ceil((60 / MIN_BPM) * framesPerSecond);

  const lagScore = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0;
    for (let f = 0; f + lag < frameCount; f++) score += globalEnvelope[f] * globalEnvelope[f + lag];
    lagScore[lag] = score / (frameCount - lag);
  }

  /*
   * Autocorrelation cannot tell a tempo from its double or half. Resolving
   * that is genuinely ambiguous, so this uses the standard fix: weight each
   * candidate by a log-normal prior centred on a comfortable 125 BPM. Note
   * placement comes from detected onsets, not from this grid, so an octave
   * error is cosmetic.
   */
  const TEMPO_PRIOR_CENTRE = 125;
  const TEMPO_PRIOR_WIDTH = 0.85;

  let bestLag = minLag;
  let bestWeighted = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const candidateBpm = (60 * framesPerSecond) / lag;
    const octaves = Math.log2(candidateBpm / TEMPO_PRIOR_CENTRE);
    const prior = Math.exp(-(octaves * octaves) / (2 * TEMPO_PRIOR_WIDTH ** 2));
    const weighted = lagScore[lag] * prior;
    if (weighted > bestWeighted) {
      bestWeighted = weighted;
      bestLag = lag;
    }
  }

  let refinedLag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const a = lagScore[bestLag - 1];
    const b = lagScore[bestLag];
    const c = lagScore[bestLag + 1];
    const denom = a - 2 * b + c;
    if (Math.abs(denom) > 1e-12) refinedLag = bestLag + (0.5 * (a - c)) / denom;
  }

  const bpm = (60 * framesPerSecond) / refinedLag;
  const secPerBeat = 60 / bpm;

  /* ---- phase: slide a pulse train and take the best fit ----------- */
  let beatOffset = 0;
  {
    const steps = 128;
    let best = -Infinity;
    for (let st = 0; st < steps; st++) {
      const phase = (st / steps) * secPerBeat;
      let score = 0;
      for (const o of raw) {
        const rel = (o.t - phase) / secPerBeat;
        const dist = Math.abs(rel - Math.round(rel));
        score += o.strength * Math.max(0, 1 - dist * 4);
      }
      if (score > best) {
        best = score;
        beatOffset = phase;
      }
    }
  }

  /* ---- energy curve, one bucket per second ------------------------ */
  const seconds = Math.max(1, Math.ceil(duration));
  const energyCurve = new Array<number>(seconds).fill(0);
  const counts = new Array<number>(seconds).fill(0);
  for (let i = 0; i < mono.length; i += 64) {
    const sIdx = Math.min(seconds - 1, Math.floor(i / sr));
    energyCurve[sIdx] += mono[i] * mono[i];
    counts[sIdx]++;
  }
  let peakEnergy = 0;
  for (let sIdx = 0; sIdx < seconds; sIdx++) {
    energyCurve[sIdx] = Math.sqrt(energyCurve[sIdx] / Math.max(1, counts[sIdx]));
    if (energyCurve[sIdx] > peakEnergy) peakEnergy = energyCurve[sIdx];
  }
  if (peakEnergy > 0) for (let sIdx = 0; sIdx < seconds; sIdx++) energyCurve[sIdx] /= peakEnergy;

  const { key, major } = estimateKey(chroma);

  onProgress?.({ phase: 'charting', value: 1 });
  return {
    version: ANALYSIS_VERSION,
    duration,
    bpm,
    beatOffset,
    onsets: raw,
    energyCurve,
    key,
    major,
  };
}

/**
 * Krumhansl-Schmuckler key finding: correlate the track's average chroma
 * against the two tonal profiles at all twelve rotations and take the best fit.
 *
 * Accuracy caveat, measured rather than assumed: on synthetic chord
 * progressions this lands on a diatonic *neighbour* of the true key (C major
 * read as F major) rather than the key itself — upper partials put a fifth's
 * worth of energy in the histogram and drag the estimate toward the dominant.
 * Kept because a neighbouring key still shares most of its notes, so a
 * pentatonic drawn from it is usually consonant. Not reliable enough to
 * advertise as "in key", which is why the piano layer is off by default.
 */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function estimateKey(chroma: ArrayLike<number>): { key: number; major: boolean } {
  let total = 0;
  for (let i = 0; i < 12; i++) total += chroma[i];
  if (total <= 0) return { key: 0, major: false };

  const norm: number[] = [];
  for (let i = 0; i < 12; i++) norm.push(chroma[i] / total);

  const correlate = (profile: number[], rotation: number): number => {
    let meanA = 0;
    let meanB = 0;
    for (let i = 0; i < 12; i++) {
      meanA += norm[(i + rotation) % 12];
      meanB += profile[i];
    }
    meanA /= 12;
    meanB /= 12;

    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < 12; i++) {
      const a = norm[(i + rotation) % 12] - meanA;
      const b = profile[i] - meanB;
      num += a * b;
      da += a * a;
      db += b * b;
    }
    return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
  };

  let best = -Infinity;
  let key = 0;
  let major = false;
  for (let r = 0; r < 12; r++) {
    const maj = correlate(MAJOR_PROFILE, r);
    if (maj > best) {
      best = maj;
      key = r;
      major = true;
    }
    const min = correlate(MINOR_PROFILE, r);
    if (min > best) {
      best = min;
      key = r;
      major = false;
    }
  }
  return { key, major };
}

export const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/* ------------------------------------------------------------------ *
 * chart building
 * ------------------------------------------------------------------ */

/**
 * What each difficulty does to a chart.
 *
 *   nps        how many onsets per second to aim for
 *   laneGap    how fast one lane may repeat — a hand's speed limit
 *   anyGap     how close any two separate moments may sit
 *   maxNotes   how many lanes a single moment may fire at once
 *   chordAt    a secondary band group becomes its own note above this share
 *              of the loudest group's energy
 *
 * The last two are what make the top difficulty a two-hand chart rather than
 * just a faster one: when a kick, a snare and a cymbal land together, Pillar
 * plays all three as a chord while Novice plays only the loudest.
 */
const DIFFICULTY_SHAPE: Record<
  string,
  { nps: number; laneGap: number; anyGap: number; maxNotes: number; chordAt: number }
> = {
  mizunoto: { nps: 1.8, laneGap: 0.4, anyGap: 0.2, maxNotes: 1, chordAt: 2 },
  hinoe: { nps: 3.4, laneGap: 0.24, anyGap: 0.115, maxNotes: 1, chordAt: 2 },
  kinoe: { nps: 5.4, laneGap: 0.15, anyGap: 0.07, maxNotes: 2, chordAt: 0.62 },
  hashira: { nps: 8.5, laneGap: 0.095, anyGap: 0.05, maxNotes: 3, chordAt: 0.34 },
};

/** A pitch in the track's key, chosen so brighter onsets sit higher. */
function pentatonicMidi(analysis: TrackAnalysis, centroid: number): number {
  const degrees = analysis.major ? [0, 2, 4, 7, 9] : [0, 3, 5, 7, 10];
  const step = Math.round(Math.min(1, Math.max(0, centroid)) * (degrees.length * 2 - 1));
  const octave = Math.floor(step / degrees.length);
  return 48 + analysis.key + octave * 12 + degrees[step % degrees.length];
}

/**
 * Columns belonging to one acoustic group, as a contiguous slice proportional
 * to the field width. On four lanes each group owns exactly one column; on
 * eight it owns two, so a busy hi-hat pattern alternates across its pair
 * instead of machine-gunning a single key.
 */
function lanesForGroup(group: number, laneCount: number): number[] {
  const start = Math.floor((group / GROUPS) * laneCount);
  const end = Math.max(start + 1, Math.floor(((group + 1) / GROUPS) * laneCount));
  const out: number[] = [];
  for (let l = start; l < end && l < laneCount; l++) out.push(l);
  return out.length ? out : [Math.min(laneCount - 1, start)];
}

export function chartFromAnalysis(
  analysis: TrackAnalysis,
  difficulty: Difficulty,
  trackId: string,
  laneCount: LaneCount = DEFAULT_LANE_COUNT,
): Chart {
  const shape = DIFFICULTY_SHAPE[difficulty.id] ?? DIFFICULTY_SHAPE.hinoe;
  const secPerBeat = 60 / analysis.bpm;
  const sixteenth = secPerBeat / 4;

  /*
   * Pick a strength threshold near the target note count — but never below an
   * absolute floor.
   *
   * Without the floor, a difficulty asking for 6.8 notes a second against a
   * track containing only 4 real onsets a second fills the gap with the
   * weakest detections in the envelope, which are noise.
   *
   * Kept deliberately near zero. Strength is normalised against the single
   * loudest transient in the track, and on real music that transient is far
   * above everything else — a floor of 0.08 discarded 75% of a track's onsets
   * before difficulty was even considered, so all four charts received the
   * same material and differed only in their gap limits. This is now a guard
   * against true silence, and the per-difficulty target below does the real
   * thinning.
   */
  const MIN_ONSET_STRENGTH = 0.012;
  const target = Math.max(24, Math.round(shape.nps * analysis.duration));
  const sorted = [...analysis.onsets].sort((a, b) => b.strength - a.strength);
  const byTarget = sorted.length > target ? sorted[target - 1].strength : 0;
  const cutoff = Math.max(byTarget, MIN_ONSET_STRENGTH);

  /*
   * Walk in time order enforcing two separate limits: how close two notes may
   * sit in the same lane (a hand cannot repeat faster than that), and how
   * close any two notes may sit at all (which caps total density while still
   * letting a kick and a cymbal land together as a chord).
   */
  const kept: Array<{ onset: AnalyzedOnset; lanes: number[] }> = [];
  const lastInLane = new Array<number>(laneCount).fill(-1e9);
  const groupCursor = new Array<number>(GROUPS).fill(0);
  let lastAny = -1e9;

  for (const o of analysis.onsets) {
    if (o.strength < cutoff) continue;

    // Simultaneous notes in different lanes are allowed; near-misses are not.
    const gap = o.t - lastAny;
    if (gap > 0.012 && gap < shape.anyGap) continue;

    /*
     * Which band groups were loud enough to earn their own lane at this
     * moment. Always at least the primary; others only on the harder charts.
     */
    const mix = o.groups ?? [];
    const candidates: number[] = [o.group ?? 0];
    if (shape.maxNotes > 1) {
      const others = mix
        .map((energy, g) => ({ energy, g }))
        .filter((x) => x.g !== (o.group ?? 0) && x.energy >= shape.chordAt)
        .sort((a, b) => b.energy - a.energy)
        .map((x) => x.g);
      for (const g of others) {
        if (candidates.length >= shape.maxNotes) break;
        candidates.push(g);
      }
    }

    // Round-robin within each group's columns, skipping any still on cooldown.
    const lanes: number[] = [];
    for (const g of candidates) {
      const columns = lanesForGroup(g, laneCount);
      for (let i = 0; i < columns.length; i++) {
        const candidate = columns[(groupCursor[g] + i) % columns.length];
        if (lanes.includes(candidate)) continue;
        if (o.t - lastInLane[candidate] < shape.laneGap) continue;
        lanes.push(candidate);
        groupCursor[g] = (columns.indexOf(candidate) + 1) % columns.length;
        break;
      }
    }
    if (!lanes.length) continue;

    kept.push({ onset: o, lanes });
    for (const lane of lanes) lastInLane[lane] = o.t;
    lastAny = o.t;
  }

  const notes: ChartNote[] = [];
  let id = 0;
  let holdCount = 0;
  let lastWasHold = false;

  for (let i = 0; i < kept.length; i++) {
    const { onset: o, lanes } = kept[i];

    /*
     * Quantisation is deliberately almost absent.
     *
     * The detector places onsets to within ~8ms of the real transient. Snapping
     * those to an estimated beat grid measured *worse* — 17ms — because the
     * grid itself carries tempo error that accumulates over a track. Since the
     * point is for notes to sit on the audio rather than on a theoretical grid,
     * the snap now only absorbs sub-frame jitter and otherwise leaves the
     * detected time alone.
     */
    const rel = (o.t - analysis.beatOffset) / sixteenth;
    const snapped = analysis.beatOffset + Math.round(rel) * sixteenth;
    const t = Math.abs(snapped - o.t) < 0.012 ? snapped : o.t;

    /*
     * A strong hit followed by a long gap becomes a hold. Rate-limited so
     * sparse charts, where long gaps are everywhere, do not become all holds.
     */
    const gapToNext = i + 1 < kept.length ? kept[i + 1].onset.t - o.t : 4;
    const canHold =
      gapToNext > 1.1 && o.strength > 0.5 && !lastWasHold && holdCount < kept.length / 8;
    if (canHold) {
      holdCount++;
      lastWasHold = true;
    } else {
      lastWasHold = false;
    }

    for (const lane of lanes) {
      notes.push({
        id: id++,
        time: PRE_ROLL + t,
        beat: (t - analysis.beatOffset) / secPerBeat,
        lane,
        // Only the primary lane sustains; a chord's extra notes stay taps.
        kind: canHold && lane === lanes[0] ? 'hold' : 'tap',
        duration: canHold && lane === lanes[0] ? Math.min(1.3, gapToNext * 0.5) : 0,
      /* Imported tracks carry their own audio; this pitch is only used by the
         optional piano layer. See estimateKey() for how good the key is. */
        midi: pentatonicMidi(analysis, o.centroid),
        instrument: 'piano',
        intensity: Math.min(1, 0.35 + o.strength * 0.75),
        chord: lanes.length > 1,
      });
    }
  }

  /* mark simultaneous notes so the renderer can tint them */
  for (let i = 1; i < notes.length; i++) {
    if (Math.abs(notes[i].time - notes[i - 1].time) < 0.012) {
      notes[i].chord = true;
      notes[i - 1].chord = true;
    }
  }

  /* --- sections from the energy curve, for background staging ------ */
  const sections: SectionSpan[] = [];
  const SECTION_COUNT = 7;
  const sectionLength = analysis.duration / SECTION_COUNT;
  const NAMES = ['Opening', 'First Verse', 'Rise', 'Chorus', 'Break', 'Final Push', 'Fade'];
  for (let s = 0; s < SECTION_COUNT; s++) {
    const startTime = PRE_ROLL + s * sectionLength;
    let sum = 0;
    let n = 0;
    for (let sec = Math.floor(s * sectionLength); sec < Math.ceil((s + 1) * sectionLength); sec++) {
      if (sec < analysis.energyCurve.length) {
        sum += analysis.energyCurve[sec];
        n++;
      }
    }
    sections.push({
      name: NAMES[s],
      startBeat: (s * sectionLength) / secPerBeat,
      endBeat: ((s + 1) * sectionLength) / secPerBeat,
      startTime,
      endTime: startTime + sectionLength,
      intensity: n ? Math.min(1, sum / n) : 0.5,
    });
  }

  const duration = PRE_ROLL + analysis.duration + 2.2;
  const buckets = Math.max(1, Math.ceil(duration));
  const densityCurve = new Array<number>(buckets).fill(0);
  for (const n of notes) densityCurve[Math.min(buckets - 1, Math.floor(n.time))]++;

  return {
    songId: trackId,
    difficultyId: difficulty.id,
    laneCount,
    bpm: Math.round(analysis.bpm),
    secPerBeat,
    notes,
    // No synthesised backing: the imported audio is the backing track.
    backing: [],
    sections,
    duration,
    noteCount: notes.length,
    peakDensity: densityCurve.reduce((m, v) => Math.max(m, v), 0),
    densityCurve,
  };
}
