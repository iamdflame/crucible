"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits, parseEventLogs, type Address, type Hash } from "viem";
import { Check, Loader2, X } from "lucide-react";
import { marketClient } from "@/lib/chain/market";
import { sendMarketTx, useWallet } from "@/lib/chain/wallet";
import OpenInWallet from "./OpenInWallet";
import RateAgent from "./RateAgent";
import { COMMERCE_ABI, DELIVERY_SECONDS, ESCROW, outsideDescription, POLICY_ABI, ROUTER_ABI, TOKEN_ABI, VIA } from "@/lib/escrow/contracts";

/**
 * Hiring an agent through ERC-8183 escrow, from the buyer's own wallet.
 *
 * Five transactions, each shown before it is signed: open the job naming the
 * agent's wallet as provider, bind it to the optimistic policy, set the
 * budget, approve exactly that budget of $U to the escrow, and fund it. The
 * $U sits in the escrow, not with us or the seller. The agent delivers within
 * minutes; the budget is released to it once the policy's dispute window
 * passes, and comes back to the buyer if it does not deliver in time.
 *
 * For an outside seller the job's description is the JSON its seller reads
 * ({task, service, via}), and once funded our server tells the seller, with
 * what the buyer entered. Its answer is shown here as it gave it.
 */
export interface EscrowOffer {
  provider: string;
  budget: string;
  tokenId: string;
  name: string;
  /** Set for an outside seller that quoted over A2A; null for our own agents. */
  outside: null | { service: string | null; serviceName: string | null; etaSeconds: number | null; standard?: boolean };
}

/** Gas for all five steps with room to spare: they used 0.0000376 BNB at 0.05 gwei on job 56802. */
const GAS_FOR_FIVE = 100_000_000_000_000n;

const STEPS = ["Open the job", "Bind it to the policy", "Set the budget", "Approve exactly the budget", "Fund the escrow"] as const;
const days = (s: bigint) => `${Number(s) / 86_400} days`;

