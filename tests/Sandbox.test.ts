import { describe, it, expect } from "vitest";
import { Sandbox } from "../src/tools/sandbox/Sandbox.js";
import { ToolError } from "../src/core/errors.js";
import path from "node:path";

describe("Sandbox", () => {
  const policy = {
    allowedRoots: [process.cwd()],
    allowedCommands: ["git", "node", "npm", "echo"],
    allowNetwork: false,
    timeoutMs: 5000,
    maxOutputBytes: 100,
  };

  it("resolves paths within allowed roots", () => {
    const sb = new Sandbox(policy);
    const p = sb.resolvePath("./package.json");
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.endsWith("package.json")).toBe(true);
  });

  it("rejects paths outside allowed roots", () => {
    const sb = new Sandbox(policy);
    expect(() => sb.resolvePath("../../etc/passwd")).toThrow(ToolError);
    expect(() => sb.resolvePath("C:\\Windows\\System32\\drivers\\etc\\hosts")).toThrow(ToolError);
  });

  it("enforces command allowlist", () => {
    const sb = new Sandbox(policy);
    expect(() => sb.assertCommand("rm -rf /")).toThrow(ToolError);
    expect(() => sb.assertCommand("git status")).not.toThrow();
  });

  it("blocks network by default", () => {
    const sb = new Sandbox(policy);
    expect(() => sb.assertNetwork("https://example.com")).toThrow(ToolError);
  });

  it("permits network when enabled", () => {
    const sb = new Sandbox({ ...policy, allowNetwork: true });
    expect(() => sb.assertNetwork("https://example.com")).not.toThrow();
  });

  it("caps output at maxOutputBytes", () => {
    const sb = new Sandbox(policy);
    const out = sb.capOutput("x".repeat(1000));
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.data, "utf8")).toBeLessThanOrEqual(policy.maxOutputBytes);
  });

  it("does not truncate short output", () => {
    const sb = new Sandbox(policy);
    const out = sb.capOutput("hi");
    expect(out.truncated).toBe(false);
    expect(out.data).toBe("hi");
  });
});
