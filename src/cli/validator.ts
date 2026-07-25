/**
 * API key validator + model discovery.
 *
 * Tests real auth against provider endpoints and fetches the list of
 * available models. Used by the onboarding wizard to validate keys
 * immediately and let the user pick from real models.
 */

import type { ProviderModel, ProviderHealth } from "../index.js";
import { OpenAIProvider } from "../index.js";
import { GeminiProvider } from "../index.js";

export interface ValidationResult {
  valid: boolean;
  provider: string;
  models?: ProviderModel[];
  error?: string;
}

/**
 * Validate an OpenAI-compatible API key by fetching /models.
 * Returns the list of available models if valid.
 */
export async function validateOpenAIKey(
  apiKey: string,
  baseUrl = "https://api.openai.com/v1",
): Promise<ValidationResult> {
  if (!apiKey || apiKey.length < 10) {
    return { valid: false, provider: "openai", error: "API key is too short" };
  }

  try {
    const provider = new OpenAIProvider({ apiKey, baseUrl });
    const models = await provider.listModels();
    return { valid: true, provider: "openai", models };
  } catch (err) {
    return {
      valid: false,
      provider: "openai",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Validate a Gemini API key by fetching /models.
 * Returns the list of available models if valid.
 */
export async function validateGeminiKey(apiKey: string): Promise<ValidationResult> {
  if (!apiKey || apiKey.length < 10) {
    return { valid: false, provider: "gemini", error: "API key is too short" };
  }

  try {
    const provider = new GeminiProvider({ apiKey });
    const models = await provider.listModels();
    return { valid: true, provider: "gemini", models };
  } catch (err) {
    return {
      valid: false,
      provider: "gemini",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Health-check a provider. */
export async function healthCheck(
  provider: string,
  apiKey: string,
  baseUrl?: string,
): Promise<ProviderHealth> {
  try {
    if (provider === "openai") {
      const p = new OpenAIProvider({ apiKey, baseUrl });
      return await p.health();
    } else if (provider === "gemini") {
      const p = new GeminiProvider({ apiKey });
      return await p.health();
    }
    return { providerId: provider, ok: false, error: "Unknown provider" };
  } catch (err) {
    return {
      providerId: provider,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Filter models to only those suitable as a primary reasoning engine.
 * Excludes embedding-only models, image generation models, etc.
 */
export function filterChatModels(
  models: ProviderModel[],
): ProviderModel[] {
  return models.filter((m) =>
    m.capabilities.includes("chat") ||
    // If no capabilities are declared, assume it's a chat model
    m.capabilities.length === 0
  );
}

/** Get a human-readable label for a model. */
export function modelLabel(model: ProviderModel): string {
  const caps = model.capabilities.length > 0
    ? ` [${model.capabilities.join(", ")}]`
    : "";
  const ctx = model.contextWindow
    ? ` (${model.contextWindow.toLocaleString()} ctx)`
    : "";
  return `${model.id}${caps}${ctx}`;
}
