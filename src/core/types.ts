/**
 * MINDI Runtime — Core Type System
 *
 * Everything in the runtime is designed around CAPABILITIES, not models.
 * A capability is a discrete ability (Vision, OCR, Web Search, Terminal, ...)
 * that is exposed through a common interface independent of its implementation.
 *
 * Providers declare which capabilities they natively support.
 * Tools provide deterministic implementations of capabilities.
 * The runtime diffs "what the task needs" against "what the selected model has"
 * and routes only the missing pieces to the best executor.
 */

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * Canonical list of capability types the runtime understands.
 * Adding a new capability means adding a new member here and implementing
 * a capability module — no core architecture change required.
 */
export const CapabilityType = {
  /** Multimodal image understanding (what is in this image?) */
  Vision: "vision",
  /** Optical character recognition — extract text from images / scanned docs */
  OCR: "ocr",
  /** Real-time web search */
  WebSearch: "web_search",
  /** Headless browser automation (navigate, click, scrape JS-rendered pages) */
  Browser: "browser",
  /** Filesystem read/write operations */
  Filesystem: "filesystem",
  /** Git operations (status, diff, log, commit) */
  Git: "git",
  /** Shell command execution */
  Terminal: "terminal",
  /** Generate images from text */
  ImageGeneration: "image_generation",
  /** Transcribe / process audio */
  Audio: "audio",
  /** Vector embeddings for semantic search / memory */
  Embeddings: "embeddings",
  /** Structured database access (SQL / NoSQL) */
  Database: "database",
  /** Native chat / text completion (the reasoning engine itself) */
  Chat: "chat",
} as const;

export type CapabilityType = (typeof CapabilityType)[keyof typeof CapabilityType];

/**
 * Metadata describing a capability's nature. Used by the router to decide
 * whether a deterministic tool is preferable to an LLM provider.
 */
export type CapabilityNature =
  | "deterministic" // tools are always preferred when available (filesystem, git, terminal)
  | "generative" // requires a model (vision, image generation, chat)
  | "either"; // either could satisfy it (ocr, web search, embeddings)

/**
 * Every capability implementation (provider adapter or tool) exposes this
 * common surface. Implementation details differ; the contract does not.
 */
export interface ICapability {
  /** Stable unique id, e.g. "openai.vision" or "tool.filesystem" */
  readonly id: string;
  /** Which capability type this implements */
  readonly type: CapabilityType;
  /** Whether this is a tool (deterministic) or provider (model-backed) */
  readonly source: "tool" | "provider";
  /** Human label for logs and UIs */
  readonly label: string;
  /** Declared priority; higher wins when multiple executors compete */
  readonly priority: number;
  /** Execute the capability against normalized input. */
  execute(input: CapabilityInput, ctx: ExecutionContext): Promise<CapabilityResult>;
  /** Quick capability probe — can this implementation handle this input? */
  canHandle(input: CapabilityInput): boolean;
}

/**
 * Normalized input for any capability. Specific capability types may
 * extend `params` with their own schema.
 */
export interface CapabilityInput {
  /** Which capability type this input targets */
  type: CapabilityType;
  /** Free-form params specific to the capability type */
  params: Record<string, unknown>;
  /** Originating request id, for tracing */
  requestId: string;
  /** Originating session id */
  sessionId: string;
}

/**
 * Normalized result of any capability execution. The ContextBuilder turns
 * this into context the primary model can reason over.
 */
