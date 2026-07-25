import { randomUUID } from "node:crypto";
import type {
  CapabilityResult,
  CapabilityType,
  ChatMessage,
  ChatRequest,
  ExecutionContext,
  IProvider,
  RuntimeEvent,
} from "../core/types.js";
import { ConfigError, MindiError, toMindiError } from "../core/errors.js";
import { resolveConfig, type ResolvedConfig, type RuntimeConfig } from "../core/config.js";
import { EventBus } from "../events/EventBus.js";
import { Logger, type LogLevel } from "../logging/Logger.js";
import { CapabilityRegistry } from "../registry/CapabilityRegistry.js";
import { ToolRuntime } from "../tools/ToolRuntime.js";
import { ProviderManager } from "../providers/ProviderManager.js";
import { loadProvidersFromConfig } from "../providers/provider-loader.js";
import { IntentAnalyzer } from "../intent/IntentAnalyzer.js";
import { CapabilityPlanner } from "../planner/CapabilityPlanner.js";
import { CapabilityRouter } from "../router/CapabilityRouter.js";
import { ExecutionPlanner } from "../planner/ExecutionPlanner.js";
import { GraphExecutor } from "../planner/GraphExecutor.js";
import { ContextBuilder } from "../context/ContextBuilder.js";
import { MetricsCollector, type MetricsSnapshot } from "../observability/MetricsCollector.js";
import { SessionManager, type Session, type SessionInit } from "../session/SessionManager.js";
import { InMemoryMemoryStore, MemoryLayer } from "../memory/MemoryLayer.js";
import {
  streamFromChatChunks,
  type StreamEvent,
} from "../streaming/StreamingEngine.js";
import { CapabilityAvailabilityTracker } from "../tools/CapabilityAvailabilityTracker.js";
import { createNetworkPolicy, booleanToPolicy } from "../tools/NetworkPolicy.js";

/**
 * Runtime
 *
 * The top-level orchestrator. Wires every subsystem together and exposes
 * the public request API used by clients (Desktop, CLI, Web, SDK, IDE).
 *
 * Clients are THIN: they only call `runtime.request(...)` and consume
 * the AsyncIterable<StreamEvent> it returns. All business logic lives here.
 *
 * Full request lifecycle:
 *
 *   1. Validate the request + resolve the primary provider/model.
 *   2. Recall session history.
 *   3. Analyze intent → required capabilities.
 *   4. Plan: diff required vs primary model's declared capabilities.
 *   5. Build an Execution Graph (DAG) from the capability plan.
 *   6. Execute the graph: parallel waves, conditional nodes, retries.
 *   7. Build normalized context messages from the results.
 *   8. Append context to history.
 *   9. Stream the primary model's response.
 *  10. Persist the user's message + assistant's reply to memory.
 *
 * Throughout, every step emits RuntimeEvents for observability.
 */
export class Runtime {
  readonly config: ResolvedConfig;
  readonly events: EventBus;
  readonly log: Logger;
  readonly registry: CapabilityRegistry;
  readonly toolRuntime: ToolRuntime;
  readonly providers: ProviderManager;
  readonly intent: IntentAnalyzer;
  readonly planner: CapabilityPlanner;
  readonly executionPlanner: ExecutionPlanner;
  readonly router: CapabilityRouter;
  readonly graphExecutor: GraphExecutor;
  readonly metrics: MetricsCollector;
  readonly context: ContextBuilder;
  readonly sessions: SessionManager;
  readonly memory: MemoryLayer;
  readonly availability: CapabilityAvailabilityTracker;
  readonly networkPolicy: ReturnType<typeof createNetworkPolicy>;

  private readonly logLevel: LogLevel;

  constructor(userConfig?: RuntimeConfig) {
    this.config = resolveConfig(userConfig);
    this.logLevel = this.config.logLevel;
    this.events = new EventBus({ keepHistory: true });
    this.log = new Logger({ level: this.logLevel, context: { component: "runtime" } });
    this.registry = new CapabilityRegistry();
    this.toolRuntime = new ToolRuntime(this.config.sandbox, this.registry).registerBuiltin();
    this.providers = new ProviderManager(this.registry);
    this.registerBuiltinProviders();
    // Network policy: convert old boolean to new policy type.
    this.networkPolicy = createNetworkPolicy(
      booleanToPolicy(this.config.sandbox.allowNetwork),
    );
    // Availability tracker: scans all capabilities on startup.
    this.availability = new CapabilityAvailabilityTracker(
      this.registry,
      this.config.sandbox,
      this.networkPolicy,
    );
    this.availability.initialScan();
    this.intent = new IntentAnalyzer();
    this.planner = new CapabilityPlanner(this.registry, this.availability);
    this.router = new CapabilityRouter(this.registry);
    this.executionPlanner = new ExecutionPlanner();
    this.graphExecutor = new GraphExecutor(this.router);
    this.context = new ContextBuilder();
    this.memory = new MemoryLayer(new InMemoryMemoryStore(), this.config.maxHistoryMessages);
    this.sessions = new SessionManager(this.memory);
    // Wire metrics collector to the event bus — non-invasive, listen-only.
    this.metrics = new MetricsCollector();
    this.events.onAny((e) => this.metrics.onEvent(e));
  }

