import type {
  CapabilityInput,
  CapabilityResult,
  CapabilityType,
  ExecutionContext,
  ITool,
  SandboxPolicy,
} from "../../core/types.js";
import { ToolError } from "../../core/errors.js";
import { Sandbox } from "./Sandbox.js";

/**
 * BaseTool
 *
 * Convenience abstract base for all deterministic tools. Subclasses
 * implement `run()` and get sandbox enforcement + result shaping for free.
 *
 * Tools MUST route all filesystem, network, and shell access through the
 * provided `Sandbox`. Tools that bypass the sandbox will be rejected.
 */
export abstract class BaseTool implements ITool {
  abstract readonly id: string;
  abstract readonly capability: CapabilityType;
  abstract readonly label: string;
  readonly deterministic = true as const;

  protected readonly sandbox: Sandbox;

  constructor(policy: Required<SandboxPolicy>) {
    this.sandbox = new Sandbox(policy);
  }

  /** Sandbox instance for subclasses to use. */
  protected get sb(): Sandbox {
    return this.sandbox;
  }

  /** Subclasses implement the actual tool logic. */
  protected abstract run(input: CapabilityInput, ctx: ExecutionContext): Promise<CapabilityResult>;

  /** Public execute() wraps run() with timeout + error normalization. */
  async execute(input: CapabilityInput, ctx: ExecutionContext): Promise<CapabilityResult> {
    const timeout = this.sandbox.getTimeout();
    // Combine the request's AbortSignal with our own timeout signal.
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), timeout);
    // If the parent request aborts, propagate.
    const onParentAbort = () => timeoutCtrl.abort();
    if (ctx.signal.aborted) {
      onParentAbort();
    } else {
      ctx.signal.addEventListener("abort", onParentAbort, { once: true });
    }
    try {
      const result = await this.run(input, ctx);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (timeoutCtrl.signal.aborted) {
        throw new ToolError("E_TOOL_TIMEOUT", `Tool "${this.id}" timed out after ${timeout}ms`, {
          toolId: this.id,
          timeoutMs: timeout,
          cause: err,
        });
      }
      throw new ToolError("E_TOOL_FAILED", `Tool "${this.id}" failed: ${msg}`, {
        toolId: this.id,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onParentAbort);
    }
  }

  /** Default: a tool claims it can handle any input of its capability type. */
  canHandle(input: CapabilityInput): boolean {
    return input.type === this.capability;
  }
}
