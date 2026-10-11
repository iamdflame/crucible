"use client";

/**
 * Wallet connection.
 *
 * Written against EIP-1193 directly rather than pulling in a connector kit.
 * The page needs one thing, an injected provider that can sign for this chain
 *, and a wallet library would add a few hundred kilobytes, a modal we would
 * then have to restyle, and a second source of truth about chain state.
 *
 * Everything here can be signing real BNB on BSC mainnet, so the flow is
 * deliberately explicit: never switch chains silently, never submit without
 * the amount having been shown, and always surface the transaction hash.
 */

import {
  createWalletClient,
  custom,
  formatEther,
  type Address,
  type EIP1193Provider,
  type Hash,
} from "viem";
import { useCallback, useEffect, useState } from "react";
import { marketChain, marketClient, MARKET_ADDRESS } from "./market";
import { MANDATE_MARKET_V2_ABI } from "./abiV2";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export type TxPhase = "idle" | "signing" | "pending" | "confirmed" | "failed";

export interface TxState {
  phase: TxPhase;
  hash?: Hash;
  error?: string;
}

export interface WalletState {
  address: Address | null;
  chainId: number | null;
  /** True when a provider exists at all. */
  available: boolean;
  /** True when connected and on the chain the market lives on. */
  ready: boolean;
  balanceWei: bigint | null;
}

const toHexChain = (id: number) => `0x${id.toString(16)}`;

