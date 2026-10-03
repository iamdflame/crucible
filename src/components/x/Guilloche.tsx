/**
 * A guilloche rosette: the engraved pattern on banknotes and certificates,
 * drawn behind the front page's proof of a real hire. It is the Seal's
 * motif at full size, struck in the signature green: the page's one picture,
 * and it says what the product does (certifies) without a word.
 *
 * Pure SVG, server-rendered; it turns slowly, and not at all under reduced
 * motion. Decorative only.
 */
const r1 = (n: number) => Math.round(n * 10) / 10;

/** One ring of petals: `n` ellipses rotated around the centre. */
function ring(n: number, cy: number, rx: number, ry: number, turn: number) {
  return Array.from({ length: n }, (_, i) => <ellipse key={i} cx="300" cy={r1(cy)} rx={r1(rx)} ry={r1(ry)} transform={`rotate(${r1(turn + (i * 360) / n)} 300 300)`} />);
}

export default function Guilloche({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 600 600" aria-hidden="true" focusable="false">
      <g fill="none" stroke="var(--c-accent)">
        <g className="x-guilloche__spin" strokeWidth="0.8" opacity="0.32">
          {ring(36, 150, 34, 150, 0)}
        </g>
        <g className="x-guilloche__spin x-guilloche__spin--back" strokeWidth="0.7" opacity="0.26">
          {ring(28, 196, 26, 104, 6)}
        </g>
        <g strokeWidth="0.9" opacity="0.4">
          {ring(18, 240, 18, 60, 10)}
        </g>
        <circle cx="300" cy="300" r="296" strokeWidth="1.4" opacity="0.4" />
        <circle cx="300" cy="300" r="286" strokeWidth="0.8" strokeDasharray="2 6" opacity="0.45" />
        <circle cx="300" cy="300" r="176" strokeWidth="1" opacity="0.35" />
      </g>
    </svg>
  );
}
