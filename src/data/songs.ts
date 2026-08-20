/**
 * Song specifications.
 *
 * Nothing here is an audio file. A song is a *score*: tempo, mode, and an
 * arrangement of sections. `composer.ts` expands a spec into (a) a backing
 * track the synth performs and (b) a playable chart. Because both come out of
 * the same expansion, notes and audio can never drift out of agreement.
 */

export type ScaleName =
  | 'hirajoshi'
  | 'insen'
  | 'yo'
  | 'iwato'
  | 'kumoi'
  | 'ryukyu';

export type DrumStyle =
  | 'none'
  | 'sparse'
  | 'taiko'
  | 'driving'
  | 'double'
  | 'break'
  | 'matsuri';

export type LeadStyle =
  | 'none'
  | 'call'
  | 'phrase'
  | 'run'
  | 'flurry'
  | 'chant';

export type DifficultyId = 'mizunoto' | 'hinoe' | 'kinoe' | 'hashira';

export interface Difficulty {
  id: DifficultyId;
  kanji: string;
  romaji: string;
  english: string;
  color: string;
  /** Scales note density in the composer. */
  density: number;
}

export const DIFFICULTIES: Difficulty[] = [
  {
    id: 'mizunoto',
    kanji: '癸',
    romaji: 'MIZUNOTO',
    english: 'Novice',
    color: '#6aa8ff',
    density: 0.42,
  },
  {
    id: 'hinoe',
    kanji: '丙',
    romaji: 'HINOE',
    english: 'Adept',
    color: '#5fd39a',
    density: 0.68,
  },
  {
    id: 'kinoe',
    kanji: '甲',
    romaji: 'KINOE',
    english: 'Elite',
    color: '#ffb54d',
    density: 0.88,
  },
  {
    id: 'hashira',
    kanji: '柱',
    romaji: 'HASHIRA',
    english: 'Pillar',
    color: '#ff4d6a',
    density: 1,
  },
];

export interface Section {
  name: string;
  bars: number;
  /** 0..1 — drives note density, synth brightness and background energy. */
  intensity: number;
  drums: DrumStyle;
  lead: LeadStyle;
  bass: boolean;
  pad: boolean;
  bell?: boolean;
  /** Semitone transposition of the mode for this section. */
  transpose?: number;
}

export interface SongSpec {
  id: string;
  kanji: string;
  romaji: string;
  english: string;
  lore: string;
  bpm: number;
  /** MIDI note number of the mode's root. */
  root: number;
  scale: ScaleName;
  /** Palette hint for the song-select card and play-field sky. */
  hue: string;
  hue2: string;
  levels: Record<DifficultyId, number>;
  arrangement: Section[];
  /** Unlocked from the start, or earned. */
  unlockedBy?: { song: string; grade: number };
}

