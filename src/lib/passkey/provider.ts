/**
 * The passkey wallet as an EIP-1193 provider, so every flow on the site (the
 * packs, a hire's five steps, a paid call's signature) uses it exactly as it
 * uses a browser wallet, without knowing the difference.
 *
 * It holds the key in memory for this tab only and signs nothing without the
 * person's approval: every transaction, typed-data signature and message is
 * described in words (describe.ts) and waits for "Approve". It moves only
 * between BNB Smart Chain and its testnet, refuses `eth_sign` (a blind
 * signature over raw bytes), and passes only read methods to the network.
 */

import { createPublicClient, createWalletClient, hexToString, http, isHex, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { bsc, bscTestnet } from "viem/chains";
import { describeMessage, describeTx, describeTyped, type Described } from "./describe";

export type Confirm = (d: Described, kind: "transaction" | "signature") => Promise<boolean>;

const CHAINS = { 56: bsc, 97: bscTestnet } as const;
const RPC: Record<56 | 97, string> = { 56: "https://bsc-dataseed.bnbchain.org", 97: "https://bsc-testnet-rpc.publicnode.com" };

const READS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
]);

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface PasskeyProvider {
  isMandatePasskey: true;
  address: Hex;
  request(a: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on(event: string, handler: (v: unknown) => void): void;
  removeListener(event: string, handler: (v: unknown) => void): void;
  /** Forgets the key: every later request is refused as from a locked wallet. */
  lock(): void;
}

export function passkeyProvider(key: Hex, confirm: Confirm, opts: { rpc?: Partial<Record<56 | 97, string>> } = {}): PasskeyProvider {
  let account: PrivateKeyAccount | null = privateKeyToAccount(key);
  const address = account.address;
  let chainId: 56 | 97 = 56;
  const listeners: Record<string, ((v: unknown) => void)[]> = {};
  const emit = (e: string, v: unknown) => (listeners[e] ?? []).forEach((f) => f(v));
  const readers = new Map<number, PublicClient>();
  const rpc = (id: 56 | 97) => opts.rpc?.[id] ?? RPC[id];
  const reader = () => {
    let r = readers.get(chainId);
    if (!r) {
      r = createPublicClient({ chain: CHAINS[chainId], transport: http(rpc(chainId)) }) as PublicClient;
      readers.set(chainId, r);
    }
    return r;
  };
  const signer = () => {
    if (!account) throw new RpcError(4100, "The passkey wallet is locked. Unlock it with your passkey.");
    return account;
  };
  const approve = async (d: Described, kind: "transaction" | "signature") => {
    if (!(await confirm(d, kind))) throw new RpcError(4001, "You refused it in your passkey wallet.");
  };

  const request = async ({ method, params }: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown> => {
    const p = Array.isArray(params) ? params : [];
    switch (method) {
      case "eth_requestAccounts":
        // Every part of the page hears the connection, after the site has remembered it (the next tick).
        if (account) setTimeout(() => emit("accountsChanged", [address]), 0);
        return account ? [address] : [];
      case "eth_accounts":
        return account ? [address] : [];
      case "eth_chainId":
        return `0x${chainId.toString(16)}`;
      case "net_version":
        return String(chainId);
      case "wallet_switchEthereumChain": {
        const want = Number.parseInt(String((p[0] as { chainId?: string } | undefined)?.chainId ?? ""), 16);
        if (want !== 56 && want !== 97) throw new RpcError(4902, "The passkey wallet works on BNB Smart Chain and its testnet only.");
        if (want !== chainId) {
          chainId = want;
          emit("chainChanged", `0x${want.toString(16)}`);
        }
        return null;
      }
      case "wallet_addEthereumChain": {
        const want = Number.parseInt(String((p[0] as { chainId?: string } | undefined)?.chainId ?? ""), 16);
        if (want !== 56 && want !== 97) throw new RpcError(4200, "The passkey wallet works on BNB Smart Chain and its testnet only.");
        return null;
      }
      case "wallet_getCapabilities":
        // No atomic batches: the site's flows then take their one-step-at-a-time path.
        return {};
      case "personal_sign": {
        const raw = String(p[0] ?? "");
        const text = isHex(raw) ? (() => { try { return hexToString(raw); } catch { return raw; } })() : raw;
        await approve(describeMessage(text), "signature");
        return signer().signMessage({ message: isHex(raw) ? { raw } : raw });
      }
      case "eth_signTypedData_v4": {
        const typed = JSON.parse(String(p[1] ?? "{}")) as { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> };
        const want = Number(typed.domain?.chainId ?? chainId);
        if (want !== chainId) throw new RpcError(4901, `This signature is for chain ${want}, and the wallet is on ${chainId}.`);
        await approve(describeTyped(typed), "signature");
        const { EIP712Domain: _domain, ...types } = typed.types;
        return (signer().signTypedData as (a: unknown) => Promise<Hex>)({ domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message });
      }
      case "eth_sendTransaction": {
        const tx = (p[0] ?? {}) as { to?: Hex; data?: Hex; value?: Hex; gas?: Hex };
        const value = tx.value ? BigInt(tx.value) : 0n;
        await approve(describeTx({ to: tx.to, data: tx.data, value }, chainId), "transaction");
        const w = createWalletClient({ account: signer(), chain: CHAINS[chainId], transport: http(rpc(chainId)) });
        return w.sendTransaction({ to: tx.to, data: tx.data, value, gas: tx.gas ? BigInt(tx.gas) : undefined });
      }
      case "eth_sign":
        throw new RpcError(4200, "The passkey wallet does not sign raw data blind.");
      default:
        if (READS.has(method)) return reader().request({ method, params: p } as never);
        throw new RpcError(4200, `The passkey wallet does not support ${method}.`);
    }
  };

  return {
    isMandatePasskey: true,
    address,
    request,
    on: (e, h) => void (listeners[e] ||= []).push(h),
    removeListener: (e, h) => void (listeners[e] = (listeners[e] ?? []).filter((x) => x !== h)),
    lock: () => {
      account = null;
      emit("accountsChanged", []);
    },
  };
}
