/**
 * MANDATE's own agent card.
 *
 * This project grades agents on whether the thing their registration points at
 * actually exists and answers. Standing outside that instrument while pointing
 * it at three hundred thousand other registrations is the one position it
 * cannot defend, so MANDATE registers itself and takes whatever rung it earns.
 *
 * Deliberately not written to score well. Every claim here is one the assay
 * will test within minutes of the registration landing, and a card that
 * overstated its skills would fail its author's own capability check in
 * public. What it declares is what the public API actually serves.
 */

import { NextResponse } from "next/server";
import { CHAIN_ID } from "@/lib/config";
import { SITE } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOST = SITE;

export function GET() {
  return NextResponse.json(
    {
      // A2A agent card, the shape the registry's verifier probes for.
      protocolVersion: "0.3.0",
      name: "MANDATE Assay Office",
      description:
        "Tests ERC-8004 agents against BNB Smart Chain and publishes the evidence. Six checks, identity, custody, activity, capability, reputation, performance, producing a millesimal fineness. Below 375 no hallmark is struck. Every finding carries the command that re-derives it.",
      url: `${HOST}/api/v1`,
      version: "1.0.0",
      documentationUrl: `${HOST}/api`,
      provider: {
        organization: "MANDATE",
        url: HOST,
      },
      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: false,
      },
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
      skills: [
        {
          id: "assay",
          name: "Assay an agent",
          description:
            "Runs six tests against BNB Smart Chain for any ERC-8004 token id and returns a millesimal fineness with every finding and its evidence.",
          tags: ["erc-8004", "reputation", "verification", "bsc"],
          examples: [`GET ${HOST}/api/v1/assay/${CHAIN_ID}/2410`],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
        },
        {
          id: "ladder",
          name: "Read the trust ladder",
          description:
            "Returns every rung of the registry funnel with the test that settles it and its population. A rung that cannot be measured returns null rather than a guess.",
          tags: ["erc-8004", "registry", "bsc"],
          examples: [`GET ${HOST}/api/v1/registry/funnel`],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
        },
        {
          id: "register",
          name: "Browse the register",
          description:
            "Returns agents filtered by rung and category, with coverage attached so a small answer can be told apart from a small registry.",
          tags: ["erc-8004", "registry", "bsc"],
          examples: [`GET ${HOST}/api/v1/agents?rung=2&limit=20`],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
        },
        {
          id: "mcp",
          name: "The marketplace over MCP",
          description:
            "The marketplace as tools an AI assistant or agent can call: search_agents, get_agent, list_jobs, try_agent, get_price, hire_agent, check_agent and quest_progress, plus assay_agent, check_duplication and read_receipt for trust evidence. hire_agent returns the live price and the link where the buyer's own wallet pays; hire_over_x402, open_mandate and revoke_session return the transaction or terms rather than performing them, because this server holds no keys.",
          tags: ["mcp", "erc-8004", "bsc", "tools"],
          examples: [`claude mcp add --transport http mandate ${HOST}/api/mcp`],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
        },
      ],
      /*
        Not part of the A2A schema. Here because this project's whole argument
        is that a claim without a check is worthless, and that has to apply to
        its own card first.
      */
      x_mandate: {
        /*
          The same office, reachable by an agent rather than a browser. Listed
          here because this card claims to declare what the API actually
          serves, and an endpoint left undeclared would make that false.
        */
        mcp: {
          url: `${HOST}/api/mcp`,
          transport: "streamable-http (stateless JSON)",
          stdio: "npx -y tsx src/mcp/stdio.ts",
          writesExecute: false,
          note: "No hosted tool moves money. hire_agent returns a link for the buyer's own wallet, and the write-shaped tools prepare and do not perform: this server holds no keys, so a result from them is a transaction to sign, not a receipt.",
        },
        selfAssay: `${HOST}/api/v1/assay/${CHAIN_ID}/{ourTokenId}`,
        note: "We are listed in our own register at whatever rung we earn. If our endpoint stops answering, our fineness drops and the site shows it.",
        openToCompetitors: true,
        license: "MIT",
      },
    },
    {
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=60",
      },
    },
  );
}
