/**
 * The passkey wallet, end to end on the live site, with Chrome's virtual
 * authenticator standing in for Face ID.
 *
 *   npx tsx --env-file=.env --env-file-if-exists=.env.local src/scripts/passkey-ui.ts
 *
 * A browser with no wallet opens /quest, makes a wallet with a passkey, is
 * funded with test tokens from the principal's testnet balance, hires the
 * free testnet pack approving every step in MANDATE's approval screen, and is
 * reloaded to check the same passkey opens the same wallet. Testnet only.
 */

import { chromium } from "playwright-core";
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { ESCROW_TESTNET } from "@/lib/escrow/contracts";

const BASE = "https://www.mandatemarkets.com";
const RPC = "https://bsc-testnet-rpc.publicnode.com";

async function main() {
  const key = process.env.PRIVATE_KEY!;
  const principal = createWalletClient({ account: privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex), chain: bscTestnet, transport: http(RPC) });
  const reader = createPublicClient({ chain: bscTestnet, transport: http(RPC) });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } as never,
  });

  await page.goto(`${BASE}/quest`, { waitUntil: "networkidle" });
  const pack = page.locator("section.x-pack--testnet");
  await pack.waitFor();
  await pack.getByRole("button", { name: /Create a wallet with a passkey/ }).click();
  await pack.getByRole("button", { name: /Switch to BNB Smart Chain testnet/ }).waitFor({ timeout: 30_000 });
  const address = (await page.evaluate(() => (window as unknown as { ethereum?: { address?: string } }).ethereum?.address)) as Address;
  console.log(`passkey wallet ${address}`);

  // Test tokens, as the faucet bot would send them.
  const gas = await principal.sendTransaction({ to: address, value: parseEther("0.01") });
  await reader.waitForTransactionReceipt({ hash: gas });
  const u = await principal.writeContract({ address: ESCROW_TESTNET.paymentToken, abi: parseAbi(["function transfer(address,uint256) returns (bool)"]), functionName: "transfer", args: [address, parseUnits("0.05", 18)] });
  await reader.waitForTransactionReceipt({ hash: u });
  console.log("funded with 0.01 tBNB and 0.05 test $U");

  await pack.getByRole("button", { name: /Switch to BNB Smart Chain testnet/ }).click();
  const hire = pack.getByRole("button", { name: /Hire both free/ });
  await hire.waitFor({ timeout: 60_000 });
  console.log(`button: "${(await hire.textContent())?.trim()}"`);
  await hire.click();

  // Every step waits on MANDATE's approval screen: read what it says, then approve.
  const dialog = page.locator(".x-approve");
  let approved = 0;
  const funded = pack.getByText(/Both testnet jobs are funded/);
  for (let i = 0; i < 40 && !(await funded.isVisible()); i++) {
    try {
      await dialog.waitFor({ timeout: 45_000 });
    } catch {
      if (await funded.isVisible()) break;
      throw new Error("no approval screen and nothing funded");
    }
    const title = (await dialog.locator(".x-approve__h").textContent())?.trim();
    approved += 1;
    console.log(`  approve ${approved}: ${title}`);
    await dialog.getByRole("button", { name: "Approve" }).click();
    await dialog.waitFor({ state: "detached", timeout: 10_000 });
  }
  await funded.waitFor({ timeout: 120_000 });
  console.log(`funded after ${approved} approvals`);
  await pack.locator(".x-pack__job", { hasText: /delivered/ }).first().waitFor({ timeout: 180_000 });
  console.log("jobs:", (await pack.locator(".x-pack__job").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim()).join(" | "));
  await pack.screenshot({ path: process.env.SHOT ?? "/tmp/passkey-pack.png" });

  // A reload forgets the key; the same passkey opens the same wallet.
  await page.reload({ waitUntil: "networkidle" });
  const unlock = page.locator("section.x-pack--testnet").getByRole("button", { name: /Unlock your passkey wallet/ });
  await unlock.waitFor({ timeout: 20_000 });
  await unlock.click();
  await page.waitForFunction(() => Boolean((window as unknown as { ethereum?: { address?: string } }).ethereum?.address), null, { timeout: 30_000 });
  const again = await page.evaluate(() => (window as unknown as { ethereum?: { address?: string } }).ethereum?.address);
  console.log(`after reload and unlock: ${again} (${again === address ? "the same wallet" : "A DIFFERENT WALLET"})`);
  await browser.close();
  process.exit(again === address ? 0 : 1);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
