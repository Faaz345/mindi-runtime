/**
 * Diff/Patch Tool — compute diffs and apply patches.
 *
 * Operations:
 *   - diff: compute unified diff between two text inputs
 *   - patch: apply a unified diff patch to text
 *   - filediff: compute diff between two files
 *   - filepatch: apply a patch to a file
 *
 * Uses a simple line-based diff implementation (no external deps).
 */

import fs from "node:fs";
import path from "node:path";
import type {
  CapabilityInput,
  CapabilityResult,
  CapabilityType,
  ExecutionContext,
} from "../../core/types.js";
import { ToolError } from "../../core/errors.js";
import { ToolBase, type ToolMetadata, type ToolRetryPolicy, assertPermissions } from "../sdk/ToolBase.js";

const CAP: CapabilityType = "filesystem";

const METADATA: ToolMetadata = {
  id: "tool.diff",
  label: "Diff/Patch",
  description: "Compute unified diffs and apply patches between text and files",
  capability: CAP,
  version: "1.0.0",
  permissions: ["filesystem.read", "filesystem.write"],
  operations: ["diff", "patch", "filediff", "filepatch"],
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["diff", "patch", "filediff", "filepatch"] },
      source: { type: "string" },
      target: { type: "string" },
      patch: { type: "string" },
      oldFile: { type: "string" },
      newFile: { type: "string" },
    },
    required: ["op"],
  },
  streaming: false,
  defaultTimeoutMs: 10_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableErrors: [] } as ToolRetryPolicy,
};

export class DiffPatchTool extends ToolBase {
  readonly id = "tool.diff";
  readonly label = "Diff/Patch";
  readonly capability: CapabilityType = CAP;
  readonly metadata = METADATA;

  protected async run(input: CapabilityInput, _ctx: ExecutionContext): Promise<CapabilityResult> {
    assertPermissions(this.sb.getPolicy(), this.metadata.permissions);

    const op = String(input.params.op ?? "diff");
    const start = Date.now();

    switch (op) {
      case "diff": {
        const source = String(input.params.source ?? "");
        const target = String(input.params.target ?? "");
        const diff = createUnifiedDiff(source, target, "source", "target");
        const capped = this.sb.capOutput(diff);
        return {
          type: CAP, source: this.id, ok: true,
          payload: { kind: "text", text: capped.data + (capped.truncated ? "[...truncated]" : "") },
          durationMs: Date.now() - start,
        };
      }
      case "patch": {
        const source = String(input.params.source ?? "");
        const patch = String(input.params.patch ?? "");
        const result = applyUnifiedPatch(source, patch);
        if (result === null) {
          return {
            type: CAP, source: this.id, ok: false,
            payload: { kind: "text", text: "Failed to apply patch" },
            error: "Patch application failed",
            durationMs: Date.now() - start,
          };
        }
        const capped = this.sb.capOutput(result);
        return {
          type: CAP, source: this.id, ok: true,
          payload: { kind: "text", text: capped.data + (capped.truncated ? "[...truncated]" : "") },
          durationMs: Date.now() - start,
        };
      }
      case "filediff": {
        const oldPath = this.sb.resolvePath(String(input.params.oldFile ?? ""));
        const newPath = this.sb.resolvePath(String(input.params.newFile ?? ""));
        const oldContent = fs.readFileSync(oldPath, "utf8");
        const newContent = fs.readFileSync(newPath, "utf8");
        const diff = createUnifiedDiff(oldContent, newContent, path.basename(oldPath), path.basename(newPath));
        const capped = this.sb.capOutput(diff);
        return {
          type: CAP, source: this.id, ok: true,
          payload: { kind: "text", text: capped.data + (capped.truncated ? "[...truncated]" : "") },
          durationMs: Date.now() - start,
        };
      }
      case "filepatch": {
        const filePath = this.sb.resolvePath(String(input.params.source ?? ""));
        const patch = String(input.params.patch ?? "");
        const content = fs.readFileSync(filePath, "utf8");
        const result = applyUnifiedPatch(content, patch);
        if (result === null) {
          return {
            type: CAP, source: this.id, ok: false,
            payload: { kind: "text", text: "Failed to apply patch to file" },
            error: "Patch application failed",
            durationMs: Date.now() - start,
          };
        }
        fs.writeFileSync(filePath, result, "utf8");
        return {
          type: CAP, source: this.id, ok: true,
          payload: { kind: "text", text: `Patched: ${filePath}` },
          durationMs: Date.now() - start,
        };
      }
      default:
        throw new ToolError("E_TOOL_FAILED", `DiffPatchTool: unknown op "${op}"`, { op });
    }
  }
}

