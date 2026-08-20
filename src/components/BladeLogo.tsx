/**
 * The title lockup. Drawn as SVG so it stays crisp at any window size and can
 * animate its own stroke — the blade "draws itself" on the title screen.
 */
export function BladeLogo({
  width = 520,
  animate = true,
  accent = '#d7263d',
}: {
  width?: number;
  animate?: boolean;
  accent?: string;
}) {
  return (
    <svg
      width={width}
      viewBox="0 0 520 190"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Kizuna Blade"
      style={{ display: 'block', overflow: 'visible' }}
    >
      <defs>
        <linearGradient id="steel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="45%" stopColor="#e8e2d6" />
          <stop offset="55%" stopColor="#9aa3b2" />
          <stop offset="100%" stopColor="#f4eee2" />
        </linearGradient>
        <linearGradient id="gilt" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fff3d0" />
          <stop offset="45%" stopColor="#e2b558" />
          <stop offset="78%" stopColor="#9a7526" />
          <stop offset="100%" stopColor="#f7dfa4" />
        </linearGradient>
        <filter id="softglow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="7" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* the blade — a single sweeping stroke that draws itself */}
      <g filter="url(#softglow)">
        <path
          d="M14 150 C 130 128, 300 74, 496 20"
          stroke="url(#steel)"
          strokeWidth="5"
          strokeLinecap="round"
          pathLength={1}
          style={
            animate
              ? {
                  strokeDasharray: 1,
                  strokeDashoffset: 1,
                  animation: 'blade-draw 1.15s cubic-bezier(0.2,0.9,0.1,1) 0.15s forwards',
                }
              : undefined
          }
        />
      </g>
      <path
        d="M14 150 C 130 128, 300 74, 496 20"
        stroke={accent}
        strokeWidth="1.2"
        strokeLinecap="round"
        opacity="0.85"
        transform="translate(0, 7)"
        pathLength={1}
        style={
          animate
            ? {
                strokeDasharray: 1,
                strokeDashoffset: 1,
                animation: 'blade-draw 1.15s cubic-bezier(0.2,0.9,0.1,1) 0.28s forwards',
              }
            : undefined
        }
      />

      {/* tsuba */}
      <ellipse
        cx="26"
        cy="152"
        rx="13"
        ry="6.5"
        fill="url(#gilt)"
        transform="rotate(-12 26 152)"
        opacity={animate ? 0 : 1}
        style={
          animate
            ? { animation: 'logo-fade 0.5s ease-out 1.1s forwards' }
            : undefined
        }
      />

      <g
        opacity={animate ? 0 : 1}
        style={
          animate ? { animation: 'logo-fade 0.7s ease-out 0.95s forwards' } : undefined
        }
      >
        <text
          x="260"
          y="120"
          textAnchor="middle"
          fill="url(#gilt)"
          fontFamily='"Hiragino Mincho ProN", "Yu Mincho", serif'
          fontSize="72"
          fontWeight="600"
          letterSpacing="14"
        >
          絆刃
        </text>
        <text
          x="260"
          y="156"
          textAnchor="middle"
          fill="#f4eee2"
          fontFamily='"Avenir Next", system-ui, sans-serif'
          fontSize="13"
          fontWeight="700"
          letterSpacing="15"
          opacity="0.82"
        >
          KIZUNA BLADE
        </text>
      </g>
    </svg>
  );
}
