"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createWalletClient, custom, encodeFunctionData, formatEther, formatUnits, parseAbi, parseEther, parseUnits, type Address, type Hex } from "viem";
import { Check, Fingerprint, Loader2, ShieldOff } from "lucide-react";
import { marketChain, marketClient } from "@/lib/chain/market";
import { useWallet } from "@/lib/chain/wallet";
import OpenInWallet from "./OpenInWallet";
import NeedHelp from "./NeedHelp";

// The same addresses the server's leash policy names; a test holds them equal.
export const USDT: Address = "0x55d398326f99059fF775485246999027B3197955";
export const VUSDT: Address = "0xfD5840Cd36d94D7229439859C0112a4185BC0255";
const ERC20 = parseAbi(["function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const VTOKEN = parseAbi(["function balanceOf(address) view returns (uint256)", "function redeem(uint256) returns (uint256)", "function borrowBalanceStored(address) view returns (uint256)"]);
/** The relay's fees and the KeyStore's registration fee, with room for a few of the agent's own actions. */
const BNB_NEEDED = parseEther("0.002");
const STORE = "mandate:leash-wallet";

type Slug = "yield-1" | "guard-1";
const AGENTS: Record<Slug, { name: string; line: string }> = {
  "yield-1": { name: "Yield-1", line: "Puts idle USDT in this wallet to work on Venus when Venus pays a rate. What it supplies stays credited to this wallet." },
  "guard-1": { name: "Guard-1", line: "Repays this wallet's own Venus USDT debt when its health factor falls near liquidation." },
};

interface Terms {
  sessionSigner: { address: Address; publicKey: Hex };
  permissions: { calls: { to: Address; signature: string }[]; spend: { limit: string; period: string; token?: Address }[] };
  expiry: number;
  may: string[];
}
interface Run {
  at: string;
  outcome: string;
  reason: string;
  txs: { step: string; tx: string }[];
}
interface Leash {
  id: string;
  slug: Slug;
  dailyUsdt: string;
  expiry: number;
  revokedAt: string | null;
  publicKey: Hex;
  runs: Run[];
}

type Sdk = {
  createClient: (o: { chains: unknown[] }) => SdkClient;
  BNB: unknown;
};
type SdkClient = {
  createPasskeyWallet(o: { name: string }): Promise<{ address: Address; signer: unknown }>;
  recoverFromPasskey(o?: Record<string, unknown>): Promise<{ address: Address; signer: unknown }>;
  execute(o: Record<string, unknown>): Promise<{ transactionHash?: Hex; status: string }>;
  grantSession(o: Record<string, unknown>): Promise<{ publicKey: Hex; transactionHash?: Hex }>;
  revokeSession(o: Record<string, unknown>): Promise<{ transactionHash?: Hex; status: string }>;
};

let clientPromise: Promise<SdkClient> | null = null;
/** The SDK is loaded only when someone starts a leash, so no other page carries its weight. */
const sdkClient = () =>
  (clientPromise ??= import("@altananetwork/sdk").then((m) => {
    const sdk = m as unknown as Sdk;
    return sdk.createClient({ chains: [sdk.BNB] });
  }));

const tx = (h?: string | null) =>
  h ? (
    <a className="x-link x-mono" href={`https://bscscan.com/tx/${h}`} target="_blank" rel="noreferrer">
      {h.slice(0, 8)}…
    </a>
  ) : null;

/**
 * A leash on your own wallet, in the order it happens: a passkey wallet the
 * agent can act on and you alone own, the funds you choose to put in it, the
 * limits, and the one signature that grants them. Then what the agent does,
 * and the button that ends it.
 */
export default function LeashWizard({ initial = "yield-1" }: { initial?: Slug }) {
  const { address: owner, available, connect, ready, switchChain } = useWallet();
  const [slug, setSlug] = useState<Slug>(initial);
  const [pk, setPk] = useState<{ address: Address; signer: unknown } | null>(null);
  const [known, setKnown] = useState<Address | null>(null);
  const [bal, setBal] = useState<{ bnb: bigint; usdt: bigint; vusdt: bigint } | null>(null);
  const [budget, setBudget] = useState("1");
  const [daily, setDaily] = useState("0.5");
  const [days, setDays] = useState("7");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leashes, setLeashes] = useState<Leash[]>([]);
  const [done, setDone] = useState<Record<string, string | null>>({});
  /*
    Whether this browser can make a passkey at all. Several wallet apps' own
    browsers cannot, and there the button would wait on a prompt that never
    comes. "platform" is whether this device has its own fingerprint or face
    unlock; without one a passkey can still live on a phone or a security key.
  */
  const [passkeys, setPasskeys] = useState<"unknown" | "none" | "roaming" | "platform">("unknown");
  useEffect(() => {
    const P = (window as unknown as { PublicKeyCredential?: { isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean> } }).PublicKeyCredential;
    if (!P || !navigator.credentials) return setPasskeys("none");
    (P.isUserVerifyingPlatformAuthenticatorAvailable?.() ?? Promise.resolve(false)).then(
      (yes) => setPasskeys(yes ? "platform" : "roaming"),
      () => setPasskeys("roaming"),
    );
  }, []);

  const wallet = pk?.address ?? known;
  useEffect(() => {
    try {
      const w = localStorage.getItem(STORE);
      if (w && /^0x[0-9a-fA-F]{40}$/.test(w)) setKnown(w as Address);
    } catch {
      /* private window: nothing remembered */
    }
  }, []);

  const read = useCallback(async () => {
    if (!wallet) return;
    const [bnb, usdt, vusdt, l] = await Promise.all([
      marketClient.getBalance({ address: wallet }),
      marketClient.readContract({ address: USDT, abi: ERC20, functionName: "balanceOf", args: [wallet] }) as Promise<bigint>,
      marketClient.readContract({ address: VUSDT, abi: VTOKEN, functionName: "balanceOf", args: [wallet] }) as Promise<bigint>,
      fetch(`/api/leash?address=${wallet}`, { cache: "no-store" }).then((r) => r.json()).catch(() => null),
    ]);
    setBal({ bnb, usdt, vusdt });
    setLeashes((l?.data?.leashes ?? []) as Leash[]);
  }, [wallet]);
  useEffect(() => {
    void read();
    const t = setInterval(() => void read(), 12_000);
    return () => clearInterval(t);
  }, [read]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await read();
    } catch (e) {
      const m = (e as Error).message ?? String(e);
      setError(/NotAllowedError|cancel/i.test(m) ? "The passkey prompt was closed, so nothing was signed." : m.split("\n")[0].slice(0, 220));
    } finally {
      setBusy(null);
    }
  };

  const remember = (a: Address) => {
    try {
      localStorage.setItem(STORE, a);
    } catch {
      /* not remembered; the passkey still finds it */
    }
  };
  const create = () =>
    run("create", async () => {
      const w = await (await sdkClient()).createPasskeyWallet({ name: "MANDATE" });
      setPk(w);
      remember(w.address);
    });
  const unlock = () =>
    run("unlock", async () => {
      const w = await (await sdkClient()).recoverFromPasskey();
      setPk(w);
      remember(w.address);
    });

  const eoa = () => createWalletClient({ account: owner as Address, chain: marketChain, transport: custom(window.ethereum as never) });
  const fundBnb = () =>
    run("bnb", async () => {
      const need = bal && bal.bnb < BNB_NEEDED ? BNB_NEEDED - bal.bnb : BNB_NEEDED;
      const h = await eoa().sendTransaction({ to: wallet!, value: need } as never);
      await marketClient.waitForTransactionReceipt({ hash: h });
      setDone((d) => ({ ...d, bnb: h }));
    });
  const fundUsdt = () =>
    run("usdt", async () => {
      const h = await eoa().writeContract({ address: USDT, abi: ERC20, functionName: "transfer", args: [wallet!, parseUnits(budget, 18)] } as never);
      await marketClient.waitForTransactionReceipt({ hash: h });
      setDone((d) => ({ ...d, usdt: h }));
    });

  const grant = () =>
    run("grant", async () => {
      if (!pk) throw new Error("Unlock the wallet with its passkey first.");
      const client = await sdkClient();
      const t = (await fetch(`/api/leash/terms?wallet=${pk.address}&slug=${slug}&daily=${daily}&days=${days}`).then((r) => r.json())) as { data?: Terms; error?: string };
      if (!t.data) throw new Error(t.error ?? "The terms could not be read.");
      // The owner approves Venus for exactly the budget; the session itself can approve nothing.
      const approved = await client.execute({ wallet: pk, signer: pk.signer, calls: [{ to: USDT, data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [VUSDT, parseUnits(budget, 18)] }) }] });
      setDone((d) => ({ ...d, approve: approved.transactionHash ?? null }));
      // The session names our agent's key; its private half never reaches this browser.
      const sessionSigner = { type: "privateKey", ...t.data.sessionSigner, signDigest: async () => { throw new Error("held by the agent, not here"); } };
      const permissions = { calls: t.data.permissions.calls, spend: t.data.permissions.spend.map((s) => ({ ...s, limit: BigInt(s.limit) })) };
      const g = await client.grantSession({ wallet: pk, signer: pk.signer, permissions, expiry: t.data.expiry, sessionSigner, register: true });
      setDone((d) => ({ ...d, grant: g.transactionHash ?? null }));
      const rec = await fetch("/api/leash", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: pk.address, slug, daily: Number(daily), owner }) }).then((r) => r.json());
      if (rec.error) throw new Error(rec.error);
    });

  const revoke = (l: Leash) =>
    run(`revoke:${l.id}`, async () => {
      if (!pk) throw new Error("Unlock the wallet with its passkey first.");
      const r = await (await sdkClient()).revokeSession({ wallet: pk, signer: pk.signer, session: l.publicKey });
      await fetch("/api/leash/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: pk.address, slug: l.slug, tx: r.transactionHash }) });
      setDone((d) => ({ ...d, [`revoke:${l.id}`]: r.transactionHash ?? null }));
    });

  const withdraw = () =>
    run("withdraw", async () => {
      if (!pk || !owner) throw new Error("Unlock the wallet and connect the wallet to send it to.");
      const client = await sdkClient();
      const v = (await marketClient.readContract({ address: VUSDT, abi: VTOKEN, functionName: "balanceOf", args: [pk.address] })) as bigint;
      if (v > 0n) await client.execute({ wallet: pk, signer: pk.signer, calls: [{ to: VUSDT, data: encodeFunctionData({ abi: VTOKEN, functionName: "redeem", args: [v] }) }] });
      const u = (await marketClient.readContract({ address: USDT, abi: ERC20, functionName: "balanceOf", args: [pk.address] })) as bigint;
      const bnb = await marketClient.getBalance({ address: pk.address });
      const back = bnb > parseEther("0.0003") ? bnb - parseEther("0.0003") : 0n;
      const calls = [
        ...(u > 0n ? [{ to: USDT, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [owner, u] }) }] : []),
        ...(back > 0n ? [{ to: owner, value: back }] : []),
      ];
      if (calls.length) {
        const r = await client.execute({ wallet: pk, signer: pk.signer, calls });
        setDone((d) => ({ ...d, withdraw: r.transactionHash ?? null }));
      }
    });

  const live = leashes.filter((l) => !l.revokedAt && l.expiry * 1000 > Date.now());
  const ready2 = useMemo(() => {
    const b = Number(budget);
    const d = Number(daily);
    const n = Number(days);
    if (!(b > 0 && d >= 0.01 && d <= 100 && n >= 1 && n <= 30)) return "Set a budget, a daily cap between 0.01 and 100 USDT, and 1 to 30 days.";
    if (d > b) return "The daily cap cannot be more than the budget.";
    if (!bal || bal.bnb < parseEther("0.0012")) return "Add about 0.002 BNB first: it pays the relay and the registry's fee.";
    if (bal.usdt < parseUnits(budget, 18)) return `Add ${budget} USDT to the wallet first.`;
    return null;
  }, [budget, daily, days, bal, slug]);

  if (!available) {
    return (
      <div className="x-leash">
        <OpenInWallet />
      </div>
    );
  }

  return (
    <div className="x-leash">
      <div className="x-leash__agents" role="radiogroup" aria-label="Which agent">
        {(Object.keys(AGENTS) as Slug[]).map((s) => (
          <button key={s} type="button" role="radio" aria-checked={slug === s} className={`x-leash__agent${slug === s ? " x-leash__agent--on" : ""}`} onClick={() => setSlug(s)}>
            <strong>{AGENTS[s].name}</strong>
            <span>{AGENTS[s].line}</span>
          </button>
        ))}
      </div>

      <ol className="x-leash__steps">
        <li className={wallet ? "x-leash__step x-leash__step--done" : "x-leash__step"}>
          <p className="x-leash__t">1. A wallet only you control</p>
          <p className="x-leash__d">A passkey wallet: your fingerprint or face unlocks it, with no seed phrase. The agent will act on this wallet and nothing else.</p>
          {pk ? (
            <p className="x-leash__ok">
              <Check size={14} aria-hidden="true" /> Unlocked <span className="x-mono">{pk.address}</span>
            </p>
          ) : passkeys === "none" ? (
            <p className="x-leash__warn">
              This browser cannot make a passkey, which is how the wallet is unlocked. Wallet apps&apos; built-in browsers often cannot. Open{" "}
              <span className="x-mono">mandatemarkets.com/leash</span> in Chrome, Safari or Edge; your main wallet can still connect there.
            </p>
          ) : (
            <div className="x-leash__row">
              {passkeys === "roaming" ? (
                <p className="x-leash__note">This device has no fingerprint or face unlock of its own, so the passkey will live on your phone or a security key when you are asked.</p>
              ) : null}
              {known ? (
                <button type="button" className="x-btn x-btn--primary" onClick={unlock} disabled={busy !== null}>
                  <Fingerprint size={16} aria-hidden="true" /> {busy === "unlock" ? "Waiting for your passkey…" : `Unlock ${known.slice(0, 6)}…${known.slice(-4)}`}
                </button>
              ) : null}
              <button type="button" className={known ? "x-btn" : "x-btn x-btn--primary"} onClick={create} disabled={busy !== null}>
                <Fingerprint size={16} aria-hidden="true" /> {busy === "create" ? "Waiting for your passkey…" : "Create a passkey wallet"}
              </button>
              {!known ? (
                <button type="button" className="x-btn x-btn--ghost" onClick={unlock} disabled={busy !== null}>
                  I already have one
                </button>
              ) : null}
            </div>
          )}
        </li>

        <li className={wallet && bal && bal.bnb >= parseEther("0.0012") ? "x-leash__step x-leash__step--done" : "x-leash__step"}>
          <p className="x-leash__t">2. Put in what the agent may use</p>
          <p className="x-leash__d">About 0.002 BNB pays the relay and the key registry's fee. {slug === "yield-1" ? "Then the USDT you want put to work." : "Guard-1 repays from USDT held in this wallet, against this wallet's own Venus loan."}</p>
          {wallet ? (
            <>
              <p className="x-leash__bal">
                Holds {bal ? `${Number(formatEther(bal.bnb)).toFixed(5)} BNB, ${Number(formatUnits(bal.usdt, 18)).toFixed(2)} USDT` : "…"}
                {bal && bal.vusdt > 0n ? " and a Venus supply" : ""}
              </p>
              {!owner ? (
                <button type="button" className="x-btn" onClick={connect}>
                  Connect the wallet to fund it from
                </button>
              ) : !ready ? (
                <button type="button" className="x-btn" onClick={switchChain}>
                  Switch to BNB Smart Chain
                </button>
              ) : (
                <div className="x-leash__row">
                  <button type="button" className="x-btn" onClick={fundBnb} disabled={busy !== null}>
                    {busy === "bnb" ? "Sending…" : "Send 0.002 BNB"}
                  </button>
                  <label className="x-leash__in">
                    <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" aria-label="Budget in USDT" /> USDT
                  </label>
                  <button type="button" className="x-btn" onClick={fundUsdt} disabled={busy !== null || !(Number(budget) > 0)}>
                    {busy === "usdt" ? "Sending…" : `Send ${budget} USDT`}
                  </button>
                  {tx(done.bnb)} {tx(done.usdt)}
                </div>
              )}
              <p className="x-leash__n">
                Or send to <span className="x-mono">{wallet}</span> from anywhere, on BNB Smart Chain only.
              </p>
            </>
          ) : null}
        </li>

        <li className={live.some((l) => l.slug === slug) ? "x-leash__step x-leash__step--done" : "x-leash__step"}>
          <p className="x-leash__t">3. Set its limits, and grant</p>
          <div className="x-leash__row">
            <label className="x-leash__in">
              Budget <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" /> USDT
            </label>
            <label className="x-leash__in">
              At most <input value={daily} onChange={(e) => setDaily(e.target.value)} inputMode="decimal" /> USDT a day
            </label>
            <label className="x-leash__in">
              For <input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" /> days
            </label>
          </div>
          <ul className="x-leash__may">
            <li>It may call Venus&apos;s USDT market for this wallet only. Everything it moves stays in this wallet.</li>
            <li>It may never move more than {daily} USDT a day, and never more than the {budget} USDT you approve.</li>
            <li>It cannot transfer, withdraw to anyone, or approve anything. The leash ends in {days} days, or the moment you revoke it.</li>
          </ul>
          {ready2 ? <p className="x-leash__n">{ready2}</p> : null}
          <button type="button" className="x-btn x-btn--primary" onClick={grant} disabled={!pk || busy !== null || ready2 !== null}>
            <Fingerprint size={16} aria-hidden="true" /> {busy === "grant" ? "Two passkey prompts: approve, then grant…" : `Grant ${AGENTS[slug].name} this leash`}
          </button>
          {!pk && wallet ? <p className="x-leash__n">Unlock the wallet with its passkey first.</p> : null}
          <p className="x-leash__n">
            {tx(done.approve)} {tx(done.grant)}
          </p>
        </li>
      </ol>

      {leashes.length ? (
        <div className="x-leash__live">
          <p className="x-leash__t">On this wallet</p>
          {leashes.map((l) => {
            const active = !l.revokedAt && l.expiry * 1000 > Date.now();
            return (
              <div key={l.id} className="x-leash__card">
                <div className="x-leash__row">
                  <strong>{AGENTS[l.slug].name}</strong>
                  <span className={active ? "x-hire-row__ok" : "x-hire-row__job"}>{active ? `on a leash until ${new Date(l.expiry * 1000).toLocaleDateString("en-GB")}` : l.revokedAt ? "revoked" : "expired"}</span>
                  <span className="x-leash__n">at most {l.dailyUsdt} USDT a day</span>
                  {active ? (
                    <button type="button" className="x-btn x-btn--sm x-btn--danger" onClick={() => revoke(l)} disabled={busy !== null || !pk}>
                      {busy === `revoke:${l.id}` ? <Loader2 size={14} className="x-spin" aria-hidden="true" /> : <ShieldOff size={14} aria-hidden="true" />} Revoke now
                    </button>
                  ) : null}
                  {tx(done[`revoke:${l.id}`])}
                </div>
                <ul className="x-leash__runs">
                  {l.runs.length ? (
                    l.runs.slice(0, 6).map((r) => (
                      <li key={r.at}>
                        <span className="x-leash__n">{new Date(r.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span> {r.reason} {tx(r.txs[0]?.tx)}
                      </li>
                    ))
                  ) : (
                    <li className="x-leash__n">It takes its first look within minutes.</li>
                  )}
                </ul>
              </div>
            );
          })}
          <button type="button" className="x-btn" onClick={withdraw} disabled={!pk || !owner || busy !== null}>
            {busy === "withdraw" ? "Withdrawing…" : "Withdraw everything to my connected wallet"}
          </button>
          {tx(done.withdraw)}
        </div>
      ) : null}

      {error ? <p className="x-escrow__err">{error}</p> : null}
      <NeedHelp />
    </div>
  );
}
