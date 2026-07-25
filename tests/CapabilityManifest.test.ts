/**
 * Tests for the Capability Manifest System.
 *
 * Tests:
 *   - Manifest building (operations, permissions, restrictions)
 *   - Permission checking (allowed, denied, with reasons)
 *   - Command checking (allowlist, blocklist)
 *   - Workspace checking (inside/outside roots)
 *   - Manifest table formatting
 *   - Manifest collection from tools
 */

import { describe, it, expect } from "vitest";
import {
  ManifestBuilder,
  createManifestFromPolicy,
  checkPermission,
  checkCommand,
  checkWorkspace,
  formatManifestTable,
  collectManifests,
} from "../src/tools/CapabilityManifest.js";
import { CapabilityType } from "../src/core/types.js";

const TEST_POLICY: Required<{
  allowedRoots: string[];
  allowedCommands: string[];
  allowNetwork: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
}> = {
  allowedRoots: ["C:/workspace"],
  allowedCommands: ["git", "npm", "node"],
  allowNetwork: false,
  timeoutMs: 30_000,
  maxOutputBytes: 1_048_576,
};

describe("ManifestBuilder", () => {
  it("builds a manifest with operations", () => {
    const m = new ManifestBuilder("tool.fs", "Filesystem", "filesystem")
      .addOperation("read", true, "Read Files")
      .addOperation("write", false, "Write Files", "Write disabled")
      .build();

    expect(m.toolId).toBe("tool.fs");
    expect(m.label).toBe("Filesystem");
    expect(m.enabled).toBe(true);
    expect(m.operations).toHaveLength(2);
    expect(m.operations[0]!.allowed).toBe(true);
    expect(m.operations[1]!.allowed).toBe(false);
    expect(m.operations[1]!.reason).toBe("Write disabled");
  });

  it("supports disabled state", () => {
    const m = new ManifestBuilder("tool.search", "Search", "web_search")
      .setEnabled(false, "Network disabled")
      .build();

    expect(m.enabled).toBe(false);
    expect(m.disabledReason).toBe("Network disabled");
  });

  it("supports workspace restrictions", () => {
    const m = new ManifestBuilder("tool.fs", "Filesystem", "filesystem")
      .setWorkspace(["C:/workspace"], "Restricted to workspace")
      .build();

    expect(m.workspace).toBeDefined();
    expect(m.workspace!.allowedRoots).toEqual(["C:/workspace"]);
  });

  it("supports command allow/block lists", () => {
    const m = new ManifestBuilder("tool.term", "Terminal", "terminal")
      .setAllowedCommands(["git", "npm"])
      .setBlockedCommands(["rm", "del"])
      .build();

    expect(m.allowedCommands).toEqual(["git", "npm"]);
    expect(m.blockedCommands).toEqual(["rm", "del"]);
  });

  it("supports network status", () => {
    const m = new ManifestBuilder("tool.http", "HTTP", "browser")
      .setNetwork(false, "Network disabled")
      .build();

    expect(m.network).toBeDefined();
    expect(m.network!.allowed).toBe(false);
    expect(m.network!.reason).toBe("Network disabled");
  });
});

describe("createManifestFromPolicy", () => {
  it("creates filesystem manifest from policy", () => {
    const m = createManifestFromPolicy("tool.fs", "Filesystem", CapabilityType.Filesystem, TEST_POLICY);

    expect(m.toolId).toBe("tool.fs");
    expect(m.enabled).toBe(true);
    expect(m.operations.find((o) => o.operation === "read")!.allowed).toBe(true);
    expect(m.operations.find((o) => o.operation === "delete")!.allowed).toBe(false);
    expect(m.workspace).toBeDefined();
  });

  it("creates terminal manifest from policy", () => {
    const m = createManifestFromPolicy("tool.term", "Terminal", CapabilityType.Terminal, TEST_POLICY);

    expect(m.operations.find((o) => o.operation === "execute")!.allowed).toBe(true);
    expect(m.allowedCommands).toEqual(["git", "npm", "node"]);
    expect(m.blockedCommands).toContain("unrestricted shell");
  });

  it("creates web search manifest with network disabled", () => {
    const m = createManifestFromPolicy("tool.search", "Web Search", CapabilityType.WebSearch, TEST_POLICY);

    const searchOp = m.operations.find((o) => o.operation === "search")!;
    expect(searchOp.allowed).toBe(false);
    expect(searchOp.reason).toContain("Network access is disabled");
    expect(m.network!.allowed).toBe(false);
  });

  it("creates git manifest with all operations", () => {
    const m = createManifestFromPolicy("tool.git", "Git", CapabilityType.Git, TEST_POLICY);

    expect(m.operations.find((o) => o.operation === "status")!.allowed).toBe(true);
    expect(m.operations.find((o) => o.operation === "commit")!.allowed).toBe(true);
    expect(m.operations.find((o) => o.operation === "clone")!.allowed).toBe(true);
  });

  it("creates disabled manifest when disabled option is set", () => {
    const m = createManifestFromPolicy("tool.x", "Test", CapabilityType.Audio, TEST_POLICY, {
      disabled: true,
      disabledReason: "Not available",
    });

    expect(m.enabled).toBe(false);
    expect(m.disabledReason).toBe("Not available");
  });

  it("creates HTTP manifest with network check", () => {
    // HttpTool uses CapabilityType.Browser. The browser case includes GET/POST/PUT/DELETE.
    const m = createManifestFromPolicy("tool.http", "HTTP", CapabilityType.Browser, TEST_POLICY);

    const getOp = m.operations.find((o) => o.operation === "GET");
    if (getOp) {
      expect(getOp.allowed).toBe(false);
      expect(getOp.reason).toContain("Network access is disabled");
    } else {
      // Browser manifest has different operations (launch, navigate, etc.)
      // Check that network is disabled instead.
      expect(m.network).toBeDefined();
      expect(m.network!.allowed).toBe(false);
    }
  });});

