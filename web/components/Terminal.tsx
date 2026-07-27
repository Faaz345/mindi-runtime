"use client";

import { useEffect, useRef, useState } from "react";
import { useInView } from "framer-motion";
import { CopyButton } from "./CopyButton";

export type TermLine = {
  text: string;
  /** Tailwind class for coloring this line. */
  className?: string;
  /** Typed character-by-character (for commands). Output lines appear instantly. */
  typed?: boolean;
};

/**
 * Terminal window — the centerpiece component of the site.
 * Glass chrome, traffic-light dots, blinking caret, optional
 * type-in animation that plays once when scrolled into view.
 */
export function Terminal({
  title = "Terminal",
  lines,
  className = "",
  animate = true,
  copyText,
  speed = 26,
}: {
  title?: string;
  lines: TermLine[];
  className?: string;
  animate?: boolean;
  copyText?: string;
  /** ms per character for typed lines. */
  speed?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  const [progress, setProgress] = useState(() =>
    animate ? lines.map(() => 0) : lines.map((l) => l.text.length),
  );

  useEffect(() => {
    if (!animate || !inView) return;
    let line = 0;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const stepLine = () => {
      if (cancelled || line >= lines.length) return;
      const l = lines[line]!;
      const idx = line;
      if (!l.typed || l.text.length === 0) {
        setProgress((p) => {
          const n = [...p];
          n[idx] = l.text.length;
          return n;
        });
        line++;
        timers.push(setTimeout(stepLine, 140));
        return;
      }
      let ch = 0;
      const tick = () => {
        if (cancelled) return;
        ch++;
        setProgress((p) => {
          const n = [...p];
          n[idx] = ch;
          return n;
        });
        if (ch < l.text.length) {
          timers.push(setTimeout(tick, speed));
        } else {
          line++;
          timers.push(setTimeout(stepLine, 260));
        }
      };
      timers.push(setTimeout(tick, 320));
    };

    stepLine();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [animate, inView, lines, speed]);

  const visible = (i: number) => lines[i]!.text.slice(0, progress[i] ?? 0);
  const allDone = progress.every((p, i) => p >= lines[i]!.text.length);
  const activeLine = progress.findIndex((p, i) => p < lines[i]!.text.length);

  return (
    <div
      ref={ref}
      className={`glass overflow-hidden rounded-xl shadow-[0_24px_80px_-24px_rgba(2,9,20,0.9),0_0_60px_-30px_rgba(59,130,246,0.35)] ${className}`}
    >
      {/* Chrome */}
      <div className="flex items-center gap-2 border-b border-white/[0.06] bg-white/[0.02] px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]/70" />
        <span className="ml-3 font-mono text-[11px] tracking-wide text-faint">{title}</span>
        {copyText ? <CopyButton text={copyText} className="ml-auto" /> : null}
      </div>
      {/* Body */}
      <div className="overflow-x-auto px-5 py-4 font-mono text-[13px] leading-[1.75]">
        {lines.map((l, i) => (
          <div key={i} className={`whitespace-pre ${l.className ?? "text-slate-300"}`}>
            {visible(i)}
            {i === activeLine && !allDone ? (
              <span className="animate-caret text-glow-soft">▍</span>
            ) : null}
          </div>
        ))}
        {allDone ? (
          <div className="whitespace-pre text-slate-300">
            <span className="animate-caret text-glow-soft">▍</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