// ---------------------------------------------------------------------------
// Simple line-based diff/patch (no external deps)
// ---------------------------------------------------------------------------

/** Create a unified diff between two strings. */
function createUnifiedDiff(source: string, target: string, oldName: string, newName: string): string {
  const sourceLines = source.split("\n");
  const targetLines = target.split("\n");
  const lines: string[] = [];

  lines.push(`--- ${oldName}`);
  lines.push(`+++ ${newName}`);

  // Simple LCS-based diff
  const matrix = lcsMatrix(sourceLines, targetLines);
  const diffs = backtrackDiff(matrix, sourceLines, targetLines);

  let i = 0;
  while (i < diffs.length) {
    // Collect a hunk
    const removed: string[] = [];
    const added: string[] = [];
    let startOld = i;
    while (i < diffs.length && (diffs[i]!.type === "del" || diffs[i]!.type === "add")) {
      if (diffs[i]!.type === "del") removed.push(diffs[i]!.line);
      else added.push(diffs[i]!.line);
      i++;
    }
    if (removed.length > 0 || added.length > 0) {
      lines.push(`@@ -${startOld + 1},${removed.length} +${startOld + 1},${added.length} @@`);
      for (const r of removed) lines.push(`-${r}`);
      for (const a of added) lines.push(`+${a}`);
    }
    if (i < diffs.length && diffs[i]!.type === "eq") {
      lines.push(` ${diffs[i]!.line}`);
      i++;
    }
  }

  return lines.join("\n");
}

interface DiffLine {
  type: "eq" | "add" | "del";
  line: string;
}

function lcsMatrix(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }
  return dp;
}

function backtrackDiff(dp: number[][], a: string[], b: string[]): DiffLine[] {
  let i = a.length;
  let j = b.length;
  const reversed: DiffLine[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      reversed.push({ type: "eq", line: a[i - 1]! });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      reversed.push({ type: "add", line: b[j - 1]! });
      j--;
    } else {
      reversed.push({ type: "del", line: a[i - 1]! });
      i--;
    }
  }
  reversed.reverse();
  return reversed;
}

/** Apply a unified diff patch to source text. Returns null on failure. */
function applyUnifiedPatch(source: string, patch: string): string | null {
  const sourceLines = source.split("\n");
  const patchLines = patch.split("\n");
  const result: string[] = [];
  let srcIdx = 0;

  for (let p = 0; p < patchLines.length; p++) {
    const line = patchLines[p]!;
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("@@")) {
      // Parse hunk header: @@ -start,count +start,count @@
      const m = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
      if (!m) return null;
      const startOld = parseInt(m[1]!, 10) - 1;
      // Copy unchanged lines before the hunk.
      while (srcIdx < startOld) {
        result.push(sourceLines[srcIdx]!);
        srcIdx++;
      }
      continue;
    }
    if (line.startsWith("-")) {
      srcIdx++; // Skip source line
    } else if (line.startsWith("+")) {
      result.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      result.push(sourceLines[srcIdx]!);
      srcIdx++;
    } else if (line === "") {
      // Empty line in patch = unchanged empty line
      result.push(sourceLines[srcIdx] ?? "");
      srcIdx++;
    }
  }

  // Copy remaining lines.
  while (srcIdx < sourceLines.length) {
    result.push(sourceLines[srcIdx]!);
    srcIdx++;
  }

  return result.join("\n");
}
