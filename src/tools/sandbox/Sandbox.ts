import type { SandboxPolicy } from "../../core/types.js";
import { ToolError } from "../../core/errors.js";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Sandbox
 *
 * Enforces the sandbox policy on every tool execution:
 *  - filesystem operations restricted to allowed roots
 *  - shell commands restricted to an allowlist
 *  - network egress gated by a flag
 *  - hard timeout
 *  - max output bytes
 *
 * Tools MUST call sandbox.assertX() before performing the corresponding
 * operation. The runtime rejects attempts that bypass the sandbox.
 */
export class Sandbox {
  constructor(private readonly policy: Required<SandboxPolicy>) {}

  getPolicy(): Readonly<Required<SandboxPolicy>> {
    return this.policy;
  }

  /** Resolve a path and ensure it stays within an allowed root. */
  resolvePath(input: string): string {
    const resolved = path.resolve(input);
    for (const root of this.policy.allowedRoots) {
      const rootResolved = path.resolve(root);
      // Ensure root is a prefix (with separator boundary)
      const rel = path.relative(rootResolved, resolved);
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
        return resolved;
      }
    }
    throw new ToolError(
      "E_TOOL_SANDBOX_VIOLATION",
      `Path "${input}" is outside allowed roots`,
      { path: input, allowedRoots: this.policy.allowedRoots },
    );
  }

  /** Verify a file is readable within the sandbox. */
  assertReadable(filePath: string): void {
    const resolved = this.resolvePath(filePath);
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        throw new ToolError(
          "E_TOOL_SANDBOX_VIOLATION",
          `Not a regular file: ${filePath}`,
          { path: filePath },
        );
      }
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError(
        "E_TOOL_SANDBOX_VIOLATION",
        `Cannot stat file: ${filePath}`,
        { path: filePath, cause: err },
      );
    }
  }

  /** Verify a command is on the allowlist. */
  assertCommand(command: string): void {
    const base = command.trim().split(/\s+/)[0];
    if (!base) {
      throw new ToolError("E_TOOL_SANDBOX_VIOLATION", "Empty command", {});
    }
    // Allow absolute path only if the basename is allowlisted.
    const basename = path.basename(base);
    const allowed = this.policy.allowedCommands.some(
      (c) => c === base || c === basename,
    );
    if (!allowed) {
      throw new ToolError(
        "E_TOOL_SANDBOX_VIOLATION",
        `Command not on allowlist: ${command}`,
        { command, allowedCommands: this.policy.allowedCommands },
      );
    }
  }

  /** Verify network egress is permitted. */
  assertNetwork(url: string): void {
    if (!this.policy.allowNetwork) {
      throw new ToolError(
        "E_TOOL_SANDBOX_VIOLATION",
        `Network access not permitted in this sandbox`,
        { url },
      );
    }
    // Validate URL format (so callers don't pass junk)
    try {
      pathToFileURL("file://localhost/").toString(); // no-op sanity
      new URL(url);
    } catch {
      throw new ToolError(
        "E_TOOL_SANDBOX_VIOLATION",
        `Invalid URL: ${url}`,
        { url },
      );
    }
  }

  /** Hard timeout for any sandboxed operation. */
  getTimeout(): number {
    return this.policy.timeoutMs;
  }

  /** Max output bytes permitted from any tool. */
  getMaxOutputBytes(): number {
    return this.policy.maxOutputBytes;
  }

  /** Truncate a buffer/string to maxOutputBytes, flagging overflow. */
  capOutput(data: string | Buffer): { data: string; truncated: boolean } {
    const max = this.policy.maxOutputBytes;
    const str = typeof data === "string" ? data : data.toString("utf8");
    const bytes = Buffer.byteLength(str, "utf8");
    if (bytes <= max) return { data: str, truncated: false };
    // Slice by byte length, then decode safely
    const buf = Buffer.from(str, "utf8").subarray(0, max);
    return { data: buf.toString("utf8"), truncated: true };
  }
}
