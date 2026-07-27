import { Reveal } from "./Reveal";
import { SectionHeading } from "./SectionHeading";

const phases = [
  {
    when: "Now",
    state: "live",
    items: [
      "Agentic coding terminal on npm — mindi",
      "Scripting CLI — mindi-cli",
      "Native function calling + text protocol",
      "Provider failover for capabilities",
      "Workspace persistence & session resume",
      "Sandboxed filesystem + allow-listed terminal",
    ],
  },
  {
    when: "Next",
    state: "next",
    items: [
      "Windows one-line installer on mindigenous.online",
      "More capability modules",
      "Deeper observability & event tooling",
      "Documentation site",
    ],
  },
  {
    when: "Later",
    state: "later",
    items: [
      "Desktop app",
      "VS Code & JetBrains extensions",
      "Web client",
      "Public SDK & hosted API",
    ],
  },
];

const stateStyles: Record<string, { dot: string; label: string }> = {
  live: { dot: "bg-emerald-300", label: "text-emerald-300/90" },
  next: { dot: "bg-glow-soft", label: "text-glow-soft" },
  later: { dot: "bg-faint", label: "text-faint" },
};

export function Roadmap() {
  return (
    <section id="roadmap" className="mx-auto max-w-6xl px-6 py-28 sm:py-36">
      <hr className="hairline mx-auto mb-28 max-w-4xl" />
      <SectionHeading
        eyebrow="Roadmap"
        title="Where this is going."
        lead="One shared runtime at the center — interfaces multiply around it."
      />
      <div className="mt-16 grid gap-5 md:grid-cols-3">
        {phases.map((p, i) => (
          <Reveal key={p.when} delay={0.07 * i} className="glass card-lift rounded-2xl p-7">
            <div className="flex items-center gap-2.5">
              <span className={`h-1.5 w-1.5 rounded-full ${stateStyles[p.state]!.dot}`} />
              <h3 className={`font-mono text-[12px] uppercase tracking-[0.22em] ${stateStyles[p.state]!.label}`}>
                {p.when}
              </h3>
            </div>
            <ul className="mt-6 space-y-3">
              {p.items.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-[13.5px] leading-relaxed text-mist">
                  <span className="mt-2 h-px w-3 shrink-0 bg-glow-soft/40" />
                  {item}
                </li>
              ))}
            </ul>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
