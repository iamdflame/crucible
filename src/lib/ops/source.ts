/**
 * Where a visit came from, filed one way on the server (lib/ops/arrivals) and
 * in the browser (lib/ops/funnel-client): an ad's utm tags first, then the
 * referring site, then direct. Pure, so both ends agree and tests can say so.
 */

const clean = (v: string | string[] | null | undefined) => (Array.isArray(v) ? v[0] : v)?.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 40) || null;

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
