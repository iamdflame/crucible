"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Check } from "lucide-react";
import HireDrawer, { type HireOffer } from "@/components/x/HireDrawer";
import OpenInWallet from "@/components/x/OpenInWallet";
import NeedHelp from "@/components/x/NeedHelp";
import HirePack, { type PackAgent } from "@/components/x/HirePack";
import { useWallet } from "@/lib/chain/wallet";

export interface QuestCard {
  category: string;
  label: string;
  others: number;
  offer: HireOffer | null;
  price: string | null;
  ours: boolean;
}

interface Counted {
  agentId: string;
  agentName: string | null;
  category: string | null;
  tx: string | null;
}

interface Progress {
  team: boolean;
  hired: Counted[];
  listed: number;
  best: { agentId: string; name: string | null; rung: number; rungName: string } | null;
}

/** BNB Chain's Set and Earn rules, as its campaign page states them. */
export interface Campaign {
  hires: number;
  marketplaces: number;
  register: string;
  page: string;
  ends: string;
}

const short = (tx: string) => `${tx.slice(0, 8)}…${tx.slice(-4)}`;

/**
 * Set and Earn for the connected wallet, by BNB Chain's rules: register the
 * wallet, hire three different agents across at least two shortlisted
 * marketplaces, and build one agent of your own. Progress here is what
 * MANDATE can confirm from the chain: different agents this wallet paid for
 * here, and its own agents listed here. Re-read while the page is open, since
 * a hire is confirmed a few seconds after it is answered.
 */
