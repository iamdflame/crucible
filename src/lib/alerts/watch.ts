/**
 * Free liquidation alerts: which wallets are watched, for which Telegram
 * chats, and the pass that reads each one and says something only when it
 * matters.
 *
 * A wallet's Venus health factor is read the same way the diagnosis reads it.
 * A message goes out when the loan crosses below the level its watcher chose,
 * again when it gets close to liquidation, a reminder while it stays low, and
 * one line when it recovers. Nothing is signed and nothing is moved: this
 * reads public data and talks. Guard-1, which can repay, is offered, never
 * implied.
 */

import { randomBytes } from "node:crypto";
import { isAddress, type Address } from "viem";
import { sql as pg } from "@/lib/db/client";
import { ensureTables } from "@/lib/db/tables";
import { readVenus } from "@/lib/diagnose/positions";
import { SITE } from "@/lib/site";
import { send, type Button } from "./telegram";

export type State = "unread" | "none" | "ok" | "low" | "danger" | "liquidatable";

/** Below this a loan is one ordinary price move from liquidation, whatever level its watcher chose. */
const DANGER = 1.05;
/** The levels a person may choose; below 1.05 would warn too late to act. */
export const MIN_THRESHOLD = 1.05;
export const MAX_THRESHOLD = 3;
/** How many wallets one chat may watch. */
const PER_CHAT = 10;

export interface Reading {
  state: State;
  hf: number | null;
  collateralUsd: number | null;
  debtUsd: number | null;
  shortfallUsd: number;
}

export async function readWallet(wallet: Address, threshold: number): Promise<Reading> {
  const v = await readVenus(wallet);
  if (!v) return { state: "unread", hf: null, collateralUsd: null, debtUsd: null, shortfallUsd: 0 };
  const hf = v.healthFactor ?? null;
  const base = { hf, collateralUsd: v.collateralUsd ?? null, debtUsd: v.borrowUsd ?? null, shortfallUsd: v.shortfallUsd };
  if (v.shortfallUsd > 0 || (hf !== null && hf < 1)) return { state: "liquidatable", ...base };
  if (hf === null) return { state: "none", ...base };
  if (hf < DANGER) return { state: "danger", ...base };
  if (hf < threshold) return { state: "low", ...base };
  return { state: "ok", ...base };
}

const RANK: Record<State, number> = { unread: -1, none: 0, ok: 0, low: 1, danger: 2, liquidatable: 3 };
/** How long a loan may stay in a bad state before it is said again. */
const REPEAT_MS: Partial<Record<State, number>> = { low: 12 * 3_600_000, danger: 2 * 3_600_000, liquidatable: 2 * 3_600_000 };

export type Say = "worse" | "again" | "recovered" | "repaid" | null;

