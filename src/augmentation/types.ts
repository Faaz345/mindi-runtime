/**
 * Capability Augmentation System — Type Definitions
 *
 * Core architectural principle: The Runtime enriches BEFORE the model reasons.
 *
 * Three capability concepts:
 *   1. NATIVE MODEL CAPABILITIES — what the selected model can do by itself
 *   2. RUNTIME AUGMENTATION CAPABILITIES — what the Runtime can execute independently
 *   3. EFFECTIVE CAPABILITIES — the union the user actually experiences
 *
 * Every request passes through the CapabilityAugmentationRouter FIRST.
 * The model never receives a request it cannot handle — the Runtime has
 * already obtained and injected all required context.
 */

import type { CapabilityType, ChatMessage, ExecutionContext } from "../core/types.js";
import type { ModelCapabilityProfile } from "../capability/types.js";

// ---------------------------------------------------------------------------
// Structured Context Block — output of every augmentation module
// ---------------------------------------------------------------------------

/**
 * Every augmentation module produces a StructuredContextBlock.
 * The ContextBuilder converts it into a ChatMessage for the primary model.
 *
 * The block carries both a concise summary (for the system prompt / timeline)
 * and full detail (injected as a context message the model reasons over).
 */
export interface StructuredContextBlock {
  /** Which capability this block satisfies */
  capability: CapabilityType;
  /** Which module/provider produced it (e.g. "vision-augment", "openrouter") */
  source: string;
  /** Whether augmentation succeeded */
  ok: boolean;
  /** Concise structured summary (always present, shown in timeline) */
  summary: string;
  /** Full detail text (truncated to fit context window, injected as message) */
  detail: string;
  /** Metadata for the model and UI (file paths, URLs fetched, tokens used) */
  metadata: Record<string, unknown>;
  /** Wall-clock duration of the augmentation in ms */
  durationMs: number;
  /** Error message when ok=false */
  error?: string;
}

// ---------------------------------------------------------------------------
// Request Analysis — parsed input before augmentation
// ---------------------------------------------------------------------------

/**
 * The result of analyzing a user's raw request. Produced by the Router's
 * input analysis phase, consumed by augmentation modules for detection
 * and execution.
 */
export interface RequestAnalysis {
  /** The user's raw text input */
  text: string;
  /** Parsed attachments (images, files, etc.) */
  attachments: ParsedAttachment[];
  /** URLs detected in the text */
  urls: DetectedUrl[];
  /** File paths detected in the text */
  filePaths: DetectedFilePath[];
  /** Repository references (GitHub, GitLab, etc.) */
  repositories: DetectedRepository[];
  /** Search/research intent signals */
  searchIntent: SearchIntent | null;
  /** Command/terminal intent signals */
  commandIntent: CommandIntent | null;
  /** Session id for correlation */
  sessionId: string;
  /** Request id for tracing */
  requestId: string;
}

export interface ParsedAttachment {
  name?: string;
  mimeType?: string;
  /** Base64 data or data URI */
  data?: string;
  /** Detected kind from mime/extension */
  kind: "image" | "file" | "audio" | "video" | "pdf" | "unknown";
}

export interface DetectedUrl {
  url: string;
  /** Whether this looks like a GitHub/GitLab repository URL */
  isRepository: boolean;
  /** Domain for routing decisions */
  domain: string;
}

export interface DetectedFilePath {
  path: string;
  kind: "file" | "dir";
  /** Whether the path appears to reference an image */
  isImage: boolean;
}

export interface DetectedRepository {
  /** Full URL (e.g. https://github.com/user/repo) */
  url: string;
  /** Provider: github, gitlab, bitbucket */
  host: string;
  /** owner/repo */
  fullName: string;
  /** Whether the user's intent requires cloning (modification) vs inspection */
  needsClone: boolean;
}

export interface SearchIntent {
  /** The inferred search query */
  query: string;
  /** Confidence 0-1 that a web search is needed */
  confidence: number;
  /** Why search was detected */
  reason: string;
}

