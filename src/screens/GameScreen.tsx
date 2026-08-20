import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDifficulty } from '../data/songs';
import { getStyle } from '../data/breathing';
import { resolveSelection, chartFor, type Selection } from '../game/selection';
import { loadTrackAudio } from '../audio/import';
import {
  GameEngine,
  gradeFor,
  clearFlags,
  JUDGEMENT_LABEL,
  type EngineSnapshot,
  type HitEvent,
  type Judgement,
} from '../game/engine';
import { Renderer } from '../game/renderer';
import { getSynth } from '../audio/synth';
import { Conductor } from '../audio/conductor';
import { useStore, recordKey, type ScoreRecord } from '../store';
import { displayKey } from '../components/Controls';

export interface RunResult {
  songId: string;
  difficultyId: string;
  styleId: string;
  score: number;
  accuracy: number;
  maxCombo: number;
  counts: Record<Judgement, number>;
  grade: number;
  fullCombo: boolean;
  perfect: boolean;
  failed: boolean;
  deltas: number[];
  artsUsed: number;
  newRecord: boolean;
  noteCount: number;
}

interface Tick {
  id: number;
  delta: number;
  color: string;
}

const JUDGE_COLOR: Record<Judgement, string> = {
  kiwami: '#ffd76a',
  zan: '#6fe3c4',
  kasuri: '#6aa8ff',
  shitsu: '#ff5c6e',
};

const EMPTY: EngineSnapshot = {
  score: 0,
  combo: 0,
  maxCombo: 0,
  multiplier: 1,
  accuracy: 1,
  counts: { kiwami: 0, zan: 0, kasuri: 0, shitsu: 0 },
  gauge: 0,
  gaugeReady: false,
  artActive: false,
  artRemaining: 0,
  guards: 0,
  resolve: 100,
  failed: false,
  judged: 0,
  total: 0,
};

export function GameScreen({
  onExit,
  onFinish,
}: {
  onExit: () => void;
  onFinish: (r: RunResult) => void;
}) {
  const { songId, tracks } = useStore();
  const selection = useMemo(() => resolveSelection(songId, tracks), [songId, tracks]);
  if (!selection) {
    return (
      <div className="screen game-screen">
        <div className="overlay">
          <h2 className="gilt">音源なし</h2>
          <span className="romaji">NO MUSIC FOUND</span>
          <p>Add an MP3 to content/music, then restart the game.</p>
          <button className="btn btn-primary" onClick={onExit}>Back to Song Select</button>
        </div>
      </div>
    );
  }
  return <GameSession selection={selection} onExit={onExit} onFinish={onFinish} />;
}

