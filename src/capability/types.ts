/**
 * MINDI Capability System — Type System
 *
 * Capabilities belong to MODELS, not providers. This module defines the
 * model-centric capability profile that becomes the single source of truth
 * for the entire runtime:
 *
 *   Provider → Discover Models → Capability Detection → Registry
 *     → Planner → Runtime → Prompt Builder → Tool Dispatcher
 *
 * The provider NEVER decides capabilities. It only fetches raw metadata
 * (`discoverModels()`). The CapabilityDetector converts metadata → profile.
 * The ModelCapabilityRegistry stores profiles and serves every consumer.
 */

import type { CapabilityType } from "../core/types.js";

// ---------------------------------------------------------------------------
// Metadata source
// ---------------------------------------------------------------------------

/** Where a capability profile's data came from. */
export type MetadataSource = "api" | "heuristic" | "cached" | "manual";

// ---------------------------------------------------------------------------
// Raw model metadata — what providers return from discoverModels()
// ---------------------------------------------------------------------------

/**
 * Raw, uninterpreted model metadata as returned by a provider's API.
 * Providers map their native wire format into this normalized shape;
 * the CapabilityDetector then derives the profile from it.
 *
 * Every field is optional — providers fill in whatever their API exposes.
 */
export interface RawModelMetadata {
  /** Model id (e.g. "nvidia/nemotron-nano-12b-v2-vl:free") */
  id: string;
  /** Human label */
  label?: string;
  /** Context window in tokens (OpenRouter: context_length) */
  contextLength?: number;
  /** Max output tokens (OpenRouter: top_provider.max_completion_tokens) */
  maxOutputTokens?: number;
  /** Input modalities (OpenRouter: architecture.input_modalities) */
  inputModalities?: string[];
  /** Output modalities (OpenRouter: architecture.output_modalities) */
  outputModalities?: string[];
  /** Combined modality string (OpenRouter: architecture.modality, e.g. "text+image->text") */
  modality?: string;
  /** Gemini: supportedGenerationMethods */
  supportedGenerationMethods?: string[];
  /** OpenRouter: supported_parameters (tools, response_format, structured_outputs, ...) */
  supportedParameters?: string[];
  /** Provider-declared feature flags */
  features?: string[];
  /** Provider-declared capability names */
  capabilities?: string[];
  /** Original raw payload, kept for future-proofing */
  raw?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Model capability profile — the single source of truth
// ---------------------------------------------------------------------------

/**
 * The complete capability profile for one (provider, model) pair.
 * Built by the CapabilityDetector, stored in the ModelCapabilityRegistry,
 * consumed by the Planner, Runtime, Prompt Builder, and slash commands.
 */
export interface ModelCapabilityProfile {
  /** Composite key: `${provider}:${model}` */
  id: string;
  /** Provider id */
  provider: string;
  /** Model id */
  model: string;
  /** Human label */
  label?: string;

  chat: boolean;
  vision: boolean;
  imageGeneration: boolean;
  embeddings: boolean;
  audioInput: boolean;
  audioOutput: boolean;
  reasoning: boolean;
  functionCalling: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  streaming: boolean;

  supportsFiles: boolean;
  supportsPDF: boolean;
  supportsImages: boolean;
  supportsVideo: boolean;

  supportsThinking: boolean;
  supportsJSON: boolean;
  supportsComputerUse: boolean;
  supportsWebSearch: boolean;

  /** Context window in tokens */
  contextWindow?: number;
  /** Max output tokens per request */
  maxOutputTokens?: number;

  /**
   * Native runtime capability types (CapabilityType) the model satisfies
   * without augmentation. Derived from the boolean flags above, but may
   * also carry extras when bridged from a provider declaration.
   */
  nativeCapabilities: CapabilityType[];

  /** Where this profile's data came from */
  metadataSource: MetadataSource;
  /** When this profile was (re)built (epoch ms) */
  resolvedAt: number;
}

// ---------------------------------------------------------------------------
// Refresh report — returned by ModelCapabilityRegistry.refresh()
// ---------------------------------------------------------------------------

export interface RefreshReport {
  /** Number of providers scanned */
  providersScanned: number;
  /** Number of models discovered across all providers */
  modelsDiscovered: number;
  /** Number of profiles that changed vs the previous cache */
  capabilitiesUpdated: number;
  /** Whether the persistent cache was written */
  cacheRefreshed: boolean;
  /** New models added to the registry */
  added: number;
  /** Models removed (no longer offered by their provider) */
  removed: number;
  /** Models whose profile was preserved unchanged */
  preserved: number;
  /** Per-provider errors (provider id -> message) */
  errors: Record<string, string>;
}
