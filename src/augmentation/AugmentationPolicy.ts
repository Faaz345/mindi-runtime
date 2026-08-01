/**
 * AugmentationPolicy — user consent management for capability augmentation.
 *
 * Generalized from VisionPolicy. Manages per-capability preferences:
 *   - Whether the user allows augmentation for each capability type
 *   - Which provider/model to use for augmentation (stored after first use)
 *   - Reset capability (via /augmentation reset)
 *
 * Persistence: backed by a PreferenceStore (ProjectMemoryManager).
 * The user is NEVER asked twice for the same capability unless they reset.
 *
 * First-time UX (shown once per capability gap):
 *   "MINDI can augment kimi-k3 with Vision using claude-sonnet-4.
 *    Allow automatic augmentation? [Yes] [No] [Remember my choice]"
 */

import type { CapabilityType } from "../core/types.js";
import type { IAugmentationPolicy } from "./types.js";

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const PREF_PREFIX = "augmentation";

function allowedKey(cap: CapabilityType): string {
  return `${PREF_PREFIX}.${cap}.allowed`;
}

function viaKey(cap: CapabilityType): string {
  return `${PREF_PREFIX}.${cap}.via`;
}

// ---------------------------------------------------------------------------
// PreferenceStore interface (same as VisionPolicy — implemented by ProjectMemory)
// ---------------------------------------------------------------------------

export interface PreferenceStore {
  getPreference<T = unknown>(key: string, fallback?: T): T | undefined;
  setPreference(key: string, value: unknown): void;
}

// ---------------------------------------------------------------------------
// AugmentationPolicy
// ---------------------------------------------------------------------------

export class AugmentationPolicy implements IAugmentationPolicy {
  constructor(private readonly store: PreferenceStore) {}

  /**
   * Check if augmentation is allowed for a capability.
   * Returns: true (allowed), false (denied), null (not yet asked).
   */
  isAllowed(capability: CapabilityType): boolean | null {
    const val = this.store.getPreference<boolean | null>(allowedKey(capability), null);
    return val ?? null;
  }

  /**
   * Record the user's choice for a capability.
   */
  setPreference(capability: CapabilityType, allowed: boolean, via?: string): void {
    this.store.setPreference(allowedKey(capability), allowed);
    if (via) {
      this.store.setPreference(viaKey(capability), via);
    }
  }

  /**
   * Get the stored augmentation provider/model for a capability.
   */
  getAugmentationVia(capability: CapabilityType): string | undefined {
    return this.store.getPreference<string>(viaKey(capability));
  }

  /**
   * Reset preferences. If capability is specified, reset only that one.
   * Otherwise reset ALL augmentation preferences.
   */
  reset(capability?: CapabilityType): void {
    if (capability) {
      this.store.setPreference(allowedKey(capability), null);
      this.store.setPreference(viaKey(capability), undefined);
    } else {
      // Reset all known capabilities.
      const allCaps: CapabilityType[] = [
        "vision", "ocr", "web_search", "browser", "filesystem",
        "git", "terminal", "image_generation", "audio", "embeddings",
        "database", "chat",
      ];
      for (const cap of allCaps) {
        this.store.setPreference(allowedKey(cap), null);
        this.store.setPreference(viaKey(cap), undefined);
      }
    }
  }

  /**
   * Get a summary of all stored preferences (for /augmentation status).
   */
  getStatus(): Array<{ capability: CapabilityType; allowed: boolean | null; via?: string }> {
    const allCaps: CapabilityType[] = [
      "vision", "ocr", "web_search", "browser", "filesystem",
      "git", "terminal", "image_generation", "audio", "embeddings",
      "database", "chat",
    ];
    return allCaps.map((cap) => ({
      capability: cap,
      allowed: this.isAllowed(cap),
      via: this.getAugmentationVia(cap),
    }));
  }
}
