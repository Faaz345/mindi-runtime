import { describe, it, expect } from "vitest";
import { CapabilityRouter } from "../src/router/CapabilityRouter.js";
import { CapabilityRegistry } from "../src/registry/CapabilityRegistry.js";
import { CapabilityType } from "../src/core/types.js";
import type { ExecutionContext, ICapability, PlannedCapability } from "../src/core/types.js";

function makeCtx(): ExecutionContext {
  const ctrl = new AbortController();
  return {
    requestId: "r", sessionId: "s", signal: ctrl.signal,
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
    events: {
      emitted: [] as Array<{ type: string }>,
      emit(e: { type: string }) { this.emitted.push(e); },
      on() { return () => {} },
      clear() { this.emitted.length = 0; },
    } as never,
  };
}

function makeCap(id: string, priority: number, source: "tool" | "provider", ok: boolean): ICapability {
  return {
    id, type: CapabilityType.Filesystem, source, label: id, priority,
    execute: async () => ({
      type: CapabilityType.Filesystem, source: id, ok,
      payload: { kind: "text", text: `result from ${id}` },
      durationMs: 5,
    }),
    canHandle: () => true,
  };
}

function makePlanned(): PlannedCapability {
  return {
    type: CapabilityType.Filesystem,
    input: { type: CapabilityType.Filesystem, params: {}, requestId: "r", sessionId: "s" },
    preferTool: true,
  };
}

describe("CapabilityRouter", () => {
  it("prefers tools over providers when preferTool=true", async () => {
    const r = new CapabilityRegistry();
    r.register(makeCap("provider.fs", 100, "provider", true));
    r.register(makeCap("tool.fs", 1000, "tool", true));
    const router = new CapabilityRouter(r);
    const res = await router.execute(makePlanned(), makeCtx());
    expect(res.source).toBe("tool.fs");
    expect(res.ok).toBe(true);
  });

  it("falls back to a provider when no tool is registered", async () => {
    const r = new CapabilityRegistry();
    r.register(makeCap("provider.fs", 100, "provider", true));
    const router = new CapabilityRouter(r);
    const res = await router.execute(makePlanned(), makeCtx());
    expect(res.source).toBe("provider.fs");
  });

  it("emits capability:dispatch and capability:success events", async () => {
    const r = new CapabilityRegistry();
    r.register(makeCap("tool.fs", 1000, "tool", true));
    const router = new CapabilityRouter(r);
    const ctx = makeCtx();
    await router.execute(makePlanned(), ctx);
    const types = (ctx.events as unknown as { emitted: Array<{ type: string }> }).emitted.map((e) => e.type);
    expect(types).toContain("capability:dispatch");
    expect(types).toContain("capability:success");
  });

  it("returns a structured failure result when executor throws", async () => {
    const r = new CapabilityRegistry();
    const throwing: ICapability = {
      id: "thrower", type: CapabilityType.Filesystem, source: "tool", label: "thrower", priority: 1000,
      execute: async () => { throw new Error("kaboom"); },
      canHandle: () => true,
    };
    r.register(throwing);
    const router = new CapabilityRouter(r);
    const res = await router.execute(makePlanned(), makeCtx());
    expect(res.ok).toBe(false);
    expect(res.error).toContain("kaboom");
  });

  it("throws CapabilityError when no executor exists", async () => {
    const r = new CapabilityRegistry();
    const router = new CapabilityRouter(r);
    await expect(router.execute(makePlanned(), makeCtx())).rejects.toThrow();
  });
});
