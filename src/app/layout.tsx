import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Analytics } from "@vercel/analytics/next";
import Palette from "@/components/shell/Palette";
import Landing from "@/components/x/Landing";
import { SITE } from "@/lib/site";
import "./tokens.css";
import "./globals.css";
import "./theme.css";
import "./market.css";

/*
  The brand's three faces, self-hosted from ./fonts rather than fetched at
  build time: the build used to pull fonts from Google and that fetch timed
  out often enough to fail deploys. Each is a Latin subset of the variable
  font, made by pyftsubset (see tools/brand/README.md), under the OFL.

    Instrument Sans   display: the wordmark, headings, figures that lead
    Inter             text: everything read
    JetBrains Mono    addresses and hashes, nothing else
*/
const display = localFont({ src: "./fonts/InstrumentSans.woff2", variable: "--font-display", weight: "400 700", display: "swap" });
const sans = localFont({ src: "./fonts/Inter.woff2", variable: "--font-sans", weight: "100 900", display: "swap" });
const mono = localFont({ src: "./fonts/JetBrainsMono.woff2", variable: "--font-mono", weight: "100 800", display: "swap" });

/*
  Titles are per route; this is the template and the fallback.

  Deliberately free of a headline count. Every figure on this site is read at
  request time because the registry moved by 1,600 entries in a day while a
  hardcoded number sat here claiming otherwise, and a stale number in a
  <meta> tag is exactly the unverifiable assertion this product objects to.
*/
export const metadata: Metadata = {
  // Every relative link preview and canonical URL resolves against our own address.
  metadataBase: new URL(SITE),
  title: {
    default: "MANDATE | BNB Smart Chain Agent Marketplace",
    template: "%s",
  },
  description:
    "The BNB Chain agent marketplace where every agent is checked on chain before you hire it, and can only take what you sign.",
  applicationName: "MANDATE",
  openGraph: {
    title: "MANDATE | BNB Smart Chain Agent Marketplace",
    description: "Every agent is checked on chain before you pay, and can only take what you sign.",
    type: "website",
    siteName: "MANDATE",
  },
  twitter: { card: "summary_large_image" },
};

/**
 * One ground, in both schemes.
 *
 * The product is struck metal on an anvil; there is no light variant of that,
 * and offering one would put the funnel's blanks on white where they read as
 * missing data rather than as the finding.
 */
export const viewport: Viewport = {
  /* The whole product is one dark ground now, so the browser chrome matches it. */
  themeColor: "#0b0d0e",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // The font variables must land on <html>, not <body>: tokens.css consumes
  // them at :root, and a var() reference to a property defined further down
  // the tree is invalid at that point, which silently drops the page to the
  // browser's default face.
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        {/* A visitor who closed the Set and Earn strip does not see it flash back on the next page (components/x/CampaignStrip). */}
        <script dangerouslySetInnerHTML={{ __html: `try{if(sessionStorage.getItem("strip:set-and-earn")==="off")document.documentElement.dataset.strip="off"}catch(e){}` }} />
      </head>
      <body>
        {children}
        {/* ⌘K, mounted once. It renders nothing until it is opened. */}
        <Palette />
        {/* Where this visit came from, noted once for the hire funnel. Renders nothing. */}
        <Landing />
        {/* Page views only, no cookies: how many people reach each step, for launch. */}
        <Analytics />
      </body>
    </html>
  );
}
