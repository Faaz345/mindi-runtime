import type { CapabilityResult, CapabilityType, ChatMessage } from "../core/types.js";
import { CapabilityType as Cap } from "../core/types.js";

/**
 * ContextBuilder
 *
 * Takes the results of capability executions and normalizes them into
 * ChatMessages that the primary model can reason over.
 *
 * The builder is the BOUNDARY between the augmentation subsystem and the
 * reasoning engine. After it produces messages, those messages are simply
 * appended to the conversation history — the primary model never knows
 * (or cares) how the context arrived.
 *
 * Output is a `capability` role message per result, plus an optional
 * `system` preamble that tells the model what these messages are.
 */
export class ContextBuilder {
  /**
   * Build a system prompt that tells the model what tools and capabilities
   * are available in the runtime. This is injected on EVERY request so the
   * model always knows what it can do.
   *
   * HONESTY CONTRACT: the prompt must never claim the model can invoke tools
   * it cannot actually invoke in the current mode. In single-shot chat the
   * model has NO tool channel — it can only reason over pre-executed
   * [Capability:...] results. In agent mode the orchestrator's own prompt
   * describes the invocation protocol.
   */
  buildSystemPrompt(opts: {
    availableCapabilities: CapabilityType[];
    unavailableCapabilities: Array<{ type: CapabilityType; reason: string }>;
    workspace: string;
    provider: string;
    model: string;
    modelHasNative?: CapabilityType[];
    /** True when the request runs through the runtime's agent loop. */
    agentMode?: boolean;
    /** True when native function tools are attached in agent mode. */
    nativeTools?: boolean;
  }): string {
    const nativeSet = new Set(opts.modelHasNative ?? []);
    const lines: string[] = [
      "You are an AI assistant running inside the MINDI Runtime environment.",
      "The MINDI Runtime is an augmentation layer: it executes capabilities",
      "(vision, filesystem, terminal, web, ...) and provides their results to",
      "you as context messages labeled [Capability:...]. Treat those results",
      "as real, current data and use them in your answers.",
      "",
      "Environment:",
      `  Workspace: ${opts.workspace}`,
      `  Provider: ${opts.provider}`,
      `  Model: ${opts.model}`,
      "",
      "Available capabilities:",
    ];

    for (const cap of opts.availableCapabilities) {
      if (nativeSet.has(cap)) {
        lines.push(`  ✓ ${humanLabel(cap)} (native — you can do this yourself)`);
      } else {
        lines.push(`  ✓ ${humanLabel(cap)} (executed by the runtime)`);
      }
    }

    if (opts.unavailableCapabilities.length > 0) {
      lines.push("");
      lines.push("Unavailable capabilities:");
      for (const cap of opts.unavailableCapabilities) {
        lines.push(`  ✗ ${humanLabel(cap.type)} — ${cap.reason}`);
      }
    }

    lines.push("");
    lines.push("How capabilities work here:");
    if (opts.agentMode) {
      lines.push("  - This task runs in the runtime's AGENT MODE. A separate");
      lines.push("    instruction block describes how to invoke tools" +
        (opts.nativeTools ? " (native function calling)." : "."));
      lines.push("    Follow it exactly — the runtime executes every tool you");
      lines.push("    invoke and feeds the real results back to you.");
    } else {
      lines.push("  - In single-shot conversation you CANNOT invoke tools yourself:");
      lines.push("    you cannot create, edit, delete, or run anything directly.");
      lines.push("    When the request clearly needs a capability (a file to read,");
      lines.push("    an image to analyze, a web search), the runtime pre-executes");
      lines.push("    it and injects the result as a [Capability:...] message.");
    }
    lines.push("  - Never claim you performed an action (wrote a file, ran a");
    lines.push("    command, opened a path). If no [Capability:...] result is");
    lines.push("    present for something the user asked about, say the runtime");
    lines.push("    did not provide it — do not fabricate results.");
    lines.push("");
    lines.push("When a user asks what tools or capabilities exist here, list the");
    lines.push("available capabilities shown above and explain that the MINDI");
    lines.push("Runtime executes them on your behalf.");

    return lines.join("\n");
  }

  /**
   * Build a system preamble explaining the augmented context.
   * Models reason better when they know what extra information they have.
   */
  buildPreamble(capabilityTypes: CapabilityType[]): string | null {
    if (capabilityTypes.length === 0) return null;
    const list = capabilityTypes.map((t) => `- ${humanLabel(t)}`).join("\n");
    return [
      "The following capability results were gathered on your behalf by MINDI Runtime.",
      "Use this information to answer the user's request.",
      "",
      "Capabilities used:",
      list,
    ].join("\n");
  }

  /**
   * Turn one capability result into a ChatMessage the primary model sees.
   */
  buildMessage(result: CapabilityResult): ChatMessage {
    const header = `[Capability: ${humanLabel(result.type)} | Executor: ${result.source} | ${result.ok ? "OK" : "FAILED"}${result.durationMs ? ` | ${result.durationMs}ms` : ""}]`;
    const body = result.ok
      ? this.formatPayload(result)
      : `Execution failed: ${result.error ?? "unknown error"}`;
    return {
      role: "capability",
      content: `${header}\n${body}`,
      name: result.source,
    };
  }

  /** Format a capability payload as model-readable text. */
  private formatPayload(result: CapabilityResult): string {
    const p = result.payload;
    switch (p.kind) {
      case "text":
        return p.text;
      case "json":
        return "```json\n" + JSON.stringify(p.data, null, 2) + "\n```";
      case "structured":
        return "```json\n" + JSON.stringify(p.data, null, 2) + "\n```";
      case "search":
        return p.results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
          .join("\n\n");
      case "file":
        return `<file path="${p.path}">\n${p.content}\n</file>`;
      case "files":
        return p.entries
          .map((e) => `${e.type === "dir" ? "[dir] " : "      "}${e.path}`)
          .join("\n");
      case "command":
        return [
          `$ exit code: ${p.exitCode}`,
          p.stdout ? `--- stdout ---\n${p.stdout}` : "(no stdout)",
          p.stderr ? `--- stderr ---\n${p.stderr}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      case "image":
        return `[Image generated — ${p.mimeType}, ${p.base64.length} bytes base64${p.url ? `, url: ${p.url}` : ""}]`;
      case "embedding":
        return `[Embedding — dim=${p.vector.length}, model=${p.model}]`;
      default: {
        // exhaustive at compile time; defensive at runtime
        const _exhaustive: never = p;
        return JSON.stringify(_exhaustive);
      }
    }
  }
}

/** Human-readable label for a capability type. */
export function humanLabel(type: CapabilityType): string {
  const labels: Record<CapabilityType, string> = {
    [Cap.Vision]: "Vision",
    [Cap.OCR]: "OCR",
    [Cap.WebSearch]: "Web Search",
    [Cap.Browser]: "Browser Automation",
    [Cap.Filesystem]: "Filesystem",
    [Cap.Git]: "Git",
    [Cap.Terminal]: "Terminal",
    [Cap.ImageGeneration]: "Image Generation",
    [Cap.Audio]: "Audio Processing",
    [Cap.Embeddings]: "Embeddings",
    [Cap.Database]: "Database",
    [Cap.Chat]: "Chat",
  };
  return labels[type] ?? type;
}
