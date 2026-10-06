/**
 * The ERC-8004 Identity Registry, read from the chain rather than from an index.
 *
 * Every registry figure on this site came through 8004scan, and that is a
 * dependency the product's own thesis will not survive. Three things it does:
 *
 *   It does not have our own registration. Token 336161 was minted at block
 *   120,148,918 and the index answers `Agent not found on chain 56` for it, so
 *   the assay office could not read its own entry.
 *
 *   It returns `DATABASE_ERROR` several times an hour, which is why the front
 *   door's registered count was being served out of a file.
 *
 *   It is lossy. It holds `name: "Agent #269703", description: null` for a
 *   token whose `tokenURI` resolves to a full manifest with a category, a
 *   safety envelope and a live x402 endpoint.
 *
 * The registry is an ERC-721 and the chain answers all three questions itself:
 * `ownerOf` says who holds the identity, `tokenURI` says where the card is,
 * and the card says what the agent claims to be. That read costs two calls
 * against a public node, needs no key, cannot be rate-limited away, and is the
 * same source anyone verifying us would use.
 *
 * `totalSupply` is not among them, this registry does not implement
 * ERC721Enumerable, so the population count still comes from an index and is
 * still stamped as such. Everything about an *individual* agent comes from
 * here.
 */

import { createPublicClient, http, type Address } from "viem";
import { bsc } from "viem/chains";
import { CHAIN_ID, IDENTITY_REGISTRY, RPC_FALLBACKS, RPC_URL } from "@/lib/config";
import { memo } from "@/lib/cache";
import { safeFetch } from "@/lib/net/safe-fetch";

const ERC721 = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "string" }],
  },
] as const;

const clients = [RPC_URL, ...RPC_FALLBACKS].map((url) =>
  createPublicClient({ chain: bsc, transport: http(url, { timeout: 8_000 }) }),
);

/** A service the card advertises, normalised across the shapes in the wild. */
export interface CardService {
  name: string;
  endpoint: string;
}

export interface RegistryEntry {
  chainId: number;
  tokenId: string;
  /** Holder of the ERC-721. The identity's owner, from `ownerOf`. */
  owner: Address;
  /** Whatever `tokenURI` returned, verbatim. */
  tokenURI: string;
  /** How the card was obtained: inline in the URI, or fetched over HTTP. */
  cardSource: "data-uri" | "http" | "unresolved";
  name: string | null;
  description: string | null;
  image: string | null;
  services: CardService[];
  /** The category the card claims, in its own words. Never trusted as ours. */
  claimedCategory: string | null;
  /** An x402 endpoint the card advertises, if it names one. */
  x402Endpoint: string | null;
  /** The card as parsed, for anything this shape does not model. */
  card: Record<string, unknown> | null;
  /** Why the card did not resolve, when it did not. */
  cardError: string | null;
  /** Block the identity was read at. */
  blockNumber: string | null;
  at: string;
}

/**
 * Tries each provider in turn.
 *
 * A single free BSC endpoint refuses often enough that one attempt is not a
 * read, and a registry page that 404s because a node was busy is indisputably
 * worse than one that waits half a second.
 */
