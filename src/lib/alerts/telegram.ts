/**
 * The Telegram bot behind the free liquidation alerts.
 *
 * One token (TELEGRAM_BOT_TOKEN) switches it on; without it every caller is
 * told alerts are off rather than failing. The bot's own @name is read from
 * Telegram with that token, so there is nothing else to configure and the
 * site never links to a bot that is not ours.
 */

const API = "https://api.telegram.org";

export const alertsOn = () => Boolean(process.env.TELEGRAM_BOT_TOKEN);

async function call<T>(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: T; error_code?: number; description?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, description: "alerts are not switched on" };
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return (await res.json().catch(() => ({ ok: false, description: `Telegram answered ${res.status}` }))) as { ok: boolean; result?: T; error_code?: number; description?: string };
}

let name: { at: number; value: string | null } | null = null;
/** The bot's username, without the @, read from Telegram once an hour. */
export async function botName(): Promise<string | null> {
  if (!alertsOn()) return null;
  if (name && Date.now() - name.at < 3_600_000) return name.value;
  const r = await call<{ username?: string }>("getMe", {}).catch(() => null);
  name = { at: Date.now(), value: r?.ok ? (r.result?.username ?? null) : null };
  return name.value;
}

export interface Button {
  text: string;
  url: string;
}

/**
 * Sends one message. Returns "blocked" when the person has stopped or blocked
 * the bot, so their alerts can be ended instead of retried forever.
 */
export async function send(chatId: string, text: string, buttons: Button[] = []): Promise<"sent" | "blocked" | "failed"> {
  const r = await call("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(buttons.length ? { reply_markup: { inline_keyboard: buttons.map((b) => [b]) } } : {}),
  }).catch(() => null);
  if (r?.ok) return "sent";
  return r?.error_code === 403 ? "blocked" : "failed";
}

/** Points Telegram at our webhook, with the secret it must send back on every update. */
export async function setWebhook(url: string, secret: string) {
  return call("setWebhook", { url, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: true });
}

export async function setCommands() {
  return call("setMyCommands", {
    commands: [
      { command: "watch", description: "Watch a wallet: /watch 0x... 1.3" },
      { command: "list", description: "The wallets you are watching, with their health factor now" },
      { command: "stop", description: "Stop every alert" },
      { command: "help", description: "What this bot does" },
    ],
  });
}
