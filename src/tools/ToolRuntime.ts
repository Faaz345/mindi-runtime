import type {
  CapabilityInput,
  CapabilityResult,
  CapabilityType,
  ExecutionContext,
  ITool,
  SandboxPolicy,
} from "../core/types.js";
import { CapabilityRegistry } from "../registry/CapabilityRegistry.js";
import { FilesystemTool } from "./builtin/FilesystemTool.js";
import { TerminalTool } from "./builtin/TerminalTool.js";
import { GitTool } from "./builtin/GitTool.js";
import { HttpTool } from "./builtin/HttpTool.js";
import { SearchTool } from "./builtin/SearchTool.js";
import { PlaywrightTool } from "./builtin/PlaywrightTool.js";
import { OcrTool } from "./builtin/OcrTool.js";
import { ArchiveTool } from "./builtin/ArchiveTool.js";
import { SqliteTool } from "./builtin/SqliteTool.js";
import { ClipboardTool } from "./builtin/ClipboardTool.js";
import { DiffPatchTool } from "./builtin/DiffPatchTool.js";
import { MarkupTool } from "./builtin/MarkupTool.js";

/**
 * ToolRuntime
 *
 * Owns the lifecycle of all deterministic tools. The runtime boots the
 * ToolRuntime with a sandbox policy; the ToolRuntime instantiates the
 * built-in tools and exposes a single `execute()` entry point that the
 * CapabilityRouter can call.
 *
 * To add a new tool:
 *   1. Implement a class extending BaseTool.
 *   2. Call `toolRuntime.register(new MyTool(policy))`.
 * No core changes required.
 */
export class ToolRuntime {
  private readonly registry: CapabilityRegistry;
  private readonly policy: Required<SandboxPolicy>;

  constructor(policy: Required<SandboxPolicy>, registry?: CapabilityRegistry) {
    this.policy = policy;
    this.registry = registry ?? new CapabilityRegistry();
  }

  /** Register built-in tools. Called by the Runtime during boot. */
  registerBuiltin(): this {
    const tools: ITool[] = [
      new FilesystemTool(this.policy),
      new TerminalTool(this.policy),
      new GitTool(this.policy),
      new HttpTool(this.policy),
      new SearchTool(this.policy),
      new PlaywrightTool(this.policy),
      new OcrTool(this.policy),
      new ArchiveTool(this.policy),
      new SqliteTool(this.policy),
      new ClipboardTool(this.policy),
      new DiffPatchTool(this.policy),
      new MarkupTool(this.policy),
    ];
    for (const tool of tools) {
      // Skip if already registered (idempotent — safe to call multiple times).
      if (!this.registry.get(tool.id)) {
        this.register(tool);
      }
    }
    return this;
  }

  /** Register a custom tool. */
  register(tool: ITool): this {
    // Wrap the tool as an ICapability adapter so it plugs into the same
    // CapabilityRegistry the providers use. The Router treats tools and
    // providers uniformly through ICapability.
    this.registry.register({
      id: tool.id,
      type: tool.capability,
      source: "tool",
      label: tool.label,
      // Tools are preferred — highest priority.
      priority: 1000,
      execute: (input, ctx) => tool.execute(input, ctx),
      canHandle: (input) => tool.canHandle(input),
    });
    return this;
  }

  /** Whether any tool exists for the capability type. */
  has(type: CapabilityType): boolean {
    return this.registry.has(type);
  }

  /** All tool capability ids. */
  list(): string[] {
    return this.registry.list();
  }

  /** Execute a tool by capability type. Returns the first matching tool. */
  async execute(input: CapabilityInput, ctx: ExecutionContext): Promise<CapabilityResult> {
    const candidates = this.registry.getByType(input.type);
    if (candidates.length === 0) {
      throw new CapabilityResultNotFoundError(input.type);
    }
    // Pick the first tool (already sorted highest-priority-first).
    const cap = candidates[0]!;
    return cap.execute(input, ctx);
  }

  getRegistry(): CapabilityRegistry {
    return this.registry;
  }
}

class CapabilityResultNotFoundError extends Error {
  constructor(type: CapabilityType) {
    super(`No tool registered for capability: ${type}`);
    this.name = "CapabilityResultNotFoundError";
  }
}
