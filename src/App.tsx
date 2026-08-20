import { useCallback, useEffect, useRef, useState } from 'react';
import { TitleScreen } from './screens/TitleScreen';
import { MenuScreen, type MenuTarget } from './screens/MenuScreen';
import { StyleScreen } from './screens/StyleScreen';
import { SongScreen } from './screens/SongScreen';
import { GameScreen, type RunResult } from './screens/GameScreen';
import { ResultScreen } from './screens/ResultScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { RecordsScreen } from './screens/RecordsScreen';
import { getStyle } from './data/breathing';
import { getSynth } from './audio/synth';
import { scanMusicFolders, importFromPaths, type ImportProgress } from './audio/import';
import { ANALYSIS_VERSION } from './audio/analyzer';
import { trackIdFor } from './data/library';
import { useStore } from './store';

type Screen =
  | 'title'
  | 'menu'
  | 'style'
  | 'song'
  | 'game'
  | 'result'
  | 'settings'
  | 'records';

export function App() {
  const {
    style,
    settings,
    loaded,
    tracks,
    markTrackMissing,
    addTrack,
    removeTrack,
  } = useStore();
  const [screen, setScreen] = useState<Screen>('title');
  const [result, setResult] = useState<RunResult | null>(null);
  const [wipe, setWipe] = useState<'' | 'cover' | 'reveal'>('');
  const [scanning, setScanning] = useState<ImportProgress | null>(null);

  const bs = getStyle(style);

  /* Push the active breathing style into CSS so every screen re-tints. */
  useEffect(() => {
    const r = document.documentElement;
    r.style.setProperty('--accent', bs.accent);
    r.style.setProperty('--accent-2', bs.accent2);
    r.style.setProperty('--accent-glow', `${bs.accent}8c`);
    r.style.setProperty('--accent-soft', `${bs.accent}20`);
  }, [bs]);

  useEffect(() => {
    if (!loaded) return;
    getSynth().setLevels({
      master: settings.masterVolume,
      music: settings.musicVolume,
      sfx: settings.sfxVolume,
    });
  }, [loaded, settings.masterVolume, settings.musicVolume, settings.sfxVolume]);

  /*
   * Imported tracks are stored as paths, so a file can disappear between
   * sessions. Check once on launch and flag anything that has moved, rather
   * than failing at the moment the player hits Deploy.
   */
  useEffect(() => {
    if (!loaded || !window.kizuna || !tracks.length) return;
    let alive = true;
    void (async () => {
      for (const t of tracks) {
        const exists = await window.kizuna!.audioExists(t.path);
        if (!alive) return;
        if (exists === !!t.missing) markTrackMissing(t.id, !exists);
      }
    })();
    return () => {
      alive = false;
    };
    // Deliberately keyed on load only: re-running per `tracks` change would
    // loop against the very state it writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  /*
   * content/music is the sole playable library. Reconcile old persisted tracks
   * against that folder first, then analyse any MP3 paths we have not seen.
   */
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;

  useEffect(() => {
    if (!loaded || !window.kizuna?.scanMusic) return;
    let alive = true;

    void (async () => {
      const found = await scanMusicFolders();
      if (!alive) return;

      const allowed = new Set(found.map((file) => trackIdFor(file.path)));
      for (const track of tracksRef.current) {
        if (!allowed.has(track.id)) {
          removeTrack(track.id);
        } else if (track.source !== 'music-folder') {
          // One-time migration for cached bundled tracks from older builds.
          addTrack({ ...track, source: 'music-folder' });
        }
      }

      /*
       * A track counts as known only if its cached analysis was produced by the
       * current detector. Bumping ANALYSIS_VERSION therefore re-analyses the
       * whole library on next launch, which is how existing tracks pick up
       * detection improvements without the player having to re-add them.
       */
      const known = new Set(
        tracksRef.current
          .filter(
            (track) =>
              allowed.has(track.id) && track.analysis?.version === ANALYSIS_VERSION,
          )
          .map((track) => track.id),
      );
      const fresh = found.filter((f) => !known.has(trackIdFor(f.path)));
      if (!fresh.length) {
        setScanning(null);
        return;
      }

      const synth = getSynth();
      const imported = await importFromPaths(
        synth,
        fresh,
        (p) => {
          if (alive) setScanning(p);
        },
        (name, message) => console.error(`[music] ${name}: ${message}`),
      );
      if (!alive) return;
      for (const t of imported) addTrack(t);
      setScanning(null);
    })();

    return () => {
      alive = false;
    };
    // Runs once per launch; keying on `tracks` would restart it on every add.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, addTrack, removeTrack]);

  /** Ink-wipe transition, used whenever we enter or leave gameplay. */
  const transition = useCallback((to: Screen) => {
    setWipe('cover');
    window.setTimeout(() => {
      setScreen(to);
      setWipe('reveal');
      window.setTimeout(() => setWipe(''), 560);
    }, 430);
  }, []);

  const onMenuSelect = useCallback(
    (t: MenuTarget) => {
      if (t === 'play') setScreen('song');
      else if (t === 'style') setScreen('style');
      else if (t === 'settings') setScreen('settings');
      else if (t === 'records') setScreen('records');
    },
    [],
  );

  const startRun = useCallback(() => {
    void getSynth().unlock();
    transition('game');
  }, [transition]);

  const handleFinish = useCallback(
    (r: RunResult) => {
      setResult(r);
      transition('result');
    },
    [transition],
  );

  // F11 / Cmd-Ctrl-F style fullscreen toggle through the Electron bridge.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F11') {
        e.preventDefault();
        void window.kizuna?.toggleFullscreen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      {screen === 'title' && (
        <TitleScreen
          onStart={() => {
            void getSynth().unlock();
            getSynth().uiSelect();
            setScreen('menu');
          }}
        />
      )}
      {screen === 'menu' && <MenuScreen onSelect={onMenuSelect} />}
      {screen === 'style' && <StyleScreen onBack={() => setScreen('menu')} />}
      {screen === 'song' && (
        <SongScreen onBack={() => setScreen('menu')} onPlay={startRun} />
      )}
      {screen === 'game' && (
        <GameScreen onExit={() => transition('song')} onFinish={handleFinish} />
      )}
      {screen === 'result' && result && (
        <ResultScreen
          result={result}
          onRetry={() => transition('game')}
          onSongSelect={() => transition('song')}
        />
      )}
      {screen === 'settings' && <SettingsScreen onBack={() => setScreen('menu')} />}
      {screen === 'records' && <RecordsScreen onBack={() => setScreen('menu')} />}

      {scanning && screen !== 'game' && (
        <div className="scan-toast">
          <span className="scan-spinner" aria-hidden="true" />
          <span className="stack gap-xs">
            <b>PREPARING TRACKS · {scanning.index}/{scanning.total}</b>
            <span className="scan-name">{scanning.title}</span>
            <span className="scan-bar">
              <i style={{ width: `${Math.round(scanning.value * 100)}%` }} />
            </span>
          </span>
        </div>
      )}

      <div className="grain" aria-hidden="true" />
      <div className="vignette" aria-hidden="true" />
      {wipe && <div className={`ink-wipe ${wipe}`} aria-hidden="true" />}
    </div>
  );
}
