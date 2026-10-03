import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CATEGORY_LABEL, type Category } from "@/lib/config";
import { CATEGORY_PITCH, type CategoryStats } from "@/lib/market/catalogue";
import AgentArtwork from "./AgentArtwork";
import { priceUsd } from "./Price";

/**
 * One of the four jobs, as a place. Each has its own ground colour and its own
 * instrument, so a returning visitor recognises the category before reading
 * its name. The counts are the same predicates the marketplace filters use.
 */
export default function CategoryTile({ category, s }: { category: Category; s: CategoryStats }) {
  const short = CATEGORY_LABEL[category].split(" ")[0];
  return (
    <Link href={`/agents?category=${category}`} className={`x-world x-world--${category}`}>
      <span className="x-world__art" aria-hidden="true">
        <AgentArtwork category={category} seed={`world:${category}`} />
      </span>
      <span className="x-world__body">
        <span className="x-world__t">{CATEGORY_LABEL[category]}</span>
        <span className="x-world__p">{CATEGORY_PITCH[category]}</span>
        <span className="x-world__stats">
          <span>
            <strong className="x-mono">{s.live}</strong> live
          </span>
          <span>
            <strong className="x-mono">{s.hireable}</strong> hireable
          </span>
          <span>{s.from !== null ? <>from <strong className="x-mono">{priceUsd(s.from)}</strong></> : "price varies"}</span>
        </span>
        <span className="x-world__go">
          Explore {short.toLowerCase()} <ArrowRight size={15} aria-hidden="true" />
        </span>
      </span>
    </Link>
  );
}
