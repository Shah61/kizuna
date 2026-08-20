import { useEffect, useMemo, useState } from 'react';
import { DIFFICULTIES, getDifficulty, type DifficultyId } from '../data/songs';
import { allPlayables, chartFor, type Selection } from '../game/selection';
import { GRADES } from '../game/engine';
import { getStyle } from '../data/breathing';
import { useStore, bestFor } from '../store';
import { getSynth } from '../audio/synth';
import { Segmented, useEscape } from '../components/Controls';

const fmt = (n: number) => n.toLocaleString('en-US');
const mmss = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function SongScreen({
  onBack,
  onPlay,
}: {
  onBack: () => void;
  onPlay: () => void;
}) {
  const {
    songId,
    setSongId,
    difficulty,
    setDifficulty,
    records,
    style,
    settings,
    tracks,
  } = useStore();

  const diff = getDifficulty(difficulty);
  const bs = getStyle(style);
  const playables = useMemo(() => allPlayables(tracks), [tracks]);
  const [index, setIndex] = useState(() =>
    Math.max(0, playables.findIndex((entry) => entry.song.id === songId)),
  );
  const clamped = playables.length ? Math.min(index, playables.length - 1) : 0;
  const current: Selection | null = playables[clamped] ?? null;
  const chart = useMemo(
    () => (current ? chartFor(current, diff, settings.laneCount) : null),
    [current, diff, settings.laneCount],
  );
  const best = current ? bestFor(records, current.song.id, difficulty) : null;
  const unplayable = !current || current.track.missing === true;

  useEscape(() => {
    getSynth().uiBack();
    onBack();
  });

  useEffect(() => {
    if (current) setSongId(current.song.id);
  }, [current, setSongId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown' && playables.length) {
        event.preventDefault();
        setIndex((value) => (value + 1) % playables.length);
        getSynth().uiHover();
      } else if (event.key === 'ArrowUp' && playables.length) {
        event.preventDefault();
        setIndex((value) => (value - 1 + playables.length) % playables.length);
        getSynth().uiHover();
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const difficultyIndex = DIFFICULTIES.findIndex((entry) => entry.id === difficulty);
        const next =
          event.key === 'ArrowRight'
            ? (difficultyIndex + 1) % DIFFICULTIES.length
            : (difficultyIndex - 1 + DIFFICULTIES.length) % DIFFICULTIES.length;
        setDifficulty(DIFFICULTIES[next].id);
        getSynth().uiHover();
      } else if (event.key === 'Enter' && current && !unplayable) {
        event.preventDefault();
        getSynth().uiSelect();
        onPlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, difficulty, onPlay, playables.length, setDifficulty, unplayable]);

  const spark = useMemo(() => {
    if (!chart) return [];
    const bars = 64;
    const source = chart.densityCurve;
    const output: number[] = [];
    for (let i = 0; i < bars; i++) {
      const from = Math.floor((i / bars) * source.length);
      const to = Math.max(from + 1, Math.floor(((i + 1) / bars) * source.length));
      let sum = 0;
      for (let j = from; j < to && j < source.length; j++) sum += source[j];
      output.push(sum / Math.max(1, to - from));
    }
    const peak = Math.max(1, ...output);
    return output.map((value) => value / peak);
  }, [chart]);

  const openMusicFolder = () => {
    void window.kizuna?.revealMusicFolder();
    getSynth().uiSelect();
  };

  if (!current || !chart) {
    return (
      <div className="screen screen-enter">
        <header className="screen-head">
          <div className="screen-title">
            <h1>任務選択</h1>
            <span className="romaji">SELECT MUSIC</span>
          </div>
          <button
            className="btn btn-sm"
            disabled={!window.kizuna?.revealMusicFolder}
            onClick={openMusicFolder}
          >
            Open Music Folder
          </button>
        </header>
        <div className="screen-body">
          <div className="records-empty">
            <span className="big">無音</span>
            <span className="eyebrow">NO MP3 FILES FOUND</span>
            <span style={{ fontSize: 12, textAlign: 'center', lineHeight: 1.7 }}>
              Add MP3 files to content/music and restart the game.
              <br />Tracks appear here after their first analysis finishes.
            </span>
            <button
              className="btn btn-primary"
              disabled={!window.kizuna?.revealMusicFolder}
              onClick={openMusicFolder}
            >
              Open Music Folder
            </button>
          </div>
        </div>
        <footer className="screen-foot">
          <div className="hintbar"><span><kbd>ESC</kbd>BACK</span></div>
          <button className="btn btn-ghost btn-sm" onClick={onBack}>Back</button>
        </footer>
      </div>
    );
  }

  const song = current.song;

  return (
    <div className="screen screen-enter" style={{ ['--song-hue' as string]: song.hue }}>
      <header className="screen-head">
        <div className="screen-title">
          <h1>任務選択</h1>
          <span className="romaji">SELECT MUSIC</span>
        </div>
        <div className="row gap-md">
          <button
            className="btn btn-sm"
            disabled={!window.kizuna?.revealMusicFolder}
            onClick={openMusicFolder}
          >
            Open Music Folder
          </button>
          <div className="row gap-sm">
            <span className="eyebrow">BREATHING</span>
            <span
              style={{
                fontFamily: 'var(--font-jp)',
                fontSize: 15,
                color: bs.accent,
                letterSpacing: '0.12em',
              }}
            >
              {bs.kanji}
            </span>
          </div>
        </div>
      </header>

      <div className="screen-body">
        <div className="song-layout">
          <div className="song-list">
            {playables.map((entry, itemIndex) => {
              const missing = entry.track.missing === true;
              return (
                <button
                  key={entry.song.id}
                  className={`song-row${itemIndex === clamped ? ' active' : ''}${missing ? ' locked' : ''}`}
                  style={{ ['--song-hue' as string]: entry.song.hue }}
                  onMouseEnter={() => {
                    if (itemIndex !== clamped) {
                      setIndex(itemIndex);
                      getSynth().uiHover();
                    }
                  }}
                  onClick={() => {
                    if (!missing) {
                      setIndex(itemIndex);
                      setSongId(entry.song.id);
                      getSynth().uiSelect();
                      onPlay();
                    }
                  }}
                >
                  <span className="song-row-index num">♪</span>
                  <span className="song-row-body">
                    <b className="latin">{entry.song.kanji}</b>
                    <span>CONTENT/MUSIC MP3</span>
                  </span>
                  {missing && <span className="song-row-lock">⚠</span>}
                </button>
              );
            })}
          </div>

          <div className="song-detail">
            <div className="song-detail-pattern pattern-seigaiha" />
            <div className="song-detail-head">
              <div>
                <h2 className="latin">{song.kanji}</h2>
                <div className="en">MUSIC FOLDER MP3</div>
              </div>
              <div className="stack gap-xs" style={{ alignItems: 'flex-end' }}>
                <span className="eyebrow">LEVEL</span>
                <span className="num" style={{ fontSize: 40, lineHeight: 1, color: diff.color }}>
                  {String(song.levels[difficulty]).padStart(2, '0')}
                </span>
              </div>
            </div>

            <p className="song-lore">{song.lore}</p>

            <Segmented<DifficultyId>
              value={difficulty}
              onChange={(nextDifficulty) => {
                setDifficulty(nextDifficulty);
                getSynth().uiHover();
              }}
              options={DIFFICULTIES.map((entry) => ({
                value: entry.id,
                color: entry.color,
                label: (
                  <span className="row gap-xs" style={{ justifyContent: 'center' }}>
                    <span style={{ fontFamily: 'var(--font-jp)', fontSize: 14 }}>{entry.kanji}</span>
                    <span>{entry.romaji}</span>
                  </span>
                ),
              }))}
            />

            <div className="density" aria-hidden="true">
              {spark.map((value, sparkIndex) => (
                <i
                  key={sparkIndex}
                  style={{ height: `${Math.max(4, value * 100)}%`, animationDelay: `${sparkIndex * 4}ms` }}
                />
              ))}
            </div>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="eyebrow">CHART DENSITY</span>
              <span className="eyebrow">PEAK {chart.peakDensity}/s</span>
            </div>

            <div className="song-stats">
              <div className="stat"><b className="num">{song.bpm}</b><span>BPM (detected)</span></div>
              <div className="stat"><b className="num">{mmss(chart.duration)}</b><span>Length</span></div>
              <div className="stat"><b className="num">{fmt(chart.noteCount)}</b><span>Notes</span></div>
              <div className="stat"><b className="num">{chart.laneCount}</b><span>Lanes</span></div>
              <div className="stat"><b style={{ fontFamily: 'var(--font-jp)', fontSize: 20 }}>MP3</b><span>Source</span></div>
            </div>

            <div className="song-detail-foot">
              {current.track.missing ? (
                <div className="locked-note"><span>⚠</span><span>MP3 missing from content/music</span></div>
              ) : best ? (
                <div className="best-card">
                  <span className="grade" style={{ color: GRADES[best.grade].color }}>
                    {GRADES[best.grade].kanji}
                  </span>
                  <span className="figures">
                    <b>{fmt(best.score)}</b>
                    <span>
                      {(best.accuracy * 100).toFixed(2)}% · {best.maxCombo} MAX
                      {best.fullCombo ? ' · FULL COMBO' : ''}
                    </span>
                  </span>
                </div>
              ) : (
                <div className="locked-note" style={{ borderStyle: 'solid' }}>
                  <span style={{ fontFamily: 'var(--font-jp)' }}>未</span>
                  <span>NO RECORD YET</span>
                </div>
              )}

              <button
                className="btn btn-primary"
                disabled={unplayable}
                onClick={() => {
                  getSynth().uiSelect();
                  onPlay();
                }}
              >
                出陣 · DEPLOY
              </button>
            </div>
          </div>
        </div>
      </div>

      <footer className="screen-foot">
        <div className="hintbar">
          <span><kbd>↑↓</kbd>SONG</span>
          <span><kbd>←→</kbd>DIFFICULTY</span>
          <span><kbd>↵</kbd>PLAY</span>
          <span><kbd>ESC</kbd>BACK</span>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>Back</button>
      </footer>
    </div>
  );
}
