"use client";

import { useEffect, useMemo, useState } from "react";
import { Copy } from "lucide-react";
import { CATEGORIES, CATEGORY_LABEL, type Category } from "@/lib/config";
import { buildPrompt, openIn, type BuildNetwork } from "@/lib/build/prompt";
import { useWallet } from "@/lib/chain/wallet";

/**
 * Build it with your own AI assistant: choose the job and the network, and
 * get a prompt that hands Claude, ChatGPT or Cursor everything BNB Chain's six
 * checks need, with the connected wallet as the agent's owner. Copy it, or
 * open a chat that reads it from its link.
 */
export default function BuildPrompt() {
  const { address } = useWallet();
  const [job, setJob] = useState<Category>("health-factor");
  const [network, setNetwork] = useState<BuildNetwork>("mainnet");
  const [wallet, setWallet] = useState("");
  const [idea, setIdea] = useState("");
  const [copied, setCopied] = useState(false);

  // The connected wallet is the likely campaign wallet; the builder can change it.
  useEffect(() => {
    if (address && !wallet) setWallet(address);
  }, [address, wallet]);

  const input = { job, network, wallet: wallet.trim() || null, idea: idea.trim() || null };
  const prompt = useMemo(() => buildPrompt(input), [job, network, wallet, idea]); // eslint-disable-line react-hooks/exhaustive-deps
  const links = useMemo(() => openIn(input), [job, network, wallet, idea]); // eslint-disable-line react-hooks/exhaustive-deps
  const badWallet = wallet.trim() !== "" && !/^0x[0-9a-fA-F]{40}$/.test(wallet.trim());

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* The prompt is on screen to select. */
    }
  };

  return (
    <section className="x-prompt" aria-labelledby="h-prompt">
      <p className="x-eyebrow">Build it with your AI assistant</p>
      <h2 id="h-prompt" className="x-prompt__h">
        A prompt that knows the six checks
      </h2>
      <p className="x-prompt__lede">
        Choose the job and the network, and paste this into Claude, ChatGPT, Cursor or Claude Code. It gives your assistant BNB Chain&apos;s six checks, BNB&apos;s
        agent SDK, the onchain work that counts for the job, the contracts and where test tokens come from, and it never asks for your wallet&apos;s key.
      </p>
      <div className="x-prompt__form">
        <label className="x-prompt__field">
          <span>Job</span>
          <select className="x-input" value={job} onChange={(e) => setJob(e.target.value as Category)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="x-prompt__field">
          <legend>Network</legend>
          <label className="x-prompt__radio">
            <input type="radio" name="network" checked={network === "mainnet"} onChange={() => setNetwork("mainnet")} /> Mainnet: MANDATE checks all six for you
          </label>
          <label className="x-prompt__radio">
            <input type="radio" name="network" checked={network === "testnet"} onChange={() => setNetwork("testnet")} /> Testnet: free test tokens, you check it yourself
          </label>
        </fieldset>
        <label className="x-prompt__field">
          <span>Your campaign wallet (optional)</span>
          <input className="x-input x-mono" value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="0x…" spellCheck={false} />
          {badWallet ? <span className="x-escrow__err">That is not a wallet address; the prompt will ask you for it instead.</span> : null}
        </label>
        <label className="x-prompt__field">
          <span>What should it do? (optional)</span>
          <input className="x-input" value={idea} maxLength={400} onChange={(e) => setIdea(e.target.value)} placeholder="Leave empty and your assistant will propose something" />
        </label>
      </div>
      <textarea className="x-input x-input--area x-prompt__text x-mono" readOnly value={prompt} rows={12} aria-label="The prompt" />
      <div className="x-prompt__acts">
        <button type="button" className="x-btn x-btn--primary" onClick={() => void copy()}>
          <Copy size={14} aria-hidden="true" /> {copied ? "Copied" : "Copy the prompt"}
        </button>
        <a className="x-btn" href={links.claude} target="_blank" rel="noreferrer">
          Open in Claude
        </a>
        <a className="x-btn" href={links.chatgpt} target="_blank" rel="noreferrer">
          Open in ChatGPT
        </a>
      </div>
      <p className="x-prompt__fine">
        The open links ask the assistant to read this prompt from its link; one that cannot open links asks you to paste it. Using Claude Code or Cursor? Add MANDATE&apos;s
        MCP server (<span className="x-mono">/api/mcp</span>) and ask for <span className="x-mono">build_prompt</span>.
      </p>
    </section>
  );
}
