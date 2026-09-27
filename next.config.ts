import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The home directory above this project is itself a git repo with its own
  // lockfile; without this, Next infers the wrong workspace root.
  outputFileTracingRoot: __dirname,
  // Pages read committed evidence from src/data at request time (demo.json,
  // recenter.json, roles.json, passkey.json, grid-window.json, probe.json),
  // and /proof reads the locked specification and its results from docs/advantage.
  // Some are read through a template path, which the tracer cannot follow.
  outputFileTracingIncludes: {
    "/**/*": ["./src/data/**/*.json", "./docs/advantage/results/*.json", "./docs/advantage/INPUT_LOCK.json"],
  },
  images: {
    remotePatterns: [{ protocol: "https", hostname: "api.8004scan.io" }],
  },
  /**
   * Left as runtime requires rather than bundled.
   *
   * `@bnbagent/sdk` loads `@altananetwork/sdk` through a dynamic require — it
   * is an optional peer dependency, GPL-3.0, so the SDK does not hard-depend
   * on it. Webpack cannot follow that, so the bundled server reported the
   * package "not installed" while it sat in node_modules, and revocation
   * failed in production while working perfectly from the CLI. The Greenfield
   * SDK has the same shape.
   */
  /**
   * Names people type, and names we used to use.
   *
   * The nav labels /assay as "Method", so a visitor who types /method — or
   * follows an older link — hit a 404 on a site whose case is that its method
   * is the product. A dead end is worse than a redirect.
   */
  /**
   * The old shopfront, pointed at the new one.
   *
   * The rebuild moved the marketplace, the tape and the ticket to routes that
   * say what they are. These URLs are in a submitted form, in a README and in
   * whatever anybody bookmarked, and a 404 on one of them is a dead end of
   * exactly the kind this rebuild exists to remove — so every one of them is
   * still a live link to the thing it used to be.
   */
  /*
    Our agents' A2A endpoints where BNB's agent SDK looks for them: a buyer
    reads the endpoint from the agent's ERC-8004 registration and appends
    /.well-known/agent-card.json for the card, or /negotiate for the SDK
    agent-server's plain form.
  */
  async rewrites() {
    return [
      { source: "/a2a/:slug/.well-known/agent-card.json", destination: "/api/a2a/:slug" },
      { source: "/a2a/:slug/.well-known/agent.json", destination: "/api/a2a/:slug" },
      { source: "/a2a/:slug/negotiate", destination: "/api/a2a/:slug?mode=negotiate" },
      { source: "/a2a/:slug", destination: "/api/a2a/:slug" },
    ];
  },

  async redirects() {
    /*
      Our own domain is the address; the platform one only keeps what chain
      records point at. Once NEXT_PUBLIC_HOST names our domain, every page on
      mandate-coral.vercel.app moves to it, except the paths written into our
      agents' ERC-8004 registrations and paid with x402, which keep answering
      where the chain says they are.
    */
    const site = (process.env.NEXT_PUBLIC_HOST ?? "").replace(/\/$/, "");
    const legacy = "mandate-coral.vercel.app";
    const moved = site && !site.includes(legacy)
      ? [
          { source: "/", has: [{ type: "host" as const, value: legacy }], destination: `${site}/`, permanent: true },
          {
            // api/cron/ stays too: the external pinger calls the old host, and a redirect across hosts drops its Authorization header (the clock stopped for 2.4 days, 25 Sep 13:05).
            source: "/:path((?!house/|\\.well-known/|api/x402/|api/cron/).*)",
            has: [{ type: "host" as const, value: legacy }],
            destination: `${site}/:path`,
            permanent: true,
          },
        ]
      : [];
    return [
      ...moved,
      { source: "/method", destination: "/assay", permanent: false },
      { source: "/agent/:tokenId", destination: "/agents/:tokenId", permanent: false },
      { source: "/market", destination: "/agents", permanent: false },
      { source: "/floor", destination: "/activity", permanent: false },
      { source: "/start", destination: "/agents", permanent: false },
      /*
        The four office pages were a second, thinner copy of the catalog and
        they 404 today. One list, filtered, is the honest shape: a category
        page that shows fewer agents than the tile promises is the diversity
        failure this rebuild set out to remove.
      */
      { source: "/office/:category", destination: "/agents?category=:category", permanent: false },
      { source: "/offices", destination: "/agents", permanent: false },
      // The V1 session page; /desk reads the KeyStore and replaces it.
      { source: "/authority", destination: "/desk", permanent: false },
      // Your agents live at the top of My Desk now.
      { source: "/dashboard", destination: "/desk", permanent: false },
      /*
        Pages the new navigation names before they are built. Each one points
        at the page that currently holds that content and is removed in the
        commit that builds the real route, so no link in the nav is ever dead.
      */
      { source: "/trust", destination: "/verify", permanent: false },
      // What a visitor would call the walkthrough; the route keeps its old name.
      { source: "/demo", destination: "/judges", permanent: false },
      // The ladder became a page that checks a token; the old explainer's URL points at it.
      { source: "/list-your-agent", destination: "/list", permanent: false },
    ];
  },
  serverExternalPackages: [
    "@bnbagent/sdk",
    "@altananetwork/sdk",
    "@bnb-chain/greenfield-js-sdk",
  ],
};

export default config;
