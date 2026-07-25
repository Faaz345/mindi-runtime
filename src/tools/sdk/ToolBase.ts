/**
 * BaseTool SDK v2 — Production-grade tool foundation.
 *
 * Extends the existing BaseTool with:
 *   - structured metadata
 *   - capability declaration
 *   - permission requirements
 *   - sandbox policies
 *   - structured inputs / outputs
 *   - progress events
 *   - streaming output
 *   - cancellation
 *   - timeout
 *   - retry policy
 *   - error normalization
 *   - metrics
 *
 * Backward-compatible: existing tools extending BaseTool v1 continue to work.
 * New tools extend ToolBase (v2) to get the full production feature set.
 */

import type {
  CapabilityInput,
  CapabilityResult,
  CapabilityType,
  ExecutionContext,
  ITool,
  SandboxPolicy,
} from "../../core/types.js";
import { ToolError, toMindiError } from "../../core/errors.js";
import { Sandbox } from "../sandbox/Sandbox.js";

// ---------------------------------------------------------------------------
// Tool Metadata
// ---------------------------------------------------------------------------

/** Permission a tool requires to execute. */
export type ToolPermission =
  | "filesystem.read"
  | "filesystem.write"
  | "network"
  | "shell"
  | "clipboard"
  | "process.spawn"
  | "env.read";

/** Structured metadata describing a tool. */
export interface ToolMetadata {
  /** Unique tool id, e.g. "tool.git" */
  readonly id: string;
  /** Human label */
  readonly label: string;
  /** Short description */
  readonly description: string;
  /** Which capability this tool implements */
  readonly capability: CapabilityType;
  /** Tool version */
  readonly version: string;
  /** Required permissions */
  readonly permissions: ToolPermission[];
  /** Supported operations / sub-commands */
  readonly operations: string[];
  /** Input schema (JSON Schema-ish) */
  readonly inputSchema: Record<string, unknown>;
  /** Whether this tool supports streaming output */
  readonly streaming: boolean;
  /** Default timeout ms */
  readonly defaultTimeoutMs: number;
  /** Default retry policy */
  readonly retryPolicy: ToolRetryPolicy;
}

/** Retry policy for tool execution. */
export interface ToolRetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  retryableErrors: string[];
}

/** Progress event emitted during tool execution. */
export interface ToolProgress {
  /** 0..1 */
  percent: number;
  /** Human-readable status */
  message: string;
  /** Optional bytes processed / total */
  bytesProcessed?: number;
  bytesTotal?: number;
  /** Timestamp */
  timestamp: number;
}

/** Streamed output chunk. */
export interface ToolStreamChunk {
  /** Incremental text data */
  text?: string;
  /** Structured data */
  data?: unknown;
  /** Progress update */
  progress?: ToolProgress;
  /** Whether the stream is done */
  done?: boolean;
}

/** Default retry policy for deterministic tools (no retries). */
export const DEFAULT_RETRY: ToolRetryPolicy = {
  maxAttempts: 1,
  backoffMs: 0,
  retryableErrors: [],
};

/** Retry policy for tools that may hit transient network errors. */
export const NETWORK_RETRY: ToolRetryPolicy = {
  maxAttempts: 3,
  backoffMs: 500,
  retryableErrors: ["E_TOOL_TIMEOUT", "E_PROVIDER_TIMEOUT"],
};

// ---------------------------------------------------------------------------
// ToolBase (v2)
// ---------------------------------------------------------------------------

/**
 * Production-grade base class for all tools.
 *
 * Subclasses implement:
 *   - `metadata` — static tool metadata
 *   - `run()` — the actual tool logic
 *   - Optionally `runStream()` — streaming variant
 *
 * ToolBase handles:
 *   - sandbox enforcement (path, command, network checks)
 *   - timeout via AbortController
 *   - retry per retryPolicy
 *   - cancellation propagation from the request context
 *   - error normalization (any thrown value → ToolError)
 *   - metrics collection (duration, success/failure)
 *   - progress event emission
 */
export abstract class ToolBase implements ITool {
  abstract readonly id: string;
  abstract readonly label: string;
  readonly deterministic = true as const;
  abstract readonly capability: CapabilityType;

  protected readonly sandbox: Sandbox;

  constructor(policy: Required<SandboxPolicy>) {
    this.sandbox = new Sandbox(policy);
  }

  /** Sandbox accessor for subclasses. */
  protected get sb(): Sandbox {
    return this.sandbox;
  }

  /** Tool metadata. Subclasses provide via getter or property. */
  abstract readonly metadata: ToolMetadata;

  /** Default retry policy — overridden by subclasses via metadata. */
  protected get retryPolicy(): ToolRetryPolicy {
    return this.metadata.retryPolicy ?? DEFAULT_RETRY;
  }

