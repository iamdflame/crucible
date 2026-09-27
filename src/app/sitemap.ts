import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";
import { listings } from "@/lib/market/listing";
import { live } from "@/lib/data/live";

export const revalidate = 3600;

const PAGES = ["", "/agents", "/quest", "/build", "/leash", "/alerts", "/standard", "/help", "/categories", "/activity", "/desk", "/list", "/jobs", "/trust", "/proof", "/graveyard", "/contracts", "/status", "/pool-gaps", "/api", "/brand"];

/** The pages, and every agent listed under one of the four jobs. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await live().catch(() => undefined);
  const now = new Date();
  return [
    ...PAGES.map((p) => ({ url: `${SITE}${p}`, lastModified: now, changeFrequency: "hourly" as const, priority: p === "" ? 1 : 0.7 })),
    ...listings().map((l) => ({ url: `${SITE}/agents/${l.tokenId}`, lastModified: now, changeFrequency: "daily" as const, priority: 0.5 })),
  ];
}