export default function QuestBoard({ cards, campaign, pack }: { cards: QuestCard[]; campaign: Campaign; pack?: PackAgent[] | null }) {
  const { address, available, connect } = useWallet();
  const [p, setP] = useState<Progress | null>(null);

  const read = useCallback(async () => {
    if (!address) {
      setP(null);
      return;
    }
    try {
      const q = await fetch(`/api/v1/quest/${address}`, { cache: "no-store" }).then((r) => r.json());
      setP({
        team: Boolean(q?.data?.team),
        hired: (q?.data?.agentsHired ?? []) as Counted[],
        listed: Number(q?.data?.agentsListed ?? 0),
        best: q?.data?.bestAgent ?? null,
      });
    } catch {
      /* the last reading stands */
    }
  }, [address]);

  useEffect(() => {
    void read();
  }, [read]);
  useEffect(() => {
    if (!address) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void read();
    }, 15_000);
    return () => clearInterval(t);
  }, [address, read]);

  const hiredHere = p && !p.team ? p.hired.length : 0;
  const built = Boolean(p && p.listed > 0);
  // Two of the three can be here; the third has to be on another shortlisted marketplace.
  const roomHere = campaign.hires - (campaign.marketplaces - 1);
  const hiredCategories = new Set((p?.hired ?? []).map((h) => h.category));

  return (
    <div className="x-quest">
      {/* First on the screen, because most people arrive here to hire: two of the three, in one confirmation. */}
      {pack && pack.length >= 2 ? <HirePack agents={pack} /> : null}

      <div className="x-quest__bar" role="status">
        {address && p ? (
          <>
            <p className="x-quest__count">
              <span className="x-mono">{Math.min(hiredHere, campaign.hires)}</span> of {campaign.hires} different agents hired here
              {built ? ", your agent listed" : ""}
            </p>
            <div className="x-quest__meter" aria-hidden="true">
              {Array.from({ length: campaign.hires + 1 }, (_, i) => (
                <span key={i} className={(i < campaign.hires ? i < hiredHere : built) ? "x-quest__seg x-quest__seg--on" : "x-quest__seg"} />
              ))}
            </div>
            {p.team ? <p className="x-quest__note">This is one of MANDATE&apos;s own wallets, so it never counts toward the campaign.</p> : null}
          </>
        ) : address ? (
          <p className="x-quest__count">Reading your hires from the chain…</p>
        ) : (
          <>
            <p className="x-quest__count">Connect your campaign wallet to see your progress.</p>
            {available ? (
              <button type="button" className="x-btn x-btn--primary" onClick={connect}>
                Connect wallet
              </button>
            ) : (
              <div className="x-quest__note">
                <OpenInWallet />
              </div>
            )}
          </>
        )}
      </div>

      <ol className="x-quest__steps">
        <li className="x-quest__step">
          <p className="x-quest__n x-mono">1</p>
          <div>
            <h2 className="x-quest__label">Register your campaign wallet</h2>
            <p className="x-quest__agent">
              With BNB Chain, before anything else: your name, the one wallet you will use, and a public GitHub. Actions from a wallet that is not registered are not
              counted.
            </p>
            <a className="x-btn x-btn--sm" href={campaign.register} target="_blank" rel="noreferrer">
              Register with BNB Chain
            </a>
          </div>
        </li>
        <li className={hiredHere >= roomHere ? "x-quest__step x-quest__step--done" : "x-quest__step"}>
          <p className="x-quest__n x-mono">{hiredHere >= roomHere ? <Check size={14} strokeWidth={3} aria-label="Done here" /> : 2}</p>
          <div>
            <h2 className="x-quest__label">
              Hire {campaign.hires} different agents, on at least {campaign.marketplaces} marketplaces
            </h2>
            <p className="x-quest__agent">
              MANDATE is one of the shortlisted marketplaces: up to {roomHere} of your hires can be here, and at least one has to be on another (they are listed on{" "}
              <a className="x-link" href={campaign.page} target="_blank" rel="noreferrer">
                BNB Chain&apos;s campaign page
              </a>
              ). Each hire has to be of a different agent, paid from your campaign wallet.
            </p>
            {p && p.hired.length ? (
              <ul className="x-quest__hired">
                {p.hired.map((h) => (
                  <li key={h.agentId} className="x-quest__done">
                    <Check size={13} strokeWidth={3} aria-hidden="true" /> {h.agentName ?? `#${h.agentId}`}
                    {h.tx ? (
                      <>
                        {" · "}
                        <a className="x-link x-mono" href={`https://bscscan.com/tx/${h.tx}`} target="_blank" rel="noreferrer">
                          {short(h.tx)}
                        </a>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </li>
        <li className={built ? "x-quest__step x-quest__step--done" : "x-quest__step"}>
          <p className="x-quest__n x-mono">{built ? <Check size={14} strokeWidth={3} aria-label="Listed" /> : 3}</p>
          <div>
            <h2 className="x-quest__label">Build one agent of your own</h2>
            <p className="x-quest__agent">
              Registered on ERC-8004 from your campaign wallet and listed here. BNB Chain checks it after the campaign: a card stating its job, live when called,
              hired by three wallets that are not yours, and at least five onchain actions on three different days that fit its job. An agent that only answers does
              not count.
            </p>
            {built && p?.best ? (
              <p className="x-quest__done">
                {p.best.name ?? `#${p.best.agentId}`} is listed here, on the {p.best.rungName} rung.
              </p>
            ) : p?.best ? (
              <p className="x-quest__agent">#{p.best.agentId} is registered, but its card does not parse yet, so it has no name here.</p>
            ) : null}
            <span className="x-quest__acts">
              <Link className="x-btn x-btn--sm x-btn--primary" href={p?.best ? `/check?q=${p.best.agentId}` : address ? `/check?q=${address}` : "/check"}>
                {p?.best ? "Check it against the six" : "Check your agent"}
              </Link>
              <Link className="x-btn x-btn--sm" href="/build">
                Build and list one
              </Link>
            </span>
          </div>
        </li>
      </ol>

      <h2 className="x-quest__h">Agents you can hire here</h2>
      <ol className="x-quest__jobs">
        {cards.map((c) => {
          const hired = hiredCategories.has(c.category);
          const hash = `#hire-${c.category}`;
          return (
            <li key={c.category} className={hired ? "x-quest__job x-quest__job--done" : "x-quest__job"}>
              <h3 className="x-quest__label">{c.label}</h3>
              {c.offer ? (
                <>
                  <p className="x-quest__agent">
                    <Link className="x-link" href={`/agents/${c.offer.tokenId}`}>
                      {c.offer.name}
                    </Link>
                    {c.ours ? <span className="x-tag">Ours</span> : null}
                  </p>
                  {c.price ? <p className="x-quest__price">{c.price}</p> : null}
                  <a className={hired ? "x-btn x-btn--block" : "x-btn x-btn--primary x-btn--block"} href={hash}>
                    Hire
                  </a>
                  {c.others ? (
                    <Link className="x-quest__alt" href={`/agents?category=${c.category}&hireable=1`}>
                      or one of {c.others} other{c.others === 1 ? "" : "s"}
                    </Link>
                  ) : null}
                  <HireDrawer offer={c.offer} openOn={hash} onDone={read} />
                </>
              ) : (
                <p className="x-quest__none">Nobody can be hired for this job right now.</p>
              )}
            </li>
          );
        })}
      </ol>

      <NeedHelp />
      <p className="x-quest__fine">
        Counted here from hires your own wallet paid on MANDATE, once the chain confirms them, each of a different agent and never of an agent you own. Calls MANDATE
        pays for do not count. Hires on other marketplaces, and your agent&apos;s own checks, are counted by BNB Chain from the chain; its determination is final.
        The campaign runs to {new Date(campaign.ends).toUTCString().slice(5, 16)}, 12:00 UTC. The same record answers at{" "}
        <span className="x-mono">/api/v1/quest/{"{address}"}</span>.
      </p>
    </div>
  );
}