export interface CommandIntent {
  /** The command the user wants to run */
  command: string;
  /** Confidence 0-1 */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Augmentation Module — extensible capability handler
// ---------------------------------------------------------------------------

/**
 * An augmentation module handles ONE capability type. It can:
 *   - Detect whether a request needs its capability
 *   - Execute the augmentation and produce a StructuredContextBlock
 *   - Report a cost estimate for ordering (lower = try first)
 *
 * Adding a new capability = registering a new module. No core changes needed.
 */
export interface AugmentationModule {
  /** Unique module id (e.g. "vision-augment", "http-augment") */
  readonly id: string;
  /** Which capability this module handles */
  readonly capability: CapabilityType;
  /** Human-readable label for events/logs */
  readonly label: string;

  /**
   * Detect whether this request needs this module's capability.
   * Pure detection — no I/O, no side effects.
   */
  detect(input: RequestAnalysis): boolean;

  /**
   * Execute the augmentation. May perform I/O (network, filesystem, etc.).
   * Returns a StructuredContextBlock with the results.
   * Never throws — errors are captured in the block's ok/error fields.
   */
  execute(input: RequestAnalysis, ctx: AugmentationContext): Promise<StructuredContextBlock>;

  /**
   * Cost estimate for ordering. Lower = cheaper = try first.
   * Scale: 1 (free/local) → 5 (expensive/network/clone)
   */
  costEstimate(input: RequestAnalysis): number;
}

/**
 * Execution context passed to augmentation modules. Provides access to
 * the runtime's provider system, capability registry, and configuration
 * without coupling modules to the full Runtime class.
 */
export interface AugmentationContext {
  /** Execution context for tracing/cancellation */
  ctx: ExecutionContext;
  /** Resolve a provider by id for capability execution */
  getProvider(id: string): AugmentationProvider | undefined;
  /** List all providers that declare a capability */
  providersFor(capability: CapabilityType): AugmentationProvider[];
  /** The workspace root directory */
  workspace: string;
  /** Sandbox allowed roots */
  allowedRoots: readonly string[];
  /** Network policy check */
  isNetworkAllowed(url: string): boolean;
}

/** Minimal provider interface for augmentation modules. */
export interface AugmentationProvider {
  readonly id: string;
  readonly label: string;
  executeCapability(
    type: CapabilityType,
    input: { type: CapabilityType; params: Record<string, unknown>; requestId: string; sessionId: string },
    ctx: ExecutionContext,
  ): Promise<{ ok: boolean; payload: { kind: string; [key: string]: unknown }; error?: string; durationMs: number; source: string }>;
}

// ---------------------------------------------------------------------------
// Effective Capability Card — unified capability view
// ---------------------------------------------------------------------------

/**
 * The single source of truth for what capabilities are available for a
 * request. Used by BOTH simple and agent mode prompt builders.
 * The prompt builder adapts tense only — the card is identical.
 */
export interface EffectiveCapabilityCard {
  /** Provider id */
  provider: string;
  /** Model id */
  model: string;
  /** What the model does natively (verified, not assumed) */
  native: CapabilityType[];
  /** What the runtime augmented for THIS specific request */
  augmented: Array<{ capability: CapabilityType; via: string }>;
  /** What the runtime CAN augment on demand (agent mode tools) */
  runtimeTools: Array<{ name: string; capability: CapabilityType; description: string }>;
  /** What is genuinely unavailable (neither native nor augmentable) */
  unavailable: Array<{ capability: CapabilityType; reason: string }>;
}

// ---------------------------------------------------------------------------
// Augmentation Record — transparency trail
// ---------------------------------------------------------------------------

/**
 * Records what happened during augmentation for a single capability.
 * Emitted as events for the Timeline UI and logged for debugging.
 */
export interface AugmentationRecord {
  capability: CapabilityType;
  /** How it was handled */
  action: "native" | "augmented" | "unavailable" | "skipped";
  /** Which module/provider handled it (for "augmented") */
  via?: string;
  /** Human-readable explanation */
  reason: string;
  /** Duration in ms (0 for native/skipped) */
  durationMs: number;
  /** Whether augmentation succeeded (for "augmented") */
  ok?: boolean;
}

// ---------------------------------------------------------------------------
// Augmentation Result — Router output
// ---------------------------------------------------------------------------

/**
 * The complete output of the CapabilityAugmentationRouter.
 * Contains everything the Runtime needs to build the final request
 * to the primary model.
 */
export interface AugmentationResult {
  /** Enriched messages ready for the primary model (system + context + user) */
  enrichedMessages: ChatMessage[];
  /** What was augmented (for transparency events / timeline) */
  augmentations: AugmentationRecord[];
  /** Effective capability card (for system prompt construction) */
  effectiveCard: EffectiveCapabilityCard;
  /** Routing decision: simple (single turn) or agentic (iterative tools) */
  route: "simple" | "agentic";
  /** Capabilities that are truly unavailable (neither native nor augmentable) */
  unavailable: Array<{ capability: CapabilityType; reason: string }>;
  /** Image parts to embed natively (only when model has native vision) */
  nativeImageParts: Array<{ type: "image"; mimeType: string; base64: string } | { type: "image_url"; url: string }>;
  /** The parsed request analysis (for downstream consumers) */
  analysis: RequestAnalysis;
}

// ---------------------------------------------------------------------------
// Augmentation Input — Router input
// ---------------------------------------------------------------------------

/**
 * Everything the CapabilityAugmentationRouter needs to process a request.
 */
export interface AugmentationInput {
  /** User's text input */
  text: string;
  /** Raw attachments from the client */
  attachments: Array<{ name?: string; mimeType?: string; data?: string }>;
  /** Session id */
  sessionId: string;
  /** Request id */
  requestId: string;
  /** The resolved provider id */
  providerId: string;
  /** The resolved model id */
  modelId: string;
  /** The model's capability profile (pre-resolved) */
  modelProfile: ModelCapabilityProfile;
  /** Session history messages */
  history: ChatMessage[];
  /** Request mode */
  mode?: "plan" | "build";
}

// ---------------------------------------------------------------------------
// Augmentation Policy — user consent management
// ---------------------------------------------------------------------------

/**
 * Manages user consent for augmentation. Generalized from VisionPolicy.
 * Persists per-workspace so the user is never asked twice.
 */
export interface IAugmentationPolicy {
  /**
   * Check if augmentation is allowed for a capability.
   * Returns: true (allowed), false (denied), null (not yet asked).
   */
  isAllowed(capability: CapabilityType): boolean | null;

  /**
   * Record the user's choice for a capability.
   * @param via Optional: the specific provider/model used for augmentation.
   */
  setPreference(capability: CapabilityType, allowed: boolean, via?: string): void;

  /**
   * Get the stored augmentation provider/model for a capability.
   */
  getAugmentationVia(capability: CapabilityType): string | undefined;

  /**
   * Reset preferences (optionally for one capability only).
   */
  reset(capability?: CapabilityType): void;
}

// ---------------------------------------------------------------------------
// Response Validation — anti-hallucination
// ---------------------------------------------------------------------------

/**
 * Result of validating a model's response against actual augmentation results.
 */
export interface ValidationResult {
  /** Whether the response passed validation */
  valid: boolean;
  /** Detected fabrications (empty if valid) */
  fabrications: DetectedFabrication[];
  /** Suggested correction message (for re-loop in agent mode) */
  correction?: string;
}

export interface DetectedFabrication {
  /** What the model claimed to do */
  claim: string;
  /** What category of fabrication */
  type: "tool_execution" | "file_operation" | "command_output" | "network_result";
  /** The matched text span */
  matchedText: string;
}
