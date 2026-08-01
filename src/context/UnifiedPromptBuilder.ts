/**
 * UnifiedPromptBuilder — single prompt builder for BOTH simple and agent mode.
 *
 * Replaces the dual system of ContextBuilder.buildSystemPrompt() +
 * AgentOrchestrator's separate agent prompt. Uses the EffectiveCapabilityCard
 * produced by the CapabilityAugmentationRouter as the single source of truth.
 *
 * The ONLY difference between simple and agent mode prompts is TENSE:
 *   - Simple: "The runtime obtained this information for you: [results]."
 *   - Agent:  "You can call these tools via [protocol]. The runtime executes them."
 *
 * The capability list, environment info, and honesty contract are IDENTICAL.
 */

import type { CapabilityType } from "../core/types.js";
import { CapabilityType as Cap } from "../core/types.js";
import type { EffectiveCapabilityCard } from "../augmentation/types.js";

// ---------------------------------------------------------------------------
// Human labels
// ---------------------------------------------------------------------------

const CAPABILITY_LABELS: Record<string, string> = {
  [Cap.Vision]: "Vision",
  [Cap.OCR]: "OCR",
  [Cap.WebSearch]: "Web Search",
  [Cap.Browser]: "Browser Automation",
  [Cap.Filesystem]: "Filesystem",
  [Cap.Git]: "Git",
  [Cap.Terminal]: "Terminal",
  [Cap.ImageGeneration]: "Image Generation",
  [Cap.Audio]: "Audio Processing",
  [Cap.Embeddings]: "Embeddings",
  [Cap.Database]: "Database",
  [Cap.Chat]: "Chat",
};

function label(cap: CapabilityType | string): string {
  return CAPABILITY_LABELS[cap] ?? cap;
}

// ---------------------------------------------------------------------------
// UnifiedPromptBuilder
// ---------------------------------------------------------------------------

export class UnifiedPromptBuilder {
  /**
   * Build the system prompt from an EffectiveCapabilityCard.
   * ONE builder, TWO modes — differs only in tense.
   */
  build(opts: {
    card: EffectiveCapabilityCard;
    mode: "simple" | "agentic";
    workspace: string;
    /** Whether native function tools are attached (agent mode only). */
    nativeTools?: boolean;
    /** Additional context preamble (e.g. project memory). */
    preamble?: string;
  }): string {
    const { card, mode, workspace } = opts;
    const lines: string[] = [];

    // ---- Identity ----
    lines.push("You are an AI assistant running inside the MINDI Runtime environment.");
    lines.push("The MINDI Runtime is a capability augmentation layer that executes");
    lines.push("tools and provides their results to you as context.");
    lines.push("");

    // ---- Environment ----
    lines.push("Environment:");
    lines.push(`  Workspace: ${workspace}`);
    lines.push(`  Provider: ${card.provider}`);
    lines.push(`  Model: ${card.model}`);
    lines.push("");

    // ---- Effective Capabilities ----
    lines.push("Effective capabilities (what you can do in this session):");
    lines.push("");

    // Native capabilities.
    if (card.native.length > 0) {
      lines.push("  Native (you handle directly):");
      for (const cap of card.native) {
        lines.push(`    ✓ ${label(cap)}`);
      }
    }

    // Augmented capabilities (already executed for THIS request).
    if (card.augmented.length > 0) {
      lines.push("");
      lines.push("  Augmented for this request (runtime already executed):");
      for (const aug of card.augmented) {
        lines.push(`    ✓ ${label(aug.capability)} — via ${aug.via}`);
      }
    }

    // Runtime tools (available on-demand in agent mode).
    if (mode === "agentic" && card.runtimeTools.length > 0) {
      lines.push("");
      lines.push("  Runtime tools (callable on demand):");
      for (const tool of card.runtimeTools) {
        lines.push(`    ✓ ${label(tool.capability)} — ${tool.description}`);
      }
    }

    // Unavailable.
    if (card.unavailable.length > 0) {
      lines.push("");
      lines.push("  Unavailable:");
      for (const un of card.unavailable) {
        lines.push(`    ✗ ${label(un.capability)} — ${un.reason}`);
      }
    }

    lines.push("");

    // ---- Mode-specific behavior ----
    lines.push("How capabilities work here:");
    if (mode === "agentic") {
      lines.push("  - This task runs in AGENT MODE.");
      if (opts.nativeTools) {
        lines.push("  - You have native function calling. Use it to invoke tools.");
        lines.push("    The runtime executes every tool call and returns real results.");
      } else {
        lines.push("  - A separate instruction block describes the tool invocation protocol.");
        lines.push("    Follow it exactly — the runtime executes every tool you invoke.");
      }
      lines.push("  - You can request additional tool executions as needed.");
    } else {
      lines.push("  - This is a single-turn conversation. You CANNOT invoke tools.");
      lines.push("  - The runtime pre-executed relevant capabilities and injected");
      lines.push("    results as [Capability:...] messages in this conversation.");
      lines.push("  - Reason over the provided context. Do not request tool execution.");
    }

    lines.push("");

    // ---- Honesty contract (IDENTICAL in both modes) ----
    lines.push("HONESTY CONTRACT (always enforced):");
    lines.push("  - NEVER claim you performed an action (wrote a file, ran a command,");
    lines.push("    fetched a URL, cloned a repo) unless a [Capability:...] result");
    lines.push("    in this conversation proves it happened.");
    lines.push("  - NEVER fabricate tool output, terminal results, or file contents.");
    lines.push("  - If information was not provided by the runtime, say so clearly.");
    lines.push("  - When asked what you can do, list the effective capabilities above.");
    lines.push("");

    // ---- Preamble (project memory, etc.) ----
    if (opts.preamble) {
      lines.push(opts.preamble);
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Build a minimal capability summary for injection into existing prompts
   * (e.g. when the agent orchestrator builds its own prompt but needs the
   * capability card appended).
   */
  buildCapabilitySummary(card: EffectiveCapabilityCard): string {
    const parts: string[] = [];
    parts.push(`Provider: ${card.provider} | Model: ${card.model}`);
    parts.push(`Native: ${card.native.map(label).join(", ") || "none"}`);
    if (card.augmented.length > 0) {
      parts.push(`Augmented: ${card.augmented.map((a) => `${label(a.capability)} via ${a.via}`).join(", ")}`);
    }
    if (card.unavailable.length > 0) {
      parts.push(`Unavailable: ${card.unavailable.map((u) => `${label(u.capability)} (${u.reason})`).join(", ")}`);
    }
    return parts.join("\n");
  }
}
