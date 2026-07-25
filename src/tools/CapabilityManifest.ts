/**
 * Capability Manifest System
 *
 * Every tool exposes an explicit, machine-readable manifest describing:
 *   - Exact operations available (read, write, mkdir, etc.)
 *   - Whether each operation is allowed (✓/✗)
 *   - Workspace restrictions (allowed roots)
 *   - Allowed/blocked commands (for terminal)
 *   - Network access status
 *   - Human-readable reason for any restriction
 *
 * The model receives this manifest before reasoning begins.
 * It never infers permissions — it's explicitly told what's available.
 *
 * Adding a new tool = implement getManifest().
 * The runtime collects all manifests and sends them to the provider.
 */

import type { CapabilityType } from "../core/types.js";
import type { SandboxPolicy } from "../core/types.js";

// ---------------------------------------------------------------------------
// Manifest Types
// ---------------------------------------------------------------------------

export interface OperationPermission {
  /** Operation name (e.g. "read", "write", "mkdir") */
  operation: string;
  /** Whether this operation is allowed */
  allowed: boolean;
  /** Human-readable label (e.g. "Read Files") */
  label: string;
  /** Why it's blocked, if allowed=false */
  reason?: string;
}

export interface ToolManifest {
  /** Tool id (e.g. "tool.filesystem") */
  toolId: string;
  /** Tool label (e.g. "Filesystem") */
  label: string;
  /** Capability type */
  capability: CapabilityType;
  /** Whether the tool is enabled at all */
  enabled: boolean;
  /** If disabled, why */
  disabledReason?: string;
  /** Specific operations and their permissions */
  operations: OperationPermission[];
  /** Workspace restrictions */
  workspace?: {
    allowedRoots: string[];
    note: string;
  };
  /** Allowed commands (for terminal-type tools) */
  allowedCommands?: string[];
  /** Blocked commands */
  blockedCommands?: string[];
  /** Network access status */
  network?: {
    allowed: boolean;
    reason?: string;
  };
  /** Additional restrictions or metadata */
  restrictions?: string[];
  // --- Availability tracking ---
  /** Whether the tool is currently available (runtime-determined) */
  available: boolean;
  /** Why it's unavailable, if available=false */
  unavailableReason?: string;
  /** Last health check timestamp (epoch ms) */
  lastHealthCheck?: number;
  /** Health status */
  healthStatus?: "healthy" | "degraded" | "down" | "unknown";
}

// ---------------------------------------------------------------------------
// Manifest Builder
// ---------------------------------------------------------------------------

export class ManifestBuilder {
  private manifest: ToolManifest;

  constructor(toolId: string, label: string, capability: CapabilityType) {
    this.manifest = {
      toolId,
      label,
      capability,
      enabled: true,
      operations: [],
      available: true,
      healthStatus: "unknown",
    };
  }

  setEnabled(enabled: boolean, reason?: string): this {
    this.manifest.enabled = enabled;
    this.manifest.disabledReason = reason;
    return this;
  }

  addOperation(operation: string, allowed: boolean, label: string, reason?: string): this {
    this.manifest.operations.push({ operation, allowed, label, reason });
    return this;
  }

  setWorkspace(allowedRoots: string[], note: string): this {
    this.manifest.workspace = { allowedRoots, note };
    return this;
  }

  setAllowedCommands(commands: string[]): this {
    this.manifest.allowedCommands = commands;
    return this;
  }

  setBlockedCommands(commands: string[]): this {
    this.manifest.blockedCommands = commands;
    return this;
  }

  setNetwork(allowed: boolean, reason?: string): this {
    this.manifest.network = { allowed, reason };
    return this;
  }

  addRestriction(restriction: string): this {
    if (!this.manifest.restrictions) this.manifest.restrictions = [];
    this.manifest.restrictions.push(restriction);
    return this;
  }

  build(): ToolManifest {
    return { ...this.manifest };
  }
}

// ---------------------------------------------------------------------------
// Manifest factory — creates manifests from sandbox policy
// ---------------------------------------------------------------------------

/**
 * Create a manifest for a tool based on the sandbox policy.
 * This is the default implementation — tools can override getManifest()
 * for more specific manifests.
 */
