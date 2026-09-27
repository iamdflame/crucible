"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { formatEther } from "viem";
import CategoryMark from "@/components/v2/marks/CategoryMark";
import { CATEGORIES, CATEGORY_LABEL } from "@/lib/config";
import { marketChain } from "@/lib/chain/market";
import { useWallet, sendMarketTx, CANONICAL_TARGET, type TxState } from "@/lib/chain/wallet";
import { marketClient } from "@/lib/chain/market";
import type { MarketMandate, MarketBid } from "@/lib/market/market-state";

/**
 * Everything you have hired, and the one thing each job is waiting on.
 *
 * The product could open a mandate and take bids on it and then had no way of
 * ever accepting one, `award` is the only call that moves a job from Open to
 * Active and it existed nowhere in the interface. So a person could commit
 * capital, watch an agent post a bond against it, and reach a dead end. That
 * is the criterion being judged, worded almost exactly.
 *
 * The rule this screen follows: every row states what is true and offers the
 * single next action, and where no action is possible it says what is being
 * waited for and roughly how long.
 */

const NATIVE = "0x0000000000000000000000000000000000000000" as const;

const STATE_NAME = ["Waiting for an agent", "Running", "Finished", "Cancelled", "Ended early"] as const;

const bnb = (wei: string, dp = 5) => `${Number(formatEther(BigInt(wei))).toFixed(dp)} BNB`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function Dashboard() {
  const { address, ready, available, connect, switchChain } = useWallet();
  const [rows, setRows] = useState<MarketMandate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<TxState>({ phase: "idle" });
  const [busyId, setBusyId] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/market/state", { cache: "no-store" });
      const body = (await res.json()) as { mandates?: MarketMandate[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `The market answered ${res.status}.`);
      setRows(body.mandates ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The market could not be read.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // What the contract holds for this wallet, so a withdraw button is offered only when there is something to withdraw.
  const [owed, setOwed] = useState<bigint | null>(null);
  const readOwed = useCallback(async () => {
    if (!address) return setOwed(null);
    const v = await marketClient
      .readContract({ address: CANONICAL_TARGET.address, abi: CANONICAL_TARGET.abi, functionName: "withdrawable", args: [NATIVE, address] } as never)
      .catch(() => null);
    setOwed(typeof v === "bigint" ? v : null);
  }, [address]);
  useEffect(() => {
    void readOwed();
  }, [readOwed, rows]);

  const mine = useMemo(() => {
    if (!rows || !address) return null;
    const me = address.toLowerCase();
    return rows.filter((r) => r.principal.toLowerCase() === me || r.agent.toLowerCase() === me);
  }, [rows, address]);

  /* ----------------------------------------------------------- actions -- */

  const award = async (m: MarketMandate, bid: MarketBid) => {
    if (!address) return;
    setBusyId(m.id);
    setNote("Valuing the agent's wallet so there is a fixed starting point…");
    try {
      const res = await fetch(`/api/market/opening?agent=${bid.agent}`);
      const o = (await res.json()) as Record<string, string> & { error?: string };
      if (!res.ok) throw new Error(o.error ?? "The opening mark could not be built.");
      setNote(null);
      await sendMarketTx(
        address,
        "award",
        [
          BigInt(m.id),
          BigInt(bid.index),
          {
            wallet: o.wallet,
            valuationWei: BigInt(o.valuationWei),
            gasSpentWei: BigInt(o.gasSpentWei),
            priceX96: BigInt(o.priceX96),
            blockNumber: BigInt(o.blockNumber),
            breakdownRef: o.breakdownRef,
            benchmarkWei: BigInt(o.benchmarkWei),
          },
        ],
        undefined,
        setTx,
      );
      await load();
    } catch (e) {
      setNote(null);
      setTx({ phase: "failed", error: e instanceof Error ? e.message : "The award failed." });
    } finally {
      setBusyId(null);
    }
  };

  const cancel = async (m: MarketMandate) => {
    if (!address) return;
    setBusyId(m.id);
    try {
      await sendMarketTx(address, "closeMandate", [BigInt(m.id)], undefined, setTx);
      await load();
    } catch {
      /* the phase carries it */
    } finally {
      setBusyId(null);
    }
  };

  const withdraw = async () => {
    if (!address) return;
    try {
      await sendMarketTx(address, "withdraw", [NATIVE], undefined, setTx);
      await load();
    } catch {
      /* the phase carries it */
    }
  };

  /* ------------------------------------------------------------- gates -- */

  if (!available) {
    return (
      <div className="m-gate">
        <p className="m-gate__why">
          This page reads the market for your address, and there is no wallet in
          this browser to read it for. Nothing is stored on our side, your jobs
          live on chain against your address.
        </p>
        <a className="m-btn" href="https://www.bnbchain.org/en/wallets" target="_blank" rel="noreferrer">
          Get a wallet for BNB Chain →
        </a>
      </div>
    );
  }

  if (!address) {
    return (
      <div className="m-gate">
        <p className="m-gate__why">
          Connect a wallet to see the jobs you have opened. Connecting reveals your
          address and nothing else.
        </p>
        <button className="m-btn m-btn--primary" type="button" onClick={() => void connect()}>
          Connect wallet →
        </button>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="m-gate">
        <p className="m-gate__why">
          Your wallet is on another network, so the market cannot be read for it.
        </p>
        <button className="m-btn m-btn--primary" type="button" onClick={() => void switchChain()}>
          Switch to {marketChain.name} →
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="m-absent">
        <p className="m-absent__t">The market could not be read just now.</p>
        <p className="m-small">{error}</p>
        <button className="m-btn m-btn--sm" type="button" onClick={() => void load()} style={{ marginTop: "0.8rem" }}>
          Try again
        </button>
      </div>
    );
  }

  if (!mine) return <p className="m-small">Reading the market…</p>;

  if (mine.length === 0) {
    return (
      <div className="m-absent">
        <p className="m-absent__t">You have not hired anything yet.</p>
        <p className="m-small">
          Nothing is stored against your account here because there is no account 
          this page just asks the chain what jobs exist for {short(address)}.
        </p>
        <Link className="m-btn m-btn--primary" href="/agents" style={{ marginTop: "1rem" }}>
          Browse agents →
        </Link>
      </div>
    );
  }

  return (
    <div className="m-stack m-stack--lg">
      {tx.phase === "failed" ? <p className="m-error">{tx.error}</p> : null}
      {tx.phase === "confirmed" ? (
        <p className="m-ok">
          Done.{" "}
          <a
            className="m-link"
            href={`${marketChain.blockExplorers?.default.url}/tx/${tx.hash}`}
            target="_blank"
            rel="noreferrer"
          >
            View the transaction
          </a>
        </p>
      ) : null}
      {note ? <p className="m-small">{note}</p> : null}

      {mine.map((m) => {
        const asPrincipal = m.principal.toLowerCase() === address.toLowerCase();
        const live = m.bids.filter((b) => !b.spent);
        const category = CATEGORIES[m.category] ?? null;
        const busy = busyId === m.id || tx.phase === "signing" || tx.phase === "pending";

        return (
          <article className="m-job" key={`${m.deployment}-${m.id}`}>
            <header className="m-job__head">
              <div className="m-cluster">
                {category ? <CategoryMark category={category} size={32} /> : null}
                <div>
                  <h3 className="m-h3">
                    {category ? CATEGORY_LABEL[category] : "Mandate"} · #{m.id}
                  </h3>
                  <p className="m-note">
                    {asPrincipal ? "You opened this" : "You are the agent on this"} ·{" "}
                    {m.deployment}
                    {m.canonical ? "" : " (an earlier deployment, read only)"}
                  </p>
                </div>
              </div>
              <span className={`m-tag${m.state === 1 ? " m-tag--verified" : ""}`}>
                {STATE_NAME[m.state] ?? `State ${m.state}`}
              </span>
            </header>

            <dl className="m-kv m-job__kv">
              <div>
                <dt>Capital committed</dt>
                <dd className="m-fig">{bnb(m.capitalWei)}</dd>
              </div>
              <div>
                <dt>Agent&rsquo;s bond at risk</dt>
                <dd className="m-fig">{m.bondWei === "0" ? "none yet" : bnb(m.bondWei)}</dd>
              </div>
              <div>
                <dt>Progress</dt>
                <dd className="m-fig">
                  {m.epochsSettled} of {m.epochsTotal} hours settled
                </dd>
              </div>
              <div>
                <dt>Ahead of the benchmark by</dt>
                <dd className="m-fig">
                  {m.epochsSettled === 0
                    ? "nothing settled yet"
                    : `${(m.cumulativeAlphaBps / 100).toFixed(2)}%`}
                </dd>
              </div>
              {m.strikes > 0 ? (
                <div>
                  <dt>Strikes against the agent</dt>
                  <dd className="m-fig">{m.strikes}</dd>
                </div>
              ) : null}
            </dl>

            {/* ------------------------------------------- what happens next */}
            {/*
              Rows from a superseded contract are read-only, and the button is
              absent rather than disabled.

              Every write on this page is addressed to the canonical market, so
              offering `closeMandate` on a v0 or v1 row would send it to v2,
              where the same id is a different job. It would revert if we were
              lucky and close somebody else's mandate if we were not. The
              correct control here is a sentence.
            */}
            {!m.canonical ? (
              <div className="m-job__act">
                <p className="m-small">
                  This job lives on {m.deployment}, a contract we have since
                  replaced. It is still readable and still counted, and it is left
                  alone: nothing here writes to a superseded market.
                </p>
              </div>
            ) : m.state === 0 && asPrincipal ? (
              live.length ? (
                <div className="m-job__act">
                  <p className="m-label">
                    {live.length} {live.length === 1 ? "agent wants" : "agents want"} this job
                  </p>
                  <p className="m-small" style={{ margin: "0.5rem 0 1rem" }}>
                    Accepting one starts the term and locks your capital for it. The
                    agent&rsquo;s wallet is valued at that moment so there is a fixed
                    starting point to measure against.
                  </p>
                  <ul className="m-bids">
                    {live.map((b) => (
                      <li className="m-bid" key={b.index}>
                        <div>
                          <p className="m-small">
                            <span className="m-mono">{short(b.agent)}</span> will beat the
                            benchmark by{" "}
                            <strong>{(b.targetAlphaBps / 100).toFixed(2)}% an hour</strong>
                          </p>
                          <p className="m-note">
                            Backing it with {bnb(b.bondWei)} of its own money
                          </p>
                        </div>
                        <button
                          className="m-btn m-btn--primary m-btn--sm"
                          type="button"
                          disabled={busy}
                          onClick={() => void award(m, b)}
                        >
                          {busy ? "Working…" : "Accept this bid →"}
                        </button>
                      </li>
                    ))}
                  </ul>
                  <button
                    className="m-btn m-btn--sm m-btn--quiet"
                    type="button"
                    disabled={busy}
                    onClick={() => void cancel(m)}
                    style={{ marginTop: "1rem" }}
                  >
                    Cancel and take my capital back
                  </button>
                </div>
              ) : (
                <div className="m-job__act">
                  <p className="m-small">
                    No agent has bid yet. An agent has to post at least{" "}
                    {bnb((BigInt(m.capitalWei) / 5n).toString())} of its own money to bid,
                    which is why this is not instant.
                  </p>
                  <button
                    className="m-btn m-btn--sm"
                    type="button"
                    disabled={busy}
                    onClick={() => void cancel(m)}
                    style={{ marginTop: "0.9rem" }}
                  >
                    Cancel and take my capital back
                  </button>
                </div>
              )
            ) : null}

            {m.canonical && m.state === 1 ? (
              <div className="m-job__act">
                <p className="m-small">
                  Running. <span className="m-mono">{short(m.agent)}</span> holds this job
                  and is marked against the benchmark every hour. It ends after{" "}
                  {m.epochsTotal} hours, or earlier if it takes too many strikes.
                </p>
              </div>
            ) : null}

            {m.canonical && m.state >= 2 && owed !== 0n ? (
              <div className="m-job__act">
                <p className="m-small">
                  This job is over. Anything owed to you is held in the contract until
                  you withdraw it.
                </p>
                <button
                  className="m-btn m-btn--sm m-btn--primary"
                  type="button"
                  disabled={busy}
                  onClick={() => void withdraw()}
                  style={{ marginTop: "0.9rem" }}
                >
                  Withdraw what I am owed
                </button>
              </div>
            ) : null}
          </article>
        );
      })}

      <div className="m-panel m-panel--sunken">
        <p className="m-label">Anything the contract still owes you</p>
        <p className="m-small" style={{ margin: "0.6rem 0 1rem" }}>
          Capital from cancelled or finished jobs is credited to your address inside
          the contract rather than pushed to your wallet, so a failing transfer can
          never strand it. This claims all of it in BNB.
        </p>
        {owed === 0n ? (
          <p className="m-small">Nothing is owed to this wallet right now.</p>
        ) : (
          <button className="m-btn" type="button" onClick={() => void withdraw()}>
            {owed ? `Withdraw ${bnb(owed.toString())} →` : "Withdraw →"}
          </button>
        )}
      </div>
    </div>
  );
}
