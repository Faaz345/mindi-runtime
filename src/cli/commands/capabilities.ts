/** `mindi capabilities` — lists all capability types + their executors. */

import type { Runtime, CapabilityType } from "../../index.js";
import { CapabilityTypes as Caps } from "../../index.js";
import { header, table, info, colors, icons } from "../format.js";

const ALL_CAPS: CapabilityType[] = [
  Caps.Chat, Caps.Vision, Caps.OCR, Caps.WebSearch, Caps.Browser,
  Caps.Filesystem, Caps.Git, Caps.Terminal, Caps.ImageGeneration,
  Caps.Audio, Caps.Embeddings, Caps.Database,
];

export function capabilitiesCommand(rt: Runtime): void {
  header("MINDI Runtime — Capabilities");

  const rows: string[][] = [];
  for (const cap of ALL_CAPS) {
    const executors = rt.registry.getByType(cap);
    const toolExecutors = executors.filter((e) => e.source === "tool");
    const providerExecutors = executors.filter((e) => e.source === "provider");

    const status = executors.length > 0
      ? `${icons.ok} available`
      : `${icons.dash} no executor`;

    const executorList = [
      ...toolExecutors.map((e) => colors.green(`tool:${e.id}`)),
      ...providerExecutors.map((e) => colors.blue(`provider:${e.id}`)),
    ].join(", ") || colors.dim("—");

    rows.push([
      colors.cyan(capLabel(cap)),
      status,
      String(executors.length),
      executorList,
    ]);
  }
  table(["Capability", "Status", "Executors", "IDs"], rows);

  const available = ALL_CAPS.filter((c) => rt.registry.has(c)).length;
  info(`Total: ${ALL_CAPS.length} capability types, ${available} available.\n`);
}

function capLabel(type: CapabilityType): string {
  const labels: Record<string, string> = {
    vision: "Vision",
    ocr: "OCR",
    web_search: "Web Search",
    browser: "Browser",
    filesystem: "Filesystem",
    git: "Git",
    terminal: "Terminal",
    image_generation: "Image Gen",
    audio: "Audio",
    embeddings: "Embeddings",
    database: "Database",
    chat: "Chat",
  };
  return labels[type] ?? type;
}
