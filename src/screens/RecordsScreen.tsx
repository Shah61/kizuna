import { useMemo } from 'react';
import { useStore } from '../store';
import { DIFFICULTIES, getDifficulty } from '../data/songs';
import { getStyle, type BreathingId } from '../data/breathing';
import { GRADES } from '../game/engine';
import { useEscape } from '../components/Controls';
import { getSynth } from '../audio/synth';
import type { DifficultyId } from '../data/songs';
import { customToSongSpec } from '../data/library';

const fmt = (n: number) => n.toLocaleString('en-US');

export function RecordsScreen({ onBack }: { onBack: () => void }) {
  const { records, tracks } = useStore();

  useEscape(() => {
    getSynth().uiBack();
    onBack();
  });

  const rows = useMemo(() => {
    return Object.entries(records)
      .flatMap(([key, rec]) => {
        const [songId, diffId, styleId] = key.split('|');
        const track = tracks.find(
          (candidate) => candidate.id === songId && candidate.source === 'music-folder',
        );
        if (!track) return [];
        return [{
          key,
          song: customToSongSpec(track),
          diff: getDifficulty(diffId as DifficultyId),
          style: getStyle(styleId as BreathingId),
          rec,
        }];
      })
      .sort((a, b) => b.rec.playedAt - a.rec.playedAt);
  }, [records, tracks]);

  const totals = useMemo(() => {
    const cleared = new Set(rows.map((r) => `${r.song.id}|${r.diff.id}`)).size;
    const possible = tracks.filter((track) => track.source === 'music-folder').length * DIFFICULTIES.length;
    const fc = rows.filter((r) => r.rec.fullCombo).length;
    const best = rows.reduce((m, r) => Math.max(m, r.rec.grade), -1);
    return { cleared, possible, fc, best };
  }, [rows, tracks]);

  return (
    <div className="screen screen-enter">
      <header className="screen-head">
        <div className="screen-title">
          <h1>階級</h1>
          <span className="romaji">RECORDS</span>
        </div>
        <div className="row gap-lg">
          <div className="stat">
            <b className="num">
              {totals.cleared}/{totals.possible}
            </b>
            <span>Charts Cleared</span>
          </div>
          <div className="stat">
            <b className="num">{totals.fc}</b>
            <span>Full Combos</span>
          </div>
          <div className="stat">
            <b
              style={{
                fontFamily: 'var(--font-jp)',
                fontSize: 22,
                color: totals.best >= 0 ? GRADES[totals.best].color : 'var(--bone-faint)',
              }}
            >
              {totals.best >= 0 ? GRADES[totals.best].kanji : '—'}
            </b>
            <span>Highest Rank</span>
          </div>
        </div>
      </header>

      <div className="screen-body" style={{ overflowY: 'auto' }}>
        {rows.length === 0 ? (
          <div className="records-empty">
            <span className="big">白紙</span>
            <span className="eyebrow">NO MISSIONS LOGGED YET</span>
            <span style={{ fontSize: 12 }}>Clear a song and your rank will appear here.</span>
          </div>
        ) : (
          <table className="records-table">
            <thead>
              <tr>
                <th>Song</th>
                <th>Difficulty</th>
                <th>Breathing</th>
                <th style={{ textAlign: 'right' }}>Score</th>
                <th style={{ textAlign: 'right' }}>Accuracy</th>
                <th style={{ textAlign: 'right' }}>Max Combo</th>
                <th style={{ textAlign: 'center' }}>Rank</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>
                    <span className="latin">{r.song.kanji}</span>
                    <span className="eyebrow" style={{ marginLeft: 10 }}>
                      {r.song.english}
                    </span>
                  </td>
                  <td style={{ color: r.diff.color }}>
                    <span className="jp" style={{ color: r.diff.color, marginRight: 8 }}>
                      {r.diff.kanji}
                    </span>
                    <span className="eyebrow" style={{ color: r.diff.color }}>
                      LV {r.song.levels[r.diff.id]}
                    </span>
                  </td>
                  <td>
                    <span style={{ color: r.style.accent }}>{r.style.kanji}</span>
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {fmt(r.rec.score)}
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {(r.rec.accuracy * 100).toFixed(2)}%
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {r.rec.maxCombo}
                    {r.rec.fullCombo && (
                      <span style={{ color: 'var(--jade)', marginLeft: 8, fontSize: 9 }}>FC</span>
                    )}
                  </td>
                  <td className="g" style={{ textAlign: 'center', color: GRADES[r.rec.grade].color }}>
                    {GRADES[r.rec.grade].kanji}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <footer className="screen-foot">
        <div className="hintbar">
          <span>
            <kbd>ESC</kbd>BACK
          </span>
          <span>RECORDS ARE STORED LOCALLY ON THIS MACHINE</span>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          Back
        </button>
      </footer>
    </div>
  );
}
