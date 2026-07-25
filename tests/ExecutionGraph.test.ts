import { describe, it, expect } from "vitest";
import { GraphBuilder, topologicalWaves, graphToString } from "../src/planner/ExecutionGraph.js";
import { CapabilityType } from "../src/core/types.js";

const mkInput = (cap: CapabilityType) => ({
  type: cap,
  params: {},
  requestId: "r",
  sessionId: "s",
});

describe("GraphBuilder", () => {
  it("builds a single-node graph", () => {
    const b = new GraphBuilder("g1");
    b.addNode({ id: "n1", capability: CapabilityType.Filesystem, input: mkInput(CapabilityType.Filesystem) });
    const g = b.build();
    expect(g.id).toBe("g1");
    expect(g.nodes.size).toBe(1);
    expect(g.rootIds).toEqual(["n1"]);
    expect(g.nodes.get("n1")!.capability).toBe(CapabilityType.Filesystem);
    expect(g.nodes.get("n1")!.state).toBe("pending");
    expect(g.nodes.get("n1")!.attempts).toBe(0);
  });

  it("assigns default id when not provided", () => {
    const b = new GraphBuilder();
    b.addNode({ capability: CapabilityType.Git, input: mkInput(CapabilityType.Git) });
    const g = b.build();
    expect(g.nodes.size).toBe(1);
    expect(g.rootIds[0]).toContain("git");
  });

  it("rejects duplicate node ids", () => {
    const b = new GraphBuilder();
    b.addNode({ id: "n1", capability: CapabilityType.Filesystem, input: mkInput(CapabilityType.Filesystem) });
    expect(() =>
      b.addNode({ id: "n1", capability: CapabilityType.Git, input: mkInput(CapabilityType.Git) }),
    ).toThrow();
  });

  it("detects cycles", () => {
    const b = new GraphBuilder();
    b.addNode({ id: "a", capability: CapabilityType.Filesystem, input: mkInput(CapabilityType.Filesystem), dependencies: ["b"] });
    b.addNode({ id: "b", capability: CapabilityType.Git, input: mkInput(CapabilityType.Git), dependencies: ["a"] });
    expect(() => b.build()).toThrow(/Cycle/);
  });

  it("rejects dependency on unknown node", () => {
    const b = new GraphBuilder();
    b.addNode({ id: "a", capability: CapabilityType.Filesystem, input: mkInput(CapabilityType.Filesystem), dependencies: ["nonexistent"] });
    expect(() => b.build()).toThrow(/unknown node/);
  });

  it("populates cost/latency/timeout estimates per capability", () => {
    const b = new GraphBuilder();
    b.addNode({ capability: CapabilityType.Vision, input: mkInput(CapabilityType.Vision) });
    b.addNode({ capability: CapabilityType.Filesystem, input: mkInput(CapabilityType.Filesystem) });
    const g = b.build();
    const vision = [...g.nodes.values()].find((n) => n.capability === CapabilityType.Vision)!;
    const fs = [...g.nodes.values()].find((n) => n.capability === CapabilityType.Filesystem)!;
    expect(vision.estimatedCost).toBeGreaterThan(fs.estimatedCost);
    expect(vision.estimatedLatencyMs).toBeGreaterThan(fs.estimatedLatencyMs);
    expect(vision.timeoutMs).toBeGreaterThan(0);
  });

  it("sets different retry policies for tools vs providers", () => {
    const b = new GraphBuilder();
    b.addNode({ capability: CapabilityType.Filesystem, executorType: "tool", input: mkInput(CapabilityType.Filesystem) });
    b.addNode({ capability: CapabilityType.Vision, executorType: "provider", input: mkInput(CapabilityType.Vision) });
    const g = b.build();
    const tool = [...g.nodes.values()].find((n) => n.capability === CapabilityType.Filesystem)!;
    const provider = [...g.nodes.values()].find((n) => n.capability === CapabilityType.Vision)!;
    expect(tool.retryPolicy.maxAttempts).toBe(1);
    expect(provider.retryPolicy.maxAttempts).toBe(2);
    expect(provider.retryPolicy.retryOn.length).toBeGreaterThan(0);
  });
});

describe("topologicalWaves", () => {
  it("returns single wave for independent nodes (parallel)", () => {
    const b = new GraphBuilder();
    b.addNode({ id: "a", capability: CapabilityType.Filesystem, input: mkInput(CapabilityType.Filesystem) });
    b.addNode({ id: "b", capability: CapabilityType.Git, input: mkInput(CapabilityType.Git) });
    b.addNode({ id: "c", capability: CapabilityType.WebSearch, input: mkInput(CapabilityType.WebSearch) });
    const g = b.build();
    const waves = topologicalWaves(g);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(3);
  });

  it("returns multiple waves for sequential dependencies", () => {
    const b = new GraphBuilder();
    b.addNode({ id: "a", capability: CapabilityType.Browser, input: mkInput(CapabilityType.Browser) });
    b.addNode({ id: "b", capability: CapabilityType.OCR, input: mkInput(CapabilityType.OCR), dependencies: ["a"] });
    b.addNode({ id: "c", capability: CapabilityType.Vision, input: mkInput(CapabilityType.Vision), dependencies: ["b"] });
    const g = b.build();
    const waves = topologicalWaves(g);
    expect(waves).toHaveLength(3);
    expect(waves[0]![0]!.id).toBe("a");
    expect(waves[1]![0]!.id).toBe("b");
    expect(waves[2]![0]!.id).toBe("c");
  });

  it("returns correct waves for mixed parallel + sequential (research pattern)", () => {
    const b = new GraphBuilder();
    // Web Search and Browser run in parallel
    b.addNode({ id: "search", capability: CapabilityType.WebSearch, input: mkInput(CapabilityType.WebSearch) });
    b.addNode({ id: "browse", capability: CapabilityType.Browser, input: mkInput(CapabilityType.Browser) });
    // OCR depends on Browser
    b.addNode({ id: "ocr", capability: CapabilityType.OCR, input: mkInput(CapabilityType.OCR), dependencies: ["browse"] });
    const g = b.build();
    const waves = topologicalWaves(g);
    expect(waves[0]).toHaveLength(2); // search + browse in parallel
    expect(waves[1]).toHaveLength(1); // ocr after browse
    expect(waves[1]![0]!.id).toBe("ocr");
  });
});

describe("graphToString", () => {
  it("produces a human-readable representation", () => {
    const b = new GraphBuilder("test-graph");
    b.addNode({ id: "a", capability: CapabilityType.Filesystem, input: mkInput(CapabilityType.Filesystem) });
    b.addNode({ id: "b", capability: CapabilityType.Git, input: mkInput(CapabilityType.Git), dependencies: ["a"] });
    const g = b.build();
    const str = graphToString(g);
    expect(str).toContain("test-graph");
    expect(str).toContain("filesystem");
    expect(str).toContain("git");
    expect(str).toContain("deps=[a]");
  });
});
