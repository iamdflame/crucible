"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, formatUnits, parseEventLogs, type Address, type Hash } from "viem";
import { Check, Loader2 } from "lucide-react";
import { marketClient } from "@/lib/chain/market";
import { fmtBnb, useWallet } from "@/lib/chain/wallet";
import { COMMERCE_ABI, DELIVERY_SECONDS, ESCROW, POLICY_ABI, ROUTER_ABI, TOKEN_ABI, VIA } from "@/lib/escrow/contracts";
import { canBatch, NotBatchable, sendBatch } from "@/lib/escrow/batch";
import { planSwap, type SwapPlan } from "@/lib/escrow/pay-with-bnb";
import { track } from "@/lib/ops/funnel-client";
import OpenInWallet from "./OpenInWallet";
import { PasskeyStart } from "./Passkey";

export interface PackAgent {
  tokenId: string;
  name: string;
  /** What it does for the buyer's wallet, in a line. */
  does: string;
  /** The wallet its jobs name as provider. */
  provider: string;
  /** Its job price in $U base units. */
  budget: string;
}

/** Gas for two jobs in one batch, with room to spare. */
const GAS = 200_000_000_000_000n;

type Phase = "idle" | "planning" | "signing" | "confirming" | "recording" | "done" | "failed";

/**
 * Two of the three Set and Earn hires, in one confirmation.
 *
 * Two different agents of ours, each a real escrowed job about the buyer's
 * own wallet: both are opened, bound, budgeted and funded in one atomic batch
 * (EIP-5792), with PancakeSwap buying the $U first when the wallet holds only
 * BNB. Each agent delivers its answer on chain, and each budget comes back if
 * it does not. Two is the most that count on one marketplace; the third hire
 * has to be on another.
 *
 * A wallet that cannot batch is offered each agent's own hire instead, one at
 * a time, rather than ten signatures in a row.
 */
