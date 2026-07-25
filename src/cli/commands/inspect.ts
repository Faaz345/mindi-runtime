/** `mindi inspect` — shows session history + runtime state. */

import type { Runtime } from "../../index.js";
import { header, section, info, warn, error, colors, icons, table, formatMs } from "../format.js";

export async function inspectCommand(
  rt: Runtime,
  opts: { sessionId?: string; events?: boolean; metrics?: boolean },
): Promise<void> {
  header("MINDI Runtime — Inspect");

  if (opts.sessionId) {
    // Inspect a specific session
    let session;
    try {
      session = rt.getSession(opts.sessionId);
    } catch {
      error(`Session not found: ${opts.sessionId}`);
      return;
    }

    section(`Session: ${session.id.slice(0, 12)}...`);
    info(`Provider:   ${colors.cyan(session.providerId)}`);
    info(`Model:      ${colors.cyan(session.modelId)}`);
    info(`Created:    ${new Date(session.createdAt).toISOString()}`);
    info(`Updated:    ${new Date(session.updatedAt).toISOString()}`);
    if (session.systemPrompt) {
      info(`System:     ${colors.dim(session.systemPrompt.slice(0, 80))}...`);
    }

    // Show conversation history
    section("Conversation History");
    const history = await rt.sessions.recall(session.id);
    if (history.length === 0) {
      warn("No messages in history.");
    } else {
      for (const msg of history) {
        const role = roleLabel(msg.role);
        const content = typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
        const truncated = content.length > 120 ? content.slice(0, 117) + "..." : content;
        process.stdout.write(`  ${role.padEnd(12)} ${colors.dim(truncated)}\n`);
      }
      info(`Total: ${history.length} messages\n`);
    }
  } else {
    // General runtime inspection
    section("Sessions");
    const sessions = rt.sessions.list();
    if (sessions.length === 0) {
      warn("No active sessions.");
    } else {
      const rows = sessions.map((s) => [
        colors.dim(s.id.slice(0, 12)),
        colors.cyan(s.providerId),
        s.modelId,
        new Date(s.updatedAt).toISOString(),
      ]);
      table(["ID", "Provider", "Model", "Updated"], rows);
    }
  }

  if (opts.events) {
    section("Event History");
    const history = rt.getHistory();
    if (history.length === 0) {
      warn("No events in history.");
    } else {
      info(`Total events: ${history.length}`);
      // Show last 30 events
      const recent = history.slice(-30);
      for (const ev of recent) {
        const ts = new Date(ev.timestamp).toISOString().slice(11, 23);
        process.stdout.write(`  ${colors.dim(ts)} ${eventIcon(ev.type)} ${ev.type}\n`);
      }
    }
  }

  if (opts.metrics) {
    section("Metrics");
    const m = rt.getMetrics();
    info(`Requests:           ${m.requests.total} (ok: ${m.requests.succeeded}, fail: ${m.requests.failed})`);
    info(`Avg latency:        ${formatMs(m.requests.avgLatencyMs)}`);
    info(`P50 latency:        ${formatMs(m.requests.p50LatencyMs)}`);
    info(`P99 latency:        ${formatMs(m.requests.p99LatencyMs)}`);
    info(`Capabilities:       ${m.capabilities.total} (ok: ${m.capabilities.succeeded}, fail: ${m.capabilities.failed})`);
    info(`Avg cap latency:    ${formatMs(m.capabilities.avgLatencyMs)}`);
    info(`Graphs:             ${m.graph.total} (ok: ${m.graph.succeeded}, fail: ${m.graph.failed})`);
    info(`Avg graph time:     ${formatMs(m.graph.avgDurationMs)}`);
    info(`Retries:            ${m.retries}`);
    info(`Cache hits:         ${m.cacheHits}`);
    info(`Cache misses:       ${m.cacheMisses}`);
    info(`Tokens used:        ${m.tokensUsed.toLocaleString()}`);

    if (m.errorsByCode.size > 0) {
      section("Errors by Code");
      for (const [code, count] of m.errorsByCode) {
        process.stdout.write(`  ${icons.fail} ${colors.red(code)}: ${count}\n`);
      }
    }

    if (m.capabilities.perType.size > 0) {
      section("Per-Capability Stats");
      const rows: string[][] = [];
      for (const [type, stats] of m.capabilities.perType) {
        rows.push([
          colors.cyan(type),
          String(stats.count),
          formatMs(stats.avgLatencyMs),
          String(stats.failures),
        ]);
      }
      table(["Capability", "Count", "Avg Latency", "Failures"], rows);
    }
  }

  process.stdout.write("\n");
}

function roleLabel(role: string): string {
  const labels: Record<string, string> = {
    system: colors.magenta("system"),
    user: colors.blue("user"),
    assistant: colors.green("assistant"),
    tool: colors.yellow("tool"),
    capability: colors.cyan("capability"),
  };
  return labels[role] ?? role;
}

function eventIcon(type: string): string {
  if (type.includes("error") || type.includes("failed")) return icons.fail;
  if (type.includes("success") || type.includes("completed")) return icons.ok;
  if (type.includes("start")) return icons.arrow;
  return icons.dot;
}
