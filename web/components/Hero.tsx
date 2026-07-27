import { CommandPill } from "./CommandPill";
import { Reveal } from "./Reveal";
import { Terminal, type TermLine } from "./Terminal";

const session: TermLine[] = [
  { text: "mindi", typed: true, className: "text-white" },
  { text: "" },
  { text: "  MINDIGENOUS — agentic coding terminal", className: "text-glow-soft" },
  { text: "  ✓ OpenAI key detected (environment)", className: "text-emerald-300/90" },
  { text: "  ✓ Gemini key detected (~/.claude)", className: "text-emerald-300/90" },
  { text: "  Model: gpt-4o-mini · session restored", className: "text-faint" },
  { text: "" },
  { text: '❯ recreate "C:\\shots\\hero.png" as a webpage', typed: true, className: "text-white" },
  { text: "  ⚡ capability: vision → openai.vision", className: "text-amber-200/90" },
  { text: "  ✓ analysis injected → writing index.html", className: "text-emerald-300/90" },
  { text: "  Done. Open ./index.html to preview.", className: "text-mist" },
];

export function Hero() {
  return (
    <section id="top" className="relative mx-auto flex max-w-6xl flex-col items-center px-6 pb-28 pt-36 sm:pt-44">
      {/* Eyebrow */}
      <Reveal>
        <a
          href="https://www.npmjs.com/package/mindigenous"
          target="_blank"
          rel="noreferrer"
          className="glass inline-flex items-center gap-2.5 rounded-full px-4 py-1.5 text-[12px] text-mist transition-colors duration-300 hover:text-white"
        >
          <span className="h-1.5 w-1.5 animate-pulse-glow rounded-full bg-glow-soft" />
          v0.1.3 on npm
          <span className="text-faint">·</span>
          <span className="font-mono text-[11px]">npm install -g mindigenous</span>
        </a>
      </Reveal>

      {/* Headline */}
      <Reveal delay={0.08} className="mt-9 text-center">
        <h1 className="text-glow max-w-4xl text-5xl font-semibold leading-[1.04] tracking-tight text-white sm:text-6xl md:text-7xl">
          One runtime.
          <br />
          Any model.
          <br />
          <span className="bg-gradient-to-r from-glow-soft via-glow-cyan to-glow-indigo bg-clip-text text-transparent">
            Unified capabilities.
          </span>
        </h1>
      </Reveal>

      {/* Sub */}
      <Reveal delay={0.16} className="mt-7 max-w-2xl text-center">
        <p className="text-[15.5px] leading-relaxed text-mist sm:text-base">
          MINDIGENOUS is an agentic coding terminal. You choose the model — the
          runtime quietly gives it the capabilities it&apos;s missing: vision,
          web, filesystem, git, terminal. Your assistant never changes. It just
          gets legs.
        </p>
      </Reveal>

      {/* Primary CTA — the install command */}
      <Reveal delay={0.24} className="mt-11 flex w-full justify-center">
        <CommandPill
          targets={[
            {
              id: "win",
              label: "Windows",
              command: "irm https://mindigenous.online/install.ps1 | iex",
              note: "One line. Installs Node.js if needed, then mindi — nothing else to do.",
            },
            {
              id: "unix",
              label: "macOS · Linux",
              command: "npm install -g mindigenous && mindi",
              note: "Requires Node.js 22+. Then just: mindi",
            },
          ]}
        />
      </Reveal>

      {/* Live session preview */}
      <Reveal delay={0.32} className="mt-16 w-full max-w-3xl">
        <Terminal title="mindi — first run" lines={session} />
      </Reveal>

      {/* Trust row */}
      <Reveal delay={0.4} className="mt-10">
        <p className="font-mono text-[11px] tracking-[0.18em] text-faint">
          NODE 22+ · MIT LICENSED · OPEN SOURCE · USES THE API KEYS YOU ALREADY HAVE
        </p>
      </Reveal>
    </section>
  );
}
