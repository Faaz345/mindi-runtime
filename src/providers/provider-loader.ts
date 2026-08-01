/**
 * Provider auto-loader.
 *
 * Reads the resolved ProvidersConfig and instantiates the correct provider
 * adapter for each entry. The runtime calls this during boot — no hardcoding.
 *
 * Adding a new provider = add a config entry. No source code changes.
 *
 * Supported types:
 *   - "openai-compatible" → OpenAIProvider (covers OpenAI, TokenRouter, Groq, etc.)
 *   - "gemini" → GeminiProvider
 *   - "custom" → skip (must be registered programmatically)
 */

import type { ProvidersConfig, ProviderEntry } from "./provider-config.js";
import { resolveProviderEntry } from "./provider-config.js";
import type { IProvider } from "../core/types.js";
import { OpenAIProvider } from "./openai/OpenAIProvider.js";
import { GeminiProvider } from "./gemini/GeminiProvider.js";
import { TokenRouterProvider } from "./tokenrouter/TokenRouterProvider.js";

/**
 * Load providers from config and return instantiated IProvider instances.
 * Only enabled providers with an apiKey (or authMethod "none") are loaded.
 */
export function loadProvidersFromConfig(
  config: ProvidersConfig,
  opts?: { primaryModel?: string },
): IProvider[] {
  const providers: IProvider[] = [];

  for (const [id, rawEntry] of Object.entries(config)) {
    const entry = resolveProviderEntry(id, rawEntry);
    if (!entry.enabled) continue;

    // Skip if no API key and auth is required.
    if (!entry.apiKey && entry.authMethod !== "none") continue;

    try {
      const provider = instantiateProvider(id, entry, opts);
      if (provider) providers.push(provider);
    } catch (err) {
      // Don't crash if one provider fails — log and continue.
      console.error(`[ProviderLoader] Failed to load provider "${id}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return providers;
}

/** Instantiate a provider based on its type. */
function instantiateProvider(id: string, entry: ProviderEntry, opts?: { primaryModel?: string }): IProvider | null {
  switch (entry.type) {
    case "openai-compatible":
      // Use TokenRouterProvider for tokenrouter id, OpenAIProvider for others.
      if (id === "tokenrouter") {
        return new TokenRouterProvider({
          apiKey: entry.apiKey!,
          baseUrl: entry.baseUrl,
          displayName: entry.displayName,
          headers: entry.headers,
          timeoutMs: entry.timeoutMs,
          models: entry.models,
          primaryModel: opts?.primaryModel,
        });
      }
      return new OpenAIProvider({
        apiKey: entry.apiKey ?? "",
        baseUrl: entry.baseUrl,
        orgId: entry.orgId,
        models: entry.models,
        displayName: entry.displayName ?? id,
        requireParameters: entry.requireParameters,
      });

    case "gemini":
      return new GeminiProvider({
        apiKey: entry.apiKey!,
        models: entry.models,
      });

    case "custom":
      // Custom providers must be registered programmatically.
      return null;

    default:
      console.warn(`[ProviderLoader] Unknown provider type "${entry.type}" for "${id}"`);
      return null;
  }
}
