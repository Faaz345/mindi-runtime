/**
 * Archive Tool — zip, unzip, tar, gzip.
 *
 * Uses Node.js built-in zlib for gzip, and the `adm-zip` package for zip
 * operations if available. Falls back to shell commands for tar.
 */

import zlib from "node:zlib";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type {
  CapabilityInput,
  CapabilityResult,
  CapabilityType,
  ExecutionContext,
} from "../../core/types.js";
import { ToolError } from "../../core/errors.js";
import { ToolBase, type ToolMetadata, type ToolRetryPolicy, assertPermissions } from "../sdk/ToolBase.js";

const CAP: CapabilityType = "filesystem";
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const METADATA: ToolMetadata = {
  id: "tool.archive",
  label: "Archive",
  description: "Archive operations: zip, unzip, tar, gzip",
  capability: CAP,
  version: "1.0.0",
  permissions: ["filesystem.read", "filesystem.write"],
  operations: ["zip", "unzip", "tar", "gzip", "gunzip"],
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["zip", "unzip", "tar", "gzip", "gunzip"] },
      source: { type: "string" },
      dest: { type: "string" },
    },
    required: ["op", "source"],
  },
  streaming: false,
  defaultTimeoutMs: 60_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableErrors: [] } as ToolRetryPolicy,
};

export class ArchiveTool extends ToolBase {
  readonly id = "tool.archive";
  readonly label = "Archive";
  readonly capability: CapabilityType = CAP;
  readonly metadata = METADATA;

  protected async run(input: CapabilityInput, ctx: ExecutionContext): Promise<CapabilityResult> {
    assertPermissions(this.sb.getPolicy(), this.metadata.permissions);

    const op = String(input.params.op ?? "");
    const source = this.sb.resolvePath(String(input.params.source ?? ""));
    const dest = input.params.dest ? this.sb.resolvePath(String(input.params.dest)) : source + ".out";

    const start = Date.now();
    ctx.log.debug("archive.execute", { op, source, dest });

    switch (op) {
      case "gzip": {
        const data = fs.readFileSync(source);
        const compressed = await gzip(data);
        fs.writeFileSync(dest, compressed);
        return result(this.id, true, { op: "gzip", source, dest, bytes: compressed.length }, start);
      }
      case "gunzip": {
        const data = fs.readFileSync(source);
        const decompressed = await gunzip(data);
        fs.writeFileSync(dest, decompressed);
        return result(this.id, true, { op: "gunzip", source, dest, bytes: decompressed.length }, start);
      }
      case "tar": {
        const args = ["cf", dest, "-C", path.dirname(source), path.basename(source)];
        const { exitCode } = await runCmd("tar", args, process.cwd(), ctx);
        return result(this.id, exitCode === 0, { op: "tar", source, dest, exitCode }, start);
      }
      case "zip": {
        const AdmZip = await tryImport("adm-zip");
        if (AdmZip) {
          const zip = new AdmZip() as unknown as { addLocalFolder: (p: string) => void; addLocalFile: (p: string) => void; writeZip: (p: string) => void; extractAllTo: (p: string, o: boolean) => void };
          const stat = fs.statSync(source);
          if (stat.isDirectory()) {
            zip.addLocalFolder(source);
          } else {
            zip.addLocalFile(source);
          }
          zip.writeZip(dest);
          return result(this.id, true, { op: "zip", source, dest }, start);
        }
        // Fallback: use shell command
        const { exitCode } = await runCmd("zip", ["-r", dest, source], process.cwd(), ctx);
        return result(this.id, exitCode === 0, { op: "zip", source, dest, exitCode }, start);
      }
      case "unzip": {
        const AdmZip = await tryImport("adm-zip");
        if (AdmZip) {
          const zip = new AdmZip(source) as unknown as { addLocalFolder: (p: string) => void; addLocalFile: (p: string) => void; writeZip: (p: string) => void; extractAllTo: (p: string, o: boolean) => void };
          zip.extractAllTo(dest, true);
          return result(this.id, true, { op: "unzip", source, dest }, start);
        }
        const { exitCode } = await runCmd("unzip", [source, "-d", dest], process.cwd(), ctx);
        return result(this.id, exitCode === 0, { op: "unzip", source, dest, exitCode }, start);
      }
      default:
        throw new ToolError("E_TOOL_FAILED", `ArchiveTool: unknown op "${op}"`, { op });
    }
  }
}

function result(source: string, ok: boolean, data: Record<string, unknown>, start: number): CapabilityResult {
  return {
    type: CAP,
    source,
    ok,
    payload: { kind: "structured", data },
    durationMs: Date.now() - start,
  };
}

function runCmd(cmd: string, args: string[], cwd: string, ctx: ExecutionContext): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, maxBuffer: 5 * 1024 * 1024 });
    let stdout = "", stderr = "";
    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
    child.on("error", () => resolve({ stdout, stderr, exitCode: -1 }));
    const onAbort = () => { try { child.kill("SIGTERM"); } catch { /* ignore */ } };
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function tryImport(name: string): Promise<(new (...args: unknown[]) => unknown) | null> {
  try {
    const mod = await import(name);
    return mod.default ?? mod;
  } catch {
    return null;
  }
}