export default function EscrowHire({
  offer,
  subject,
  inputs = {},
  category = null,
}: {
  offer: EscrowOffer;
  subject: string | null;
  /** What the buyer entered, for an outside seller. */
  inputs?: Record<string, string>;
  category?: string | null;
}) {
  const { address, ready, connect, switchChain, available } = useWallet();
  const budget = BigInt(offer.budget);
  const [disputeWindow, setDisputeWindow] = useState<bigint | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [bnb, setBnb] = useState<bigint | null>(null);
  const [at, setAt] = useState(-1);
  const [jobId, setJobId] = useState<bigint | null>(null);
  // Each step's transaction, by the step's own number: a skipped approval must not shift the ones after it.
  const [txs, setTxs] = useState<Partial<Record<number, Hash>>>({});
  const [doneSteps, setDoneSteps] = useState<number[]>([]);
  const [failedAt, setFailedAt] = useState<number | null>(null);
  /*
    What is already on chain, kept across a retry. A buyer who rejects step
    three has an open job already; trying again carries on from step three on
    that job rather than opening, and paying gas for, a second one.
  */
  const progress = useRef<{
    id: bigint | null;
    expiredAt: bigint | null;
    steps: Set<number>;
    /** An outside agent's live quote: who to name, what to fund, the description it signed, and until when it stands. */
    quote: { provider: Address; price: bigint; description: string; expiresAt: number | null } | null;
    /** A price the buyer has seen and accepted, when the live quote differs from the listed one. */
    accepted: bigint | null;
  }>({ id: null, expiredAt: null, steps: new Set(), quote: null, accepted: null });
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<{ status: string; deliverableUrl: string | null; submitTx?: string | null; answer?: unknown; verified?: boolean | null } | null>(null);
  const [fundTx, setFundTx] = useState<Hash | null>(null);

  useEffect(() => {
    marketClient
      .readContract({ address: ESCROW.policy, abi: POLICY_ABI, functionName: "disputeWindow" })
      .then((w) => setDisputeWindow(BigInt(w)))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!address) return;
    marketClient
      .readContract({ address: ESCROW.paymentToken, abi: TOKEN_ABI, functionName: "balanceOf", args: [address] })
      .then(setBalance)
      .catch(() => undefined);
    marketClient.getBalance({ address }).then(setBnb).catch(() => undefined);
  }, [address]);

  const outside = Boolean(offer.outside);
  // After funding, the job is read back until the agent's submission shows.
  const poll = useCallback(async (id: bigint) => {
    for (let i = 0; i < 60; i++) {
      const r = await fetch(`/api/escrow/jobs/${id}`, { cache: "no-store" }).then((x) => x.json()).catch(() => null);
      const d = r?.data;
      if (d) {
        setJob({ status: d.status, deliverableUrl: d.deliverableUrl, submitTx: d.record?.submitTx ?? null, answer: d.sellerAnswer ?? null, verified: d.sellerVerified ?? null });
        // An outside seller can submit before its answer reaches us; wait for both.
        // An outside agent's answer counts once it is verified against its on-chain hash, or after two minutes of trying.
        if (d.status !== "FUNDED" && (!outside || d.sellerVerified || (d.sellerAnswer && i > 24))) return;
      }
      await new Promise((ok) => setTimeout(ok, 5_000));
    }
  }, [outside]);

  const run = async () => {
    if (!address || disputeWindow === null) return;
    setError(null);
    setFailedAt(null);
    const d = progress.current;
    let current = -1;
    const step = async (i: number, fn: () => Promise<Hash>) => {
      current = i;
      setAt(i);
      const h = await fn();
      d.steps.add(i);
      setDoneSteps([...d.steps]);
      setTxs((t) => ({ ...t, [i]: h }));
      return h;
    };
    try {
      d.expiredAt ??= BigInt(Math.floor(Date.now() / 1000)) + disputeWindow + BigInt(DELIVERY_SECONDS);
      const about = subject ?? address;
      /*
        An outside agent is asked for its price again now, not from the census:
        an agent on BNB's SDK signs a quote that lasts minutes, and refuses a
        job whose description does not carry it. A price above the one shown
        is put to the buyer before anything is signed.
      */
      if (offer.outside && d.id === null) {
        setAt(0);
        const r = await fetch("/api/escrow/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenId: offer.tokenId, inputs }) });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j?.data) throw new Error(j?.error ?? "The agent's seller did not quote just now.");
        const live = { provider: j.data.provider as Address, price: BigInt(j.data.price), description: String(j.data.description), expiresAt: j.data.expiresAt ?? null };
        if (live.price > budget && d.accepted !== live.price) {
          d.accepted = live.price;
          setAt(-1);
          setError(`The seller's price is now ${formatUnits(live.price, 18)} $U. Press the button again to accept it.`);
          return;
        }
        d.quote = live;
      }
      const cost = d.quote?.price ?? budget;
      const provider = d.quote?.provider ?? (offer.provider as Address);
      // An outside seller reads its task from the description; ours is the line any indexer can match.
      const description = d.quote?.description ?? (offer.outside ? outsideDescription(offer.outside.serviceName ?? offer.name, offer.outside.service, inputs) : `${VIA}: ${offer.name} (ERC-8004 #${offer.tokenId}) for ${about}`);
      if (d.id === null) {
        const created = await step(0, () =>
          sendMarketTx(address, "createJob", [provider, ESCROW.router, d.expiredAt, description, ESCROW.router], undefined, undefined, { address: ESCROW.commerce, abi: COMMERCE_ABI }),
        );
        const receipt = await marketClient.getTransactionReceipt({ hash: created });
        const log = parseEventLogs({ abi: COMMERCE_ABI, eventName: "JobCreated", logs: receipt.logs })[0];
        if (!log) throw new Error("The job opened, but its number could not be read from the receipt.");
        d.id = log.args.jobId;
        setJobId(d.id);
      }
      const id = d.id;
      if (!d.steps.has(1)) await step(1, () => sendMarketTx(address, "registerJob", [id, ESCROW.policy], undefined, undefined, { address: ESCROW.router, abi: ROUTER_ABI }));
      if (!d.steps.has(2)) await step(2, () => sendMarketTx(address, "setBudget", [id, cost, "0x"], undefined, undefined, { address: ESCROW.commerce, abi: COMMERCE_ABI }));
      if (!d.steps.has(3)) {
        const allowance = (await marketClient.readContract({ address: ESCROW.paymentToken, abi: TOKEN_ABI, functionName: "allowance", args: [address, ESCROW.commerce] })) as bigint;
        if (allowance < cost) {
          await step(3, () => sendMarketTx(address, "approve", [ESCROW.commerce, cost], undefined, undefined, { address: ESCROW.paymentToken, abi: TOKEN_ABI }));
        } else {
          // Already approved for at least the budget: nothing to sign.
          d.steps.add(3);
          setDoneSteps([...d.steps]);
        }
      }
      /*
        A signed quote stands for minutes, and the agent checks it at the block
        the job is funded in. Funding after it lapses would lock the budget in
        a job the agent will refuse, so the flow stops here and starts over
        with a fresh quote instead; the unfunded job simply lapses.
      */
      if (d.quote?.expiresAt && Math.floor(Date.now() / 1000) > d.quote.expiresAt - 20) {
        progress.current = { id: null, expiredAt: null, steps: new Set(), quote: null, accepted: null };
        setDoneSteps([]);
        setTxs({});
        setJobId(null);
        throw new Error("The agent's signed quote ran out before the job was funded, so it was not funded. Try again for a fresh quote.");
      }
      const funded = await step(4, () => sendMarketTx(address, "fund", [id, cost, "0x"], undefined, undefined, { address: ESCROW.commerce, abi: COMMERCE_ABI }));
      setAt(5);
      setFundTx(funded);
      await fetch("/api/escrow/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(offer.outside ? { jobId: id.toString(), tx: funded, subject, tokenId: offer.tokenId, inputs } : { jobId: id.toString(), tx: funded, subject }),
      });
      void poll(id);
    } catch (e) {
      // A lapsed quote starts the job over, so the retry begins at step one.
      setFailedAt(progress.current.steps.size === 0 ? 0 : current);
      // Until the fund step confirms, no token has left the buyer's wallet, whatever else was signed.
      setError(`${(e as Error).message.slice(0, 200)} Nothing has left your wallet.`);
    }
  };

  const short = formatUnits(budget, 18);
  const who = offer.outside ? offer.name : "our agent";
  const eta = offer.outside?.etaSeconds ? `in about ${Math.max(1, Math.round(offer.outside.etaSeconds / 60))} minutes` : "within minutes";
  const delivered = job?.status === "SUBMITTED" || job?.status === "COMPLETED";
  if (!available)
    return (
      <div className="x-escrow">
        <p className="x-escrow__note">A wallet is needed: the escrow is funded from it.</p>
        <OpenInWallet />
      </div>
    );
  if (!address)
    return (
      <button type="button" className="x-btn x-btn--block" onClick={connect}>
        Connect a wallet
      </button>
    );
  if (!ready)
    return (
      <button type="button" className="x-btn x-btn--block" onClick={switchChain}>
        Switch to BNB Smart Chain
      </button>
    );

  return (
    <div className="x-escrow">
      <p className="x-escrow__note">
        {short} $U goes into the ERC-8183 escrow, not to {offer.outside ? "the seller or to us" : "us"}. {offer.name} delivers {eta}; the $U is released to it{" "}
        {disputeWindow === null ? "after the dispute window" : `${days(disputeWindow)} after it delivers`} unless you dispute, and comes back to you if it does not deliver
        within {DELIVERY_SECONDS / 60} minutes.
      </p>
      <ol className="x-escrow__steps">
        {STEPS.map((s, i) => (
          <li
            key={s}
            className={doneSteps.includes(i) || at >= 5 ? "x-escrow__done" : i === failedAt ? "x-escrow__failed" : i === at ? "x-escrow__now" : undefined}
          >
            {doneSteps.includes(i) || at >= 5 ? (
              <Check size={14} aria-hidden="true" />
            ) : i === failedAt ? (
              <X size={14} aria-hidden="true" />
            ) : i === at ? (
              <Loader2 size={14} className="x-spin" aria-hidden="true" />
            ) : (
              <span className="x-escrow__n">{i + 1}</span>
            )}
            {s}
            {txs[i] ? (
              <a className="x-link x-mono" href={`https://bscscan.com/tx/${txs[i]}`} target="_blank" rel="noreferrer">
                {txs[i]!.slice(0, 8)}…
              </a>
            ) : null}
          </li>
        ))}
      </ol>
      {failedAt !== null ? (
        <>
          {error ? <p className="x-escrow__err">{error}</p> : null}
          <button type="button" className="x-btn x-btn--primary x-btn--block" onClick={run}>
            Try again from step {failedAt + 1}
          </button>
        </>
      ) : null}
      {at < 0 ? (
        balance !== null && balance < budget ? (
          <p className="x-escrow__err">
            This wallet holds {formatUnits(balance, 18)} $U; the job needs {short}.{" "}
            <a className="x-link" href={`https://pancakeswap.finance/swap?chain=bsc&outputCurrency=${ESCROW.paymentToken}`} target="_blank" rel="noreferrer">
              Get $U on PancakeSwap
            </a>
          </p>
        ) : bnb !== null && bnb < GAS_FOR_FIVE ? (
          <p className="x-escrow__err">
            This wallet holds {formatUnits(bnb, 18)} BNB. About 0.0001 BNB of gas covers the five steps; add a little BNB on BNB Smart Chain first.
          </p>
        ) : (
          <button type="button" className="x-btn x-btn--primary x-btn--block" onClick={run} disabled={disputeWindow === null}>
            Fund the job, {short} $U
          </button>
        )
      ) : null}
      {jobId !== null && at >= 5 ? (
        <div className="x-escrow__job" role="status">
          <p>
            Job <span className="x-mono">#{jobId.toString()}</span>:{" "}
            {delivered ? "delivered on chain." : `funded. Waiting for ${who} to deliver…`}
          </p>
          {job?.deliverableUrl ? (
            <p>
              <a className="x-link" href={job.deliverableUrl} target="_blank" rel="noreferrer">
                Read what it delivered
              </a>
              {job.submitTx ? (
                <>
                  {" · "}
                  <a className="x-link x-mono" href={`https://bscscan.com/tx/${job.submitTx}`} target="_blank" rel="noreferrer">
                    submission
                  </a>
                </>
              ) : null}
            </p>
          ) : null}
          {job?.answer ? (
            <details className="x-hire__adv" open={delivered}>
              <summary>
                What {offer.name} delivered
                {job.verified ? " · matches the hash it committed on chain" : ""}
              </summary>
              <pre className="x-pre">{JSON.stringify(job.answer, null, 2).slice(0, 6000)}</pre>
            </details>
          ) : null}
          {delivered && fundTx ? <RateAgent tokenId={offer.tokenId} name={offer.name} category={category} hireTx={fundTx} /> : null}
        </div>
      ) : null}
      {error && failedAt === null ? <p className="x-escrow__err">{error}</p> : null}
    </div>
  );
}
