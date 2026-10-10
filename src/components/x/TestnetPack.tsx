"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPublicClient, createWalletClient, custom, encodeFunctionData, fallback, formatUnits, http, parseEventLogs, type Address, type Hash, type Hex } from "viem";
import { bscTestnet } from "viem/chains";
import { Check, Copy, Loader2 } from "lucide-react";
import { useWallet } from "@/lib/chain/wallet";
import { COMMERCE_ABI, DELIVERY_SECONDS, ESCROW_TESTNET, POLICY_ABI, ROUTER_ABI, TOKEN_ABI, VIA } from "@/lib/escrow/contracts";
import { canBatch, NotBatchable, sendBatch } from "@/lib/escrow/batch";
import { readableError } from "@/lib/chain/wallet";
import { track } from "@/lib/ops/funnel-client";
import OpenInWallet from "./OpenInWallet";

export interface TestnetPackAgent {
  slug: string;
  name: string;
  does: string;
  /** Its ERC-8004 id on testnet. */
  tokenId: string;
  /** Its ERC-8004 id on mainnet, where its page lives. */
  mainnetTokenId: string;
  /** The wallet its testnet jobs name as provider. */
  provider: string;
  /** Its job price in test $U base units. */
  budget: string;
}

/** BNB Chain's own faucets: its Telegram bot gives both test tokens; the web faucets one each. */
const FAUCET = {
  bot: "https://t.me/bnbchain_official_bot",
  botHandle: "@bnbchain_official_bot",
  u: "https://united-coin-u.github.io/u-faucet/",
  tbnb: "https://www.bnbchain.org/en/testnet-faucet",
};
/** Gas for two jobs on testnet, at its 0.1 gwei, with plenty of room. */
const GAS = 2_000_000_000_000_000n;
const EXPLORER = "https://testnet.bscscan.com";

type Phase = "idle" | "planning" | "signing" | "confirming" | "recording" | "done" | "failed";
type Eth = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
const eth = (): Eth | null => (typeof window === "undefined" ? null : ((window.ethereum as unknown as Eth | undefined) ?? null));

/** Asks the wallet for BNB Smart Chain testnet, adding it first when the wallet does not know it. */
async function toTestnet(): Promise<void> {
  const e = eth();
  if (!e) throw new Error("No wallet in this browser.");
  try {
    await e.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x61" }] });
  } catch (err) {
    if ((err as { code?: number }).code !== 4902) throw err;
    await e.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: "0x61",
          chainName: "BNB Smart Chain Testnet",
          nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
          rpcUrls: ["https://bsc-testnet-rpc.publicnode.com", "https://data-seed-prebsc-1-s1.bnbchain.org:8545"],
          blockExplorerUrls: ["https://testnet.bscscan.com"],
        },
      ],
    });
  }
}

/**
 * The same two hires, free, on BNB Smart Chain testnet.
 *
 * Set and Earn counts testnet hires, and a buyer without a cent of real $U can
 * do the hire track on testnet: the same two agents of ours, under their
 * testnet identities, each a real escrowed job on the testnet kernel paid in
 * test $U from BNB Chain's own faucets. Each agent delivers its answer on
 * chain and is settled after the 15-minute dispute window. A wallet that can
 * batch confirms once; one that cannot signs the steps in turn, which costs
 * nothing on testnet but patience.
 */