export default function HirePack({ agents }: { agents: PackAgent[] }) {
  const { address, ready, available, connect, connectError, switchChain } = useWallet();
  const [batch, setBatch] = useState<boolean | null>(null);
  const [u, setU] = useState<bigint | null>(null);
  const [bnb, setBnb] = useState<bigint | null>(null);
  const [plan, setPlan] = useState<SwapPlan | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<Hash | null>(null);
  const [jobs, setJobs] = useState<{ jobId: string; tokenId: string; name: string; status: string; url: string | null }[]>([]);
  const total = agents.reduce((s, a) => s + BigInt(a.budget), 0n);
  const short = u !== null && u < total ? total - u : 0n;

  useEffect(() => {
    if (!address || !ready) return;
    void canBatch(address).then(setBatch);
    marketClient.readContract({ address: ESCROW.paymentToken, abi: TOKEN_ABI, functionName: "balanceOf", args: [address] }).then(setU).catch(() => undefined);
    marketClient.getBalance({ address }).then(setBnb).catch(() => undefined);
  }, [address, ready]);

  // Short of $U: the swap that buys exactly the shortfall, shown before anything is signed.
  useEffect(() => {
    if (!address || short === 0n) {
      setPlan(null);
      return;
    }
    let gone = false;
    planSwap(marketClient, address, short)
      .then((p) => !gone && setPlan(p))
      .catch(() => !gone && setPlan(null));
    return () => {
      gone = true;
    };
  }, [address, short]);

  // After funding: each job read back until its agent's answer is on chain.
  const poll = useCallback(async (ids: { jobId: string; tokenId: string; name: string }[]) => {
    for (let i = 0; i < 60; i++) {
      const read = await Promise.all(
        ids.map((j) =>
          fetch(`/api/escrow/jobs/${j.jobId}`, { cache: "no-store" })
            .then((r) => r.json())
            .then((r) => ({ ...j, status: String(r?.data?.status ?? "FUNDED"), url: (r?.data?.deliverableUrl as string | null) ?? null }))
            .catch(() => ({ ...j, status: "FUNDED", url: null })),
        ),
      );
      setJobs(read);
      if (read.every((j) => j.status === "SUBMITTED" || j.status === "COMPLETED")) return;
      await new Promise((ok) => setTimeout(ok, 5_000));
    }
  }, []);

  const run = async () => {
    if (!address) return;
    setError(null);
    setPhase("planning");
    for (const a of agents) track("open", a.tokenId);
    try {
      const [disputeWindow, counter, held, allowance] = await Promise.all([
        marketClient.readContract({ address: ESCROW.policy, abi: POLICY_ABI, functionName: "disputeWindow" }) as Promise<bigint>,
        marketClient.readContract({ address: ESCROW.commerce, abi: COMMERCE_ABI, functionName: "jobCounter" }) as Promise<bigint>,
        marketClient.readContract({ address: ESCROW.paymentToken, abi: TOKEN_ABI, functionName: "balanceOf", args: [address] }) as Promise<bigint>,
        marketClient.readContract({ address: ESCROW.paymentToken, abi: TOKEN_ABI, functionName: "allowance", args: [address, ESCROW.commerce] }) as Promise<bigint>,
      ]);
      const swap = held < total ? await planSwap(marketClient, address, total - held) : null;
      const expiredAt = BigInt(Math.floor(Date.now() / 1000)) + BigInt(disputeWindow) + BigInt(DELIVERY_SECONDS);
      // Each job gets the next number in turn; if anyone else's job takes one first, the batch is refused whole and nothing moves.
      const ids = agents.map((_, i) => counter + 1n + BigInt(i));
      const calls = [
        ...(swap ? [swap.call] : []),
        ...agents.flatMap((a, i) => [
          {
            to: ESCROW.commerce as Address,
            data: encodeFunctionData({ abi: COMMERCE_ABI, functionName: "createJob", args: [a.provider as Address, ESCROW.router, expiredAt, `${VIA}: ${a.name} (ERC-8004 #${a.tokenId}) for ${address}`, ESCROW.router] }),
          },
          { to: ESCROW.router as Address, data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "registerJob", args: [ids[i]!, ESCROW.policy] }) },
          { to: ESCROW.commerce as Address, data: encodeFunctionData({ abi: COMMERCE_ABI, functionName: "setBudget", args: [ids[i]!, BigInt(a.budget), "0x"] }) },
        ]),
        ...(allowance < total ? [{ to: ESCROW.paymentToken as Address, data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "approve", args: [ESCROW.commerce, total] }) }] : []),
        ...agents.map((a, i) => ({ to: ESCROW.commerce as Address, data: encodeFunctionData({ abi: COMMERCE_ABI, functionName: "fund", args: [ids[i]!, BigInt(a.budget), "0x"] }) })),
      ];
      setPhase("signing");
      const hash = await sendBatch(address, calls, () => setPhase("confirming"));
      setTx(hash);
      setPhase("confirming");
      const receipt = await marketClient.waitForTransactionReceipt({ hash });
      const funded = parseEventLogs({ abi: COMMERCE_ABI, eventName: "JobFunded", logs: receipt.logs }).filter((l) => l.args.client.toLowerCase() === address.toLowerCase());
      if (funded.length < agents.length) throw new Error("The batch went through, but not every job in it was funded. Check My Desk before trying again.");
      // The batch is atomic, so each funded job has the number it was planned with.
      const made = funded.map((l) => {
        const a = agents[ids.findIndex((id) => id === l.args.jobId)] ?? agents.find((x) => x.provider.toLowerCase() === l.args.provider.toLowerCase()) ?? agents[0]!;
        return { jobId: l.args.jobId.toString(), tokenId: a.tokenId, name: a.name };
      });
      setPhase("recording");
      // Told to us so our agents deliver now, not on the next pass of the chain. Retried: our node can be a block behind the wallet's.
      await Promise.all(
        made.map(async (j) => {
          for (let i = 0; i < 6; i++) {
            const r = await fetch("/api/escrow/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: j.jobId, tx: hash, subject: address }) }).catch(() => null);
            if (r?.ok) {
              track("funded", j.tokenId);
              return;
            }
            if (r && r.status >= 400 && r.status < 500 && r.status !== 404 && r.status !== 429) return;
            await new Promise((ok) => setTimeout(ok, 3_000));
          }
        }),
      );
      setPhase("done");
      setJobs(made.map((j) => ({ ...j, status: "FUNDED", url: null })));
      void poll(made);
    } catch (e) {
      setPhase("failed");
      const m = (e as Error).message;
      setError(e instanceof NotBatchable ? "Your wallet would not take the batch. Hire them one at a time below." : `${m.slice(0, 200)} Nothing has left your wallet.`);
    }
  };

  const price = formatUnits(total, 18);
  return (
    <section className="x-pack" aria-labelledby="h-pack">
      <p className="x-eyebrow">Set and Earn · hire track</p>
      <h2 id="h-pack" className="x-pack__h">
        Two hires, one confirmation
      </h2>
      <p className="x-pack__lede">
        Two different agents, each a real escrowed job about your wallet, for {price} $U together. Pay with the BNB in your wallet if you hold no $U. Two of your
        three hires can be here; the third has to be on another shortlisted marketplace.
      </p>
      <ul className="x-pack__agents">
        {agents.map((a) => {
          const j = jobs.find((x) => x.tokenId === a.tokenId);
          const delivered = j && (j.status === "SUBMITTED" || j.status === "COMPLETED");
          return (
            <li key={a.tokenId}>
              <span className="x-pack__mark" aria-hidden="true">
                {delivered ? <Check size={14} strokeWidth={3} /> : j ? <Loader2 size={14} className="x-spin" /> : null}
              </span>
              <span>
                <Link className="x-pack__name" href={`/agents/${a.tokenId}`}>
                  {a.name}
                </Link>
                <span className="x-pack__does">{a.does}</span>
                {j ? (
                  <span className="x-pack__job">
                    Job <span className="x-mono">#{j.jobId}</span>: {delivered ? "delivered on chain. " : "funded, delivering… "}
                    {delivered && j.url ? (
                      <a className="x-link" href={j.url} target="_blank" rel="noreferrer">
                        Read its answer
                      </a>
                    ) : null}
                  </span>
                ) : null}
              </span>
              <span className="x-pack__price x-mono">{formatUnits(BigInt(a.budget), 18)} $U</span>
            </li>
          );
        })}
      </ul>

      {!available ? (
        <div className="x-pack__wallet">
          <p className="x-pack__note">Hiring needs a wallet on BNB Smart Chain. On a phone, open this page in your wallet app, or make one here with a passkey:</p>
          <OpenInWallet label="Open this page in your wallet app" />
          <PasskeyStart quiet />
        </div>
      ) : !address ? (
        <>
          <button type="button" className="x-btn x-btn--primary x-btn--lg x-btn--block" onClick={() => void connect().catch(() => undefined)}>
            Connect your campaign wallet
          </button>
          {connectError ? (
            <p className="x-escrow__err" role="alert">
              {connectError}
            </p>
          ) : null}
        </>
      ) : !ready ? (
        <button type="button" className="x-btn x-btn--primary x-btn--lg x-btn--block" onClick={() => void switchChain().catch(() => undefined)}>
          Switch to BNB Smart Chain
        </button>
      ) : phase === "done" ? (
        <p className="x-pack__ok" role="status">
          Both jobs are funded{tx ? (
            <>
              {" "}
              in{" "}
              <a className="x-link x-mono" href={`https://bscscan.com/tx/${tx}`} target="_blank" rel="noreferrer">
                {tx.slice(0, 10)}…
              </a>
            </>
          ) : null}
          . Each agent delivers on chain within minutes; your progress above counts each hire once the chain confirms it.
        </p>
      ) : batch === false ? (
        <div className="x-pack__wallet">
          <p className="x-pack__note">Your wallet signs one transaction at a time, so hire them one by one:</p>
          <div className="x-pack__each">
            {agents.map((a) => (
              <Link key={a.tokenId} className="x-btn" href={`/agents/${a.tokenId}#call`}>
                Hire {a.name}
              </Link>
            ))}
          </div>
        </div>
      ) : (
        <>
          {short > 0n ? (
            <p className="x-pack__note">
              {plan
                ? `About ${fmtBnb(plan.quote, 6)} BNB, at most ${fmtBnb(plan.maxIn, 6)}, buys the ${formatUnits(short, 18)} $U this wallet is short of, on PancakeSwap in the same confirmation. Unused BNB comes straight back.`
                : "Reading PancakeSwap's price for the $U this wallet is short of…"}
            </p>
          ) : null}
          {bnb !== null && bnb < GAS + (plan?.maxIn ?? 0n) ? (
            <p className="x-escrow__err">This wallet holds {fmtBnb(bnb, 5)} BNB; add a little BNB on BNB Smart Chain for the gas first.</p>
          ) : (
            <button
              type="button"
              className="x-btn x-btn--primary x-btn--lg x-btn--block"
              onClick={() => void run()}
              disabled={batch === null || (short > 0n && !plan) || phase === "planning" || phase === "signing" || phase === "confirming" || phase === "recording"}
            >
              {phase === "planning"
                ? "Preparing…"
                : phase === "signing"
                  ? "Confirm in your wallet…"
                  : phase === "confirming" || phase === "recording"
                    ? "Funding both jobs…"
                    : `Hire both for ${price} $U, in one confirmation`}
            </button>
          )}
          {error ? (
            <p className="x-escrow__err" role="alert">
              {error}
            </p>
          ) : null}
        </>
      )}
      <p className="x-pack__fine">Nothing moves until you sign. Each budget sits in BNB Chain&apos;s ERC-8183 escrow, not with us, and comes back if the work does not.</p>
    </section>
  );
}
