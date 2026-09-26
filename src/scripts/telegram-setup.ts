/**
 * Points the alerts bot at this site. Run once after TELEGRAM_BOT_TOKEN and
 * TELEGRAM_WEBHOOK_SECRET are set, and again if either changes.
 *
 *   npm run telegram-setup
 *
 * Telegram then sends every message the bot receives to /api/telegram/webhook
 * with the secret in a header, which the route checks before reading it.
 */

import { botName, setCommands, setWebhook } from "@/lib/alerts/telegram";
import { SITE } from "@/lib/site";

async function main() {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!process.env.TELEGRAM_BOT_TOKEN || !secret) throw new Error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET first.");
  const bot = await botName();
  if (!bot) throw new Error("Telegram did not recognise the token.");
  const url = `${SITE}/api/telegram/webhook`;
  const hook = await setWebhook(url, secret);
  const cmds = await setCommands();
  console.log(`@${bot}: webhook ${hook.ok ? "set" : `refused (${hook.description})`} to ${url}; commands ${cmds.ok ? "set" : `refused (${cmds.description})`}`);
  if (!hook.ok || !cmds.ok) process.exit(1);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
