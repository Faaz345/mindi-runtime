import { describe, it, expect } from "vitest";
import { ExecutionPlanner } from "../src/planner/ExecutionPlanner.js";
import { CapabilityType } from "../src/core/types.js";
import { topologicalWaves } from "../src/planner/ExecutionGraph.js";
import type { CapabilityPlan } from "../src/core/types.js";

const mkPlan = (missing: CapabilityType[]): CapabilityPlan => ({
  satisfied: [CapabilityType.Chat],
  missing: missing.map((type) => ({
    type,
    input: { type, params: {}, requestId: "r", sessionId: "s" },
    preferTool: type === "filesystem" || type === "git" || type === "terminal",
  })),
  unavailable: [],
});

describe("ExecutionPlanner", () => {
  const planner = new ExecutionPlanner();

  it("produces a graph with one node per missing capability", () => {
    const plan = mkPlan([CapabilityType.Filesystem, CapabilityType.Git]);
    const graph = planner.plan(plan, { requestId: "r", sessionId: "s" });
    expect(graph.nodes.size).toBe(2);
  });

  it("creates independent nodes (parallel) for unrelated capabilities", () => {
    const plan = mkPlan([CapabilityType.WebSearch, CapabilityType.Browser]);
    const graph = planner.plan(plan, { requestId: "r", sessionId: "s" });
    // WebSearch and Browser have no dependency rule between them → parallel
    const waves = topologicalWaves(graph);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(2);
  });

  it("creates Browser → OCR dependency", () => {
    const plan = mkPlan([CapabilityType.Browser, CapabilityType.OCR]);
    const graph = planner.plan(plan, { requestId: "r", sessionId: "s" });
    const ocrNode = [...graph.nodes.values()].find((n) => n.capability === CapabilityType.OCR)!;
    const browserNode = [...graph.nodes.values()].find((n) => n.capability === CapabilityType.Browser)!;
    expect(ocrNode.dependencies).toContain(browserNode.id);
    const waves = topologicalWaves(graph);
    expect(waves).toHaveLength(2); // Browser first, then OCR
  });

  it("creates Browser → Vision dependency", () => {
    const plan = mkPlan([CapabilityType.Browser, CapabilityType.Vision]);
    const graph = planner.plan(plan, { requestId: "r", sessionId: "s" });
    const visionNode = [...graph.nodes.values()].find((n) => n.capability === CapabilityType.Vision)!;
    const browserNode = [...graph.nodes.values()].find((n) => n.capability === CapabilityType.Browser)!;
    expect(visionNode.dependencies).toContain(browserNode.id);
  });

  it("creates OCR → Vision dependency (image debug pattern)", () => {
    const plan = mkPlan([CapabilityType.OCR, CapabilityType.Vision]);
    const graph = planner.plan(plan, { requestId: "r", sessionId: "s" });
    const visionNode = [...graph.nodes.values()].find((n) => n.capability === CapabilityType.Vision)!;
    const ocrNode = [...graph.nodes.values()].find((n) => n.capability === CapabilityType.OCR)!;
    expect(visionNode.dependencies).toContain(ocrNode.id);
    const waves = topologicalWaves(graph);
    expect(waves).toHaveLength(2); // OCR first, then Vision
  });

  it("creates Browser → OCR → Vision chain (browser debug pattern)", () => {
    const plan = mkPlan([CapabilityType.Browser, CapabilityType.OCR, CapabilityType.Vision]);
    const graph = planner.plan(plan, { requestId: "r", sessionId: "s" });
    const waves = topologicalWaves(graph);
    // Wave 0: Browser (no deps)
    // Wave 1: OCR (depends on Browser)
    // Wave 2: Vision (depends on OCR, which depends on Browser)
    expect(waves).toHaveLength(3);
    expect(waves[0]![0]!.capability).toBe(CapabilityType.Browser);
    expect(waves[1]![0]!.capability).toBe(CapabilityType.OCR);
    expect(waves[2]![0]!.capability).toBe(CapabilityType.Vision);
  });

  it("creates parallel WebSearch + Browser with Browser → OCR chain (research pattern)", () => {
    const plan = mkPlan([CapabilityType.WebSearch, CapabilityType.Browser, CapabilityType.OCR]);
    const graph = planner.plan(plan, { requestId: "r", sessionId: "s" });
    const waves = topologicalWaves(graph);
    // Wave 0: WebSearch + Browser (parallel)
    // Wave 1: OCR (depends on Browser)
    expect(waves).toHaveLength(2);
    expect(waves[0]).toHaveLength(2);
    expect(waves[1]).toHaveLength(1);
    expect(waves[1]![0]!.capability).toBe(CapabilityType.OCR);
  });

  it("produces an empty graph for a plan with no missing capabilities", () => {
    const plan: CapabilityPlan = {
      satisfied: [CapabilityType.Chat],
      missing: [],
      unavailable: [],
    };
    const graph = planner.plan(plan, { requestId: "r", sessionId: "s" });
    expect(graph.nodes.size).toBe(0);
    expect(graph.rootIds).toEqual([]);
  });

  it("sets executor type to 'tool' for preferTool capabilities", () => {
    const plan = mkPlan([CapabilityType.Filesystem, CapabilityType.Vision]);
    const graph = planner.plan(plan, { requestId: "r", sessionId: "s" });
    const fsNode = [...graph.nodes.values()].find((n) => n.capability === CapabilityType.Filesystem)!;
    const visionNode = [...graph.nodes.values()].find((n) => n.capability === CapabilityType.Vision)!;
    expect(fsNode.executorType).toBe("tool");
    expect(visionNode.executorType).toBe("auto");
  });

  it("assigns unique node ids based on capability type", () => {
    const plan = mkPlan([CapabilityType.Filesystem, CapabilityType.Git]);
    const graph = planner.plan(plan, { requestId: "r", sessionId: "s" });
    const ids = [...graph.nodes.keys()];
    expect(ids[0]).toContain("filesystem");
    expect(ids[1]).toContain("git");
  });
});
