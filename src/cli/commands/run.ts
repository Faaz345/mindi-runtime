/** `mindi run` — executes a request, streams output, shows augmentation. */

import type { Runtime, StreamEvent } from "../../index.js";
import { header, info, error, success, colors, icons, formatMs } from "../format.js";

export async function runCommand(
  rt: Runtime,
  opts: {
    provider?: string;
    model?: string;
    text: string;
    sessionId?: string;
    json?: boolean;
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

  if (!opts.json) {
    header("MINDI Runtime — Run");
    info(`Session:  ${colors.dim(sessionId.slice(0, 12))}...`);
    info(`Input:    "${colors.cyan(opts.text.slice(0, 80))}${opts.text.length > 80 ? "..." : ""}"`);
    process.stdout.write("\n");
  }

  const startTime = Date.now();
  const events: StreamEvent[] = [];

  try {
    for await (const ev of rt.request({
      sessionId,
      text: opts.text,
      modelId: opts.model,
    })) {
      events.push(ev);

      if (opts.json) continue;

      switch (ev.type) {
        case "intent":
          process.stdout.write(`${icons.info} ${colors.bold("Intent")}: ${ev.summary}\n`);
          process.stdout.write(`  ${colors.dim("Required capabilities")}: [${ev.capabilities.join(", ")}]\n`);
          process.stdout.write(`  ${colors.dim("Confidence")}: ${(ev.confidence * 100).toFixed(0)}%\n\n`);
          break;

        case "plan":
          process.stdout.write(`${icons.info} ${colors.bold("Plan")}:\n`);
          process.stdout.write(`  ${colors.dim("Satisfied")}:   [${ev.satisfied.join(", ") || colors.dim("none")}]\n`);
          process.stdout.write(`  ${colors.dim("Missing")}:    [${ev.missing.join(", ") || colors.dim("none")}]\n`);
          if (ev.unavailable.length > 0) {
            process.stdout.write(`  ${colors.dim("Unavailable")}: [${ev.unavailable.map((u) => u.type).join(", ")}]\n`);
          }
          process.stdout.write("\n");
          break;

        case "capability":
          const status = ev.ok ? colors.green("✓") : colors.red("✗");
          process.stdout.write(`${status} ${colors.bold("Capability")}: ${colors.cyan(ev.capabilityType)} via ${colors.blue(ev.source)} (${formatMs(ev.durationMs)})\n`);
          if (ev.preview) {
            process.stdout.write(`  ${colors.dim(ev.preview.slice(0, 100))}${ev.preview.length > 100 ? "..." : ""}\n`);
          }
          process.stdout.write("\n");
          break;

        case "delta":
          process.stdout.write(ev.text);
          break;

        case "done":
          process.stdout.write("\n\n");
          break;

        case "error":
          error(`Stream error: ${ev.code} — ${ev.message}\n`);
          break;
      }
    }

    const duration = Date.now() - startTime;

    if (opts.json) {
      process.stdout.write(JSON.stringify({ events, sessionId, durationMs: duration }, null, 2) + "\n");
      return;
    }

    // Summary
    const capCount = events.filter((e) => e.type === "capability").length;
    const deltas = events.filter((e) => e.type === "delta").length;
    success(`Request completed in ${formatMs(duration)}`);
    info(`Capabilities executed: ${capCount}`);
    info(`Stream chunks:         ${deltas}`);

    // Metrics
    const metrics = rt.getMetrics();
    info(`Tokens used:           ${metrics.tokensUsed.toLocaleString()}`);

  } catch (err) {
    error(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
