import { describe, it, expect, vi } from "vitest";
import { GraphBuilder } from "../src/planner/ExecutionGraph.js";
import { GraphExecutor, type NodeResult } from "../src/planner/GraphExecutor.js";
import { CapabilityRegistry } from "../src/registry/CapabilityRegistry.js";
import { CapabilityRouter } from "../src/router/CapabilityRouter.js";
import { CapabilityType } from "../src/core/types.js";
import type { ExecutionContext, ICapability, CapabilityResult } from "../src/core/types.js";

function makeCtx(): ExecutionContext & { emitted: Array<{ type: string; [k: string]: unknown }> } {
  const emitted: Array<{ type: string; [k: string]: unknown }> = [];
  const ctrl = new AbortController();
  return {
    requestId: "r",
    sessionId: "s",
    signal: ctrl.signal,
    log: {
      trace() {}, debug() {}, info() {}, warn() {}, error() {},
      child() { return this; },
    },
    events: {
      emit(e: { type: string; [k: string]: unknown }) { emitted.push(e); },
      on() { return () => {} },
      clear() { emitted.length = 0; },
    },
    emitted,
  } as never;
}

function makeCap(id: string, type: CapabilityType, delay = 0, ok = true): ICapability {
  return {
    id, type, source: "tool", label: id, priority: 1000,
    execute: async () => {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      if (!ok) throw new Error(`${id} failed`);
      return {
        type, source: id, ok: true,
        payload: { kind: "text", text: `result from ${id}` },
        durationMs: delay,
      };
    },
    canHandle: () => true,
  };
}

const mkInput = (cap: CapabilityType) => ({
  type: cap, params: {}, requestId: "r", sessionId: "s",
});

