import { Reveal } from "./Reveal";
import { SectionHeading } from "./SectionHeading";

const providers = [
  "OpenAI", "Google Gemini", "Anthropic", "Groq", "DeepSeek", "Together AI",
  "Fireworks AI", "OpenRouter", "TokenRouter", "LM Studio", "vLLM",
  "Any OpenAI-compatible API",
];

const clients = [
  { name: "Agentic Terminal", state: "now" },
  { name: "Scripting CLI", state: "now" },
  { name: "Desktop", state: "soon" },
  { name: "Web", state: "soon" },
  { name: "VS Code", state: "soon" },
  { name: "JetBrains", state: "soon" },
  { name: "SDK", state: "soon" },
  { name: "API", state: "soon" },
];

export function Ecosystem() {
  return (
    <section id="ecosystem" className="mx-auto max-w-6xl px-6 py-28 sm:py-36">
      <hr className="hairline mx-auto mb-28 max-w-4xl" />
      <SectionHeading
        eyebrow="Ecosystem"
        title="Plays well with what you already use."
        lead="Providers are interchangeable adapters. One OpenAI-compatible adapter alone covers an entire ecosystem of gateways and local servers."
      />

      <Reveal delay={0.1} className="mt-14">
        <div className="flex flex-wrap justify-center gap-2.5">
          {providers.map((p) => (
            <span
              key={p}
              className="glass card-lift cursor-default rounded-full px-4 py-2 text-[13px] text-mist hover:text-white"
            >
              {p}
            </span>
          ))}
        </div>
      </Reveal>

      <Reveal delay={0.18} className="mx-auto mt-16 max-w-4xl">
        <div className="glass rounded-2xl p-8">
          <p className="text-center font-mono text-[11px] uppercase tracking-[0.26em] text-faint">
            One runtime · every client
          </p>
          <div className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {clients.map((c) => (
              <div
                key={c.name}
                className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-abyss/50 px-4 py-3"
              >
                <span className="text-[13px] text-white">{c.name}</span>
                <span
                  className={`font-mono text-[10px] uppercase tracking-wider ${
                    c.state === "now" ? "text-emerald-300/90" : "text-faint"
                  }`}
                >
                  {c.state === "now" ? "● live" : "soon"}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-6 text-center text-[12.5px] leading-relaxed text-faint">
            Clients stay thin. The runtime owns orchestration, planning, routing,
            execution, memory, and streaming — only the interface changes.
          </p>
        </div>
      </Reveal>
    </section>
  );
}
