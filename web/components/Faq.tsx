"use client";

import { useState } from "react";
import { Reveal } from "./Reveal";
import { SectionHeading } from "./SectionHeading";

const faqs = [
  {
    q: "Do I need to install Node.js?",
    a: "Only once. On Windows, the one-line installer (irm … | iex) installs Node 22+ for you automatically. On macOS, brew install node does it. After that, everything is just: mindi.",
  },
  {
    q: "Which API key do I need?",
    a: "Any one you already have — OpenAI, Google Gemini, Anthropic, Groq, DeepSeek, Together, Fireworks, OpenRouter, or TokenRouter. The first launch auto-detects keys from your environment, .env files, and even Claude Code's config. A free Google AI Studio key is the easiest way to start.",
  },
  {
    q: "Does MINDI replace my model?",
    a: "Never. Your selected model remains the reasoning engine and the voice that answers you. The runtime only executes the capabilities the model lacks — and hands the results back as context. It augments; it does not substitute.",
  },
  {
    q: "Is it safe to let it touch my files?",
    a: "The agent runs in a sandbox: filesystem tools only reach inside your workspace, and terminal commands are checked against an allow-list. The agent is explicitly taught these rules, and violations surface as errors — they are never silently worked around.",
  },
  {
    q: "Does it work offline or with local models?",
    a: "Yes. Set OPENAI_BASE_URL to any OpenAI-compatible server — LM Studio, vLLM, or a local gateway — and the runtime treats it like any other provider, augmenting it with capabilities it doesn't have.",
  },
  {
    q: "Is it free?",
    a: "The runtime is open source under the MIT license. You bring your own provider keys; costs are whatever your chosen provider charges for the tokens you use.",
  },
];

function Item({ q, a, open, onToggle }: { q: string; a: string; open: boolean; onToggle: () => void }) {
  return (
    <div className="glass overflow-hidden rounded-xl">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between gap-4 px-6 py-5 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-glow"
      >
        <span className="text-[14.5px] font-medium text-white">{q}</span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className={`shrink-0 text-faint transition-transform duration-300 ${open ? "rotate-45" : ""}`}
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-400 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <p className="px-6 pb-6 text-[13.5px] leading-relaxed text-mist">{a}</p>
        </div>
      </div>
    </div>
  );
}

export function Faq() {
  const [open, setOpen] = useState(0);
  return (
    <section id="faq" className="mx-auto max-w-3xl px-6 py-28 sm:py-36">
      <hr className="hairline mx-auto mb-28 max-w-4xl" />
      <SectionHeading eyebrow="FAQ" title="Quiet answers." />
      <div className="mt-14 space-y-3">
        {faqs.map((f, i) => (
          <Reveal key={f.q} delay={0.04 * i}>
            <Item q={f.q} a={f.a} open={open === i} onToggle={() => setOpen(open === i ? -1 : i)} />
          </Reveal>
        ))}
      </div>
    </section>
  );
}
