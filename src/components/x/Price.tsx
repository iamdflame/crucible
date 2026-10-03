import type { Listing } from "@/lib/market/listing";
import type { Rail } from "@/lib/market/hire-law";
import { tokenAmount } from "@/lib/market/listing";

/**
 * A price that looks like a price.
 *
 * Buyers compare prices at a glance, so the figure is large and in dollars
 * whenever the agent charges in a dollar stablecoin. The exact token amount it
 * quoted sits underneath, because "$0.05" is a convenience and "0.05 USDT" is
 * the fact. Anything we cannot express in dollars keeps the seller's own unit,
 * and an agent that has not published a price says so rather than looking free.
 */

export function usd(n: number): string {
  // At least two decimals, and more only when a real small charge needs them,
  // so $0.005 never rounds down to a price that looks like nothing.
  const exact = n.toFixed(4).replace(/0+$/, "");
  const decimals = exact.split(".")[1]?.length ?? 0;
  return `$${n.toFixed(Math.max(2, decimals))}`;
}

/**
 * A price, as opposed to any dollar figure: nothing reads "$0.00". A quote of
 * zero is free, and one too small to show in four decimals (a seller once
 * priced a job at one base unit of $U) says so instead of rounding to nothing.
 */
export function priceUsd(n: number): string {
  if (n === 0) return "Free";
  if (n > 0 && n < 0.0001) return "<$0.0001";
  return usd(n);
}

export interface PriceParts {
  /** The big figure. */
  value: string | null;
  /** "/ call" when there is a figure. */
  unit: string | null;
  /** The exact quote, small: "0.05 USDT". */
  exact: string | null;
  /** Why there is no figure, when there is not. */
  none: string | null;
}

/**
 * The price parts. Given the rail Hire will use, the price is that rail's: an
 * escrowed job is paid in $U whatever token the agent's own 402 names, so a
 * card that leads with the job must not show the per-call token beside it.
 */
export function priceParts(
  l: Pick<Listing, "usdPrice" | "priceLabel" | "declaresPayment"> & Partial<Pick<Listing, "quote" | "escrowQuote">>,
  rail?: Rail | null,
): PriceParts {
  if (rail?.kind === "escrow") return { value: priceUsd(Number(rail.wei) / 1e18), unit: "/ job", exact: `${tokenAmount(rail.wei)} $U`, none: null };
  // A seller that only takes escrowed jobs is priced per job, not per call.
  const unit = !l.quote && l.escrowQuote && !l.escrowQuote.unpayable ? "/ job" : "/ call";
  if (l.usdPrice !== null && l.usdPrice !== undefined) return { value: priceUsd(l.usdPrice), unit, exact: l.priceLabel, none: null };
  if (l.priceLabel) return { value: l.priceLabel, unit, exact: null, none: null };
  if (l.declaresPayment) return { value: null, unit: null, exact: null, none: "Paid, price not read yet" };
  return { value: null, unit: null, exact: null, none: "No price published" };
}

export default function Price({
  l,
  size = "md",
  from = false,
  rail,
  on,
}: {
  l: Pick<Listing, "usdPrice" | "priceLabel" | "declaresPayment"> & Partial<Pick<Listing, "quote" | "escrowQuote">>;
  size?: "sm" | "md" | "lg";
  /** For summaries across several agents: "From $0.02". */
  from?: boolean;
  /** The payment rail, shown next to the exact amount. */
  rail?: string | null;
  /** The rail Hire uses, whose price this shows. */
  on?: Rail | null;
}) {
  const p = priceParts(l, on);
  if (!p.value) {
    return (
      <span className={`x-price x-price--${size} x-price--none`}>
        <span className="x-price__none">{p.none}</span>
      </span>
    );
  }
  const sub = [p.exact, rail].filter(Boolean).join(" · ");
  return (
    <span className={`x-price x-price--${size}`} title="Read from the agent's own payment response">
      <span className="x-price__main">
        {from ? <span className="x-price__from">From</span> : null}
        <span className="x-price__v">{p.value}</span>
        <span className="x-price__u">{p.unit}</span>
      </span>
      {sub ? <span className="x-price__sub x-mono">{sub}</span> : null}
    </span>
  );
}