  // ---- Bootstrapping ----------------------------------------------------

  /** Register built-in providers from config. Generic — no hardcoding. */
  private registerBuiltinProviders(): void {
    const providers = loadProvidersFromConfig(this.config.providers);
    for (const provider of providers) {
      this.providers.register(provider);
    }
  }

  /** Allow callers to register custom providers at runtime. */
  registerProvider(provider: IProvider): this {
    this.providers.register(provider);
    return this;
  }

  /** Allow callers to register custom tools at runtime. */
  registerTool(tool: import("../core/types.js").ITool): this {
    this.toolRuntime.register(tool);
    return this;
  }

  // ---- Sessions --------------------------------------------------------

  createSession(init: SessionInit): Session {
    const session = this.sessions.create(init);
    this.events.emit({ type: "session:created", sessionId: session.id, timestamp: Date.now() });
    return session;
  }

  getSession(id: string): Session {
    return this.sessions.get(id);
  }

  // ---- Request lifecycle ----------------------------------------------

  /**
   * Execute a request against the user's chosen primary model, augmenting
   * it with any missing capabilities. Returns a streaming AsyncIterable.
   *
   * The primary model is NEVER switched — capability execution results are
   * normalized and injected as context messages, then the primary model
   * continues reasoning over them.
   */
  request(input: string | RuntimeRequestInput): AsyncIterable<StreamEvent> {
    return this.requestInternal(input);
  }