export default function TestnetPack({ agents }: { agents: TestnetPackAgent[] }) {
  const { address, available, chainId, connect, connectError } = useWallet();
  const onTestnet = chainId === 97;
  const reader = useMemo(
    () => createPublicClient({ chain: bscTestnet, transport: fallback([http("https://bsc-testnet-rpc.publicnode.com"), http("https://data-seed-prebsc-1-s1.bnbchain.org:8545")]) }),
    [],
  );
  const [tbnb, setTbnb] = useState<bigint | null>(null);
  const [u, setU] = useState<bigint | null>(null);
  const [batch, setBatch] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [jobs, setJobs] = useState<{ jobId: string; slug: string; status: string; url: string | null }[]>([]);
  const total = agents.reduce((s, a) => s + BigInt(a.budget), 0n);

  const readBalances = useCallback(() => {
    if (!address) return;
    reader.getBalance({ address }).then(setTbnb).catch(() => undefined);
    reader.readContract({ address: ESCROW_TESTNET.paymentToken, abi: TOKEN_ABI, functionName: "balanceOf", args: [address] }).then((v) => setU(v as bigint)).catch(() => undefined);
  }, [address, reader]);

  useEffect(() => {
    readBalances();
    if (address && onTestnet) void canBatch(address, 97).then(setBatch);
  }, [address, onTestnet, readBalances]);

  // Re-read while the buyer is off fetching test tokens.
  useEffect(() => {
    if (!address || phase !== "idle") return;
    const t = setInterval(() => document.visibilityState === "visible" && readBalances(), 10_000);
    return () => clearInterval(t);
  }, [address, phase, readBalances]);

  const poll = useCallback(async (made: { jobId: string; slug: string }[]) => {
    for (let i = 0; i < 90; i++) {
      const read = await Promise.all(
        made.map((j) =>
          fetch(`/api/escrow/testnet/jobs/${j.jobId}`, { cache: "no-store" })
            .then((r) => r.json())
            .then((r) => ({ ...j, status: String(r?.data?.status ?? "FUNDED"), url: (r?.data?.deliverableUrl as string | null) ?? null }))
            .catch(() => ({ ...j, status: "FUNDED", url: null })),
        ),
      );
      setJobs(read);
      if (read.every((j) => j.status === "COMPLETED")) return;
      await new Promise((ok) => setTimeout(ok, 6_000));
    }
  }, []);

  const run = async () => {
    if (!address) return;
    setError(null);
    setPhase("planning");
    for (const a of agents) track("open", a.tokenId);
    try {
      const [disputeWindow, counter, allowance] = await Promise.all([
        reader.readContract({ address: ESCROW_TESTNET.policy, abi: POLICY_ABI, functionName: "disputeWindow" }) as Promise<bigint>,
        reader.readContract({ address: ESCROW_TESTNET.commerce, abi: COMMERCE_ABI, functionName: "jobCounter" }) as Promise<bigint>,
        reader.readContract({ address: ESCROW_TESTNET.paymentToken, abi: TOKEN_ABI, functionName: "allowance", args: [address, ESCROW_TESTNET.commerce] }) as Promise<bigint>,
      ]);
      const expiredAt = BigInt(Math.floor(Date.now() / 1000)) + disputeWindow + BigInt(DELIVERY_SECONDS);
      const open = (a: TestnetPackAgent) =>
        encodeFunctionData({ abi: COMMERCE_ABI, functionName: "createJob", args: [a.provider as Address, ESCROW_TESTNET.router, expiredAt, `${VIA}: ${a.name} (ERC-8004 testnet #${a.tokenId}) for ${address}`, ESCROW_TESTNET.router] });
      const bind = (id: bigint) => encodeFunctionData({ abi: ROUTER_ABI, functionName: "registerJob", args: [id, ESCROW_TESTNET.policy] });
      const budget = (id: bigint, a: TestnetPackAgent) => encodeFunctionData({ abi: COMMERCE_ABI, functionName: "setBudget", args: [id, BigInt(a.budget), "0x"] });
      const approve = encodeFunctionData({ abi: TOKEN_ABI, functionName: "approve", args: [ESCROW_TESTNET.commerce, total] });
      const fund = (id: bigint, a: TestnetPackAgent) => encodeFunctionData({ abi: COMMERCE_ABI, functionName: "fund", args: [id, BigInt(a.budget), "0x"] });

      let made: { jobId: string; slug: string; tokenId: string }[];
      if (batch) {
        // Each job gets the next number in turn; if anyone else's job takes one first, the batch is refused whole and nothing moves.
        const ids = agents.map((_, i) => counter + 1n + BigInt(i));
        const calls = [
          ...agents.flatMap((a, i) => [
            { to: ESCROW_TESTNET.commerce as Address, data: open(a) },
            { to: ESCROW_TESTNET.router as Address, data: bind(ids[i]!) },
            { to: ESCROW_TESTNET.commerce as Address, data: budget(ids[i]!, a) },
          ]),
          ...(allowance < total ? [{ to: ESCROW_TESTNET.paymentToken as Address, data: approve }] : []),
          ...agents.map((a, i) => ({ to: ESCROW_TESTNET.commerce as Address, data: fund(ids[i]!, a) })),
        ];
        setPhase("signing");
        const hash = await sendBatch(address, calls, () => setPhase("confirming"), 97);
        setPhase("confirming");
        const receipt = await reader.waitForTransactionReceipt({ hash });
        const funded = parseEventLogs({ abi: COMMERCE_ABI, eventName: "JobFunded", logs: receipt.logs }).filter((l) => l.args.client.toLowerCase() === address.toLowerCase());
        if (funded.length < agents.length) throw new Error("The batch went through, but not every job in it was funded.");
        made = funded.map((l) => {
          const a = agents.find((x) => x.provider.toLowerCase() === l.args.provider.toLowerCase()) ?? agents[0]!;
          return { jobId: l.args.jobId.toString(), slug: a.slug, tokenId: a.tokenId };
        });
      } else {
        // One transaction at a time: each job's number read from its own receipt, so no other buyer can take it.
        const e = eth();
        if (!e) throw new Error("No wallet in this browser.");
        const w = createWalletClient({ account: address, chain: bscTestnet, transport: custom(e) });
        const steps = agents.length * 4 + (allowance < total ? 1 : 0);
        let n = 0;
        const send = async (label: string, to: Address, data: Hex) => {
          n += 1;
          setStep(`${label} (${n} of ${steps})`);
          setPhase("signing");
          const hash: Hash = await w.sendTransaction({ to, data });
          setPhase("confirming");
          const r = await reader.waitForTransactionReceipt({ hash });
          if (r.status !== "success") throw new Error(`${label} was undone on chain.`);
          return r;
        };
        const ids: bigint[] = [];
        for (const a of agents) {
          const r = await send(`Open ${a.name}'s job`, ESCROW_TESTNET.commerce, open(a));
          const id = parseEventLogs({ abi: COMMERCE_ABI, eventName: "JobCreated", logs: r.logs })[0]?.args.jobId;
          if (id === undefined) throw new Error("The job was opened, but its number could not be read.");
          ids.push(id);
          await send(`Bind it to the dispute policy`, ESCROW_TESTNET.router, bind(id));
          await send(`Set its budget`, ESCROW_TESTNET.commerce, budget(id, a));
        }
        if (allowance < total) await send("Approve the test $U", ESCROW_TESTNET.paymentToken, approve);
        for (const [i, a] of agents.entries()) await send(`Fund ${a.name}'s job`, ESCROW_TESTNET.commerce, fund(ids[i]!, a));
        made = agents.map((a, i) => ({ jobId: ids[i]!.toString(), slug: a.slug, tokenId: a.tokenId }));
        setStep(null);
      }
      setPhase("recording");
      // Told to us so our agents deliver now, not on the next five-minute pass. Retried: our node can be a block behind the wallet's.
      await Promise.all(
        made.map(async (j) => {
          for (let i = 0; i < 8; i++) {
            const r = await fetch("/api/escrow/testnet/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: j.jobId }) }).catch(() => null);
            if (r?.ok) {
              track("funded", j.tokenId);
              return;
            }
            if (r && r.status === 409) return;
            await new Promise((ok) => setTimeout(ok, 3_000));
          }
        }),
      );
      setPhase("done");
      setJobs(made.map((j) => ({ ...j, status: "FUNDED", url: null })));
      readBalances();
      void poll(made);
    } catch (e) {
      setPhase("failed");
      setStep(null);
      const m = e instanceof NotBatchable ? "Your wallet would not take the batch on testnet." : readableError(e);
      setError(`${m.slice(0, 200)} Any job already opened refunds its test $U after its deadline.`);
      setBatch(e instanceof NotBatchable ? false : batch);
    }
  };

  const ask = address ? `I would like to get tBNB and U on BNB Smart Chain Testnet to my wallet ${address}` : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ask);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* The message is on screen to select. */
    }
  };
  const shortGas = tbnb !== null && tbnb < GAS;
  const shortU = u !== null && u < total;
  const busy = phase === "planning" || phase === "signing" || phase === "confirming" || phase === "recording";

  return (
    <section className="x-pack x-pack--testnet" aria-labelledby="h-pack-testnet">
      <p className="x-eyebrow">Free · BNB Smart Chain testnet</p>
      <h2 id="h-pack-testnet" className="x-pack__h">
        The same two hires, free on testnet
      </h2>
      <p className="x-pack__lede">
        Set and Earn counts testnet hires. Hire the same two agents on BNB Smart Chain testnet with test $U from BNB Chain&apos;s faucet: real escrowed jobs,
        delivered on chain, and no real money.
      </p>
      <ul className="x-pack__agents">
        {agents.map((a) => {
          const j = jobs.find((x) => x.slug === a.slug);
          const delivered = j && (j.status === "SUBMITTED" || j.status === "COMPLETED");
          return (
            <li key={a.slug}>
              <span className="x-pack__mark" aria-hidden="true">
                {delivered ? <Check size={14} strokeWidth={3} /> : j ? <Loader2 size={14} className="x-spin" /> : null}
              </span>
              <span>
                <Link className="x-pack__name" href={`/agents/${a.mainnetTokenId}`}>
                  {a.name}
                </Link>{" "}
                <span className="x-tag">testnet #{a.tokenId}</span>
                <span className="x-pack__does">{a.does}</span>
                {j ? (
                  <span className="x-pack__job">
                    Testnet job <span className="x-mono">#{j.jobId}</span>: {j.status === "COMPLETED" ? "delivered and settled. " : delivered ? "delivered on chain. " : "funded, delivering… "}
                    {delivered && j.url ? (
                      <a className="x-link" href={j.url} target="_blank" rel="noreferrer">
                        Read its answer
                      </a>
                    ) : null}
                  </span>
                ) : null}
              </span>
              <span className="x-pack__price x-mono">{formatUnits(BigInt(a.budget), 18)} test $U</span>
            </li>
          );
        })}
      </ul>

      {!available ? (
        <div className="x-pack__wallet">
          <p className="x-pack__note">Hiring needs a wallet. On a phone, open this page in your wallet app:</p>
          <OpenInWallet label="Open this page in your wallet app" />
        </div>
      ) : !address ? (
        <>
          <button type="button" className="x-btn x-btn--lg x-btn--block" onClick={() => void connect().catch(() => undefined)}>
            Connect your campaign wallet
          </button>
          {connectError ? (
            <p className="x-escrow__err" role="alert">
              {connectError}
            </p>
          ) : null}
        </>
      ) : !onTestnet ? (
        <button type="button" className="x-btn x-btn--lg x-btn--block" onClick={() => void toTestnet().catch((e) => setError(readableError(e)))}>
          Switch to BNB Smart Chain testnet
        </button>
      ) : phase === "done" ? (
        <p className="x-pack__ok" role="status">
          Both testnet jobs are funded. Each agent delivers on chain within minutes, and is settled 15 minutes after; your progress above counts each hire once the
          chain confirms it.
        </p>
      ) : shortGas || shortU ? (
        <div className="x-pack__wallet">
          <p className="x-pack__note">
            This wallet holds {tbnb === null ? "…" : formatUnits(tbnb, 18).slice(0, 7)} tBNB and {u === null ? "…" : formatUnits(u, 18)} test $U; the two hires need a
            little tBNB for gas and {formatUnits(total, 18)} test $U. BNB Chain&apos;s Telegram bot sends both. Open{" "}
            <a className="x-link" href={FAUCET.bot} target="_blank" rel="noreferrer">
              {FAUCET.botHandle}
            </a>{" "}
            and send:
          </p>
          <div className="x-share">
            <span className="x-share__url x-mono">{ask}</span>
            <button type="button" className="x-btn x-btn--sm" onClick={() => void copy()}>
              <Copy size={14} aria-hidden="true" /> {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="x-pack__fine">
            Or the web faucets:{" "}
            <a className="x-link" href={FAUCET.u} target="_blank" rel="noreferrer">
              test $U
            </a>{" "}
            and{" "}
            <a className="x-link" href={FAUCET.tbnb} target="_blank" rel="noreferrer">
              tBNB
            </a>{" "}
            (it asks for some mainnet history). This box updates when they arrive.
          </p>
        </div>
      ) : (
        <>
          <button type="button" className="x-btn x-btn--lg x-btn--block" onClick={() => void run()} disabled={batch === null || busy}>
            {phase === "planning"
              ? "Preparing…"
              : phase === "signing"
                ? step ? `Confirm in your wallet: ${step}` : "Confirm in your wallet…"
                : phase === "confirming" || phase === "recording"
                  ? step ? `Waiting for the chain: ${step}` : "Funding both jobs…"
                  : batch
                    ? `Hire both free, for ${formatUnits(total, 18)} test $U, in one confirmation`
                    : `Hire both free, for ${formatUnits(total, 18)} test $U (your wallet signs each step)`}
          </button>
          {error ? (
            <p className="x-escrow__err" role="alert">
              {error}
            </p>
          ) : null}
        </>
      )}
      <p className="x-pack__fine">
        Testnet only: nothing here uses real money. Each budget sits in BNB Chain&apos;s ERC-8183 escrow on testnet and comes back if the work does not. Every
        transaction is on{" "}
        <a className="x-link" href={EXPLORER} target="_blank" rel="noreferrer">
          testnet BscScan
        </a>
        .
      </p>
    </section>
  );
}
