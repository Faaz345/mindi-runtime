/**
 * Tests for the Capability Availability Tracker and Network Policy system.
 *
 * Tests:
 *   - Availability states (registered, available, unavailable)
 *   - Network policy levels (offline, provider-only, trusted-domains, full)
 *   - Network access checking per policy
 *   - Health table formatting
 *   - Unavailable reason messages for model context injection
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CapabilityAvailabilityTracker, formatHealthTable } from "../src/tools/CapabilityAvailabilityTracker.js";
import { CapabilityRegistry } from "../src/registry/CapabilityRegistry.js";
import { CapabilityType } from "../src/core/types.js";
import {
  createNetworkPolicy,
  checkNetworkAccess,
  booleanToPolicy,
  formatNetworkPolicy,
  type NetworkPolicy,
} from "../src/tools/NetworkPolicy.js";

// ---------------------------------------------------------------------------
// Network Policy Tests
// ---------------------------------------------------------------------------

describe("NetworkPolicy", () => {
  it("creates offline policy", () => {
    const cfg = createNetworkPolicy("offline");
    expect(cfg.policy).toBe("offline");
    expect(cfg.trustedDomains.length).toBeGreaterThan(0);
  });

  it("creates provider-only policy", () => {
    const cfg = createNetworkPolicy("provider-only", undefined, ["api.tokenrouter.com"]);
    expect(cfg.policy).toBe("provider-only");
    expect(cfg.providerEndpoints).toContain("api.tokenrouter.com");
  });

  it("creates trusted-domains policy with custom domains", () => {
    const cfg = createNetworkPolicy("trusted-domains", [
      { pattern: "example.com", label: "Example" },
    ]);
    expect(cfg.policy).toBe("trusted-domains");
    expect(cfg.trustedDomains).toHaveLength(1);
  });

  it("creates full policy", () => {
    const cfg = createNetworkPolicy("full");
    expect(cfg.policy).toBe("full");
  });

  it("converts boolean true to full", () => {
    expect(booleanToPolicy(true)).toBe("full");
  });

  it("converts boolean false to offline", () => {
    expect(booleanToPolicy(false)).toBe("offline");
  });
});

describe("checkNetworkAccess", () => {
  it("blocks all URLs in offline mode", () => {
    const cfg = createNetworkPolicy("offline");
    const result = checkNetworkAccess("https://api.openai.com/v1/chat", cfg);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("offline");
  });

  it("allows provider endpoints in provider-only mode", () => {
    const cfg = createNetworkPolicy("provider-only", undefined, ["api.openai.com"]);
    const result = checkNetworkAccess("https://api.openai.com/v1/chat", cfg);
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("provider");
  });

  it("blocks non-provider URLs in provider-only mode", () => {
    const cfg = createNetworkPolicy("provider-only", undefined, ["api.openai.com"]);
    const result = checkNetworkAccess("https://example.com/page", cfg);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("provider endpoints only");
  });

  it("allows trusted domains", () => {
    const cfg = createNetworkPolicy("trusted-domains", [
      { pattern: "github.com", label: "GitHub" },
    ]);
    const result = checkNetworkAccess("https://github.com/repo", cfg);
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("GitHub");
  });

  it("blocks non-trusted domains", () => {
    const cfg = createNetworkPolicy("trusted-domains", [
      { pattern: "github.com", label: "GitHub" },
    ]);
    const result = checkNetworkAccess("https://evil.com/hack", cfg);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("trusted");
  });

  it("allows all URLs in full mode", () => {
    const cfg = createNetworkPolicy("full");
    const result = checkNetworkAccess("https://anything.com/anywhere", cfg);
    expect(result.allowed).toBe(true);
  });
});

describe("formatNetworkPolicy", () => {
  it("formats offline", () => {
    const cfg = createNetworkPolicy("offline");
    expect(formatNetworkPolicy(cfg)).toContain("Offline");
  });

  it("formats provider-only", () => {
    const cfg = createNetworkPolicy("provider-only", undefined, ["api.test.com"]);
    const text = formatNetworkPolicy(cfg);
    expect(text).toContain("Provider-only");
    expect(text).toContain("1 endpoints");
  });

  it("formats trusted-domains", () => {
    const cfg = createNetworkPolicy("trusted-domains", [
      { pattern: "a.com", label: "A" },
      { pattern: "b.com", label: "B" },
    ]);
    const text = formatNetworkPolicy(cfg);
    expect(text).toContain("Trusted domains");
    expect(text).toContain("2 domains");
  });

  it("formats full", () => {
    const cfg = createNetworkPolicy("full");
    expect(formatNetworkPolicy(cfg)).toContain("Full internet");
  });
});

// ---------------------------------------------------------------------------
// Capability Availability Tracker Tests
// ---------------------------------------------------------------------------

const OFFLINE_POLICY: Required<{
  allowedRoots: string[];
  allowedCommands: string[];
  allowNetwork: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
}> = {
  allowedRoots: [],
  allowedCommands: [],
  allowNetwork: false,
  timeoutMs: 30_000,
  maxOutputBytes: 1_048_576,
};

const FULL_POLICY: Required<{
  allowedRoots: string[];
  allowedCommands: string[];
  allowNetwork: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
}> = {
  allowedRoots: ["C:/workspace"],
  allowedCommands: ["git", "npm"],
  allowNetwork: true,
  timeoutMs: 30_000,
  maxOutputBytes: 1_048_576,
};

describe("CapabilityAvailabilityTracker", () => {
  let registry: CapabilityRegistry;
  let tracker: CapabilityAvailabilityTracker;

  beforeEach(() => {
    registry = new CapabilityRegistry();
    const netPolicy = createNetworkPolicy("offline");
    tracker = new CapabilityAvailabilityTracker(registry, OFFLINE_POLICY, netPolicy);
  });

  it("marks unregistered capabilities as unavailable", () => {
    const avail = tracker.checkCapability(CapabilityType.WebSearch);
    expect(avail.state).toBe("unavailable");
    expect(avail.unavailableReason).toContain("No executor registered");
    expect(avail.healthStatus).toBe("down");
  });

  it("marks registered capabilities as available when policy allows", () => {
    // Register a filesystem tool.
    registry.register({
      id: "tool.fs",
      type: CapabilityType.Filesystem,
      source: "tool",
      label: "Filesystem",
      priority: 1000,
      execute: async () => ({ type: CapabilityType.Filesystem, source: "tool.fs", ok: true, payload: { kind: "text", text: "" }, durationMs: 0 }),
      canHandle: () => true,
    });

    // Use a policy with workspace roots.
    const fullTracker = new CapabilityAvailabilityTracker(registry, FULL_POLICY, createNetworkPolicy("full"));
    const avail = fullTracker.checkCapability(CapabilityType.Filesystem);
    expect(avail.state).toBe("available");
    expect(avail.healthStatus).toBe("healthy");
    expect(avail.manifest).toBeDefined();
  });

  it("marks filesystem unavailable when no workspace roots", () => {
    registry.register({
      id: "tool.fs",
      type: CapabilityType.Filesystem,
      source: "tool",
      label: "Filesystem",
      priority: 1000,
      execute: async () => ({ type: CapabilityType.Filesystem, source: "tool.fs", ok: true, payload: { kind: "text", text: "" }, durationMs: 0 }),
      canHandle: () => true,
    });

    const avail = tracker.checkCapability(CapabilityType.Filesystem);
    expect(avail.state).toBe("unavailable");
    expect(avail.unavailableReason).toContain("workspace");
  });

  it("marks terminal unavailable when no commands allowed", () => {
    registry.register({
      id: "tool.term",
      type: CapabilityType.Terminal,
      source: "tool",
      label: "Terminal",
      priority: 1000,
      execute: async () => ({ type: CapabilityType.Terminal, source: "tool.term", ok: true, payload: { kind: "text", text: "" }, durationMs: 0 }),
      canHandle: () => true,
    });

    const avail = tracker.checkCapability(CapabilityType.Terminal);
    expect(avail.state).toBe("unavailable");
    expect(avail.unavailableReason).toContain("commands");
  });

  it("marks web search unavailable when network disabled", () => {
    registry.register({
      id: "tool.search",
      type: CapabilityType.WebSearch,
      source: "tool",
      label: "Web Search",
      priority: 1000,
      execute: async () => ({ type: CapabilityType.WebSearch, source: "tool.search", ok: true, payload: { kind: "text", text: "" }, durationMs: 0 }),
      canHandle: () => true,
    });

    const avail = tracker.checkCapability(CapabilityType.WebSearch);
    expect(avail.state).toBe("unavailable");
    expect(avail.unavailableReason).toContain("Network");
  });

  it("isAvailable returns false for unregistered capabilities", () => {
    expect(tracker.isAvailable(CapabilityType.Audio)).toBe(false);
  });

  it("getUnavailableReason returns structured message", () => {
    registry.register({
      id: "tool.search",
      type: CapabilityType.WebSearch,
      source: "tool",
      label: "Web Search",
      priority: 1000,
      execute: async () => ({ type: CapabilityType.WebSearch, source: "tool.search", ok: true, payload: { kind: "text", text: "" }, durationMs: 0 }),
      canHandle: () => true,
    });

    tracker.checkCapability(CapabilityType.WebSearch);
    const reason = tracker.getUnavailableReason(CapabilityType.WebSearch);
    expect(reason).toContain("Web Search");
    expect(reason).toContain("unavailable");
    expect(reason).toContain("Network");
  });

  it("getUnavailableMessages returns all unavailable", () => {
    registry.register({
      id: "tool.search",
      type: CapabilityType.WebSearch,
      source: "tool",
      label: "Web Search",
      priority: 1000,
      execute: async () => ({ type: CapabilityType.WebSearch, source: "tool.search", ok: true, payload: { kind: "text", text: "" }, durationMs: 0 }),
      canHandle: () => true,
    });

    tracker.scanAll();
    const messages = tracker.getUnavailableMessages();
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m) => m.includes("Web Search"))).toBe(true);
  });

  it("markDegraded sets healthStatus without making unavailable", () => {
    registry.register({
      id: "tool.fs",
      type: CapabilityType.Filesystem,
      source: "tool",
      label: "Filesystem",
      priority: 1000,
      execute: async () => ({ type: CapabilityType.Filesystem, source: "tool.fs", ok: true, payload: { kind: "text", text: "" }, durationMs: 0 }),
      canHandle: () => true,
    });

    const fullTracker = new CapabilityAvailabilityTracker(registry, FULL_POLICY, createNetworkPolicy("full"));
    fullTracker.checkCapability(CapabilityType.Filesystem);
    fullTracker.markDegraded(CapabilityType.Filesystem, "intermittent failure");

    const avail = fullTracker.getAvailability(CapabilityType.Filesystem)!;
    expect(avail.healthStatus).toBe("degraded");
    expect(avail.state).toBe("available"); // still available, just degraded
  });

  it("markDown makes capability unavailable", () => {
    registry.register({
      id: "tool.fs",
      type: CapabilityType.Filesystem,
      source: "tool",
      label: "Filesystem",
      priority: 1000,
      execute: async () => ({ type: CapabilityType.Filesystem, source: "tool.fs", ok: true, payload: { kind: "text", text: "" }, durationMs: 0 }),
      canHandle: () => true,
    });

    const fullTracker = new CapabilityAvailabilityTracker(registry, FULL_POLICY, createNetworkPolicy("full"));
    fullTracker.checkCapability(CapabilityType.Filesystem);
    fullTracker.markDown(CapabilityType.Filesystem, "disk failure");

    const avail = fullTracker.getAvailability(CapabilityType.Filesystem)!;
    expect(avail.state).toBe("unavailable");
    expect(avail.healthStatus).toBe("down");
    expect(avail.unavailableReason).toBe("disk failure");
  });

  it("markHealthy restores availability", () => {
    registry.register({
      id: "tool.fs",
      type: CapabilityType.Filesystem,
      source: "tool",
      label: "Filesystem",
      priority: 1000,
      execute: async () => ({ type: CapabilityType.Filesystem, source: "tool.fs", ok: true, payload: { kind: "text", text: "" }, durationMs: 0 }),
      canHandle: () => true,
    });

    const fullTracker = new CapabilityAvailabilityTracker(registry, FULL_POLICY, createNetworkPolicy("full"));
    fullTracker.checkCapability(CapabilityType.Filesystem);
    fullTracker.markDown(CapabilityType.Filesystem, "disk failure");
    fullTracker.markHealthy(CapabilityType.Filesystem);

    const avail = fullTracker.getAvailability(CapabilityType.Filesystem)!;
    expect(avail.state).toBe("available");
    expect(avail.healthStatus).toBe("healthy");
    expect(avail.unavailableReason).toBeUndefined();
  });
});

describe("formatHealthTable", () => {
  it("produces a health table with all capabilities", () => {
    const registry = new CapabilityRegistry();
    registry.register({
      id: "tool.fs",
      type: CapabilityType.Filesystem,
      source: "tool",
      label: "Filesystem",
      priority: 1000,
      execute: async () => ({ type: CapabilityType.Filesystem, source: "tool.fs", ok: true, payload: { kind: "text", text: "" }, durationMs: 0 }),
      canHandle: () => true,
    });

    const fullTracker = new CapabilityAvailabilityTracker(registry, FULL_POLICY, createNetworkPolicy("full"));
    fullTracker.scanAll();

    const table = formatHealthTable(fullTracker, "Full internet");
    expect(table).toContain("MINDI Runtime Health");
    expect(table).toContain("Network Policy: Full internet");
    expect(table).toContain("Filesystem");
    expect(table).toContain("available");
    expect(table).toContain("healthy");
  });

  it("shows unavailable capabilities with reason", () => {
    const registry = new CapabilityRegistry();
    registry.register({
      id: "tool.search",
      type: CapabilityType.WebSearch,
      source: "tool",
      label: "Web Search",
      priority: 1000,
      execute: async () => ({ type: CapabilityType.WebSearch, source: "tool.search", ok: true, payload: { kind: "text", text: "" }, durationMs: 0 }),
      canHandle: () => true,
    });

    const offlineTracker = new CapabilityAvailabilityTracker(registry, OFFLINE_POLICY, createNetworkPolicy("offline"));
    offlineTracker.scanAll();

    const table = formatHealthTable(offlineTracker, "Offline");
    expect(table).toContain("Web Search");
    expect(table).toContain("unavailable");
    expect(table).toContain("Network");
  });
});
