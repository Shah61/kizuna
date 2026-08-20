import { useEffect, useMemo, useRef, useState } from 'react';
import { GRADES, JUDGEMENT_LABEL, type Judgement } from '../game/engine';
import { getDifficulty } from '../data/songs';
import { getStyle } from '../data/breathing';
import { getSynth } from '../audio/synth';
import { useEscape } from '../components/Controls';
import { Atmosphere } from '../components/Atmosphere';
import type { RunResult } from './GameScreen';
import { useStore } from '../store';
import { resolveSelection } from '../game/selection';

const JUDGE_ORDER: Judgement[] = ['kiwami', 'zan', 'kasuri', 'shitsu'];
const JUDGE_COLOR: Record<Judgement, string> = {
  kiwami: '#ffd76a',
  zan: '#6fe3c4',
  kasuri: '#6aa8ff',
  shitsu: '#ff5c6e',
};

/** Ease-out count-up, so the final score lands rather than snapping. */
function useCountUp(target: number, ms = 1100): number {
  const [v, setV] = useState(0);
  const raf = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const tick = () => {
      const p = Math.min(1, (performance.now() - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      setV(Math.round(target * eased));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, ms]);
  return v;
}

export function ResultScreen({
  result,
  onRetry,
  onSongSelect,
}: {
  result: RunResult;
  onRetry: () => void;
  onSongSelect: () => void;
}) {
  const { tracks } = useStore();
  const selection = useMemo(
    () => resolveSelection(result.songId, tracks),
    [result.songId, tracks],
  );
  const song = selection?.song;
  const diff = getDifficulty(result.difficultyId as never);
  const bs = getStyle(result.styleId as never);
  const grade = GRADES[result.grade];
  const score = useCountUp(result.score);

  useEscape(onSongSelect);

  useEffect(() => {
    const synth = getSynth();
    void synth.unlock().then(() => {
      if (result.failed) {
        synth.miss(synth.now);
        return;
      }
      // A short arpeggiated flourish scaled to how well it went.
      const base = 60 + result.grade * 2;
      [0, 4, 7, 12].forEach((s, i) => {
        synth.bell(synth.now + i * 0.11, base + s, 0.34, 2.6);
      });
      synth.taiko(synth.now, 1, 33);
    });
  }, [result.failed, result.grade]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        getSynth().uiSelect();
        onRetry();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onRetry]);

  /* timing histogram: 21 buckets across ±150ms */
  const histogram = useMemo(() => {
    const BUCKETS = 21;
    const bins = new Array(BUCKETS).fill(0);
    for (const d of result.deltas) {
      const clamped = Math.max(-0.15, Math.min(0.15, d));
      const idx = Math.min(
        BUCKETS - 1,
        Math.floor(((clamped + 0.15) / 0.3) * BUCKETS),
      );
      bins[idx]++;
    }
    const peak = Math.max(1, ...bins);
    return bins.map((b) => b / peak);
  }, [result.deltas]);

  const meanMs = useMemo(() => {
    if (!result.deltas.length) return 0;
    return (
      (result.deltas.reduce((a, b) => a + b, 0) / result.deltas.length) * 1000
    );
  }, [result.deltas]);

  const total = Math.max(1, result.noteCount);

  return (
    <div
      className="screen result-screen screen-enter"
      style={
        {
          '--accent': bs.accent,
          '--accent-glow': `${bs.accent}88`,
        } as React.CSSProperties
      }
    >
      <Atmosphere count={14} kind={result.failed ? 'ember' : 'petal'} tint={bs.accent} />

      <header className="screen-head">
        <div className="screen-title">
          <h1>{result.failed ? '任務失敗' : '任務完了'}</h1>
          <span className="romaji">
            {result.failed ? 'MISSION FAILED' : 'MISSION COMPLETE'}
          </span>
        </div>
        <div className="stack gap-xs" style={{ alignItems: 'flex-end' }}>
          <b className="latin" style={{ fontSize: 18 }}>{song?.kanji ?? 'MUSIC TRACK'}</b>
          <span className="eyebrow">
            {diff.kanji} {diff.romaji} · {bs.english} · LV {song?.levels[diff.id] ?? '—'}
          </span>
        </div>
      </header>

      <div className="result-inner">
        <div className="result-grade" style={{ color: grade.color }}>
          <div className="result-grade-ring" />
          <div className="result-grade-ring dashed" />
          <div className="result-grade-kanji">{grade.kanji}</div>
          <div className="result-grade-romaji">{grade.romaji}</div>
          <div className="result-flags">
            {result.perfect && <span className="flag pf">PERFECT</span>}
            {result.fullCombo && !result.perfect && <span className="flag fc">FULL COMBO</span>}
            {result.newRecord && <span className="flag new">NEW RECORD</span>}
            {result.failed && <span className="flag failed">FAILED</span>}
          </div>
        </div>

        <div className="result-main">
          <div className="result-score">
            <b className="gilt">{score.toLocaleString('en-US')}</b>
            <span className="eyebrow">SCORE</span>
          </div>

          <div className="result-breakdown">
            {JUDGE_ORDER.map((j) => (
              <div className="judge-cell" key={j}>
                <span className="k" style={{ color: JUDGE_COLOR[j] }}>
                  {JUDGEMENT_LABEL[j].kanji}
                </span>
                <span className="v num">{result.counts[j]}</span>
                <span className="r">{JUDGEMENT_LABEL[j].romaji}</span>
                <span className="bar">
                  <i
                    style={{
                      width: `${(result.counts[j] / total) * 100}%`,
                      background: JUDGE_COLOR[j],
                    }}
                  />
                </span>
              </div>
            ))}
          </div>

          <div className="result-figures">
            <div className="stat">
              <b className="num">{(result.accuracy * 100).toFixed(2)}%</b>
              <span>Accuracy</span>
            </div>
            <div className="stat">
              <b className="num">{result.maxCombo}</b>
              <span>Max Combo</span>
            </div>
            <div className="stat">
              <b className="num">{result.artsUsed}</b>
              <span>Breathing Arts</span>
            </div>
            <div className="stat">
              <b className="num">
                {meanMs > 0 ? '+' : ''}
                {meanMs.toFixed(1)}ms
              </b>
              <span>{meanMs > 4 ? 'Late' : meanMs < -4 ? 'Early' : 'Centred'}</span>
            </div>
          </div>

          <div>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 9 }}>
              <span className="eyebrow">TIMING DISTRIBUTION</span>
              {Math.abs(meanMs) > 12 && (
                <span className="eyebrow" style={{ color: bs.accent }}>
                  TRY OFFSET {meanMs > 0 ? '+' : ''}
                  {(meanMs / 1000).toFixed(3)}s IN SETTINGS
                </span>
              )}
            </div>
            <div className="histogram">
              <div className="axis" />
              {histogram.map((v, i) => (
                <i
                  key={i}
                  style={{ height: `${Math.max(2, v * 100)}%`, animationDelay: `${i * 18}ms` }}
                />
              ))}
            </div>
            <div className="histo-legend">
              <span>−150MS EARLY</span>
              <span>ON BEAT</span>
              <span>LATE +150MS</span>
            </div>
          </div>
        </div>
      </div>

      <footer className="screen-foot">
        <div className="hintbar">
          <span>
            <kbd>↵</kbd>RETRY
          </span>
          <span>
            <kbd>ESC</kbd>SONG SELECT
          </span>
        </div>
        <div className="row gap-sm">
          <button className="btn" onClick={onSongSelect}>
            Song Select
          </button>
          <button className="btn btn-primary" onClick={onRetry}>
            再挑戦 · Retry
          </button>
        </div>
      </footer>
    </div>
  );
}
