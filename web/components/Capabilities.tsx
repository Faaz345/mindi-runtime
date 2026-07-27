import { Reveal } from "./Reveal";
import { SectionHeading } from "./SectionHeading";

const caps = [
  { name: "Vision", desc: "Screenshot, photo, and diagram analysis — routed to a provider that can actually see.", tag: "provider" },
  { name: "OCR", desc: "Text extraction from images and scanned documents.", tag: "provider" },
  { name: "Web Search", desc: "Live information retrieval when the task needs the current world.", tag: "provider · tool" },
  { name: "Browser Automation", desc: "Navigate, read, and capture pages as part of a plan.", tag: "tool" },
  { name: "Filesystem", desc: "Read, write, and organize project files — workspace-sandboxed.", tag: "tool" },
  { name: "Git", desc: "Status, diffs, and history as first-class capability nodes.", tag: "tool" },
  { name: "Terminal", desc: "Allow-listed command execution with deterministic results.", tag: "tool" },
  { name: "Image Generation", desc: "Visual assets created inside the same reasoning loop.", tag: "provider" },
  { name: "Audio Processing", desc: "Speech and sound handled as pluggable capability modules.", tag: "provider" },
  { name: "Embeddings", desc: "Vector representations for memory and retrieval.", tag: "provider" },
  { name: "Databases", desc: "Structured storage wired into capability plans.", tag: "tool" },
  { name: "Future modules", desc: "Every capability is reusable, replaceable, and independent. New ones drop in.", tag: "registry" },
];

export function Capabilities() {
  return (
    <section id="capabilities" className="mx-auto max-w-6xl px-6 py-28 sm:py-36">
      <hr className="hairline mx-auto mb-28 max-w-4xl" />
      <SectionHeading
        eyebrow="Core Capabilities"
        title="Missing senses, on demand."
        lead="Capabilities are independent modules. The registry knows them, the router picks the best executor — a provider or a deterministic tool — and your model receives the result as context."
      />
      <div className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {caps.map((c, i) => (
          <Reveal key={c.name} delay={0.03 * i} className="glass card-lift rounded-xl p-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-[14px] font-medium text-white">{c.name}</h3>
              <span className="rounded-full border border-white/[0.08] px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-faint">
                {c.tag}
              </span>
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-mist">{c.desc}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
