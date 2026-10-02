/**
 * MANDATE's social images, rendered from HTML in the site's own fonts and
 * colours, so a link card or a post image never drifts from the brand.
 *
 *   node src/scripts/social-cards.mjs                 every card
 *   node src/scripts/social-cards.mjs check-og hero   some of them
 *
 * Route cards land where Next serves them (src/app/<route>/opengraph-image.png
 * and twitter-image.png); post images land in ~/Documents/mandate-promo.
 */

import { chromium } from "playwright-core";
import { readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
// Embedded, not linked: a page set from a string cannot read local files, and a missing font falls back to a serif.
const font = (f) => `url("data:font/woff2;base64,${readFileSync(join(ROOT, "src/app/fonts", f)).toString("base64")}") format("woff2")`;
const mark = readFileSync(join(ROOT, "public/brand-kit/mandate-mark.svg"), "utf8");
const PROMO = join(homedir(), "Documents/mandate-promo/x-first-post");

const SIX = [
  "Registered on ERC-8004, owned by your campaign wallet",
  "A card that says which job it does",
  "Live when called",
  "Hired by three wallets that are not yours",
  "Five onchain actions, on three different days",
  "Those actions fit its job",
];

const css = `
@font-face { font-family: Display; src: ${font("InstrumentSans.woff2")}; font-weight: 400 700; }
@font-face { font-family: Sans; src: ${font("Inter.woff2")}; font-weight: 100 900; }
@font-face { font-family: Mono; src: ${font("JetBrainsMono.woff2")}; font-weight: 100 800; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { width: var(--w); height: var(--h); overflow: hidden; background: #0b0d0e; color: #fafaf8; font-family: Sans; }
.card { position: relative; width: 100%; height: 100%; padding: var(--pad); display: flex; flex-direction: column; }
.card::before { content: ""; position: absolute; inset: 0;
  background: radial-gradient(circle at 92% 8%, rgba(19,185,138,0.20), transparent 46%),
              linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px) 0 0 / 56px 56px,
              linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px) 0 0 / 56px 56px; }
.card > * { position: relative; }
.brand { display: flex; align-items: center; gap: 18px; font-family: Display; font-weight: 600; font-size: var(--brand); letter-spacing: -0.01em; }
.brand svg { width: calc(var(--brand) * 1.6); height: calc(var(--brand) * 1.6); }
h1 { font-family: Display; font-weight: 700; letter-spacing: -0.028em; line-height: 1.03; font-size: var(--h1); margin-top: auto; max-width: var(--h1w); }
.sub { color: #a2a8af; font-size: var(--sub); line-height: 1.35; margin-top: 22px; max-width: var(--subw); }
.foot { display: flex; align-items: center; gap: 20px; margin-top: 40px; }
.pill { white-space: nowrap; display: inline-flex; align-items: center; gap: 10px; padding: 8px 16px; border-radius: 999px; background: rgba(255,255,255,0.06); color: #c9cdd2; font-size: var(--small); }
.pill i { width: 9px; height: 9px; border-radius: 50%; background: #13b98a; display: inline-block; }
.url { white-space: nowrap; color: #13b98a; font-size: calc(var(--small) * 1.25); font-weight: 500; }
.split { display: grid; grid-template-columns: 1.05fr 1fr; gap: 64px; align-items: end; margin-top: auto; }
.split h1 { margin-top: 0; }
.six { list-style: none; display: grid; gap: 14px; padding: 30px 32px; border-radius: 22px; background: rgba(17,20,23,0.92); border: 1px solid rgba(255,255,255,0.1); }
.six li { display: grid; grid-template-columns: 34px 1fr; gap: 16px; align-items: center; font-size: 25px; line-height: 1.25; color: #e8e9e6; }
.six b { display: inline-grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; background: rgba(19,185,138,0.16); color: #13b98a; font: 600 17px Mono; }
.six .key { margin-top: 8px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.08); grid-template-columns: 1fr; color: #a2a8af; font-size: 19px; }
`;

const shell = (vars, body) => `<!doctype html><html><head><meta charset="utf-8"><style>:root{${vars}}${css}</style></head><body><div class="card">${body}</div></body></html>`;
const brand = `<div class="brand">${mark}<span>Mandate</span></div>`;
const foot = (url) => `<div class="foot"><span class="pill"><i></i>BNB Smart Chain · Mainnet</span><span class="url">${url}</span></div>`;

const OG = "--w:1200px;--h:630px;--pad:72px 80px;--brand:34px;--h1:76px;--h1w:1000px;--sub:28px;--subw:960px;--small:20px;";
const HERO = "--w:1600px;--h:900px;--pad:84px 96px;--brand:38px;--h1:92px;--h1w:820px;--sub:30px;--subw:760px;--small:22px;";

const END = "--w:1280px;--h:720px;--pad:80px 88px;--brand:34px;--h1:78px;--h1w:1100px;--sub:28px;--subw:1000px;--small:22px;";

const ADS = join(homedir(), "Documents/mandate-promo/x-ads");
const WIDE = "--w:1200px;--h:628px;--pad:64px 76px;--brand:32px;--h1:74px;--h1w:1050px;--sub:27px;--subw:1000px;--small:20px;";
const SQUARE = "--w:1080px;--h:1080px;--pad:80px 80px;--brand:36px;--h1:84px;--h1w:920px;--sub:30px;--subw:900px;--small:22px;";
const stack = `.stack { margin-top: auto; display: grid; gap: 34px; } .stack h1 { margin-top: 0; } .six { padding: 26px 30px; } .six li { font-size: 27px; }`;

const CARDS = {
  "video-end-square": {
    size: [1080, 1080],
    out: [join(ADS, "end-card-1080.png")],
    html: shell(SQUARE, `${brand}<h1>Check your agent before BNB Chain does.</h1><p class="sub">Six checks, read from the chain. Free, nothing to sign.</p>${foot("mandatemarkets.com/check")}`),
  },
  "ad-wide-builders": {
    size: [1200, 628],
    out: [join(ADS, "builders-1200x628.png")],
    html: shell(WIDE, `${brand}<h1>Does your agent qualify for Set and Earn?</h1><p class="sub">Check it against BNB Chain's six build checks now, read from the chain. Free, nothing to sign.</p>${foot("mandatemarkets.com/check")}`),
  },
  "ad-square-builders": {
    size: [1080, 1080],
    out: [join(ADS, "builders-1080x1080.png")],
    html: shell(
      SQUARE,
      `<style>${stack}</style>${brand}<div class="stack"><h1>Does your agent qualify for Set and Earn?</h1><ol class="six">${SIX.map((t, i) => `<li><b>${i + 1}</b><span>${t}</span></li>`).join("")}</ol>${foot("mandatemarkets.com/check")}</div>`,
    ),
  },
  "ad-wide-hirers": {
    size: [1200, 628],
    out: [join(ADS, "hirers-1200x628.png")],
    html: shell(WIDE, `${brand}<h1>Hire Set and Earn agents you can check.</h1><p class="sub">Agents' answers checked against the chain. Escrowed jobs hold your money until the work arrives.</p>${foot("mandatemarkets.com/quest")}`),
  },
  "ad-square-hirers": {
    size: [1080, 1080],
    out: [join(ADS, "hirers-1080x1080.png")],
    html: shell(
      SQUARE,
      `${brand}<h1>Hire Set and Earn agents you can check.</h1><p class="sub">Agents' answers are checked against our own reading of the chain. Escrowed jobs hold your money until the work arrives. Your progress is counted as you go.</p>${foot("mandatemarkets.com/quest")}`,
    ),
  },
  "video-end": {
    size: [1280, 720],
    out: [join(PROMO, "end-card.png")],
    html: shell(END, `${brand}<h1>Check your agent before BNB Chain does.</h1><p class="sub">Six checks, read from the chain. Free, nothing to sign.</p>${foot("mandatemarkets.com/check")}`),
  },
  "check-og": {
    size: [1200, 630],
    out: ["src/app/check/opengraph-image.png", "src/app/check/twitter-image.png"],
    html: shell(OG, `${brand}<h1>Does your agent qualify for Set and Earn?</h1><p class="sub">BNB Chain checks every agent after 5 November. Check yours now against the same six things, read from the chain.</p>${foot("mandatemarkets.com/check")}`),
  },
  "quest-og": {
    size: [1200, 630],
    out: ["src/app/quest/opengraph-image.png", "src/app/quest/twitter-image.png"],
    html: shell(OG, `${brand}<h1>Set and Earn, in one place.</h1><p class="sub">Hire three different agents, build one of your own, and see your progress counted on chain as you go.</p>${foot("mandatemarkets.com/quest")}`),
  },
  hero: {
    size: [1600, 900],
    out: [join(PROMO, "hero.png")],
    html: shell(
      HERO,
      `${brand}<div class="split"><div><h1>Does your agent qualify for Set and Earn?</h1><p class="sub">BNB Chain checks every agent after the campaign closes on 5 November. Check yours now, while there is time to fix it.</p>${foot("mandatemarkets.com/check")}</div>
      <ol class="six">${SIX.map((t, i) => `<li><b>${i + 1}</b><span>${t}</span></li>`).join("")}<li class="key">Each check: met, not yet, or not met, with the reason.</li></ol></div>`,
    ),
  },
};

const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CARDS);
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
for (const name of want) {
  const c = CARDS[name];
  if (!c) throw new Error(`no card ${name}`);
  const page = await browser.newPage({ viewport: { width: c.size[0], height: c.size[1] }, deviceScaleFactor: 1 });
  await page.setContent(c.html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const [first, ...rest] = c.out.map((o) => (o.startsWith("/") ? o : join(ROOT, o)));
  mkdirSync(dirname(first), { recursive: true });
  await page.screenshot({ path: first, type: "png" });
  for (const o of rest) copyFileSync(first, o);
  console.log(`${name}: ${c.out.join(", ")}`);
  await page.close();
}
await browser.close();
