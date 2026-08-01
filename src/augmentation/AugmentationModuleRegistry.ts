/**
 * AugmentationModuleRegistry — extensible registry of augmentation modules.
 *
 * Each module handles ONE capability type. Adding a new capability to the
 * runtime requires only registering a new module here — no changes to the
 * Router, Planner, Provider, or Prompt Builder.
 *
 * Modules are ordered by cost estimate (cheapest first) when multiple
 * modules can satisfy the same capability, enabling cost-aware routing
 * (e.g. HTTP fetch before git clone).
 */

import type { CapabilityType } from "../core/types.js";
import type { AugmentationModule, RequestAnalysis } from "./types.js";

export class AugmentationModuleRegistry {
  private readonly modules = new Map<string, AugmentationModule>();
  private readonly byCapability = new Map<CapabilityType, AugmentationModule[]>();

  /**
   * Register an augmentation module. Throws if the id is already taken.
   * Modules are automatically indexed by capability for fast lookup.
   */
  register(module: AugmentationModule): this {
    if (this.modules.has(module.id)) {
      throw new Error(`Augmentation module already registered: ${module.id}`);
    }
    this.modules.set(module.id, module);
    const list = this.byCapability.get(module.capability) ?? [];
    list.push(module);
    // Keep sorted by base cost (static estimate with empty input).
    list.sort((a, b) => a.costEstimate(EMPTY_ANALYSIS) - b.costEstimate(EMPTY_ANALYSIS));
    this.byCapability.set(module.capability, list);
    return this;
  }

  /**
   * Unregister a module by id. Returns true if it was found and removed.
   */
  unregister(id: string): boolean {
    const module = this.modules.get(id);
    if (!module) return false;
    this.modules.delete(id);
    const list = this.byCapability.get(module.capability);
    if (list) {
      const idx = list.indexOf(module);
      if (idx >= 0) list.splice(idx, 1);
      if (list.length === 0) this.byCapability.delete(module.capability);
    }
    return true;
  }

  /**
   * Get a module by its id.
   */
  get(id: string): AugmentationModule | undefined {
    return this.modules.get(id);
  }

  /**
   * Get all modules registered for a capability, ordered by cost (cheapest first).
   */
  getByCapability(capability: CapabilityType): AugmentationModule[] {
    return this.byCapability.get(capability) ?? [];
  }

  /**
   * Run detection across ALL registered modules. Returns the modules whose
   * detect() returned true, ordered by cost estimate (cheapest first).
   *
   * This is the primary entry point used by the CapabilityAugmentationRouter
   * to determine which augmentations to execute for a given request.
   */
  detectAll(input: RequestAnalysis): AugmentationModule[] {
    const detected: AugmentationModule[] = [];
    for (const module of this.modules.values()) {
      try {
        if (module.detect(input)) {
          detected.push(module);
        }
      } catch {
        // A module's detect() should never throw, but be defensive.
      }
    }
    // Sort by cost estimate for this specific input (cheapest first).
    detected.sort((a, b) => a.costEstimate(input) - b.costEstimate(input));
    return detected;
  }

  /**
   * Detect modules for a specific capability only.
   * Used when the Router knows a capability is needed and wants to find
   * the cheapest module to handle it.
   */
  detectForCapability(capability: CapabilityType, input: RequestAnalysis): AugmentationModule[] {
    const candidates = this.getByCapability(capability);
    return candidates
      .filter((m) => {
        try { return m.detect(input); } catch { return false; }
      })
      .sort((a, b) => a.costEstimate(input) - b.costEstimate(input));
  }

  /**
   * List all registered modules (for debugging / health display).
   */
  listAll(): AugmentationModule[] {
    return [...this.modules.values()];
  }

  /**
   * List all registered capability types that have at least one module.
   */
  registeredCapabilities(): CapabilityType[] {
    return [...this.byCapability.keys()];
  }

  /**
   * True if at least one module is registered for the given capability.
   */
  has(capability: CapabilityType): boolean {
    const list = this.byCapability.get(capability);
    return !!list && list.length > 0;
  }

  /** Number of registered modules. */
  get size(): number {
    return this.modules.size;
  }
}

/** Minimal empty analysis for static cost sorting. */
const EMPTY_ANALYSIS: RequestAnalysis = {
  text: "",
  attachments: [],
  urls: [],
  filePaths: [],
  repositories: [],
  searchIntent: null,
  commandIntent: null,
  sessionId: "",
  requestId: "",
};
