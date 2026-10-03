/**
 * Every agent's picture, drawn from the job it does.
 *
 * Registry agents either publish no image or publish one we cannot vouch for,
 * and a grid of blanks and stock robots reads as a database, not a shop. So
 * each agent is drawn as the financial instrument it operates, and each of
 * the four jobs has its own ground colour and its own geometry, so a person
 * can tell the categories apart before reading a word:
 *
 *   rebalancing   a liquidity depth chart, the active range lit, the price
 *                 marker drifting inside it
 *   grid          a price ladder: levels, a price path crossing them, buys and
 *                 sells filled where it crosses, an order book on the edge
 *   yield         capital routed Sankey-style from one source to venues, the
 *                 best route live, each venue with its rate
 *   health        a shield around a risk gauge with the liquidation threshold
 *                 marked and a needle where the position sits
 *
 * The seed (token id and name) varies the particulars, so siblings in one job
 * are recognisably related and never identical. Nothing here is data: the
 * picture is an identity, and the page never presents it as a reading.
 *
 * Pure SVG, server-rendered, no filters. Motion is CSS: tiles move only on
 * hover, and everything stops under reduced motion.
 */

import type { Category } from "@/lib/config";

type Shape = "banner" | "square" | "wide";

export const TONE: Record<Category, { hue: string; hue2: string; bg: string }> = {
  rebalancing: { hue: "var(--c-cat-rebalance)", hue2: "var(--c-cat-rebalance-2)", bg: "var(--c-cat-rebalance-bg)" },
  "grid-trading": { hue: "var(--c-cat-grid)", hue2: "var(--c-cat-grid-2)", bg: "var(--c-cat-grid-bg)" },
  "yield-optimisation": { hue: "var(--c-cat-yield)", hue2: "var(--c-cat-yield-2)", bg: "var(--c-cat-yield-bg)" },
  "health-factor": { hue: "var(--c-cat-health)", hue2: "var(--c-cat-health-2)", bg: "var(--c-cat-health-bg)" },
};

/** A small deterministic PRNG. Same seed, same picture, on server and client. */
export function rng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const between = (rand: () => number, a: number, b: number) => a + rand() * (b - a);

interface Ctx {
  w: number;
  h: number;
  rand: () => number;
  id: string;
  hue: string;
  hue2: string;
}

/** Catmull-Rom through points, as a smooth cubic path. */
function smooth(pts: [number, number][]): string {
  if (pts.length < 2) return "";
  let d = `M ${r1(pts[0][0])} ${r1(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${r1(c1[0])} ${r1(c1[1])}, ${r1(c2[0])} ${r1(c2[1])}, ${r1(p2[0])} ${r1(p2[1])}`;
  }
  return d;
}

/* ------------------------------------------------------------ rebalancing */

