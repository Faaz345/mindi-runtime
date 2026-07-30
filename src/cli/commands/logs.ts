/** `mindi-cli logs` — shows runtime event history / live event stream. */

import type { Runtime, RuntimeEvent } from "../../index.js";
import { header, info, warn, colors, icons } from "../format.js";

export async function logsCommand(
  rt: Runtime,
  opts: { follow?: boolean; filter?: string; limit?: number },
): Promise<void> {
  if (opts.follow) {
    header("MINDI Runtime — Live Event Stream");
    info("Listening for events (Ctrl+C to stop)...\n");
    process.stdout.write(`${colors.dim("─".repeat(80))}\n`);

    rt.onAny((ev) => {
      printEvent(ev, opts.filter);
    });

    // Keep process alive
    return new Promise(() => {});
  }

  // Show recent history
  header("MINDI Runtime — Event History");

  const history = rt.getHistory();
  if (history.length === 0) {
    warn("No events in history. Run a request first (mindi-cli run).");
    return;
  }

  const limit = opts.limit ?? 50;
  const recent = history.slice(-limit);

  info(`Showing last ${recent.length} of ${history.length} events\n`);
  process.stdout.write(`${colors.dim("─".repeat(80))}\n`);

  for (const ev of recent) {
    printEvent(ev, opts.filter);
  }

  process.stdout.write("\n");
}

function printEvent(ev: RuntimeEvent, filter?: string): void {
  const ts = new Date(ev.timestamp).toISOString().slice(11, 23);
  const type = ev.type;
  const icon = eventIcon(type);

  let detail = "";
  switch (ev.type) {
    case "request:start":
      detail = `${colors.blue(ev.model)} "${ev.input.slice(0, 50)}${ev.input.length > 50 ? "..." : ""}"`;
      break;
    case "request:end":
      detail = `${ev.ok ? colors.green("OK") : colors.red("FAIL")} ${ev.durationMs}ms`;
      break;
    case "session:created":
      detail = colors.dim(ev.sessionId.slice(0, 12));
      break;
    case "intent:analyzed":
      detail = `caps=[${ev.intent.requiredCapabilities.join(",")}] conf=${(ev.intent.confidence * 100).toFixed(0)}%`;
      break;
    case "planner:plan":
      detail = `satisfied=[${ev.plan.satisfied.join(",")}] missing=[${ev.plan.missing.map((m) => m.type).join(",")}] unavailable=[${ev.plan.unavailable.map((u) => u.type).join(",")}]`;
      break;
    case "capability:dispatch":
      detail = `${colors.cyan(ev.capabilityType)} → ${colors.blue(ev.executor)}:${ev.capabilityId}`;
      break;
    case "capability:success":
      detail = `${colors.green("OK")} ${ev.durationMs}ms ${ev.capabilityId}`;
      break;
    case "capability:error":
      detail = `${colors.red("FAIL")} ${ev.capabilityId}: ${ev.error}`;
      break;
    case "context:assembled":
      detail = `injected ${ev.injectedCount} context message(s)`;
      break;
    case "execution_graph_created":
      detail = `graph ${ev.graphId.slice(0, 8)} (${ev.nodeCount} nodes)`;
      break;
    case "node_started":
      detail = `${colors.cyan(ev.capability)} node=${ev.nodeId}`;
      break;
    case "node_completed":
      detail = `${ev.ok ? colors.green("OK") : colors.red("FAIL")} ${ev.durationMs}ms node=${ev.nodeId}`;
      break;
    case "node_failed":
      detail = `${colors.red("FAIL")} ${ev.nodeId}: ${ev.error}`;
      break;
    case "graph_completed":
      detail = `${ev.ok ? colors.green("OK") : colors.red("FAIL")} ${ev.durationMs}ms completed=${ev.completedNodes} failed=${ev.failedNodes}`;
      break;
    case "provider:stream":
      detail = `${colors.blue(ev.providerId)}/${ev.model}`;
      break;
    case "provider:chunk":
      detail = colors.dim(`"${ev.delta.slice(0, 40)}${ev.delta.length > 40 ? "..." : ""}"`);
      break;
    case "provider:done":
      detail = `finish=${ev.finishReason}`;
      break;
    case "memory:written":
      detail = `${ev.entries} entries`;
      break;
    default:
      detail = colors.dim(JSON.stringify(ev).slice(0, 80));
  }

  if (filter && !type.includes(filter) && !detail.includes(filter)) return;

  process.stdout.write(`${colors.dim(ts)} ${icon} ${colors.bold(type.padEnd(26))} ${detail}\n`);
}

function eventIcon(type: string): string {
  if (type.includes("error") || type.includes("failed")) return icons.fail;
  if (type.includes("success") || type.includes("completed")) return icons.ok;
  if (type.includes("start")) return colors.cyan("▶");
  if (type.includes("dispatch")) return icons.arrow;
  return icons.dot;
}