export interface CapabilityResult {
  /** Which capability produced this */
  type: CapabilityType;
  /** Which executor produced this (capability id) */
  source: string;
  /** Whether execution succeeded */
  ok: boolean;
  /** Normalized payload — see CapabilityPayload variants below */
  payload: CapabilityPayload;
  /** Optional error message when ok=false */
  error?: string;
  /** Wall-clock duration in ms */
  durationMs: number;
  /** Tokens consumed if a provider was used (for observability/cost) */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

/**
 * Discriminated union of normalized payloads. Adding a new payload shape
 * is the only change needed to support a new result format.
 */
export type CapabilityPayload =
  | { kind: "text"; text: string }
  | { kind: "json"; data: unknown }
  | { kind: "image"; mimeType: string; base64: string; url?: string }
  | { kind: "embedding"; vector: number[]; model: string }
  | { kind: "search"; results: Array<{ title: string; url: string; snippet: string }> }
  | { kind: "file"; path: string; content: string; encoding: "utf8" | "base64" }
  | { kind: "files"; entries: Array<{ path: string; type: "file" | "dir"; size?: number }> }
  | { kind: "command"; stdout: string; stderr: string; exitCode: number }
  | { kind: "structured"; data: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * A provider is an external AI service. It declares the capabilities it
 * natively supports; the runtime never asks a provider for a capability
 * it has not declared.
 */
export interface IProvider {
  /** Stable unique id, e.g. "openai", "gemini" */
  readonly id: string;
  /** Human label */
  readonly label: string;
  /** Capabilities this provider can natively satisfy */
  readonly capabilities: ReadonlySet<CapabilityType>;
  /** Models this provider exposes */
  listModels(): Promise<ProviderModel[]>;
  /** Probe whether a specific model is available */
  hasModel(modelId: string): Promise<boolean>;
  /** Does this provider declare the capability (for any of its models)? */
  hasCapability(type: CapabilityType): boolean;
  /**
   * Resolve the full capability declaration for a specific model.
   * Implementations should call the provider's model metadata endpoint and
   * cache the result. The runtime uses this for capability negotiation.
   */
  declareCapability(modelId: string): Promise<ProviderCapabilityDeclaration>;
  /** Native chat completion, streaming. Only called for CapabilityType.Chat. */
  chat(request: ChatRequest, ctx: ExecutionContext): AsyncIterable<ChatChunk>;
  /** Execute a non-chat capability natively (e.g. provider's own vision, embeddings). */
  executeCapability(
    type: CapabilityType,
    input: CapabilityInput,
    ctx: ExecutionContext,
  ): Promise<CapabilityResult>;
  /** Liveness check */
  health(): Promise<ProviderHealth>;
}

export interface ProviderModel {
  id: string;
  label: string;
  /** Capabilities this specific model supports (subset of provider's) */
  capabilities: CapabilityType[];
  /** Max input context in tokens */
  contextWindow?: number;
  /** Optional pricing per 1M tokens, in USD */
  pricing?: { inputPer1M?: number; outputPer1M?: number };
}

/**
 * Rich capability declaration for a specific (provider, model) tuple.
 *
 * Replaces static hardcoded assumptions with real provider-discovered
 * capabilities. The runtime caches these per model id; providers populate
 * them from their API's model metadata endpoint.
 */
export interface ProviderCapabilityDeclaration {
  /** Provider id */
  providerId: string;
  /** Model id */
  modelId: string;
  /** Human-readable label */
  label: string;
  /** Which capability types this model supports */
  capabilities: CapabilityType[];
  /** Supports streaming chat completions */
  streaming: boolean;
  /** Supports OpenAI-style tool/function calling */
  toolCalling: boolean;
  /** Accepts image inputs (multimodal) */
  multimodal: boolean;
  /** Supports generating embeddings */
  embeddingSupport: boolean;
  /** Supports generating images (e.g. DALL-E) */
  imageGeneration: boolean;
  /** Supports audio input/output */
  audioSupport: boolean;
  /** Maximum input context window in tokens */
  maxContext: number;
  /** Max output tokens per request */
  maxOutputTokens?: number;
  /** Provider-specific metadata (version, region, etc.) */
  metadata: Record<string, unknown>;
  /** When this declaration was resolved (epoch ms) */
  resolvedAt: number;
}

export interface ProviderHealth {
  providerId: string;
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * A tool is a deterministic, sandboxed executor for a capability.
 * Tools are preferred over LLM providers whenever they can satisfy a
 * capability more accurately.
 */
export interface ITool {
  /** Stable unique id, e.g. "tool.filesystem" */
  readonly id: string;
  /** Which capability this tool implements */
  readonly capability: CapabilityType;
  /** Human label */
  readonly label: string;
  /** Tool never depends on a remote service */
  readonly deterministic: true;
  /** Execute the tool against normalized input. */
  execute(input: CapabilityInput, ctx: ExecutionContext): Promise<CapabilityResult>;
  /** Can this tool satisfy this particular input? */
  canHandle(input: CapabilityInput): boolean;
}

/**
 * Sandbox policy applied to all tool executions. Tools MUST honor this.
 * The runtime rejects any tool attempt to escape the sandbox.
 */
export interface SandboxPolicy {
  /** Filesystem roots the tool is allowed to read/write within */
  allowedRoots: string[];
  /** Shell commands the tool is allowed to run (empty = none) */
  allowedCommands: string[];
  /** Network egress permitted? (default false for tools) */
  allowNetwork: boolean;
  /** Hard wall-clock timeout per execution */
  timeoutMs: number;
  /** Max output bytes per execution */
  maxOutputBytes: number;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export type ChatRole = "system" | "user" | "assistant" | "tool" | "capability";

/**
 * A message in a conversation. `capability` role messages carry the
 * normalized context the runtime injected (results from tools/providers).
 */
export interface ChatMessage {
  role: ChatRole;
  content: ChatContent;
  /** Optional name (for tool/capability messages) */
  name?: string;
  /** Optional tool call id this message answers */
  toolCallId?: string;
}

export type ChatContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image"; mimeType: string; base64: string | URL }
      | { type: "image_url"; url: string }
    >;

export interface ChatRequest {
  /** Provider-specific model id */
  model: string;
  /** Conversation so far */
  messages: ChatMessage[];
  /** Sampling temperature */
  temperature?: number;
  /** Max tokens to generate */
  maxTokens?: number;
  /** Stop sequences */
  stop?: string[];
  /** Optional capability hints the model can lean on */
  capabilities?: CapabilityType[];
}

export interface ChatChunk {
  /** Incremental text delta */
  delta?: string;
  /** Final usage stats, only on last chunk */
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  /** Signals stream end */
  done?: boolean;
  /** Optional finish reason */
  finishReason?: "stop" | "length" | "tool_call" | "error";
}

// ---------------------------------------------------------------------------
// Execution context (threaded through every call)
// ---------------------------------------------------------------------------

/**
 * ExecutionContext is passed to every capability/tool/provider call.
 * It carries correlation ids, cancellation, logging and the event bus —
 * never business state.
 */
export interface ExecutionContext {
  /** Correlation id for this request */
  requestId: string;
  /** Session id this request belongs to */
  sessionId: string;
  /** AbortSignal for cancellation */
  signal: AbortSignal;
  /** Structured logger scoped to this request */
  log: ILogger;
  /** Event bus for emitting lifecycle events */
  events: IEventBus;
}

export interface ILogger {
  trace(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  /** Create a child logger with extra persistent context */
  child(meta: Record<string, unknown>): ILogger;
}

export interface IEventBus {
  emit<T extends RuntimeEvent>(event: T): void;
  on<T extends RuntimeEvent["type"]>(
    type: T,
    handler: (event: Extract<RuntimeEvent, { type: T }>) => void,
  ): () => void;
  /** Remove all handlers — used in tests */
  clear(): void;
}

// ---------------------------------------------------------------------------
// Runtime events — every internal communication is one of these
// ---------------------------------------------------------------------------

export type RuntimeEvent =
  | { type: "request:start"; requestId: string; sessionId: string; input: string; model: string; timestamp: number }
  | { type: "request:end"; requestId: string; sessionId: string; ok: boolean; durationMs: number; timestamp: number }
  | { type: "session:created"; sessionId: string; timestamp: number }
  | { type: "intent:analyzed"; requestId: string; intent: IntentDescriptor; timestamp: number }
  | { type: "planner:plan"; requestId: string; plan: CapabilityPlan; timestamp: number }
  | { type: "capability:dispatch"; requestId: string; capabilityId: string; capabilityType: CapabilityType; executor: "tool" | "provider"; timestamp: number }
  | { type: "capability:success"; requestId: string; capabilityId: string; durationMs: number; timestamp: number }
  | { type: "capability:error"; requestId: string; capabilityId: string; error: string; timestamp: number }
  | { type: "context:assembled"; requestId: string; injectedCount: number; timestamp: number }
  | { type: "provider:stream"; requestId: string; providerId: string; model: string; timestamp: number }
  | { type: "provider:chunk"; requestId: string; delta: string; timestamp: number }
  | { type: "provider:done"; requestId: string; finishReason: string; timestamp: number }
  | { type: "memory:written"; sessionId: string; entries: number; timestamp: number }
  // Execution graph events — emitted by the GraphExecutor
  | { type: "execution_graph_created"; requestId: string; graphId: string; nodeCount: number; timestamp: number }
  | { type: "node_started"; requestId: string; graphId: string; nodeId: string; capability: CapabilityType; timestamp: number }
  | { type: "node_waiting"; requestId: string; graphId: string; nodeId: string; waitingFor: string[]; timestamp: number }
  | { type: "node_completed"; requestId: string; graphId: string; nodeId: string; ok: boolean; durationMs: number; timestamp: number }
  | { type: "node_failed"; requestId: string; graphId: string; nodeId: string; error: string; timestamp: number }
  | { type: "graph_completed"; requestId: string; graphId: string; ok: boolean; durationMs: number; completedNodes: number; failedNodes: number; timestamp: number };

// ---------------------------------------------------------------------------
// Intent & Planning
// ---------------------------------------------------------------------------

/**
 * Output of the IntentAnalyzer. Describes what the user is trying to do
 * and which capabilities the request appears to require.
 */
export interface IntentDescriptor {
  /** Free-text summary of the user's intent */
  summary: string;
  /** Capability types the request seems to require */
  requiredCapabilities: CapabilityType[];
  /** Confidence 0..1 */
  confidence: number;
  /** Signals extracted from input that drove the analysis */
  signals: IntentSignal[];
}

export interface IntentSignal {
  /** Which capability this signal hints at */
  capability: CapabilityType;
  /** Why we think so (matched keyword, attached file, etc.) */
  reason: string;
  /** Weight 0..1 */
  weight: number;
}

/**
 * Output of the CapabilityPlanner. Diffs required capabilities against
 * the selected model's declared capabilities and produces a plan listing
 * the missing capabilities that must be augmented.
 */
export interface CapabilityPlan {
  /** Capabilities the primary model already has — no augmentation needed */
  satisfied: CapabilityType[];
  /** Capabilities that must be augmented by routing to a tool/provider */
  missing: PlannedCapability[];
  /** Capabilities required but no executor available — will degrade gracefully */
  unavailable: Array<{ type: CapabilityType; reason: string }>;
}

export interface PlannedCapability {
  type: CapabilityType;
  /** Normalized input to feed the executor */
  input: CapabilityInput;
  /** Whether a deterministic tool is preferred (router decides final executor) */
  preferTool: boolean;
}

// ---------------------------------------------------------------------------
// Execution Graph — DAG of capability executions
// ---------------------------------------------------------------------------

/** State of a single execution node in the graph. */
export type ExecutionState =
  | "pending"
  | "waiting"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

/** Retry policy for a node. */
export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  retryOn: string[];
}

/**
 * A single node in the execution graph. Each node represents one capability
 * execution that must happen to satisfy the request.
 */
export interface ExecutionNode {
  /** Unique execution id within this graph */
  id: string;
  /** Which capability this node executes */
  capability: CapabilityType;
  /** Who should execute: "tool", "provider", or "auto" (router decides) */
  executorType: "tool" | "provider" | "auto";
  /** Node ids that must complete before this node can start */
  dependencies: string[];
  /** Current execution state */
  state: ExecutionState;
  /** Relative cost estimate (units, not dollars) */
  estimatedCost: number;
  /** Estimated latency in ms */
  estimatedLatencyMs: number;
  /** Hard timeout for this node */
  timeoutMs: number;
  /** Retry policy */
  retryPolicy: RetryPolicy;
  /** Normalized input to feed the executor */
  input: CapabilityInput;
  /** Optional condition: only execute if this returns true given prior results */
  condition?: (results: Map<string, CapabilityResult>) => boolean;
  /** Filled after execution */
  result?: CapabilityResult;
  /** Number of attempts made */
  attempts: number;
}

/**
 * A Directed Acyclic Graph of execution nodes.
 * The GraphExecutor processes this topologically — independent nodes run
 * in parallel, dependent nodes wait.
 */
export interface ExecutionGraph {
  /** Unique graph id */
  id: string;
  /** All nodes keyed by id */
  nodes: Map<string, ExecutionNode>;
  /** Node ids with no dependencies (entry points) */
  rootIds: string[];
  /** Adjacency: nodeId -> ids of nodes that depend on it */
  dependents: Map<string, string[]>;
}

/** Result of executing an entire graph. */
export interface GraphExecutionResult {
  graph: ExecutionGraph;
  /** Results keyed by node id */
  results: Map<string, CapabilityResult>;
  /** Whether all nodes completed successfully */
  ok: boolean;
  /** Total wall-clock duration */
  durationMs: number;
  /** Count of completed nodes */
  completedNodes: number;
  /** Count of failed nodes */
  failedNodes: number;
}
