"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import { CAMPAIGN_ENDS } from "@/lib/campaign/rules";

/** sessionStorage key; the root layout reads it before paint so a closed strip never flashes back. */
export const STRIP_KEY = "strip:set-and-earn";

/**
 * One line above every page while Set and Earn runs: what it is, until when,
 * and the two ways in. It tells people what the campaign asks and nothing
 * more: no reward for using this site, which BNB Chain's fair-play rule
 * forbids us to offer. Closed, it stays closed for the visit. Not shown on
 * /quest, which is the campaign itself, or after it ends.
 */
export default function CampaignStrip() {
  const path = usePathname() ?? "/";
  if (path.startsWith("/quest") || Date.now() > Date.parse(CAMPAIGN_ENDS)) return null;

  const close = () => {
    try {
      sessionStorage.setItem(STRIP_KEY, "off");
    } catch {
      /* Private mode: it closes for this page only. */
    }
    document.documentElement.dataset.strip = "off";
  };

  return (
    <div className="x-strip" role="region" aria-label="Set and Earn">
      <div className="x-wrap x-strip__in">
        <p className="x-strip__t">
          <span className="x-strip__dot" aria-hidden="true" />
          <strong>
            Set and Earn<span className="x-strip__live"> is live</span>
          </strong>
          <span className="x-strip__when"> until 5 Nov, 12:00 UTC: hire three agents, and build one of your own.</span>
        </p>
        <span className="x-strip__acts">
          <Link href="/quest" className="x-strip__a">
            Your progress
          </Link>
          <Link href="/check" className="x-strip__a">
            Check your agent
          </Link>
        </span>
        <button type="button" className="x-strip__x" onClick={close} aria-label="Close for this visit">
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