function Rebalance({ w, h, rand, id, hue, hue2 }: Ctx) {
  const pad = w * 0.05;
  const base = h * 0.84;
  const n = Math.round(between(rand, 30, 40));
  const slot = (w - pad * 2) / n;
  const bar = Math.max(2, slot * 0.72);
  const c = between(rand, 0.38, 0.62);
  const spread = between(rand, 0.12, 0.2);
  const peak = h * between(rand, 0.52, 0.66);
  const lo = c - spread * between(rand, 0.7, 1.1);
  const hi = c + spread * between(rand, 0.7, 1.1);
  const price = c + (rand() - 0.5) * spread * 1.1;
  const X = (f: number) => pad + f * (w - pad * 2);

  // A second pool of liquidity on some agents, and a lean on others, so two
  // range agents never share a silhouette.
  const twin = rand() < 0.4;
  const c2 = c + (rand() < 0.5 ? -1 : 1) * spread * between(rand, 1.6, 2.3);
  const twinH = between(rand, 0.35, 0.6);
  const lean = between(rand, -0.35, 0.35);
  const bars = Array.from({ length: n }, (_, i) => {
    const f = (i + 0.5) / n;
    const s1 = spread * (f < c ? 1 - lean : 1 + lean);
    const main = Math.exp(-((f - c) ** 2) / (2 * s1 * s1));
    const second = twin ? twinH * Math.exp(-((f - c2) ** 2) / (2 * (spread * 0.7) ** 2)) : 0;
    const shape = Math.max(main, second);
    const height = Math.max(3, peak * shape * (0.78 + rand() * 0.34) + h * 0.03);
    return { x: pad + i * slot + (slot - bar) / 2, height, inRange: f >= lo && f <= hi };
  });

  return (
    <g>
      <defs>
        <linearGradient id={`in-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={hue2} stopOpacity="0.95" />
          <stop offset="1" stopColor={hue} stopOpacity="0.35" />
        </linearGradient>
      </defs>
      {[0.3, 0.55].map((f) => (
        <line key={f} x1={pad} x2={w - pad} y1={r1(h * f)} y2={r1(h * f)} stroke="rgba(255,255,255,0.05)" />
      ))}
      <rect x={r1(X(lo))} y={r1(h * 0.1)} width={r1(X(hi) - X(lo))} height={r1(base - h * 0.1)} fill={hue} fillOpacity="0.07" />
      {bars.map((b, i) => (
        <rect
          key={i}
          x={r1(b.x)}
          y={r1(base - b.height)}
          width={r1(bar)}
          height={r1(b.height)}
          rx={Math.min(2, bar / 3)}
          fill={b.inRange ? `url(#in-${id})` : "rgba(255,255,255,0.12)"}
        />
      ))}
      <line x1={pad} x2={w - pad} y1={r1(base)} y2={r1(base)} stroke="rgba(255,255,255,0.18)" />
      {[lo, hi].map((f, i) => (
        <g key={i}>
          <line x1={r1(X(f))} x2={r1(X(f))} y1={r1(h * 0.12)} y2={r1(base)} stroke={hue} strokeWidth="1.4" strokeDasharray="4 4" strokeOpacity="0.9" />
          <rect x={r1(X(f) - 4)} y={r1(h * 0.08)} width="8" height="16" rx="3" fill={hue} />
        </g>
      ))}
      <g className="x-art-drift">
        <line x1={r1(X(price))} x2={r1(X(price))} y1={r1(h * 0.16)} y2={r1(base)} stroke="var(--c-accent)" strokeWidth="2" />
        <circle cx={r1(X(price))} cy={r1(h * 0.16)} r="4.5" fill="var(--c-accent)" />
      </g>
    </g>
  );
}

/* ------------------------------------------------------------------- grid */

