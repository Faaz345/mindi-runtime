import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFileSync, realpathSync, statSync } from "node:fs";
import type {
  CapabilityInput,
  CapabilityResult,
  CapabilityType,
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ExecutionContext,
  IProvider,
  ProviderModel,
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
import { WorkspaceStore } from "../workspace/WorkspaceStore.js";
import { ProjectMemoryManager } from "../workspace/ProjectMemory.js";
import { ContextCompressor } from "../workspace/ContextCompressor.js";
import { SessionSearch } from "../workspace/SessionSearch.js";
import {
  WorkspaceSessionManager,
  type AvailabilityProbe,
  type RestoreResult,
} from "../workspace/WorkspaceSessionManager.js";
import { SlashCommandRegistry, type RuntimeCommandBridge } from "../workspace/SlashCommands.js";
import { ModelCapabilityRegistry } from "../capability/ModelCapabilityRegistry.js";
import { CapabilityCache } from "../capability/CapabilityCache.js";
import { profileToCapabilityTypes } from "../capability/CapabilityDetector.js";
import type { RefreshReport } from "../capability/types.js";
import { TaskPlanner } from "../planner/TaskPlanner.js";
import { AgentOrchestrator, type AgentRunResult } from "../agent/AgentOrchestrator.js";
import { isVisionRefusal } from "../agent/visionRefusal.js";

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
  readonly taskPlanner: TaskPlanner;
  readonly executionPlanner: ExecutionPlanner;
  readonly router: CapabilityRouter;
  readonly graphExecutor: GraphExecutor;
  readonly metrics: MetricsCollector;
  readonly context: ContextBuilder;
  readonly sessions: SessionManager;
  readonly memory: MemoryLayer;
  readonly availability: CapabilityAvailabilityTracker;
  readonly networkPolicy: ReturnType<typeof createNetworkPolicy>;
  /** Model capability registry — single source of truth for model capabilities. */
  readonly modelCapabilities: ModelCapabilityRegistry;
  /** Workspace session system (null when workspace.enabled = false). */
  readonly workspace: WorkspaceSystem | null;

  private readonly logLevel: LogLevel;

  constructor(userConfig?: RuntimeConfig) {
    this.config = resolveConfig(userConfig);
    this.logLevel = this.config.logLevel;
    this.events = new EventBus({ keepHistory: true });
    this.log = new Logger({ level: this.logLevel, context: { component: "runtime" } });
    this.registry = new CapabilityRegistry();
    this.toolRuntime = new ToolRuntime(this.config.sandbox, this.registry).registerBuiltin();
    this.providers = new ProviderManager(this.registry);
    // Model capability registry — the single source of truth for what each
    // model can do. Metadata-first detection, heuristic fallback, persistent
    // cache when the workspace is enabled.
    this.modelCapabilities = new ModelCapabilityRegistry(
      this.config.workspace.enabled
        ? new CapabilityCache(
            path.join(this.config.workspace.rootDir, ".mindi", "cache", "capabilities.json"),
          )
        : undefined,
    );
    this.modelCapabilities.attachProviders(this.providers);
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
    this.planner = new CapabilityPlanner(this.registry, this.availability, this.modelCapabilities);
    this.taskPlanner = new TaskPlanner();
    this.router = new CapabilityRouter(this.registry);
    this.executionPlanner = new ExecutionPlanner();
    this.graphExecutor = new GraphExecutor(this.router);
    this.context = new ContextBuilder();
    this.memory = new MemoryLayer(new InMemoryMemoryStore(), this.config.maxHistoryMessages);
    this.sessions = new SessionManager(this.memory);
    // Workspace persistence system — opt-in via config.workspace.enabled
    // (default true). When enabled, sessions/history/project-memory/summaries
    // are persisted to .mindi/ and auto-restored across launches.
    this.workspace = this.config.workspace.enabled
      ? this.initWorkspace()
      : null;
    // Wire metrics collector to the event bus — non-invasive, listen-only.
    this.metrics = new MetricsCollector();
    this.events.onAny((e) => this.metrics.onEvent(e));
  }

  /**
   * Initialize the workspace system. Builds all the pieces (store, project
   * memory, compressor, search, session manager, slash command registry)
   * and returns them bundled. Called from the constructor.
   */
  private initWorkspace(): WorkspaceSystem {
    const store = new WorkspaceStore(this.config.workspace.rootDir);
    const projectMemory = new ProjectMemoryManager(store);
    const compressor = new ContextCompressor(store);
    const search = new SessionSearch(store);
    const sessionManager = new WorkspaceSessionManager(store, projectMemory, compressor, search);
    // Bridge: lets /model and /refresh-models reach the runtime's capability
    // registry + provider manager from the slash command layer.
    const bridge: RuntimeCommandBridge = {
      getCurrentSelection: () => {
        const active = sessionManager.getActive();
        return active
          ? { providerId: active.providerId, modelId: active.modelId }
          : { providerId: this.config.defaultProviderId, modelId: this.config.defaultModel };
      },
      getProviderLabel: (providerId) => this.providers.get(providerId)?.label ?? providerId,
      getProfile: (providerId, modelId) => this.modelCapabilities.get(providerId, modelId),
      refreshModels: () => this.refreshCapabilities(),
    };
    const slash = new SlashCommandRegistry(sessionManager, bridge);
    return { store, projectMemory, compressor, search, sessionManager, slash };
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
    // Lazily discover this provider's models in the background so the
    // capability registry warms up without blocking startup.
    void this.modelCapabilities.refresh().catch(() => {});
    return this;
  }

  /** Allow callers to register custom tools at runtime. */
  registerTool(tool: import("../core/types.js").ITool): this {
    this.toolRuntime.register(tool);
    return this;
  }

  /**
   * Rebuild the capability registry from fresh provider metadata.
   * Reconnects to every configured provider, refreshes metadata, updates
   * the persistent cache. Returns a summary report.
   */
  async refreshCapabilities(): Promise<RefreshReport> {
    return this.modelCapabilities.refresh();
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

  // ---- Workspace (persistent sessions) --------------------------------

  /**
   * Restore the last active workspace session (or create one). Call this on
   * launch, before the first user prompt, so the conversation continues
   * naturally. Returns null when the workspace system is disabled.
   *
   * The restored session's provider/model are validated against currently
   * registered providers, with automatic fallback if the saved ones are gone.
   *
   * The restored session is also mirrored into the in-memory SessionManager
   * (same id + full history) so request() continues with complete context.
   */
  async restoreWorkspace(): Promise<RestoreResult | null> {
    if (!this.workspace) return null;
    const probe = makeAvailabilityProbe(this.providers);
    const result = await this.workspace.sessionManager.restore(probe, {
      providerId: this.config.defaultProviderId,
      modelId: this.config.defaultModel,
    });

    // Mirror into the legacy SessionManager so the request lifecycle sees the
    // restored session (id + provider + model + history). The model receives
    // the restored messages before the first user prompt — the conversation
    // continues as if nothing was interrupted.
    const history = this.workspace.sessionManager.recall(result.session.id);
    this.sessions.restore(
      result.session.id,
      {
        providerId: result.effectiveProviderId,
        modelId: result.effectiveModelId,
        systemPrompt: result.session.systemPrompt,
        meta: result.session.meta,
      },
      history,
    );
    return result;
  }

  /**
   * Switch to a different workspace session mid-flight (used by /switch).
   * Mirrors the target session into the in-memory SessionManager and returns
   * restore-style info so callers can update provider/model.
   */
  async activateWorkspaceSession(sessionId: string): Promise<RestoreResult | null> {
    if (!this.workspace) return null;
    this.workspace.sessionManager.switch(sessionId);
    // Reuse the normal restore path so the selected session's persisted
    // provider/model are validated and mirrored into the live runtime.
    return this.restoreWorkspace();
  }

  /**
   * Dispatch a slash command (e.g. "/new", "/switch abc"). Returns whether it
   * was handled and an optional user-facing message. Returns handled=false
   * for non-slash input so the caller can treat it as a normal prompt.
   */
  async dispatchSlashCommand(raw: string) {
    if (!this.workspace) {
      return { handled: false as const };
    }
    return this.workspace.slash.dispatch(raw);
  }

  /** True if a `.mindi` workspace already exists in the configured root. */
  hasWorkspace(): boolean {
    return this.workspace?.store.exists() ?? false;
  }

  /**
   * Extract image content parts from a request — from explicit attachments
   * and from image file paths mentioned in the text (quoted or bare).
   * Only returns parts when the model has native vision; otherwise returns
   * empty parts so the request stays text-only (and vision gets augmented
   * via a capability executor instead).
   *
   * If an image path was referenced but the file cannot be read, returns a
   * `warning` string the caller should surface to the user (via the model),
   * instead of silently dropping the image.
   */
  private extractImageParts(
    req: RuntimeRequestInput,
    modelCapabilities: ReadonlySet<CapabilityType>,
  ): {
    parts: Array<{ type: "image"; mimeType: string; base64: string | URL } | { type: "image_url"; url: string }>;
    warning?: string;
    imageBytes: number;
  } {
    const parts: Array<{ type: "image"; mimeType: string; base64: string | URL } | { type: "image_url"; url: string }> = [];
    let imageBytes = 0;
    if (!modelCapabilities.has("vision" as CapabilityType)) return { parts, imageBytes };

    // 1. Explicit attachments that are images.
    for (const att of req.attachments ?? []) {
      if (!att.data) continue;
      const mime = att.mimeType ?? "image/png";
      if (mime.startsWith("image/")) {
        // data may be a data URI or raw base64.
        const base64 = att.data.startsWith("data:") ? att.data.split(",")[1] ?? att.data : att.data;
        parts.push({ type: "image", mimeType: mime, base64 });
        imageBytes += Math.ceil(base64.length * 3 / 4);
      }
    }
    if (parts.length > 0) return { parts, imageBytes };

    // 2. Image file path in the text (quoted paths may contain spaces).
    const text = req.text;
    const quoted = text.match(/"([^"]+\.(?:png|jpe?g|gif|webp|bmp|tiff?))"/i)
      ?? text.match(/'([^']+\.(?:png|jpe?g|gif|webp|bmp|tiff?))'/i);
    const bare = quoted
      ? null
      : text.match(/([A-Za-z]:[\\\/][^\s"']+\.(?:png|jpe?g|gif|webp|bmp|tiff?))|(\/[^\s"']+\.(?:png|jpe?g|gif|webp|bmp|tiff?))/i);
    const filePath = quoted?.[1] ?? bare?.[1] ?? bare?.[2];
    if (filePath) {
      const dataUri = readImageAsDataUri(filePath, this.config.sandbox.allowedRoots, true);
      if (dataUri) {
        parts.push({ type: "image_url", url: dataUri });
        imageBytes += Math.ceil(dataUri.length * 3 / 4);
      } else {
        return {
          parts,
          imageBytes,
          warning: `[System note: the user referenced an image file, but it could not be read from disk (file not found, inaccessible, or an unsupported format): ${filePath}. Do NOT pretend to analyze it — tell the user the file could not be read and ask them to verify the path.]`,
        };
      }
    }

    return { parts, imageBytes };
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
    const initialReq = normalizeInput(input);
    const pathResult = extractImageAttachment(initialReq, this.config.sandbox.allowedRoots);
    const req: RuntimeRequestInput = pathResult?.attachment
      ? { ...initialReq, attachments: [...(initialReq.attachments ?? []), pathResult.attachment] }
      : initialReq;
    // Set when the user referenced an image that couldn't be read from disk.
    const imageReadWarning = pathResult?.warning;
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

      const capabilityMessages: ChatMessage[] = [];
      const usedCapabilityTypes: CapabilityType[] = [];
      let visionAugmentFailed = false;
      let visionAugmentOk = false;
      if (req.mode !== "plan") {
        // 3. Plan what the model lacks, then execute only in Build mode.
        const plan = await this.planner.plan(intent, provider, modelId, {
          requestId,
          sessionId: session.id,
          messages: history,
          input: req.text,
          attachments: req.attachments,
        });
        this.events.emit({ type: "planner:plan", requestId, plan, timestamp: Date.now() });
        yield {
          type: "plan",
          satisfied: plan.satisfied,
          missing: plan.missing.map((m) => m.type),
          unavailable: plan.unavailable,
        };

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

        for await (const { result } of this.graphExecutor.execute(execGraph, ctx)) {
          capabilityMessages.push(this.context.buildMessage(result));
          usedCapabilityTypes.push(result.type);
          if (result.type === ("vision" as CapabilityType)) {
            if (result.ok) visionAugmentOk = true;
            else visionAugmentFailed = true;
          }
          yield {
            type: "capability",
            capabilityType: result.type,
            source: result.source,
            ok: result.ok,
            durationMs: result.durationMs,
            preview: preview(result),
          };
        }
      } else {
        yield { type: "plan", satisfied: [], missing: [], unavailable: [] };
      }

      // Determine which capabilities the PRIMARY MODEL has natively.
      // The ModelCapabilityRegistry is the single source of truth — the
      // provider is never asked to infer capabilities itself.
      const profile = await this.modelCapabilities.ensure(provider.id, modelId);
      const modelCapabilities = new Set<CapabilityType>(profileToCapabilityTypes(profile));

      // 5. Build the augmented message list for the primary model.
      // If the model has native vision, embed images directly as multimodal
      // content so the model actually SEES them (no hallucinated analysis).
      // If an image path was referenced but the file can't be read, a warning
      // is appended to the message so the model can tell the user.
      const { parts: imageParts, warning: imageWarning, imageBytes } = this.extractImageParts(req, modelCapabilities);
      // Tell the client an image was attached (transparency — the user can
      // verify the image actually made it into the request).
      if (imageParts.length > 0) {
        yield { type: "attachment", kind: "image", count: imageParts.length, sizeBytes: imageBytes };
      }
      // When images are embedded, anchor the model on the image. Weak vision
      // models otherwise ignore the image and hallucinate from system context.
      const anchorNote = imageParts.length > 0
        ? "\n\n[An image is attached to this message. Carefully analyze the ACTUAL image content — its layout, colors, text, and components — and base your response primarily on what is literally in the image, not on assumptions or prior context.]"
        : "";
      const userText = `${req.text}${anchorNote}${imageWarning ? `\n\n${imageWarning}` : ""}`;
      const userMessage: ChatMessage = imageParts.length > 0
        ? { role: "user", content: [{ type: "text", text: userText }, ...imageParts] }
        : { role: "user", content: userText };
      const maxHistoryForRequest = Math.min(history.length, this.config.maxHistoryMessages);
      const truncatedHistory = maxHistoryForRequest < history.length
        ? [history[0]!, ...history.slice(-maxHistoryForRequest)]
        : history;

      // Build available/unavailable lists from the model's perspective:
      // - Capabilities the model has natively → "available (native)"
      // - Capabilities the model lacks but runtime has tools for → "available (via runtime)"
      // - Capabilities that are unavailable → "unavailable"
      const toolAvailable = this.availability.getAvailable();
      const toolUnavailable = this.availability.getUnavailable();
      const availableCaps: CapabilityType[] = [...modelCapabilities, ...toolAvailable];
      const executionWorkspace = this.config.workspace.enabled
        ? this.config.workspace.rootDir
        : this.config.sandbox.allowedRoots[0] ?? this.config.workspace.rootDir;
      const unavailableCaps = toolUnavailable.map((u) => ({
        type: u.capability,
        reason: u.unavailableReason ?? "Unavailable",
      }));

      // ------------------------------------------------------------------
      // SEMANTIC TASK ROUTING (classified BEFORE the system prompt is built
      // so the prompt can honestly state whether tools are invocable).
      //
      // The TaskPlanner classifies the user's GOAL. Multi-step goals
      // (artifact creation, repo analysis, web research, code modification,
      // scaffolding, fixing) are NEVER "native" — they go through the
      // AgentOrchestrator: Plan → Execute → Observe → Reflect → Continue.
      // Simple chat takes the classic single-shot path below.
      // ------------------------------------------------------------------
      const taskPlan = this.taskPlanner.classify({
        text: req.text,
        hasImages: imageParts.length > 0 || intent.requiredCapabilities.includes("vision" as CapabilityType),
        attachments: req.attachments,
        modelProfile: profile,
      });
      ctx.log.info("task.classified", {
        kind: taskPlan.kind,
        taskType: taskPlan.taskType,
        chain: taskPlan.chain,
        reasoning: taskPlan.reasoning,
      });

      const agentMode = req.mode !== "plan" && taskPlan.kind === "agentic";
      const systemPrompt = this.context.buildSystemPrompt({
        availableCapabilities: availableCaps,
        unavailableCapabilities: unavailableCaps,
        workspace: executionWorkspace,
        provider: provider.id,
        model: modelId,
        modelHasNative: Array.from(modelCapabilities),
        agentMode,
        nativeTools: profile.toolCalling === true,
      });

      const augmented: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...truncatedHistory.filter((m) => m.role !== "system"),
        ...capabilityMessages,
        userMessage,
      ];
      // Unreadable image path — warn EVERY model (not just vision-native
      // ones) so it never burns turns probing the filesystem for the file.
      if (imageReadWarning && !imageWarning) {
        augmented.splice(augmented.length - 1, 0, { role: "system", content: imageReadWarning });
      }
      // Vision augmentation was attempted and failed on every provider.
      // Without this note the model tries to inspect the image itself with
      // fs/terminal tools — all sandbox-blocked — and wastes the whole loop.
      if (visionAugmentFailed && !visionAugmentOk) {
        augmented.splice(augmented.length - 1, 0, {
          role: "system",
          content: [
            "[System note: the user referenced an image. The runtime read the image",
            "file and attempted vision analysis, but it FAILED on every configured",
            "provider (no vision-capable model available). The file EXISTS — do NOT",
            "try to locate, read, stat, or list it with filesystem/terminal tools.",
            "Tell the user plainly that image analysis is unavailable right now,",
            "suggest selecting a vision-capable model/provider, and ask how to",
            "proceed. Never fabricate an analysis from the filename.]",
          ].join(" "),
        });
      }
      if (req.mode === "plan") {
        augmented.splice(1, 0, {
          role: "system",
          content: [
            "You are in PLAN MODE. Discuss and refine the approach only.",
            "Do not call tools, execute commands, create, edit, or save files, or claim that any action was performed.",
            "When the plan is ready, ask the user whether they want to switch to Build mode and implement it.",
          ].join(" "),
        });
      }

      // Optionally add the augmentation preamble as additional system context.
      const preamble = this.context.buildPreamble(usedCapabilityTypes);
      if (preamble) {
        augmented.splice(1, 0, { role: "system", content: preamble });
      }
      this.events.emit({
        type: "context:assembled",
        requestId,
        injectedCount: capabilityMessages.length,
        timestamp: Date.now(),
      });

      if (agentMode) {
        // ---- AGENTIC PATH: the runtime drives execution end-to-end. ----
        const orchestrator = new AgentOrchestrator();
        let agentResult: AgentRunResult | undefined;
        let agentText = "";
        try {
          const iter = orchestrator.run({
            provider,
            modelId,
            baseMessages: augmented,
            userText: req.text,
            taskPlan,
            ctx,
            registry: this.registry,
            workspace: executionWorkspace,
            // Prefer the API's native function-calling channel when the
            // model's profile says it supports it (vastly more reliable
            // than the textual <tool_call> protocol on strong models).
            nativeTools: profile.toolCalling === true,
          });
          while (true) {
            const step = await iter.next();
            if (step.done) { agentResult = step.value as AgentRunResult; break; }
            const ev = step.value as StreamEvent;
            if (ev.type === "delta") {
              agentText += ev.text;
              this.events.emit({ type: "provider:chunk", requestId, delta: ev.text, timestamp: Date.now() });
            }
            yield ev;
          }
        } catch (err) {
          const e = toMindiError(err);
          ctx.log.error("agent.error", { code: e.code, message: e.message });
          yield { type: "error", code: e.code, message: e.message };
        }

        // Persist the full interaction: user message + capability context +
        // the agent's final response (tool transcript stays in workspace).
        const messagesToSave: ChatMessage[] = [userMessage, ...capabilityMessages];
        if (agentText.trim()) {
          messagesToSave.push({ role: "assistant", content: agentText });
        }
        await this.sessions.remember(session.id, messagesToSave);
        this.events.emit({ type: "memory:written", sessionId: session.id, entries: messagesToSave.length, timestamp: Date.now() });
        if (this.workspace && this.config.workspace.autoSave) {
          const ws = this.workspace.sessionManager;
          if (ws.get(session.id)) {
            ws.remember(session.id, messagesToSave);
            if (agentResult) {
              ws.recordEvent(session.id, {
                timestamp: Date.now(),
                kind: "request:end",
                data: { ok: agentResult.goalCompleted, iterations: agentResult.iterations, toolsExecuted: agentResult.toolsExecuted, taskType: taskPlan.taskType },
              });
            }
          }
        }

        const agentDurationMs = Date.now() - start;
        ctx.log.info("request.end", { ok: agentResult?.goalCompleted ?? false, durationMs: agentDurationMs, iterations: agentResult?.iterations, toolsExecuted: agentResult?.toolsExecuted });
        this.events.emit({
          type: "request:end",
          requestId,
          sessionId: session.id,
          ok: agentResult?.goalCompleted ?? false,
          durationMs: agentDurationMs,
          timestamp: Date.now(),
        });
        return;
      }

      // ---- SIMPLE PATH: classic single-shot chat (below). ----

      // 7. Stream the primary model's response.
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
        const turn = yield* this.streamChatTurn(provider, chatRequest, ctx);
        fullText = turn.text;
        usage = turn.usage;

        // ---- VISION-REFUSAL FALLBACK ----------------------------------
        // The runtime attached an image, but the model replied with a
        // "can't see the image" refusal (free-tier routes silently drop
        // image parts; weak VL models ignore image tokens). Analyze the
        // image with a dedicated vision model on a DIFFERENT route, then
        // regenerate the answer from that analysis.
        if (imageParts.length > 0 && fullText.trim() && isVisionRefusal(fullText)) {
          const retry = yield* this.visionRefusalFallback({
            provider,
            modelId,
            imageParts,
            text: req.text,
            systemPrompt,
            history: truncatedHistory.filter((m) => m.role !== "system"),
            ctx,
          });
          if (retry) {
            fullText = retry.text;
            usage = retry.usage ?? usage;
          }
        }

        // 7. Persist to memory (user message + assistant reply).
        const messagesToSave: ChatMessage[] = [userMessage, ...capabilityMessages];
        if (fullText.trim()) {
          messagesToSave.push({ role: "assistant", content: fullText });
        }
        await this.sessions.remember(session.id, messagesToSave);
        this.events.emit({ type: "memory:written", sessionId: session.id, entries: messagesToSave.length, timestamp: Date.now() });

        // 7b. Persist to the workspace (.mindi) for cross-launch continuity.
        //     Auto-compresses long histories into rolling summaries.
        //     Tolerant: if the workspace doesn't track this session (e.g. it
        //     was created via the legacy SessionManager), skip silently.
        if (this.workspace && this.config.workspace.autoSave) {
          const ws = this.workspace.sessionManager;
          if (ws.get(session.id)) {
            ws.remember(session.id, messagesToSave);
            if (usage) ws.addUsage(session.id, usage);
            ws.recordEvent(session.id, {
              timestamp: Date.now(),
              kind: "request:end",
              data: { ok: true, durationMs: Date.now() - start, model: modelId, provider: provider.id },
            });
          }
        }

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

          // Persist partial result to the workspace too (tolerant).
          if (this.workspace && this.config.workspace.autoSave) {
            const ws = this.workspace.sessionManager;
            if (ws.get(session.id)) {
              ws.remember(session.id, messagesToSave);
              if (usage) ws.addUsage(session.id, usage);
            }
          }

          // Emit a done event so the Terminal shows the partial response.
          yield { type: "done", finishReason: "length", usage };
        } else {
          // No content was generated — save just the user message.
          await this.sessions.remember(session.id, [userMessage, ...capabilityMessages]);
          if (this.workspace && this.config.workspace.autoSave && this.workspace.sessionManager.get(session.id)) {
            this.workspace.sessionManager.remember(session.id, [userMessage, ...capabilityMessages]);
          }
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
   * Stream one chat turn: forwards deltas/done as StreamEvents while
   * accumulating the full text + usage. Extracted so the vision-refusal
   * fallback can re-run a turn with augmented context.
   */
  private async *streamChatTurn(
    provider: IProvider,
    request: ChatRequest,
    ctx: ExecutionContext,
  ): AsyncGenerator<StreamEvent, { text: string; usage?: ChatChunk["usage"] }, unknown> {
    let text = "";
    let usage: ChatChunk["usage"];
    const chunkStream = provider.chat(request, ctx);
    for await (const ev of streamFromChatChunks(chunkStream, ctx)) {
      if (ev.type === "delta") {
        text += ev.text;
        this.events.emit({ type: "provider:chunk", requestId: ctx.requestId, delta: ev.text, timestamp: Date.now() });
      } else if (ev.type === "done") {
        usage = ev.usage;
        this.events.emit({
          type: "provider:done",
          requestId: ctx.requestId,
          finishReason: ev.finishReason ?? "stop",
          timestamp: Date.now(),
        });
      }
      yield ev;
    }
    return { text, usage };
  }

  /**
   * Vision-refusal fallback. The primary model received an attached image
   * but answered with a "can't see it" refusal. Run the image through a
   * dedicated vision capability on an ALTERNATE model/route, then re-ask
   * the primary model with the analysis injected as capability context.
   * Returns the new turn's text/usage, or null when no fallback exists
   * (a warning is emitted so the user knows the answer is unreliable).
   */
  private async *visionRefusalFallback(opts: {
    provider: IProvider;
    modelId: string;
    imageParts: Array<{ type: "image"; mimeType: string; base64: string | URL } | { type: "image_url"; url: string }>;
    text: string;
    systemPrompt: string;
    history: ChatMessage[];
    ctx: ExecutionContext;
  }): AsyncGenerator<StreamEvent, { text: string; usage?: ChatChunk["usage"] } | null, unknown> {
    const { ctx } = opts;
    yield {
      type: "reflection",
      note: "Model reported it cannot see the attached image — trying a dedicated vision model",
      iteration: 0,
    };
    ctx.log.warn("vision.refusal_detected", { model: opts.modelId, provider: opts.provider.id });

    const image = imagePartsToDataUri(opts.imageParts);
    if (!image) return null;

    // 1. Find an alternate vision-capable model (never the one that failed).
    const fallback = await this.resolveFallbackVisionModel(opts.provider.id, opts.modelId);
    if (!fallback) {
      yield {
        type: "reflection",
        note: "The model could not see the attached image and no alternate vision model is configured. The reply above is unreliable — pick a vision-capable model or add a provider that has one.",
        iteration: 0,
      };
      return null;
    }

    // 2. Analyze the image with the fallback model.
    const visionInput: CapabilityInput = {
      type: "vision" as CapabilityType,
      params: {
        prompt: `Analyze this image in detail so another model can answer the user's question about it. User's question: ${opts.text}`,
        image,
        model: fallback.modelId,
      },
      requestId: ctx.requestId,
      sessionId: ctx.sessionId,
    };
    let result: CapabilityResult;
    try {
      result = await fallback.provider.executeCapability("vision" as CapabilityType, visionInput, ctx);
    } catch (err) {
      const e = toMindiError(err);
      ctx.log.warn("vision.fallback_failed", { model: fallback.modelId, error: e.message });
      yield {
        type: "reflection",
        note: `Fallback vision via ${fallback.modelId} failed (${e.message}). The reply above is unreliable.`,
        iteration: 0,
      };
      return null;
    }
    yield {
      type: "capability",
      capabilityType: "vision",
      source: result.source,
      ok: result.ok,
      durationMs: result.durationMs,
      preview: preview(result),
    };
    if (!result.ok || result.payload.kind !== "text" || !result.payload.text.trim()) {
      yield {
        type: "reflection",
        note: `Fallback vision via ${fallback.modelId} failed (${result.error ?? "empty analysis"}). The reply above is unreliable.`,
        iteration: 0,
      };
      return null;
    }

    // 3. Re-ask the primary model with the analysis as context (text-only —
    //    the image itself already proved useless on this route).
    const visionMsg = this.context.buildMessage(result);
    const retryText = `${opts.text}\n\n[System note: your previous reply claimed you could not see the attached image. A dedicated vision model (${fallback.modelId}) has analyzed it — the analysis appears above as a [Capability: Vision] context message. Answer the user's question from that analysis. Do not claim you cannot see the image.]`;
    const retryMessages: ChatMessage[] = [
      { role: "system", content: opts.systemPrompt },
      ...opts.history,
      visionMsg,
      { role: "user", content: retryText },
    ];
    yield {
      type: "reflection",
      note: `Image analyzed via ${fallback.modelId} — regenerating answer`,
      iteration: 0,
    };
    this.events.emit({
      type: "provider:stream",
      requestId: ctx.requestId,
      providerId: opts.provider.id,
      model: opts.modelId,
      timestamp: Date.now(),
    });
    return yield* this.streamChatTurn(opts.provider, { model: opts.modelId, messages: retryMessages }, ctx);
  }

  /**
   * Pick an alternate vision-capable model for the refusal fallback.
   * Excludes the model that just failed; prefers a different provider
   * route, then non-free tiers (free routes are the ones that usually
   * drop image parts silently).
   */
  private async resolveFallbackVisionModel(
    primaryProviderId: string,
    primaryModelId: string,
  ): Promise<{ provider: IProvider; modelId: string } | null> {
    const candidates: Array<{ provider: IProvider; modelId: string; score: number }> = [];
    for (const p of this.providers.selectFor("vision" as CapabilityType)) {
      let models: ProviderModel[] = [];
      try {
        models = await p.listModels();
      } catch {
        continue;
      }
      for (const m of models) {
        if (!m.capabilities.includes("vision" as CapabilityType)) continue;
        if (p.id === primaryProviderId && m.id === primaryModelId) continue;
        let score = 0;
        if (p.id !== primaryProviderId) score += 2; // prefer a different route
        if (!m.id.endsWith(":free")) score += 1; // prefer non-free tiers
        candidates.push({ provider: p, modelId: m.id, score });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    return best ? { provider: best.provider, modelId: best.modelId } : null;
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
  /** Plan is read-only conversation; Build executes sandbox-authorized tools. */
  mode?: "plan" | "build";
}

// ---- Workspace system bundle ------------------------------------------

/**
 * Bundled workspace subsystem. Exposed on `runtime.workspace` so callers
 * (Terminal, CLI) can drive session lifecycle, search, slash commands, and
 * inject project memory into prompts.
 */
export interface WorkspaceSystem {
  store: WorkspaceStore;
  projectMemory: ProjectMemoryManager;
  compressor: ContextCompressor;
  search: SessionSearch;
  sessionManager: WorkspaceSessionManager;
  slash: SlashCommandRegistry;
}

// ---- Availability probe (bridges ProviderManager → WorkspaceSessionManager) ----

/**
 * Builds an AvailabilityProbe against the runtime's ProviderManager.
 * Used by restoreWorkspace() to validate the saved provider/model.
 */
export function makeAvailabilityProbe(pm: ProviderManager): AvailabilityProbe {
  return {
    isProviderAvailable(providerId: string): boolean {
      return !!pm.get(providerId);
    },
    async isModelAvailable(providerId: string, modelId: string): Promise<boolean> {
      const p = pm.get(providerId);
      if (!p) return false;
      try {
        return await p.hasModel(modelId);
      } catch {
        return false;
      }
    },
    async listModels(providerId: string): Promise<string[]> {
      const p = pm.get(providerId);
      if (!p) return [];
      try {
        const models = await p.listModels();
        return models.map((m) => m.id);
      } catch {
        return [];
      }
    },
    fallbackProviderId(unavailableId: string): string | undefined {
      const chatCapable = pm.selectFor("chat" as CapabilityType);
      const alt = chatCapable.find((p) => p.id !== unavailableId);
      return alt?.id;
    },
  };
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

/** Read an image file and return a base64 data URI, or null on failure. */
function readImageAsDataUri(filePath: string, allowedRoots: readonly string[], explicitAttachment = false): string | null {
  try {
    const resolved = realpathSync(filePath);
    const insideRoot = allowedRoots.some((root) => {
      const rootResolved = realpathSync(root);
      const relative = path.relative(rootResolved, resolved);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
    if (!insideRoot && !explicitAttachment) return null;
    const stat = statSync(resolved);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return null;
    const buffer = readFileSync(resolved);
    const ext = filePath.match(/\.(\w+)$/)?.[1]?.toLowerCase() ?? "png";
    const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Convert extracted image parts back into a single data URI (first image). */
function imagePartsToDataUri(
  parts: Array<{ type: "image"; mimeType: string; base64: string | URL } | { type: "image_url"; url: string }>,
): string {
  const p = parts[0];
  if (!p) return "";
  if (p.type === "image_url") return p.url;
  const b64 = typeof p.base64 === "string" ? p.base64 : String(p.base64);
  return b64.startsWith("data:") ? b64 : `data:${p.mimeType};base64,${b64}`;
}

function extractImageAttachment(
  req: RuntimeRequestInput,
  allowedRoots: readonly string[],
): { attachment?: { name: string; mimeType: string; data: string }; warning?: string } | undefined {
  if (req.attachments?.some((a) => a.mimeType?.startsWith("image/") && a.data)) return undefined;
  const match = req.text.match(/"([^"\r\n]+\.(?:png|jpe?g|gif|webp|bmp|tiff?))"|'([^'\r\n]+\.(?:png|jpe?g|gif|webp|bmp|tiff?))'|([A-Za-z]:[\\/][^\s"']+\.(?:png|jpe?g|gif|webp|bmp|tiff?))|(\/[^\s"']+\.(?:png|jpe?g|gif|webp|bmp|tiff?))/i);
  const filePath = match?.[1] ?? match?.[2] ?? match?.[3] ?? match?.[4];
  if (!filePath) return undefined;
  // A path pasted directly into the prompt is an explicit user attachment,
  // not autonomous tool access. General filesystem tools remain sandboxed.
  const dataUri = readImageAsDataUri(filePath, allowedRoots, true);
  if (!dataUri) {
    // The user referenced an image but it can't be read (missing, inaccessible,
    // too large, or unsupported). Surface a warning for EVERY model — not just
    // vision-native ones — so the model never wastes turns probing for it.
    return {
      warning: `[System note: the user referenced an image file, but it could not be read from disk (file not found, inaccessible, or an unsupported format): ${filePath}. Do NOT try to locate or read it with filesystem/terminal tools, and do NOT pretend to analyze it — tell the user the file could not be read and ask them to verify the path or drag the image into the prompt directly.]`,
    };
  }
  const comma = dataUri.indexOf(",");
  const header = dataUri.slice(0, comma);
  const mimeType = header.slice(5, header.indexOf(";"));
  return {
    attachment: {
      name: path.basename(filePath),
      mimeType,
      data: dataUri.slice(comma + 1),
    },
  };
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
