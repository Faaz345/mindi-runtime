import { Reveal } from "./Reveal";
import { SectionHeading } from "./SectionHeading";
import { Terminal, type TermLine } from "./Terminal";

const vision: TermLine[] = [
  { text: 'mindi-cli run "whats in this image? C:\\brand\\logo.png"', typed: true, className: "text-white" },
  { text: "" },
  { text: "  capability:dispatch  vision → custom.vision", className: "text-faint" },
  { text: "  capability:error     No vision-capable model available", className: "text-amber-200/80" },
  { text: "  capability:dispatch  vision → open-router.vision  (failover)", className: "text-faint" },
  { text: "  capability:success   1240ms", className: "text-emerald-300/90" },
  { text: "" },
  { text: "  A line-art tribal logo in thin monochrome strokes — a geometric", className: "text-slate-300" },
  { text: "  bird-like mark, symmetric along the vertical axis.", className: "text-slate-300" },
];

const graph: TermLine[] = [
  { text: 'mindi-cli graph "browse https://example.com and take a screenshot"', typed: true, className: "text-white" },
  { text: "" },
  { text: "  Execution Graph — 3 nodes", className: "text-glow-soft" },
  { text: "  ├─ search   (web-search)   ▶ parallel", className: "text-slate-300" },
  { text: "  ├─ browse   (browser)      ▶ parallel", className: "text-slate-300" },
  { text: "  └─ capture  (browser)      ▶ after browse", className: "text-slate-300" },
  { text: "" },
  { text: "mindi-cli logs --follow --filter capability", typed: true, className: "text-white" },
  { text: "  ● live event stream attached", className: "text-emerald-300/90" },
];

export function Examples() {
  return (
    <section id="examples" className="mx-auto max-w-6xl px-6 py-28 sm:py-36">
      <hr className="hairline mx-auto mb-28 max-w-4xl" />
      <SectionHeading
        eyebrow="Terminal Examples"
        title="Watch the runtime think."
        lead="Augmentation isn't hidden — it's observable. Every dispatch, failover, and result is a structured event you can stream live."
      />
      <div className="mt-16 grid gap-6 lg:grid-cols-2">
        <Reveal className="min-w-0">
          <Terminal title="vision failover" lines={vision} />
          <p className="mt-4 text-center text-[12.5px] text-faint">
            The first provider has no vision model — the second one does. The user never notices.
          </p>
        </Reveal>
        <Reveal delay={0.1} className="min-w-0">
          <Terminal title="execution graph + live events" lines={graph} />
          <p className="mt-4 text-center text-[12.5px] text-faint">
            Preview the plan before it runs, then watch it execute in real time.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
