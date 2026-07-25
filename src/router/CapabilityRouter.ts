import type {
  CapabilityInput,
  CapabilityResult,
  ExecutionContext,
  ICapability,
  PlannedCapability,
} from "../core/types.js";
import type { CapabilityRegistry } from "../registry/CapabilityRegistry.js";
import { CapabilityError } from "../core/errors.js";

/**
 * CapabilityRouter
 *
 * The router's responsibility is SELECTING the best executor for a given
 * capability + input. It no longer decides execution ORDER — that's the
 * GraphExecutor's job.
 *
 * Two entry points:
 *   - selectExecutor(type, input, preferTool) → ICapability
 *     Used by the GraphExecutor. Returns the chosen executor without running it.
 *
 *   - execute(planned, ctx) → CapabilityResult
 *     Legacy entry point for backward compatibility. Picks + runs a single
 *     capability. Still used by CapabilityRouter tests and any code that
 *     hasn't migrated to the graph executor yet.
 *
 * Selection policy:
 *   1. If preferTool is true AND a tool executor is registered,
 *      use the tool (deterministic > generative).
 *   2. Otherwise pick the executor with the highest priority (already
 *      sorted by the registry — tools are 1000, providers are 100).
 *   3. Validate the executor claims it canHandle() the input.
 */
export class CapabilityRouter {
  constructor(private readonly registry: CapabilityRegistry) {}

  /**
   * Select the best executor for a capability + input.
   * Does NOT execute — just returns the ICapability.
   * The GraphExecutor calls this, then runs the executor itself.
   */
  selectExecutor(
    type: import("../core/types.js").CapabilityType,
    input: CapabilityInput,
    preferTool: boolean,
  ): ICapability {
    const candidates = this.registry.getByType(type);
    if (candidates.length === 0) {
      throw new CapabilityError(
        "E_CAPABILITY_NOT_FOUND",
        `No executor registered for capability "${type}"`,
        { capabilityType: type },
      );
    }
    return this.pickExecutor(candidates, input, preferTool);
  }

  /**
   * Legacy entry point: pick the best executor AND run it.
   * Kept for backward compatibility — the GraphExecutor uses selectExecutor()
   * instead, but existing tests and any non-graph callers still use this.
   */
  async execute(
    planned: PlannedCapability,
    ctx: ExecutionContext,
  ): Promise<CapabilityResult> {
    const candidates = this.registry.getByType(planned.type);
    if (candidates.length === 0) {
      throw new CapabilityError(
        "E_CAPABILITY_NOT_FOUND",
        `No executor registered for capability "${planned.type}"`,
        { capabilityType: planned.type, requestId: ctx.requestId },
      );
    }

    const executor = this.pickExecutor(candidates, planned.input, planned.preferTool);
    ctx.log.debug("router.dispatch", {
      capability: planned.type,
      executor: executor.id,
      source: executor.source,
    });
    ctx.events.emit({
      type: "capability:dispatch",
      requestId: ctx.requestId,
      capabilityId: executor.id,
      capabilityType: planned.type,
      executor: executor.source,
      timestamp: Date.now(),
    });

    const start = Date.now();
    try {
      const result = await executor.execute(planned.input, ctx);
      ctx.events.emit({
        type: "capability:success",
        requestId: ctx.requestId,
        capabilityId: executor.id,
        durationMs: Date.now() - start,
        timestamp: Date.now(),
      });
      if (!result.durationMs) result.durationMs = Date.now() - start;
      return result;
    } catch (err) {
      ctx.events.emit({
        type: "capability:error",
        requestId: ctx.requestId,
        capabilityId: executor.id,
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      });
      return {
        type: planned.type,
        source: executor.id,
        ok: false,
        payload: { kind: "text", text: `Capability "${planned.type}" failed: ${err instanceof Error ? err.message : String(err)}` },
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  /**
   * Pick the best executor from candidates.
   *   - If preferTool, scan for a tool-source executor.
   *   - Otherwise take the first (highest priority).
   *   - Ensure the chosen executor canHandle the input; fall back to the
   *     next candidate if not.
   */
  private pickExecutor(
    candidates: readonly ICapability[],
    input: CapabilityInput,
    preferTool: boolean,
  ): ICapability {
    if (preferTool) {
      const tool = candidates.find((c) => c.source === "tool" && c.canHandle(input));
      if (tool) return tool;
    }
    for (const c of candidates) {
      if (c.canHandle(input)) return c;
    }
    return candidates[0]!;
  }
}
