/**
 * Clipboard Tool — read from and write to the system clipboard.
 *
 * Uses platform-native commands:
 *   - Windows: clip / powershell Get-Clipboard
 *   - macOS: pbcopy / pbpaste
 *   - Linux: xclip / xsel
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type {
  CapabilityInput,
  CapabilityResult,
  CapabilityType,
  ExecutionContext,
} from "../../core/types.js";
import { ToolError } from "../../core/errors.js";
import { ToolBase, type ToolMetadata, type ToolRetryPolicy, assertPermissions } from "../sdk/ToolBase.js";

const execAsync = promisify(exec);
const CAP: CapabilityType = "terminal";

const METADATA: ToolMetadata = {
  id: "tool.clipboard",
  label: "Clipboard",
  description: "Read from and write to the system clipboard",
  capability: CAP,
  version: "1.0.0",
  permissions: ["process.spawn"],
  operations: ["read", "write"],
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["read", "write"] },
      text: { type: "string" },
    },
    required: ["op"],
  },
  streaming: false,
  defaultTimeoutMs: 5_000,
  retryPolicy: { maxAttempts: 2, backoffMs: 200, retryableErrors: ["E_TOOL_TIMEOUT"] } as ToolRetryPolicy,
};

export class ClipboardTool extends ToolBase {
  readonly id = "tool.clipboard";
  readonly label = "Clipboard";
  readonly capability: CapabilityType = CAP;
  readonly metadata = METADATA;

  protected async run(input: CapabilityInput, ctx: ExecutionContext): Promise<CapabilityResult> {
    assertPermissions(this.sb.getPolicy(), this.metadata.permissions);

    const op = String(input.params.op ?? "read");
    const start = Date.now();

    switch (op) {
      case "read": {
        const { cmd, args } = readCommand();
        const { stdout } = await execAsync(`${cmd} ${args}`, { timeout: this.timeoutMs, signal: ctx.signal });
        const capped = this.sb.capOutput(stdout);
        return {
          type: CAP, source: this.id, ok: true,
          payload: { kind: "text", text: capped.data + (capped.truncated ? "[...truncated]" : "") },
          durationMs: Date.now() - start,
        };
      }
      case "write": {
        const text = String(input.params.text ?? "");
        const { cmd, args } = writeCommand();
        await execAsync(`${cmd} ${args}`, {
          input: text,
          timeout: this.timeoutMs,
          signal: ctx.signal,
        } as Parameters<typeof execAsync>[1]);
        return {
          type: CAP, source: this.id, ok: true,
          payload: { kind: "text", text: `Wrote ${text.length} chars to clipboard` },
          durationMs: Date.now() - start,
        };
      }
      default:
        throw new ToolError("E_TOOL_FAILED", `ClipboardTool: unknown op "${op}"`, { op });
    }
  }
}

function readCommand(): { cmd: string; args: string } {
  switch (process.platform) {
    case "win32":
      return { cmd: "powershell", args: "-command Get-Clipboard" };
    case "darwin":
      return { cmd: "pbpaste", args: "" };
    default:
      return { cmd: "xclip", args: "-selection clipboard -o" };
  }
}

function writeCommand(): { cmd: string; args: string } {
  switch (process.platform) {
    case "win32":
      return { cmd: "clip", args: "" };
    case "darwin":
      return { cmd: "pbcopy", args: "" };
    default:
      return { cmd: "xclip", args: "-selection clipboard" };
  }
}
