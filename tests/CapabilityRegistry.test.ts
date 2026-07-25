import { describe, it, expect } from "vitest";
import { CapabilityRegistry } from "../src/registry/CapabilityRegistry.js";
import { CapabilityType } from "../src/core/types.js";
import type { ICapability } from "../src/core/types.js";

function makeCap(id: string, type: CapabilityType, priority: number, source: "tool" | "provider" = "tool"): ICapability {
  return {
    id,
    type,
    source,
    label: id,
    priority,
    execute: async () => ({
      type,
      source: id,
      ok: true,
      payload: { kind: "text", text: "" },
      durationMs: 0,
    }),
    canHandle: () => true,
  };
}

describe("CapabilityRegistry", () => {
  it("registers and retrieves by type", () => {
    const r = new CapabilityRegistry();
    const cap = makeCap("fs", CapabilityType.Filesystem, 1000);
    r.register(cap);
    expect(r.getByType(CapabilityType.Filesystem)).toHaveLength(1);
    expect(r.get("fs")).toBe(cap);
    expect(r.has(CapabilityType.Filesystem)).toBe(true);
    expect(r.has(CapabilityType.Vision)).toBe(false);
  });

  it("sorts executors by priority desc", () => {
    const r = new CapabilityRegistry();
    r.register(makeCap("low", CapabilityType.Vision, 100, "provider"));
    r.register(makeCap("high", CapabilityType.Vision, 1000, "tool"));
    const list = r.getByType(CapabilityType.Vision);
    expect(list[0]!.id).toBe("high");
    expect(list[1]!.id).toBe("low");
  });

  it("rejects duplicate ids", () => {
    const r = new CapabilityRegistry();
    r.register(makeCap("fs", CapabilityType.Filesystem, 1000));
    expect(() => r.register(makeCap("fs", CapabilityType.Filesystem, 1000))).toThrow();
  });

  it("unregisters by id", () => {
    const r = new CapabilityRegistry();
    r.register(makeCap("fs", CapabilityType.Filesystem, 1000));
    expect(r.unregister("fs")).toBe(true);
    expect(r.has(CapabilityType.Filesystem)).toBe(false);
    expect(r.unregister("fs")).toBe(false);
  });

  it("lists all registered ids", () => {
    const r = new CapabilityRegistry();
    r.register(makeCap("fs", CapabilityType.Filesystem, 1000));
    r.register(makeCap("git", CapabilityType.Git, 1000));
    expect(r.list().sort()).toEqual(["fs", "git"]);
  });
});
