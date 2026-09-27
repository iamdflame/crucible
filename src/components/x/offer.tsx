/**
 * What the hire drawer offers for one listing, decided by the hire law.
 *
 * Shared by the agent page and the quest, so an agent is offered exactly the
 * same way wherever a buyer meets it: a paid call only when it quoted a price
 * we can settle, a job only when it bids in the market, and a refusal with its
 * reason otherwise.
 */

import { formatUnits } from "viem";
import AgentArtwork from "@/components/x/AgentArtwork";
import { priceParts } from "@/components/x/Price";
import type { HireOffer } from "@/components/x/HireDrawer";
import { CATEGORY_LABEL } from "@/lib/config";
import type { Listing } from "@/lib/market/listing";
import { previewFor } from "@/lib/market/quotes";
import { hirePath } from "@/lib/market/hire-law";
import { SPONSORED } from "@/lib/market/sponsored-targets";
import { houseSlug } from "@/lib/market/performance";
import { inputsFor, kindOf, type CallInput } from "@/lib/market/inputs";
import { HOUSE_LEASHES } from "@/lib/chain/house";
import { allowedCalls, CANNOT } from "@/lib/chain/leash-words";
import { USDT, WBNB } from "@/lib/chain/leash";
import { HOUSE_BUDGET } from "@/lib/escrow/contracts";
import { providerFor } from "@/lib/escrow/jobs";

const TOKEN: Record<string, string> = { [USDT.toLowerCase()]: "USDT", [WBNB.toLowerCase()]: "WBNB" };

/**
 * What an agent on BNB's SDK is asked for, by job: its signed task is written
 * from these (lib/escrow/task.ts), so a wallet for the jobs about a wallet and
 * a sentence for the ones about a plan.
 */
function standardInputs(category: string | null): CallInput[] {
  if (category === "health-factor") return [{ name: "wallet", required: true, description: "the account whose Venus loan to read", kind: "wallet" }];
  if (category === "rebalancing") return [{ name: "wallet", required: true, description: "the owner of the PancakeSwap V3 positions", kind: "wallet" }];
  if (category === "grid-trading")
    return [
      { name: "lower", required: false, description: "lowest price for the grid, in USDT per BNB; blank sets 8% under the price now", kind: "text" },
      { name: "upper", required: false, description: "highest price, in USDT per BNB; blank sets 8% over", kind: "text" },
      { name: "capital", required: false, description: "USD to spread across the grid; blank is 1000", kind: "text" },
    ];
  if (category === "yield-optimisation") return [{ name: "task", required: false, description: "what to place and how much, e.g. 1000 USDT", kind: "text" }];
  return [{ name: "task", required: true, description: "what you want done, in a sentence", kind: "text" }];
}

/** What an outside escrow seller says it needs, as fields the drawer asks for. Optional where its own words say so. */
function needsAsInputs(needs: Record<string, string> | null): CallInput[] {
  return Object.entries(needs ?? {})
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(name))
    .slice(0, 8)
    .map(([name, description]) => ({ name, required: !/optional|defaults? to/i.test(description), description, kind: kindOf(name, description) }));
}

export function offerFor(l: Listing): HireOffer {
  const preview = previewFor(l.tokenId);
  const verdict = hirePath(l);
  const perCall = verdict.rails.find((r) => r.kind === "x402");
  const jobRail = verdict.rails.some((r) => r.kind === "mandate");
  const sponsor = verdict.ok ? SPONSORED[l.tokenId] : undefined;
  const slug = houseSlug(l.tokenId);
  const escrowRail = verdict.rails.some((r) => r.kind === "escrow");
  const outsideEscrow = escrowRail && !slug && l.escrowQuote ? l.escrowQuote : null;
  const leash = slug ? HOUSE_LEASHES.find((h) => h.slug === slug) : undefined;
  return {
    tokenId: l.tokenId,
    name: l.name,
    art: <AgentArtwork category={l.category} seed={`${l.tokenId}:${l.name}`} shape="square" />,
    categoryLabel: l.category ? CATEGORY_LABEL[l.category] : null,
    category: l.category,
    price: priceParts(l),
    latencyMs: l.probe?.answered ? (l.probe.latencyMs ?? null) : null,
    task: preview?.summary ?? l.quote?.description ?? (l.what ? l.what : `One call to ${l.name}`),
    x402:
      perCall && l.quote
        ? {
            path: SPONSORED[l.tokenId]?.url() ?? l.quote.endpoint,
            method: SPONSORED[l.tokenId]?.method ?? "GET",
            body: SPONSORED[l.tokenId]?.body,
            payTo: l.quote.payTo,
            network: l.quote.network,
            scheme: l.quote.scheme,
            asset: l.quote.asset,
            assetName: l.quote.assetName,
            header: l.quote.header,
            version: l.quote.x402Version,
            transferMethod: l.quote.transferMethod,
          }
        : null,
    // An escrow-only seller asks in its quote; everyone else in its 402 or our code.
    inputs: !perCall && outsideEscrow ? (outsideEscrow.kind === "sdk" ? standardInputs(l.category) : needsAsInputs(outsideEscrow.needs)) : inputsFor(l.tokenId, preview),
    job: jobRail
      ? {
          href: `/hire/${l.tokenId}`,
          can: leash ? allowedCalls(leash.calls).map((a) => a.words) : [],
          caps: leash ? leash.tokenSpend.map((t) => `${formatUnits(t.limit, 18)} ${TOKEN[t.token.toLowerCase()] ?? "tokens"} a day`) : [],
          cannot: CANNOT,
        }
      : null,
    // Our own agents take escrowed jobs from their own wallets; outside sellers, at the price they quoted.
    escrow: (() => {
      const p = escrowRail && slug ? providerFor(slug) : null;
      if (p) return { provider: p.owner, budget: HOUSE_BUDGET.toString(), tokenId: l.tokenId, name: l.name, outside: null };
      return outsideEscrow
        ? {
            provider: outsideEscrow.provider,
            budget: outsideEscrow.price,
            tokenId: l.tokenId,
            name: l.name,
            outside: { service: outsideEscrow.service, serviceName: outsideEscrow.serviceName, etaSeconds: outsideEscrow.etaSeconds, standard: outsideEscrow.kind === "sdk" },
          }
        : null;
    })(),
    sponsored: sponsor ? { asks: sponsor.asks, checkWith: sponsor.checkWith, takesSubject: sponsor.takesSubject, price: l.priceLabel } : null,
    refuse: verdict.ok ? null : verdict.reason,
    alternatives: l.category ? `/agents?category=${l.category}&hireable=1` : "/agents?hireable=1",
  };
}
