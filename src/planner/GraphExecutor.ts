import type {
  CapabilityResult,
  CapabilityType,
  ExecutionGraph,
  ExecutionContext,
  ExecutionNode,
  ICapability,
} from "../core/types.js";
import type { CapabilityRouter } from "../router/CapabilityRouter.js";
import { topologicalWaves } from "./ExecutionGraph.js";
import { MindiError, toMindiError } from "../core/errors.js";

/**
 * A node result yielded by the GraphExecutor as nodes complete.
 * The Runtime forwards these as `capability` StreamEvents to the client.
 */
export interface NodeResult {
  nodeId: string;
  capability: CapabilityType;
  result: CapabilityResult;
}

/**
 * GraphExecutor
 *
 * Executes an ExecutionGraph (DAG) by:
 *   1. Partitioning nodes into topological waves.
 *   2. Running all nodes in a wave in parallel.
 *   3. Between waves, checking conditional nodes — skip if condition is false.
 *   4. Retrying failed nodes per their retry policy.
 *   5. Emitting node_started / node_waiting / node_completed / node_failed /
 *      graph_completed events for observability.
 *
 * The executor does NOT pick which executor to use — that's the Router's job.
 * The executor calls `router.selectExecutor()` for each node, then runs it.
 *
 * The executor yields NodeResults as they complete, so the Runtime can stream
 * capability events to the client in real-time.
 */
export class GraphExecutor {
  constructor(private readonly router: CapabilityRouter) {}

  async *execute(
    graph: ExecutionGraph,
    ctx: ExecutionContext,
  ): AsyncIterable<NodeResult> {
    const start = Date.now();
    const waves = topologicalWaves(graph);
    const completed = new Map<string, CapabilityResult>();
    let completedCount = 0;
    let failedCount = 0;

    ctx.log.debug("graph.execute.start", {
      graphId: graph.id,
      waves: waves.length,
      nodes: graph.nodes.size,
    });

    for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
      const wave = waves[waveIdx]!;

      // Check conditions — skip nodes whose condition evaluates false.
      const runnable: ExecutionNode[] = [];
      for (const node of wave) {
        if (node.condition) {
          const meets = node.condition(completed);
          if (!meets) {
            node.state = "skipped";
            ctx.log.debug("graph.node.skipped", { nodeId: node.id, capability: node.capability });
            continue;
          }
        }
        runnable.push(node);
      }

      // Emit node_waiting for nodes whose dependencies just completed
      // (only meaningful for wave > 0).
      if (waveIdx > 0) {
        for (const node of runnable) {
          const waitingFor = node.dependencies.filter((d) => !completed.has(d));
          if (waitingFor.length > 0) {
            node.state = "waiting";
            ctx.events.emit({
              type: "node_waiting",
              requestId: ctx.requestId,
              graphId: graph.id,
              nodeId: node.id,
              waitingFor,
              timestamp: Date.now(),
            });
          }
        }
      }

      // Start all runnable nodes in this wave in parallel.
      const promises = runnable.map((node) => this.executeNode(node, graph, ctx));

      // Wait for the entire wave to settle.
      const settled = await Promise.allSettled(promises);

      // Process results and yield them.
      for (let i = 0; i < runnable.length; i++) {
        const node = runnable[i]!;
        const s = settled[i]!;
        if (s.status === "fulfilled") {
          node.state = "completed";
          node.result = s.value;
          completed.set(node.id, s.value);
          completedCount++;
          ctx.events.emit({
            type: "node_completed",
            requestId: ctx.requestId,
            graphId: graph.id,
            nodeId: node.id,
            ok: s.value.ok,
            durationMs: s.value.durationMs,
            timestamp: Date.now(),
          });
          yield { nodeId: node.id, capability: node.capability, result: s.value };
        } else {
          // The node failed after all retries. Create a structured failure result.
          const err = toMindiError(s.reason);
          const failResult = makeFailureResult(node, err);
          node.state = "failed";
          node.result = failResult;
          completed.set(node.id, failResult);
          failedCount++;
          ctx.events.emit({
            type: "node_failed",
            requestId: ctx.requestId,
            graphId: graph.id,
            nodeId: node.id,
            error: err.message,
            timestamp: Date.now(),
          });
          yield { nodeId: node.id, capability: node.capability, result: failResult };
        }
      }
    }

    const ok = failedCount === 0;
    const durationMs = Date.now() - start;
    ctx.events.emit({
      type: "graph_completed",
      requestId: ctx.requestId,
      graphId: graph.id,
      ok,
      durationMs,
      completedNodes: completedCount,
      failedNodes: failedCount,
      timestamp: Date.now(),
    });
    ctx.log.debug("graph.execute.done", { graphId: graph.id, ok, durationMs, completedCount, failedCount });
  }

  /**
   * Execute a single node with retry logic.
   * The router selects the executor; this method runs it.
   */
  private async executeNode(
    node: ExecutionNode,
    graph: ExecutionGraph,
    ctx: ExecutionContext,
  ): Promise<CapabilityResult> {
    node.state = "running";
    ctx.events.emit({
      type: "node_started",
      requestId: ctx.requestId,
      graphId: graph.id,
      nodeId: node.id,
      capability: node.capability,
      timestamp: Date.now(),
    });

    const preferTool = node.executorType === "tool" || node.executorType === "auto";
    let lastError: unknown;

    for (let attempt = 0; attempt < node.retryPolicy.maxAttempts; attempt++) {
      node.attempts = attempt + 1;
      if (attempt > 0) {
        await sleep(node.retryPolicy.backoffMs * attempt);
        ctx.log.debug("graph.node.retry", { nodeId: node.id, attempt });
      }
      try {
        const executor = this.router.selectExecutor(node.capability, node.input, preferTool);
        ctx.events.emit({
          type: "capability:dispatch",
          requestId: ctx.requestId,
          capabilityId: executor.id,
          capabilityType: node.capability,
          executor: executor.source,
          timestamp: Date.now(),
        });

        const execStart = Date.now();
        const result = await this.runWithTimeout(executor, node, ctx);
        if (!result.durationMs) result.durationMs = Date.now() - execStart;

        ctx.events.emit({
          type: "capability:success",
          requestId: ctx.requestId,
          capabilityId: executor.id,
          durationMs: result.durationMs,
          timestamp: Date.now(),
        });
        return result;
      } catch (err) {
        lastError = err;
        const code = err instanceof MindiError ? err.code : "E_INTERNAL";
        ctx.events.emit({
          type: "capability:error",
          requestId: ctx.requestId,
          capabilityId: `node:${node.id}`,
          error: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        });
        if (!node.retryPolicy.retryOn.includes(code)) break;
      }
    }

    throw toMindiError(lastError);
  }

  /**
   * Run an executor with a per-node timeout (via AbortController).
   */
  private async runWithTimeout(
    executor: ICapability,
    node: ExecutionNode,
    ctx: ExecutionContext,
  ): Promise<CapabilityResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), node.timeoutMs);
    // If the parent request aborts, propagate.
    const onParentAbort = () => ctrl.abort();
    if (ctx.signal.aborted) onParentAbort();
    else ctx.signal.addEventListener("abort", onParentAbort, { once: true });

    try {
      return await executor.execute(node.input, ctx);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onParentAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeFailureResult(node: ExecutionNode, err: MindiError): CapabilityResult {
  return {
    type: node.capability,
    source: `node:${node.id}`,
    ok: false,
    payload: {
      kind: "text",
      text: `Capability "${node.capability}" failed after ${node.attempts} attempt(s): ${err.message}`,
    },
    error: err.message,
    durationMs: 0,
  };
}