describe("GraphExecutor", () => {
  it("executes a single-node graph", async () => {
    const reg = new CapabilityRegistry();
    reg.register(makeCap("tool.fs", CapabilityType.Filesystem));
    const router = new CapabilityRouter(reg);
    const executor = new GraphExecutor(router);

    const b = new GraphBuilder("g1");
    b.addNode({ id: "n1", capability: CapabilityType.Filesystem, input: mkInput(CapabilityType.Filesystem), executorType: "tool" });
    const graph = b.build();
    const ctx = makeCtx();

    const results: NodeResult[] = [];
    for await (const r of executor.execute(graph, ctx)) results.push(r);

    expect(results).toHaveLength(1);
    expect(results[0]!.result.ok).toBe(true);
    expect(results[0]!.result.source).toBe("tool.fs");
  });

  it("executes parallel nodes in the same wave", async () => {
    const reg = new CapabilityRegistry();
    reg.register(makeCap("tool.fs", CapabilityType.Filesystem, 50));
    reg.register(makeCap("tool.git", CapabilityType.Git, 50));
    const router = new CapabilityRouter(reg);
    const executor = new GraphExecutor(router);

    const b = new GraphBuilder("g2");
    b.addNode({ id: "a", capability: CapabilityType.Filesystem, input: mkInput(CapabilityType.Filesystem), executorType: "tool" });
    b.addNode({ id: "b", capability: CapabilityType.Git, input: mkInput(CapabilityType.Git), executorType: "tool" });
    const graph = b.build();

    const start = Date.now();
    const results: NodeResult[] = [];
    for await (const r of executor.execute(graph, makeCtx())) results.push(r);
    const duration = Date.now() - start;

    // If sequential, would be ~100ms. Parallel should be ~50ms.
    expect(duration).toBeLessThan(90);
    expect(results).toHaveLength(2);
  });

  it("executes sequential nodes in separate waves", async () => {
    const reg = new CapabilityRegistry();
    reg.register(makeCap("tool.fs", CapabilityType.Filesystem, 30));
    reg.register(makeCap("tool.git", CapabilityType.Git, 30));
    const router = new CapabilityRouter(reg);
    const executor = new GraphExecutor(router);

    const b = new GraphBuilder("g3");
    b.addNode({ id: "a", capability: CapabilityType.Filesystem, input: mkInput(CapabilityType.Filesystem), executorType: "tool" });
    b.addNode({ id: "b", capability: CapabilityType.Git, input: mkInput(CapabilityType.Git), executorType: "tool", dependencies: ["a"] });
    const graph = b.build();

    const results: NodeResult[] = [];
    for await (const r of executor.execute(graph, makeCtx())) results.push(r);

    expect(results).toHaveLength(2);
    // First result should be "a" (no deps), second "b"
    expect(results[0]!.nodeId).toBe("a");
    expect(results[1]!.nodeId).toBe("b");
  });

  it("emits execution_graph events on the event bus", async () => {
    const reg = new CapabilityRegistry();
    reg.register(makeCap("tool.fs", CapabilityType.Filesystem));
    const router = new CapabilityRouter(reg);
    const executor = new GraphExecutor(router);

    const b = new GraphBuilder("g-evt");
    b.addNode({ id: "n1", capability: CapabilityType.Filesystem, input: mkInput(CapabilityType.Filesystem), executorType: "tool" });
    const graph = b.build();
    const ctx = makeCtx();

    for await (const _ of executor.execute(graph, ctx)) { /* drain */ }

    const types = ctx.emitted.map((e) => e.type);
    expect(types).toContain("node_started");
    expect(types).toContain("node_completed");
    expect(types).toContain("graph_completed");
  });

  it("emits capability:dispatch and capability:success events", async () => {
    const reg = new CapabilityRegistry();
    reg.register(makeCap("tool.fs", CapabilityType.Filesystem));
    const router = new CapabilityRouter(reg);
    const executor = new GraphExecutor(router);

    const b = new GraphBuilder();
    b.addNode({ id: "n1", capability: CapabilityType.Filesystem, input: mkInput(CapabilityType.Filesystem), executorType: "tool" });
    const graph = b.build();
    const ctx = makeCtx();

    for await (const _ of executor.execute(graph, ctx)) { /* drain */ }

    const types = ctx.emitted.map((e) => e.type);
    expect(types).toContain("capability:dispatch");
    expect(types).toContain("capability:success");
  });

  it("emits node_failed for failing nodes", async () => {
    const reg = new CapabilityRegistry();
    reg.register(makeCap("tool.fs", CapabilityType.Filesystem, 0, false));
    const router = new CapabilityRouter(reg);
    const executor = new GraphExecutor(router);

    const b = new GraphBuilder();
    b.addNode({ id: "n1", capability: CapabilityType.Filesystem, input: mkInput(CapabilityType.Filesystem), executorType: "tool" });
    const graph = b.build();
    const ctx = makeCtx();

    const results: NodeResult[] = [];
    for await (const r of executor.execute(graph, ctx)) results.push(r);

    expect(results).toHaveLength(1);
    expect(results[0]!.result.ok).toBe(false);
    const types = ctx.emitted.map((e) => e.type);
    expect(types).toContain("node_failed");
    expect(types).toContain("capability:error");
  });

  it("skips conditional nodes when condition returns false", async () => {
    const reg = new CapabilityRegistry();
    reg.register(makeCap("tool.fs", CapabilityType.Filesystem));
    reg.register(makeCap("tool.git", CapabilityType.Git));
    const router = new CapabilityRouter(reg);
    const executor = new GraphExecutor(router);

    const b = new GraphBuilder();
    b.addNode({ id: "a", capability: CapabilityType.Filesystem, input: mkInput(CapabilityType.Filesystem), executorType: "tool" });
    b.addNode({
      id: "b",
      capability: CapabilityType.Git,
      input: mkInput(CapabilityType.Git),
      executorType: "tool",
      dependencies: ["a"],
      condition: () => false, // never run
    });
    const graph = b.build();
    const ctx = makeCtx();

    const results: NodeResult[] = [];
    for await (const r of executor.execute(graph, ctx)) results.push(r);

    // Only "a" executes; "b" is skipped
    expect(results).toHaveLength(1);
    expect(results[0]!.nodeId).toBe("a");
    const bNode = graph.nodes.get("b")!;
    expect(bNode.state).toBe("skipped");
  });

  it("runs conditional node when condition returns true", async () => {
    const reg = new CapabilityRegistry();
    reg.register(makeCap("tool.fs", CapabilityType.Filesystem));
    reg.register(makeCap("tool.git", CapabilityType.Git));
    const router = new CapabilityRouter(reg);
    const executor = new GraphExecutor(router);

    const b = new GraphBuilder();
    b.addNode({ id: "a", capability: CapabilityType.Filesystem, input: mkInput(CapabilityType.Filesystem), executorType: "tool" });
    b.addNode({
      id: "b",
      capability: CapabilityType.Git,
      input: mkInput(CapabilityType.Git),
      executorType: "tool",
      dependencies: ["a"],
      condition: (results) => results.has("a"), // run if "a" completed
    });
    const graph = b.build();

    const results: NodeResult[] = [];
    for await (const r of executor.execute(graph, makeCtx())) results.push(r);

    expect(results).toHaveLength(2);
  });

  it("emits graph_completed with ok=true when all nodes succeed", async () => {
    const reg = new CapabilityRegistry();
    reg.register(makeCap("tool.fs", CapabilityType.Filesystem));
    reg.register(makeCap("tool.git", CapabilityType.Git));
    const router = new CapabilityRouter(reg);
    const executor = new GraphExecutor(router);

    const b = new GraphBuilder();
    b.addNode({ id: "a", capability: CapabilityType.Filesystem, input: mkInput(CapabilityType.Filesystem), executorType: "tool" });
    b.addNode({ id: "b", capability: CapabilityType.Git, input: mkInput(CapabilityType.Git), executorType: "tool" });
    const graph = b.build();
    const ctx = makeCtx();

    for await (const _ of executor.execute(graph, ctx)) { /* drain */ }

    const graphComplete = ctx.emitted.find((e) => e.type === "graph_completed")!;
    expect(graphComplete.ok).toBe(true);
    expect(graphComplete.completedNodes).toBe(2);
    expect(graphComplete.failedNodes).toBe(0);
  });

  it("emits graph_completed with ok=false when any node fails", async () => {
    const reg = new CapabilityRegistry();
    reg.register(makeCap("tool.fs", CapabilityType.Filesystem, 0, false));
    const router = new CapabilityRouter(reg);
    const executor = new GraphExecutor(router);

    const b = new GraphBuilder();
    b.addNode({ id: "n1", capability: CapabilityType.Filesystem, input: mkInput(CapabilityType.Filesystem), executorType: "tool" });
    const graph = b.build();
    const ctx = makeCtx();

    for await (const _ of executor.execute(graph, ctx)) { /* drain */ }

    const graphComplete = ctx.emitted.find((e) => e.type === "graph_completed")!;
    expect(graphComplete.ok).toBe(false);
    expect(graphComplete.failedNodes).toBe(1);
  });

  it("handles mixed parallel + sequential (research pattern)", async () => {
    const reg = new CapabilityRegistry();
    reg.register(makeCap("tool.search", CapabilityType.WebSearch, 30));
    reg.register(makeCap("tool.browse", CapabilityType.Browser, 30));
    reg.register(makeCap("tool.ocr", CapabilityType.OCR, 20));
    const router = new CapabilityRouter(reg);
    const executor = new GraphExecutor(router);

    const b = new GraphBuilder();
    b.addNode({ id: "search", capability: CapabilityType.WebSearch, input: mkInput(CapabilityType.WebSearch), executorType: "tool" });
    b.addNode({ id: "browse", capability: CapabilityType.Browser, input: mkInput(CapabilityType.Browser), executorType: "tool" });
    b.addNode({ id: "ocr", capability: CapabilityType.OCR, input: mkInput(CapabilityType.OCR), executorType: "tool", dependencies: ["browse"] });
    const graph = b.build();

    const start = Date.now();
    const results: NodeResult[] = [];
    for await (const r of executor.execute(graph, makeCtx())) results.push(r);
    const duration = Date.now() - start;

    // search + browse in parallel (~30ms), then ocr (~20ms) = ~50ms total
    // if sequential: 30 + 30 + 20 = 80ms
    expect(duration).toBeLessThan(75);
    expect(results).toHaveLength(3);
    // browse and search should come before ocr
    const ocrIdx = results.findIndex((r) => r.nodeId === "ocr");
    const browseIdx = results.findIndex((r) => r.nodeId === "browse");
    expect(ocrIdx).toBeGreaterThan(browseIdx);
  });

  it("yields results as nodes complete (streaming)", async () => {
    const reg = new CapabilityRegistry();
    reg.register(makeCap("fast", CapabilityType.Filesystem, 10));
    reg.register(makeCap("slow", CapabilityType.Git, 50));
    const router = new CapabilityRouter(reg);
    const executor = new GraphExecutor(router);

    const b = new GraphBuilder();
    b.addNode({ id: "fast", capability: CapabilityType.Filesystem, input: mkInput(CapabilityType.Filesystem), executorType: "tool" });
    b.addNode({ id: "slow", capability: CapabilityType.Git, input: mkInput(CapabilityType.Git), executorType: "tool" });
    const graph = b.build();

    const results: NodeResult[] = [];
    for await (const r of executor.execute(graph, makeCtx())) results.push(r);

    // Both should be yielded; order may vary but both present
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.nodeId).sort()).toEqual(["fast", "slow"]);
  });
});
