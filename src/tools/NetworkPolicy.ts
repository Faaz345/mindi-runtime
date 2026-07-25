/**
 * Network Policy System
 *
 * Fine-grained network access control:
 *   - offline: no network at all
 *   - provider-only: only AI provider endpoints (API calls)
 *   - trusted-domains: allow specific domains (GitHub, npm, docs, etc.)
 *   - full: unrestricted internet
 *
 * This replaces the simple boolean allowNetwork flag.
 */

export type NetworkPolicy = "offline" | "provider-only" | "trusted-domains" | "full";

export interface TrustedDomain {
  pattern: string;
  label: string;
}

const DEFAULT_TRUSTED_DOMAINS: TrustedDomain[] = [
  { pattern: "github.com", label: "GitHub" },
  { pattern: "api.github.com", label: "GitHub API" },
  { pattern: "registry.npmjs.org", label: "npm registry" },
  { pattern: "api.openai.com", label: "OpenAI API" },
  { pattern: "generativelanguage.googleapis.com", label: "Google Gemini API" },
  { pattern: "api.tokenrouter.com", label: "TokenRouter API" },
];

export interface NetworkPolicyConfig {
  policy: NetworkPolicy;
  trustedDomains: TrustedDomain[];
  /** Provider endpoints that are always allowed (derived from config) */
  providerEndpoints: string[];
}

export function createNetworkPolicy(
  policy: NetworkPolicy,
  trustedDomains?: TrustedDomain[],
  providerEndpoints?: string[],
): NetworkPolicyConfig {
  return {
    policy,
    trustedDomains: trustedDomains ?? DEFAULT_TRUSTED_DOMAINS,
    providerEndpoints: providerEndpoints ?? [],
  };
}

/**
 * Check if a URL is allowed under the given network policy.
 * Returns a structured result with reason.
 */
export function checkNetworkAccess(
  url: string,
  config: NetworkPolicyConfig,
): { allowed: boolean; reason: string } {
  switch (config.policy) {
    case "offline":
      return { allowed: false, reason: "Network access is disabled (offline mode)" };

    case "provider-only": {
      // Allow only provider endpoints.
      for (const endpoint of config.providerEndpoints) {
        if (url.includes(endpoint)) {
          return { allowed: true, reason: "Allowed: provider endpoint" };
        }
      }
      return {
        allowed: false,
        reason: `Network access restricted to provider endpoints only. URL "${url}" is not a provider endpoint.`,
      };
    }

    case "trusted-domains": {
      for (const td of config.trustedDomains) {
        if (url.includes(td.pattern)) {
          return { allowed: true, reason: `Allowed: trusted domain (${td.label})` };
        }
      }
      // Also allow provider endpoints.
      for (const endpoint of config.providerEndpoints) {
        if (url.includes(endpoint)) {
          return { allowed: true, reason: "Allowed: provider endpoint" };
        }
      }
      return {
        allowed: false,
        reason: `Network access restricted to trusted domains. URL "${url}" is not on the trusted list.`,
      };
    }

    case "full":
      return { allowed: true, reason: "Full internet access enabled" };

    default:
      return { allowed: false, reason: "Unknown network policy" };
  }
}

/**
 * Convert the old boolean allowNetwork to a NetworkPolicy.
 */
export function booleanToPolicy(allowNetwork: boolean): NetworkPolicy {
  return allowNetwork ? "full" : "offline";
}

/**
 * Format the network policy for display.
 */
export function formatNetworkPolicy(config: NetworkPolicyConfig): string {
  switch (config.policy) {
    case "offline":
      return "Offline — no network access";
    case "provider-only":
      return `Provider-only — AI endpoints only (${config.providerEndpoints.length} endpoints)`;
    case "trusted-domains":
      return `Trusted domains — ${config.trustedDomains.length} domains allowed`;
    case "full":
      return "Full internet — unrestricted";
  }
}
