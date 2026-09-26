/**
 * What Telegram sends when someone writes to the alerts bot.
 *
 *   POST /api/telegram/webhook   (from Telegram only: it must carry our secret)
 *
 * /start <code> binds the wallet chosen on mandatemarkets.com/alerts to this
 * chat; /watch 0x… 1.3 does the same from inside Telegram; /list reads every
 * watched wallet now; /stop ends every alert. Telegram retries anything that
 * is not a 200, so a failure is answered in the chat and acknowledged here.
 */

import { NextResponse } from "next/server";
import { send } from "@/lib/alerts/telegram";
import { describe, link, message, MAX_THRESHOLD, MIN_THRESHOLD, parseWallet, readWallet, remember, stop, validThreshold, watch, watching } from "@/lib/alerts/watch";
import { SITE, SITE_HOST } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const DEFAULT_LEVEL = 1.3;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const HELP = [
  "I watch Venus loans on BNB Smart Chain and message you before one can be liquidated. It is free, and nothing here can move your funds.",
  "",
  `/watch 0x… 1.3  watch a wallet; 1.3 is the health factor that wakes you (${MIN_THRESHOLD} to ${MAX_THRESHOLD})`,
  "/list  what you watch, with each health factor now",
  "/stop  end every alert",
  "",
  `Or set it up at ${SITE_HOST}/alerts`,
].join("\n");

async function welcome(chatId: string, wallet: `0x${string}`, threshold: number) {
  const r = await readWallet(wallet, threshold).catch(() => null);
  if (r) await remember(chatId, wallet, r).catch(() => undefined);
  const now = r ? describe(r) : "Venus could not be read just now";
  const low = r && (r.state === "low" || r.state === "danger" || r.state === "liquidatable");
  const warn = low ? `\n\n${message("worse", wallet, threshold, r!).text}` : "";
  await send(
    chatId,
    `Watching ${short(wallet)} on Venus. You will get a message here if its health factor falls below ${threshold.toFixed(2)}.\nRight now: ${now}.${warn}\n\nSend /list to see what you watch, /stop to end every alert.`,
    low ? message("worse", wallet, threshold, r!).buttons : [],
  );
}

export async function POST(request: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  let update: { message?: { chat?: { id?: number | string }; text?: string } };
  try {
    update = await request.json();
  } catch {
    return NextResponse.json({ ok: true });
  }
  const chatId = update.message?.chat?.id;
  const text = (update.message?.text ?? "").trim();
  if (chatId === undefined || !text) return NextResponse.json({ ok: true });
  const chat = String(chatId);
  const [command, ...args] = text.split(/\s+/);
  const cmd = command.toLowerCase().replace(/@.*$/, "");

  try {
    if (cmd === "/start" && args[0]) {
      const r = await link(args[0], chat);
      if ("refused" in r) await send(chat, r.refused);
      else await welcome(chat, r.wallet, r.threshold);
    } else if (cmd === "/watch") {
      const wallet = parseWallet(args[0] ?? "");
      const level = args[1] === undefined ? DEFAULT_LEVEL : Number(args[1]);
      if (!wallet) await send(chat, `Send the wallet to watch, like this:\n/watch 0x1234… 1.3`);
      else if (!validThreshold(level)) await send(chat, `The level is the health factor that wakes you, from ${MIN_THRESHOLD} to ${MAX_THRESHOLD}. For example: /watch ${short(wallet)} 1.3`);
      else {
        const r = await watch(chat, wallet, level);
        if ("refused" in r) await send(chat, r.refused);
        else await welcome(chat, r.wallet, r.threshold);
      }
    } else if (cmd === "/list") {
      const all = await watching(chat);
      if (!all.length) await send(chat, `You are not watching any wallet. Send /watch 0x… 1.3, or set it up at ${SITE_HOST}/alerts`);
      else {
        const lines = await Promise.all(all.map(async (w) => `${short(w.wallet)}, below ${w.threshold.toFixed(2)}: ${describe(await readWallet(w.wallet, w.threshold).catch(() => ({ state: "unread" as const, hf: null, collateralUsd: null, debtUsd: null, shortfallUsd: 0 })))}`));
        await send(chat, `You are watching:\n${lines.join("\n")}`);
      }
    } else if (cmd === "/stop") {
      const n = await stop(chat);
      await send(chat, n ? `Stopped ${n} ${n === 1 ? "alert" : "alerts"}. Nothing more will be sent. Send /watch 0x… to start again.` : "You had no alerts running.");
    } else {
      await send(chat, HELP, [{ text: "Set up alerts on the site", url: `${SITE}/alerts` }]);
    }
  } catch {
    await send(chat, "Something went wrong on our side. Try again in a minute.").catch(() => undefined);
  }
  return NextResponse.json({ ok: true });
}
