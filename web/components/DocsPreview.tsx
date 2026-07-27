import { Reveal } from "./Reveal";
import { SectionHeading } from "./SectionHeading";
import { Terminal, type TermLine } from "./Terminal";

const helpLines: TermLine[] = [
  { text: "mindi-cli --help", typed: true, className: "text-white" },
  { text: "" },
  { text: "  setup        First-run onboarding wizard", className: "text-slate-300" },
  { text: "  doctor       Health-check all providers", className: "text-slate-300" },
  { text: "  run          Execute a request, stream output", className: "text-slate-300" },
  { text: "  graph        Visualize the execution graph", className: "text-slate-300" },
  { text: "  logs         Live runtime event stream", className: "text-slate-300" },
  { text: "  models       List models across providers", className: "text-slate-300" },
  { text: "  inspect      Session history + metrics", className: "text-slate-300" },
  { text: "  config       Show / validate resolved config", className: "text-slate-300" },
];

const envLines: TermLine[] = [
  { text: "# .env — any one key is enough to start", className: "text-faint" },
  { text: "OPENAI_API_KEY=sk-...", className: "text-slate-300" },
  { text: "GEMINI_API_KEY=...", className: "text-slate-300" },
  { text: "" },
  { text: "# any OpenAI-compatible gateway works too", className: "text-faint" },
  { text: "OPENAI_BASE_URL=http://localhost:1234/v1   # LM Studio", className: "text-glow-cyan" },
  { text: "" },
  { text: "MINDI_DEFAULT_PROVIDER=openai", className: "text-slate-300" },
  { text: "MINDI_DEFAULT_MODEL=gpt-4o-mini", className: "text-slate-300" },
];

export function DocsPreview() {
  return (
    <section id="docs" className="mx-auto max-w-6xl px-6 py-28 sm:py-36">
      <hr className="hairline mx-auto mb-28 max-w-4xl" />
      <SectionHeading
        eyebrow="Documentation Preview"
        title="A power CLI, when you want one."
        lead="The interactive terminal is the front door. mindi-cli is the scripting surface — diagnostics, graphs, logs, and one-shot runs."
      />
      <div className="mt-16 grid gap-6 lg:grid-cols-2">
        <Reveal className="min-w-0">
          <Terminal title="command surface" lines={helpLines} copyText="mindi-cli --help" />
        </Reveal>
        <Reveal delay={0.1} className="min-w-0">
          <Terminal title="configuration" lines={envLines} animate={false} copyText={"OPENAI_API_KEY=sk-...\nGEMINI_API_KEY=...\nOPENAI_BASE_URL=http://localhost:1234/v1"} />
        </Reveal>
      </div>
      <Reveal delay={0.15} className="mt-10 text-center">
        <a
          href="https://github.com/Faaz345/mindi-runtime#readme"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 text-[13.5px] text-glow-soft transition-colors duration-300 hover:text-white"
        >
          Read the full documentation on GitHub
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M7 17 17 7M8 7h9v9" />
          </svg>
        </a>
      </Reveal>
    </section>
  );
}
