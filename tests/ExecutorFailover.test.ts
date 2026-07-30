import { describe, it, expect } from "vitest";
import { GraphBuilder } from "../src/planner/ExecutionGraph.js";
import { GraphExecutor, type NodeResult } from "../src/planner/GraphExecutor.js";
import { CapabilityRegistry } from "../src/registry/CapabilityRegistry.js";
import { CapabilityRouter } from "../src/router/CapabilityRouter.js";
import { CapabilityType } from "../src/core/types.js";
import type {
  CapabilityInput,
  CapabilityResult,
  ChatChunk,
  ChatRequest,
  ExecutionContext,
  ICapability,
  IProvider,
  ProviderCapabilityDeclaration,
} from "../src/core/types.js";
import { Runtime } from "../src/runtime/Runtime.js";

function makeCtx(): ExecutionContext & { emitted: Array<{ type: string; [k: string]: unknown }> } {
  const emitted: Array<{ type: string; [k: string]: unknown }> = [];
  const ctrl = new AbortController();
  return {
    requestId: "r",
    sessionId: "s",
    signal: ctrl.signal,
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
    events: {
      emit(e: { type: string; [k: string]: unknown }) { emitted.push(e); },
      on() { return () => {} },
      clear() { emitted.length = 0; },
    },
    emitted,
  } as never;
}

function capResult(id: string, type: CapabilityType, ok: boolean, text: string, error?: string): CapabilityResult {
  return { type, source: id, ok, payload: { kind: "text", text }, error, durationMs: 1 };
}

// ---------------------------------------------------------------------------
// GraphExecutor: fail over to the next executor when one fails
// ---------------------------------------------------------------------------

describe("GraphExecutor — executor failover", () => {
  function failingCap(id: string, type: CapabilityType, error: string): ICapability {
    return {
      id, type, source: "provider", label: id, priority: 100,
      execute: async () => capResult(id, type, false, "", error),
      canHandle: () => true,
    };
  }
  function okCap(id: string, type: CapabilityType, text: string): ICapability {
    return {
      id, type, source: "provider", label: id, priority: 100,
      execute: async () => capResult(id, type, true, text),
      canHandle: () => true,
    };
  }

  it("falls through to the next executor when the first returns ok:false", async () => {
    const reg = new CapabilityRegistry();
    reg.register(failingCap("custom.vision", CapabilityType.Vision, "No vision-capable model available"));
    reg.register(okCap("open-router.vision", CapabilityType.Vision, "a cat"));
    const executor = new GraphExecutor(new CapabilityRouter(reg));

    const b = new GraphBuilder("g");
    b.addNode({ id: "n1", capability: CapabilityType.Vision, input: { type: CapabilityType.Vision, params: {}, requestId: "r", sessionId: "s" }, executorType: "auto" });
    const ctx = makeCtx();

    const results: NodeResult[] = [];
    for await (const r of executor.execute(b.build(), ctx)) results.push(r);

    expect(results).toHaveLength(1);
    expect(results[0]!.result.ok).toBe(true);
    expect(results[0]!.result.source).toBe("open-router.vision");
    // The intermediate failure was surfaced for observability.
    expect(ctx.emitted.some((e) => e.type === "capability:error" && e.capabilityId === "custom.vision")).toBe(true);
  });

  it("returns the last failure when every executor fails", async () => {
    const reg = new CapabilityRegistry();
    reg.register(failingCap("pA.vision", CapabilityType.Vision, "no model on pA"));
    reg.register(failingCap("pB.vision", CapabilityType.Vision, "no model on pB"));
    const executor = new GraphExecutor(new CapabilityRouter(reg));

    const b = new GraphBuilder("g");
    b.addNode({ id: "n1", capability: CapabilityType.Vision, input: { type: CapabilityType.Vision, params: {}, requestId: "r", sessionId: "s" }, executorType: "auto" });

    const results: NodeResult[] = [];
    for await (const r of executor.execute(b.build(), makeCtx())) results.push(r);

    expect(results).toHaveLength(1);
    expect(results[0]!.result.ok).toBe(false);
    expect(results[0]!.result.error).toContain("no model on pB");
  });
});

// ---------------------------------------------------------------------------
// Runtime: provider-level failover + anti-flailing system notes
// ---------------------------------------------------------------------------

interface FakeProviderOpts {
  caps?: CapabilityType[];
  visionCalls?: CapabilityInput[];
  visionResult?: CapabilityResult;
  chatCapture?: ChatRequest[];
}

