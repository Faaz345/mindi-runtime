import { Reveal } from "./Reveal";
import { SectionHeading } from "./SectionHeading";

const steps = [
  { name: "Prompt", desc: "You type naturally — a task, a question, a pasted image path.", kind: "io" },
  { name: "Intent Analysis", desc: "The runtime classifies what the request actually needs.", kind: "runtime" },
  { name: "Capability Planning", desc: "It compares that against what your model natively declares — and plans only the gap.", kind: "runtime" },
  { name: "Registry & Router", desc: "Candidates are ordered: preferred tool first, then providers — best first.", kind: "runtime" },
  { name: "Providers & Tools", desc: "The execution graph runs — parallel where possible, sequential where required, with retries and provider failover.", kind: "exec" },
  { name: "Context Builder", desc: "Results become structured context, injected back into the conversation.", kind: "runtime" },
  { name: "Your Model", desc: "The assistant you chose reasons over everything and answers.", kind: "io" },
  { name: "Streaming Response", desc: "Tokens stream to the terminal as they're generated.", kind: "io" },
];

const kindStyle: Record<string, string> = {
  io: "border-glow-soft/30 text-white",
  runtime: "border-white/[0.09] text-mist",
  exec: "border-glow-indigo/40 text-glow-cyan",
};

export function HowItWorks() {
  return (
    <section id="how-it-works" className="mx-auto max-w-6xl px-6 py-28 sm:py-36">
      <hr className="hairline mx-auto mb-28 max-w-4xl" />
      <SectionHeading
        eyebrow="How It Works"
        title="Every request, one lifecycle."
        lead="The same quiet pipeline for every prompt — whether the model needs nothing, or needs eyes."
      />

      <div className="mx-auto mt-16 max-w-2xl">
        {steps.map((s, i) => (
          <Reveal key={s.name} delay={0.05 * i}>
            <div className="flex gap-5">
              {/* Rail */}
              <div className="flex flex-col items-center">
                <span
                  className={`glass flex h-9 w-9 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] ${kindStyle[s.kind]}`}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                {i < steps.length - 1 ? (
                  <span className="my-1 w-px flex-1 bg-gradient-to-b from-glow-soft/25 to-white/[0.05]" />
                ) : null}
              </div>
              {/* Content */}
              <div className={i < steps.length - 1 ? "pb-8" : ""}>
                <h3 className="pt-1.5 text-[15px] font-medium text-white">{s.name}</h3>
                <p className="mt-1 max-w-md text-[13.5px] leading-relaxed text-mist">{s.desc}</p>
              </div>
            </div>
          </Reveal>
        ))}
      </div>

      <Reveal delay={0.15} className="mx-auto mt-14 max-w-2xl">
        <div className="glass rounded-xl p-5 text-center">
          <p className="text-[13px] leading-relaxed text-mist">
            <span className="text-white">Deterministic tools never get masked.</span>{" "}
            A sandbox violation surfaces as a sandbox violation. Provider errors
            trigger failover. The model is told what happened — so it never
            wastes turns probing a filesystem it can&apos;t reach.
          </p>
        </div>
      </Reveal>
    </section>
  );
}
