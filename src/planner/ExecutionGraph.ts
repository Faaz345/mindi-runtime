import type {
  CapabilityResult,
  CapabilityType,
  ExecutionGraph,
  ExecutionNode,
  RetryPolicy,
} from "../core/types.js";
import { randomUUID } from "node:crypto";

/**
 * Execution Graph builder + utilities.
 *
 * The graph is a DAG: nodes are capability executions, edges are dependencies.
 * The builder validates acyclicity and provides topological wave sort for
 * parallel execution.
 */

// ---------------------------------------------------------------------------
// Cost / latency estimation table
// ---------------------------------------------------------------------------

const ESTIMATES: Record<CapabilityType, { cost: number; latencyMs: number }> = {
  vision: { cost: 15, latencyMs: 3000 },
  ocr: { cost: 5, latencyMs: 1000 },
  web_search: { cost: 8, latencyMs: 2000 },
  browser: { cost: 20, latencyMs: 5000 },
  filesystem: { cost: 1, latencyMs: 50 },
  git: { cost: 1, latencyMs: 100 },
  terminal: { cost: 2, latencyMs: 500 },
  image_generation: { cost: 30, latencyMs: 10000 },
  audio: { cost: 15, latencyMs: 5000 },
  embeddings: { cost: 3, latencyMs: 500 },
  database: { cost: 2, latencyMs: 200 },
  chat: { cost: 10, latencyMs: 2000 },
};

const DEFAULT_TIMEOUT: Record<CapabilityType, number> = {
  vision: 30_000,
  ocr: 15_000,
  web_search: 20_000,
  browser: 60_000,
  filesystem: 10_000,
  git: 15_000,
  terminal: 30_000,
  image_generation: 120_000,
  audio: 60_000,
  embeddings: 15_000,
  database: 15_000,
  chat: 120_000,
};

const DEFAULT_RETRY_TOOL: RetryPolicy = {
  maxAttempts: 1,
  backoffMs: 500,
  retryOn: [],
};

const DEFAULT_RETRY_PROVIDER: RetryPolicy = {
  maxAttempts: 2,
  backoffMs: 1000,
  retryOn: ["E_PROVIDER_TIMEOUT", "E_PROVIDER_RATE_LIMIT"],
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export class GraphBuilder {
  private readonly nodes = new Map<string, ExecutionNode>();
  private readonly dependents = new Map<string, string[]>();
  private readonly id: string;

  constructor(id?: string) {
    this.id = id ?? randomUUID();
  }

  addNode(opts: {
    id?: string;
    capability: CapabilityType;
    executorType?: "tool" | "provider" | "auto";
    dependencies?: string[];
    input: ExecutionNode["input"];
    condition?: (results: Map<string, CapabilityResult>) => boolean;
    timeoutMs?: number;
    retryPolicy?: RetryPolicy;
  }): string {
    const nodeId = opts.id ?? `${opts.capability}-${this.nodes.size}`;
    if (this.nodes.has(nodeId)) {
      throw new Error(`Duplicate node id: ${nodeId}`);
    }
    const cap = opts.capability;
    const est = ESTIMATES[cap] ?? { cost: 5, latencyMs: 2000 };
    const isTool = opts.executorType === "tool";
    const retry = opts.retryPolicy ?? (isTool ? DEFAULT_RETRY_TOOL : DEFAULT_RETRY_PROVIDER);
    const node: ExecutionNode = {
      id: nodeId,
      capability: cap,
      executorType: opts.executorType ?? "auto",
      dependencies: opts.dependencies ?? [],
      state: "pending",
      estimatedCost: est.cost,
      estimatedLatencyMs: est.latencyMs,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT[cap] ?? 30_000,
      retryPolicy: retry,
      input: opts.input,
      condition: opts.condition,
      attempts: 0,
    };
    this.nodes.set(nodeId, node);
    // Register reverse edges
    for (const dep of node.dependencies) {
      const list = this.dependents.get(dep) ?? [];
      list.push(nodeId);
      this.dependents.set(dep, list);
    }
    return nodeId;
  }

  /** Finalize and validate the graph. Throws if cycles are detected. */
  build(): ExecutionGraph {
    this.validateAcyclic();
    const rootIds = Array.from(this.nodes.values())
      .filter((n) => n.dependencies.length === 0)
      .map((n) => n.id);
    return {
      id: this.id,
      nodes: new Map(this.nodes),
      rootIds,
      dependents: new Map(this.dependents),
    };
  }

  /** Detect cycles via DFS with a tri-color marking. */
  private validateAcyclic(): void {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    for (const id of this.nodes.keys()) color.set(id, WHITE);

    const visit = (id: string, path: string[]): void => {
      const c = color.get(id);
      if (c === BLACK) return;
      if (c === GRAY) {
        throw new Error(`Cycle detected in execution graph: ${[...path, id].join(" -> ")}`);
      }
      color.set(id, GRAY);
      const node = this.nodes.get(id)!;
      for (const dep of node.dependencies) {
        if (!this.nodes.has(dep)) {
          throw new Error(`Node "${id}" depends on unknown node "${dep}"`);
        }
        visit(dep, [...path, id]);
      }
      color.set(id, BLACK);
    };

    for (const id of this.nodes.keys()) {
      visit(id, []);
    }
  }

  get size(): number {
    return this.nodes.size;
  }
}

// ---------------------------------------------------------------------------
// Topological wave sort
// ---------------------------------------------------------------------------

/**
 * Partition a graph into waves of parallel-executable nodes.
 *
 * Wave 0 = roots (no dependencies).
 * Wave N = nodes whose dependencies are ALL in waves 0..N-1.
 *
 * Within a wave, all nodes can run in parallel. Between waves, execution
 * must be sequential.
 */
export function topologicalWaves(graph: ExecutionGraph): ExecutionNode[][] {
  const completed = new Set<string>();
  const remaining = new Set(graph.nodes.keys());
  const waves: ExecutionNode[][] = [];

  while (remaining.size > 0) {
    const wave: ExecutionNode[] = [];
    for (const id of remaining) {
      const node = graph.nodes.get(id)!;
      if (node.dependencies.every((d) => completed.has(d))) {
        wave.push(node);
      }
    }
    if (wave.length === 0) {
      // This shouldn't happen if validateAcyclic passed, but guard anyway.
      throw new Error("Deadlock in execution graph — no runnable nodes but graph not empty");
    }
    for (const node of wave) {
      completed.add(node.id);
      remaining.delete(node.id);
    }
    waves.push(wave);
  }
  return waves;
}

/**
 * Pretty-print the graph as an adjacency list for debugging / logging.
 */
export function graphToString(graph: ExecutionGraph): string {
  const lines: string[] = [];
  for (const node of graph.nodes.values()) {
    const deps = node.dependencies.length > 0 ? ` deps=[${node.dependencies.join(",")}]` : "";
    lines.push(`  ${node.id}: ${node.capability} (${node.executorType})${deps}`);
  }
  return `graph ${graph.id} (${graph.nodes.size} nodes):\n${lines.join("\n")}`;
}
