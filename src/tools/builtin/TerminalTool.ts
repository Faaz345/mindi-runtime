import { spawn } from "node:child_process";
import type {
  CapabilityInput,
  CapabilityResult,
  CapabilityType,
  ExecutionContext,
  SandboxPolicy,
} from "../../core/types.js";
import { ToolError } from "../../core/errors.js";
import { BaseTool } from "../sandbox/BaseTool.js";

/**
 * TerminalTool — deterministic capability implementation for `terminal`.
 *
 * Executes shell commands restricted to an allowlist. Output is capped to
 * sandbox maxOutputBytes. Honors the execution context's AbortSignal.
 *
 * On Windows, commands run through `cmd.exe /c <command>`.
 * On POSIX, through `sh -c <command>`.
 *
 * The allowlist matches against the first token of the command, so e.g.
 * allowing "git" permits "git status", "git log", etc., but blocks "rm".
 */
export class TerminalTool extends BaseTool {
  readonly id = "tool.terminal";
  readonly capability: CapabilityType = "terminal";
  readonly label = "Terminal";

  constructor(policy: Required<SandboxPolicy>) {
    super(policy);
  }

  protected async run(input: CapabilityInput, ctx: ExecutionContext): Promise<CapabilityResult> {
    const start = Date.now();
    const command = String(input.params.command ?? "");
    if (!command) {
      throw new ToolError("E_TOOL_FAILED", "TerminalTool: missing command", { params: input.params });
    }
    // Enforce allowlist BEFORE spawning.
    this.sb.assertCommand(command);
    const cwd = input.params.cwd ? this.sb.resolvePath(String(input.params.cwd)) : undefined;

    return new Promise<CapabilityResult>((resolve, reject) => {
      const isWin = process.platform === "win32";
      const child = spawn(isWin ? "cmd.exe" : "sh", isWin ? ["/c", command] : ["-c", command], {
        cwd,
        env: { ...process.env, FORCE_COLOR: "0" },
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      const maxBytes = this.sb.getMaxOutputBytes();
      let truncated = false;

      const onData = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
        if (truncated) return;
        const s = stream === "stdout" ? stdout : stderr;
        const next = s + chunk.toString("utf8");
        if (Buffer.byteLength(next, "utf8") > maxBytes) {
          truncated = true;
          if (stream === "stdout") stdout = next.slice(0, maxBytes);
          else stderr = next.slice(0, maxBytes);
          try {
            child.kill("SIGTERM");
          } catch {
            /* ignore */
          }
          return;
        }
        if (stream === "stdout") stdout = next;
        else stderr = next;
      };

      child.stdout?.on("data", onData("stdout"));
      child.stderr?.on("data", onData("stderr"));

      const onAbort = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err) => {
        ctx.signal.removeEventListener("abort", onAbort);
        reject(
          new ToolError("E_TOOL_FAILED", `TerminalTool spawn error: ${err.message}`, {
            command,
            cause: err,
          }),
        );
      });

      child.on("close", (exitCode) => {
        ctx.signal.removeEventListener("abort", onAbort);
        const cap = this.sb.capOutput(stdout);
        const result: CapabilityResult = {
          type: this.capability,
          source: this.id,
          ok: true,
          payload: {
            kind: "command",
            stdout: cap.data + (cap.truncated || truncated ? `\n[...truncated]` : ""),
            stderr,
            exitCode: exitCode ?? -1,
          },
          durationMs: Date.now() - start,
        };
        resolve(result);
      });
    });
  }
}
