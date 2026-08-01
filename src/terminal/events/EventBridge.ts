/**
 * EventBridge — connects the runtime's two event systems to the Timeline.
 *
 * The runtime emits:
 *   1. RuntimeEvent (via EventBus) — internal lifecycle events
 *   2. StreamEvent (via request iterator) — client-facing stream events
 *
 * The Timeline renders RuntimeEvent2 (typed, with metadata + dedicated renderers).
 *
 * This bridge translates BOTH sources into RuntimeEvent2 instances so the
 * Timeline can render every real runtime action with its own renderer.
 *
 * Architecture:
 *   EventBus.onAny() ──┐
 *                      ├──→ EventBridge ──→ RuntimeEvent2[] ──→ Timeline
 *   StreamEvent ───────┘
 *
 * The bridge is stateful: it accumulates events for the current request and
 * exposes them as a bounded array. On request completion, the array can be
 * snapshotted for persistence or cleared for the next request.
 *
 * NEVER fakes progress. Every RuntimeEvent2 corresponds to a real action.
 */

import type { RuntimeEvent } from "../../core/types.js";
import type { StreamEvent } from "../../streaming/StreamingEngine.js";
import type { RuntimeEvent2, EventMeta, EventStatus } from "./RuntimeEvents.js";
import { createMeta, genEventId } from "./RuntimeEvents.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default max events retained in memory. Configurable via constructor. */
const DEFAULT_MAX_EVENTS = 500;

// ---------------------------------------------------------------------------
// EventBridge
// ---------------------------------------------------------------------------

export class EventBridge {
  private events: RuntimeEvent2[] = [];
  private toolsExecuted = 0;
  private tokensUsed = 0;
  /** Phase 8: Configurable retention cap. */
  private readonly maxEvents: number;

  constructor(opts?: { maxEvents?: number }) {
    this.maxEvents = opts?.maxEvents ?? DEFAULT_MAX_EVENTS;
  }

  /** All accumulated events for the current request. */
  getEvents(): readonly RuntimeEvent2[] {
    return this.events;
  }

  /** Number of events accumulated. */
  get length(): number {
    return this.events.length;
  }

  /** Reset for a new request cycle. */
  reset(): void {
    this.events = [];
    this.toolsExecuted = 0;
    this.tokensUsed = 0;
  }

  /**
   * Seed the bridge with persisted execution events from a restored session.
   * Converts workspace ExecutionEvent[] → RuntimeEvent2[] so the Timeline
   * shows the session's history immediately on restore.
   */
  seed(persisted: Array<{ timestamp: number; kind: string; data: Record<string, unknown> }>): void {
    for (const ev of persisted) {
      const converted = this.convertPersistedEvent(ev);
      if (converted) this.push(converted);
    }
  }

  private convertPersistedEvent(ev: { timestamp: number; kind: string; data: Record<string, unknown> }): RuntimeEvent2 | null {
    const meta = createMeta({ timestamp: ev.timestamp, status: "completed" });
    switch (ev.kind) {
      case "request:start":
        return { type: "timeline_checkpoint", meta, label: "Request started" } as RuntimeEvent2;
      case "request:end":
        return {
          type: "completion",
          meta: createMeta({ timestamp: ev.timestamp, status: ev.data.ok ? "completed" : "failed", durationMs: (ev.data.durationMs as number) ?? 0 }),
          summary: ev.data.ok ? `Completed in ${ev.data.durationMs}ms` : `Failed after ${ev.data.durationMs}ms`,
          totalDurationMs: (ev.data.durationMs as number) ?? 0,
          toolsExecuted: 0,
          tokensUsed: 0,
        } as RuntimeEvent2;
      case "intent":
        return { type: "intent_analyzed", meta, summary: String(ev.data.summary ?? "Intent analyzed"), capabilities: (ev.data.capabilities as string[]) ?? [] } as RuntimeEvent2;
      case "plan":
        return { type: "capability_plan", meta, satisfied: (ev.data.planned as string[]) ?? [], missing: (ev.data.missing as string[]) ?? [], unavailable: [] } as RuntimeEvent2;
      case "capability:dispatch":
        return { type: "capability_dispatch", meta, capability: String(ev.data.type ?? "unknown"), executor: String(ev.data.provider ?? ""), executorType: "provider" } as RuntimeEvent2;
      case "capability:success":
        return { type: "success", meta, message: String(ev.data.summary ?? "Capability completed") } as RuntimeEvent2;
      case "capability:error":
        return { type: "error", meta, message: String(ev.data.error ?? "Capability failed"), code: String(ev.data.code ?? "E_CAPABILITY") } as RuntimeEvent2;
      case "provider:stream":
        return { type: "timeline_checkpoint", meta, label: `Streaming from ${ev.data.provider ?? "provider"}` } as RuntimeEvent2;
      case "provider:done":
        return { type: "timeline_checkpoint", meta, label: `Provider response complete` } as RuntimeEvent2;
      case "memory:written":
        return { type: "memory_access", meta, operation: "write", sessionId: String(ev.data.sessionId ?? ""), entries: (ev.data.entries as number) ?? 1 } as RuntimeEvent2;
      default:
        return null;
    }
  }

