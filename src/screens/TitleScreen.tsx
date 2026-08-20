import { useEffect } from 'react';
import { BladeLogo } from '../components/BladeLogo';
import { Atmosphere } from '../components/Atmosphere';

export function TitleScreen({ onStart }: { onStart: () => void }) {
  useEffect(() => {
    const go = () => onStart();
    window.addEventListener('keydown', go);
    window.addEventListener('mousedown', go);
    return () => {
      window.removeEventListener('keydown', go);
      window.removeEventListener('mousedown', go);
    };
  }, [onStart]);

  return (
    <div className="screen title-screen screen-enter">
      <div className="title-rays" aria-hidden="true" />
      <div className="title-sun" aria-hidden="true" />
      <Atmosphere count={26} kind="petal" />

      <div className="title-inner">
        <BladeLogo width={540} />
        <div className="title-tagline">息を整えろ</div>
        <div className="title-prompt">
          <span className="title-prompt-key">PRESS ANY KEY</span>
        </div>
      </div>

      <div className="title-side left kanji-vertical" aria-hidden="true">
        全集中
      </div>
      <div className="title-side right kanji-vertical" aria-hidden="true">
        鬼滅
      </div>

      <div className="title-foot">
        <span>MP3 LIBRARY · CONTENT/MUSIC</span>
        <span>v0.1.0</span>
      </div>
    </div>
  );
}
