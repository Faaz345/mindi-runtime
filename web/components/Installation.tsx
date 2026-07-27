"use client";

import { useState } from "react";
import { Reveal } from "./Reveal";
import { SectionHeading } from "./SectionHeading";
import { Terminal, type TermLine } from "./Terminal";

const platforms: { id: string; label: string; lines: TermLine[]; copy: string; foot: string }[] = [
  {
    id: "windows",
    label: "Windows",
    copy: "irm https://mindigenous.online/install.ps1 | iex",
    foot: "The installer checks for Node.js 22+, installs it if missing, installs mindigenous, and sets up PATH — then prints the welcome guide with a live system check.",
    lines: [
      { text: "irm https://mindigenous.online/install.ps1 | iex", typed: true, className: "text-white" },
      { text: "" },
      { text: "  ==> Checking for Node.js 22+ ...", className: "text-glow-soft" },
      { text: "      Node.js 22+ not found. Installing it for you (one-time)...", className: "text-amber-200/90" },
      { text: "      Node.js v22.19.0 installed.", className: "text-emerald-300/90" },
      { text: "  ==> Installing mindigenous ...", className: "text-glow-soft" },
      { text: "  Installation complete!", className: "text-emerald-300/90" },
      { text: "" },
      { text: "mindi", typed: true, className: "text-white" },
    ],
  },
  {
    id: "macos",
    label: "macOS",
    copy: "brew install node && npm install -g mindigenous && mindi",
    foot: "brew installs Node.js 22+ (skip if you already have it). npm installs the terminal globally. mindi launches it — onboarding handles the rest.",
    lines: [
      { text: "brew install node", typed: true, className: "text-white" },
      { text: "npm install -g mindigenous", typed: true, className: "text-white" },
      { text: "" },
      { text: "  MINDIGENOUS — agentic coding terminal installed successfully", className: "text-glow-soft" },
      { text: "  OK     Node.js v22.19.0", className: "text-emerald-300/90" },
      { text: "  OK     git version 2.51.0", className: "text-emerald-300/90" },
      { text: "" },
      { text: "mindi", typed: true, className: "text-white" },
    ],
  },
  {
    id: "linux",
    label: "Linux",
    copy: "curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt install -y nodejs && npm install -g mindigenous",
    foot: "Debian / Ubuntu shown — any distro works: install Node.js 22+ with your package manager, then the npm line. WSL counts as Linux.",
    lines: [
      { text: "curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -", typed: true, className: "text-white" },
      { text: "sudo apt install -y nodejs", typed: true, className: "text-white" },
      { text: "npm install -g mindigenous", typed: true, className: "text-white" },
      { text: "" },
      { text: "  added 45 packages in 8s", className: "text-faint" },
      { text: "" },
      { text: "mindi", typed: true, className: "text-white" },
    ],
  },
];

export function Installation() {
  const [active, setActive] = useState(0);
  const p = platforms[active]!;

  return (
    <section id="install" className="mx-auto max-w-6xl px-6 py-28 sm:py-36">
      <SectionHeading
        eyebrow="Installation"
        title="One command. Sixty seconds."
        lead="The install command is the product's front door — like Bun, Ollama, or Claude Code. No accounts, no dashboards, no setup wizard in a browser."
      />

      <Reveal delay={0.12} className="mt-14">
        <div className="mb-5 flex justify-center gap-1">
          {platforms.map((x, i) => (
            <button
              key={x.id}
              type="button"
              onClick={() => setActive(i)}
              className={`cursor-pointer rounded-full px-4 py-1.5 font-mono text-[11px] tracking-wider transition-all duration-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-glow ${
                i === active
                  ? "border border-glow-soft/40 bg-glow/15 text-white"
                  : "border border-transparent text-faint hover:text-mist"
              }`}
            >
              {x.label}
            </button>
          ))}
        </div>

        <div className="mx-auto max-w-3xl">
          <Terminal
            key={p.id}
            title={`PowerShell · ${p.label}`}
            lines={p.lines}
            copyText={p.copy}
          />
          <p className="mt-5 text-center text-[13.5px] leading-relaxed text-faint">{p.foot}</p>
        </div>
      </Reveal>
    </section>
  );
}
