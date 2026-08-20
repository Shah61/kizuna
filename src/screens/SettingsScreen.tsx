import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore, DEFAULT_SETTINGS } from '../store';
import { getSynth } from '../audio/synth';
import { Slider, Toggle, Segmented, KeyBinder, useEscape, displayKey } from '../components/Controls';
import {
  DEFAULT_KEYS_BY_LANE_COUNT,
  LANE_COUNTS,
  defaultKeysFor,
  type LaneCount,
} from '../game/lanes';

const BEAT = 0.55; // seconds between calibration clicks

/** Common layouts for each field size, so adding lanes stays one click. */
const KEY_PRESETS: Record<LaneCount, Array<{ label: string; keys: string[] }>> = {
  4: [
    { label: 'DFJK', keys: DEFAULT_KEYS_BY_LANE_COUNT[4] },
    { label: 'SDKL', keys: ['s', 'd', 'k', 'l'] },
    { label: 'ASKL', keys: ['a', 's', 'k', 'l'] },
    { label: 'ZXCV', keys: ['z', 'x', 'c', 'v'] },
    { label: '←↓↑→', keys: ['ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowRight'] },
  ],
  6: [
    { label: 'SDFJKL', keys: DEFAULT_KEYS_BY_LANE_COUNT[6] },
    { label: 'ASDJKL', keys: ['a', 's', 'd', 'j', 'k', 'l'] },
    { label: 'ZXCNM,', keys: ['z', 'x', 'c', 'n', 'm', ','] },
  ],
  8: [
    { label: 'ASDFGHJK', keys: DEFAULT_KEYS_BY_LANE_COUNT[8] },
    { label: 'ASDFJKL;', keys: ['a', 's', 'd', 'f', 'j', 'k', 'l', ';'] },
  ],
};

/** Reusing a bound key swaps the two lanes instead of leaving one unplayable. */
function rebindLane(keys: string[], lane: number, nextKey: string): string[] {
  const next = [...keys];
  const duplicate = next.findIndex((key, index) => index !== lane && key === nextKey);
  if (duplicate >= 0) next[duplicate] = next[lane];
  next[lane] = nextKey;
  return next;
}

