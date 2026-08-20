/**
 * Tracks discovered in content/music.
 *
 * An imported track is stored as a file path plus its cached analysis — never
 * the audio itself. That keeps the settings file small and means the game
 * always plays the MP3 from that folder. Re-analysing on every launch would
 * cost seconds per track, so the onsets and tempo are cached.
 */

import type { TrackAnalysis } from '../audio/analyzer';
import type { SongSpec, DifficultyId } from './songs';
import { DIFFICULTIES } from './songs';

export const CUSTOM_PREFIX = 'custom:';

export interface CustomTrack {
  /** `custom:<hash of path>` */
  id: string;
  path: string;
  title: string;
  duration: number;
  bpm: number;
  addedAt: number;
  analysis: TrackAnalysis;
  /** Only tracks discovered in content/music are admitted to the library. */
  source?: 'music-folder';
  /** Set when the file has gone missing since it was imported. */
  missing?: boolean;
}

export const isCustomId = (id: string): boolean => id.startsWith(CUSTOM_PREFIX);

function hashString(s: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export const trackIdFor = (path: string): string => CUSTOM_PREFIX + hashString(path);

/** Palettes folder tracks cycle through, so the play field still has colour. */
const PALETTES: Array<[string, string]> = [
  ['#ff7a45', '#5c1414'],
  ['#b98ce0', '#4a2d78'],
  ['#7fdcc0', '#123a33'],
  ['#ffcf4d', '#6b1f00'],
  ['#6aa8ff', '#152a5c'],
  ['#ff6b9d', '#5c1436'],
  ['#5fd39a', '#12432f'],
  ['#c86bff', '#2a0b45'],
];

/** Trim float precision so a library of tracks stays a reasonable JSON size. */
export function compactAnalysis(a: TrackAnalysis): TrackAnalysis {
  const r = (v: number, p = 3) => Math.round(v * 10 ** p) / 10 ** p;
  return {
    duration: r(a.duration, 2),
    bpm: r(a.bpm, 2),
    beatOffset: r(a.beatOffset, 4),
    onsets: a.onsets.map((o) => ({
      t: r(o.t, 3),
      strength: r(o.strength, 3),
      group: o.group,
      groups: o.groups.map((v) => r(v, 2)),
      centroid: r(o.centroid, 3),
    })),
    energyCurve: a.energyCurve.map((v) => r(v, 2)),
    key: a.key,
    major: a.major,
    version: a.version,
  };
}

/**
 * Present a folder track using the SongSpec display shape used by the HUD.
 */
export function customToSongSpec(track: CustomTrack): SongSpec {
  const [hue, hue2] = PALETTES[Math.abs(hashString(track.id).charCodeAt(0)) % PALETTES.length];
  const density = track.analysis.onsets.length / Math.max(1, track.analysis.duration);

  const levels = {} as Record<DifficultyId, number>;
  for (const d of DIFFICULTIES) {
    const nps = Math.min(density, 1.7 + d.density * 5.2);
    levels[d.id] = Math.max(1, Math.min(12, Math.round(nps * 1.5 + track.bpm / 110)));
  }

  return {
    id: track.id,
    kanji: track.title,
    romaji: 'MUSIC FOLDER MP3',
    english: track.title,
    lore: track.missing
      ? 'The MP3 is no longer present in content/music. Restore it and restart the game.'
      : 'Loaded from content/music. The chart was generated from the recording itself — every note follows an onset in the mix.',
    bpm: Math.round(track.bpm),
    root: 57,
    scale: 'yo',
    hue,
    hue2,
    levels,
    arrangement: [],
  };
}
