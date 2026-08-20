/**
 * Breathing styles double as the game's "characters". Each one bends the rules
 * a little, so picking a style is a real strategic choice rather than a skin.
 */

export type BreathingId =
  | 'water'
  | 'flame'
  | 'thunder'
  | 'wind'
  | 'stone'
  | 'mist';

export interface BreathingStyle {
  id: BreathingId;
  kanji: string;
  romaji: string;
  english: string;
  /** The style's signature "form", used as the ultimate's on-screen title. */
  formKanji: string;
  formRomaji: string;
  tagline: string;
  description: string;

  /** UI + play-field palette. */
  accent: string;
  accent2: string;
  /** Particle tint for hit bursts. */
  spark: string;

  modifiers: {
    /** Extra milliseconds added to every judgement window. */
    windowBonus: number;
    /** Multiplier applied to note scroll speed. */
    scrollMul: number;
    /** Flat multiplier on final score. */
    scoreMul: number;
    /** How fast the concentration gauge fills, relative to normal. */
    gaugeRate: number;
    /** Misses absorbed before the combo actually breaks. */
    shieldPerCombo: number;
    /** Notes fade out this fraction of the way down the lane (Mist). */
    fadeFrom: number;
  };

  /** One line the UI shows to explain the trade-off in plain language. */
  perk: string;
  cost: string;
}

export const BREATHING_STYLES: BreathingStyle[] = [
  {
    id: 'water',
    kanji: '水の呼吸',
    romaji: 'MIZU NO KOKYŪ',
    english: 'Water Breathing',
    formKanji: '拾ノ型・生生流転',
    formRomaji: 'TENTH FORM — CONSTANT FLUX',
    tagline: 'Flow, adapt, never break.',
    description:
      'The forgiving style. Timing windows widen and the current carries you through rough passages. Start here if you are learning a song.',
    accent: '#4fc3f7',
    accent2: '#1c62b8',
    spark: '#bfeaff',
    modifiers: {
      windowBonus: 16,
      scrollMul: 0.95,
      scoreMul: 0.94,
      gaugeRate: 1,
      shieldPerCombo: 0,
      fadeFrom: 0,
    },
    perk: 'Judgement windows +16ms',
    cost: 'Final score ×0.94',
  },
  {
    id: 'flame',
    kanji: '炎の呼吸',
    romaji: 'HONOO NO KOKYŪ',
    english: 'Flame Breathing',
    formKanji: '玖ノ型・煉獄',
    formRomaji: 'NINTH FORM — RENGOKU',
    tagline: 'Burn brighter the longer you hold.',
    description:
      'Combo is everything. The combo multiplier climbs past the normal ceiling, but a broken chain costs more than it does for anyone else.',
    accent: '#ff8534',
    accent2: '#d92f1c',
    spark: '#ffd8a8',
    modifiers: {
      windowBonus: 0,
      scrollMul: 1,
      scoreMul: 1.06,
      gaugeRate: 1,
      shieldPerCombo: 0,
      fadeFrom: 0,
    },
    perk: 'Combo multiplier caps at ×6 instead of ×4',
    cost: 'A miss resets the multiplier to ×1',
  },
  {
    id: 'thunder',
    kanji: '雷の呼吸',
    romaji: 'KAMINARI NO KOKYŪ',
    english: 'Thunder Breathing',
    formKanji: '壱ノ型・霹靂一閃',
    formRomaji: 'FIRST FORM — THUNDERCLAP AND FLASH',
    tagline: 'One strike. Nothing wasted.',
    description:
      'Notes arrive fast and leave faster. Reading time is cut down hard, and the score you take home is scaled up to match.',
    accent: '#ffd93d',
    accent2: '#c98b00',
    spark: '#fff5c2',
    modifiers: {
      windowBonus: -6,
      scrollMul: 1.35,
      scoreMul: 1.18,
      gaugeRate: 1.1,
      shieldPerCombo: 0,
      fadeFrom: 0,
    },
    perk: 'Final score ×1.18',
    cost: 'Scroll speed ×1.35, windows −6ms',
  },
  {
    id: 'wind',
    kanji: '風の呼吸',
    romaji: 'KAZE NO KOKYŪ',
    english: 'Wind Breathing',
    formKanji: '壱ノ型・塵旋風・削ぎ',
    formRomaji: 'FIRST FORM — DUST WHIRLWIND CUTTER',
    tagline: 'Keep moving. Keep cutting.',
    description:
      'The concentration gauge fills at almost double rate, so you spend far more of the song inside a Breathing Art.',
    accent: '#5fd39a',
    accent2: '#1f8f63',
    spark: '#c8f7e0',
    modifiers: {
      windowBonus: 4,
      scrollMul: 1.08,
      scoreMul: 1.02,
      gaugeRate: 1.85,
      shieldPerCombo: 0,
      fadeFrom: 0,
    },
    perk: 'Concentration builds ×1.85 faster',
    cost: 'Art duration is shorter each time',
  },
  {
    id: 'stone',
    kanji: '岩の呼吸',
    romaji: 'IWA NO KOKYŪ',
    english: 'Stone Breathing',
    formKanji: '伍ノ型・瓦輪刑部',
    formRomaji: 'FIFTH FORM — WHEEL OF STONE',
    tagline: 'Immovable. Unhurried.',
    description:
      'Every 40 notes of clean play forges a guard. A guard eats one miss without breaking your chain. Slow, heavy, extremely hard to kill.',
    accent: '#d9a441',
    accent2: '#8a5a1c',
    spark: '#ffe9b8',
    modifiers: {
      windowBonus: 8,
      scrollMul: 0.88,
      scoreMul: 0.97,
      gaugeRate: 0.85,
      shieldPerCombo: 40,
      fadeFrom: 0,
    },
    perk: 'Earns a miss-absorbing guard every 40 combo',
    cost: 'Gauge fills slower, score ×0.97',
  },
  {
    id: 'mist',
    kanji: '霞の呼吸',
    romaji: 'KASUMI NO KOKYŪ',
    english: 'Mist Breathing',
    formKanji: '柒ノ型・朧',
    formRomaji: 'SEVENTH FORM — OBSCURING CLOUD',
    tagline: 'You will not see it coming.',
    description:
      'Notes materialise out of fog barely in time to be read. The highest scoring multiplier in the game, for players who have the chart memorised.',
    accent: '#b8c4d9',
    accent2: '#5d6b85',
    spark: '#f0f4fb',
    modifiers: {
      windowBonus: 0,
      scrollMul: 1.15,
      scoreMul: 1.3,
      gaugeRate: 1,
      shieldPerCombo: 0,
      fadeFrom: 0.42,
    },
    perk: 'Final score ×1.30',
    cost: 'Notes are invisible for the top 42% of the lane',
  },
];

export const getStyle = (id: BreathingId): BreathingStyle =>
  BREATHING_STYLES.find((s) => s.id === id) ?? BREATHING_STYLES[0];