  private async *requestInternal(input: string | RuntimeRequestInput): AsyncIterable<StreamEvent> {
    const req = normalizeInput(input);
    const requestId = req.requestId ?? randomUUID();
    const session = this.sessions.get(req.sessionId);
    const provider = this.providers.getPrimary(session.providerId);
    const modelId = req.modelId ?? session.modelId;

    // Build the execution context (correlation id, logger, cancellation, bus).
    // No timeout — let the provider stream until it finishes naturally.
    // The user can always Ctrl+C to interrupt.
    const ctrl = new AbortController();
    if (req.signal) {
      if (req.signal.aborted) ctrl.abort();
      else req.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    const ctx: ExecutionContext = {
      requestId,
      sessionId: session.id,
      signal: ctrl.signal,
      log: this.log.child({ requestId, sessionId: session.id, model: modelId }),
      events: this.events,
    };

    const start = Date.now();
    ctx.log.info("request.start", { input: truncate(req.text, 200), model: modelId, provider: provider.id });
    this.events.emit({
      type: "request:start",
      requestId,
      sessionId: session.id,
      input: req.text,
      model: modelId,
      timestamp: start,
    });

    try {
      // 1. Recall session history.
      const history = await this.sessions.recall(session.id);

      // 2. Analyze intent.
      const intent = this.intent.analyze(req.text, req.attachments ?? [], history);
      this.events.emit({ type: "intent:analyzed", requestId, intent, timestamp: Date.now() });
      yield {
        type: "intent",
        summary: intent.summary,
        capabilities: intent.requiredCapabilities,
        confidence: intent.confidence,
      };

      // 3. Plan: what does the primary model lack? (async: real capability negotiation)
      const plan = await this.planner.plan(intent, provider, modelId, {
        requestId,
        sessionId: session.id,
        messages: history,
        input: req.text,
      });
      this.events.emit({ type: "planner:plan", requestId, plan, timestamp: Date.now() });
      yield {
        type: "plan",
        satisfied: plan.satisfied,
        missing: plan.missing.map((m) => m.type),
        unavailable: plan.unavailable,
      };

      // 4. Build execution graph from the capability plan.
      const execGraph = this.executionPlanner.plan(plan, {
        requestId,
        sessionId: session.id,
      });
      this.events.emit({
        type: "execution_graph_created",
        requestId,
        graphId: execGraph.id,
        nodeCount: execGraph.nodes.size,
        timestamp: Date.now(),
      });
      ctx.log.debug("execution.graph", {
        graphId: execGraph.id,
        nodes: execGraph.nodes.size,
        roots: execGraph.rootIds.length,
      });

      // 5. Execute the graph — yields NodeResults as nodes complete.
      const capabilityMessages: ChatMessage[] = [];
      const usedCapabilityTypes: CapabilityType[] = [];
      for await (const { result } of this.graphExecutor.execute(execGraph, ctx)) {
        const msg = this.context.buildMessage(result);
        capabilityMessages.push(msg);
        usedCapabilityTypes.push(result.type);
        yield {
          type: "capability",
          capabilityType: result.type,
          source: result.source,
          ok: result.ok,
          durationMs: result.durationMs,
          preview: preview(result),
        };
      }

      // 5. Build the augmented message list for the primary model.
      const userMessage: ChatMessage = { role: "user", content: req.text };
      // Truncate history to prevent context overflow. Keep the system prompt
      // (if any) + the last N messages.
      const maxHistoryForRequest = Math.min(history.length, this.config.maxHistoryMessages);
      const truncatedHistory = maxHistoryForRequest < history.length
        ? [history[0]!, ...history.slice(-maxHistoryForRequest)]
        : history;
      const augmented: ChatMessage[] = [...truncatedHistory, userMessage, ...capabilityMessages];

      // Optionally prepend the context preamble as a system message.
      const preamble = this.context.buildPreamble(usedCapabilityTypes);
      if (preamble) {
        // Insert preamble right after the initial system prompt if present,
        // otherwise as the first message.
        const first = augmented[0];
        if (first && first.role === "system") {
          augmented.splice(1, 0, { role: "system", content: preamble });
        } else {
          augmented.unshift({ role: "system", content: preamble });
        }
      }
      this.events.emit({
        type: "context:assembled",
        requestId,
        injectedCount: capabilityMessages.length,
        timestamp: Date.now(),
      });

      // 6. Stream the primary model's response.
      const chatRequest: ChatRequest = {
        model: modelId,
        messages: augmented,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        stop: req.stop,
        capabilities: intent.requiredCapabilities,
      };
      this.events.emit({
        type: "provider:stream",
        requestId,
        providerId: provider.id,
        model: modelId,
        timestamp: Date.now(),
      });

      // Collect the full assistant reply in parallel with streaming so we
      // can persist it to memory after the stream completes.
      let fullText = "";
      let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;

      try {
        const chunkStream = provider.chat(chatRequest, ctx);
        for await (const ev of streamFromChatChunks(chunkStream, ctx)) {
          if (ev.type === "delta") {
            fullText += ev.text;
            this.events.emit({ type: "provider:chunk", requestId, delta: ev.text, timestamp: Date.now() });
          } else if (ev.type === "done") {
            usage = ev.usage;
            this.events.emit({
              type: "provider:done",
              requestId,
              finishReason: ev.finishReason ?? "stop",
              timestamp: Date.now(),
            });
          }
          yield ev;
        }

        // 7. Persist to memory (user message + assistant reply).
        const messagesToSave: ChatMessage[] = [userMessage, ...capabilityMessages];
        if (fullText.trim()) {
          messagesToSave.push({ role: "assistant", content: fullText });
        }
        await this.sessions.remember(session.id, messagesToSave);
        this.events.emit({ type: "memory:written", sessionId: session.id, entries: messagesToSave.length, timestamp: Date.now() });

        const durationMs = Date.now() - start;
        ctx.log.info("request.end", { ok: true, durationMs, tokens: usage?.totalTokens });
        this.events.emit({
          type: "request:end",
          requestId,
          sessionId: session.id,
          ok: true,
          durationMs,
          timestamp: Date.now(),
        });
      } catch (err) {
        const e = toMindiError(err);
        ctx.log.error("provider.stream.error", { code: e.code, message: e.message });

        // CRITICAL: If we got partial content before the error, yield it as a
        // proper assistant message so the user doesn't lose what was generated.
        if (fullText.trim()) {
          // Save partial response to memory.
          const messagesToSave: ChatMessage[] = [userMessage, ...capabilityMessages];
          messagesToSave.push({ role: "assistant", content: fullText });
          await this.sessions.remember(session.id, messagesToSave);

          // Emit a done event so the Terminal shows the partial response.
          yield { type: "done", finishReason: "length", usage };
        } else {
          // No content was generated — save just the user message.
          await this.sessions.remember(session.id, [userMessage, ...capabilityMessages]);
        }

        yield { type: "error", code: e.code, message: e.message };
        this.events.emit({
          type: "request:end",
          requestId,
          sessionId: session.id,
          ok: false,
          durationMs: Date.now() - start,
          timestamp: Date.now(),
        });
        return;
      }
    } catch (err) {
      const e = toMindiError(err);
      ctx?.log?.error("request.error", { code: e.code, message: e.message });
      this.events.emit({
        type: "request:end",
        requestId,
        sessionId: session.id,
        ok: false,
        durationMs: Date.now() - start,
        timestamp: Date.now(),
      });
      yield { type: "error", code: e.code, message: e.message };
    }
  }

  /**
   * Non-streaming variant: collect the full response. Convenience for
   * CLI / SDK consumers.
   */
  async requestOnce(input: string | RuntimeRequestInput): Promise<RuntimeResponse> {
    let text = "";
    let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
    let finishReason: string | undefined;
    const capabilities: Array<{ type: string; source: string; ok: boolean; durationMs: number }> = [];
    let intent: { summary: string; capabilities: string[]; confidence: number } | undefined;
    let error: { code: string; message: string } | undefined;

    for await (const ev of this.request(input)) {
      switch (ev.type) {
        case "intent": intent = ev; break;
        case "capability": capabilities.push({ type: ev.capabilityType, source: ev.source, ok: ev.ok, durationMs: ev.durationMs }); break;
        case "delta": text += ev.text; break;
        case "done": usage = ev.usage; finishReason = ev.finishReason; break;
        case "error": error = { code: ev.code, message: ev.message }; break;
      }
    }
    return { text, usage, finishReason, capabilities, intent, error };
  }

  // ---- Observability ---------------------------------------------------

  /** Subscribe to any runtime event. */
  on<T extends RuntimeEvent["type"]>(
    type: T,
    handler: (event: Extract<RuntimeEvent, { type: T }>) => void,
  ): () => void {
    return this.events.on(type, handler);
  }

  /** Subscribe to every event (logging / metrics sinks). */
  onAny(handler: (event: RuntimeEvent) => void): () => void {
    return this.events.onAny(handler);
  }

  /** Recent event history (for debugging). */
  getHistory(): readonly RuntimeEvent[] {
    return this.events.getHistory();
  }

  /** Health-check all providers. */
  async health(): Promise<Array<{ providerId: string; ok: boolean; latencyMs?: number; error?: string }>> {
    return this.providers.healthAll();
  }

  /** Get a point-in-time snapshot of runtime metrics. */
  getMetrics(): MetricsSnapshot {
    return this.metrics.snapshot();
  }

  /** Reset all collected metrics. */
  resetMetrics(): void {
    this.metrics.reset();
  }
}

// ---- Request / response shapes ----------------------------------------

export interface RuntimeRequestInput {
  /** Session to use (must already exist) */
  sessionId: string;
  /** The user's text input */
  text: string;
  /** Attached files / images that may hint at capabilities */
  attachments?: Array<{ name?: string; mimeType?: string; data?: string }>;
  /** Override the session's model for this request only */
  modelId?: string;
  /** Caller-provided request id (for correlation) */
  requestId?: string;
  /** Per-request AbortSignal */
  signal?: AbortSignal;
  /** Per-request timeout */
  timeoutMs?: number;
  /** Sampling temperature */
  temperature?: number;
  /** Max tokens */
  maxTokens?: number;
  /** Stop sequences */
  stop?: string[];
}

function normalizeInput(input: string | RuntimeRequestInput): RuntimeRequestInput {
  if (typeof input === "string") {
    throw new ConfigError(
      "Runtime.request() requires a sessionId. Pass a RuntimeRequestInput object instead of a bare string.",
    );
  }
  if (!input.sessionId) {
    throw new ConfigError("Runtime.request() requires a sessionId", { input });
  }
  if (!input.text) {
    throw new ConfigError("Runtime.request() requires text", { input });
  }
  return input;
}

export interface RuntimeResponse {
  text: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  finishReason?: string;
  capabilities: Array<{ type: string; source: string; ok: boolean; durationMs: number }>;
  intent?: { summary: string; capabilities: string[]; confidence: number };
  error?: { code: string; message: string };
}

// ---- helpers -----------------------------------------------------------

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 3) + "..." : s;
}

function preview(result: CapabilityResult): string {
  const p = result.payload;
  switch (p.kind) {
    case "text": return truncate(p.text, 200);
    case "command": return truncate(p.stdout, 200);
    case "file": return truncate(p.content, 200);
    case "search": return `${p.results.length} results`;
    case "files": return `${p.entries.length} entries`;
    case "image": return `[image ${p.mimeType}]`;
    case "embedding": return `[vector dim=${p.vector.length}]`;
    case "json":
    case "structured": return truncate(JSON.stringify(p.data), 200);
    default: return "";
  }
}

export { MindiError };
