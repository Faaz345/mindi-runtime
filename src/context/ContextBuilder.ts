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
   * Build a system preamble explaining the augmented context.
   * Models reason better when they know what extra information they have.
   */
  buildPreamble(capabilityTypes: CapabilityType[]): string | null {
    if (capabilityTypes.length === 0) return null;
    const list = capabilityTypes.map((t) => `- ${humanLabel(t)}`).join("\n");
    return [
      "You have been augmented with the following additional capabilities by MINDI Runtime.",
      "The information in the following capability messages was gathered on your behalf.",
      "Use it to answer the user's request.",
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
