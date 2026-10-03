/**
 * An agent's seal: its initials struck inside a guilloche rosette, in its
 * job's colours. A shelf of charts reads as data; a shelf of faces reads as
 * a shop, and most agents publish no picture we can vouch for. So each one
 * gets a seal of its own, seeded by its id and name: the same agent always
 * looks the same, and two agents in one job are related but never identical.
 *
 * Nothing in it is data, and it never claims anything. The checks an agent
 * has passed are written beside it, in words.
 *
 * Pure SVG, server-rendered.
 */
import type { Category } from "@/lib/config";
import { rng, TONE } from "./AgentArtwork";

const NEUTRAL = { hue: "var(--c-text-3)", hue2: "var(--c-text-2)", bg: "var(--c-surface-2)" };
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Two letters a person would pick: the first two words' initials, or a single word's first two letters. */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? "").replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/[\s-]+/).filter(Boolean);
  if (!words.length) return "?";
  const pick = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : words[0]!.slice(0, 2);
  return pick.toUpperCase();
}

export default function AgentSeal({ tokenId, name, category, size = 48, className }: { tokenId: string; name: string | null; category: Category | null; size?: number; className?: string }) {
  const tone = category ? TONE[category] : NEUTRAL;
  const rand = rng(`seal:${tokenId}:${name ?? ""}`);
  const petals = 10 + Math.floor(rand() * 9);
  const turn = rand() * 360;
  const rx = 7 + rand() * 6;
  const ry = 15 + rand() * 6;
  const dash = 1 + Math.round(rand() * 3);
  const letters = initialsOf(name);

  return (
    <svg className={className} width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <circle cx="50" cy="50" r="49" fill={tone.bg} />
      <g fill="none" stroke={tone.hue2} strokeWidth="0.7" opacity="0.5">
        {Array.from({ length: petals }, (_, i) => (
          <ellipse key={i} cx="50" cy={r1(50 - 24)} rx={r1(rx)} ry={r1(ry)} transform={`rotate(${r1(turn + (i * 360) / petals)} 50 50)`} />
        ))}
      </g>
      <circle cx="50" cy="50" r="46.5" fill="none" stroke={tone.hue} strokeWidth="1.6" />
      <circle cx="50" cy="50" r="42" fill="none" stroke={tone.hue} strokeWidth="0.8" strokeDasharray={`${dash} ${dash + 1.5}`} opacity="0.7" />
      <circle cx="50" cy="50" r="27" fill={tone.bg} stroke={tone.hue} strokeWidth="1.2" />
      <text x="50" y="50" textAnchor="middle" dominantBaseline="central" fill="var(--c-text)" fontFamily="var(--f-display)" fontWeight="700" fontSize={letters.length > 1 ? 23 : 28} letterSpacing="-0.5">
        {letters}
      </text>
    </svg>
  );
}
