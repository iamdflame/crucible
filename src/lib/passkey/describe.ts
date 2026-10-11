/**
 * What a passkey wallet is being asked to sign, in words, for the person to
 * approve or refuse.
 *
 * A browser wallet app shows its own screen before it signs anything; a
 * passkey wallet has no app, so this is that screen. Every request is decoded
 * against the contracts this site's flows use (the ERC-8183 escrow on both
 * networks, the tokens it pays in, PancakeSwap's router); anything else is
 * named as unknown rather than guessed at. Pure, so each description is tested.
 */

import { decodeFunctionData, formatUnits, getAddress, parseAbi, type Address, type Hex } from "viem";
import { COMMERCE_ABI, ESCROW, ESCROW_TESTNET, ROUTER_ABI, TOKEN_ABI } from "@/lib/escrow/contracts";
import { PROTOCOLS } from "@/lib/config";
import { USDT, WBNB } from "@/lib/chain/valuation/prices";
import { USD1 } from "@/lib/x402";

export interface Described {
  /** One line: what it does. */
  title: string;
  /** The facts under it: whom it pays, how much, on which network. */
  lines: string[];
  /** True when nothing about it was recognised: the person should only approve it if they know why. */
  unknown?: boolean;
}

const NAMES: Record<string, string> = {
  [ESCROW.commerce.toLowerCase()]: "BNB Chain's ERC-8183 escrow",
  [ESCROW.router.toLowerCase()]: "the escrow's evaluator router",
  [ESCROW_TESTNET.commerce.toLowerCase()]: "BNB Chain's ERC-8183 escrow (testnet)",
  [ESCROW_TESTNET.router.toLowerCase()]: "the escrow's evaluator router (testnet)",
  [PROTOCOLS.pancakeSmartRouter.toLowerCase()]: "PancakeSwap's router",
};

const TOKENS: Record<string, string> = {
  [ESCROW.paymentToken.toLowerCase()]: "$U",
  [ESCROW_TESTNET.paymentToken.toLowerCase()]: "test $U",
  [USDT.toLowerCase()]: "USDT",
  [USD1.toLowerCase()]: "USD1",
  [WBNB.toLowerCase()]: "WBNB",
};

const ROUTER_SWAP_ABI = parseAbi(["function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)"]);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const nameOf = (a: string) => NAMES[a.toLowerCase()] ?? TOKENS[a.toLowerCase()] ?? short(a);
const tokenAmount = (token: string, amount: bigint) => `${formatUnits(amount, 18)} ${TOKENS[token.toLowerCase()] ?? `of token ${short(token)}`}`;
export const networkName = (chainId: number) => (chainId === 97 ? "BNB Smart Chain testnet (free test tokens)" : chainId === 56 ? "BNB Smart Chain" : `chain ${chainId}`);

