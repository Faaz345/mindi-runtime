import Image from "next/image";
import { CopyButton } from "./CopyButton";

const cols = [
  {
    title: "Product",
    links: [
      { label: "Install", href: "#install" },
      { label: "Capabilities", href: "#capabilities" },
      { label: "How it works", href: "#how-it-works" },
      { label: "Roadmap", href: "#roadmap" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "GitHub", href: "https://github.com/Faaz345/mindi-runtime" },
      { label: "npm", href: "https://www.npmjs.com/package/mindigenous" },
      { label: "Issues", href: "https://github.com/Faaz345/mindi-runtime/issues" },
      { label: "Docs", href: "https://github.com/Faaz345/mindi-runtime#readme" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-white/[0.05] px-6 py-16">
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-12 md:grid-cols-[1.4fr_1fr_1fr_1.4fr]">
          <div>
            <div className="flex items-center gap-2.5">
              <Image src="/logo.svg" alt="MINDIGENOUS" width={22} height={22} className="opacity-90" />
              <span className="text-[13px] font-semibold tracking-[0.22em] text-white">MINDIGENOUS</span>
            </div>
            <p className="mt-4 max-w-xs text-[13px] leading-relaxed text-faint">
              One Runtime. Any Model. Unified Capabilities.
            </p>
          </div>
          {cols.map((c) => (
            <div key={c.title}>
              <h4 className="font-mono text-[11px] uppercase tracking-[0.22em] text-faint">{c.title}</h4>
              <ul className="mt-4 space-y-2.5">
                {c.links.map((l) => (
                  <li key={l.label}>
                    <a
                      href={l.href}
                      target={l.href.startsWith("http") ? "_blank" : undefined}
                      rel={l.href.startsWith("http") ? "noreferrer" : undefined}
                      className="text-[13px] text-mist transition-colors duration-300 hover:text-white"
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div>
            <h4 className="font-mono text-[11px] uppercase tracking-[0.22em] text-faint">Install</h4>
            <div className="glass mt-4 flex items-center justify-between gap-3 rounded-lg px-3.5 py-2.5">
              <code className="truncate font-mono text-[11.5px] text-mist">npm install -g mindigenous</code>
              <CopyButton text="npm install -g mindigenous" label="" />
            </div>
          </div>
        </div>
        <hr className="hairline my-12" />
        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
          <p className="text-[12px] text-faint">MIT License · Built by MINDIGENOUS</p>
          <p className="font-mono text-[11px] text-faint">v0.1.3</p>
        </div>
      </div>
    </footer>
  );
}
