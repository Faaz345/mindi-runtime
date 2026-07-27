import fs from "node:fs/promises";
import path from "node:path";
import type {
  CapabilityInput,
  CapabilityResult,
  CapabilityType,
  SandboxPolicy,
} from "../../core/types.js";
import { ToolError } from "../../core/errors.js";
import { BaseTool } from "../sandbox/BaseTool.js";

/**
 * FilesystemTool — deterministic capability implementation for `filesystem`.
 *
 * Operations:
 *   - read   : read a file's content (utf8 or base64)
 *   - write  : write content to a file
 *   - list   : list entries in a directory
 *   - stat   : stat a path
 *   - mkdir  : create a directory recursively
 *
 * All paths are resolved and verified against the sandbox's allowed roots.
 */
export class FilesystemTool extends BaseTool {
  readonly id = "tool.filesystem";
  readonly capability: CapabilityType = "filesystem";
  readonly label = "Filesystem";

  constructor(policy: Required<SandboxPolicy>) {
    super(policy);
  }

  protected async run(input: CapabilityInput): Promise<CapabilityResult> {
    const start = Date.now();
    const op = String(input.params.op ?? "");
    const target = String(input.params.path ?? "");
    if (!op) {
      throw new ToolError("E_TOOL_FAILED", "FilesystemTool: missing op", { params: input.params });
    }
    if (!target && op !== "list") {
      throw new ToolError("E_TOOL_FAILED", "FilesystemTool: missing path", { params: input.params });
    }

    let payload: CapabilityResult["payload"];

    switch (op) {
      case "read": {
        const resolved = this.sb.resolvePath(target);
        const stat = await fs.stat(resolved);
        if (!stat.isFile()) {
          throw new ToolError("E_TOOL_FAILED", `Not a file: ${target}`, { path: target });
        }
        const encoding = (input.params.encoding as "utf8" | "base64") ?? "utf8";
        const data = await fs.readFile(resolved);
        let content: string;
        if (encoding === "base64") {
          content = data.toString("base64");
        } else {
          content = data.toString("utf8");
        }
        const { data: capped, truncated } = this.sb.capOutput(content);
        payload = {
          kind: "file",
          path: resolved,
          content: capped + (truncated ? `\n[...truncated at ${this.sb.getMaxOutputBytes()} bytes]` : ""),
          encoding,
        };
        break;
      }
      case "write": {
        const resolved = this.sb.resolvePath(target);
        const content = String(input.params.content ?? "");
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, content, "utf8");
        payload = { kind: "structured", data: { written: true, path: resolved, bytes: Buffer.byteLength(content) } };
        break;
      }
      case "list": {
        const dir = target ? this.sb.resolvePath(target) : this.sb.getPolicy().allowedRoots[0] ?? process.cwd();
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const out = entries.map((e) => ({
          path: path.join(dir, e.name),
          type: e.isDirectory() ? ("dir" as const) : ("file" as const),
        }));
        payload = { kind: "files", entries: out };
        break;
      }
      case "mkdir": {
        const resolved = this.sb.resolvePath(target);
        await fs.mkdir(resolved, { recursive: true });
        payload = { kind: "structured", data: { created: true, path: resolved } };
        break;
      }
      case "stat": {
        const resolved = this.sb.resolvePath(target);
        const s = await fs.stat(resolved);
        payload = {
          kind: "structured",
          data: {
            path: resolved,
            type: s.isFile() ? "file" : s.isDirectory() ? "dir" : "other",
            size: s.size,
            mtime: s.mtime.toISOString(),
          },
        };
        break;
      }
      default:
        throw new ToolError("E_TOOL_FAILED", `FilesystemTool: unknown op "${op}"`, { op });
    }

    return {
      type: this.capability,
      source: this.id,
      ok: true,
      payload,
      durationMs: Date.now() - start,
    };
  }
}