/** A transaction, as the person approving it should read it. */
export function describeTx(tx: { to?: string | null; data?: Hex | null; value?: bigint | null }, chainId: number): Described {
  const to = tx.to ?? "";
  const value = tx.value ?? 0n;
  const net = `Network: ${networkName(chainId)}. Gas is paid in ${chainId === 97 ? "tBNB" : "BNB"} from this wallet.`;
  const sends = value > 0n ? [`Sends ${formatUnits(value, 18)} ${chainId === 97 ? "tBNB" : "BNB"} with it.`] : [];
  if (!to) return { title: "Deploy a contract", lines: [...sends, net], unknown: true };
  if (!tx.data || tx.data === "0x") return { title: `Send ${formatUnits(value, 18)} ${chainId === 97 ? "tBNB" : "BNB"} to ${short(to)}`, lines: [net] };
  const t = to.toLowerCase();
  try {
    if (t === ESCROW.commerce.toLowerCase() || t === ESCROW_TESTNET.commerce.toLowerCase()) {
      const d = decodeFunctionData({ abi: COMMERCE_ABI, data: tx.data });
      const a = d.args as readonly unknown[];
      if (d.functionName === "createJob") return { title: "Open a job in the escrow", lines: [`Agent paid on delivery: ${short(String(a[0]))}.`, `Description: ${String(a[3]).slice(0, 160)}`, ...sends, net] };
      if (d.functionName === "setBudget") return { title: `Set job #${String(a[0])}'s budget`, lines: [`Budget: ${formatUnits(a[1] as bigint, 18)}.`, net] };
      if (d.functionName === "fund") return { title: `Fund job #${String(a[0])}`, lines: [`Moves ${formatUnits(a[1] as bigint, 18)} into the escrow. The agent is paid when it delivers; if it does not, you reclaim it.`, net] };
      if (d.functionName === "claimRefund") return { title: `Reclaim job #${String(a[0])}'s budget`, lines: [net] };
      return { title: `Escrow: ${d.functionName}`, lines: [...sends, net] };
    }
    if (t === ESCROW.router.toLowerCase() || t === ESCROW_TESTNET.router.toLowerCase()) {
      const d = decodeFunctionData({ abi: ROUTER_ABI, data: tx.data });
      const a = d.args as readonly unknown[];
      if (d.functionName === "registerJob") return { title: `Bind job #${String(a[0])} to the dispute policy`, lines: ["So it can be settled, or refunded if the agent does not deliver.", net] };
      return { title: `Escrow router: ${d.functionName}`, lines: [net] };
    }
    if (TOKENS[t]) {
      const d = decodeFunctionData({ abi: TOKEN_ABI, data: tx.data });
      const a = d.args as readonly unknown[];
      if (d.functionName === "approve") return { title: `Allow ${nameOf(String(a[0]))} to take ${tokenAmount(t, a[1] as bigint)}`, lines: ["Exactly this amount, not an open-ended allowance.", net] };
      return { title: `${TOKENS[t]}: ${d.functionName}`, lines: [net] };
    }
    if (t === PROTOCOLS.pancakeSmartRouter.toLowerCase()) {
      decodeFunctionData({ abi: ROUTER_SWAP_ABI, data: tx.data });
      return { title: "Swap on PancakeSwap", lines: [`Pays at most ${formatUnits(value, 18)} BNB for the tokens this hire needs; unused BNB comes back.`, net] };
    }
  } catch {
    /* Not the function expected at that address: described as unknown below. */
  }
  try {
    const d = decodeFunctionData({ abi: TOKEN_ABI, data: tx.data });
    const a = d.args as readonly unknown[];
    if (d.functionName === "approve") return { title: `Allow ${nameOf(String(a[0]))} to take ${formatUnits(a[1] as bigint, 18)} of token ${short(to)}`, lines: [net], unknown: true };
  } catch {
    /* fall through */
  }
  return { title: `Call contract ${short(getAddress(to) as Address)}`, lines: [`Function ${tx.data.slice(0, 10)}, not one this site uses.`, ...sends, net], unknown: true };
}

/** A typed-data signature (EIP-712): a payment authorization is said as one. */
export function describeTyped(typed: { domain?: { name?: string; chainId?: number | string; verifyingContract?: string }; primaryType?: string; message?: Record<string, unknown> }): Described {
  const m = typed.message ?? {};
  const chain = Number(typed.domain?.chainId ?? 56);
  if (typed.primaryType === "TransferWithAuthorization" || typed.primaryType === "ReceiveWithAuthorization") {
    const token = String(typed.domain?.verifyingContract ?? "");
    const until = Number(m.validBefore ?? 0);
    return {
      title: `Authorize a payment of ${tokenAmount(token, BigInt(String(m.value ?? 0)))}`,
      lines: [`To: ${short(String(m.to ?? ""))}.`, until ? `Valid until ${new Date(until * 1000).toUTCString().slice(5, 25)} UTC.` : "", `Network: ${networkName(chain)}.`].filter(Boolean),
    };
  }
  if (typed.primaryType === "PermitWitnessTransferFrom" || typed.primaryType === "PermitTransferFrom") {
    const permitted = (m.permitted ?? {}) as { token?: string; amount?: string | number };
    return { title: `Authorize a payment of ${tokenAmount(String(permitted.token ?? ""), BigInt(String(permitted.amount ?? 0)))} through Permit2`, lines: [`Network: ${networkName(chain)}.`] };
  }
  return { title: `Sign ${typed.primaryType ?? "typed data"} for ${typed.domain?.name ?? "an unnamed app"}`, lines: [`Network: ${networkName(chain)}.`], unknown: true };
}

/** A plain message: shown as it is. */
export function describeMessage(text: string): Described {
  return { title: "Sign a message", lines: [text.length > 400 ? `${text.slice(0, 400)}…` : text] };
}