/*
  Wallets that only announce themselves (EIP-6963) and never set
  window.ethereum. The site saw them and showed Connect, but every call read
  window.ethereum, so pressing Connect did nothing at all (4 Oct). The first
  one to announce is adopted as window.ethereum when nothing else has set it,
  so every path (connect, payments, batches) reaches it without knowing.
*/
if (typeof window !== "undefined") {
  const adopt = (e: Event) => {
    const provider = (e as CustomEvent<{ provider?: EIP1193Provider }>).detail?.provider;
    if (!provider || window.ethereum) return;
    try {
      window.ethereum = provider;
    } catch {
      /* window.ethereum is a fixed property here; that wallet set it, and it is used. */
    }
  };
  window.addEventListener("eip6963:announceProvider", adopt);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

/** Why a connection did not happen, in words a person can act on. */
export function connectWords(error: unknown): string {
  const e = error as { code?: number; message?: string } | null;
  const m = e?.message ?? String(error);
  if (e?.code === 4001 || /reject|denied|cancel/i.test(m)) return "The connection was cancelled in your wallet. Press Connect to try again.";
  if (e?.code === -32002 || /already pending|already processing/i.test(m)) {
    return "Your wallet already has a connection request open. Open your wallet (its icon in the browser bar, or the app) and approve it there.";
  }
  if (/No wallet found/i.test(m)) return "No wallet found in this browser. Install MetaMask or another BNB Smart Chain wallet, or on a phone open this page in your wallet app.";
  if (/locked|unlock/i.test(m)) return "Your wallet is locked. Unlock it, then press Connect again.";
  return `Your wallet did not connect: ${m.slice(0, 140)}`;
}

/**
 * Whether this browser has ever connected a wallet to this origin.
 *
 * Kept in `localStorage` rather than inferred, because the question is not
 * "does a wallet exist", it is "has this person already agreed to talk to
 * us", and only they can have answered that.
 */
const CONNECTED_KEY = "mandate:wallet-connected";

function hasConnectedBefore(): boolean {
  try {
    return window.localStorage.getItem(CONNECTED_KEY) === "1";
  } catch {
    // Private windows and blocked site data both throw. Neither is a reason
    // to open a wallet dialogue nobody asked for.
    return false;
  }
}

function rememberConnected(): void {
  try {
    window.localStorage.setItem(CONNECTED_KEY, "1");
  } catch {
    /* The convenience is optional; the connection is not stored anywhere else. */
  }
}

function forgetConnected(): void {
  try {
    window.localStorage.removeItem(CONNECTED_KEY);
  } catch {
    /* Nothing was stored, so there is nothing to forget. */
  }
}

/**
 * Fired when this tab disconnects, so every component holding a `useWallet`
 * drops the account at once. Other tabs hear the same thing through the
 * `storage` event when the remembered flag is removed.
 */
const DISCONNECT_EVENT = "mandate:wallet-disconnect";

export function useWallet() {
  const [state, setState] = useState<WalletState>({
    address: null,
    chainId: null,
    available: false,
    ready: false,
    balanceWei: null,
  });

  const refresh = useCallback(async (address: Address | null) => {
    const provider = window.ethereum;
    if (!provider || !address) {
      setState((s) => ({ ...s, address: null, ready: false, balanceWei: null }));
      return;
    }
    const chainHex = (await provider.request({ method: "eth_chainId" })) as string;
    const chainId = Number.parseInt(chainHex, 16);
    let balanceWei: bigint | null = null;
    try {
      balanceWei = await marketClient.getBalance({ address });
    } catch {
      balanceWei = null;
    }
    setState({
      address,
      chainId,
      available: true,
      ready: chainId === marketChain.id,
      balanceWei,
    });
  }, []);

  /*
    Nothing is asked of the wallet until somebody asks for the wallet.

    This used to call `eth_accounts` on mount, on the reasoning that reading
    the authorised accounts is not a request for permission. That reasoning is
    correct about the JSON-RPC method and wrong about what actually happens:
    several multi-chain wallets, Phantom among them, injected as
    `window.ethereum`, surface their own connect overlay on the first provider
    call from an unknown origin, whatever the method is. So opening the front
    page of an assay office threw a wallet popup at the reader, which for a
    site asking to be trusted with capital is the single worst first impression
    available.

    The provider is only touched after a deliberate act. The presence check is
    a property read, which reaches no extension. If this browser has connected
    to this origin before, the silent `eth_accounts` reflection happens then
    and only then, a returning user keeps the convenience and a first-time
    visitor gets no dialogue at all.
  */
  useEffect(() => {
    /*
      Extensions do not all arrive before React does.

      This checked `window.ethereum` exactly once, on mount, in an effect whose
      only dependency is stable, so a wallet that injected two hundred
      milliseconds later was invisible for the rest of the session, and the UI
      showed a buttonless "no wallet detected" to somebody who plainly had one.

      Three ways in now, all passive: the EIP-6963 announcement, which is how
      Rabby, Coinbase and current MetaMask introduce themselves and the only
      way to see past whichever extension won the `window.ethereum` race; the
      legacy `ethereum#initialized` event; and a short poll for injectors that
      announce nothing at all. None of them touches the provider, presence is
      a property read, so the popup problem this file used to have does not
      come back.
    */
    let cancelled = false;
    const onDisconnect = () =>
      setState((s) => ({ ...s, address: null, chainId: null, ready: false, balanceWei: null }));
    const onStorage = (e: StorageEvent) => {
      if (e.key === CONNECTED_KEY && e.newValue === null) onDisconnect();
    };
    window.addEventListener(DISCONNECT_EVENT, onDisconnect);
    window.addEventListener("storage", onStorage);

    const markAvailable = () => {
      if (!cancelled) setState((s) => (s.available ? s : { ...s, available: true }));
    };

    const onAnnounce = () => markAvailable();
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    window.addEventListener("ethereum#initialized", onAnnounce, { once: true });

    let tries = 0;
    const poll = window.setInterval(() => {
      tries += 1;
      if (window.ethereum) markAvailable();
      if (window.ethereum || tries >= 6) window.clearInterval(poll);
    }, 400);

    const cleanupDetect = () => {
      cancelled = true;
      window.removeEventListener(DISCONNECT_EVENT, onDisconnect);
      window.removeEventListener("storage", onStorage);
      window.clearInterval(poll);
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      window.removeEventListener("ethereum#initialized", onAnnounce);
    };

    /*
      Listening is attached to whichever wallet is present, and again when one
      arrives later: a passkey wallet opened on this page (lib/passkey) comes
      after the page, and a hook that only listened at mount never heard it
      switch network or change account.
    */
    let detach: (() => void) | null = null;
    const attach = (provider: NonNullable<typeof window.ethereum>) => {
      if (detach) return;
      const onAccounts = (accounts: unknown) => {
        const list = accounts as Address[];
        // After a disconnect, a wallet that cannot give up its permission may
        // still announce accounts. They are ignored until the person connects
        // again, or "disconnect" would undo itself on the next account switch.
        if (list?.length && !hasConnectedBefore()) return;
        void refresh(list?.length ? list[0] : null);
      };
      const onChain = () => {
        setState((s) => {
          if (s.address) void refresh(s.address);
          return s;
        });
      };
      const p = provider as unknown as {
        on?: (e: string, h: (v: unknown) => void) => void;
        removeListener?: (e: string, h: (v: unknown) => void) => void;
      };
      p.on?.("accountsChanged", onAccounts);
      p.on?.("chainChanged", onChain);
      detach = () => {
        p.removeListener?.("accountsChanged", onAccounts);
        p.removeListener?.("chainChanged", onChain);
      };
    };
    const onLater = () => {
      const provider = window.ethereum;
      if (!provider || cancelled) return;
      markAvailable();
      attach(provider);
    };
    window.addEventListener("eip6963:announceProvider", onLater);
    window.addEventListener("mandate:passkey-opened", onLater);

    const provider = window.ethereum;
    if (!provider) {
      setState((s) => ({ ...s, available: false }));
      return () => {
        cleanupDetect();
        window.removeEventListener("eip6963:announceProvider", onLater);
        window.removeEventListener("mandate:passkey-opened", onLater);
        detach?.();
      };
    }
    setState((s) => ({ ...s, available: true }));
    if (hasConnectedBefore()) {
      provider
        .request({ method: "eth_accounts" })
        .then((accounts) => {
          const list = accounts as Address[];
          if (list?.length) void refresh(list[0]);
        })
        .catch(() => undefined);
    }
    attach(provider);
    return () => {
      cleanupDetect();
      window.removeEventListener("eip6963:announceProvider", onLater);
      window.removeEventListener("mandate:passkey-opened", onLater);
      detach?.();
    };
  }, [refresh]);

  // Why the last press of Connect failed, for the button that was pressed to say so.
  const [connectError, setConnectError] = useState<string | null>(null);
  const connect = useCallback(async () => {
    setConnectError(null);
    try {
      const provider = window.ethereum;
      if (!provider) throw new Error("No wallet found in this browser.");
      const accounts = (await provider.request({
        method: "eth_requestAccounts",
      })) as Address[];
      if (!accounts?.length) throw new Error("The wallet shared no account. It may be locked: unlock it and try again.");
      // Remembered so a later visit can reflect the connection silently. This is
      // the only thing that licenses touching the provider on mount.
      rememberConnected();
      await refresh(accounts[0] ?? null);
    } catch (e) {
      setConnectError(connectWords(e));
      throw e;
    }
  }, [refresh]);

  /** Asks the wallet to move to the market's chain, adding it if unknown. */
  const switchChain = useCallback(async () => {
    const provider = window.ethereum;
    if (!provider) return;
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: toHexChain(marketChain.id) }],
      });
    } catch (error) {
      // 4902: the wallet does not know this chain yet.
      const code = (error as { code?: number }).code;
      if (code !== 4902) throw error;
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: toHexChain(marketChain.id),
            chainName: marketChain.name,
            nativeCurrency: marketChain.nativeCurrency,
            rpcUrls: [marketChain.rpcUrls.default.http[0]],
            blockExplorerUrls: marketChain.blockExplorers?.default?.url
              ? [marketChain.blockExplorers.default.url]
              : undefined,
          },
        ],
      });
    }
    if (state.address) await refresh(state.address);
  }, [refresh, state.address]);

  /**
   * Stops this site reading the wallet.
   *
   * The remembered flag is what licenses the silent reconnect on a later
   * visit, so forgetting it is the disconnect. Where the wallet supports it
   * (MetaMask and several others do), the site's permission is also handed
   * back, so the wallet itself shows the site as disconnected. Nothing here
   * touches funds or anything already signed.
   */
  const disconnect = useCallback(async () => {
    forgetConnected();
    window.dispatchEvent(new Event(DISCONNECT_EVENT));
    try {
      await window.ethereum?.request({
        method: "wallet_revokePermissions",
        params: [{ eth_accounts: {} }],
      } as never);
    } catch {
      /* Not supported by this wallet; the local disconnect stands on its own. */
    }
  }, []);

  return { ...state, connect, connectError, switchChain, refresh, disconnect };
}

