import { useEffect, useState } from 'react';
import { BladeLogo } from '../components/BladeLogo';
import { Atmosphere } from '../components/Atmosphere';
import { getStyle } from '../data/breathing';
import { useStore } from '../store';
import { getSynth } from '../audio/synth';

export type MenuTarget = 'play' | 'style' | 'records' | 'settings' | 'quit';

interface Entry {
  id: MenuTarget;
  kanji: string;
  label: string;
  hint: string;
}

const ENTRIES: Entry[] = [
  { id: 'play', kanji: '出陣', label: 'Begin Mission', hint: 'Choose a song and cut it clean.' },
  { id: 'style', kanji: '呼吸', label: 'Breathing Style', hint: 'Six styles. Each one changes the rules.' },
  { id: 'records', kanji: '階級', label: 'Records', hint: 'Your ranks, scores and clears.' },
  { id: 'settings', kanji: '調整', label: 'Settings', hint: 'Keys, scroll speed, audio calibration.' },
];

export function MenuScreen({ onSelect }: { onSelect: (t: MenuTarget) => void }) {
  const { style } = useStore();
  const s = getStyle(style);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        setIndex((i) => (i + 1) % ENTRIES.length);
        getSynth().uiHover();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        setIndex((i) => (i - 1 + ENTRIES.length) % ENTRIES.length);
        getSynth().uiHover();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        getSynth().uiSelect();
        onSelect(ENTRIES[index].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, onSelect]);

  return (
    <div className="screen menu-screen screen-enter">
      <Atmosphere count={16} kind="petal" />

      <div className="menu-left">
        <div className="menu-brand">
          <BladeLogo width={280} animate={false} accent={s.accent} />
        </div>

        <nav className="menu-list">
          {ENTRIES.map((e, i) => (
            <button
              key={e.id}
              className={`menu-item${i === index ? ' active' : ''}`}
              onMouseEnter={() => {
                if (i !== index) {
                  setIndex(i);
                  getSynth().uiHover();
                }
              }}
              onClick={() => {
                getSynth().uiSelect();
                onSelect(e.id);
              }}
            >
              <span className="menu-item-kanji">{e.kanji}</span>
              <span className="menu-item-text">
                <b>{e.label}</b>
                <span>{e.hint}</span>
              </span>
            </button>
          ))}
        </nav>
      </div>

      <div className="menu-right">
        <div className="menu-crest">
          <div className="menu-crest-ring" />
          <div className="menu-crest-ring" />
          <div className="menu-crest-kanji">
            <span>{s.kanji.slice(0, 1)}</span>
            {s.kanji.slice(1)}
          </div>
        </div>
      </div>

      <div className="menu-style-chip">
        <span className="swatch" />
        <span className="stack gap-xs">
          <b style={{ fontSize: 11, letterSpacing: '0.2em' }}>{s.english.toUpperCase()}</b>
          <span className="eyebrow">{s.perk}</span>
        </span>
      </div>

      <div className="menu-foot">
        <span>
          <kbd style={{ marginRight: 8 }}>↑↓</kbd>NAVIGATE
          <kbd style={{ margin: '0 8px 0 22px' }}>↵</kbd>SELECT
        </span>
        <span>絆刃 · KIZUNA BLADE</span>
      </div>
    </div>
  );
}
