/**
 * What a builder typed into /check, read generously. Most builders do not
 * know their agent's ERC-8004 id by heart, but they have its page open
 * somewhere, its name, or the wallet that registered it; on 2 October, 53
 * people opened the check and five agents were checked. Each of these is
 * read the way a person would mean it.
 *
 *   341554, #341554                   the id
 *   0x… (40 hex)                      the wallet that owns it
 *   a link to its page                ours, 8004scan's, BscScan's: the last
 *                                     number in the path, or ?a= / ?id=
 *   a link to a wallet's page         that wallet
 *   anything else, 2 to 60 letters    its name
 */

export type CheckInput =
  | { kind: "empty" }
  | { kind: "id"; id: string }
  | { kind: "wallet"; wallet: string }
  | { kind: "name"; text: string }
  | { kind: "bad" };

const ID = /^\d{1,12}$/;
const WALLET = /^0x[0-9a-fA-F]{40}$/;

export function readCheckInput(raw: string): CheckInput {
  const t = raw.trim();
  if (!t) return { kind: "empty" };
  if (WALLET.test(t)) return { kind: "wallet", wallet: t };
  const bare = t.replace(/^#/, "");
  if (ID.test(bare)) return { kind: "id", id: bare };
  if (/^https?:\/\//i.test(t) || /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(t)) {
    let u: URL;
    try {
      u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
    } catch {
      return { kind: "bad" };
    }
    const segs = u.pathname.split("/").filter(Boolean);
    const num = [...segs].reverse().find((s) => ID.test(s));
    if (num) return { kind: "id", id: num };
    for (const k of ["a", "id", "q", "tokenId", "agentId"]) {
      const v = u.searchParams.get(k)?.trim() ?? "";
      if (ID.test(v)) return { kind: "id", id: v };
      if (WALLET.test(v)) return { kind: "wallet", wallet: v };
    }
    const addr = segs.find((s) => WALLET.test(s));
    if (addr) return { kind: "wallet", wallet: addr };
    return { kind: "bad" };
  }
  // A cut-short address is a mistake to point out, not a name to look up.
  if (/^0x[0-9a-f]*$/i.test(t)) return { kind: "bad" };
  if (t.length >= 2 && t.length <= 60 && /[a-z]/i.test(t)) return { kind: "name", text: t };
  return { kind: "bad" };
}