function GameSession({
  selection,
  onExit,
  onFinish,
}: {
  selection: Selection;
  onExit: () => void;
  onFinish: (r: RunResult) => void;
}) {
  const { difficulty, style, settings, submitRecord } = useStore();
  const song = selection.song;
  const diff = useMemo(() => getDifficulty(difficulty), [difficulty]);
  const bs = useMemo(() => getStyle(style), [style]);
  const chart = useMemo(
    () => chartFor(selection, diff, settings.laneCount),
    [selection, diff, settings.laneCount],
  );

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const conductorRef = useRef<Conductor | null>(null);
  const rafRef = useRef<number>(0);
  const activeFromRef = useRef(0);
  const finishedRef = useRef(false);
  const heldRef = useRef<Set<number>>(new Set());
  const tickIdRef = useRef(0);
  const frameRef = useRef(0);

  const [hud, setHud] = useState<EngineSnapshot>(EMPTY);
  const [sectionName, setSectionName] = useState('');
  const [progress, setProgress] = useState(0);
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [artBanner, setArtBanner] = useState(0);
  const [paused, setPaused] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [comboBump, setComboBump] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  /* ------------------------------------------------------------- *
   * finish
   * ------------------------------------------------------------- */
  const finish = useCallback(
    (failed: boolean) => {
      const engine = engineRef.current;
      if (!engine || finishedRef.current) return;
      finishedRef.current = true;

      conductorRef.current?.stop();
      cancelAnimationFrame(rafRef.current);

      const acc = engine.accuracy;
      const grade = gradeFor(acc);
      const flags = clearFlags(engine);
      const score = Math.round(engine.score * bs.modifiers.scoreMul);

      const rec: ScoreRecord = {
        score,
        accuracy: acc,
        maxCombo: engine.maxCombo,
        grade: grade.index,
        fullCombo: flags.fullCombo,
        playedAt: Date.now(),
      };
      const newRecord = failed
        ? false
        : submitRecord(recordKey(song.id, diff.id, bs.id), rec);

      onFinish({
        songId: song.id,
        difficultyId: diff.id,
        styleId: bs.id,
        score,
        accuracy: acc,
        maxCombo: engine.maxCombo,
        counts: { ...engine.counts },
        grade: grade.index,
        fullCombo: flags.fullCombo,
        perfect: flags.perfect,
        failed,
        deltas: engine.deltas.slice(),
        artsUsed: engine.artsUsed,
        newRecord,
        noteCount: chart.noteCount,
      });
    },
    [bs, song.id, diff.id, chart.noteCount, submitRecord, onFinish],
  );

  const finishRef = useRef(finish);
  finishRef.current = finish;

  /* ------------------------------------------------------------- *
   * hit feedback shared by input and the miss sweep
   * ------------------------------------------------------------- */
  const applyEvent = useCallback((ev: HitEvent) => {
    const renderer = rendererRef.current;
    const synth = getSynth();
    renderer?.onHit(ev);

    if (ev.judgement === 'shitsu') {
      synth.miss(synth.now);
      return;
    }

    const tier = ev.judgement === 'kiwami' ? 2 : ev.judgement === 'zan' ? 1 : 0;
    synth.slash(synth.now, tier);

    const id = tickIdRef.current++;
    setTicks((prev) => [
      ...prev.slice(-11),
      { id, delta: ev.delta, color: JUDGE_COLOR[ev.judgement] },
    ]);
    window.setTimeout(() => {
      setTicks((prev) => prev.filter((t) => t.id !== id));
    }, 1100);
  }, []);

  /* ------------------------------------------------------------- *
   * boot
   * ------------------------------------------------------------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const synth = getSynth();
    synth.setLevels({
      master: settingsRef.current.masterVolume,
      music: settingsRef.current.musicVolume,
      sfx: settingsRef.current.sfxVolume,
    });

    const engine = new GameEngine(chart, bs, { noFail: settingsRef.current.noFail });
    const renderer = new Renderer(canvas, chart, song, bs, {
      scrollSpeed: settingsRef.current.scrollSpeed,
      showLaneGuides: settingsRef.current.showLaneGuides,
      reducedEffects: settingsRef.current.reducedEffects,
      laneLabels: settingsRef.current.keys.map(displayKey),
    });
    const conductor = new Conductor(synth);
    conductor.audioOffset = settingsRef.current.audioOffset;

    engineRef.current = engine;
    rendererRef.current = renderer;
    conductorRef.current = conductor;
    finishedRef.current = false;
    activeFromRef.current = 0;

    /*
     * Imported tracks need their file decoded before the clock starts. The
     * bytes are cached after the first play, so this is usually instant.
     */
    let cancelled = false;
    void (async () => {
      await synth.unlock();
      let audio: AudioBuffer | null = null;
      try {
        audio = await loadTrackAudio(synth, selection.track);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        return;
      }
      if (cancelled) return;
      conductor.start(chart, 0.9, audio);
    })();

    const onResize = () => renderer.resize();
    window.addEventListener('resize', onResize);

    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      const t = conductor.songTime;
      const jt = conductor.judgeTime;

      for (const ev of engine.update(jt)) applyEvent(ev);

      // advance the render cursor past everything fully resolved
      const states = engine.states;
      let from = activeFromRef.current;
      while (
        from < states.length &&
        (states[from].holdDone ||
          (states[from].judged !== null && states[from].note.kind === 'tap')) &&
        states[from].note.time < t - 0.4
      ) {
        from++;
      }
      activeFromRef.current = from;

      const section =
        chart.sections.find((s) => t >= s.startTime && t < s.endTime) ??
        chart.sections[chart.sections.length - 1];

      renderer.draw(
        {
          time: t,
          combo: engine.combo,
          artActive: engine.artActive,
          intensity: section?.intensity ?? 0.4,
          paused: false,
        },
        states,
        from,
      );

      // HUD at ~30Hz — the numbers do not need 60 React renders a second
      frameRef.current++;
      if (frameRef.current % 2 === 0) {
        setHud(engine.snapshot(jt));
        setProgress(conductor.progress);
        setSectionName(section?.name ?? '');
      }

      if (engine.failed) {
        finishRef.current(true);
        return;
      }
      if (
        conductor.state === 'finished' ||
        (engine.judgedCount >= states.length && t > chart.duration - 2)
      ) {
        finishRef.current(false);
        return;
      }
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', onResize);
      conductor.stop();
      synth.duckMusic(settingsRef.current.musicVolume, 0.2);
    };
  }, [chart, song, bs, applyEvent, selection.track]);

  /* ------------------------------------------------------------- *
   * combo bump
   * ------------------------------------------------------------- */
  const lastComboRef = useRef(0);
  useEffect(() => {
    if (hud.combo > lastComboRef.current && hud.combo > 0) {
      setComboBump(true);
      const id = window.setTimeout(() => setComboBump(false), 90);
      lastComboRef.current = hud.combo;
      return () => window.clearTimeout(id);
    }
    lastComboRef.current = hud.combo;
  }, [hud.combo]);

  /* gauge-full chime, once per fill */
  const readyRef = useRef(false);
  useEffect(() => {
    if (hud.gaugeReady && !readyRef.current) {
      readyRef.current = true;
      getSynth().gaugeReady();
    } else if (!hud.gaugeReady) {
      readyRef.current = false;
    }
  }, [hud.gaugeReady]);

  /* ------------------------------------------------------------- *
   * pause / resume
   * ------------------------------------------------------------- */
  const doPause = useCallback(() => {
    if (finishedRef.current || paused || countdown > 0) return;
    conductorRef.current?.pause();
    setPaused(true);
  }, [paused, countdown]);

  const doResume = useCallback(() => {
    if (!paused) return;
    setPaused(false);
    setCountdown(3);
  }, [paused]);

  useEffect(() => {
    if (countdown <= 0) return;
    const id = window.setTimeout(() => {
      if (countdown === 1) {
        setCountdown(0);
        void conductorRef.current?.resume();
      } else {
        setCountdown((c) => c - 1);
      }
    }, 700);
    return () => window.clearTimeout(id);
  }, [countdown]);

  /*
   * If the window is hidden or loses focus, rAF stops but the audio clock does
   * not — the player would come back to a wall of misses. Pause instead.
   */
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') doPause();
    };
    window.addEventListener('visibilitychange', onHide);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('blur', doPause);
    return () => {
      window.removeEventListener('visibilitychange', onHide);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('blur', doPause);
    };
  }, [doPause]);

  const quit = useCallback(() => {
    conductorRef.current?.stop();
    finishedRef.current = true;
    cancelAnimationFrame(rafRef.current);
    getSynth().uiBack();
    onExit();
  }, [onExit]);

  /* ------------------------------------------------------------- *
   * input
   * ------------------------------------------------------------- */
  useEffect(() => {
    const laneFor = (key: string) =>
      settingsRef.current.keys.findIndex((k) => k.toLowerCase() === key);

    const onDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const key = e.key.toLowerCase();

      if (e.key === 'Escape') {
        e.preventDefault();
        if (paused) doResume();
        else doPause();
        return;
      }
      if (paused || countdown > 0 || finishedRef.current) return;

      const engine = engineRef.current;
      const conductor = conductorRef.current;
      const renderer = rendererRef.current;
      if (!engine || !conductor || !renderer) return;

      if (key === settingsRef.current.artKey.toLowerCase()) {
        e.preventDefault();
        if (engine.activateArt(conductor.judgeTime)) {
          renderer.onArt();
          getSynth().artActivate(getSynth().now);
          setArtBanner((n) => n + 1);
        }
        return;
      }

      const lane = laneFor(key);
      if (lane < 0) return;
      e.preventDefault();
      heldRef.current.add(lane);
      renderer.setHeld(lane, true);

      const ev = engine.press(lane, conductor.judgeTime);
      if (ev) applyEvent(ev);
      else getSynth().slash(getSynth().now, 0); // whiff still gives a swing
    };

    const onUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const lane = laneFor(key);
      if (lane < 0) return;
      heldRef.current.delete(lane);
      rendererRef.current?.setHeld(lane, false);
      if (paused || countdown > 0 || finishedRef.current) return;
      const engine = engineRef.current;
      const conductor = conductorRef.current;
      if (!engine || !conductor) return;
      const ev = engine.release(lane, conductor.judgeTime);
      if (ev) applyEvent(ev);
    };

    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, [paused, countdown, doPause, doResume, applyEvent]);

  /* ------------------------------------------------------------- */

  const accPct = (hud.accuracy * 100).toFixed(2);
  const sectionMarks = useMemo(
    () => chart.sections.map((s) => (s.startTime / chart.duration) * 100),
    [chart],
  );

  return (
    <div
      className="screen game-screen"
      style={
        {
          '--accent': bs.accent,
          '--accent2': bs.accent2,
          '--accent-glow': `${bs.accent}88`,
          '--accent-soft': `${bs.accent}22`,
        } as React.CSSProperties
      }
    >
      <canvas ref={canvasRef} className="game-canvas" />

      <div className="hud">
        <div className="hud-progress">
          <i style={{ width: `${progress * 100}%` }} />
          <div className="marks">
            {sectionMarks.map((m, i) => (
              <i key={i} style={{ left: `${m}%` }} />
            ))}
          </div>
        </div>

        <div className="hud-top">
          <div className="hud-song">
            <b>{song.kanji}</b>
            <span>
              {diff.kanji} {diff.romaji} · LV {song.levels[diff.id]} · {bs.english}
            </span>
          </div>
          <div className="hud-score">
            <b>{hud.score.toLocaleString('en-US')}</b>
            <span>{accPct}%</span>
          </div>
        </div>

        <div className="hud-section">{sectionName}</div>

        <div className={`hud-combo${comboBump ? ' bump' : ''}`}>
          {hud.combo > 0 && (
            <>
              <b>{hud.combo}</b>
              <span>COMBO</span>
              <div>
                <span className="mult">×{hud.multiplier}</span>
              </div>
            </>
          )}
        </div>

        <div className="hud-right">
          <div className="hud-acc">
            <b>{accPct}%</b>
            <span>ACCURACY</span>
          </div>

          <div>
            <div className="gauge-label">
              <span>全集中 CONCENTRATION</span>
              {hud.gaugeReady && <span className="go">SPACE</span>}
            </div>
            <div className={`gauge${hud.gaugeReady ? ' ready' : ''}`}>
              <i style={{ width: `${hud.artActive ? 100 : hud.gauge}%` }} />
            </div>
            {hud.guards > 0 && (
              <div className="guards">
                {Array.from({ length: hud.guards }, (_, i) => (
                  <i key={i} />
                ))}
              </div>
            )}
          </div>

          {!settings.noFail && (
            <div>
              <div className="gauge-label">
                <span>気力 RESOLVE</span>
                <span className="num">{Math.round(hud.resolve)}</span>
              </div>
              <div className={`gauge resolve${hud.resolve < 30 ? ' low' : ''}`}>
                <i style={{ width: `${hud.resolve}%` }} />
              </div>
            </div>
          )}
        </div>

        {settings.showTimingBar && (
          <div className="timing-bar">
            <div className="scale" />
            <div className="centre" />
            {ticks.map((t) => (
              <i
                key={t.id}
                style={{
                  left: `${50 + Math.max(-50, Math.min(50, (t.delta / 0.15) * 50))}%`,
                  background: t.color,
                }}
              />
            ))}
          </div>
        )}

        {artBanner > 0 && hud.artActive && (
          <div className="art-banner" key={artBanner}>
            <div className="form-kanji">{bs.formKanji}</div>
            <div className="form-romaji">{bs.formRomaji}</div>
          </div>
        )}
      </div>

      {countdown > 0 && (
        <div className="overlay" style={{ background: 'rgba(5,4,9,0.5)' }}>
          <div className="countdown" key={countdown}>
            {['壱', '弐', '参'][countdown - 1]}
          </div>
        </div>
      )}

      {loadError && (
        <div className="overlay">
          <h2 className="kanji" style={{ color: 'var(--crimson)' }}>音源不明</h2>
          <span className="romaji">TRACK COULD NOT BE LOADED</span>
          <div className="ink-rule" style={{ width: 260 }} />
          <p style={{ maxWidth: 460, textAlign: 'center', fontSize: 12, color: 'var(--bone-dim)', lineHeight: 1.7 }}>
            {loadError}
          </p>
          <button className="btn btn-primary" onClick={quit}>
            Back to Song Select
          </button>
        </div>
      )}

      {paused && (
        <div className="overlay">
          <h2 className="gilt">小休止</h2>
          <span className="romaji">PAUSED</span>
          <div className="ink-rule" style={{ width: 260 }} />
          <div className="row gap-sm">
            <button className="btn btn-primary" onClick={doResume}>
              Resume
            </button>
            <button className="btn" onClick={quit}>
              Abandon Mission
            </button>
          </div>
          <div className="hintbar">
            <span>
              {hud.judged} / {hud.total} NOTES JUDGED
            </span>
            <span>
              {JUDGEMENT_LABEL.kiwami.kanji} {hud.counts.kiwami} ·{' '}
              {JUDGEMENT_LABEL.shitsu.kanji} {hud.counts.shitsu}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
