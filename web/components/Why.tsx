import { Reveal } from "./Reveal";
import { SectionHeading } from "./SectionHeading";

const reasons = [
  {
    title: "Your model stays the brain",
    body: "The runtime never silently switches models. The assistant you chose is the assistant that answers — capabilities are borrowed, reasoning is not.",
    glyph: (
      <path d="M12 3a7 7 0 0 1 7 7c0 2.4-1.2 3.9-2.3 5.2-.9 1-1.7 1.9-1.7 3.3h-6c0-1.4-.8-2.3-1.7-3.3C6.2 13.9 5 12.4 5 10a7 7 0 0 1 7-7Zm-3 17.5h6M10.5 22h3" />
    ),
  },
  {
    title: "Uses the keys you already have",
    body: "First launch auto-detects API keys from your environment, .env files, even Claude Code's config. OpenAI, Gemini, Anthropic, Groq, OpenRouter — pick one and go.",
    glyph: (
      <path d="m15.5 7.5 3 3L8 21l-4 1 1-4L15.5 7.5Zm0 0 2-2a2.1 2.1 0 0 1 3 3l-2 2m-3-3 3 3" />
    ),
  },
  {
    title: "Failover, built in",
    body: "When a provider can't execute a capability — say it has no vision model — the runtime sweeps to the next candidate instead of failing. Tools, being deterministic, fail fast and honestly.",
    glyph: (
      <path d="M17 2.5 21 6l-4 3.5M21 6H8a5 5 0 0 0-5 5v1m4 9.5L3 18l4-3.5M3 18h13a5 5 0 0 0 5-5v-1" />
    ),
  },
  {
    title: "Sandboxed by default",
    body: "Filesystem tools only reach inside your workspace. Terminal commands run against an allow-list. The agent is taught the sandbox rules — so it works with them, not around them.",
    glyph: (
      <path d="M12 3 4.5 6v5c0 4.7 3.2 8.4 7.5 10 4.3-1.6 7.5-5.3 7.5-10V6L12 3Zm-3 9.2 2.2 2.2 4-4" />
    ),
  },
  {
    title: "Sessions that persist",
    body: "Workspace persistence means you can close the terminal and resume the conversation later. History, context, and working state survive restarts.",
    glyph: (
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2ZM17 21v-8H7v8M7 3v5h8" />
    ),
  },
  {
    title: "One runtime, every client",
    body: "The terminal, the CLI, and every future MINDIGENOUS product — desktop, web, editor extensions, SDK — share this same runtime. Business logic never leaves it.",
    glyph: (
      <path d="M12 2.5 3 7v10l9 4.5L21 17V7l-9-4.5ZM3 7l9 4.5M12 11.5 21 7m-9 4.5V21" />
    ),
  },
];

export function Why() {
  return (
    <section id="why" className="mx-auto max-w-6xl px-6 py-28 sm:py-36">
      <hr className="hairline mx-auto mb-28 max-w-4xl" />
      <SectionHeading
        eyebrow="Why MINDI?"
        title="Built to be trusted with your work."
        lead="Design principles, not marketing claims. Every one of these is enforced in the runtime's code, not promised on a slide."
      />
      <div className="mt-16 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {reasons.map((r, i) => (
          <Reveal key={r.title} delay={0.05 * i} className="glass card-lift rounded-2xl p-7">
            <svg
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#60a5fa"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              className="mb-5 opacity-80"
            >
              {r.glyph}
            </svg>
            <h3 className="text-[15px] font-medium text-white">{r.title}</h3>
            <p className="mt-2.5 text-[13.5px] leading-relaxed text-mist">{r.body}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
