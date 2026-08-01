import type { ChatChunk, ChatMessage, ExecutionContext } from "../core/types.js";
import { RequestError } from "../core/errors.js";

/**
 * StreamingEngine
 *
 * Provides a uniform streaming surface for clients:
 *
 *   request() -> AsyncIterable<StreamEvent>
 *
 * Where StreamEvent is a tagged union of:
 *   - { type: "intent",     ... }  — intent analysis completed
 *   - { type: "plan",       ... }  — capability plan completed
 *   - { type: "capability", ... }  — a capability result was injected
 *   - { type: "delta",      text } — incremental model output
 *   - { type: "done",       ... }  — stream complete (with usage stats)
 *   - { type: "error",      ... }  — stream failed
 *
 * The engine is a thin adapter over an AsyncIterable<ChatChunk> source —
 * it does NOT contain provider-specific logic. That keeps the streaming
 * contract uniform across all providers.
 */

export type StreamEvent =
  | { type: "intent"; summary: string; capabilities: string[]; confidence: number }
  | { type: "plan"; satisfied: string[]; missing: string[]; unavailable: Array<{ type: string; reason: string }> }
  | { type: "capability"; capabilityType: string; source: string; ok: boolean; durationMs: number; preview: string }
  | { type: "attachment"; kind: "image"; count: number; sizeBytes: number }
  // Vision policy decision (Phase 4 — deterministic provider selection)
  | { type: "vision"; action: "native" | "fallback" | "unavailable" | "denied"; provider?: string; model?: string; reason: string }
  // Provider failover (Phase 5 — emitted when a provider switch occurs)
  | { type: "provider_failover"; from: string; to: string; reason: string }
  // Agentic lifecycle events (emitted by the AgentOrchestrator)
  | { type: "task"; taskType: string; chain: string[]; reasoning: string }
  | { type: "tool"; phase: "selected" | "started" | "finished"; name: string; ok?: boolean; durationMs?: number; preview?: string }
  | { type: "file"; path: string; bytes: number; verified: boolean }
  | { type: "reflection"; note: string; iteration: number }
  | { type: "goal"; status: "completed" | "failed"; reason: string }
  | { type: "delta"; text: string }
  | { type: "done"; finishReason?: string; usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }
  | { type: "error"; code: string; message: string };

/**
 * Convert an AsyncIterable<ChatChunk> into a stream of StreamEvents.
 * Collects usage stats as they arrive so the final `done` event is complete.
 */
export async function* streamFromChatChunks(
  source: AsyncIterable<ChatChunk>,
  ctx: ExecutionContext,
): AsyncIterable<StreamEvent> {
  let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
  let finishReason: string | undefined;
  try {
    for await (const chunk of source) {
      if (ctx.signal.aborted) {
        yield { type: "error", code: "E_REQUEST_CANCELLED", message: "cancelled" };
        return;
      }
      if (chunk.delta) {
        yield { type: "delta", text: chunk.delta };
      }
      if (chunk.usage) {
        usage = chunk.usage;
      }
      if (chunk.finishReason) {
        finishReason = chunk.finishReason;
      }
      if (chunk.done) {
        yield { type: "done", finishReason, usage };
        return;
      }
    }
    // Source ended without explicit done — emit one.
    yield { type: "done", finishReason, usage };
  } catch (err) {
    const code = err instanceof Error && "code" in err ? String((err as { code: string }).code) : "E_INTERNAL";
    const message = err instanceof Error ? err.message : String(err);
    yield { type: "error", code, message };
  }
}

/**
 * Collect a full AsyncIterable<ChatChunk> into a single string + usage.
 * Used when a non-streaming consumer needs the full response (CLI / SDK).
 */
export async function collectStream(
  source: AsyncIterable<ChatChunk>,
  ctx: ExecutionContext,
): Promise<{ text: string; usage?: ChatChunk["usage"]; finishReason?: string }> {
  let text = "";
  let usage: ChatChunk["usage"];
  let finishReason: string | undefined;
  for await (const chunk of source) {
    if (ctx.signal.aborted) {
      throw new RequestError("E_REQUEST_CANCELLED", "Request cancelled by caller");
    }
    if (chunk.delta) text += chunk.delta;
    if (chunk.usage) usage = chunk.usage;
    if (chunk.finishReason) finishReason = chunk.finishReason;
  }
  return { text, usage, finishReason };
}

/**
 * Build a synthetic capability-role message from a stream of capability
 * events — used to collapse multiple capability results into a single
 * assistant-visible context block when needed.
 */
export function capabilitiesToMessage(events: StreamEvent[]): ChatMessage | null {
  const caps = events.filter((e): e is Extract<StreamEvent, { type: "capability" }> => e.type === "capability");
  if (caps.length === 0) return null;
  const body = caps
    .map((c) => `[${c.capabilityType} from ${c.source} ${c.ok ? "OK" : "FAILED"} ${c.durationMs}ms]\n${c.preview}`)
    .join("\n\n");
  return { role: "capability", content: body };
}
