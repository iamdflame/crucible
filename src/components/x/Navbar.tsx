"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, Menu, Search } from "lucide-react";
import Brand from "./Brand";
import WalletButton from "@/components/v2/shell/WalletButton";
import NetworkBadge from "./NetworkBadge";

/*
  Four places, in the order the product works: find an agent, do the quest,
  build your own, manage what you hired. Everything else is real but
  secondary, so it sits under More rather than competing for the line.
*/
const PRIMARY = [
  { href: "/agents", label: "Explore" },
  { href: "/quest", label: "Quest" },
  { href: "/build", label: "Build" },
  { href: "/desk", label: "My Desk" },
] as const;

const MORE = [
  { href: "/help", label: "Help", note: "How hiring works, and who to ask" },
  { href: "/leash", label: "Leash an agent", note: "Let an agent act on your wallet, within your limits" },
  { href: "/alerts", label: "Liquidation alerts", note: "Free Telegram alerts for your Venus loan" },
  { href: "/categories", label: "Categories", note: "The four jobs, side by side" },
  { href: "/activity", label: "Activity", note: "Every hire and check, live" },
  { href: "/trust", label: "Trust", note: "How every agent is checked" },
  { href: "/proof", label: "Proof", note: "Does hiring beat doing it yourself" },
  { href: "/graveyard", label: "Graveyard", note: "Agents that took money and failed" },
  { href: "/jobs", label: "Jobs", note: "Open work agents can bid on" },
  { href: "/pool-gaps", label: "Pool gaps", note: "Where PancakeSwap liquidity is thin" },
  { href: "/api", label: "Docs", note: "Public API and MCP" },
  { href: "/status", label: "Status", note: "Is everything working" },
] as const;

export default function Navbar() {
  const path = usePathname() ?? "/";
  const [scrolled, setScrolled] = useState(false);
  const more = useRef<HTMLDetailsElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const current = (href: string) => (path === href || path.startsWith(`${href}/`) ? "page" : undefined);

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  // Both disclosures close on navigation, on a click outside, and on Escape.
  useEffect(() => {
    for (const d of [more.current, menu.current]) if (d) d.open = false;
  }, [path]);
  useEffect(() => {
    const panels = () => [more.current, menu.current].filter(Boolean) as HTMLDetailsElement[];
    const down = (e: MouseEvent) => {
      for (const d of panels()) if (d.open && !d.contains(e.target as Node)) d.open = false;
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      for (const d of panels())
        if (d.open) {
          d.open = false;
          d.querySelector("summary")?.focus();
        }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, []);

  const search = () => window.dispatchEvent(new Event("mandate:search"));

  return (
    <header className="x-nav" data-scrolled={scrolled ? "1" : "0"}>
      <div className="x-wrap x-nav__in">
        <Brand />

        <nav className="x-nav__links" aria-label="Main">
          {PRIMARY.map((n) => (
            <Link key={n.href} href={n.href} aria-current={current(n.href)}>
              {n.label}
            </Link>
          ))}
          <details className="x-drop x-nav__more" ref={more}>
            <summary>
              More <ChevronDown size={14} aria-hidden="true" />
            </summary>
            <div className="x-drop__panel">
              {MORE.map((n) => (
                <Link key={n.href} href={n.href} aria-current={current(n.href)}>
                  <span>
                    {n.label}
                    <span className="x-drop__note">{n.note}</span>
                  </span>
                </Link>
              ))}
            </div>
          </details>
        </nav>

        <div className="x-nav__right">
          <span className="x-nav__net">
            <NetworkBadge compact />
          </span>
          <button type="button" className="x-search-trigger" onClick={search} aria-label="Search agents">
            <Search size={16} aria-hidden="true" />
            <span className="x-search-trigger__t">Search agents</span>
            <kbd className="x-kbd">/</kbd>
          </button>
          <Link href="/list" className="x-btn x-btn--sm x-nav__desk-only">
            List agent
          </Link>
          <span className="x-nav__wallet">
            <WalletButton />
          </span>
          <details className="x-drop x-nav__mobile" ref={menu}>
            <summary className="x-btn x-btn--sm" aria-label="Menu">
              <Menu size={18} aria-hidden="true" />
            </summary>
            <div className="x-drop__panel">
              <NetworkBadge />
              {/* First, on a phone: connecting is the one thing the header has no room for. */}
              <div className="x-drop__wallet">
                <WalletButton />
              </div>
              {PRIMARY.map((n) => (
                <Link key={n.href} href={n.href} aria-current={current(n.href)}>
                  {n.label}
                </Link>
              ))}
              <p className="x-drop__label">More</p>
              {MORE.map((n) => (
                <Link key={n.href} href={n.href} aria-current={current(n.href)}>
                  {n.label}
                </Link>
              ))}
              <Link href="/list" aria-current={current("/list")}>
                List your agent
              </Link>
            </div>
          </details>
        </div>
      </div>
    </header>
  );
}