  /** Snapshot the current events (for persistence on completion). */
  snapshot(): RuntimeEvent2[] {
    return [...this.events];
  }

  // ---- RuntimeEvent (EventBus) ingestion --------------------------------

  /**
   * Ingest a RuntimeEvent from the EventBus. Called via runtime.onAny().
   * Translates internal lifecycle events into Timeline-renderable events.
   */
  ingestRuntimeEvent(event: RuntimeEvent): void {
    switch (event.type) {
      case "request:start":
        this.push({
          type: "planning",
          meta: this.meta("running", 0),
          title: "Processing request",
          steps: ["Intent analysis", "Capability planning", "Execution", "Generation"],
          currentStep: 0,
        });
        break;

      case "intent:analyzed":
        this.push({
          type: "intent_analyzed",
          meta: this.meta("completed"),
          summary: event.intent.summary,
          capabilities: event.intent.requiredCapabilities,
          confidence: event.intent.confidence,
        });
        break;

      case "planner:plan":
        this.push({
          type: "capability_plan",
          meta: this.meta("completed"),
          satisfied: event.plan.satisfied,
          missing: event.plan.missing.map((m) => m.type),
          unavailable: event.plan.unavailable,
        });
        break;

      case "execution_graph_created":
        this.push({
          type: "planning",
          meta: this.meta("completed"),
          title: `Execution graph: ${event.nodeCount} node(s)`,
          steps: Array.from({ length: event.nodeCount }, (_, i) => `Node ${i + 1}`),
          currentStep: event.nodeCount,
        });
        break;

      case "capability:dispatch":
        this.push({
          type: "capability_dispatch",
          meta: this.meta("running"),
          capability: event.capabilityType,
          executor: event.capabilityId,
          executorType: event.executor,
        });
        break;

      case "capability:success":
        this.push({
          type: "tool_finished",
          meta: this.meta("completed", event.durationMs),
          toolName: event.capabilityId,
          toolId: event.capabilityId,
          success: true,
          summary: `Completed in ${event.durationMs}ms`,
        });
        break;

      case "capability:error":
        this.push({
          type: "error",
          meta: this.meta("failed"),
          message: event.error,
          code: "E_CAPABILITY_ERROR",
          details: `Capability ${event.capabilityId} failed`,
        });
        break;

      case "node_started":
        this.push({
          type: "tool_started",
          meta: this.meta("running"),
          toolName: event.capability,
          toolId: event.nodeId,
          description: `Executing ${event.capability}`,
        });
        break;

      case "node_completed":
        this.push({
          type: "tool_finished",
          meta: this.meta(event.ok ? "completed" : "failed", event.durationMs),
          toolName: event.nodeId,
          toolId: event.nodeId,
          success: event.ok,
          summary: event.ok ? `Completed in ${event.durationMs}ms` : "Failed",
        });
        break;

      case "node_failed":
        this.push({
          type: "error",
          meta: this.meta("failed"),
          message: event.error,
          code: "E_NODE_FAILED",
          details: `Node ${event.nodeId} failed`,
        });
        break;

      case "provider:stream":
        this.push({
          type: "thinking",
          meta: this.meta("running", 0, event.providerId, event.model),
          summary: `Generating via ${event.providerId}/${event.model}`,
        });
        break;

      case "provider:done":
        this.push({
          type: "success",
          meta: this.meta("completed"),
          message: `Generation complete (${event.finishReason})`,
        });
        break;

      case "context:assembled":
        if (event.injectedCount > 0) {
          this.push({
            type: "thinking",
            meta: this.meta("completed"),
            summary: `Context assembled: ${event.injectedCount} capability result(s) injected`,
          });
        }
        break;

      case "memory:written":
        this.push({
          type: "memory_access",
          meta: this.meta("completed"),
          operation: "write",
          sessionId: event.sessionId,
          entries: event.entries,
        });
        break;

      case "request:end":
        this.push({
          type: "completion",
          meta: this.meta(event.ok ? "completed" : "failed", event.durationMs),
          summary: event.ok ? "Request completed" : "Request failed",
          totalDurationMs: event.durationMs,
          tokensUsed: this.tokensUsed,
          toolsExecuted: this.toolsExecuted,
        });
        break;

      // Events we don't render in the Timeline (chunk-level, too noisy):
      case "provider:chunk":
      case "session:created":
      case "graph_completed":
      case "node_waiting":
        break;
    }
  }