export function createManifestFromPolicy(
  toolId: string,
  label: string,
  capability: CapabilityType,
  policy: Required<SandboxPolicy>,
  options?: {
    disabled?: boolean;
    disabledReason?: string;
    customOperations?: OperationPermission[];
  },
): ToolManifest {
  const builder = new ManifestBuilder(toolId, label, capability);

  if (options?.disabled) {
    return builder.setEnabled(false, options.disabledReason).build();
  }

  // Default operations based on capability type.
  if (options?.customOperations) {
    for (const op of options.customOperations) {
      builder.addOperation(op.operation, op.allowed, op.label, op.reason);
    }
  } else {
    // Auto-generate operations from capability type + policy.
    switch (capability) {
      case "filesystem":
        builder
          .addOperation("read", policy.allowedRoots.length > 0, "Read Files",
            policy.allowedRoots.length === 0 ? "No workspace roots configured" : undefined)
          .addOperation("write", policy.allowedRoots.length > 0, "Write Files",
            policy.allowedRoots.length === 0 ? "No workspace roots configured" : undefined)
          .addOperation("append", policy.allowedRoots.length > 0, "Append to Files",
            policy.allowedRoots.length === 0 ? "No workspace roots configured" : undefined)
          .addOperation("mkdir", policy.allowedRoots.length > 0, "Create Directories",
            policy.allowedRoots.length === 0 ? "No workspace roots configured" : undefined)
          .addOperation("rename", policy.allowedRoots.length > 0, "Rename Files",
            policy.allowedRoots.length === 0 ? "No workspace roots configured" : undefined)
          .addOperation("list", policy.allowedRoots.length > 0, "List Directory",
            policy.allowedRoots.length === 0 ? "No workspace roots configured" : undefined)
          .addOperation("delete", false, "Delete Files", "Deletion disabled for safety")
          .setWorkspace(policy.allowedRoots, policy.allowedRoots.length > 0 ? "Restricted to workspace roots" : "No workspace configured");
        break;
      case "terminal":
        builder
          .addOperation("execute", policy.allowedCommands.length > 0, "Execute Commands",
            policy.allowedCommands.length === 0 ? "No commands allowed" : undefined)
          .setAllowedCommands(policy.allowedCommands)
          .setBlockedCommands(["unrestricted shell", "rm -rf", "format", "del /f"])
          .addRestriction("Only allowlisted commands may be executed");
        break;
      case "git":
        builder
          .addOperation("status", true, "Git Status")
          .addOperation("diff", true, "Git Diff")
          .addOperation("log", true, "Git Log")
          .addOperation("add", true, "Git Add")
          .addOperation("commit", true, "Git Commit")
          .addOperation("branch", true, "Git Branch")
          .addOperation("checkout", true, "Git Checkout")
          .addOperation("show", true, "Git Show")
          .addOperation("reset", true, "Git Reset")
          .addOperation("clone", true, "Git Clone");
        break;
      case "browser":
        builder
          .addOperation("launch", true, "Launch Browser")
          .addOperation("navigate", true, "Navigate to URL")
          .addOperation("screenshot", true, "Take Screenshot")
          .addOperation("click", true, "Click Element")
          .addOperation("type", true, "Type Text")
          .addOperation("evaluate", true, "Execute JavaScript")
          .addOperation("wait", true, "Wait for Element")
          .addOperation("snapshot", true, "Accessibility Snapshot")
          .addOperation("extract", true, "Extract DOM")
          .addOperation("GET", policy.allowNetwork, "HTTP GET",
            !policy.allowNetwork ? "Network access is disabled" : undefined)
          .addOperation("POST", policy.allowNetwork, "HTTP POST",
            !policy.allowNetwork ? "Network access is disabled" : undefined)
          .addOperation("PUT", policy.allowNetwork, "HTTP PUT",
            !policy.allowNetwork ? "Network access is disabled" : undefined)
          .addOperation("DELETE", policy.allowNetwork, "HTTP DELETE",
            !policy.allowNetwork ? "Network access is disabled" : undefined)
          .setNetwork(policy.allowNetwork, policy.allowNetwork ? "Browser requires network access" : "Network access is disabled for this session");
        break;
      case "web_search":
        builder
          .addOperation("search", policy.allowNetwork, "Search the Web",
            !policy.allowNetwork ? "Network access is disabled for this session" : undefined)
          .setNetwork(policy.allowNetwork, policy.allowNetwork ? undefined : "Network access is disabled for this session");
        break;
      case "ocr":
        builder
          .addOperation("image", true, "OCR from Image")
          .addOperation("pdf", true, "OCR from PDF");
        break;
      case "database":
        builder
          .addOperation("query", true, "Execute Query")
          .addOperation("schema", true, "Get Schema")
          .addOperation("export", true, "Export Data")
          .addOperation("transaction", true, "Run Transaction");
        break;
      case "image_generation":
        builder
          .addOperation("generate", true, "Generate Image from Prompt");
        break;
      case "audio":
        builder
          .addOperation("transcribe", true, "Transcribe Audio")
          .addOperation("process", true, "Process Audio");
        break;
      case "embeddings":
        builder
          .addOperation("embed", true, "Generate Embeddings");
        break;
      default:
        builder.addOperation("execute", true, "Execute");
    }
  }

  return builder.build();
}

// ---------------------------------------------------------------------------
// Manifest collection — gathers all tool manifests
// ---------------------------------------------------------------------------

export interface RuntimeManifest {
  tools: ToolManifest[];
  workspace: string;
  provider: string;
  model: string;
}

/**
 * Collect manifests from all registered tools.
 * This is sent to the provider before reasoning begins.
 */
export function collectManifests(
  tools: Array<{ id: string; capability: CapabilityType; label: string }>,
  policy: Required<SandboxPolicy>,
): ToolManifest[] {
  return tools.map((tool) =>
    createManifestFromPolicy(tool.id, tool.label, tool.capability, policy),
  );
}

