/**
 * BNB Smart Chain testnet (chain 97): a reader and a signer.
 *
 * Our four agents also sell on testnet, where Set and Earn counts hires and a
 * buyer pays in test $U, so each one registers, quotes, delivers and settles
 * there as it does on mainnet. thirdweb with our key first (it answers the
 * reads public nodes refuse), then two public nodes, so a write never waits on
 * one provider.
 */

import { createPublicClient, createWalletClient, fallback, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

function transports() {
  const key = (process.env.THIRDWEB_SECRET_KEY || process.env.thirdweb_secret || "").trim();
  return [
    ...(key ? [http("https://97.rpc.thirdweb.com", { fetchOptions: { headers: { "x-secret-key": key } }, timeout: 20_000, retryCount: 1 })] : []),
    http("https://bsc-testnet-rpc.publicnode.com", { timeout: 20_000, retryCount: 1 }),
    http("https://data-seed-prebsc-1-s1.bnbchain.org:8545", { timeout: 20_000, retryCount: 1 }),
  ];
}

let reader: PublicClient | null = null;

export function testnetPublic(): PublicClient {
  reader ??= createPublicClient({ chain: bscTestnet, transport: fallback(transports()) }) as PublicClient;
  return reader;
}

export function testnetWallet(key: Hex) {
  return createWalletClient({ account: privateKeyToAccount(key), chain: bscTestnet, transport: fallback(transports()) });
}

export const TESTNET_TX = (hash: string) => `https://testnet.bscscan.com/tx/${hash}`;