/**
 * Which contract a write goes to, and which ABI describes it.
 *
 * This used to be implicit, every write went to `MARKET_ADDRESS` under
 * `MANDATE_MARKET_ABI`, and the two had drifted apart. `MARKET_ADDRESS` points
 * at MandateMarket**V2**; `MANDATE_MARKET_ABI` describes **V1**. Their
 * signatures are not compatible: V2's `openMandate` takes twelve arguments
 * where V1's takes six, `bid` four where V1 takes two, `withdraw` one where V1
 * takes none.
 *
 * The consequence was total. `simulateContract` runs before the wallet is ever
 * asked for a signature, so every write reverted with `execution reverted: 0x`
 *, the chain saying "no such function", and the user saw a dead button and no
 * wallet prompt. Not a degraded hire path: no hire path at all.
 *
 * Verified against mainnet: V1's `openMandate` selector reverts on
 * `0x6052C0ab…71B2` and succeeds on `0xeD331c44…1544`, and the former answers
 * `paused()` and `proposerStake()`, which only V2 has.
 *
 * So the target is now explicit at every call site. The book already carries a
 * `deploymentAddress` per row, mandates from three deployments share one table
 *, and passing it here is what stops a bid on a superseded row being sent to
 * the canonical contract against a different mandate with the same number.
 */
export interface WriteTarget {
  address: Address;
  abi: readonly unknown[];
}

/** The canonical market: V2, the one `MARKET_ADDRESS` resolves to. */
export const CANONICAL_TARGET: WriteTarget = {
  address: MARKET_ADDRESS,
  abi: MANDATE_MARKET_V2_ABI,
};

