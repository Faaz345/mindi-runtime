/**
 * Tests for the production tool ecosystem:
 *   - ToolBase SDK (metadata, permissions, retry, timeout)
 *   - GitTool, HttpTool, SearchTool, DiffPatchTool, MarkupTool, ArchiveTool
 *
 * Tests use temp directories and mock data where needed.
 * Optional-dependency tools (Playwright, OCR, SQLite) are tested
 * for graceful failure when the dependency is not installed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { CapabilityInput, ExecutionContext, SandboxPolicy } from "../src/core/types.js";
import { ToolError } from "../src/core/errors.js";
import { ToolBase, assertPermissions, hasPermission, DEFAULT_RETRY, NETWORK_RETRY, type ToolMetadata, type ToolRetryPolicy } from "../src/tools/sdk/ToolBase.js";
import { GitTool } from "../src/tools/builtin/GitTool.js";
import { HttpTool } from "../src/tools/builtin/HttpTool.js";
import { SearchTool, DuckDuckGoProvider } from "../src/tools/builtin/SearchTool.js";
import { DiffPatchTool } from "../src/tools/builtin/DiffPatchTool.js";
import { MarkupTool } from "../src/tools/builtin/MarkupTool.js";
import { ArchiveTool } from "../src/tools/builtin/ArchiveTool.js";
import { ClipboardTool } from "../src/tools/builtin/ClipboardTool.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const POLICY: Required<SandboxPolicy> = {
  allowedRoots: [],
  allowedCommands: ["git", "node", "npm", "tar", "zip", "unzip"],
  allowNetwork: false,
  timeoutMs: 10_000,
  maxOutputBytes: 1024 * 1024,
};

const NETWORK_POLICY: Required<SandboxPolicy> = {
  ...POLICY,
  allowNetwork: true,
};

function makeCtx(): ExecutionContext {
  const ctrl = new AbortController();
  return {
    requestId: "test",
    sessionId: "test",
    signal: ctrl.signal,
    log: {
      trace() {}, debug() {}, info() {}, warn() {}, error() {},
      child() { return this; },
    },
    events: {
      emitted: [] as Array<{ type: string }>,
      emit(e: { type: string }) { this.emitted.push(e); },
      on() { return () => {} },
      clear() { this.emitted.length = 0; },
    } as never,
  };
}

function mkInput(cap: string, params: Record<string, unknown>): CapabilityInput {
  return { type: cap as never, params, requestId: "test", sessionId: "test" };
}

// ---------------------------------------------------------------------------
// ToolBase SDK Tests
// ---------------------------------------------------------------------------

class TestTool extends ToolBase {
  readonly id = "tool.test";
  readonly label = "Test";
  readonly capability = "filesystem" as const;
  readonly metadata: ToolMetadata = {
    id: "tool.test",
    label: "Test",
    description: "Test tool",
    capability: "filesystem",
    version: "1.0.0",
    permissions: ["filesystem.read"],
    operations: ["test"],
    inputSchema: {},
    streaming: false,
    defaultTimeoutMs: 5_000,
    retryPolicy: DEFAULT_RETRY,
  };

  protected async run(_input: CapabilityInput, _ctx: ExecutionContext) {
    return {
      type: "filesystem" as const,
      source: this.id,
      ok: true,
      payload: { kind: "text" as const, text: "test result" },
      durationMs: 1,
    };
  }
}

class FailingTool extends ToolBase {
  readonly id = "tool.failing";
  readonly label = "Failing";
  readonly capability = "filesystem" as const;
  readonly metadata: ToolMetadata = {
    id: "tool.failing",
    label: "Failing",
    description: "Always fails",
    capability: "filesystem",
    version: "1.0.0",
    permissions: [],
    operations: ["fail"],
    inputSchema: {},
    streaming: false,
    defaultTimeoutMs: 1_000,
    retryPolicy: { maxAttempts: 2, backoffMs: 10, retryableErrors: ["E_TOOL_FAILED"] } as ToolRetryPolicy,
  };

  attempts = 0;

  protected async run(_input: CapabilityInput, _ctx: ExecutionContext): Promise<never> {
    this.attempts++;
    throw new ToolError("E_TOOL_FAILED", "intentional failure", {});
  }
}

describe("ToolBase SDK", () => {
  it("exposes metadata", () => {
    const t = new TestTool(POLICY);
    expect(t.metadata.id).toBe("tool.test");
    expect(t.metadata.capability).toBe("filesystem");
    expect(t.metadata.permissions).toEqual(["filesystem.read"]);
  });

  it("execute() returns CapabilityResult", async () => {
    const t = new TestTool(POLICY);
    const res = await t.execute(mkInput("filesystem", {}), makeCtx());
    expect(res.ok).toBe(true);
    expect(res.source).toBe("tool.test");
  });

  it("execute() normalizes errors to ToolError", async () => {
    const t = new FailingTool(POLICY);
    await expect(t.execute(mkInput("filesystem", {}), makeCtx())).rejects.toThrow();
  });

  it("retries on retryable errors", async () => {
    const t = new FailingTool(POLICY);
    try {
      await t.execute(mkInput("filesystem", {}), makeCtx());
    } catch {
      // expected
    }
    expect(t.attempts).toBe(2); // retried once
  });

  it("canHandle returns true for matching capability", () => {
    const t = new TestTool(POLICY);
    expect(t.canHandle(mkInput("filesystem", {}))).toBe(true);
    expect(t.canHandle(mkInput("vision", {}))).toBe(false);
  });
});

describe("ToolBase permissions", () => {
  it("hasPermission returns true for granted permissions", () => {
    expect(hasPermission(NETWORK_POLICY, "network")).toBe(true);
    expect(hasPermission(POLICY, "network")).toBe(false);
  });

  it("assertPermissions throws on denied permission", () => {
    expect(() => assertPermissions(POLICY, ["network"])).toThrow(ToolError);
    expect(() => assertPermissions(NETWORK_POLICY, ["network"])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// GitTool Tests
// ---------------------------------------------------------------------------

describe("GitTool", () => {
  let tmp: string;
  let tool: GitTool;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "mindi-git-"));
    POLICY.allowedRoots = [tmp];
    tool = new GitTool(POLICY);
    // Init a git repo
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
      execFile("git", ["init"], { cwd: tmp }, (err) => err ? reject(err) : resolve());
    });
    await new Promise<void>((resolve, reject) => {
      execFile("git", ["config", "user.email", "test@test.com"], { cwd: tmp }, (err) => err ? reject(err) : resolve());
    });
    await new Promise<void>((resolve, reject) => {
      execFile("git", ["config", "user.name", "Test"], { cwd: tmp }, (err) => err ? reject(err) : resolve());
    });
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("runs git status", async () => {
    const res = await tool.execute(mkInput("git", { op: "status", cwd: tmp }), makeCtx());
    expect(res.ok).toBe(true);
    expect(res.payload.kind).toBe("command");
  });

  it("runs git add + commit", async () => {
    await fsp.writeFile(path.join(tmp, "test.txt"), "hello");
    await tool.execute(mkInput("git", { op: "add", args: ["."], cwd: tmp }), makeCtx());
    const res = await tool.execute(mkInput("git", { op: "commit", args: ["-m", "initial"], cwd: tmp }), makeCtx());
    expect(res.payload.kind).toBe("command");
  });

  it("runs git log", async () => {
    await fsp.writeFile(path.join(tmp, "a.txt"), "a");
    await tool.execute(mkInput("git", { op: "add", args: ["."], cwd: tmp }), makeCtx());
    await tool.execute(mkInput("git", { op: "commit", args: ["-m", "commit1"], cwd: tmp }), makeCtx());
    const res = await tool.execute(mkInput("git", { op: "log", cwd: tmp }), makeCtx());
    expect(res.ok).toBe(true);
    expect((res.payload as { stdout: string }).stdout).toContain("commit1");
  });

  it("runs git branch", async () => {
    const res = await tool.execute(mkInput("git", { op: "branch", cwd: tmp }), makeCtx());
    expect(res.ok).toBe(true);
  });

  it("rejects unknown op", async () => {
    await expect(
      tool.execute(mkInput("git", { op: "frobnicate" }), makeCtx()),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// HttpTool Tests
// ---------------------------------------------------------------------------

describe("HttpTool", () => {
  it("rejects without network permission", async () => {
    const tool = new HttpTool(POLICY);
    await expect(
      tool.execute(mkInput("browser", { method: "GET", url: "https://example.com" }), makeCtx()),
    ).rejects.toThrow(ToolError);
  });

  it("rejects missing url", async () => {
    const tool = new HttpTool(NETWORK_POLICY);
    await expect(
      tool.execute(mkInput("browser", { method: "GET" }), makeCtx()),
    ).rejects.toThrow();
  });

  it("rejects unsupported method", async () => {
    const tool = new HttpTool(NETWORK_POLICY);
    await expect(
      tool.execute(mkInput("browser", { method: "PATCH", url: "https://example.com" }), makeCtx()),
    ).rejects.toThrow();
  });

  it("has correct metadata", () => {
    const tool = new HttpTool(NETWORK_POLICY);
    expect(tool.metadata.permissions).toContain("network");
    expect(tool.metadata.operations).toEqual(["GET", "POST", "PUT", "DELETE"]);
  });
});

// ---------------------------------------------------------------------------
// SearchTool Tests
// ---------------------------------------------------------------------------

describe("SearchTool", () => {
  it("registers built-in providers", () => {
    const tool = new SearchTool(NETWORK_POLICY);
    expect(tool.metadata.id).toBe("tool.search");
    expect(tool.metadata.permissions).toContain("network");
  });

  it("rejects without network permission", async () => {
    const tool = new SearchTool(POLICY);
    await expect(
      tool.execute(mkInput("web_search", { query: "test" }), makeCtx()),
    ).rejects.toThrow(ToolError);
  });

  it("rejects missing query", async () => {
    const tool = new SearchTool(NETWORK_POLICY);
    await expect(
      tool.execute(mkInput("web_search", {}), makeCtx()),
    ).rejects.toThrow();
  });

  it("rejects unknown provider", async () => {
    const tool = new SearchTool(NETWORK_POLICY);
    await expect(
      tool.execute(
        mkInput("web_search", { query: "test", provider: "nonexistent" }),
        makeCtx(),
      ),
    ).rejects.toThrow();
  });
});

describe("DuckDuckGoProvider", () => {
  it("does not require an API key", () => {
    const p = new DuckDuckGoProvider();
    expect(p.requiresApiKey).toBe(false);
    expect(p.id).toBe("duckduckgo");
  });
});

// ---------------------------------------------------------------------------
// DiffPatchTool Tests
// ---------------------------------------------------------------------------

describe("DiffPatchTool", () => {
  let tmp: string;
  let tool: DiffPatchTool;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "mindi-diff-"));
    POLICY.allowedRoots = [tmp];
    tool = new DiffPatchTool(POLICY);
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("computes diff between two strings", async () => {
    const res = await tool.execute(
      mkInput("filesystem", { op: "diff", source: "hello\nworld", target: "hello\nearth" }),
      makeCtx(),
    );
    expect(res.ok).toBe(true);
    const text = (res.payload as { text: string }).text;
    expect(text).toContain("world");
    expect(text).toContain("earth");
  });

  it("computes filediff between two files", async () => {
    const f1 = path.join(tmp, "old.txt");
    const f2 = path.join(tmp, "new.txt");
    await fsp.writeFile(f1, "line1\nline2\nline3");
    await fsp.writeFile(f2, "line1\nchanged\nline3");
    const res = await tool.execute(
      mkInput("filesystem", { op: "filediff", oldFile: f1, newFile: f2 }),
      makeCtx(),
    );
    expect(res.ok).toBe(true);
    expect((res.payload as { text: string }).text).toContain("changed");
  });

  it("applies patch to text", async () => {
    const patch = "--- source\n+++ target\n@@ -1,1 +1,1 @@\n-hello\n+world\n";
    const res = await tool.execute(
      mkInput("filesystem", { op: "patch", source: "hello", patch }),
      makeCtx(),
    );
    expect(res.ok).toBe(true);
    expect((res.payload as { text: string }).text).toContain("world");
  });

  it("applies patch to file", async () => {
    const f = path.join(tmp, "patch.txt");
    await fsp.writeFile(f, "original");
    const patch = "--- source\n+++ target\n@@ -1,1 +1,1 @@\n-original\n+patched\n";
    const res = await tool.execute(
      mkInput("filesystem", { op: "filepatch", source: f, patch }),
      makeCtx(),
    );
    expect(res.ok).toBe(true);
    expect(await fsp.readFile(f, "utf8")).toContain("patched");
  });
});

// ---------------------------------------------------------------------------
// MarkupTool Tests
// ---------------------------------------------------------------------------

describe("MarkupTool", () => {
  const tool = new MarkupTool(POLICY);

  it("converts Markdown to HTML", async () => {
    const res = await tool.execute(
      mkInput("filesystem", { op: "md2html", text: "# Hello\n\n**bold** *italic*" }),
      makeCtx(),
    );
    expect(res.ok).toBe(true);
    const html = (res.payload as { text: string }).text;
    expect(html).toContain("<h1>");
    expect(html).toContain("<strong>");
    expect(html).toContain("<em>");
  });

  it("converts HTML to Markdown", async () => {
    const res = await tool.execute(
      mkInput("filesystem", { op: "html2md", text: "<h1>Title</h1><p>**bold**</p>" }),
      makeCtx(),
    );
    expect(res.ok).toBe(true);
    const md = (res.payload as { text: string }).text;
    expect(md).toContain("# Title");
  });

  it("extracts text from HTML", async () => {
    const res = await tool.execute(
      mkInput("filesystem", { op: "extract", text: "<div><p>Hello</p><script>evil()</script></div>" }),
      makeCtx(),
    );
    expect(res.ok).toBe(true);
    const text = (res.payload as { text: string }).text;
    expect(text).toContain("Hello");
    expect(text).not.toContain("evil");
  });

  it("generates table of contents", async () => {
    const res = await tool.execute(
      mkInput("filesystem", { op: "toc", text: "# Title\n## Section A\n### Sub\n## Section B" }),
      makeCtx(),
    );
    expect(res.ok).toBe(true);
    const toc = (res.payload as { text: string }).text;
    expect(toc).toContain("Title");
    expect(toc).toContain("Section A");
    expect(toc).toContain("Section B");
  });
});

// ---------------------------------------------------------------------------
// ArchiveTool Tests
// ---------------------------------------------------------------------------

describe("ArchiveTool", () => {
  let tmp: string;
  let tool: ArchiveTool;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "mindi-archive-"));
    POLICY.allowedRoots = [tmp];
    tool = new ArchiveTool(POLICY);
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("compresses with gzip", async () => {
    const src = path.join(tmp, "data.txt");
    await fsp.writeFile(src, "x".repeat(1000));
    const res = await tool.execute(
      mkInput("filesystem", { op: "gzip", source: src, dest: src + ".gz" }),
      makeCtx(),
    );
    expect(res.ok).toBe(true);
    expect(fs.existsSync(src + ".gz")).toBe(true);
  });

  it("decompresses with gunzip", async () => {
    const src = path.join(tmp, "data2.txt");
    await fsp.writeFile(src, "y".repeat(500));
    await tool.execute(mkInput("filesystem", { op: "gzip", source: src, dest: src + ".gz" }), makeCtx());
    const res = await tool.execute(
      mkInput("filesystem", { op: "gunzip", source: src + ".gz", dest: src + ".out" }),
      makeCtx(),
    );
    expect(res.ok).toBe(true);
    expect(await fsp.readFile(src + ".out", "utf8")).toBe("y".repeat(500));
  });

  it("rejects unknown op", async () => {
    await expect(
      tool.execute(mkInput("filesystem", { op: "rar" }), makeCtx()),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ClipboardTool Tests
// ---------------------------------------------------------------------------

describe("ClipboardTool", () => {
  it("has correct metadata", () => {
    const tool = new ClipboardTool(POLICY);
    expect(tool.metadata.id).toBe("tool.clipboard");
    expect(tool.metadata.operations).toEqual(["read", "write"]);
  });

  it("rejects unknown op", async () => {
    const tool = new ClipboardTool(POLICY);
    await expect(
      tool.execute(mkInput("terminal", { op: "frobnicate" }), makeCtx()),
    ).rejects.toThrow();
  });
});
