/** `mindi providers` — lists registered providers + their capabilities. */

import type { Runtime } from "../../index.js";
import { CapabilityType } from "../../index.js";
import { header, table, info, colors, icons } from "../format.js";

export function providersCommand(rt: Runtime): void {
  header("MINDI Runtime — Providers");

  const providers = rt.providers.list();
  if (providers.length === 0) {
    info("No providers registered.");
    info("Set OPENAI_API_KEY or GEMINI_API_KEY in .env to register providers.");
    return;
  }

  const rows: string[][] = [];
  for (const p of providers) {
    const caps = Array.from(p.capabilities).map(capLabel).join(", ");
    rows.push([
      colors.cyan(p.id),
      p.label,
      caps || colors.dim("none"),
    ]);
  }
  table(["ID", "Label", "Capabilities"], rows);

  // Show capability details per provider
  for (const p of providers) {
    process.stdout.write(`\n${colors.bold(colors.cyan(p.id))}\n`);
    process.stdout.write(`  ${icons.bullet} Label: ${p.label}\n`);
    process.stdout.write(`  ${icons.bullet} Capabilities: ${Array.from(p.capabilities).map(capLabel).join(", ")}\n`);

    // Health check
    const health = p.health();
    health.then((h) => {
      if (h.ok) {
        process.stdout.write(`  ${icons.ok} Healthy (${h.latencyMs !== undefined ? `${h.latencyMs}ms` : ""})\n`);
      } else {
        process.stdout.write(`  ${icons.fail} Unhealthy: ${h.error ?? "unknown"}\n`);
      }
    });
  }
  process.stdout.write("\n");
}

function capLabel(type: CapabilityType): string {
  const labels: Record<string, string> = {
    vision: "Vision",
    ocr: "OCR",
    web_search: "WebSearch",
    browser: "Browser",
    filesystem: "FS",
    git: "Git",
    terminal: "Terminal",
    image_generation: "ImageGen",
    audio: "Audio",
    embeddings: "Embed",
    database: "DB",
    chat: "Chat",
  };
  return labels[type] ?? type;
}
