/**
 * Capability Availability Tracker
 *
 * Tracks the three-state availability of every capability:
 *   - Registered (an executor exists in the registry)
 *   - Available (the executor is healthy and permitted to run)
 *   - Unavailable (disabled, network blocked, provider down, etc.)
 *
 * The planner queries this tracker BEFORE planning to avoid
 * scheduling executions that will fail.
 *
 * Health checks run:
 *   - On startup (initial availability scan)
 *   - Periodically (every 60s for providers, on-demand for tools)
 *   - After failures (mark degraded)
 */

import type { CapabilityType } from "../core/types.js";
import type { CapabilityRegistry } from "../registry/CapabilityRegistry.js";
import type { ToolManifest } from "./CapabilityManifest.js";
import { createManifestFromPolicy } from "./CapabilityManifest.js";
import type { SandboxPolicy } from "../core/types.js";
import type { NetworkPolicyConfig } from "./NetworkPolicy.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AvailabilityState = "registered" | "available" | "unavailable";

export interface CapabilityAvailability {
  capability: CapabilityType;
  state: AvailabilityState;
  /** Tool/provider id */
  executorId: string;
  /** Label for display */
  label: string;
  /** Whether it's a tool or provider */
  source: "tool" | "provider";
  /** Why it's unavailable, if state=unavailable */
  unavailableReason?: string;
  /** Last health check (epoch ms) */
  lastHealthCheck?: number;
  /** Health status */
  healthStatus: "healthy" | "degraded" | "down" | "unknown";
  /** Manifest (operations, permissions) */
  manifest?: ToolManifest;
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

export class CapabilityAvailabilityTracker {
  private readonly availability = new Map<CapabilityType, CapabilityAvailability>();
  private readonly registry: CapabilityRegistry;
  private readonly policy: Required<SandboxPolicy>;
  private healthCheckTimer: NodeJS.Timeout | null = null;

  constructor(
    registry: CapabilityRegistry,
    policy: Required<SandboxPolicy>,
    _networkPolicy: NetworkPolicyConfig,
  ) {
    this.registry = registry;
    this.policy = policy;
  }

  /**
   * Perform initial availability scan.
   * Called during runtime startup.
   */
  async initialScan(): Promise<void> {
    this.scanAll();
  }

  /**
   * Scan all registered capabilities and update availability.
   */
  scanAll(): void {
    const allTypes = this.getAllRegisteredTypes();
    for (const type of allTypes) {
      this.checkCapability(type);
    }
  }

  /**
   * Check a single capability's availability.
   * Determines if the capability can actually be used, not just if it's registered.
   */
  checkCapability(type: CapabilityType): CapabilityAvailability {
    const executors = this.registry.getByType(type);
    const registered = executors.length > 0;

    if (!registered) {
      const avail: CapabilityAvailability = {
        capability: type,
        state: "unavailable",
        executorId: "none",
        label: type,
        source: "tool",
        unavailableReason: `No executor registered for capability "${type}"`,
        lastHealthCheck: Date.now(),
        healthStatus: "down",
      };
      this.availability.set(type, avail);
      return avail;
    }

    const executor = executors[0]!;
    let available = true;
    let unavailableReason: string | undefined;

    // Check network requirements.
    const manifest = createManifestFromPolicy(
      executor.id,
      executor.label,
      type,
      this.policy,
    );

    if (manifest.network && !manifest.network.allowed) {
      available = false;
      unavailableReason = manifest.network.reason ?? "Network access is disabled";
    }

    // Check if tool is enabled.
    if (!manifest.enabled) {
      available = false;
      unavailableReason = manifest.disabledReason ?? "Tool is disabled";
    }

    // Check workspace requirements for filesystem-type tools.
    if (available && manifest.workspace && manifest.workspace.allowedRoots.length === 0) {
      available = false;
      unavailableReason = "No workspace roots configured";
    }

    // Check command allowlist for terminal-type tools.
    if (available && manifest.allowedCommands && manifest.allowedCommands.length === 0) {
      available = false;
      unavailableReason = "No commands allowed by the terminal policy";
    }

    const avail: CapabilityAvailability = {
      capability: type,
      state: available ? "available" : "unavailable",
      executorId: executor.id,
      label: executor.label,
      source: executor.source,
      unavailableReason,
      lastHealthCheck: Date.now(),
      healthStatus: available ? "healthy" : "down",
      manifest,
    };

    this.availability.set(type, avail);
    return avail;
  }

  /**
   * Check if a capability is available for execution.
   * This is the method the planner calls.
   */
  isAvailable(type: CapabilityType): boolean {
    const avail = this.availability.get(type);
    if (!avail) {
      // Not scanned yet — scan now.
      return this.checkCapability(type).state === "available";
    }
    return avail.state === "available";
  }