/** What, if anything, to tell a watcher. Pure, for tests. */
export function decide(prev: State | null, now: State, lastAlertAt: number | null, at = Date.now()): Say {
  if (now === "unread") return null;
  const before = prev && prev !== "unread" ? RANK[prev] : 0;
  const after = RANK[now];
  if (after >= 1 && after > before) return "worse";
  if (after >= 1 && after === before) return lastAlertAt === null || at - lastAlertAt >= (REPEAT_MS[now] ?? Infinity) ? "again" : null;
  if (before >= 1 && after === 0) return now === "none" ? "repaid" : "recovered";
  return null;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
// Cents while they matter; whole dollars once the sum is large.
const usd = (n: number | null) => (n === null ? "unknown" : `$${n < 100 ? n.toFixed(2) : Math.round(n).toLocaleString("en-US")}`);
const fall = (hf: number) => Math.max(0, Math.round((1 - 1 / hf) * 100));

/** One reading, in a sentence. */
export function describe(r: Reading): string {
  if (r.state === "unread") return "Venus could not be read just now";
  if (r.state === "none") return "no Venus loan";
  if (r.state === "liquidatable") return `liquidatable now, short by ${usd(r.shortfallUsd)}`;
  return `health factor ${r.hf!.toFixed(2)} (collateral ${usd(r.collateralUsd)}, debt ${usd(r.debtUsd)})`;
}

/** The message for a change, with the two ways out. */
export function message(say: Exclude<Say, null>, wallet: string, threshold: number, r: Reading): { text: string; buttons: Button[] } {
  const w = short(wallet);
  const ways: Button[] = [
    { text: "Open Venus", url: "https://app.venus.io" },
    { text: "Let Guard-1 repay for me", url: `${SITE}/leash?agent=guard-1` },
  ];
  const fix = "To raise it, repay some debt or add collateral on Venus. Or let Guard-1 repay for you, within a daily cap you set.";
  if (say === "recovered") return { text: `Back to ${r.hf!.toFixed(2)} on ${w}, above your ${threshold.toFixed(2)}. We keep watching.`, buttons: [] };
  if (say === "repaid") return { text: `${w} has no Venus debt now. We keep watching in case it borrows again.`, buttons: [] };
  if (r.state === "liquidatable") {
    return { text: `Urgent: the Venus loan on ${w} can be liquidated now, short by ${usd(r.shortfallUsd)}. Repay debt or add collateral as soon as you can.`, buttons: ways };
  }
  const hf = r.hf!;
  const lead = r.state === "danger" ? `Urgent: health factor ${hf.toFixed(2)} on ${w}.` : `Health factor ${hf.toFixed(2)} on ${w}, below your ${threshold.toFixed(2)}.`;
  const again = say === "again" ? " It is still there." : "";
  return {
    text: `${lead}${again}\nCollateral ${usd(r.collateralUsd)}, debt ${usd(r.debtUsd)}. If your collateral lost about ${fall(hf)}% of its value, the loan could be liquidated.\n\n${fix}`,
    buttons: ways,
  };
}

// ------------------------------------------------------------------ store

type Row = { id: string; wallet: string; threshold: number; chat_id: string | null; last_state: State | null; last_alert_at: Date | null };

export const validThreshold = (t: number) => Number.isFinite(t) && t >= MIN_THRESHOLD && t <= MAX_THRESHOLD;

/** A code the bot's Start button carries back, good for a day. */
export async function createCode(wallet: Address, threshold: number): Promise<string> {
  await ensureTables();
  const id = randomBytes(12).toString("hex");
  await pg!`insert into telegram_alerts (id, wallet, threshold) values (${id}, ${wallet.toLowerCase()}, ${threshold})`;
  return id;
}

/** Binds a code to the chat that pressed Start. One chat, one wallet, one level: a repeat replaces the level. */
export async function link(code: string, chatId: string): Promise<{ wallet: Address; threshold: number } | { refused: string }> {
  await ensureTables();
  const [r] = (await pg!`
    select id, wallet, threshold from telegram_alerts
    where id = ${code} and chat_id is null and created_at > now() - interval '1 day'
  `) as { id: string; wallet: string; threshold: number }[];
  if (!r) return { refused: "That link has expired or was already used. Open mandatemarkets.com/alerts to make a new one, or send /watch 0x… here." };
  const done = await watch(chatId, r.wallet as Address, r.threshold);
  await pg!`delete from telegram_alerts where id = ${code}`;
  return done;
}

/** Watches a wallet for a chat directly, as `/watch 0x… 1.3` does. */
export async function watch(chatId: string, wallet: Address, threshold: number): Promise<{ wallet: Address; threshold: number } | { refused: string }> {
  await ensureTables();
  const w = wallet.toLowerCase();
  const [same] = (await pg!`select id from telegram_alerts where chat_id = ${chatId} and wallet = ${w} and stopped_at is null`) as { id: string }[];
  if (same) {
    await pg!`update telegram_alerts set threshold = ${threshold} where id = ${same.id}`;
    return { wallet, threshold };
  }
  const [{ n }] = (await pg!`select count(*)::int as n from telegram_alerts where chat_id = ${chatId} and stopped_at is null`) as { n: number }[];
  if (n >= PER_CHAT) return { refused: `You are already watching ${PER_CHAT} wallets. Send /stop to clear them, then add the ones you need.` };
  await pg!`insert into telegram_alerts (id, wallet, threshold, chat_id, linked_at) values (${randomBytes(12).toString("hex")}, ${w}, ${threshold}, ${chatId}, now())`;
  return { wallet, threshold };
}

/** The reading taken when a wallet is first watched, so the pass does not repeat what the welcome already said. */
export async function remember(chatId: string, wallet: Address, r: Reading): Promise<void> {
  if (r.state === "unread") return;
  const alerted = RANK[r.state] >= 1 ? new Date() : null;
  await pg!`
    update telegram_alerts set last_hf = ${r.hf}, last_state = ${r.state}, last_checked_at = now(), last_alert_at = ${alerted}
    where chat_id = ${chatId} and wallet = ${wallet.toLowerCase()} and stopped_at is null
  `;
}

export async function watching(chatId: string): Promise<{ wallet: Address; threshold: number }[]> {
  await ensureTables();
  const rows = (await pg!`select wallet, threshold from telegram_alerts where chat_id = ${chatId} and stopped_at is null order by linked_at`) as { wallet: string; threshold: number }[];
  return rows.map((r) => ({ wallet: r.wallet as Address, threshold: r.threshold }));
}

export async function stop(chatId: string): Promise<number> {
  await ensureTables();
  const rows = (await pg!`update telegram_alerts set stopped_at = now() where chat_id = ${chatId} and stopped_at is null returning id`) as { id: string }[];
  return rows.length;
}

export const parseWallet = (s: string): Address | null => (isAddress(s) ? (s as Address) : null);

// ------------------------------------------------------------------ the pass

/** Reads every watched wallet, longest-unchecked first, and says what changed. */
export async function checkAlerts(opts: { budgetMs: number }): Promise<string> {
  if (!pg) return "no database";
  if (!process.env.TELEGRAM_BOT_TOKEN) return "alerts are not switched on";
  await ensureTables();
  const started = Date.now();
  await pg`delete from telegram_alerts where chat_id is null and created_at < now() - interval '1 day'`;
  const due = (await pg`
    select id, wallet, threshold, chat_id, last_state, last_alert_at from telegram_alerts
    where chat_id is not null and stopped_at is null
    order by last_checked_at asc nulls first
    limit 60
  `) as Row[];
  const out = { checked: 0, sent: 0, blocked: 0 };
  const queue = [...due];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (;;) {
        if (Date.now() - started > opts.budgetMs) return;
        const r = queue.shift();
        if (!r) return;
        const reading = await readWallet(r.wallet as Address, r.threshold).catch(() => null);
        if (!reading || reading.state === "unread") continue;
        out.checked += 1;
        const say = decide(r.last_state, reading.state, r.last_alert_at ? new Date(r.last_alert_at).getTime() : null);
        let sent = false;
        if (say) {
          const m = message(say, r.wallet, r.threshold, reading);
          const result = await send(r.chat_id!, m.text, m.buttons);
          if (result === "blocked") {
            out.blocked += 1;
            await pg!`update telegram_alerts set stopped_at = now() where chat_id = ${r.chat_id} and stopped_at is null`;
            continue;
          }
          sent = result === "sent";
          if (sent) out.sent += 1;
        }
        // A message that did not go out leaves the old state, so the next pass tries it again.
        const kept = say && !sent ? r.last_state : reading.state;
        await pg!`
          update telegram_alerts set last_hf = ${reading.hf}, last_state = ${kept}, last_checked_at = now(),
            last_alert_at = ${sent ? new Date() : r.last_alert_at}
          where id = ${r.id}
        `;
      }
    }),
  );
  return `${out.checked} of ${due.length} checked, ${out.sent} alerts sent${out.blocked ? `, ${out.blocked} chats had blocked the bot` : ""}`;
}
