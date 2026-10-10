/**
 * Our agents' testnet registrations: the A2A card they point to carries
 * ?chain=97, so a testnet marketplace is quoted in test $U, and they name
 * their testnet identity, not their mainnet one.
 */

import { describe, expect, it } from "vitest";
import { REFERENCE } from "../house";
import { sdkRegistration, sdkRegistrationTestnet } from "../house/registration";
import { ESCROW_TESTNET } from "../escrow/contracts";

describe("sdkRegistrationTestnet", () => {
  const guard = REFERENCE.find((r) => r.slug === "guard-1")!;

  it("points its A2A card at the testnet seller and leaves out per-call x402", () => {
    const r = sdkRegistrationTestnet(guard, "2591", "344123") as { services: { name: string; endpoint: string }[]; x402Support: boolean };
    const a2a = r.services.find((s) => s.name === "A2A")!;
    expect(a2a.endpoint).toMatch(/\/a2a\/guard-1\/\.well-known\/agent-card\.json\?chain=97$/);
    expect(r.services.some((s) => s.name === "x402")).toBe(false);
    expect(r.x402Support).toBe(false);
    expect(r.services.find((s) => s.name === "web")!.endpoint).toMatch(/\/agents\/344123$/);
  });

  it("names its testnet identity on the testnet registry, and none before it has one", () => {
    const r = sdkRegistrationTestnet(guard, "2591", "344123") as { registrations: { agentId: number; agentRegistry: string }[] };
    expect(r.registrations).toEqual([{ agentId: 2591, agentRegistry: `eip155:97:${ESCROW_TESTNET.identity}` }]);
    expect((sdkRegistrationTestnet(guard, null, "344123") as { registrations: unknown[] }).registrations).toEqual([]);
  });

  it("leaves the mainnet registration as it was", () => {
    const r = sdkRegistration(guard, "344123") as { services: { name: string; endpoint: string }[] };
    expect(r.services.find((s) => s.name === "A2A")!.endpoint).not.toContain("chain=97");
  });
});
