import { Reveal } from "./Reveal";
import { SectionHeading } from "./SectionHeading";

const flow = [
  { k: "01", t: "Missing capability detected", d: "You pasted an image path — but your model is text-only." },
  { k: "02", t: "Runtime plans execution", d: "Intent analysis and a capability plan, built around your model's declared limits." },
  { k: "03", t: "Best executor runs it", d: "A provider or a deterministic tool. If one provider can't see, it fails over to one that can." },
  { k: "04", t: "Context returns to your model", d: "The result comes back as structured context. Your model keeps reasoning — as the assistant." },
];

export function WhatIs() {
  return (
    <section id="what" className="mx-auto max-w-6xl px-6 py-28 sm:py-36">
      <hr className="hairline mx-auto mb-28 max-w-4xl" />
      <SectionHeading
        eyebrow="What is MINDI?"
        title="An augmentation runtime — not another model."
        lead="Today's models are fragmented: some reason well, some see, some search, some run offline. You're forced to switch constantly. MINDI removes the switch."
      />

      <div className="mt-16 grid gap-5 md:grid-cols-2">
        <Reveal className="glass card-lift rounded-2xl p-8">
          <p className="text-[15px] leading-relaxed text-mist">
            Imagine a person who cannot walk. You don&apos;t replace the
            person —{" "}
            <span className="text-white">you provide them with legs.</span>
          </p>
          <p className="mt-5 text-[15px] leading-relaxed text-mist">
            MINDI follows the same philosophy. If your selected model lacks a
            capability, the runtime{" "}
            <span className="text-white">augments that model instead of replacing it.</span>{" "}
            The reasoning stays with the model you chose. The runtime only
            supplies what it&apos;s missing.
          </p>
          <div className="mt-8 rounded-xl border border-white/[0.07] bg-abyss/60 p-5 font-mono text-[12.5px] leading-loose">
            <div className="text-white">Primary Model</div>
            <div className="text-faint">↓</div>
            <div className="text-glow-soft">Runtime augments missing capability</div>
            <div className="text-faint">↓</div>
            <div className="text-white">Primary Model continues reasoning</div>
          </div>
        </Reveal>

        <div className="grid gap-5">
          {flow.map((s, i) => (
            <Reveal key={s.k} delay={0.06 * i} className="glass card-lift rounded-2xl p-6">
              <div className="flex items-start gap-5">
                <span className="font-mono text-[11px] tracking-widest text-glow-soft/70">{s.k}</span>
                <div>
                  <h3 className="text-[15px] font-medium text-white">{s.t}</h3>
                  <p className="mt-1.5 text-[13.5px] leading-relaxed text-mist">{s.d}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