function Grid({ w, h, rand, id, hue, hue2 }: Ctx) {
  const top = h * 0.12;
  const bottom = h * 0.86;
  const left = w * 0.07;
  const right = w * 0.86;
  const levels = Math.round(between(rand, 6, 9));
  const gap = (bottom - top) / (levels - 1);
  const ly = (i: number) => top + i * gap;
  const mid = (top + bottom) / 2;

  const k = Math.round(between(rand, 9, 13));
  const phase = rand() * 6;
  const amp = (bottom - top) * between(rand, 0.28, 0.4);
  const pts: [number, number][] = Array.from({ length: k }, (_, i) => {
    const x = left + ((right - left) * i) / (k - 1);
    const y = mid + Math.sin(i * between(rand, 0.7, 1.1) + phase) * amp + (rand() - 0.5) * gap * 1.2;
    return [x, Math.max(top + 4, Math.min(bottom - 4, y))];
  });
  const d = smooth(pts);

  // Where the path crosses a level: a filled order.
  const fills: { x: number; y: number; sell: boolean }[] = [];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    for (let l = 0; l < levels; l++) {
      const y = ly(l);
      if ((y0 - y) * (y1 - y) < 0) fills.push({ x: x0 + ((y - y0) / (y1 - y0)) * (x1 - x0), y, sell: y < mid });
    }
  }

  return (
    <g>
      <defs>
        <linearGradient id={`area-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={hue2} stopOpacity="0.22" />
          <stop offset="1" stopColor={hue} stopOpacity="0" />
        </linearGradient>
      </defs>
      {Array.from({ length: levels }, (_, i) => {
        const sell = ly(i) < mid;
        return (
          <g key={i}>
            <line x1={r1(left)} x2={r1(right)} y1={r1(ly(i))} y2={r1(ly(i))} stroke={sell ? hue : "var(--c-ok)"} strokeOpacity="0.22" strokeDasharray="3 5" />
            <line x1={r1(left - 10)} x2={r1(left - 4)} y1={r1(ly(i))} y2={r1(ly(i))} stroke="rgba(255,255,255,0.3)" />
            <rect
              x={r1(right + 8)}
              y={r1(ly(i) - 2.5)}
              width={r1(between(rand, 8, w - right - 16))}
              height="5"
              rx="1.5"
              fill={sell ? hue : "var(--c-ok)"}
              fillOpacity="0.55"
            />
          </g>
        );
      })}
      <path d={`${d} L ${r1(right)} ${r1(bottom)} L ${r1(left)} ${r1(bottom)} Z`} fill={`url(#area-${id})`} />
      <path d={d} fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      {fills.slice(0, 16).map((f, i) => (
        <circle key={i} cx={r1(f.x)} cy={r1(f.y)} r="3.6" fill={f.sell ? hue2 : "var(--c-ok)"} stroke="rgba(11,14,17,0.9)" strokeWidth="1.5" />
      ))}
      <circle className="x-art-travel" r="4.5" fill="var(--c-accent)" style={{ offsetPath: `path('${d}')` }} />
    </g>
  );
}

/* ------------------------------------------------------------------ yield */

function Yield(ctx: Ctx) {
  // Some agents route capital the other way across the frame.
  const flip = ctx.rand() < 0.4;
  return flip ? (
    <g transform={`translate(${ctx.w} 0) scale(-1 1)`}>
      <YieldFlow {...ctx} />
    </g>
  ) : (
    <YieldFlow {...ctx} />
  );
}

function YieldFlow({ w, h, rand, id, hue, hue2 }: Ctx) {
  const sx = w * 0.08;
  const sTop = h * 0.2;
  const sBot = h * 0.8;
  const vx = w * 0.72;
  const count = Math.round(between(rand, 3, 4));
  const best = Math.floor(rand() * count);
  const weights = Array.from({ length: count }, (_, i) => (i === best ? between(rand, 1.4, 2) : between(rand, 0.5, 1)));
  const total = weights.reduce((a, b) => a + b, 0);
  const vGap = h * 0.06;
  const vSpan = h * 0.78 - vGap * (count - 1);

  let sCursor = sTop;
  let vCursor = h * 0.11;
  const bands = weights.map((wt, i) => {
    const sh = ((sBot - sTop) * wt) / total;
    const vh = (vSpan * wt) / total;
    const b = { s0: sCursor, s1: sCursor + sh, v0: vCursor, v1: vCursor + vh, best: i === best, rate: i === best ? between(rand, 0.75, 1) : between(rand, 0.25, 0.7) };
    sCursor += sh;
    vCursor += vh + vGap;
    return b;
  });
  const mx = (sx + vx) / 2;

  return (
    <g>
      <defs>
        <linearGradient id={`flow-${id}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={hue} stopOpacity="0.12" />
          <stop offset="1" stopColor={hue2} stopOpacity="0.55" />
        </linearGradient>
      </defs>
      {bands.map((b, i) => (
        <path
          key={i}
          d={`M ${r1(sx + 8)} ${r1(b.s0)} C ${r1(mx)} ${r1(b.s0)}, ${r1(mx)} ${r1(b.v0)}, ${r1(vx)} ${r1(b.v0)} L ${r1(vx)} ${r1(b.v1)} C ${r1(mx)} ${r1(b.v1)}, ${r1(mx)} ${r1(b.s1)}, ${r1(sx + 8)} ${r1(b.s1)} Z`}
          fill={b.best ? `url(#flow-${id})` : "rgba(255,255,255,0.06)"}
        />
      ))}
      {bands
        .filter((b) => b.best)
        .map((b, i) => {
          const sm = (b.s0 + b.s1) / 2;
          const vm = (b.v0 + b.v1) / 2;
          return (
            <path
              key={`f${i}`}
              className="x-art-flow"
              d={`M ${r1(sx + 8)} ${r1(sm)} C ${r1(mx)} ${r1(sm)}, ${r1(mx)} ${r1(vm)}, ${r1(vx)} ${r1(vm)}`}
              fill="none"
              stroke={hue2}
              strokeWidth="1.6"
              strokeDasharray="5 7"
            />
          );
        })}
      <rect x={r1(sx)} y={r1(sTop)} width="9" height={r1(sBot - sTop)} rx="3" fill="rgba(255,255,255,0.32)" />
      {bands.map((b, i) => (
        <g key={`v${i}`}>
          <rect x={r1(vx)} y={r1(b.v0)} width="10" height={r1(Math.max(6, b.v1 - b.v0))} rx="3" fill={b.best ? hue : "rgba(255,255,255,0.22)"} />
          <rect x={r1(vx + 18)} y={r1((b.v0 + b.v1) / 2 - 3)} width={r1((w - vx - 30) * b.rate)} height="6" rx="2" fill={b.best ? "var(--c-accent)" : "rgba(255,255,255,0.18)"} />
        </g>
      ))}
    </g>
  );
}

