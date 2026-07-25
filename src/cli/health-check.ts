/**
 * Silent health check — runs on every launch.
 *
 * If the configured provider is invalid, credentials expired,
 * model disappeared, or connectivity fails, returns the specific
 * failure so the UI can open a repair flow instead of throwing errors.
 */

import { loadConfig, type OnboardingConfig } from "./onboarding-config.js";

export type HealthIssue =
  | { type: "no-config" }
  | { type: "not-onboarded" }
  | { type: "provider-unavailable"; providerId: string; error: string }
  | { type: "model-missing"; providerId: string; modelId: string }
  | { type: "auth-failed"; providerId: string; error: string }
  | { type: "connection-failed"; providerId: string; error: string };

export interface HealthCheckResult {
  ok: boolean;
  issue?: HealthIssue;
  config?: OnboardingConfig;
}

/**
 * Run a silent health check. Never throws — returns issues.
 * The UI uses this to decide whether to show onboarding/repair.
 */
export async function silentHealthCheck(): Promise<HealthCheckResult> {
  // 1. Check if config exists.
  const config = loadConfig();
  if (!config) {
    return { ok: false, issue: { type: "no-config" } };
  }

  // 2. Check if onboarding was completed.
  if (!config.onboarded) {
    return { ok: false, issue: { type: "not-onboarded" }, config };
  }

  // 3. Check if primary provider is configured.
  if (!config.primaryProvider || config.primaryProvider === "none") {
    return { ok: false, issue: { type: "not-onboarded" }, config };
  }

  // 4. Check if provider entry exists.
  const entry = config.providers[config.primaryProvider];
  if (!entry) {
    return { ok: false, issue: { type: "provider-unavailable", providerId: config.primaryProvider, error: "Provider not found in config" }, config };
  }

  // 5. Check if API key is present (unless auth is "none").
  if (!entry.apiKey && entry.authMethod !== "none") {
    return { ok: false, issue: { type: "auth-failed", providerId: config.primaryProvider, error: "No API key configured" }, config };
  }

  // 6. Try a live health check (timeout 5s).
  try {
    const { Runtime } = await import("../runtime/Runtime.js");
    const { toRuntimeConfig } = await import("./onboarding-config.js");
    const rt = new Runtime(toRuntimeConfig(config));
    const healthResults = await rt.health();
    const providerHealth = healthResults.find((h) => h.providerId === config.primaryProvider);

    if (!providerHealth || !providerHealth.ok) {
      const error = providerHealth?.error ?? "Unknown error";
      if (error.includes("401") || error.includes("403") || error.includes("auth")) {
        return { ok: false, issue: { type: "auth-failed", providerId: config.primaryProvider, error }, config };
      }
      return { ok: false, issue: { type: "connection-failed", providerId: config.primaryProvider, error }, config };
    }

    // 7. Check if model still exists (if we can list models).
    try {
      const provider = rt.providers.get(config.primaryProvider);
      if (provider) {
        const models = await provider.listModels();
        if (models.length > 0 && !models.some((m) => m.id === config.primaryModel)) {
          return { ok: false, issue: { type: "model-missing", providerId: config.primaryProvider, modelId: config.primaryModel }, config };
        }
      }
    } catch {
      // Model list failed — might be an opaque provider (like TokenRouter).
      // Don't block launch if we can't list models.
    }

    return { ok: true, config };
  } catch (err) {
    return { ok: false, issue: { type: "connection-failed", providerId: config.primaryProvider, error: err instanceof Error ? err.message : String(err) }, config };
  }
}
