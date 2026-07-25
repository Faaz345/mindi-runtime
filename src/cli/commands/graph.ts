/** `mindi graph` — visualizes the execution graph for a request. */

import type { Runtime, StreamEvent } from "../../index.js";
import { header, info, warn, error, colors, icons, formatMs, section } from "../format.js";

export async function graphCommand(
  rt: Runtime,
  opts: {
    provider?: string;
    model?: string;
    text: string;
    sessionId?: string;
  },
): Promise<void> {
  // Create or reuse a session
  let sessionId = opts.sessionId;
  if (!sessionId) {
    const provider = opts.provider || rt.config.defaultProviderId;
    const model = opts.model || rt.config.defaultModel;
    try {
      const session = rt.createSession({ providerId: provider, modelId: model });
      sessionId = session.id;
    } catch (err) {
      error(`Failed to create session: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }

  header("MINDI Runtime — Execution Graph");
  info(`Input: "${colors.cyan(opts.text.slice(0, 80))}${opts.text.length > 80 ? "..." : ""}"\n`);

  // Execute the request, but focus on graph + plan events
  let planEvent: StreamEvent | null = null;
  const capabilityEvents: Array<{ type: string; source: string; ok: boolean; durationMs: number; nodeId?: string }> = [];

  // Track graph events from the event bus
  const graphEvents: Array<{ type: string; nodeId?: string; capability?: string; timestamp: number }> = [];
  const off = rt.onAny((ev) => {
    if (ev.type === "execution_graph_created") {
      graphEvents.push({ type: "graph_created", timestamp: ev.timestamp });
    } else if (ev.type === "node_started") {
      graphEvents.push({ type: "node_started", nodeId: ev.nodeId, capability: ev.capability, timestamp: ev.timestamp });
    } else if (ev.type === "node_completed") {
      graphEvents.push({ type: "node_completed", nodeId: ev.nodeId, timestamp: ev.timestamp });
    } else if (ev.type === "node_failed") {
      graphEvents.push({ type: "node_failed", nodeId: ev.nodeId, timestamp: ev.timestamp });
    } else if (ev.type === "graph_completed") {
      graphEvents.push({ type: "graph_completed", timestamp: ev.timestamp });
    }
  });

  try {
    for await (const ev of rt.request({ sessionId, text: opts.text, modelId: opts.model })) {
      if (ev.type === "plan") {
        planEvent = ev;
      } else if (ev.type === "capability") {
        capabilityEvents.push({
          type: ev.capabilityType,
          source: ev.source,
          ok: ev.ok,
          durationMs: ev.durationMs,
        });
      }
      // Drain the stream
      if (ev.type === "done") break;
      if (ev.type === "error") break;
    }
  } catch (err) {
    error(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    off();
  }

  // Display the plan
  if (planEvent && planEvent.type === "plan") {
    section("Capability Plan");
    info(`Satisfied:   [${planEvent.satisfied.map(colors.green).join(", ") || colors.dim("none")}]`);
    info(`Missing:     [${planEvent.missing.map(colors.yellow).join(", ") || colors.dim("none")}]`);
    if (planEvent.unavailable.length > 0) {
      info(`Unavailable: [${planEvent.unavailable.map((u) => colors.red(u.type)).join(", ")}]`);
    }
  }

  // Display the execution timeline
  section("Execution Timeline");
  if (graphEvents.length === 0) {
    warn("No graph events captured. The request may not have triggered augmentation.");
  } else {
    for (const ev of graphEvents) {
      const ts = new Date(ev.timestamp).toISOString().slice(11, 23);
      switch (ev.type) {
        case "graph_created":
          process.stdout.write(`  ${colors.dim(ts)} ${icons.info} graph created\n`);
          break;
        case "node_started":
          process.stdout.write(`  ${colors.dim(ts)} ${icons.arrow} ▶ ${colors.cyan(ev.capability ?? ev.nodeId ?? "?")} started\n`);
          break;
        case "node_completed":
          process.stdout.write(`  ${colors.dim(ts)} ${icons.ok} ✓ ${colors.green(ev.nodeId ?? "?")} completed\n`);
          break;
        case "node_failed":
          process.stdout.write(`  ${colors.dim(ts)} ${icons.fail} ✗ ${colors.red(ev.nodeId ?? "?")} failed\n`);
          break;
        case "graph_completed":
          process.stdout.write(`  ${colors.dim(ts)} ${icons.ok} graph completed\n`);
          break;
      }
    }
  }

  // Display capability results
  if (capabilityEvents.length > 0) {
    section("Capability Results");
    for (const cap of capabilityEvents) {
      const status = cap.ok ? colors.green("✓") : colors.red("✗");
      process.stdout.write(`  ${status} ${colors.cyan(cap.type)} via ${colors.blue(cap.source)} (${formatMs(cap.durationMs)})\n`);
    }
  }

  // Visualize the DAG structure (if we can reconstruct it)
  section("Graph Topology");
  if (capabilityEvents.length === 0) {
    info("No capabilities were executed (model had all required capabilities).");
  } else {
    // Show a simple textual DAG
    // Group by execution order based on the event timeline
    const started = graphEvents.filter((e) => e.type === "node_started");
    for (let i = 0; i < started.length; i++) {
      const ev = started[i]!;
      const indent = "  ";
      const isLast = i === started.length - 1;
      const prefix = isLast ? "└─ " : "├─ ";
      process.stdout.write(`${indent}${prefix}${colors.cyan(ev.capability ?? ev.nodeId ?? "?")}\n`);
    }
  }

  process.stdout.write("\n");
}
