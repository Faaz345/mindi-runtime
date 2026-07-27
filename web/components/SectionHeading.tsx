import { Reveal } from "./Reveal";

export function SectionHeading({
  eyebrow,
  title,
  lead,
  align = "center",
}: {
  eyebrow: string;
  title: string;
  lead?: string;
  align?: "center" | "left";
}) {
  const alignCls = align === "center" ? "items-center text-center" : "items-start text-left";
  return (
    <Reveal className={`flex flex-col gap-4 ${alignCls}`}>
      <span className="font-mono text-[11px] uppercase tracking-[0.28em] text-glow-soft/80">
        {eyebrow}
      </span>
      <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-white sm:text-4xl">
        {title}
      </h2>
      {lead ? <p className="max-w-xl text-[15px] leading-relaxed text-mist">{lead}</p> : null}
    </Reveal>
  );
}
