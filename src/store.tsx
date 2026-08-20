/**
 * App-wide state: settings, unlock progress, and the current selection.
 *
 * Persistence goes through the Electron preload bridge when it exists and
 * falls back to localStorage in the browser, so `npm run dev:vite` alone is a
 * perfectly usable development target.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { BreathingId } from './data/breathing';
import type { DifficultyId } from './data/songs';
import type { CustomTrack } from './data/library';
import {
  DEFAULT_LANE_COUNT,
  defaultKeysFor,
  normaliseLaneSettings,
  type LaneCount,
} from './game/lanes';

declare global {
  interface Window {
    kizuna?: {
      isDesktop: boolean;
      loadSettings: () => Promise<Record<string, unknown>>;
      saveSettings: (data: unknown) => Promise<boolean>;
      appInfo: () => Promise<{ version: string; platform: string }>;
      toggleFullscreen: () => Promise<boolean>;
      readAudio: (filePath: string) => Promise<ArrayBuffer>;
      audioExists: (filePath: string) => Promise<boolean>;
      scanMusic: () => Promise<Array<{ path: string; name: string; source: 'music-folder' }>>;
      musicFolder: () => Promise<string>;
      revealMusicFolder: () => Promise<string>;
    };
  }
}

export interface Settings {
  laneCount: LaneCount;
  keys: string[];
  artKey: string;
  scrollSpeed: number;
  /** Seconds. Positive means the player's hits register late. */
  audioOffset: number;
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  noFail: boolean;
  reducedEffects: boolean;
  showLaneGuides: boolean;
  showTimingBar: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  laneCount: DEFAULT_LANE_COUNT,
  keys: defaultKeysFor(DEFAULT_LANE_COUNT),
  artKey: ' ',
  scrollSpeed: 1,
  audioOffset: 0,
  masterVolume: 0.85,
  musicVolume: 0.8,
  sfxVolume: 0.75,
  noFail: false,
  reducedEffects: false,
  showLaneGuides: true,
  showTimingBar: true,
};

export interface ScoreRecord {
  score: number;
  accuracy: number;
  maxCombo: number;
  grade: number;
  fullCombo: boolean;
  playedAt: number;
}

export type Records = Record<string, ScoreRecord>;

export const recordKey = (song: string, diff: DifficultyId, style: BreathingId) =>
  `${song}|${diff}|${style}`;

/** Best result for a song+difficulty across every breathing style. */
export const bestFor = (
  records: Records,
  song: string,
  diff: DifficultyId,
): ScoreRecord | null => {
  let best: ScoreRecord | null = null;
  for (const [k, v] of Object.entries(records)) {
    const [s, d] = k.split('|');
    if (s !== song || d !== diff) continue;
    if (!best || v.score > best.score) best = v;
  }
  return best;
};

export const bestGradeForSong = (records: Records, song: string): number => {
  let g = -1;
  for (const [k, v] of Object.entries(records)) {
    if (k.split('|')[0] !== song) continue;
    g = Math.max(g, v.grade);
  }
  return g;
};

interface StoreValue {
  settings: Settings;
  setSettings: (patch: Partial<Settings>) => void;
  resetSettings: () => void;
  records: Records;
  submitRecord: (key: string, rec: ScoreRecord) => boolean;
  style: BreathingId;
  setStyle: (s: BreathingId) => void;
  songId: string;
  setSongId: (s: string) => void;
  difficulty: DifficultyId;
  setDifficulty: (d: DifficultyId) => void;
  tracks: CustomTrack[];
  addTrack: (t: CustomTrack) => void;
  removeTrack: (id: string) => void;
  markTrackMissing: (id: string, missing: boolean) => void;
  loaded: boolean;
}

const StoreContext = createContext<StoreValue | null>(null);

const STORAGE_KEY = 'kizuna-blade:v1';

async function loadPersisted(): Promise<Record<string, unknown>> {
  if (window.kizuna) {
    try {
      return await window.kizuna.loadSettings();
    } catch {
      /* fall through to localStorage */
    }
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function persist(data: unknown): Promise<void> {
  if (window.kizuna) {
    try {
      await window.kizuna.saveSettings(data);
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* storage full or unavailable — settings simply won't survive a restart */
  }
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [settings, setSettingsState] = useState<Settings>(DEFAULT_SETTINGS);
  const [records, setRecords] = useState<Records>({});
  const [style, setStyle] = useState<BreathingId>('water');
  const [songId, setSongId] = useState<string>('hearth');
  const [difficulty, setDifficulty] = useState<DifficultyId>('hinoe');
  const [tracks, setTracks] = useState<CustomTrack[]>([]);
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    void loadPersisted().then((data) => {
      if (!alive) return;
      if (data.settings && typeof data.settings === 'object') {
        const saved = data.settings as Partial<Settings>;
        const lanes = normaliseLaneSettings(saved.laneCount, saved.keys);
        setSettingsState({ ...DEFAULT_SETTINGS, ...saved, ...lanes });
      }
      if (data.records && typeof data.records === 'object') {
        setRecords(data.records as Records);
      }
      if (Array.isArray(data.tracks)) setTracks(data.tracks as CustomTrack[]);
      if (typeof data.style === 'string') setStyle(data.style as BreathingId);
      if (typeof data.difficulty === 'string')
        setDifficulty(data.difficulty as DifficultyId);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Debounced write — settings sliders fire continuously while dragging.
  useEffect(() => {
    if (!loaded) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void persist({ settings, records, style, difficulty, tracks });
    }, 350);
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, [settings, records, style, difficulty, tracks, loaded]);

  const setSettings = useCallback((patch: Partial<Settings>) => {
    setSettingsState((prev) => ({ ...prev, ...patch }));
  }, []);

  const resetSettings = useCallback(() => {
    setSettingsState({
      ...DEFAULT_SETTINGS,
      keys: defaultKeysFor(DEFAULT_SETTINGS.laneCount),
    });
  }, []);

  /** Returns true when this run beat the stored best. */
  const submitRecord = useCallback((key: string, rec: ScoreRecord) => {
    let improved = false;
    setRecords((prev) => {
      const existing = prev[key];
      if (existing && existing.score >= rec.score) return prev;
      improved = true;
      return { ...prev, [key]: rec };
    });
    return improved;
  }, []);

  /** Re-importing an existing path replaces it rather than duplicating. */
  const addTrack = useCallback((t: CustomTrack) => {
    setTracks((prev) => [t, ...prev.filter((x) => x.id !== t.id)]);
  }, []);

  const removeTrack = useCallback((id: string) => {
    setTracks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const markTrackMissing = useCallback((id: string, missing: boolean) => {
    setTracks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, missing } : t)),
    );
  }, []);

  const value = useMemo<StoreValue>(
    () => ({
      settings,
      setSettings,
      resetSettings,
      records,
      submitRecord,
      style,
      setStyle,
      songId,
      setSongId,
      difficulty,
      setDifficulty,
      tracks,
      addTrack,
      removeTrack,
      markTrackMissing,
      loaded,
    }),
    [
      settings, setSettings, resetSettings, records, submitRecord, style,
      songId, difficulty, tracks, addTrack, removeTrack, markTrackMissing, loaded,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const v = useContext(StoreContext);
  if (!v) throw new Error('useStore must be used inside <StoreProvider>');
  return v;
}
