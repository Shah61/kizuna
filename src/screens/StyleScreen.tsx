import { useEffect, useState } from 'react';
import { BREATHING_STYLES, getStyle, type BreathingId } from '../data/breathing';
import { useStore } from '../store';
import { getSynth } from '../audio/synth';
import { useEscape } from '../components/Controls';
import { Atmosphere } from '../components/Atmosphere';

export function StyleScreen({ onBack }: { onBack: () => void }) {
  const { style, setStyle } = useStore();
  const [hover, setHover] = useState<BreathingId>(style);
  const current = getStyle(hover);

  useEscape(() => {
    getSynth().uiBack();
    onBack();
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const i = BREATHING_STYLES.findIndex((s) => s.id === hover);
      if (e.key === 'ArrowRight') {
        setHover(BREATHING_STYLES[(i + 1) % BREATHING_STYLES.length].id);
        getSynth().uiHover();
      } else if (e.key === 'ArrowLeft') {
        setHover(
          BREATHING_STYLES[(i - 1 + BREATHING_STYLES.length) % BREATHING_STYLES.length].id,
        );
        getSynth().uiHover();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setStyle(hover);
        getSynth().uiSelect();
        onBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hover, setStyle, onBack]);

  return (
    <div className="screen screen-enter">
      <Atmosphere count={10} kind="ember" tint={current.accent} />

      <header className="screen-head">
        <div className="screen-title">
          <h1>呼吸を選べ</h1>
          <span className="romaji">CHOOSE YOUR BREATHING</span>
        </div>
        <span className="eyebrow">SIX STYLES · SIX SETS OF RULES</span>
      </header>

      <div className="screen-body stack gap-md">
        <div className="style-grid grow">
          {BREATHING_STYLES.map((s) => (
            <button
              key={s.id}
              className={`style-card${s.id === hover ? ' selected' : ''}`}
              style={{ ['--card' as string]: s.accent }}
              onMouseEnter={() => {
                if (s.id !== hover) {
                  setHover(s.id);
                  getSynth().uiHover();
                }
              }}
              onClick={() => {
                setStyle(s.id);
                getSynth().uiSelect();
                onBack();
              }}
            >
              <span className="style-card-kanji">{s.kanji.slice(0, 1)}</span>
              <span className="style-card-name">
                <b>{s.english.replace(' Breathing', '').toUpperCase()}</b>
                <span>{s.romaji.split(' ')[0]}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="style-detail" style={{ ['--accent' as string]: current.accent }}>
          <div>
            <h3>
              {current.kanji} · {current.english}
            </h3>
            <p>{current.description}</p>
            <p
              style={{
                marginTop: 12,
                fontFamily: 'var(--font-jp)',
                color: current.accent,
                fontSize: 12,
                letterSpacing: '0.14em',
              }}
            >
              {current.formKanji} — {current.formRomaji}
            </p>
          </div>
          <div className="style-traits">
            <div className="trait perk">
              <span className="trait-tag">PERK</span>
              <span>{current.perk}</span>
            </div>
            <div className="trait cost">
              <span className="trait-tag">COST</span>
              <span>{current.cost}</span>
            </div>
            <div className="trait" style={{ color: 'var(--bone-faint)' }}>
              <span className="trait-tag" style={{ background: 'rgba(244,238,226,0.07)' }}>
                ART
              </span>
              <span>
                Doubles score and upgrades every judgement for{' '}
                {current.id === 'wind' ? '5.3' : '8.5'}s
              </span>
            </div>
          </div>
        </div>
      </div>

      <footer className="screen-foot">
        <div className="hintbar">
          <span>
            <kbd>←→</kbd>BROWSE
          </span>
          <span>
            <kbd>↵</kbd>EQUIP
          </span>
          <span>
            <kbd>ESC</kbd>BACK
          </span>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          Back
        </button>
      </footer>
    </div>
  );
}
