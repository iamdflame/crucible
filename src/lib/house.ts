/**
 * The agents this office operates itself, and the wallets they act from.
 *
 * The register's top rungs were occupied by two bare addresses. They hold
 * mandates, settle epochs and get slashed, but they are not ERC-8004
 * identities, so the funnel had to say, in the product's own words, that "the
 * registry's population and the market's do not yet overlap at all". A
 * marketplace whose only bonded participants are outside the registry it
 * indexes is a studio with a directory attached.
 *
 * These wallets are registered as ERC-8004 identities so that the tokenId and
 * the holder are the same thing, and rung 5 counts registrations rather than
 * addresses.
 *
 * One identity per wallet, not one per office. 0xd6d11Aa5 holds mandates in
 * all four offices, and minting four registrations for it would have made rung
 * five read `4` for one participant, the same manufactured plurality this
 * register flags when one wallet holds forty-four BORT tokens. The card names
 * every office the wallet actually works in, and the count stays honest.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Category } from "@/lib/config";
import { SITE_HOST } from "@/lib/site";

export interface HouseAgent {
  /** URL segment and card identifier. */
  slug: string;
  name: string;
  description: string;
  /** The wallet it acts from. This is the mandate holder. */
  wallet: `0x${string}`;
  /** Offices it holds mandates in. Read from the book, not aspirational. */
  offices: Category[];
  /**
   * Its ERC-8004 token id, once registered.
   *
   * Absent until the registration lands. The site says "not yet registered"
   * rather than reserving a number, because a token id that does not exist is
   * the kind of claim this product exists to refuse.
   */
  tokenId: string | null;
}

export const HOUSE: HouseAgent[] = [
  {
    slug: "keeper-a",
    name: "MANDATE House Keeper A",
    description:
      `Operates mandates in four offices on BNB Smart Chain: grid trading, rebalancing, yield optimisation and health factor monitoring. It bids by escrowing its own capital, is settled hourly against a benchmark committed to chain before the outcome is known, and has been slashed. Its record, including the epochs it lost, is public at ${SITE_HOST} and re-derivable with npx mandate-verify.`,
    wallet: "0xd6d11Aa5046dc5C7BE8d63B9223b60D7AD94cBe9",
    offices: ["grid-trading", "rebalancing", "yield-optimisation", "health-factor"],
    tokenId: process.env.NEXT_PUBLIC_HOUSE_A_TOKEN_ID ?? null,
  },
  {
    slug: "keeper-b",
    name: "MANDATE House Keeper B",
    description:
      "Operates a grid trading mandate on BNB Smart Chain. It escrowed its own capital as a bond against a target it committed to, and is settled against a benchmark whose hash was on chain before the outcome was known. Its running alpha is negative and stays on the tape.",
    wallet: "0x090d19610cdb4d6bb011d9EB579910Ac3296BB0a",
    offices: ["grid-trading"],
    tokenId: process.env.NEXT_PUBLIC_HOUSE_B_TOKEN_ID ?? null,
  },
];

export const houseBySlug = (slug: string): HouseAgent | null =>
  HOUSE.find((h) => h.slug === slug) ?? null;

export const houseByWallet = (wallet: string): HouseAgent | null =>
  HOUSE.find((h) => h.wallet.toLowerCase() === wallet.toLowerCase()) ?? null;

/** Registered house agents, by token id, for joining the register to the book. */
export const houseByTokenId = (tokenId: string): HouseAgent | null =>
  HOUSE.find((h) => h.tokenId === tokenId) ?? null;

/**
 * The reference agents: one per category, each its own ERC-8004 identity.
 *
 * They act on the demo account through sessions its owner granted, and each
 * sells its work over x402. Each registration is owned by its own key, so four
 * agents are four identities and not one wallet counted four times. The token
 * ids come from `src/data/reference-agents.json`, written by
 * `src/scripts/register-reference.ts` when the registration landed.
 */
export interface ReferenceAgent {
  slug: "range-1" | "grid-1" | "yield-1" | "guard-1";
  name: string;
  category: Category;
  description: string;
  /** The environment variable holding the key that owns the registration. */
  keyEnv: string;
}

export const REFERENCE: ReferenceAgent[] = [
  {
    slug: "range-1",
    name: "Mandate Range-1",
    category: "rebalancing",
    keyEnv: "HOUSE_RANGE_KEY",
    description:
      "Recenters PancakeSwap V3 positions that have drifted out of range, through RecipientBound, a contract whose mint and collect have no recipient argument: the position and its tokens can only go back to their owner. Sells a position check and a recenter plan over x402 for 0.05 USD1.",
  },
  {
    slug: "grid-1",
    name: "Mandate Grid-1",
    category: "grid-trading",
    keyEnv: "HOUSE_GRID_KEY",
    description:
      "Trades a 25 basis point grid on PancakeSwap V3 WBNB/USDT 0.05% through SwapBound, which fixes the pair and pays only the principal. Its window, fills, win rate and drawdown, is read from the contract's own events, losses included. Sells the window and its next signal over x402 for 0.05 USD1.",
  },
  {
    slug: "yield-1",
    name: "Mandate Yield-1",
    category: "yield-optimisation",
    keyEnv: "HOUSE_YIELD_KEY",
    description:
      "Compares USDT supply rates on Venus and Aave at the current block and supplies only where the call credits the caller. Sells a wallet's idle cash and placement report over x402 for 0.05 USD1.",
  },
  {
    slug: "guard-1",
    name: "Mandate Guard-1",
    category: "health-factor",
    keyEnv: "HOUSE_GUARD_KEY",
    description:
      "Reads a Venus account's health factor with Venus's own oracle and repays the account's own debt under its trigger, through a session that cannot borrow. Sells a health factor report and repayment advice over x402 for 0.05 USD1.",
  },
];

export const referenceBySlug = (slug: string): ReferenceAgent | null => REFERENCE.find((r) => r.slug === slug) ?? null;

export interface ReferenceRegistration {
  tokenId: string;
  owner: `0x${string}`;
  tokenURI: string;
  tx: `0x${string}`;
  block: number;
}

/** Our agents' identities on BNB Smart Chain testnet, by slug, written by register-reference-testnet. Empty until it has run. */
export function referenceRegistrationsTestnet(): Record<string, ReferenceRegistration> {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "src/data/reference-agents-testnet.json"), "utf8")) as Record<string, ReferenceRegistration>;
  } catch {
    return {};
  }
}

/** Registrations that have landed, by slug. Empty until the script has run. */
export function referenceRegistrations(): Record<string, ReferenceRegistration> {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "src/data/reference-agents.json"), "utf8")) as Record<string, ReferenceRegistration>;
  } catch {
    return {};
  }
}
