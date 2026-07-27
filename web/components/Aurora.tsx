"use client";

import { useEffect } from "react";

/**
 * Cinematic backdrop: deep navy field, slow-drifting aurora orbs,
 * a soft top beam, blueprint grid, and a quiet mouse spotlight.
 * Fixed position — sits behind every section. Zero per-frame JS
 * except one pointermove listener writing two CSS variables.
 */
export function Aurora() {
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      document.documentElement.style.setProperty("--spot-x", `${e.clientX}px`);
      document.documentElement.style.setProperty("--spot-y", `${e.clientY}px`);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  return (
    <div aria-hidden className="fixed inset-0 -z-10 overflow-hidden bg-abyss">
      {/* Base vertical wash */}
      <div className="absolute inset-0 bg-[linear-gradient(180deg,#030b1c_0%,#020914_45%,#020914_100%)]" />

      {/* Blueprint grid (masked to the top) */}
      <div className="bg-grid absolute inset-0" />

      {/* Aurora beam across the top */}
      <div className="absolute -top-[340px] left-1/2 h-[620px] w-[130%] -translate-x-1/2 rounded-[100%] bg-[radial-gradient(ellipse_at_center,rgba(59,130,246,0.16),rgba(99,102,241,0.07)_45%,transparent_72%)] blur-2xl" />

      {/* Floating light orbs */}
      <div className="animate-drift-slow absolute -left-40 top-[12%] h-[480px] w-[480px] rounded-full bg-[radial-gradient(circle,rgba(37,99,235,0.14),transparent_65%)] blur-3xl" />
      <div className="animate-drift-slower absolute right-[-10%] top-[38%] h-[560px] w-[560px] rounded-full bg-[radial-gradient(circle,rgba(99,102,241,0.11),transparent_65%)] blur-3xl" />
      <div className="animate-drift-slow absolute bottom-[6%] left-[22%] h-[440px] w-[440px] rounded-full bg-[radial-gradient(circle,rgba(56,189,248,0.08),transparent_65%)] blur-3xl" />

      {/* Cinematic vignette to keep edges quiet */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_120%_90%_at_50%_10%,transparent_55%,rgba(2,9,20,0.75)_100%)]" />
    </div>
  );
}