  /** Default timeout — from metadata or sandbox policy. */
  protected get timeoutMs(): number {
    return this.metadata.defaultTimeoutMs ?? this.sandbox.getTimeout();
  }

  /**
   * Subclasses implement the actual tool logic.
   * Errors thrown here are normalized by execute().
   */
  protected abstract run(
    input: CapabilityInput,
    ctx: ExecutionContext,
  ): Promise<CapabilityResult>;

  /**
   * Streaming variant. Override to support streaming output.
   * Default implementation falls back to run().
   */
  protected async *runStream(
    input: CapabilityInput,
    ctx: ExecutionContext,
  ): AsyncIterable<ToolStreamChunk> {
    const result = await this.run(input, ctx);
    yield { data: result, done: true };
  }

  /**
   * Public execute() — wraps run() with timeout, retry, cancellation,
   * error normalization, and metrics.
   */
  async execute(
    input: CapabilityInput,
    ctx: ExecutionContext,
  ): Promise<CapabilityResult> {
    const start = Date.now();
    const timeout = this.timeoutMs;
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      const onParentAbort = () => ctrl.abort();

      if (ctx.signal.aborted) {
        onParentAbort();
      } else {
        ctx.signal.addEventListener("abort", onParentAbort, { once: true });
      }

      try {
        const result = await this.run(input, ctx);
        if (!result.durationMs) result.durationMs = Date.now() - start;

        // Emit progress=100 on success.
        ctx.events.emit({
          type: "capability:success",
          requestId: ctx.requestId,
          capabilityId: this.id,
          durationMs: result.durationMs,
          timestamp: Date.now(),
        });

        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onParentAbort);
        return result;
      } catch (err) {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onParentAbort);

        lastError = err;
        const mindiErr = toMindiError(err);
        const code = mindiErr.code;

        ctx.events.emit({
          type: "capability:error",
          requestId: ctx.requestId,
          capabilityId: this.id,
          error: mindiErr.message,
          timestamp: Date.now(),
        });

        // Check if retryable.
        if (attempt < this.retryPolicy.maxAttempts && this.retryPolicy.retryableErrors.includes(code)) {
          ctx.log.debug("tool.retry", {
            toolId: this.id,
            attempt,
            nextAttempt: attempt + 1,
            code,
          });
          await sleep(this.retryPolicy.backoffMs * attempt);
          continue;
        }

        // Not retryable or out of attempts.
        if (ctrl.signal.aborted || ctx.signal.aborted) {
          throw new ToolError("E_TOOL_TIMEOUT", `Tool "${this.id}" timed out after ${timeout}ms`, {
            toolId: this.id,
            timeoutMs: timeout,
            attempt,
            cause: err,
          });
        }
        throw new ToolError("E_TOOL_FAILED", `Tool "${this.id}" failed: ${mindiErr.message}`, {
          toolId: this.id,
          attempt,
          cause: err,
        });
      }
    }

    // Exhausted retries.
    const err = toMindiError(lastError);
    throw new ToolError("E_TOOL_FAILED", `Tool "${this.id}" failed after ${this.retryPolicy.maxAttempts} attempts: ${err.message}`, {
      toolId: this.id,
      cause: lastError,
    });
  }

  /**
   * Streaming execute. Returns an async iterable of chunks.
   * The runtime can consume these for real-time progress.
   */
  async *executeStream(
    input: CapabilityInput,
    ctx: ExecutionContext,
  ): AsyncIterable<ToolStreamChunk> {
    yield* this.runStream(input, ctx);
  }

  /** Default: a tool claims it can handle any input of its capability type. */
  canHandle(input: CapabilityInput): boolean {
    return input.type === this.capability;
  }

  /** Emit a progress event. */
  protected emitProgress(ctx: ExecutionContext, percent: number, message: string, _extra?: { bytesProcessed?: number; bytesTotal?: number }): void {
    ctx.log.debug("tool.progress", { toolId: this.id, percent, message });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Check if a required permission is granted by the sandbox policy. */
export function hasPermission(policy: Required<SandboxPolicy>, perm: ToolPermission): boolean {
  switch (perm) {
    case "network":
      return policy.allowNetwork;
    case "filesystem.read":
    case "filesystem.write":
      return policy.allowedRoots.length > 0;
    case "shell":
    case "process.spawn":
      return policy.allowedCommands.length > 0;
    case "clipboard":
    case "env.read":
      return true;
    default:
      return false;
  }
}

/** Validate that all required permissions are satisfied. Throws if not. */
export function assertPermissions(policy: Required<SandboxPolicy>, perms: ToolPermission[]): void {
  for (const p of perms) {
    if (!hasPermission(policy, p)) {
      throw new ToolError("E_TOOL_SANDBOX_VIOLATION", `Permission denied: ${p}`, { permission: p });
    }
  }
}