function fakeProvider(id: string, opts: FakeProviderOpts = {}): IProvider {
  const caps = new Set(opts.caps ?? [CapabilityType.Chat, CapabilityType.Vision]);
  return {
    id,
    label: id,
    capabilities: caps,
    listModels: async () => [],
    hasModel: async () => true,
    hasCapability: (t) => caps.has(t),
    declareCapability: async (modelId: string): Promise<ProviderCapabilityDeclaration> => ({
      providerId: id, modelId, label: modelId,
      capabilities: [CapabilityType.Chat], // text-only model
      streaming: true, toolCalling: false, multimodal: false,
      embeddingSupport: false, imageGeneration: false, audioSupport: false,
      maxContext: 8192, metadata: {}, resolvedAt: Date.now(),
    }),
    chat: (req: ChatRequest) => {
      opts.chatCapture?.push(req);
      return (async function* (): AsyncIterable<ChatChunk> {
        yield { delta: "I cannot analyze the image right now." };
        yield { done: true, finishReason: "stop" };
      })();
    },
    executeCapability: async (_type: CapabilityType, input: CapabilityInput) => {
      opts.visionCalls?.push(input);
      return opts.visionResult ?? capResult(`${id}.vision`, CapabilityType.Vision, false, "", `No vision-capable model available on provider "${id}"`);
    },
    health: async () => ({ providerId: id, ok: true }),
  };
}

function makeRuntime(): Runtime {
  return new Runtime({
    defaultProviderId: "pA",
    defaultModel: "m1",
    logLevel: "error",
    providers: {},
    sandbox: { allowedRoots: [process.cwd()], allowedCommands: [], allowNetwork: true },
    workspace: { enabled: false },
  });
}

describe("Runtime — vision augmentation failover + anti-flailing notes", () => {
  it("fails vision over to a second provider and injects the analysis (no failure note)", async () => {
    const visionCallsA: CapabilityInput[] = [];
    const visionCallsB: CapabilityInput[] = [];
    const chatCapture: ChatRequest[] = [];
    const rt = makeRuntime();
    rt.registerProvider(fakeProvider("pA", { visionCalls: visionCallsA, chatCapture }));
    rt.registerProvider(fakeProvider("pB", {
      visionCalls: visionCallsB,
      visionResult: capResult("pB.vision", CapabilityType.Vision, true, "A line-art tribal logo in thin monochrome strokes."),
    }));

    const sess = rt.createSession({ providerId: "pA", modelId: "m1" });
    for await (const _ of rt.request({
      sessionId: sess.id,
      text: "recreate C:\\no-such-dir-xyz\\missing.png as a webpage",
    })) { /* drain */ }

    // Both providers were tried, in order.
    expect(visionCallsA.length).toBeGreaterThan(0);
    expect(visionCallsB.length).toBeGreaterThan(0);
    // The successful analysis reached the model as a capability message.
    const json = JSON.stringify(chatCapture[0]!.messages);
    expect(json).toContain("line-art tribal logo");
    // No "failed on every provider" note when a fallback succeeded.
    expect(json).not.toContain("FAILED on every configured");
  });

  it("injects a don't-flail note when vision fails on EVERY provider", async () => {
    const chatCapture: ChatRequest[] = [];
    const rt = makeRuntime();
    rt.registerProvider(fakeProvider("pA", { chatCapture }));
    rt.registerProvider(fakeProvider("pB"));

    const sess = rt.createSession({ providerId: "pA", modelId: "m1" });
    for await (const _ of rt.request({
      sessionId: sess.id,
      text: "recreate C:\\no-such-dir-xyz\\missing.png as a webpage",
    })) { /* drain */ }

    const json = JSON.stringify(chatCapture[0]!.messages);
    expect(json).toContain("FAILED on every configured");
    expect(json).toContain("Never fabricate an analysis from the filename");
  });

  it("warns about unreadable image paths for any model", async () => {
    const chatCapture: ChatRequest[] = [];
    const rt = makeRuntime();
    rt.registerProvider(fakeProvider("pA", { chatCapture }));

    const sess = rt.createSession({ providerId: "pA", modelId: "m1" });
    for await (const _ of rt.request({
      sessionId: sess.id,
      text: "whats in this image? C:\\no-such-dir-xyz\\missing.png",
    })) { /* drain */ }

    expect(JSON.stringify(chatCapture[0]!.messages)).toContain("could not be read from disk");
  });
});