export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const { settings, setSettings, resetSettings, tracks } = useStore();
  const [calibrating, setCalibrating] = useState(false);
  const [taps, setTaps] = useState<number[]>([]);
  const [phase, setPhase] = useState(0);
  const [musicDir, setMusicDir] = useState<string>('');

  useEffect(() => {
    if (!window.kizuna?.musicFolder) return;
    void window.kizuna.musicFolder().then(setMusicDir);
  }, []);

  useEscape(() => {
    getSynth().uiBack();
    onBack();
  });

  useEffect(() => {
    getSynth().setLevels({
      master: settings.masterVolume,
      music: settings.musicVolume,
      sfx: settings.sfxVolume,
    });
  }, [settings.masterVolume, settings.musicVolume, settings.sfxVolume]);

  /* ---------------------------------------------------------------- *
   * calibration: a metronome you tap along with. The mean error is the
   * offset, which is exactly what the judge needs to subtract.
   * ---------------------------------------------------------------- */
  const startRef = useRef(0);
  const rafRef = useRef(0);
  const scheduledRef = useRef(0);

  const stopCalibration = useCallback(() => {
    setCalibrating(false);
    cancelAnimationFrame(rafRef.current);
  }, []);

  useEffect(() => {
    if (!calibrating) return;
    const synth = getSynth();
    let alive = true;

    void synth.unlock().then(() => {
      if (!alive) return;
      startRef.current = synth.now + 0.4;
      scheduledRef.current = 0;

      const tick = () => {
        rafRef.current = requestAnimationFrame(tick);
        const now = synth.now;
        // schedule clicks a little ahead, same lookahead idea as the conductor
        while (startRef.current + scheduledRef.current * BEAT < now + 0.3) {
          const at = startRef.current + scheduledRef.current * BEAT;
          if (at > now) {
            synth.taiko(at, scheduledRef.current % 4 === 0 ? 1 : 0.6, 36);
            if (scheduledRef.current % 4 === 0) synth.rim(at, 0.3);
          }
          scheduledRef.current++;
        }
        const elapsed = now - startRef.current;
        setPhase(((elapsed % BEAT) + BEAT) % BEAT / BEAT);
      };
      rafRef.current = requestAnimationFrame(tick);
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== ' ' || e.repeat) return;
      e.preventDefault();
      const elapsed = getSynth().now - startRef.current;
      const nearest = Math.round(elapsed / BEAT) * BEAT;
      const delta = elapsed - nearest;
      if (Math.abs(delta) < BEAT * 0.45) setTaps((prev) => [...prev.slice(-15), delta]);
    };
    window.addEventListener('keydown', onKey);

    return () => {
      alive = false;
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('keydown', onKey);
    };
  }, [calibrating]);

  const meanTap = taps.length ? taps.reduce((a, b) => a + b, 0) / taps.length : 0;
  const keyPresets = KEY_PRESETS[settings.laneCount];

  return (
    <div className="screen screen-enter">
      <header className="screen-head">
        <div className="screen-title">
          <h1>調整</h1>
          <span className="romaji">SETTINGS</span>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            resetSettings();
            getSynth().uiBack();
          }}
        >
          Restore Defaults
        </button>
      </header>

      <div className="screen-body">
        <div className="settings-grid">
          <div className="settings-col">
          {/* --- input ------------------------------------------- */}
          <section className="settings-card">
            <h3>
              操作 <em>INPUT</em>
            </h3>
            <Segmented<LaneCount>
              label="Play field"
              value={settings.laneCount}
              onChange={(laneCount) => {
                setSettings({ laneCount, keys: defaultKeysFor(laneCount) });
                getSynth().uiSelect();
              }}
              options={LANE_COUNTS.map((laneCount) => ({
                value: laneCount,
                label: `${laneCount} LANES`,
              }))}
            />
            <div className="ctrl">
              <span className="ctrl-label">
                Presets
                <em className="ctrl-hint">Pick a layout, or bind every lane below.</em>
              </span>
              <div className="preset-row">
                {keyPresets.map((preset) => {
                  const active =
                    preset.keys.length === settings.keys.length &&
                    preset.keys.every((k, i) => k === settings.keys[i]);
                  return (
                    <button
                      key={preset.label}
                      type="button"
                      className={`preset${active ? ' active' : ''}`}
                      onClick={() => {
                        setSettings({ keys: [...preset.keys] });
                        getSynth().uiSelect();
                      }}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="ctrl">
              <span className="ctrl-label">
                Lane keys
                <em className="ctrl-hint">Left to right. Click a key, then press one.</em>
              </span>
              <div className="keys-row">
                {settings.keys.map((k, i) => (
                  <KeyBinder
                    key={i}
                    label={`LANE ${i + 1}`}
                    value={k}
                    onChange={(nk) => {
                      setSettings({ keys: rebindLane(settings.keys, i, nk) });
                      getSynth().uiSelect();
                    }}
                  />
                ))}
              </div>
            </div>
            <KeyBinder
              label="BREATHING ART"
              value={settings.artKey}
              onChange={(k) => {
                setSettings({ artKey: k });
                getSynth().uiSelect();
              }}
            />
          </section>

          </div>

          <div className="settings-col">
          {/* --- gameplay ---------------------------------------- */}
          <section className="settings-card">
            <h3>
              視認性 <em>GAMEPLAY</em>
            </h3>
            <Slider
              label="Scroll speed"
              value={settings.scrollSpeed}
              min={0.5}
              max={3}
              step={0.05}
              format={(v) => `${v.toFixed(2)}×`}
              onChange={(v) => setSettings({ scrollSpeed: v })}
            />
            <Toggle
              label="Bar lines"
              hint="Faint horizontal guides on every bar."
              value={settings.showLaneGuides}
              onChange={(v) => setSettings({ showLaneGuides: v })}
            />
            <Toggle
              label="Timing bar"
              hint="Shows how early or late each hit landed."
              value={settings.showTimingBar}
              onChange={(v) => setSettings({ showTimingBar: v })}
            />
            <Toggle
              label="No-fail mode"
              hint="Resolve can empty without ending the run."
              value={settings.noFail}
              onChange={(v) => setSettings({ noFail: v })}
            />
            <Toggle
              label="Reduced effects"
              hint="Fewer particles. Use if frames drop."
              value={settings.reducedEffects}
              onChange={(v) => setSettings({ reducedEffects: v })}
            />
          </section>

          </div>

          <div className="settings-col">
          {/* --- audio ------------------------------------------- */}
          <section className="settings-card">
            <h3>
              音量 <em>AUDIO</em>
            </h3>
            <Slider
              label="Master"
              value={settings.masterVolume}
              min={0}
              max={1}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => setSettings({ masterVolume: v })}
            />
            <Slider
              label="Music"
              value={settings.musicVolume}
              min={0}
              max={1}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => setSettings({ musicVolume: v })}
            />
            <Slider
              label="Effects"
              value={settings.sfxVolume}
              min={0}
              max={1}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => {
                setSettings({ sfxVolume: v });
                getSynth().slash(getSynth().now, 2);
              }}
            />
          </section>

          </div>

          <div className="settings-col">
          {/* --- music library ----------------------------------- */}
          <section className="settings-card">
            <h3>
              曲庫 <em>MUSIC</em>
            </h3>
            <p style={{ fontSize: 11, lineHeight: 1.7, color: 'var(--bone-dim)' }}>
              The playable library comes only from MP3 files in content/music.
              Add or remove files there, then restart the game to refresh it.
            </p>
            {musicDir && (
              <code className="path-box" title={musicDir}>
                {musicDir}
              </code>
            )}
            <div className="row gap-sm">
              <button
                className="btn btn-sm"
                disabled={!window.kizuna?.revealMusicFolder}
                onClick={() => {
                  void window.kizuna?.revealMusicFolder();
                  getSynth().uiSelect();
                }}
              >
                Open Music Folder
              </button>
              <span className="eyebrow" style={{ marginLeft: 'auto' }}>
                {tracks.filter((track) => track.source === 'music-folder').length} MP3 TRACKS
              </span>
            </div>
          </section>

          {/* --- calibration ------------------------------------- */}
          <section className="settings-card">
            <h3>
              呼吸合わせ <em>CALIBRATION</em>
            </h3>
            <p style={{ fontSize: 11, lineHeight: 1.7, color: 'var(--bone-dim)' }}>
              Every machine adds a little audio latency. Start the metronome, tap{' '}
              <kbd
                style={{
                  padding: '2px 6px',
                  border: '1px solid var(--hair)',
                  borderRadius: 3,
                  fontFamily: 'var(--font-num)',
                  fontSize: 10,
                }}
              >
                SPACE
              </kbd>{' '}
              on the beat about sixteen times, then apply the measured offset.
            </p>

            <div className="calibrate-strip">
              <div className="target" />
              {calibrating && (
                <div className="beat" style={{ left: `${phase * 100}%` }} />
              )}
            </div>

            <Slider
              label="Audio offset"
              value={settings.audioOffset}
              min={-0.2}
              max={0.2}
              step={0.001}
              format={(v) => `${v > 0 ? '+' : ''}${(v * 1000).toFixed(0)}ms`}
              onChange={(v) => setSettings({ audioOffset: v })}
            />

            <div className="row gap-sm">
              <button
                className={`btn btn-sm${calibrating ? '' : ' btn-primary'}`}
                onClick={() => {
                  if (calibrating) stopCalibration();
                  else {
                    setTaps([]);
                    setCalibrating(true);
                  }
                }}
              >
                {calibrating ? 'Stop' : 'Start Metronome'}
              </button>
              <button
                className="btn btn-sm"
                disabled={taps.length < 4}
                onClick={() => {
                  setSettings({ audioOffset: parseFloat(meanTap.toFixed(3)) });
                  stopCalibration();
                  getSynth().uiSelect();
                }}
              >
                Apply {taps.length >= 4 ? `${(meanTap * 1000).toFixed(0)}ms` : '—'}
              </button>
              <span className="eyebrow" style={{ marginLeft: 'auto' }}>
                {taps.length} TAPS
              </span>
            </div>
          </section>
          </div>
        </div>
      </div>

      <footer className="screen-foot">
        <div className="hintbar">
          <span>
            <kbd>ESC</kbd>BACK
          </span>
          <span>
            {settings.laneCount} LANES: {settings.keys.map(displayKey).join(' · ')}
          </span>
          <span>
            {settings.scrollSpeed === DEFAULT_SETTINGS.scrollSpeed
              ? 'DEFAULT SPEED'
              : 'CUSTOM SPEED'}
          </span>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          Back
        </button>
      </footer>
    </div>
  );
}