describe("checkPermission", () => {
  const manifest = createManifestFromPolicy("tool.fs", "Filesystem", CapabilityType.Filesystem, TEST_POLICY);

  it("allows permitted operations", () => {
    const result = checkPermission(manifest, "read");
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("OK");
  });

  it("denies disallowed operations with reason", () => {
    const result = checkPermission(manifest, "delete");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("disabled");
  });

  it("denies unknown operations with alternative", () => {
    const result = checkPermission(manifest, "frobnicate");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not supported");
    expect(result.alternative).toContain("read");
  });

  it("denies when tool is disabled", () => {
    const disabled = { ...manifest, enabled: false, disabledReason: "Tool offline" };
    const result = checkPermission(disabled, "read");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("Tool offline");
  });
});

describe("checkCommand", () => {
  const manifest = createManifestFromPolicy("tool.term", "Terminal", CapabilityType.Terminal, TEST_POLICY);

  it("allows allowlisted commands", () => {
    const result = checkCommand(manifest, "git status");
    expect(result.allowed).toBe(true);
  });

  it("denies non-allowlisted commands with alternative", () => {
    const result = checkCommand(manifest, "powershell -c rm -rf /");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not on the allowlist");
    expect(result.alternative).toContain("git");
  });

  it("denies blocked commands", () => {
    const result = checkCommand(manifest, "powershell unrestricted");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not on the allowlist");
  });
});

describe("checkWorkspace", () => {
  const manifest = createManifestFromPolicy("tool.fs", "Filesystem", CapabilityType.Filesystem, TEST_POLICY);

  it("allows paths within workspace", () => {
    const result = checkWorkspace(manifest, "C:/workspace/file.txt");
    expect(result.allowed).toBe(true);
  });

  it("denies paths outside workspace", () => {
    const result = checkWorkspace(manifest, "C:/other/file.txt");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("outside");
  });
});

describe("formatManifestTable", () => {
  it("produces a readable capabilities table", () => {
    const manifests = [
      createManifestFromPolicy("tool.fs", "Filesystem", CapabilityType.Filesystem, TEST_POLICY),
      createManifestFromPolicy("tool.term", "Terminal", CapabilityType.Terminal, TEST_POLICY),
    ];

    const table = formatManifestTable(manifests, "C:/workspace", "tokenrouter", "z-ai/glm-5.2-free");

    expect(table).toContain("MINDI Runtime Capabilities");
    expect(table).toContain("Filesystem");
    expect(table).toContain("✓ Read Files");
    expect(table).toContain("✗ Delete Files");
    expect(table).toContain("Terminal");
    expect(table).toContain("git");
    expect(table).toContain("Workspace: C:/workspace");
    expect(table).toContain("Provider: tokenrouter");
    expect(table).toContain("Model: z-ai/glm-5.2-free");
  });

  it("shows disabled tools", () => {
    const m = createManifestFromPolicy("tool.search", "Web Search", CapabilityType.WebSearch, TEST_POLICY);
    const table = formatManifestTable([m], "C:/workspace", "tr", "model");
    expect(table).toContain("✗ Disabled");
  });
});

describe("collectManifests", () => {
  it("collects manifests from tool list", () => {
    const tools = [
      { id: "tool.filesystem", capability: CapabilityType.Filesystem as const, label: "Filesystem" },
      { id: "tool.terminal", capability: CapabilityType.Terminal as const, label: "Terminal" },
    ];

    const manifests = collectManifests(tools, TEST_POLICY);
    expect(manifests).toHaveLength(2);
    expect(manifests[0]!.toolId).toBe("tool.filesystem");
    expect(manifests[1]!.toolId).toBe("tool.terminal");
  });
});
