/**
 * ModelCapabilityRegistry — the single source of truth for model capabilities.
 *
 * Architecture:
 *
 *   Provider → Discover Models → Capability Detection → REGISTRY
 *     → Planner → Runtime → Prompt Builder → Tool Dispatcher
 *
 * Every consumer (Planner, Runtime, Prompt Builder, slash commands) queries
 * THIS registry. The provider never decides capabilities — it only supplies
 * raw metadata via discoverModels(). Detection is metadata-first, with a
 * universal naming heuristic as the last-resort fallback.
 *
 * Resolution order for get()/ensure():
 *   1. Manual override (registered via registerManual)
 *   2. Live profile (built from API metadata during refresh/ensure)
 *   3. Persistent cache (.mindi/cache/capabilities.json)
 *   4. Provider declaration bridge (legacy declareCapability)
 *   5. Universal heuristic (model name patterns)
 */

import type { IProvider } from "../core/types.js";
import type { CapabilityCache } from "./CapabilityCache.js";
import {
  buildProfile,
  profileFromDeclaration,
  profileKey,
} from "./CapabilityDetector.js";
import type {
  MetadataSource,
  ModelCapabilityProfile,
  RawModelMetadata,
  RefreshReport,
} from "./types.js";

/** Minimal provider accessor the registry needs (structural — no import cycle). */
export interface ProviderAccessor {
  get(id: string): IProvider | undefined;
  listProviders(): IProvider[];
}

export class ModelCapabilityRegistry {
  private readonly profiles = new Map<string, ModelCapabilityProfile>();
  private readonly manual = new Set<string>();
  private providers: ProviderAccessor | null = null;

  constructor(private readonly cache?: CapabilityCache) {
    // Seed from the persistent cache so reconnects are instantaneous.
    if (cache) {
      for (const profile of cache.values()) {
        this.profiles.set(profile.id, profile);
        if (profile.metadataSource === "manual") this.manual.add(profile.id);
      }
    }
  }

  // ---- Wiring ---------------------------------------------------------

  /** Attach the provider manager so the registry can discover models. */
  attachProviders(accessor: ProviderAccessor): void {
    this.providers = accessor;
  }

  /** Notify the registry that a provider was added/removed at runtime. */
  onProviderRemoved(providerId: string): void {
    for (const [key, profile] of this.profiles) {
      if (profile.provider === providerId) {
        this.profiles.delete(key);
        this.manual.delete(key);
        this.cache?.delete(key);
      }
    }
    this.cache?.save();
  }

  // ---- Lookup ---------------------------------------------------------

  /**
   * Synchronous lookup. Never throws. Returns the best-known profile:
   * manual → live → cached → heuristic (built on demand).
   */
  get(providerId: string, modelId: string): ModelCapabilityProfile {
    const key = profileKey(providerId, modelId);
    const existing = this.profiles.get(key);
    if (existing) return existing;

    // Nothing known yet — build a heuristic profile synchronously.
    const profile = buildProfile(providerId, modelId, undefined, "heuristic");
    this.profiles.set(key, profile);
    return profile;
  }

  /** True if a non-heuristic profile exists for this model. */
  has(providerId: string, modelId: string): boolean {
    const p = this.profiles.get(profileKey(providerId, modelId));
    return !!p && p.metadataSource !== "heuristic";
  }

  /**
   * Async ensure: like get(), but if the best-known profile is only a
   * heuristic guess, try to upgrade it from the provider (raw metadata →
   * declaration bridge). This is the method the Planner/Runtime call.
   */
  async ensure(providerId: string, modelId: string): Promise<ModelCapabilityProfile> {
    const key = profileKey(providerId, modelId);
    const existing = this.profiles.get(key);

    // Manual + API-sourced profiles are authoritative — never downgrade.
    if (existing && existing.metadataSource !== "heuristic") return existing;

    const provider = this.providers?.get(providerId);
    if (provider) {
      // Bridge: use the provider's declaration (itself metadata-derived for
      // modern providers) to upgrade the heuristic profile.
      try {
        const decl = await provider.declareCapability(modelId);
        const bridged = profileFromDeclaration(decl);
        // If the heuristic found MORE than the bridge (e.g. the provider's
        // declaration was chat-only but the model name says vision), prefer
        // the richer of the two for the multimodal flags.
        if (existing?.vision && !bridged.vision) {
          bridged.vision = true;
          bridged.supportsImages = true;
          if (!bridged.nativeCapabilities.includes("vision" as never)) {
            bridged.nativeCapabilities = [...bridged.nativeCapabilities, "vision" as never];
          }
        }
        this.store(bridged);
        return bridged;
      } catch {
        // Provider can't declare — fall through to heuristic.
      }
    }

    if (existing) return existing;
    const profile = buildProfile(providerId, modelId, undefined, "heuristic");
    this.profiles.set(key, profile);
    return profile;
  }

  // ---- Mutation -------------------------------------------------------

