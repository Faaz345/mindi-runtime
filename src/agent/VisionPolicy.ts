/**
 * VisionPolicy — deterministic vision provider selection.
 *
 * Rules (in priority order):
 *   1. If the current model has native vision → ALWAYS use it. Never switch.
 *   2. If the current model lacks vision AND images are present:
 *      a. Check stored user preference (per-workspace via ProjectMemory).
 *      b. If preference = "allowed" → use the stored fallback model.
 *      c. If preference = "denied"  → skip vision, warn user.
 *      d. If no preference exists   → return "ask" so the UI can prompt once.
 *   3. Fallback resolution is DETERMINISTIC: candidates are sorted by
 *      (providerId, modelId) alphabetically. The first vision-capable model
 *      that isn't the primary is always chosen. No scoring heuristics.
 *   4. The preference is remembered per workspace. The user is NEVER asked
 *      again unless they run `/vision reset`.
 *   5. When the next request does NOT require vision fallback, the primary
 *      provider/model is used automatically (no restore needed — we never
 *      actually switch the session's provider).
 *
 * Architecture:
 *   Terminal calls runtime.getVisionDecision() BEFORE streaming.
 *   If "ask" → Terminal prompts user → runtime.setVisionPreference().
 *   Then runtime.request() proceeds with the stored decision.
 *   During the stream, a `vision` StreamEvent is emitted for the Timeline.
 */

import type { CapabilityType, IProvider, ProviderModel } from "../core/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VisionAction = "native" | "fallback" | "ask" | "denied" | "unavailable";

export interface VisionDecision {
  action: VisionAction;
  /** Which provider will handle vision (only for "native" or "fallback"). */
  providerId?: string;
  /** Which model will handle vision (only for "native" or "fallback"). */
  modelId?: string;
  /** Human-readable explanation (shown in Timeline + logs). */
  reason: string;
  /** Available fallback candidates (only for "ask"). */
  candidates?: Array<{ providerId: string; modelId: string }>;
}

export interface VisionPreference {
  /** Whether the user allows fallback to another model for vision. */
  fallbackAllowed: boolean | null; // null = not yet decided
  /** The specific provider to use for fallback (stored after first use). */
  fallbackProviderId?: string;
  /** The specific model to use for fallback (stored after first use). */
  fallbackModelId?: string;
}

// ---------------------------------------------------------------------------
// Preference storage keys (in ProjectMemory)
// ---------------------------------------------------------------------------

const PREF_ALLOWED = "vision.fallbackAllowed";
const PREF_PROVIDER = "vision.fallbackProviderId";
const PREF_MODEL = "vision.fallbackModelId";

// ---------------------------------------------------------------------------
// VisionPolicy
// ---------------------------------------------------------------------------

export class VisionPolicy {
  /**
   * Read the stored preference from a preference store.
   * The store is any object with getPreference/setPreference (ProjectMemoryManager).
   */
  static readPreference(store: PreferenceStore): VisionPreference {
    return {
      fallbackAllowed: store.getPreference<boolean | null>(PREF_ALLOWED, null) ?? null,
      fallbackProviderId: store.getPreference<string>(PREF_PROVIDER),
      fallbackModelId: store.getPreference<string>(PREF_MODEL),
    };
  }

  /**
   * Persist the user's vision preference.
   */
  static writePreference(store: PreferenceStore, pref: VisionPreference): void {
    store.setPreference(PREF_ALLOWED, pref.fallbackAllowed);
    if (pref.fallbackProviderId) store.setPreference(PREF_PROVIDER, pref.fallbackProviderId);
    if (pref.fallbackModelId) store.setPreference(PREF_MODEL, pref.fallbackModelId);
  }

  /**
   * Reset the stored preference (via /vision reset).
   */
  static resetPreference(store: PreferenceStore): void {
    store.setPreference(PREF_ALLOWED, null);
    store.setPreference(PREF_PROVIDER, undefined);
    store.setPreference(PREF_MODEL, undefined);
  }

