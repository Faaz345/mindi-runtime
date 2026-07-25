import type {
  CapabilityPlan,
  CapabilityType,
  ExecutionGraph,
} from "../core/types.js";
import { GraphBuilder } from "./ExecutionGraph.js";

/**
 * ExecutionPlanner
 *
 * Sits between the CapabilityPlanner and the CapabilityRouter.
 *
 * Takes a CapabilityPlan (which lists missing capabilities) and produces an
 * ExecutionGraph (DAG) describing:
 *   - which capabilities to execute
 *   - in what order (dependencies)
 *   - which can run in parallel
 *   - which are conditional on prior results
 *
 * Dependency rules (conservative — err toward parallelism unless a clear
 * data dependency exists):
 *
 *   Browser → OCR         (OCR extracts text from the browsed/screenshot page)
 *   Browser → Vision      (Vision analyzes the browsed/screenshot page)
 *   OCR → Vision          (Vision benefits from OCR's extracted text)
 *
 * Everything else runs in parallel. For example, WebSearch + Browser run
 * side by side and their results merge at the context builder.
 *
 * Adding a new dependency rule = add an entry to DEPENDENCY_RULES.
 * No core architecture change required.
 */

interface DependencyRule {
  before: CapabilityType;
  after: CapabilityType;
  reason: string;
}

const DEPENDENCY_RULES: DependencyRule[] = [
  { before: "browser", after: "ocr", reason: "OCR may extract text from browser screenshots" },
  { before: "browser", after: "vision", reason: "Vision may analyze browser screenshots" },
  { before: "ocr", after: "vision", reason: "Vision benefits from OCR results" },
];

export class ExecutionPlanner {
  /**
   * Convert a CapabilityPlan into an ExecutionGraph.
   *
   * The graph is built by:
   *   1. Assigning a deterministic node id to each missing capability.
   *   2. Computing dependencies from the rule table.
   *   3. Adding all nodes to the graph builder in one pass (since we know
   *      all ids upfront, dependencies can reference future nodes).
   */
  plan(
    capabilityPlan: CapabilityPlan,
    _request: { requestId: string; sessionId: string },
  ): ExecutionGraph {
    const builder = new GraphBuilder();

    // Assign deterministic node ids: "node-{capability}-{index}".
    // If a capability type appears once (the common case), id = "node-{cap}".
    const nodeIds = new Map<CapabilityType, string>();
    const typeCount = new Map<CapabilityType, number>();
    for (const planned of capabilityPlan.missing) {
      const idx = typeCount.get(planned.type) ?? 0;
      typeCount.set(planned.type, idx + 1);
      const id = idx === 0 ? `node-${planned.type}` : `node-${planned.type}-${idx}`;
      nodeIds.set(planned.type, id);
    }

    // Compute dependencies for each missing capability.
    const missingTypes = new Set(capabilityPlan.missing.map((m) => m.type));
    const depsByType = new Map<CapabilityType, string[]>();
    for (const planned of capabilityPlan.missing) {
      const deps: string[] = [];
      for (const rule of DEPENDENCY_RULES) {
        // If this capability (rule.after) depends on another (rule.before)
        // AND both are in the missing set, add the edge.
        if (rule.after === planned.type && missingTypes.has(rule.before)) {
          const depId = nodeIds.get(rule.before);
          if (depId) deps.push(depId);
        }
      }
      depsByType.set(planned.type, deps);
    }

    // Add all nodes. Since we assigned ids upfront, dependencies can
    // reference nodes that haven't been added yet — the builder resolves
    // them at build() time.
    for (const planned of capabilityPlan.missing) {
      const id = nodeIds.get(planned.type)!;
      const executorType = planned.preferTool ? "tool" : "auto";
      builder.addNode({
        id,
        capability: planned.type,
        executorType,
        input: planned.input,
        dependencies: depsByType.get(planned.type) ?? [],
      });
    }

    return builder.build();
  }
}