// ---------------------------------------------------------------------------
// Permission checking
// ---------------------------------------------------------------------------

export interface PermissionResult {
  allowed: boolean;
  reason: string;
  /** What is allowed instead */
  alternative?: string;
}

/**
 * Check if a specific operation is allowed by the manifest.
 * Returns a structured result with reason — never a generic "permission denied".
 */
export function checkPermission(
  manifest: ToolManifest,
  operation: string,
): PermissionResult {
  if (!manifest.enabled) {
    return {
      allowed: false,
      reason: manifest.disabledReason ?? `Tool "${manifest.label}" is disabled`,
    };
  }

  const op = manifest.operations.find((o) => o.operation === operation);
  if (!op) {
    return {
      allowed: false,
      reason: `Operation "${operation}" is not supported by "${manifest.label}"`,
      alternative: `Supported operations: ${manifest.operations.map((o) => o.operation).join(", ")}`,
    };
  }

  if (!op.allowed) {
    return {
      allowed: false,
      reason: op.reason ?? `Operation "${operation}" is not allowed for "${manifest.label}"`,
      alternative: op.reason ? undefined : `Allowed operations: ${manifest.operations.filter((o) => o.allowed).map((o) => o.operation).join(", ")}`,
    };
  }

  return { allowed: true, reason: "OK" };
}

/**
 * Check if a command is allowed by the terminal manifest.
 */
export function checkCommand(
  manifest: ToolManifest,
  command: string,
): PermissionResult {
  if (!manifest.enabled) {
    return { allowed: false, reason: `Tool "${manifest.label}" is disabled` };
  }

  const base = command.trim().split(/\s+/)[0] ?? "";
  const basename = base.split(/[\\/]/).pop() ?? base;

  const blocked = manifest.blockedCommands?.some((c) => c === base || c === basename);
  if (blocked) {
    return {
      allowed: false,
      reason: `Command "${base}" is blocked by the terminal policy`,
      alternative: `Allowed commands: ${manifest.allowedCommands?.join(", ") ?? "none"}`,
    };
  }

  const allowed = manifest.allowedCommands?.some((c) => c === base || c === basename);
  if (!allowed) {
    return {
      allowed: false,
      reason: `Command "${base}" is not on the allowlist`,
      alternative: `Allowed commands: ${manifest.allowedCommands?.join(", ") ?? "none"}`,
    };
  }

  return { allowed: true, reason: "OK" };
}

/**
 * Check if a path is within the allowed workspace.
 */
export function checkWorkspace(
  manifest: ToolManifest,
  filePath: string,
): PermissionResult {
  if (!manifest.workspace) {
    return { allowed: true, reason: "No workspace restrictions" };
  }

  const resolved = path.resolve(filePath);
  for (const root of manifest.workspace.allowedRoots) {
    const rootResolved = path.resolve(root);
    const rel = path.relative(rootResolved, resolved);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      return { allowed: true, reason: "Within workspace" };
    }
  }

  return {
    allowed: false,
    reason: `Cannot ${"access"} outside the configured workspace`,
    alternative: `Allowed roots: ${manifest.workspace.allowedRoots.join(", ")}`,
  };
}

// Re-export path for checkWorkspace.
import path from "node:path";

// ---------------------------------------------------------------------------
// Formatting — /capabilities command output
// ---------------------------------------------------------------------------

export function formatManifestTable(manifests: ToolManifest[], workspace: string, provider: string, model: string): string {
  const lines: string[] = [];
  lines.push("MINDI Runtime Capabilities");
  lines.push("");

  for (const m of manifests) {
    lines.push(m.label);
    if (!m.enabled) {
      lines.push(`  ✗ Disabled${m.disabledReason ? ` — ${m.disabledReason}` : ""}`);
      lines.push("");
      continue;
    }
    for (const op of m.operations) {
      lines.push(`  ${op.allowed ? "✓" : "✗"} ${op.label}${op.reason ? ` — ${op.reason}` : ""}`);
    }
    if (m.allowedCommands && m.allowedCommands.length > 0) {
      lines.push(`  Allowed: ${m.allowedCommands.join(", ")}`);
    }
    if (m.blockedCommands && m.blockedCommands.length > 0) {
      lines.push(`  Blocked: ${m.blockedCommands.join(", ")}`);
    }
    if (m.workspace) {
      lines.push(`  Workspace: ${m.workspace.allowedRoots.join(", ")}`);
    }
    if (m.network) {
      lines.push(`  Network: ${m.network.allowed ? "✓ Enabled" : "✗ Disabled"}${m.network.reason ? ` — ${m.network.reason}` : ""}`);
    }
    if (m.restrictions && m.restrictions.length > 0) {
      for (const r of m.restrictions) {
        lines.push(`  Restriction: ${r}`);
      }
    }
    lines.push("");
  }

  lines.push(`Workspace: ${workspace}`);
  lines.push(`Provider: ${provider}`);
  lines.push(`Model: ${model}`);

  return lines.join("\n");
}
