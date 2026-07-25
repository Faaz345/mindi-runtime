import { describe, it, expect } from "vitest";
import { ContextBuilder } from "../src/context/ContextBuilder.js";
import { CapabilityType } from "../src/core/types.js";
import type { CapabilityResult } from "../src/core/types.js";

describe("ContextBuilder", () => {
  const b = new ContextBuilder();

  it("returns null preamble when no capabilities were used", () => {
    expect(b.buildPreamble([])).toBeNull();
  });

  it("returns a human-readable preamble when capabilities were used", () => {
    const p = b.buildPreamble([CapabilityType.Filesystem, CapabilityType.Git]);
    expect(p).toContain("Filesystem");
    expect(p).toContain("Git");
    expect(p).toContain("MINDI Runtime");
  });

  it("formats text payload", () => {
    const r: CapabilityResult = {
      type: CapabilityType.Vision, source: "openai.vision", ok: true,
      payload: { kind: "text", text: "a cat sitting on a sofa" }, durationMs: 100,
    };
    const m = b.buildMessage(r);
    expect(m.role).toBe("capability");
    expect(m.content).toContain("[Capability: Vision");
    expect(m.content).toContain("a cat sitting on a sofa");
  });

  it("formats command payload with exit code and stdout", () => {
    const r: CapabilityResult = {
      type: CapabilityType.Terminal, source: "tool.terminal", ok: true,
      payload: { kind: "command", stdout: "hello", stderr: "", exitCode: 0 }, durationMs: 50,
    };
    const m = b.buildMessage(r);
    expect(m.content).toContain("$ exit code: 0");
    expect(m.content).toContain("hello");
  });

  it("formats search results as numbered list", () => {
    const r: CapabilityResult = {
      type: CapabilityType.WebSearch, source: "tool.search", ok: true,
      payload: {
        kind: "search",
        results: [
          { title: "A", url: "http://a", snippet: "snip a" },
          { title: "B", url: "http://b", snippet: "snip b" },
        ],
      }, durationMs: 100,
    };
    const m = b.buildMessage(r);
    expect(m.content).toContain("1. A");
    expect(m.content).toContain("http://a");
    expect(m.content).toContain("2. B");
  });

  it("includes failure message for failed capability", () => {
    const r: CapabilityResult = {
      type: CapabilityType.Git, source: "tool.git", ok: false,
      payload: { kind: "text", text: "" }, error: "repo not found", durationMs: 0,
    };
    const m = b.buildMessage(r);
    expect(m.content).toContain("FAILED");
    expect(m.content).toContain("repo not found");
  });

  it("formats file payload with path tag", () => {
    const r: CapabilityResult = {
      type: CapabilityType.Filesystem, source: "tool.filesystem", ok: true,
      payload: { kind: "file", path: "/x/y.txt", content: "hello", encoding: "utf8" }, durationMs: 1,
    };
    const m = b.buildMessage(r);
    expect(m.content).toContain('<file path="/x/y.txt">');
    expect(m.content).toContain("hello");
  });
});