  // ---- StreamEvent (request iterator) ingestion -------------------------

  /**
   * Ingest a StreamEvent from the request iterator. These are the
   * client-facing events emitted by Runtime.request() and the
   * AgentOrchestrator.
   */
  ingestStreamEvent(event: StreamEvent): void {
    switch (event.type) {
      case "intent":
        // Already handled via RuntimeEvent "intent:analyzed" — skip duplicate.
        break;

      case "plan":
        // Already handled via RuntimeEvent "planner:plan" — skip duplicate.
        break;

      case "capability":
        this.toolsExecuted++;
        this.push({
          type: "tool_finished",
          meta: this.meta(event.ok ? "completed" : "failed", event.durationMs),
          toolName: event.capabilityType,
          toolId: `cap-${event.capabilityType}`,
          success: event.ok,
          summary: `via ${event.source} — ${event.preview.slice(0, 60)}`,
        });
        break;

      case "attachment":
        this.push({
          type: "thinking",
          meta: this.meta("completed"),
          summary: `Attached ${event.count} image(s) (${Math.round(event.sizeBytes / 1024)} KB)`,
        });
        break;

      case "vision":
        this.push({
          type: event.action === "denied" || event.action === "unavailable" ? "warning" : "capability_dispatch",
          meta: this.meta(event.action === "denied" || event.action === "unavailable" ? "warning" : "completed"),
          ...(event.action === "denied" || event.action === "unavailable"
            ? { message: event.reason }
            : {
                capability: "vision",
                executor: event.model ?? "unknown",
                executorType: "provider" as const,
              }),
        } as RuntimeEvent2);
        break;

      case "provider_failover":
        this.push({
          type: "warning",
          meta: this.meta("warning"),
          message: `Provider failover: ${event.from} → ${event.to}`,
          details: event.reason,
        });
        break;

      case "task":
        this.push({
          type: "planning",
          meta: this.meta("completed"),
          title: `Task: ${event.taskType}`,
          steps: event.chain,
          currentStep: event.chain.length,
        });
        break;

      case "tool":
        if (event.phase === "started" || event.phase === "selected") {
          this.push({
            type: "tool_started",
            meta: this.meta("running"),
            toolName: event.name,
            toolId: `tool-${event.name}-${Date.now()}`,
            description: event.preview ?? `Running ${event.name}`,
          });
        } else if (event.phase === "finished") {
          this.toolsExecuted++;
          this.push({
            type: "tool_finished",
            meta: this.meta(event.ok ? "completed" : "failed", event.durationMs),
            toolName: event.name,
            toolId: `tool-${event.name}`,
            success: event.ok ?? true,
            summary: event.preview ?? (event.ok ? "ok" : "failed"),
          });
        }
        break;

      case "file":
        this.push({
          type: event.verified ? "file_created" : "file_modified",
          meta: this.meta(event.verified ? "completed" : "warning"),
          ...(event.verified
            ? { filePath: event.path, lines: undefined }
            : { filePath: event.path, linesAdded: 0, linesRemoved: 0 }),
        } as RuntimeEvent2);
        break;

      case "reflection":
        this.push({
          type: "thinking",
          meta: this.meta("completed"),
          summary: event.note,
        });
        break;

      case "goal":
        this.push({
          type: event.status === "completed" ? "success" : "error",
          meta: this.meta(event.status === "completed" ? "completed" : "failed"),
          ...(event.status === "completed"
            ? { message: `Goal completed: ${event.reason}` }
            : { message: event.reason, code: "E_GOAL_FAILED" }),
        } as RuntimeEvent2);
        break;

      case "delta":
        // Track tokens for the completion summary.
        this.tokensUsed += Math.ceil(event.text.length / 4);
        break;

      case "done":
        if (event.usage?.totalTokens) {
          this.tokensUsed = event.usage.totalTokens;
        }
        break;

      case "error":
        this.push({
          type: "error",
          meta: this.meta("failed"),
          message: event.message,
          code: event.code,
        });
        break;
    }
  }

  // ---- Internal ---------------------------------------------------------

  private push(event: RuntimeEvent2): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  }

  private meta(
    status: EventStatus,
    durationMs = 0,
    provider?: string,
    model?: string,
  ): EventMeta {
    return createMeta({
      id: genEventId(),
      status,
      durationMs,
      provider,
      model,
    });
  }
}
