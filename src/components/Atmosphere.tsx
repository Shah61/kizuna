import { useMemo } from 'react';

/**
 * Drifting petals / rising embers behind the menus. Pure CSS animation on a
 * fixed set of elements — cheap enough to leave running under every screen.
 */
export function Atmosphere({
  count = 22,
  kind = 'petal',
  tint,
}: {
  count?: number;
  kind?: 'petal' | 'ember';
  tint?: string;
}) {
  const items = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => {
        const seed = (i * 2654435761) % 1000 / 1000;
        const seed2 = (i * 40503) % 997 / 997;
        return {
          left: `${(seed * 100).toFixed(2)}%`,
          delay: `${(-seed2 * 18).toFixed(2)}s`,
          duration: `${(kind === 'petal' ? 11 + seed2 * 12 : 7 + seed2 * 7).toFixed(2)}s`,
          drift: `${((seed - 0.5) * (kind === 'petal' ? 260 : 120)).toFixed(0)}px`,
          scale: 0.5 + seed2 * 0.9,
          opacity: 0.3 + seed * 0.5,
        };
      }),
    [count, kind],
  );

  return (
    <div className="petal-field" aria-hidden="true">
      {items.map((it, i) => (
        <span
          key={i}
          className={kind === 'petal' ? 'petal' : 'ember'}
          style={
            {
              left: it.left,
              animationDelay: it.delay,
              animationDuration: it.duration,
              transform: `scale(${it.scale})`,
              '--petal-drift': it.drift,
              '--ember-drift': it.drift,
              '--petal-opacity': it.opacity,
              ...(tint && kind === 'ember' ? { background: tint } : null),
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
