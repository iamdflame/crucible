/**
 * One confirmation instead of five, where the buyer's wallet can batch.
 *
 * EIP-5792 lets a wallet take several calls and send them as one atomic
 * transaction: MetaMask does it by upgrading the account under EIP-7702,
 * smart wallets through their own account. The escrow's five steps (open,
 * bind, budget, approve, fund) go as one batch naming the job number it will
 * get, jobCounter() + 1, behind a swap of BNB for the $U the buyer is short
 * of when they pay in BNB (lib/escrow/pay-with-bnb). If somebody else's job
 * takes that number first, the
 * budget and fund calls are refused (the kernel answers Unauthorized to
 * anyone but a job's client, checked on chain 27 Sep) and, the batch being
 * atomic, nothing at all happens; the buyer presses again.
 *
 * A wallet that cannot batch is never asked to: the five-step flow runs.
 */

import type { Address, Hash, Hex } from "viem";
import { readableError } from "@/lib/chain/wallet";

type Request = (a: { method: string; params?: unknown[] }) => Promise<unknown>;
const request = (): Request | null => {
  const eth = typeof window === "undefined" ? undefined : window.ethereum;
  return eth ? ((eth as unknown as { request: Request }).request.bind(eth) as Request) : null;
};

/** Thrown when the wallet will not take a batch at all, so the caller falls back to the steps. */
export class NotBatchable extends Error {}

/** Whether this wallet sends atomic batches on BNB Smart Chain. Asked only once a wallet is connected. */
export async function canBatch(address: Address): Promise<boolean> {
  const req = request();
  if (!req) return false;
  try {
    const caps = (await req({ method: "wallet_getCapabilities", params: [address, ["0x38"]] })) as Record<string, { atomic?: { status?: string }; atomicBatch?: { supported?: boolean } }> | null;
    const c = caps?.["0x38"] ?? caps?.["56"];
    const status = c?.atomic?.status ?? (c?.atomicBatch?.supported ? "supported" : null);
    // "ready" is a wallet that will upgrade the account when the buyer agrees, in the same confirmation.
    return status === "supported" || status === "ready";
  } catch {
    return false;
  }
}

/** Status codes as EIP-5792 v2 defines them, from either the number or the older word. */
function statusCode(s: unknown): number {
  if (typeof s === "number") return s;
  if (s === "CONFIRMED") return 200;
  if (s === "PENDING") return 100;
  return 0;
}

/**
 * Sends the calls as one atomic batch and waits for it on chain. Returns the
 * transaction that carried it. A refusal, a revert or a timeout is thrown as
 * a sentence; a wallet that turns the method down is thrown as NotBatchable.
 */
export async function sendBatch(address: Address, calls: { to: Address; data: Hex; value?: bigint }[], onSent?: () => void): Promise<Hash> {
  const req = request();
  if (!req) throw new NotBatchable("no wallet");
  let id: string;
  try {
    const res = (await req({
      method: "wallet_sendCalls",
      params: [{ version: "2.0.0", chainId: "0x38", from: address, atomicRequired: true, calls: calls.map((c) => ({ to: c.to, data: c.data, value: `0x${(c.value ?? 0n).toString(16)}` })) }],
    })) as string | { id: string };
    id = typeof res === "string" ? res : res.id;
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === 4001) throw new Error(readableError(e));
    // Method unknown, atomicity or this chain unsupported, or anything else before sending: the steps will do.
    throw new NotBatchable((e as Error).message);
  }
  onSent?.();
  for (let i = 0; i < 120; i++) {
    await new Promise((ok) => setTimeout(ok, 2_000));
    const st = (await req({ method: "wallet_getCallsStatus", params: [id] }).catch(() => null)) as { status?: unknown; receipts?: { transactionHash?: Hash; status?: string }[] } | null;
    if (!st) continue;
    const code = statusCode(st.status);
    if (code >= 400) {
      throw new Error(
        code >= 500
          ? "The batch was undone on chain, so nothing moved: most likely another job took its number in the same moment. Press again."
          : "The wallet could not send the batch, so nothing moved.",
      );
    }
    const hash = st.receipts?.at(-1)?.transactionHash;
    if (code === 200 && hash) return hash;
  }
  throw new Error("The wallet has not reported the batch confirmed after four minutes. Check My Desk before trying again.");
}
