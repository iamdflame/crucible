/**
 * The passkey wallet: the same passkey always opens the same wallet, nothing
 * is signed without a yes, and what the person approves is said in words.
 */

import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, recoverMessageAddress, recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { keyFromPrf } from "../passkey/derive";
import { describeTx, describeTyped } from "../passkey/describe";
import { passkeyProvider } from "../passkey/provider";
import { COMMERCE_ABI, ESCROW, ESCROW_TESTNET, ROUTER_ABI, TOKEN_ABI } from "../escrow/contracts";

const PRF = new Uint8Array(32).fill(7);

describe("keyFromPrf", () => {
  it("gives the same valid key for the same passkey answer, and a different one otherwise", async () => {
    const a = await keyFromPrf(PRF);
    expect(await keyFromPrf(PRF)).toBe(a);
    expect(privateKeyToAccount(a).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(await keyFromPrf(new Uint8Array(32).fill(8))).not.toBe(a);
  });
  it("refuses an answer too short to be a PRF output", async () => {
    await expect(keyFromPrf(new Uint8Array(16))).rejects.toThrow("too short");
  });
});

describe("describeTx", () => {
  const provider = "0x00000000000000000000000000000000000000aa";
  it("says each escrow step in words, on the network it is on", () => {
    const open = describeTx({ to: ESCROW.commerce, data: encodeFunctionData({ abi: COMMERCE_ABI, functionName: "createJob", args: [provider, ESCROW.router, 1n, "via mandatemarkets.com: Guard-1", ESCROW.router] }) }, 56);
    expect(open.title).toBe("Open a job in the escrow");
    expect(open.lines.join(" ")).toContain("Guard-1");
    const fund = describeTx({ to: ESCROW_TESTNET.commerce, data: encodeFunctionData({ abi: COMMERCE_ABI, functionName: "fund", args: [12n, 10n ** 16n, "0x"] }) }, 97);
    expect(fund.title).toBe("Fund job #12");
    expect(fund.lines.join(" ")).toContain("testnet");
    const bind = describeTx({ to: ESCROW.router, data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "registerJob", args: [12n, ESCROW.policy] }) }, 56);
    expect(bind.title).toContain("dispute policy");
  });
  it("names an approval's spender and exact amount", () => {
    const d = describeTx({ to: ESCROW.paymentToken, data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "approve", args: [ESCROW.commerce, 2n * 10n ** 16n] }) }, 56);
    expect(d.title).toBe("Allow BNB Chain's ERC-8183 escrow to take 0.02 $U");
    expect(d.unknown).toBeUndefined();
  });
  it("flags a call it does not recognise", () => {
    const d = describeTx({ to: "0x1111111111111111111111111111111111111111", data: "0xdeadbeef" }, 56);
    expect(d.unknown).toBe(true);
  });
});

describe("describeTyped", () => {
  it("says a payment authorization as a payment", () => {
    const d = describeTyped({ domain: { name: "United Stables", chainId: 56, verifyingContract: ESCROW.paymentToken }, primaryType: "TransferWithAuthorization", message: { to: "0x00000000000000000000000000000000000000bb", value: "10000000000000000", validBefore: 1_800_000_000 } });
    expect(d.title).toBe("Authorize a payment of 0.01 $U");
  });
});

describe("passkeyProvider", () => {
  const make = async (yes: boolean) => {
    const key = (await keyFromPrf(PRF)) as Hex;
    const confirm = vi.fn(async () => yes);
    return { p: passkeyProvider(key, confirm), confirm, address: privateKeyToAccount(key).address };
  };

  it("shares its one account, and moves only between BNB Smart Chain and its testnet", async () => {
    const { p, address } = await make(true);
    expect(await p.request({ method: "eth_accounts" })).toEqual([address]);
    expect(await p.request({ method: "eth_chainId" })).toBe("0x38");
    const changed = vi.fn();
    p.on("chainChanged", changed);
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x61" }] });
    expect(changed).toHaveBeenCalledWith("0x61");
    await expect(p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] })).rejects.toMatchObject({ code: 4902 });
  });

  it("signs a message only after a yes, and the signature is the wallet's", async () => {
    const { p, confirm, address } = await make(true);
    const sig = (await p.request({ method: "personal_sign", params: ["0x68656c6c6f", address] })) as Hex;
    expect(confirm).toHaveBeenCalledOnce();
    expect(await recoverMessageAddress({ message: { raw: "0x68656c6c6f" }, signature: sig })).toBe(address);
  });

  it("refuses when the person says no, and never signs raw bytes blind", async () => {
    const { p } = await make(false);
    await expect(p.request({ method: "personal_sign", params: ["0x68656c6c6f"] })).rejects.toMatchObject({ code: 4001 });
    await expect(p.request({ method: "eth_sendTransaction", params: [{ to: ESCROW.commerce, data: "0x" }] })).rejects.toMatchObject({ code: 4001 });
    await expect(p.request({ method: "eth_sign", params: ["0x00", "0x00"] })).rejects.toMatchObject({ code: 4200 });
    await expect(p.request({ method: "eth_coinbase" })).rejects.toMatchObject({ code: 4200 });
  });

  it("signs typed data for its own chain only", async () => {
    const { p, address } = await make(true);
    const typed = {
      domain: { name: "United Stables", version: "1", chainId: 56, verifyingContract: ESCROW.paymentToken },
      types: { EIP712Domain: [], Mail: [{ name: "to", type: "address" }] },
      primaryType: "Mail",
      message: { to: address },
    };
    const sig = (await p.request({ method: "eth_signTypedData_v4", params: [address, JSON.stringify(typed)] })) as Hex;
    const { EIP712Domain: _d, ...types } = typed.types;
    expect(await recoverTypedDataAddress({ domain: typed.domain, types, primaryType: "Mail", message: typed.message, signature: sig } as never)).toBe(address);
    await expect(p.request({ method: "eth_signTypedData_v4", params: [address, JSON.stringify({ ...typed, domain: { ...typed.domain, chainId: 97 } })] })).rejects.toMatchObject({ code: 4901 });
  });

  it("holds nothing once locked", async () => {
    const { p } = await make(true);
    p.lock();
    expect(await p.request({ method: "eth_accounts" })).toEqual([]);
    await expect(p.request({ method: "personal_sign", params: ["0x00"] })).rejects.toMatchObject({ code: 4100 });
  });
});