  /** Register a manual override (user config). Highest priority. */
  registerManual(profile: ModelCapabilityProfile): void {
    profile.metadataSource = "manual";
    profile.resolvedAt = Date.now();
    this.manual.add(profile.id);
    this.store(profile);
  }

  /** List every known profile. */
  list(): ModelCapabilityProfile[] {
    return [...this.profiles.values()];
  }

  /** List profiles for one provider. */
  listForProvider(providerId: string): ModelCapabilityProfile[] {
    return this.list().filter((p) => p.provider === providerId);
  }

  /** Invalidate one model (or everything) so the next lookup re-derives. */
  invalidate(providerId?: string, modelId?: string): void {
    if (providerId && modelId) {
      const key = profileKey(providerId, modelId);
      if (!this.manual.has(key)) this.profiles.delete(key);
    } else if (providerId) {
      for (const [key, p] of this.profiles) {
        if (p.provider === providerId && !this.manual.has(key)) this.profiles.delete(key);
      }
    } else {
      for (const key of [...this.profiles.keys()]) {
        if (!this.manual.has(key)) this.profiles.delete(key);
      }
    }
  }

  // ---- Refresh --------------------------------------------------------

  /**
   * Re-scan every attached provider, rebuild profiles from fresh metadata,
   * and merge with the persistent cache.
   *
   * Merge semantics:
   *   - New models       → added
   *   - Changed metadata → updated
   *   - Deleted models   → removed (unless manually overridden)
   *   - Unchanged        → preserved
   */
  async refresh(): Promise<RefreshReport> {
    const report: RefreshReport = {
      providersScanned: 0,
      modelsDiscovered: 0,
      capabilitiesUpdated: 0,
      cacheRefreshed: false,
      added: 0,
      removed: 0,
      preserved: 0,
      errors: {},
    };
    if (!this.providers) return report;

    const seen = new Set<string>();

    for (const provider of this.providers.listProviders()) {
      report.providersScanned++;
      let rawModels: RawModelMetadata[] | undefined;
      try {
        rawModels = await provider.discoverModels?.();
      } catch (err) {
        report.errors[provider.id] = err instanceof Error ? err.message : String(err);
        continue;
      }
      if (!rawModels) continue; // provider doesn't expose metadata discovery

      for (const raw of rawModels) {
        if (!raw.id) continue;
        report.modelsDiscovered++;
        const key = profileKey(provider.id, raw.id);
        seen.add(key);
        if (this.manual.has(key)) { report.preserved++; continue; }

        const prev = this.profiles.get(key);
        const next = buildProfile(provider.id, raw.id, raw, "api");

        if (!prev) {
          report.added++;
          this.store(next);
        } else if (profilesEqual(prev, next)) {
          report.preserved++;
          // Keep the existing (possibly cached) source label but bump nothing.
        } else {
          report.capabilitiesUpdated++;
          this.store(next);
        }
      }
    }

    // Remove models whose provider was scanned but no longer offers them.
    for (const [key, profile] of [...this.profiles]) {
      if (this.manual.has(key)) continue;
      const providerScanned = this.providers.get(profile.provider) !== undefined;
      const providerHasDiscovery = providerScanned && seen.size >= 0;
      if (providerHasDiscovery && !seen.has(key) && report.providersScanned > 0) {
        // Only remove if its provider actually returned a model list.
        const provider = this.providers.get(profile.provider);
        if (provider && typeof provider.discoverModels === "function") {
          this.profiles.delete(key);
          this.cache?.delete(key);
          report.removed++;
        }
      }
    }

    this.cache?.save();
    report.cacheRefreshed = !!this.cache;
    return report;
  }

  // ---- Internal -------------------------------------------------------

  private store(profile: ModelCapabilityProfile): void {
    this.profiles.set(profile.id, profile);
    this.cache?.set(profile);
    this.cache?.save();
  }
}

/** Shallow structural equality for change detection (ignores timestamps/source). */
function profilesEqual(a: ModelCapabilityProfile, b: ModelCapabilityProfile): boolean {
  return (
    a.chat === b.chat &&
    a.vision === b.vision &&
    a.imageGeneration === b.imageGeneration &&
    a.embeddings === b.embeddings &&
    a.audioInput === b.audioInput &&
    a.audioOutput === b.audioOutput &&
    a.reasoning === b.reasoning &&
    a.toolCalling === b.toolCalling &&
    a.functionCalling === b.functionCalling &&
    a.structuredOutput === b.structuredOutput &&
    a.streaming === b.streaming &&
    a.supportsFiles === b.supportsFiles &&
    a.supportsPDF === b.supportsPDF &&
    a.supportsImages === b.supportsImages &&
    a.supportsVideo === b.supportsVideo &&
    a.supportsThinking === b.supportsThinking &&
    a.supportsJSON === b.supportsJSON &&
    a.supportsComputerUse === b.supportsComputerUse &&
    a.supportsWebSearch === b.supportsWebSearch &&
    a.contextWindow === b.contextWindow &&
    a.maxOutputTokens === b.maxOutputTokens
  );
}

export type { MetadataSource, ModelCapabilityProfile, RawModelMetadata, RefreshReport };
