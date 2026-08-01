/**
 * Provider configuration system.
 *
 * Supports arbitrary providers via config — no hardcoding.
 * Users add providers by creating a config entry, not changing source code.
 *
 * Supported config formats:
 *   - JSON (.mindi/providers.json)
 *   - Environment variables (PROVIDER_<ID>_<KEY>=value)
 *   - Programmatic (RuntimeConfig.providers)
 *
 * Each provider entry specifies:
 *   - type: "openai-compatible" | "gemini" | "custom" (determines which adapter to use)
 *   - apiKey / baseUrl / headers / etc.
 *
 * The openai-compatible type covers: OpenAI, OpenRouter, TokenRouter,
 * Groq, DeepSeek, Together, Fireworks, Ollama, LM Studio, Azure, vLLM,
 * and any future OpenAI-compatible server.
 */

import type { CapabilityType } from "../core/types.js";

// ---------------------------------------------------------------------------
// Provider Config Entry
// ---------------------------------------------------------------------------

/** Authentication method. */
export type AuthMethod = "bearer" | "api-key-query" | "header" | "none";

/** Retry policy for a provider. */
export interface ProviderRetryPolicy {
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Error codes that should trigger a retry. */
  retryableErrors: string[];
}

/** A single provider configuration entry. */
export interface ProviderEntry {
  /** Provider type — determines which adapter to instantiate. */
  type: "openai-compatible" | "gemini" | "custom";
  /** Human-readable display name. */
  displayName?: string;
  /** API base URL. */
  baseUrl?: string;
  /** API key (for bearer auth). */
  apiKey?: string;
  /** Organization ID (OpenAI-specific). */
  orgId?: string;
  /** Authentication method. Default: "bearer". */
  authMethod?: AuthMethod;
  /** Auth header name (for "header" auth method). */
  authHeader?: string;
  /** Custom headers to send with every request. */
  headers?: Record<string, string>;
  /** Request timeout in ms. */
  timeoutMs?: number;
  /** Retry policy. */
  retryPolicy?: ProviderRetryPolicy;
  /** Declared capabilities (if not auto-detectable). */
  capabilities?: CapabilityType[];
  /**
   * OpenRouter-style strict routing: send `provider.require_parameters=true`
   * so requests only route to upstreams that accept EVERY parameter in the
   * request (including image content parts). Prevents silent image dropping
   * on routes that can't handle multimodal input. Defaults to true on
   * openrouter.ai, off elsewhere.
   */
  requireParameters?: boolean;
  /** Model overrides (capability/contextWindow per model). */
  models?: Record<string, { capabilities: CapabilityType[]; contextWindow?: number }>;
  /** Provider-specific metadata. */
  metadata?: Record<string, unknown>;
  /** Whether this provider is enabled. Default: true. */
  enabled?: boolean;
}

/** Map of provider id → config entry. */
export type ProvidersConfig = Record<string, ProviderEntry>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_RETRY_POLICY: ProviderRetryPolicy = {
  maxAttempts: 3,
  baseBackoffMs: 500,
  maxBackoffMs: 10_000,
  retryableErrors: ["E_PROVIDER_TIMEOUT", "E_PROVIDER_RATE_LIMIT", "E_PROVIDER_UNAVAILABLE"],
};

/**
 * Well-known provider presets shown in the setup wizard.
 * Ordered by popularity — these are the providers a user would recognize.
 * Internal/aggregator providers (TokenRouter, OpenRouter, etc.) are NOT
 * listed here; they are configured via the "Custom Provider" option.
 */
