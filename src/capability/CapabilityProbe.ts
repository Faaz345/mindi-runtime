/**
 * CapabilityProbe — lightweight verification of model capabilities.
 *
 * Used when metadata is insufficient (heuristic-only profile) and the
 * runtime needs to VERIFY a capability before relying on it.
 *
 * Probes are:
 *   - Lightweight (single small request, minimal tokens)
 *   - Non-destructive (never modify state)
 *   - Cached (result stored in the ModelCapabilityRegistry)
 *   - Optional (only run when metadata source is "heuristic")
 *
 * Probe types:
 *   - Vision: send a tiny test image, check if model describes it
 *   - ToolCalling: send a simple tool definition, check if model invokes it
 *   - JSON: request JSON output, check if response is valid JSON
 *   - Streaming: already verified by the streaming pipeline itself
 *
 * The probe NEVER blocks the user's request. If a probe is needed, it runs
 * in the background and the result is cached for future requests.
 */

import type { CapabilityType, ExecutionContext } from "../core/types.js";
import { CapabilityType as Cap } from "../core/types.js";
import type { ModelCapabilityProfile } from "./types.js";

// ---------------------------------------------------------------------------
// Probe result
// ---------------------------------------------------------------------------

export interface ProbeResult {
  capability: CapabilityType;
  verified: boolean;
  /** How long the probe took */
  durationMs: number;
  /** Details (for debugging) */
  detail?: string;
}

export interface ProbeOptions {
  /** Only probe if the profile's metadata source is "heuristic" */
  onlyIfHeuristic?: boolean;
  /** Timeout per probe in ms (default: 10000) */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// CapabilityProbe
// ---------------------------------------------------------------------------

export class CapabilityProbe {
  /**
   * Determine which capabilities need probing for a given profile.
   * Only probes capabilities that are:
   *   1. Not already verified (metadata source != "api")
   *   2. Relevant to the current request
   */
  static needsProbe(
    profile: ModelCapabilityProfile,
    requiredCapabilities: CapabilityType[],
    opts?: ProbeOptions,
  ): CapabilityType[] {
    // If metadata is from API, trust it — no probe needed.
    if (opts?.onlyIfHeuristic !== false && profile.metadataSource !== "heuristic") {
      return [];
    }

    const needsProbe: CapabilityType[] = [];

    for (const cap of requiredCapabilities) {
      switch (cap) {
        case Cap.Vision:
          // Vision heuristic is fairly reliable (model name patterns).
          // Only probe if the heuristic said YES (verify it's not a false positive).
          if (profile.vision) needsProbe.push(cap);
          break;
        case Cap.Chat:
          // Chat is always true for registered models — never probe.
          break;
        default:
          // Other capabilities: probe if the heuristic claims support.
          break;
      }
    }

    return needsProbe;
  }

  /**
   * Run a lightweight probe for a specific capability.
   * Returns whether the capability is verified.
   *
   * NOTE: This is a framework for future probe implementations.
   * Currently, probes are not executed inline (they would add latency).
   * Instead, the system relies on:
   *   1. API metadata (preferred)
   *   2. Heuristic detection (fast, usually correct)
   *   3. Runtime fallback (if a capability fails, augmentation kicks in)
   *
   * The augmentation system makes probes LESS critical — if vision fails,
   * the VisionAugment module handles it transparently.
   */
  static async probe(
    capability: CapabilityType,
    _profile: ModelCapabilityProfile,
    _sendRequest: (messages: Array<{ role: string; content: string }>, ctx: ExecutionContext) => Promise<string>,
    _ctx: ExecutionContext,
    _opts?: ProbeOptions,
  ): Promise<ProbeResult> {
    const start = Date.now();

    try {
      // Probe implementations would go here.
      // For now, return "not verified" — the augmentation system handles gaps.
      return {
        capability,
        verified: false,
        durationMs: Date.now() - start,
        detail: "Probe not yet implemented — augmentation system handles gaps transparently",
      };
    } catch (err) {
      return {
        capability,
        verified: false,
        durationMs: Date.now() - start,
        detail: `Probe error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