export const SONGS: SongSpec[] = [
  {
    id: 'hearth',
    kanji: '竈の火',
    romaji: 'KAMADO NO HI',
    english: 'Hearth Fire',
    lore: 'Snow on the roof, charcoal in the basket, everyone still home.',
    bpm: 124,
    root: 57, // A3
    scale: 'yo',
    hue: '#f0a35e',
    hue2: '#7a3b1f',
    levels: { mizunoto: 1, hinoe: 3, kinoe: 5, hashira: 7 },
    arrangement: [
      { name: 'Snowfall', bars: 4, intensity: 0.1, drums: 'none', lead: 'none', bass: false, pad: true, bell: true },
      { name: 'First Light', bars: 8, intensity: 0.3, drums: 'sparse', lead: 'call', bass: true, pad: true },
      { name: 'The Walk Down', bars: 8, intensity: 0.5, drums: 'taiko', lead: 'phrase', bass: true, pad: true },
      { name: 'Warmth', bars: 8, intensity: 0.66, drums: 'taiko', lead: 'phrase', bass: true, pad: true, bell: true },
      { name: 'Ash', bars: 4, intensity: 0.35, drums: 'sparse', lead: 'call', bass: true, pad: true },
      { name: 'Ember', bars: 8, intensity: 0.8, drums: 'driving', lead: 'run', bass: true, pad: true, bell: true },
      { name: 'Rest', bars: 4, intensity: 0.15, drums: 'none', lead: 'call', bass: false, pad: true, bell: true },
    ],
  },
  {
    id: 'wisteria',
    kanji: '藤の花',
    romaji: 'FUJI NO HANA',
    english: 'Wisteria',
    lore: 'The blossoms hang all year at the foot of the mountain. Nothing with a taste for blood comes past them.',
    bpm: 138,
    root: 62, // D4
    scale: 'kumoi',
    hue: '#b98ce0',
    hue2: '#4a2d78',
    levels: { mizunoto: 2, hinoe: 4, kinoe: 6, hashira: 8 },
    arrangement: [
      { name: 'Under the Arch', bars: 4, intensity: 0.18, drums: 'none', lead: 'call', bass: false, pad: true, bell: true },
      { name: 'Purple Rain', bars: 8, intensity: 0.42, drums: 'sparse', lead: 'phrase', bass: true, pad: true },
      { name: 'Pollen', bars: 8, intensity: 0.6, drums: 'taiko', lead: 'phrase', bass: true, pad: true },
      { name: 'The Scent Carries', bars: 8, intensity: 0.75, drums: 'driving', lead: 'run', bass: true, pad: true, bell: true },
      { name: 'Held Breath', bars: 4, intensity: 0.28, drums: 'break', lead: 'call', bass: true, pad: true },
      { name: 'Full Bloom', bars: 12, intensity: 0.9, drums: 'matsuri', lead: 'flurry', bass: true, pad: true, bell: true, transpose: 2 },
      { name: 'Falling', bars: 4, intensity: 0.2, drums: 'none', lead: 'call', bass: false, pad: true, bell: true },
    ],
  },
  {
    id: 'nighttrain',
    kanji: '夜行列車',
    romaji: 'YAKŌ RESSHA',
    english: 'Night Train',
    lore: 'Two hundred passengers asleep and dreaming the same dream. Something is walking the aisle.',
    bpm: 152,
    root: 55, // G3
    scale: 'insen',
    hue: '#ff7a45',
    hue2: '#5c1414',
    levels: { mizunoto: 3, hinoe: 6, kinoe: 8, hashira: 10 },
    arrangement: [
      { name: 'Steam', bars: 4, intensity: 0.22, drums: 'sparse', lead: 'none', bass: true, pad: true },
      { name: 'On the Rails', bars: 8, intensity: 0.55, drums: 'driving', lead: 'phrase', bass: true, pad: true },
      { name: 'Carriage Six', bars: 8, intensity: 0.7, drums: 'driving', lead: 'run', bass: true, pad: true },
      { name: 'Wake Up', bars: 8, intensity: 0.86, drums: 'double', lead: 'flurry', bass: true, pad: false },
      { name: 'Dream Logic', bars: 4, intensity: 0.3, drums: 'break', lead: 'chant', bass: false, pad: true, bell: true, transpose: -3 },
      { name: 'Set Your Heart Ablaze', bars: 12, intensity: 0.95, drums: 'matsuri', lead: 'flurry', bass: true, pad: true, bell: true, transpose: 3 },
      { name: 'Dawn at the Station', bars: 4, intensity: 0.25, drums: 'sparse', lead: 'call', bass: true, pad: true, bell: true },
    ],
  },
  {
    id: 'spidermtn',
    kanji: '蜘蛛の山',
    romaji: 'KUMO NO YAMA',
    english: 'Spider Mountain',
    lore: 'Every thread on this slope is attached to something, and all of it is attached to one family.',
    bpm: 146,
    root: 54, // F#3
    scale: 'iwato',
    hue: '#7fdcc0',
    hue2: '#123a33',
    levels: { mizunoto: 3, hinoe: 5, kinoe: 8, hashira: 10 },
    arrangement: [
      { name: 'Silk', bars: 4, intensity: 0.16, drums: 'none', lead: 'call', bass: false, pad: true, bell: true },
      { name: 'Puppetry', bars: 8, intensity: 0.5, drums: 'sparse', lead: 'phrase', bass: true, pad: true },
      { name: 'Marionette', bars: 8, intensity: 0.72, drums: 'taiko', lead: 'run', bass: true, pad: true },
      { name: 'Cut the Strings', bars: 8, intensity: 0.9, drums: 'double', lead: 'flurry', bass: true, pad: false },
      { name: 'Something Older', bars: 6, intensity: 0.44, drums: 'break', lead: 'chant', bass: true, pad: true, transpose: -2 },
      { name: 'Down the Slope', bars: 12, intensity: 0.94, drums: 'matsuri', lead: 'flurry', bass: true, pad: true, bell: true },
      { name: 'Quiet Web', bars: 4, intensity: 0.18, drums: 'none', lead: 'call', bass: false, pad: true, bell: true },
    ],
  },
  {
    id: 'uppermoon',
    kanji: '上弦の月',
    romaji: 'JŌGEN NO TSUKI',
    english: 'Upper Moon',
    lore: 'A number carved into an eye. Centuries of practice behind it, and all the time in the world.',
    bpm: 172,
    root: 52, // E3
    scale: 'hirajoshi',
    hue: '#c86bff',
    hue2: '#2a0b45',
    levels: { mizunoto: 4, hinoe: 7, kinoe: 9, hashira: 11 },
    unlockedBy: { song: 'nighttrain', grade: 3 },
    arrangement: [
      { name: 'Descent', bars: 4, intensity: 0.3, drums: 'sparse', lead: 'chant', bass: true, pad: true },
      { name: 'Appraisal', bars: 8, intensity: 0.62, drums: 'taiko', lead: 'phrase', bass: true, pad: true },
      { name: 'Blood Demon Art', bars: 8, intensity: 0.82, drums: 'double', lead: 'run', bass: true, pad: true },
      { name: 'Compass Needle', bars: 8, intensity: 0.92, drums: 'double', lead: 'flurry', bass: true, pad: false, transpose: 1 },
      { name: 'Memory', bars: 6, intensity: 0.4, drums: 'break', lead: 'chant', bass: false, pad: true, bell: true, transpose: -4 },
      { name: 'Transparent World', bars: 14, intensity: 1, drums: 'matsuri', lead: 'flurry', bass: true, pad: true, bell: true, transpose: 4 },
      { name: 'Sunrise', bars: 4, intensity: 0.24, drums: 'none', lead: 'call', bass: false, pad: true, bell: true },
    ],
  },
  {
    id: 'nichirin',
    kanji: '日輪',
    romaji: 'NICHIRIN',
    english: 'Sun Wheel',
    lore: 'Ore pulled from the peaks closest to the sun. It only ever wanted to be a blade.',
    bpm: 190,
    root: 50, // D3
    scale: 'ryukyu',
    hue: '#ffcf4d',
    hue2: '#6b1f00',
    levels: { mizunoto: 5, hinoe: 8, kinoe: 10, hashira: 12 },
    unlockedBy: { song: 'uppermoon', grade: 4 },
    arrangement: [
      { name: 'The Forge', bars: 4, intensity: 0.4, drums: 'taiko', lead: 'call', bass: true, pad: true },
      { name: 'Quench', bars: 8, intensity: 0.7, drums: 'driving', lead: 'run', bass: true, pad: true },
      { name: 'Hi no Kami', bars: 12, intensity: 0.9, drums: 'matsuri', lead: 'flurry', bass: true, pad: true, bell: true },
      { name: 'Twelve Forms', bars: 8, intensity: 0.96, drums: 'double', lead: 'flurry', bass: true, pad: false, transpose: 2 },
      { name: 'Stillness', bars: 4, intensity: 0.3, drums: 'break', lead: 'chant', bass: false, pad: true, bell: true },
      { name: 'Dance of the Fire God', bars: 16, intensity: 1, drums: 'matsuri', lead: 'flurry', bass: true, pad: true, bell: true, transpose: 5 },
      { name: 'Held', bars: 4, intensity: 0.2, drums: 'none', lead: 'call', bass: false, pad: true, bell: true },
    ],
  },
];

export const getSong = (id: string): SongSpec =>
  SONGS.find((s) => s.id === id) ?? SONGS[0];

export const getDifficulty = (id: DifficultyId): Difficulty =>
  DIFFICULTIES.find((d) => d.id === id) ?? DIFFICULTIES[0];