export const PROVIDER_DEFAULTS: Record<string, Partial<ProviderEntry>> = {
  openai: { type: "openai-compatible", baseUrl: "https://api.openai.com/v1", displayName: "OpenAI" },
  anthropic: { type: "openai-compatible", baseUrl: "https://api.anthropic.com/v1", displayName: "Anthropic" },
  gemini: { type: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", displayName: "Google Gemini" },
  deepseek: { type: "openai-compatible", baseUrl: "https://api.deepseek.com/v1", displayName: "DeepSeek" },
  groq: { type: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", displayName: "Groq" },
  mistral: { type: "openai-compatible", baseUrl: "https://api.mistral.ai/v1", displayName: "Mistral AI" },
  ollama: { type: "openai-compatible", baseUrl: "http://localhost:11434/v1", displayName: "Ollama (local)", authMethod: "none" },
  lmstudio: { type: "openai-compatible", baseUrl: "http://localhost:1234/v1", displayName: "LM Studio (local)", authMethod: "none" },
  // Internal/aggregator providers (not shown in wizard, but resolvable by id)
  tokenrouter: { type: "openai-compatible", baseUrl: "https://api.tokenrouter.com/v1", displayName: "MINDI Cloud" },
  openrouter: { type: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", displayName: "OpenRouter" },
  together: { type: "openai-compatible", baseUrl: "https://api.together.xyz/v1", displayName: "Together AI" },
  fireworks: { type: "openai-compatible", baseUrl: "https://api.fireworks.ai/inference/v1", displayName: "Fireworks AI" },
  azure: { type: "openai-compatible", displayName: "Azure OpenAI" },
};

/**
 * The ordered list of providers shown in the setup wizard UI.
 * Well-known providers first, then a "Custom Provider" option at the bottom.
 */
export const WIZARD_PROVIDER_LIST: Array<{ id: string; label: string; description: string }> = [
  { id: "openai", label: "OpenAI", description: "GPT-4o, GPT-4, o1, o3" },
  { id: "anthropic", label: "Anthropic", description: "Claude 4, Claude 3.5 Sonnet" },
  { id: "gemini", label: "Google Gemini", description: "Gemini 2.5 Pro, Flash" },
  { id: "deepseek", label: "DeepSeek", description: "DeepSeek-V3, DeepSeek-R1" },
  { id: "groq", label: "Groq", description: "Ultra-fast inference (Llama, Mixtral)" },
  { id: "mistral", label: "Mistral AI", description: "Mistral Large, Codestral" },
  { id: "ollama", label: "Ollama (local)", description: "Run models locally, no API key needed" },
  { id: "lmstudio", label: "LM Studio (local)", description: "Local server, no API key needed" },
  { id: "custom", label: "Custom Provider", description: "Any OpenAI-compatible API (base URL + key)" },
];

// ---------------------------------------------------------------------------
// Config Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a provider entry by merging with known defaults.
 * If the provider id matches a known provider (openai, tokenrouter, etc.),
 * defaults are applied first, then the user's entry overrides them.
 */
export function resolveProviderEntry(id: string, entry: ProviderEntry): ProviderEntry {
  const defaults = PROVIDER_DEFAULTS[id] ?? {};
  return {
    type: entry.type ?? defaults.type ?? "openai-compatible",
    displayName: entry.displayName ?? defaults.displayName ?? id,
    baseUrl: entry.baseUrl ?? defaults.baseUrl,
    apiKey: entry.apiKey,
    orgId: entry.orgId,
    authMethod: entry.authMethod ?? defaults.authMethod ?? "bearer",
    authHeader: entry.authHeader,
    headers: { ...defaults.headers, ...entry.headers },
    timeoutMs: entry.timeoutMs ?? 60_000,
    retryPolicy: entry.retryPolicy ?? DEFAULT_RETRY_POLICY,
    capabilities: entry.capabilities,
    requireParameters: entry.requireParameters,
    models: entry.models,
    metadata: { ...defaults.metadata, ...entry.metadata },
    enabled: entry.enabled ?? true,
  };
}

/**
 * Load providers from environment variables.
 *
 * Format:
 *   PROVIDER_<ID>_API_KEY=value
 *   PROVIDER_<ID>_BASE_URL=value
 *   PROVIDER_<ID>_TYPE=value
 *   PROVIDER_<ID>_DISPLAY_NAME=value
 *
 * Also reads legacy OPENAI_API_KEY / GEMINI_API_KEY for backward compat.
 */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): ProvidersConfig {
  const providers: ProvidersConfig = {};

  // Legacy: OPENAI_API_KEY → openai provider
  if (env.OPENAI_API_KEY) {
    providers.openai = {
      type: "openai-compatible",
      apiKey: env.OPENAI_API_KEY,
      baseUrl: env.OPENAI_BASE_URL,
      orgId: env.OPENAI_ORG_ID,
      displayName: "OpenAI",
    };
  }

  // Legacy: GEMINI_API_KEY → gemini provider
  if (env.GEMINI_API_KEY) {
    providers.gemini = {
      type: "gemini",
      apiKey: env.GEMINI_API_KEY,
      displayName: "Google Gemini",
    };
  }

  // Generic: PROVIDER_<ID>_API_KEY → provider
  for (const [key, value] of Object.entries(env)) {
    const m = key.match(/^PROVIDER_(\w+?)_(API_KEY|BASE_URL|TYPE|DISPLAY_NAME|ORG_ID|ENABLED)$/);
    if (!m || !value) continue;
    const id = m[1]!.toLowerCase();
    const field = m[2]!;
    if (!providers[id]) providers[id] = { type: "openai-compatible" };
    switch (field) {
      case "API_KEY": providers[id]!.apiKey = value; break;
      case "BASE_URL": providers[id]!.baseUrl = value; break;
      case "TYPE": providers[id]!.type = value as ProviderEntry["type"]; break;
      case "DISPLAY_NAME": providers[id]!.displayName = value; break;
      case "ORG_ID": providers[id]!.orgId = value; break;
      case "ENABLED": providers[id]!.enabled = value !== "false" && value !== "0"; break;
    }
  }

  return providers;
}
