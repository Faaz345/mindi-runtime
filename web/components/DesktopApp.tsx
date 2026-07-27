import { Reveal } from "./Reveal";

export function DesktopApp() {
  return (
    <section id="desktop" className="mx-auto max-w-6xl px-6 py-28 sm:py-36">
      <Reveal>
        <div className="glass relative overflow-hidden rounded-3xl px-8 py-16 text-center sm:px-16 sm:py-20">
          {/* Glow */}
          <div className="pointer-events-none absolute -top-32 left-1/2 h-72 w-[720px] -translate-x-1/2 rounded-[100%] bg-[radial-gradient(ellipse_at_center,rgba(59,130,246,0.18),transparent_70%)] blur-2xl" />

          <span className="font-mono text-[11px] uppercase tracking-[0.28em] text-glow-soft/80">
            Coming soon
          </span>
          <h2 className="mx-auto mt-4 max-w-xl text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            The desktop app.
            <br />
            <span className="text-mist">The same runtime. A new interface.</span>
          </h2>
          <p className="mx-auto mt-5 max-w-lg text-[15px] leading-relaxed text-mist">
            Everything the terminal does — orchestration, failover, sandboxed
            tools, persistent sessions — behind a cinematic desktop experience.
            The runtime doesn&apos;t change. Only the glass does.
          </p>
          <a
            href="https://github.com/Faaz345/mindi-runtime"
            target="_blank"
            rel="noreferrer"
            className="mt-9 inline-flex items-center gap-2 rounded-lg border border-glow-soft/30 bg-glow/10 px-5 py-2.5 text-[13.5px] text-white transition-all duration-300 hover:border-glow-soft/60 hover:bg-glow/20"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2Z" />
            </svg>
            Star the repo to follow along
          </a>
        </div>
      </Reveal>
    </section>
  );
}
