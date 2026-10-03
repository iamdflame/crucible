import AppShell from "@/components/v2/shell/AppShell";
import { Skel } from "@/components/x/Skeleton";

/** Shaped like an agent's page (picture, name, price, the hire panel), so a slow read never shows the marketplace's grid instead. */
export default function Loading() {
  return (
    <AppShell>
      <section className="x-wrap x-ad-hero" aria-busy="true">
        <Skel w={160} h={14} />
        <div style={{ height: 16 }} />
        <div className="x-ad-hero__grid">
          <Skel h={300} r={14} />
          <div>
            <Skel w={140} h={22} r={999} />
            <div style={{ height: 16 }} />
            <Skel w={320} h={40} />
            <div style={{ height: 14 }} />
            <Skel h={16} />
            <div style={{ height: 8 }} />
            <Skel w={260} h={16} />
            <div style={{ height: 24 }} />
            <Skel w={120} h={32} />
            <div style={{ height: 20 }} />
            <Skel w={200} h={48} r={10} />
          </div>
        </div>
      </section>
      <div className="x-wrap x-ad-body" aria-hidden="true">
        <div>
          <Skel h={92} r={10} />
          <div style={{ height: 24 }} />
          <Skel h={180} r={10} />
        </div>
        <Skel h={320} r={10} />
      </div>
    </AppShell>
  );
}
