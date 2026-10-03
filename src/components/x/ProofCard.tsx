import Link from "next/link";
import { Check } from "lucide-react";
import { formatUnits } from "viem";
import { CATEGORY_LABEL } from "@/lib/config";
import type { Receipt } from "@/lib/market/receipt";
import AgentSeal from "./AgentSeal";

/**
 * The latest hire, as a certificate: who was hired, for how much, and each
 * transaction from payment to delivery, every one a link to BscScan. It is
 * the front page's proof that the promise above it is kept, so nothing on
 * it is dressed up: a hire paid by one of our own wallets says so.
 */
export default function ProofCard({ receipt }: { receipt: Receipt }) {
  const r = receipt;
  return (
    <figure className="x-proofcard">
      <p className="x-proofcard__k">
        <span className="x-strip__dot" aria-hidden="true" />
        Latest hire · BNB Smart Chain
      </p>
      <div className="x-proofcard__who">
        <AgentSeal tokenId={r.tokenId} name={r.agent} category={r.category} size={44} />
        <div>
          <Link className="x-proofcard__agent" href={`/agents/${r.tokenId}`}>
            {r.agent}
          </Link>
          <p className="x-proofcard__job">
            {r.category ? `${CATEGORY_LABEL[r.category]} · ` : ""}escrowed job{" "}
            <Link className="x-link x-mono" href={`/api/escrow/jobs/${r.jobId}`}>
              #{r.jobId}
            </Link>
          </p>
        </div>
        <p className="x-proofcard__price x-mono">{formatUnits(BigInt(r.budget), 18)} $U</p>
      </div>
      <ol className="x-proofcard__steps">
        {r.steps.map((st) => (
          <li key={st.tx}>
            <Check size={14} strokeWidth={2.5} aria-hidden="true" />
            <span>{st.label}</span>
            <a className="x-link x-mono" href={`https://bscscan.com/tx/${st.tx}`} target="_blank" rel="noreferrer">
              {st.tx.slice(0, 6)}…{st.tx.slice(-4)}
            </a>
          </li>
        ))}
        {r.verified ? (
          <li>
            <Check size={14} strokeWidth={2.5} aria-hidden="true" />
            <span>Its answer matches the hash it committed</span>
          </li>
        ) : null}
      </ol>
      <figcaption className="x-proofcard__note">
        {r.deliveredInSeconds !== null ? `Delivered ${r.deliveredInSeconds} s after payment. ` : ""}
        {r.team ? "Paid from one of our own wallets: a real mainnet hire, never counted toward the quest." : "Paid by a buyer from their own wallet."}
      </figcaption>
    </figure>
  );
}