  /**
   * Get the availability status for a capability.
   */
  getAvailability(type: CapabilityType): CapabilityAvailability | undefined {
    return this.availability.get(type);
  }

  /**
   * Get all availability statuses.
   */
  getAll(): CapabilityAvailability[] {
    return Array.from(this.availability.values());
  }

  /**
   * Get only available capabilities.
   */
  getAvailable(): CapabilityType[] {
    return this.getAll()
      .filter((a) => a.state === "available")
      .map((a) => a.capability);
  }

  /**
   * Get only unavailable capabilities.
   */
  getUnavailable(): CapabilityAvailability[] {
    return this.getAll().filter((a) => a.state === "unavailable");
  }

  /**
   * Mark a capability as degraded (after a failure).
   */
  markDegraded(type: CapabilityType, _reason: string): void {
    const avail = this.availability.get(type);
    if (avail) {
      avail.healthStatus = "degraded";
      avail.lastHealthCheck = Date.now();
      // Don't mark unavailable — degraded means "may still work".
    }
  }

  /**
   * Mark a capability as down (after repeated failures).
   */
  markDown(type: CapabilityType, reason: string): void {
    const avail = this.availability.get(type);
    if (avail) {
      avail.state = "unavailable";
      avail.healthStatus = "down";
      avail.unavailableReason = reason;
      avail.lastHealthCheck = Date.now();
    }
  }

  /**
   * Mark a capability as healthy again.
   */
  markHealthy(type: CapabilityType): void {
    const avail = this.availability.get(type);
    if (avail) {
      avail.healthStatus = "healthy";
      avail.state = "available";
      avail.unavailableReason = undefined;
      avail.lastHealthCheck = Date.now();
    }
  }

  /**
   * Start periodic health checks (every 60 seconds).
   */
  startPeriodicChecks(intervalMs = 60_000): void {
    this.stopPeriodicChecks();
    this.healthCheckTimer = setInterval(() => {
      this.scanAll();
    }, intervalMs);
  }

  /**
   * Stop periodic health checks.
   */
  stopPeriodicChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Get a human-readable reason for why a capability is unavailable.
   * Used for injecting into the model context.
   */
  getUnavailableReason(type: CapabilityType): string | null {
    const avail = this.availability.get(type);
    if (!avail || avail.state !== "unavailable") return null;
    return `${avail.label} is currently unavailable.\nReason: ${avail.unavailableReason ?? "Unknown"}`;
  }

  /**
   * Get all unavailable capability messages for the model.
   */
  getUnavailableMessages(): string[] {
    return this.getUnavailable().map((a) =>
      `${a.label} is currently unavailable.\nReason: ${a.unavailableReason ?? "Unknown"}`,
    );
  }

  // ---------------------------------------------------------------------------

  private getAllRegisteredTypes(): CapabilityType[] {
    // Scan the registry for all capability types.
    const types = new Set<CapabilityType>();
    // We need to check each known capability type.
    const allTypes: CapabilityType[] = [
      "vision", "ocr", "web_search", "browser", "filesystem", "git",
      "terminal", "image_generation", "audio", "embeddings", "database", "chat",
    ];
    for (const type of allTypes) {
      if (this.registry.has(type)) {
        types.add(type);
      }
    }
    return Array.from(types);
  }
}

// ---------------------------------------------------------------------------
// Formatting — /health command output
// ---------------------------------------------------------------------------

export function formatHealthTable(tracker: CapabilityAvailabilityTracker, networkPolicyLabel: string): string {
  const all = tracker.getAll();
  const lines: string[] = [];

  lines.push("MINDI Runtime Health");
  lines.push("");
  lines.push(`Network Policy: ${networkPolicyLabel}`);
  lines.push("");

  if (all.length === 0) {
    lines.push("  No capabilities registered.");
    return lines.join("\n");
  }

  for (const avail of all) {
    const statusIcon = avail.state === "available" ? "✓" : avail.state === "unavailable" ? "✗" : "○";
    const healthIcon = avail.healthStatus === "healthy" ? "✓" :
                       avail.healthStatus === "degraded" ? "⚠" :
                       avail.healthStatus === "down" ? "✗" : "?";

    lines.push(`${avail.label}`);
    lines.push(`  ${statusIcon} ${avail.state}`);
    lines.push(`  Health: ${healthIcon} ${avail.healthStatus}`);
    if (avail.lastHealthCheck) {
      const ago = Math.round((Date.now() - avail.lastHealthCheck) / 1000);
      lines.push(`  Last checked: ${ago}s ago`);
    }
    if (avail.unavailableReason) {
      lines.push(`  Reason: ${avail.unavailableReason}`);
    }
    if (avail.source === "provider") {
      lines.push(`  Provider: ${avail.executorId}`);
    } else {
      lines.push(`  Tool: ${avail.executorId}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