/**
 * Sends one write to the market and follows it to a receipt.
 *
 * Simulates first: a revert caught here costs nothing, while the same revert
 * caught on-chain costs gas and tells the user far less about why.
 */
export async function sendMarketTx(
  account: Address,
  functionName: string,
  args: unknown[],
  value?: bigint,
  onPhase?: (s: TxState) => void,
  target: WriteTarget = CANONICAL_TARGET,
): Promise<Hash> {
  const provider = window.ethereum;
  if (!provider) throw new Error("No wallet found.");

  const wallet = createWalletClient({
    account,
    chain: marketChain,
    transport: custom(provider),
  });

  /*
    Does this contract have this function at all?

    The outage this guard exists for was silent: the ABI described V1, the
    address held V2, and `simulateContract` returned `execution reverted: 0x`,
    the chain's way of saying "no such function", which is indistinguishable
    from a business-logic rejection once it reaches a user. Every write in the
    product died that way and the failure read as a dead button.

    Checking the ABI names before dialling out costs nothing and converts that
    whole class of mistake from a mystery into a sentence that names the
    function and the contract.
  */
  const known = (target.abi as readonly { type?: string; name?: string }[]).some(
    (entry) => entry.type === "function" && entry.name === functionName,
  );
  if (!known) {
    const message = `${functionName} is not a function on the market at ${target.address}. This deployment answers a different ABI.`;
    onPhase?.({ phase: "failed", error: message });
    throw new Error(message);
  }

  onPhase?.({ phase: "signing" });

  try {
    const { request } = await marketClient.simulateContract({
      address: target.address,
      abi: target.abi,
      functionName,
      args,
      value,
      account,
    } as never);

    const hash = await wallet.writeContract(request as never);
    onPhase?.({ phase: "pending", hash });

    const receipt = await marketClient.waitForTransactionReceipt({ hash });
    if (receipt.status === "reverted") {
      onPhase?.({ phase: "failed", hash, error: "The transaction reverted." });
      throw new Error("reverted");
    }
    onPhase?.({ phase: "confirmed", hash });
    return hash;
  } catch (error) {
    const message = readableError(error);
    onPhase?.({ phase: "failed", error: message });
    throw new Error(message);
  }
}

/** Turns a viem/provider error into something a person can act on. */
export function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);

  if (/User rejected|denied transaction|4001/i.test(raw)) {
    return "You rejected the request in your wallet.";
  }
  if (/insufficient funds/i.test(raw)) {
    return "Not enough BNB to cover the amount plus gas.";
  }
  // Custom errors from MandateMarket, mapped to what the user should do.
  const named: Record<string, string> = {
    BondTooSmall: "That bond is below the market minimum.",
    BadState: "This mandate is no longer accepting that action.",
    NoCapital: "A mandate needs capital to open.",
    BadParameters: "Those mandate terms are out of range.",
    NotPrincipal: "Only the principal who opened this mandate can award it.",
    MandateHeld: "That bond is currently at risk and cannot be withdrawn.",
    BidSpent: "That bid has already been promoted or withdrawn.",
    NothingToWithdraw: "There is nothing to withdraw.",
    EpochNotElapsed: "This epoch has not finished yet.",
    // V2 adds errors a user can actually hit. Each says what to do about it,
    // not what the contract called it.
    Paused: "The market is paused and is not accepting new capital.",
    BidExpired: "That bid has expired. The agent would need to post a new one.",
    NoSuchBid: "That bid no longer exists.",
    NotBidder: "Only the wallet that placed a bid can withdraw it.",
    BelowFineness: "That agent's fineness is below what this market requires.",
    NotAssayed: "That agent has never been assayed, so it cannot bid here yet.",
    StaleObservation: "The opening mark is stale or empty, that wallet holds nothing to measure at this block.",
    NoOpeningAttestation: "This mandate has no opening mark committed, so it cannot be settled.",
    TermComplete: "This mandate has served its full term.",
    WrongAsset: "That is not the asset this mandate is denominated in.",
    ChallengeWindowTooLong: "The epoch is shorter than the window in which it could be contested.",
    StakeTooSmall: "That stake is below what the market requires to propose or challenge.",
    BondTooSmall_V2: "That bond is below this mandate's required floor.",
  };
  for (const [key, message] of Object.entries(named)) {
    if (raw.includes(key)) return message;
  }

  const short = raw.split("\n")[0] ?? raw;
  return short.length > 160 ? `${short.slice(0, 157)}…` : short;
}

/** A balance to `dp` places; a balance too small to show is "<0.001", never a misleading "0.000". */
export const fmtBnb = (wei: bigint | null, dp = 3) => {
  if (wei === null) return "";
  const v = Number(formatEther(wei));
  const floor = 10 ** -dp;
  return v > 0 && v < floor ? `<${floor.toFixed(dp)}` : v.toFixed(dp);
};
