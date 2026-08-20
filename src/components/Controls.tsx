import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <label className="ctrl">
      <span className="ctrl-label">{label}</span>
      <span className="ctrl-body">
        <span className="slider">
          <span className="slider-track">
            <span className="slider-fill" style={{ width: `${pct}%` }} />
            <span className="slider-thumb" style={{ left: `${pct}%` }} />
          </span>
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => onChange(parseFloat(e.target.value))}
          />
        </span>
        <span className="ctrl-value num">
          {format ? format(value) : value.toFixed(2)}
        </span>
      </span>
    </label>
  );
}

export function Toggle({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="ctrl ctrl-toggle"
      onClick={() => onChange(!value)}
      aria-pressed={value}
    >
      <span className="ctrl-label">
        {label}
        {hint && <em className="ctrl-hint">{hint}</em>}
      </span>
      <span className={`switch${value ? ' on' : ''}`}>
        <span className="switch-knob" />
      </span>
    </button>
  );
}

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label?: string;
  value: T;
  options: Array<{ value: T; label: ReactNode; color?: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="ctrl">
      {label && <span className="ctrl-label">{label}</span>}
      <div className="segmented">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`seg${o.value === value ? ' active' : ''}`}
            style={
              o.value === value && o.color
                ? ({ '--seg-color': o.color } as React.CSSProperties)
                : undefined
            }
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const KEY_DISPLAY: Record<string, string> = {
  ' ': 'SPACE',
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  shift: 'SHIFT',
  control: 'CTRL',
  alt: 'ALT',
  enter: 'ENTER',
  tab: 'TAB',
};

export const displayKey = (k: string): string =>
  KEY_DISPLAY[k.toLowerCase()] ?? k.toUpperCase();

/** Click, then press a key. Escape cancels. */
export function KeyBinder({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (k: string) => void;
}) {
  const [listening, setListening] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setListening(false);
        return;
      }
      onChange(e.key.length === 1 ? e.key.toLowerCase() : e.key);
      setListening(false);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [listening, onChange]);

  return (
    <button
      ref={ref}
      type="button"
      className={`keybind${listening ? ' listening' : ''}`}
      onClick={() => setListening((v) => !v)}
    >
      <span className="keybind-label">{label}</span>
      <kbd>{listening ? '…' : displayKey(value)}</kbd>
    </button>
  );
}

/** Escape-to-go-back, used by every sub-screen. */
export function useEscape(handler: () => void, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  const stable = useCallback(() => ref.current(), []);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        stable();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, stable]);
}
