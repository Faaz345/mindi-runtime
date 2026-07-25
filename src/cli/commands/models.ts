/** `mindi models` — lists all models across providers with declarations. */

import type { Runtime } from "../../index.js";
import { header, table, info, warn, colors, icons, formatMs } from "../format.js";

export async function modelsCommand(rt: Runtime, opts: { provider?: string }): Promise<void> {
  header("MINDI Runtime — Models");

  const providers = opts.provider
    ? [rt.providers.get(opts.provider)].filter(Boolean)
    : rt.providers.list();

  if (providers.length === 0) {
    warn("No providers registered.");
    return;
  }

  for (const provider of providers) {
    if (!provider) continue;
    info(`Provider: ${colors.cyan(provider.id)}`);

    let models;
    try {
      models = await provider.listModels();
    } catch (err) {
      process.stdout.write(`  ${icons.fail} Failed to list models: ${err instanceof Error ? err.message : String(err)}\n\n`);
      continue;
    }

    if (models.length === 0) {
      process.stdout.write(`  ${icons.dash} No models available\n\n`);
      continue;
    }

    const rows: string[][] = [];
    for (const m of models) {
      const caps = m.capabilities.join(", ") || colors.dim("—");
      const ctx = m.contextWindow ? formatMs(0).replace("<1ms", `${m.contextWindow} tok`) : colors.dim("—");
      rows.push([
        colors.cyan(m.id),
        m.label,
        caps,
        ctx,
      ]);
    }
    table(["Model ID", "Label", "Capabilities", "Context"], rows);
  }

  // Show capability declarations for specific models
  if (opts.provider) {
    const provider = rt.providers.get(opts.provider);
    if (provider) {
      process.stdout.write(`\n${colors.bold("Capability Declarations")}\n`);
      let models;
      try {
        models = await provider.listModels();
      } catch {
        return;
      }
      for (const m of models.slice(0, 5)) {
        try {
          const decl = await provider.declareCapability(m.id);
          process.stdout.write(`\n  ${colors.cyan(m.id)}:\n`);
          process.stdout.write(`    ${icons.bullet} streaming:       ${decl.streaming ? colors.green("yes") : colors.red("no")}\n`);
          process.stdout.write(`    ${icons.bullet} tool calling:     ${decl.toolCalling ? colors.green("yes") : colors.red("no")}\n`);
          process.stdout.write(`    ${icons.bullet} multimodal:       ${decl.multimodal ? colors.green("yes") : colors.red("no")}\n`);
          process.stdout.write(`    ${icons.bullet} embeddings:       ${decl.embeddingSupport ? colors.green("yes") : colors.red("no")}\n`);
          process.stdout.write(`    ${icons.bullet} image gen:        ${decl.imageGeneration ? colors.green("yes") : colors.red("no")}\n`);
          process.stdout.write(`    ${icons.bullet} audio:            ${decl.audioSupport ? colors.green("yes") : colors.red("no")}\n`);
          process.stdout.write(`    ${icons.bullet} max context:      ${decl.maxContext.toLocaleString()} tokens\n`);
          if (decl.maxOutputTokens) {
            process.stdout.write(`    ${icons.bullet} max output:       ${decl.maxOutputTokens.toLocaleString()} tokens\n`);
          }
        } catch (err) {
          process.stdout.write(`  ${icons.fail} ${m.id}: ${err instanceof Error ? err.message : "failed"}\n`);
        }
      }
    }
  }

  process.stdout.write("\n");
}
