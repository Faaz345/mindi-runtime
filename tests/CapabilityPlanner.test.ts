import { describe, it, expect } from "vitest";
import { CapabilityPlanner } from "../src/planner/CapabilityPlanner.js";
import { CapabilityRegistry } from "../src/registry/CapabilityRegistry.js";
import { CapabilityType } from "../src/core/types.js";
import type { IProvider, IntentDescriptor, CapabilityType as CapT, ProviderCapabilityDeclaration } from "../src/core/types.js";

function fakeProvider(caps: CapT[]): IProvider {
  return {
    id: "fake",
    label: "Fake",
    capabilities: new Set(caps),
    listModels: async () => [{ id: "fake-model", label: "Fake", capabilities: caps }],
    hasModel: async () => true,
    hasCapability: (t) => caps.includes(t),
    declareCapability: async (modelId: string): Promise<ProviderCapabilityDeclaration> => ({
      providerId: "fake",
      modelId,
      label: "Fake",
      capabilities: caps,
      streaming: true,
      toolCalling: false,
      multimodal: caps.includes(CapabilityType.Vision),
      embeddingSupport: caps.includes(CapabilityType.Embeddings),
      imageGeneration: caps.includes(CapabilityType.ImageGeneration),
      audioSupport: false,
      maxContext: 8192,
      metadata: {},
      resolvedAt: Date.now(),
    }),
    chat: async function* () {},
    executeCapability: async () => { throw new Error("not impl"); },
    health: async () => ({ providerId: "fake", ok: true }),
  };
}

function fakeIntent(req: CapT[]): IntentDescriptor {
  return {
    summary: "test",
    requiredCapabilities: req,
    confidence: 0.9,
    signals: req.map((c) => ({ capability: c, reason: "test", weight: 1 })),
  };
}