async function anyClient<T>(fn: (c: (typeof clients)[number]) => Promise<T>): Promise<T | null> {
  for (const c of clients) {
    try {
      return await fn(c);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The card behind a `tokenURI`.
 *
 * Three encodings appear on this registry: base64 data URIs (which our own
 * registration uses, and which are self-contained), plain data URIs, and HTTP
 * URLs (which every Agripinaa token uses). The HTTP fetch is bounded and its
 * failure is recorded rather than swallowed: an agent whose card is a dead
 * link and an agent with no card are different findings.
 */
async function readCard(
  uri: string,
): Promise<{ card: Record<string, unknown> | null; source: RegistryEntry["cardSource"]; error: string | null }> {
  if (!uri) return { card: null, source: "unresolved", error: "The registration carries no tokenURI." };

  if (uri.startsWith("data:")) {
    try {
      const comma = uri.indexOf(",");
      const meta = uri.slice(5, comma);
      const payload = uri.slice(comma + 1);
      const json = meta.includes("base64")
        ? Buffer.from(payload, "base64").toString("utf8")
        : decodeURIComponent(payload);
      return { card: JSON.parse(json) as Record<string, unknown>, source: "data-uri", error: null };
    } catch {
      return { card: null, source: "unresolved", error: "The inline card is not parseable JSON." };
    }
  }

  /*
    IPFS is a scheme, not a host, so it needs a gateway.

    Skipping it was a real under-reading rather than a missing nicety: a
    forty-four token cluster came back with no name and no description, which
    reads as forty-four blank registrations and is in fact one unsupported URI
    scheme. Publishing that as a finding about those agents would have been the
    precise failure this product exists to catch, committed by us.

    Two gateways, tried in order, because one refusing is not the card being
    absent either.
  */
  const urls = uri.startsWith("ipfs://")
    ? IPFS_GATEWAYS.map((g) => g + uri.slice("ipfs://".length).replace(/^ipfs\//, ""))
    : /^https?:\/\//i.test(uri)
      ? [uri]
      : [];

  if (urls.length === 0) {
    return { card: null, source: "unresolved", error: `The tokenURI scheme is not one we fetch: ${uri.slice(0, 32)}` };
  }

  let last = "The card URL did not answer.";
  for (const url of urls) {
    try {
      // The tokenURI is whatever the registrant wrote, so it goes through the same guard as an endpoint.
      const res = await safeFetch(url, { headers: { accept: "application/json" }, timeoutMs: 6_000, maxBytes: 512 * 1024 });
      if (res.status < 200 || res.status >= 300) {
        last = `The card URL answered ${res.status}.`;
        continue;
      }
      return { card: JSON.parse(res.text) as Record<string, unknown>, source: "http", error: null };
    } catch {
      last = "The card URL did not answer.";
    }
  }
  return { card: null, source: "unresolved", error: last };
}

/**
 * Gateways for `ipfs://` cards.
 *
 * Two, so that one gateway being slow is not recorded as an agent having no
 * card. Both are public and neither is ours, which is the point: a reader
 * checking this can use any gateway they like and get the same bytes, because
 * the CID is in the registration.
 */
const IPFS_GATEWAYS = ["https://ipfs.io/ipfs/", "https://cloudflare-ipfs.com/ipfs/"];

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/**
 * Services, out of the several shapes cards use for them.
 *
 * ERC-8004's registration-v1 uses `services: [{name, endpoint}]`. Others put a
 * single endpoint under `x402.endpoint`, or name `a2a`/`mcp` at the top level.
 * All of them are somebody's claim about where the agent answers; none of them
 * are evidence that it does, and nothing here upgrades a rung.
 */
export function readServices(card: Record<string, unknown> | null): CardService[] {
  if (!card) return [];
  const out: CardService[] = [];

  const raw = card.services;
  if (Array.isArray(raw)) {
    for (const s of raw) {
      if (!s || typeof s !== "object") continue;
      const o = s as Record<string, unknown>;
      const endpoint = str(o.endpoint) ?? str(o.url);
      const name = str(o.name) ?? str(o.type);
      if (endpoint) out.push({ name: name ?? "service", endpoint });
    }
  }

  const x402 = card.x402;
  if (x402 && typeof x402 === "object") {
    const e = str((x402 as Record<string, unknown>).endpoint);
    if (e) out.push({ name: "x402", endpoint: e });
  }

  for (const key of ["a2a_endpoint", "agent_url", "mcp_server", "endpoint", "url"]) {
    const e = str(card[key]);
    if (e) out.push({ name: key, endpoint: e });
  }

  /*
    Same endpoint under two names is one service, named for the protocol it
    speaks when one of its names says so: a card listing one URL as "web" and
    as "A2A" used to keep "web", and was never called as an agent (6 Oct).
  */
  const PROTOCOL = /^(a2a|mcp|x402)$/i;
  const byEndpoint = new Map<string, CardService>();
  for (const s of out) {
    const had = byEndpoint.get(s.endpoint);
    if (!had || (!PROTOCOL.test(had.name) && PROTOCOL.test(s.name))) byEndpoint.set(s.endpoint, s);
  }
  return [...byEndpoint.values()];
}

async function readEntryUncached(chainId: number, tokenId: string): Promise<RegistryEntry | null> {
  if (!/^\d{1,20}$/.test(tokenId)) return null;
  const id = BigInt(tokenId);

  const owner = await anyClient((c) =>
    c.readContract({
      address: IDENTITY_REGISTRY as Address,
      abi: ERC721,
      functionName: "ownerOf",
      args: [id],
    }),
  );

  // `ownerOf` reverts for a token that was never minted. That is the whole
  // existence test, and it is the registry's own answer rather than an index's.
  if (!owner) return null;

  const [uri, blockNumber] = await Promise.all([
    anyClient((c) =>
      c.readContract({
        address: IDENTITY_REGISTRY as Address,
        abi: ERC721,
        functionName: "tokenURI",
        args: [id],
      }),
    ),
    anyClient((c) => c.getBlockNumber()),
  ]);

  const { card, source, error } = await readCard(uri ?? "");

  return {
    chainId,
    tokenId,
    owner: owner as Address,
    tokenURI: uri ?? "",
    cardSource: source,
    name: str(card?.name),
    description: str(card?.description),
    image: str(card?.image) ?? str(card?.image_url),
    services: readServices(card),
    claimedCategory: str(card?.category),
    x402Endpoint:
      readServices(card).find((s) => s.name === "x402")?.endpoint ?? null,
    card,
    cardError: error,
    blockNumber: blockNumber ? blockNumber.toString() : null,
    at: new Date().toISOString(),
  };
}

/**
 * One agent's identity, from the chain.
 *
 * Memoised for a minute: a certificate page reads this, and the assay running
 * on the same page reads it again for the same token in the same request.
 */
export function readRegistryEntry(
  tokenId: string,
  chainId = CHAIN_ID,
): Promise<RegistryEntry | null> {
  return memo(
    `registry-entry:${chainId}:${tokenId}`,
    { freshMs: 60_000, staleMs: 10 * 60_000 },
    () => readEntryUncached(chainId, tokenId),
  );
}
