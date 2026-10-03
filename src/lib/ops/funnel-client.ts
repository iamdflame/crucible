/**
 * The browser's half of the hire funnel: where this visit came from, noted
 * once when it lands, and a count sent when a visitor opens a hire, tries an
 * agent free, or pays. Counts only, the same as arrivals: no cookie, no
 * address, nothing about who it is.
 */

import { sourceOf } from "@/lib/ops/source";

const KEY = "landing:source";
type Step = "open" | "try" | "funded" | "paid";

/** Notes the visit's source on its first page; later pages keep it. */
export function rememberLanding(): void {
  try {
    if (sessionStorage.getItem(KEY)) return;
    sessionStorage.setItem(KEY, sourceOf(Object.fromEntries(new URLSearchParams(window.location.search)), document.referrer || null, window.location.host));
  } catch {
    /* No storage: its steps are filed as unknown. */
  }
}

export function track(step: Step, tokenId: string): void {
  let source = "unknown";
  try {
    source = sessionStorage.getItem(KEY) ?? "unknown";
  } catch {
    /* unknown */
  }
  const body = JSON.stringify({ step, tokenId, source });
  try {
    if (navigator.sendBeacon?.("/api/v1/funnel", new Blob([body], { type: "application/json" }))) return;
  } catch {
    /* fall back to fetch */
  }
  void fetch("/api/v1/funnel", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => undefined);
}