/* ----------------------------------------------------------------- health */

function Health({ w, h, rand, id, hue, hue2 }: Ctx) {
  // Half the agents put the shield on the left, and the shield's build varies,
  // so two guards side by side are not the same picture twice.
  const mirror = rand() < 0.5;
  const cx = w * (mirror ? between(rand, 0.3, 0.38) : between(rand, 0.62, 0.7));
  const sh = h * between(rand, 0.8, 0.9);
  const sw = sh * between(rand, 0.36, 0.48);
  const y0 = h * 0.07;
  const shield = `M ${r1(cx)} ${r1(y0)} L ${r1(cx + sw)} ${r1(y0 + sh * 0.16)} L ${r1(cx + sw)} ${r1(y0 + sh * 0.52)} Q ${r1(cx + sw)} ${r1(y0 + sh * 0.84)} ${r1(cx)} ${r1(y0 + sh)} Q ${r1(cx - sw)} ${r1(y0 + sh * 0.84)} ${r1(cx - sw)} ${r1(y0 + sh * 0.52)} L ${r1(cx - sw)} ${r1(y0 + sh * 0.16)} Z`;
  const gx = cx;
  const gy = y0 + sh * 0.56;
  const R = sw * 0.66;
  const start = 210; // degrees, clockwise sweep of 240
  const sweep = 240;
  const pt = (deg: number, r: number): [number, number] => {
    const a = (deg * Math.PI) / 180;
    return [gx + r * Math.cos(a), gy - r * Math.sin(a)];
  };
  const arc = (f0: number, f1: number, r: number) => {
    const a0 = start - sweep * f0;
    const a1 = start - sweep * f1;
    const [x0, y0p] = pt(a0, r);
    const [x1, y1] = pt(a1, r);
    return `M ${r1(x0)} ${r1(y0p)} A ${r1(r)} ${r1(r)} 0 ${sweep * (f1 - f0) > 180 ? 1 : 0} 1 ${r1(x1)} ${r1(y1)}`;
  };
  const threshold = between(rand, 0.18, 0.24);
  const value = between(rand, 0.5, 0.86);
  const [nx, ny] = pt(start - sweep * value, R * 0.82);

  // A short history of the health factor, left of the shield.
  const hx0 = mirror ? cx + sw + w * 0.06 : w * 0.06;
  const hx1 = mirror ? w * 0.94 : cx - sw - w * 0.06;
  const hist: [number, number][] = Array.from({ length: 8 }, (_, i) => [hx0 + ((hx1 - hx0) * i) / 7, h * (0.3 + rand() * 0.3)]);

  return (
    <g>
      <defs>
        <linearGradient id={`shield-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={hue} stopOpacity="0.16" />
          <stop offset="1" stopColor={hue} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {hx1 > hx0 + 20 ? (
        <g>
          <line x1={r1(hx0)} x2={r1(hx1)} y1={r1(h * 0.74)} y2={r1(h * 0.74)} stroke="var(--c-err)" strokeOpacity="0.6" strokeDasharray="3 4" />
          <path d={smooth(hist)} fill="none" stroke={hue2} strokeWidth="1.8" strokeLinecap="round" />
          <circle cx={r1(hist[7][0])} cy={r1(hist[7][1])} r="3.2" fill={hue2} />
        </g>
      ) : null}
      <path d={shield} fill={`url(#shield-${id})`} stroke={hue} strokeOpacity="0.55" strokeWidth="1.4" />
      <path d={arc(0, 1, R)} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="9" strokeLinecap="round" />
      <path d={arc(0, threshold, R)} fill="none" stroke="var(--c-err)" strokeWidth="9" strokeLinecap="round" />
      <path d={arc(threshold + 0.03, threshold + 0.24, R)} fill="none" stroke="var(--c-accent)" strokeOpacity="0.85" strokeWidth="9" />
      <path d={arc(threshold + 0.27, 1, R)} fill="none" stroke="var(--c-ok)" strokeOpacity="0.8" strokeWidth="9" strokeLinecap="round" />
      {(() => {
        const [ax, ay] = pt(start - sweep * threshold, R * 0.62);
        const [bx, by] = pt(start - sweep * threshold, R * 1.28);
        return <line x1={r1(ax)} y1={r1(ay)} x2={r1(bx)} y2={r1(by)} stroke="var(--c-err)" strokeWidth="2" />;
      })()}
      <g className="x-art-breathe" style={{ transformOrigin: `${r1(gx)}px ${r1(gy)}px` }}>
        <line x1={r1(gx)} y1={r1(gy)} x2={r1(nx)} y2={r1(ny)} stroke="rgba(255,255,255,0.92)" strokeWidth="2.2" strokeLinecap="round" />
      </g>
      <circle cx={r1(gx)} cy={r1(gy)} r="5" fill="var(--c-accent)" />
    </g>
  );
}

function Unfiled({ w, h, rand }: Ctx) {
  return (
    <g>
      {Array.from({ length: 9 }, (_, i) => (
        <rect key={i} x={r1(rand() * w * 0.85)} y={r1(h * 0.15 + rand() * h * 0.7)} width={r1(20 + rand() * 70)} height="2" rx="1" fill="rgba(255,255,255,0.14)" />
      ))}
    </g>
  );
}

const SIZE: Record<Shape, [number, number]> = { banner: [400, 220], square: [300, 300], wide: [400, 300] };

export default function AgentArtwork({
  category,
  seed,
  shape = "banner",
  title,
}: {
  category: Category | null;
  /** Anything stable per agent: callers pass the token id and name. */
  seed: string;
  shape?: Shape;
  /** Accessible name. The art is decorative when omitted. */
  title?: string;
}) {
  const [w, h] = SIZE[shape];
  const rand = rng(`${category ?? "none"}:${seed}`);
  const id = `${shape[0]}${Math.floor(rand() * 1e9).toString(36)}`;
  const tone = category ? TONE[category] : { hue: "rgba(255,255,255,0.3)", hue2: "rgba(255,255,255,0.5)", bg: "var(--c-surface-2)" };
  const ctx: Ctx = { w, h, rand, id, hue: tone.hue, hue2: tone.hue2 };

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="xMidYMid slice"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      className="x-art"
      data-category={category ?? "none"}
    >
      <defs>
        <radialGradient id={`glow-${id}`} cx="0.75" cy="0.15" r="0.9">
          <stop offset="0" stopColor={tone.hue} stopOpacity="0.16" />
          <stop offset="1" stopColor={tone.hue} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width={w} height={h} fill={tone.bg} />
      <rect width={w} height={h} fill={`url(#glow-${id})`} />
      {category === "rebalancing" ? <Rebalance {...ctx} /> : null}
      {category === "grid-trading" ? <Grid {...ctx} /> : null}
      {category === "yield-optimisation" ? <Yield {...ctx} /> : null}
      {category === "health-factor" ? <Health {...ctx} /> : null}
      {!category ? <Unfiled {...ctx} /> : null}
    </svg>
  );
}
