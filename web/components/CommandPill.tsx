"use client";

import { useState } from "react";
import { CopyButton } from "./CopyButton";

export type InstallTarget = {
  id: string;
  label: string;
  command: string;
  note: string;
};

/**
 * The install command — the primary CTA of the entire site.
 * One glowing pill, platform tabs, blinking prompt, copy button.
 */
export function CommandPill({ targets }: { targets: InstallTarget[] }) {
  const [active, setActive] = useState(0);
  const t = targets[active]!;

  return (
    <div className="w-full max-w-2xl">
      {/* Platform tabs */}
      <div className="mb-3 flex items-center justify-center gap-1">
        {targets.map((x, i) => (
          <button
            key={x.id}
            type="button"
            onClick={() => setActive(i)}
            className={`cursor-pointer rounded-full px-3.5 py-1.5 font-mono text-[11px] tracking-wider transition-all duration-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-glow ${
              i === active
                ? "border border-glow-soft/40 bg-glow/15 text-white"
                : "border border-transparent text-faint hover:text-mist"
            }`}
          >
            {x.label}
          </button>
        ))}
      </div>

      {/* The command itself */}
      <div className="glass group relative flex items-center gap-3 rounded-xl px-5 py-4 shadow-[0_0_70px_-18px_rgba(59,130,246,0.5)] transition-shadow duration-500 hover:shadow-[0_0_90px_-14px_rgba(59,130,246,0.65)]">
        <span className="select-none font-mono text-glow-soft">$</span>
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[13px] text-white sm:text-sm">
          {t.command}
        </code>
        <CopyButton text={t.command} />
        {/* Quiet glow underline */}
        <span className="pointer-events-none absolute inset-x-8 -bottom-px h-px bg-gradient-to-r from-transparent via-glow-soft/50 to-transparent" />
      </div>

      <p className="mt-3 text-center text-[13px] text-faint">{t.note}</p>
    </div>
  );
}
