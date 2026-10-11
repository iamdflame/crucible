import Navbar from "./Navbar";
import CampaignStrip from "./CampaignStrip";
import Footer from "./Footer";
import CompareTray from "./CompareTray";
import { PasskeyHost } from "./Passkey";

/**
 * The one shell every page renders inside.
 *
 * It carries both class roots: `x-app` for the marketplace system and
 * `m-app` for pages still written against the older sheet, whose tokens now
 * resolve to the same palette.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="m-app x-app">
      <a className="x-skip" href="#main">
        Skip to content
      </a>
      <CampaignStrip />
      <Navbar />
      <main id="main" className="x-main m-main">
        {children}
      </main>
      <Footer />
      <CompareTray />
      <PasskeyHost />
    </div>
  );
}
