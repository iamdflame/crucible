"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Wallet } from "lucide-react";
import { connectWords, useWallet } from "@/lib/chain/wallet";

/**
 * "Use my wallet" on /check: most builders know the wallet they registered
 * from, not their agent's id, so the connected wallet lists the agents it
 * owns and each is one tap from its check. Connecting asks for nothing but
 * the address; nothing is signed.
 */
export default function CheckMine() {
  const { address, connect } = useWallet();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setError(null);
    if (address) {
      router.push(`/check?q=${address}`);
      return;
    }
    if (!window.ethereum) {
      setError("No wallet in this browser. Paste the wallet address you registered from instead.");
      return;
    }
    setBusy(true);
    try {
      await connect();
      const [first] = ((await window.ethereum.request({ method: "eth_accounts" })) as string[] | undefined) ?? [];
      if (first) router.push(`/check?q=${first}`);
      else setError("The wallet did not share an address. Paste it instead.");
    } catch (e) {
      setError(`${connectWords(e)} Or paste the wallet address you registered from.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="x-check__mine">
      <button type="button" className="x-btn" onClick={() => void go()} disabled={busy}>
        <Wallet size={16} aria-hidden="true" />
        {busy ? "Connecting…" : address ? "Check the agents my wallet owns" : "Use my wallet"}
      </button>
      {error ? (
        <p className="x-check__err" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
