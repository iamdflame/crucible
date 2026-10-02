/**
 * How people reach the Set and Earn pages, counted per day: from which ad
 * (its utm tags), which site (the referrer's host), or directly. Counts only,
 * kept in our own database: no cookie, no address, nothing about who came,
 * which is what the site's analytics promise. Link previewers and crawlers
 * are left out, so a count is a person following a link.
 */

import { after } from "next/server";
import { headers } from "next/headers";
import { sql as pg } from "@/lib/db/client";
import { ensureTables } from "@/lib/db/tables";

const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|quora link|whatsapp|telegram|discord|vercel|curl|wget|python|node-fetch|headless/i;
const clean = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 40) || null;

/** The source an arrival is filed under: utm tags first, then the referring host, then direct. Pure, for tests. */
export function sourceOf(sp: Record<string, string | string[] | undefined>, referer: string | null, host: string): string {
  const src = clean(sp.utm_source);
  if (src) return [src, clean(sp.utm_medium), clean(sp.utm_campaign), clean(sp.utm_content)].filter(Boolean).join("/");
  if (referer) {
    try {
      const r = new URL(referer).host.replace(/^www\./, "");
      if (r && r !== host.replace(/^www\./, "")) return r === "t.co" ? "x.com" : r;
      return "internal";
    } catch {
      /* fall through */
    }
  }
  return "direct";
}

/** Counts this request as an arrival at `path`, after the page has been sent. */
export async function countArrival(path: string, sp: Record<string, string | string[] | undefined>): Promise<void> {
  if (!pg) return;
  const h = await headers();
  if (BOT.test(h.get("user-agent") ?? "") || h.get("purpose") === "prefetch" || h.get("next-router-prefetch")) return;
  const source = sourceOf(sp, h.get("referer"), h.get("host") ?? "");
  try {
    after(async () => {
      await ensureTables();
      await pg!`insert into arrivals (day, path, source, n) values (current_date, ${path}, ${source}, 1) on conflict (day, path, source) do update set n = arrivals.n + 1`.catch(() => undefined);
    });
  } catch {
    /* outside a request: nothing to count */
  }
}

/** Marks an agent as checked today. */
export async function countCheck(tokenId: string): Promise<void> {
  if (!pg) return;
  await ensureTables();
  await pg`insert into checks_daily (day, token_id) values (current_date, ${tokenId}) on conflict do nothing`.catch(() => undefined);
}
