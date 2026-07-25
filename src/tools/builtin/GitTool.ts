/**
 * Git Tool — deterministic git operations via the shell.
 *
 * Operations: status, diff, add, commit, checkout, branch, log, show, reset, clone
 *
 * All commands are executed through the sandbox's TerminalTool command allowlist.
 * The tool enforces that `git` is on the allowed commands list.
 */

import { execFile } from "node:child_process";
import type {
  CapabilityInput,
  CapabilityResult,
  CapabilityType,
  ExecutionContext,
} from "../../core/types.js";
import { ToolError } from "../../core/errors.js";
import { ToolBase, type ToolMetadata, type ToolRetryPolicy, assertPermissions } from "../sdk/ToolBase.js";

const CAP: CapabilityType = "git";

const METADATA: ToolMetadata = {
  id: "tool.git",
  label: "Git",
  description: "Deterministic git operations: status, diff, add, commit, checkout, branch, log, show, reset, clone",
  capability: CAP,
  version: "1.0.0",
  permissions: ["shell"],
  operations: ["status", "diff", "add", "commit", "checkout", "branch", "log", "show", "reset", "clone"],
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["status", "diff", "add", "commit", "checkout", "branch", "log", "show", "reset", "clone"] },
      args: { type: "array", items: { type: "string" } },
      cwd: { type: "string" },
    },
    required: ["op"],
  },
  streaming: false,
  defaultTimeoutMs: 30_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableErrors: [] } as ToolRetryPolicy,
};

export class GitTool extends ToolBase {
  readonly id = "tool.git";
  readonly label = "Git";
  readonly capability: CapabilityType = CAP;
  readonly metadata = METADATA;

  protected async run(input: CapabilityInput, ctx: ExecutionContext): Promise<CapabilityResult> {
    assertPermissions(this.sb.getPolicy(), this.metadata.permissions);

    const op = String(input.params.op ?? "");
    const args = Array.isArray(input.params.args) ? (input.params.args as string[]) : [];
    const cwd = input.params.cwd ? this.sb.resolvePath(String(input.params.cwd)) : process.cwd();

    if (!this.metadata.operations.includes(op)) {
      throw new ToolError("E_TOOL_FAILED", `GitTool: unknown op "${op}"`, { op });
    }

    // Build the git command args.
    const gitArgs = [op, ...args];
    const start = Date.now();

    ctx.log.debug("git.execute", { op, args: gitArgs, cwd });

    const { stdout, stderr, exitCode } = await runGit(gitArgs, cwd, ctx);

    const result: CapabilityResult = {
      type: CAP,
      source: this.id,
      ok: exitCode === 0,
      payload: {
        kind: "command",
        stdout: this.sb.capOutput(stdout).data,
        stderr: this.sb.capOutput(stderr).data,
        exitCode,
      },
      durationMs: Date.now() - start,
    };

    if (exitCode !== 0 && op !== "status") {
      // Git returned non-zero — surface as error but still return structured result.
      result.ok = false;
      result.error = `git ${op} failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`;
    }

    return result;
  }
}

/** Run a git command as a child process, honoring the execution context's AbortSignal. */
function runGit(args: string[], cwd: string, ctx: ExecutionContext): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const onAbort = () => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    };
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      ctx.signal.removeEventListener("abort", onAbort);
      reject(new ToolError("E_TOOL_FAILED", `git spawn error: ${err.message}`, { cause: err }));
    });

    child.on("close", (code) => {
      ctx.signal.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}