describe("CapabilityPlanner", () => {
  it("marks capabilities the model has as satisfied", async () => {
    const r = new CapabilityRegistry();
    const p = new CapabilityPlanner(r);
    const provider = fakeProvider([CapabilityType.Chat, CapabilityType.Vision]);
    const plan = await p.plan(
      fakeIntent([CapabilityType.Chat, CapabilityType.Vision]),
      provider,
      "fake-model",
      { requestId: "r", sessionId: "s", messages: [], input: "" },
    );
    expect(plan.satisfied.sort()).toEqual([CapabilityType.Chat, CapabilityType.Vision]);
    expect(plan.missing).toHaveLength(0);
  });

  it("plans augmentation for missing capabilities with registered executors", async () => {
    const r = new CapabilityRegistry();
    // Register a tool for Filesystem.
    r.register({
      id: "tool.fs",
      type: CapabilityType.Filesystem,
      source: "tool",
      label: "FS",
      priority: 1000,
      execute: async () => ({ type: CapabilityType.Filesystem, source: "tool.fs", ok: true, payload: { kind: "text", text: "" }, durationMs: 0 }),
      canHandle: () => true,
    });
    const p = new CapabilityPlanner(r);
    const provider = fakeProvider([CapabilityType.Chat]);
    const plan = await p.plan(
      fakeIntent([CapabilityType.Chat, CapabilityType.Filesystem]),
      provider,
      "fake-model",
      { requestId: "r", sessionId: "s", messages: [], input: "list files" },
    );
    expect(plan.satisfied).toEqual([CapabilityType.Chat]);
    expect(plan.missing).toHaveLength(1);
    expect(plan.missing[0]!.type).toBe(CapabilityType.Filesystem);
    expect(plan.missing[0]!.preferTool).toBe(true);
  });

  it("marks capabilities with no executor as unavailable", async () => {
    const r = new CapabilityRegistry();
    const p = new CapabilityPlanner(r);
    const provider = fakeProvider([CapabilityType.Chat]);
    const plan = await p.plan(
      fakeIntent([CapabilityType.Chat, CapabilityType.Audio]),
      provider,
      "fake-model",
      { requestId: "r", sessionId: "s", messages: [], input: "transcribe audio" },
    );
    expect(plan.unavailable.length).toBe(1);
    expect(plan.unavailable[0]!.type).toBe(CapabilityType.Audio);
  });

  it("uses real capability declarations for negotiation", async () => {
    const r = new CapabilityRegistry();
    // Register a vision executor
    r.register({
      id: "provider.vision",
      type: CapabilityType.Vision,
      source: "provider",
      label: "Vision",
      priority: 100,
      execute: async () => ({ type: CapabilityType.Vision, source: "provider.vision", ok: true, payload: { kind: "text", text: "desc" }, durationMs: 0 }),
      canHandle: () => true,
    });
    const p = new CapabilityPlanner(r);
    // Provider declares Chat only (no Vision) — Vision should be missing.
    const provider = fakeProvider([CapabilityType.Chat]);
    const plan = await p.plan(
      fakeIntent([CapabilityType.Chat, CapabilityType.Vision]),
      provider,
      "fake-model",
      { requestId: "r", sessionId: "s", messages: [], input: "describe image" },
    );
    expect(plan.satisfied).toEqual([CapabilityType.Chat]);
    expect(plan.missing).toHaveLength(1);
    expect(plan.missing[0]!.type).toBe(CapabilityType.Vision);
  });

  it("falls back to provider.capabilities when declareCapability throws", async () => {
    const r = new CapabilityRegistry();
    const p = new CapabilityPlanner(r);
    const provider: IProvider = {
      ...fakeProvider([CapabilityType.Chat, CapabilityType.Vision]),
      declareCapability: async () => { throw new Error("network error"); },
    };
    // Vision is in the fallback set, so it should be satisfied.
    const plan = await p.plan(
      fakeIntent([CapabilityType.Chat, CapabilityType.Vision]),
      provider,
      "fake-model",
      { requestId: "r", sessionId: "s", messages: [], input: "describe image" },
    );
    expect(plan.satisfied).toContain(CapabilityType.Vision);
  });

  describe("filesystem pre-execution (fix: models told they have tools they can't invoke)", () => {
    function planFs(input: string) {
      const r = new CapabilityRegistry();
      r.register({
        id: "tool.fs",
        type: CapabilityType.Filesystem,
        source: "tool",
        label: "FS",
        priority: 1000,
        execute: async () => ({ type: CapabilityType.Filesystem, source: "tool.fs", ok: true, payload: { kind: "text", text: "" }, durationMs: 0 }),
        canHandle: () => true,
      });
      const p = new CapabilityPlanner(r);
      const provider = fakeProvider([CapabilityType.Chat]);
      return p.plan(
        fakeIntent([CapabilityType.Chat, CapabilityType.Filesystem]),
        provider,
        "fake-model",
        { requestId: "r", sessionId: "s", messages: [], input },
      );
    }

    it("pre-executes fs.read for a bare filename mention", async () => {
      const plan = await planFs("what's in package.json?");
      expect(plan.missing[0]!.input.params).toEqual({ op: "read", path: "package.json" });
    });

    it("pre-executes fs.read for a quoted path with spaces", async () => {
      const plan = await planFs(`summarize "C:\\Users\\me\\My Documents\\notes.md" please`);
      expect(plan.missing[0]!.input.params).toEqual({ op: "read", path: "C:\\Users\\me\\My Documents\\notes.md" });
    });

    it("pre-executes fs.read for a relative path", async () => {
      const plan = await planFs("read src\\index.ts and explain it");
      expect(plan.missing[0]!.input.params).toEqual({ op: "read", path: "src\\index.ts" });
    });

    it("uses list (not read) for directory-looking targets", async () => {
      const plan = await planFs("what files are in C:\\projects\\mindi-runtime");
      expect(plan.missing[0]!.input.params).toEqual({ op: "list", path: "C:\\projects\\mindi-runtime" });
    });

    it("skips image paths (handled by vision, not fs.read)", async () => {
      const plan = await planFs(`describe "C:\\pics\\shot one.png"`);
      expect(plan.missing[0]!.input.params).toEqual({ op: "list", path: "" });
    });

    it("falls back to workspace list when no path is mentioned", async () => {
      const plan = await planFs("list the files here");
      expect(plan.missing[0]!.input.params).toEqual({ op: "list", path: "" });
    });
  });
});
