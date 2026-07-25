import type { CapabilityType, ICapability } from "../core/types.js";
import { CapabilityError } from "../core/errors.js";

/**
 * Capability Registry
 *
 * Central directory of every capability implementation available to the
 * runtime. A capability implementation is either:
 *   - a tool adapter (deterministic), or
 *   - a provider adapter (model-backed).
 *
 * Both register here through the same `register()` call. The Router later
 * queries the registry by capability type to find the best executor.
 *
 * Adding a new capability module = implement ICapability + register().
 * No core architecture change required.
 */
export class CapabilityRegistry {
  /** type -> sorted list of executors (highest priority first) */
  private readonly byType = new Map<CapabilityType, ICapability[]>();
  /** id -> capability (for direct lookup / dedup) */
  private readonly byId = new Map<string, ICapability>();

  register(cap: ICapability): void {
    if (this.byId.has(cap.id)) {
      throw new CapabilityError("E_CAPABILITY_FAILED", `Capability already registered: ${cap.id}`, {
        capabilityId: cap.id,
      });
    }
    this.byId.set(cap.id, cap);
    const list = this.byType.get(cap.type) ?? [];
    list.push(cap);
    // Keep sorted by priority desc — tools naturally float to the top when
    // they share a type with providers (because the planner prefers them).
    list.sort((a, b) => b.priority - a.priority);
    this.byType.set(cap.type, list);
  }

  unregister(id: string): boolean {
    const cap = this.byId.get(id);
    if (!cap) return false;
    this.byId.delete(id);
    const list = this.byType.get(cap.type);
    if (list) {
      const filtered = list.filter((c) => c.id !== id);
      this.byType.set(cap.type, filtered);
    }
    return true;
  }

  /** All executors for a capability type, highest priority first. */
  getByType(type: CapabilityType): readonly ICapability[] {
    return this.byType.get(type) ?? [];
  }

  /** Direct lookup by id. */
  get(id: string): ICapability | undefined {
    return this.byId.get(id);
  }

  /** All registered capability ids. */
  list(): string[] {
    return Array.from(this.byId.keys());
  }

  /** Whether any executor exists for this type. */
  has(type: CapabilityType): boolean {
    return (this.byType.get(type)?.length ?? 0) > 0;
  }
}
