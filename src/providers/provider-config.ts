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

/** Known provider type defaults (baseUrl, etc.) for common providers. */
export const PROVIDER_DEFAULTS: Record<string, Partial<ProviderEntry>> = {
  openai: { type: "openai-compatible", baseUrl: "https://api.openai.com/v1", displayName: "OpenAI" },
  tokenrouter: { type: "openai-compatible", baseUrl: "https://api.tokenrouter.com/v1", displayName: "TokenRouter" },
  openrouter: { type: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", displayName: "OpenRouter" },
  groq: { type: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", displayName: "Groq" },
  deepseek: { type: "openai-compatible", baseUrl: "https://api.deepseek.com/v1", displayName: "DeepSeek" },
  together: { type: "openai-compatible", baseUrl: "https://api.together.xyz/v1", displayName: "Together AI" },
  fireworks: { type: "openai-compatible", baseUrl: "https://api.fireworks.ai/inference/v1", displayName: "Fireworks AI" },
  ollama: { type: "openai-compatible", baseUrl: "http://localhost:11434/v1", displayName: "Ollama", authMethod: "none" },
  lmstudio: { type: "openai-compatible", baseUrl: "http://localhost:1234/v1", displayName: "LM Studio", authMethod: "none" },
  azure: { type: "openai-compatible", displayName: "Azure OpenAI" },
  gemini: { type: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", displayName: "Google Gemini" },
};

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
