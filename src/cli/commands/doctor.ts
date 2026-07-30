/** `mindi-cli doctor` — health checks all providers, shows diagnostics. */

import type { Runtime } from "../../index.js";
import { header, section, success, warn, error, info, table, formatMs, colors, icons } from "../format.js";

export async function doctorCommand(rt: Runtime): Promise<void> {
  header("MINDI Runtime — Doctor");

  // 1. Config check
  section("Configuration");
  const cfg = rt.config;
  info(`Default provider: ${colors.cyan(cfg.defaultProviderId)}`);
  info(`Default model:    ${colors.cyan(cfg.defaultModel)}`);
  info(`Log level:        ${cfg.logLevel}`);
  info(`Request timeout:  ${formatMs(cfg.requestTimeoutMs)}`);
  info(`Tool timeout:     ${formatMs(cfg.toolTimeoutMs)}`);
  info(`Max history:      ${cfg.maxHistoryMessages} messages`);

  // 2. Provider health checks
  section("Provider Health");
  const healthResults = await rt.health();
  if (healthResults.length === 0) {
    warn("No providers registered. Set OPENAI_API_KEY or GEMINI_API_KEY in .env");
    return;
  }

  const rows: string[][] = [];
  for (const h of healthResults) {
    const status = h.ok ? `${icons.ok} OK` : `${icons.fail} DOWN`;
    const latency = h.latencyMs !== undefined ? formatMs(h.latencyMs) : "—";
    rows.push([
      colors.cyan(h.providerId),
      status,
      latency,
      h.error ? colors.red(h.error) : colors.dim("—"),
    ]);
  }
  table(["Provider", "Status", "Latency", "Error"], rows);

  const allOk = healthResults.every((h) => h.ok);
  if (allOk) {
    success("All providers are healthy.\n");
  } else {
    const failed = healthResults.filter((h) => !h.ok);
    error(`${failed.length} provider(s) are down. Check API keys and network.`);
  }

  // 3. Tools check
  section("Tools");
  const toolIds = rt.toolRuntime.list();
  if (toolIds.length === 0) {
    warn("No tools registered.");
  } else {
    info(`Registered tools (${toolIds.length}):`);
    for (const id of toolIds) {
      process.stdout.write(`  ${icons.bullet} ${colors.cyan(id)}\n`);
    }
  }

  // 4. Capabilities check
  section("Capability Registry");
  const capIds = rt.registry.list();
  if (capIds.length === 0) {
    warn("No capabilities registered.");
  } else {
    info(`Registered capabilities (${capIds.length}):`);
    for (const id of capIds) {
      process.stdout.write(`  ${icons.bullet} ${colors.cyan(id)}\n`);
    }
  }

  // 5. Sessions check
  section("Sessions");
  const sessions = rt.sessions.list();
  info(`Active sessions: ${sessions.length}`);
  if (sessions.length > 0) {
    const sRows = sessions.map((s) => [
      colors.dim(s.id.slice(0, 8)),
      colors.cyan(s.providerId),
      s.modelId,
      new Date(s.updatedAt).toISOString(),
    ]);
    table(["ID", "Provider", "Model", "Updated"], sRows);
  }

  process.stdout.write("\n");
}