  /**
   * Make a deterministic vision decision.
   *
   * @param hasImages       Whether the current request contains images
   * @param modelHasVision  Whether the primary model has native vision
   * @param primaryProviderId  The user's current provider
   * @param primaryModelId     The user's current model
   * @param preference      The stored user preference
   * @param candidates      Available fallback candidates (pre-resolved)
   */
  static decide(
    hasImages: boolean,
    modelHasVision: boolean,
    primaryProviderId: string,
    primaryModelId: string,
    preference: VisionPreference,
    candidates: Array<{ providerId: string; modelId: string }>,
  ): VisionDecision {
    // Rule 1: Native vision — always prefer, never switch.
    if (modelHasVision) {
      return {
        action: "native",
        providerId: primaryProviderId,
        modelId: primaryModelId,
        reason: `Using ${primaryProviderId}/${primaryModelId} native vision`,
      };
    }

    // No images in this request — no vision needed at all.
    if (!hasImages) {
      return {
        action: "native",
        providerId: primaryProviderId,
        modelId: primaryModelId,
        reason: "No images in request — vision not needed",
      };
    }

    // Rule 2: Model lacks vision + images present.
    // 2c: User explicitly denied fallback.
    if (preference.fallbackAllowed === false) {
      return {
        action: "denied",
        reason: `Vision fallback disabled by user preference. ${primaryModelId} cannot process images. Run /vision allow to enable fallback.`,
      };
    }

    // No candidates available anywhere.
    if (candidates.length === 0) {
      return {
        action: "unavailable",
        reason: `${primaryModelId} lacks vision and no alternate vision-capable model is configured. Add a provider with vision support.`,
      };
    }

    // 2b: User previously allowed + we have a stored fallback.
    if (preference.fallbackAllowed === true && preference.fallbackProviderId && preference.fallbackModelId) {
      // Verify the stored fallback is still in the candidate list.
      const stillAvailable = candidates.some(
        (c) => c.providerId === preference.fallbackProviderId && c.modelId === preference.fallbackModelId,
      );
      if (stillAvailable) {
        return {
          action: "fallback",
          providerId: preference.fallbackProviderId,
          modelId: preference.fallbackModelId,
          reason: `Using saved vision fallback: ${preference.fallbackProviderId}/${preference.fallbackModelId}`,
        };
      }
      // Stored fallback no longer available — fall through to pick a new one.
    }

    // 2b (continued): User allowed but no specific model stored yet — pick deterministically.
    if (preference.fallbackAllowed === true) {
      const best = candidates[0]!;
      return {
        action: "fallback",
        providerId: best.providerId,
        modelId: best.modelId,
        reason: `Using vision fallback: ${best.providerId}/${best.modelId} (deterministic selection)`,
      };
    }

    // 2d: No preference stored — ask the user.
    return {
      action: "ask",
      reason: `${primaryModelId} cannot process images. A fallback vision model is available. Allow fallback?`,
      candidates,
    };
  }

  /**
   * Resolve fallback candidates DETERMINISTICALLY.
   *
   * Sorting: alphabetical by (providerId, modelId). This guarantees the
   * same result every time given the same provider/model set — no scoring
   * heuristics, no randomness, no route-preference bias.
   *
   * Excludes the primary model (it already proved it can't handle vision).
   */
  static resolveCandidates(
    providers: IProvider[],
    primaryProviderId: string,
    primaryModelId: string,
    modelLists: Map<string, ProviderModel[]>,
  ): Array<{ providerId: string; modelId: string }> {
    const candidates: Array<{ providerId: string; modelId: string }> = [];

    for (const p of providers) {
      const models = modelLists.get(p.id) ?? [];
      for (const m of models) {
        if (!m.capabilities.includes("vision" as CapabilityType)) continue;
        if (p.id === primaryProviderId && m.id === primaryModelId) continue;
        candidates.push({ providerId: p.id, modelId: m.id });
      }
    }

    // Deterministic sort: alphabetical by provider, then model.
    candidates.sort((a, b) => {
      const pc = a.providerId.localeCompare(b.providerId);
      if (pc !== 0) return pc;
      return a.modelId.localeCompare(b.modelId);
    });

    return candidates;
  }
}

// ---------------------------------------------------------------------------
// PreferenceStore interface (implemented by ProjectMemoryManager)
// ---------------------------------------------------------------------------

export interface PreferenceStore {
  getPreference<T = unknown>(key: string, fallback?: T): T | undefined;
  setPreference(key: string, value: unknown): void;
}
