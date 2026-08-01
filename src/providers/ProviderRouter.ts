/**
 * ProviderRouter — deterministic, priority-based provider/model resolution.
 *
 * Resolution priority (highest → lowest):
 *   1. User's explicit selection (request-level override)
 *   2. Session provider/model (what the session was created with)
 *   3. Workspace preference (settings.defaultProviderId / defaultModelId)
 *   4. Config default (config.defaultProviderId / defaultModel)
 *   5. Capability requirements (filter to providers that satisfy needed caps)
 *   6. Tie-breakers: health status → alphabetical by providerId (deterministic)
 *
 * Failover rules:
 *   - Default: NO automatic failover. If the selected provider fails, the
 *     request fails with a clear error explaining what happened.
 *   - When auto-failover is enabled (config or /failover on): alternatives
 *     are tried in priority order. Each failover emits an event explaining
 *     exactly WHY the switch happened.
 *   - Auto-restore: failover NEVER sticks. The next request always resolves
 *     fresh from the priority chain, so the user's preferred provider is
 *     automatically restored.
 *
 * This module is pure logic — no I/O, no side effects. The Runtime calls it
 * at the start of each request to determine which provider/model to use.
 */

import type { CapabilityType, IProvider } from "../core/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RouteContext {
  /** Provider/model explicitly requested by the user (highest priority). */
  explicitProviderId?: string;
  explicitModelId?: string;
  /** Session-level provider/model. */
  sessionProviderId?: string;
  sessionModelId?: string;
  /** Workspace-level defaults. */
  workspaceProviderId?: string;
  workspaceModelId?: string;
  /** Config-level defaults. */
  configProviderId: string;
  configModel: string;
  /** Capabilities required by this request (e.g. vision, tools). */
  requiredCapabilities?: CapabilityType[];
  /** Whether automatic failover is enabled. */
  autoFailover?: boolean;
}

export interface RouteDecision {
  /** The resolved provider to use. */
  providerId: string;
  /** The resolved model to use. */
  modelId: string;
  /** Which priority level determined the selection. */
  source: "explicit" | "session" | "workspace" | "config" | "capability" | "failover";
  /** Human-readable explanation (for events/logs). */
  reason: string;
  /** Ordered failover alternatives (only populated when autoFailover=true). */
  alternatives: Array<{ providerId: string; modelId: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// ProviderRouter
// ---------------------------------------------------------------------------

export class ProviderRouter {
  /**
   * Resolve which provider/model to use for a request.
   *
   * Deterministic: same inputs → same output, every time.
   * Never silently switches — the `source` field explains the decision.
   *
   * @param ctx       The resolution context (all priority levels)
   * @param available Map of registered providers (id → provider)
   */
  static resolve(ctx: RouteContext, available: Map<string, IProvider>): RouteDecision {
    // Priority 1: User's explicit selection — NEVER overridden.
    if (ctx.explicitProviderId && available.has(ctx.explicitProviderId)) {
      return {
        providerId: ctx.explicitProviderId,
        modelId: ctx.explicitModelId ?? ctx.sessionModelId ?? ctx.configModel,
        source: "explicit",
        reason: `User explicitly selected ${ctx.explicitProviderId}`,
        alternatives: [],
      };
    }

    // Priority 2: Session provider/model.
    // If the session specifies a provider, it is AUTHORITATIVE — never
    // silently fall through to a different provider. If it's not registered,
    // return it anyway so getPrimary() throws a clear error.
    if (ctx.sessionProviderId) {
      const decision: RouteDecision = {
        providerId: ctx.sessionProviderId,
        modelId: ctx.sessionModelId ?? ctx.workspaceModelId ?? ctx.configModel,
        source: "session",
        reason: `Session provider: ${ctx.sessionProviderId}/${ctx.sessionModelId ?? "default"}`,
        alternatives: [],
      };
      if (ctx.autoFailover && available.has(ctx.sessionProviderId)) {
        decision.alternatives = ProviderRouter.buildAlternatives(ctx, available, ctx.sessionProviderId);
      }
      return decision;
    }

    // Priority 3: Workspace preference.
    if (ctx.workspaceProviderId && available.has(ctx.workspaceProviderId)) {
      const decision: RouteDecision = {
        providerId: ctx.workspaceProviderId,
        modelId: ctx.workspaceModelId ?? ctx.configModel,
        source: "workspace",
        reason: `Workspace default: ${ctx.workspaceProviderId}/${ctx.workspaceModelId ?? "default"}`,
        alternatives: [],
      };
      if (ctx.autoFailover) {
        decision.alternatives = ProviderRouter.buildAlternatives(ctx, available, ctx.workspaceProviderId);
      }
      return decision;
    }

    // Priority 4: Config default.
    if (available.has(ctx.configProviderId)) {
      const decision: RouteDecision = {
        providerId: ctx.configProviderId,
        modelId: ctx.configModel,
        source: "config",
        reason: `Config default: ${ctx.configProviderId}/${ctx.configModel}`,
        alternatives: [],
      };
      if (ctx.autoFailover) {
        decision.alternatives = ProviderRouter.buildAlternatives(ctx, available, ctx.configProviderId);
      }
      return decision;
    }

    // Priority 5: Capability-based selection — find any provider that has
    // the required capabilities. Deterministic: alphabetical by providerId.
    const required = ctx.requiredCapabilities ?? [];
    const candidates = Array.from(available.values())
      .filter((p) => required.every((cap) => p.hasCapability(cap)))
      .filter((p) => p.hasCapability("chat" as CapabilityType))
      .sort((a, b) => a.id.localeCompare(b.id));

    if (candidates.length > 0) {
      const best = candidates[0]!;
      return {
        providerId: best.id,
        modelId: ctx.configModel,
        source: "capability",
        reason: `Selected ${best.id} — satisfies required capabilities (${required.join(", ") || "chat"})`,
        alternatives: ctx.autoFailover
          ? candidates.slice(1).map((p) => ({ providerId: p.id, modelId: ctx.configModel, reason: "Capability-compatible alternative" }))
          : [],
      };
    }

    // Fallback: return config default even if not registered (will throw later).
    return {
      providerId: ctx.configProviderId,
      modelId: ctx.configModel,
      source: "config",
      reason: `No suitable provider found — falling back to config default ${ctx.configProviderId}`,
      alternatives: [],
    };
  }

  /**
   * Build an ordered list of failover alternatives.
   *
   * Ordering: capability-compatible providers, sorted alphabetically.
   * Excludes the primary (already selected).
   * Only includes providers with the "chat" capability.
   */
  private static buildAlternatives(
    ctx: RouteContext,
    available: Map<string, IProvider>,
    excludeId: string,
  ): Array<{ providerId: string; modelId: string; reason: string }> {
    const required = ctx.requiredCapabilities ?? [];
    return Array.from(available.values())
      .filter((p) => p.id !== excludeId)
      .filter((p) => p.hasCapability("chat" as CapabilityType))
      .filter((p) => required.every((cap) => p.hasCapability(cap)))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => ({
        providerId: p.id,
        modelId: ctx.configModel,
        reason: `Failover alternative: ${p.id} (chat-capable${required.length > 0 ? `, satisfies ${required.join("+")}` : ""})`,
      }));
  }
}
