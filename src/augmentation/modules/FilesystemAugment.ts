/**
 * FilesystemAugment — augmentation module for local file access.
 *
 * Fires when: the request references local file paths (absolute or relative)
 *             that are NOT images (images are handled by VisionAugment).
 *
 * Execution: reads referenced files from disk (within sandbox bounds) and
 *            injects their content as structured context.
 *
 * Cost: 1 (local I/O — cheapest possible operation).
 *
 * This module ELIMINATES "I cannot read files" responses.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { CapabilityType } from "../../core/types.js";
import { CapabilityType as Cap } from "../../core/types.js";
import type {
  AugmentationContext,
  AugmentationModule,
  RequestAnalysis,
  StructuredContextBlock,
} from "../types.js";

/** Maximum file size to inject (256 KB). Larger files get truncated. */
const MAX_FILE_SIZE = 256 * 1024;
/** Maximum number of files to read per request. */
const MAX_FILES = 10;
/** Maximum directory entries to list. */
const MAX_DIR_ENTRIES = 100;

export class FilesystemAugment implements AugmentationModule {
  readonly id = "filesystem-augment";
  readonly capability: CapabilityType = Cap.Filesystem;
  readonly label = "Filesystem Access";

  /**
   * Detect: fires when non-image file paths are referenced.
   * Image paths are excluded — VisionAugment handles those.
   */
  detect(input: RequestAnalysis): boolean {
    return input.filePaths.some((p) => !p.isImage);
  }

  /**
   * Execute: read referenced files/directories and inject content.
   */
  async execute(input: RequestAnalysis, ctx: AugmentationContext): Promise<StructuredContextBlock> {
    const start = Date.now();
    const targets = input.filePaths.filter((p) => !p.isImage).slice(0, MAX_FILES);

    if (targets.length === 0) {
      return {
        capability: Cap.Filesystem,
        source: this.id,
        ok: false,
        summary: "No file paths to read",
        detail: "No non-image file paths detected in the request.",
        metadata: {},
        durationMs: Date.now() - start,
        error: "No files",
      };
    }

    const results: Array<{ path: string; ok: boolean; content: string; error?: string }> = [];

    for (const target of targets) {
      const resolvedPath = this.resolvePath(target.path, ctx.workspace);

      // Sandbox check: ensure path is within allowed roots.
      if (!this.isAllowed(resolvedPath, ctx.allowedRoots)) {
        results.push({
          path: target.path,
          ok: false,
          content: "",
          error: `Path outside sandbox: ${resolvedPath}`,
        });
        continue;
      }

      try {
        const info = await stat(resolvedPath);

        if (info.isDirectory()) {
          const entries = await readdir(resolvedPath, { withFileTypes: true });
          const listing = entries
            .slice(0, MAX_DIR_ENTRIES)
            .map((e) => `${e.isDirectory() ? "[dir] " : "      "}${e.name}`)
            .join("\n");
          const extra = entries.length > MAX_DIR_ENTRIES
            ? `\n[... ${entries.length - MAX_DIR_ENTRIES} more entries]`
            : "";
          results.push({
            path: target.path,
            ok: true,
            content: `Directory listing of ${resolvedPath}:\n${listing}${extra}`,
          });
        } else {
          // Read file content.
          if (info.size > MAX_FILE_SIZE) {
            // Read only the first portion.
            const buffer = Buffer.alloc(MAX_FILE_SIZE);
            const { open } = await import("node:fs/promises");
            const fh = await open(resolvedPath, "r");
            try {
              await fh.read(buffer, 0, MAX_FILE_SIZE, 0);
            } finally {
              await fh.close();
            }
            const content = buffer.toString("utf-8");
            results.push({
              path: target.path,
              ok: true,
              content: `<file path="${resolvedPath}" size="${info.size}" truncated="true">\n${content}\n</file>\n[File truncated — ${info.size - MAX_FILE_SIZE} more bytes]`,
            });
          } else {
            const content = await readFile(resolvedPath, "utf-8");
            results.push({
              path: target.path,
              ok: true,
              content: `<file path="${resolvedPath}" size="${info.size}">\n${content}\n</file>`,
            });
          }
        }
      } catch (err) {
        results.push({
          path: target.path,
          ok: false,
          content: "",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const successful = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);

    const sections = results.map((r) => {
      if (r.ok) return r.content;
      return `[Failed to read ${r.path}: ${r.error}]`;
    });

    return {
      capability: Cap.Filesystem,
      source: this.id,
      ok: successful.length > 0,
      summary: `Read ${successful.length}/${targets.length} file(s)/dir(s)`,
      detail: [
        "The following filesystem content was read by the runtime:",
        "",
        ...sections,
        "",
        "Use this content to answer the user's question. Do not claim you read it.",
      ].join("\n"),
      metadata: {
        totalPaths: targets.length,
        successful: successful.length,
        failed: failed.length,
        paths: results.map((r) => ({ path: r.path, ok: r.ok })),
      },
      durationMs: Date.now() - start,
      error: failed.length > 0 ? `${failed.length} path(s) could not be read` : undefined,
    };
  }

  /** Cost: 1 — local I/O, cheapest possible. */
  costEstimate(_input: RequestAnalysis): number {
    return 1;
  }

  // ---- Helpers ---------------------------------------------------------

  private resolvePath(p: string, workspace: string): string {
    // Handle ~ expansion.
    if (p.startsWith("~/") || p.startsWith("~\\")) {
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
      return resolve(home, p.slice(2));
    }
    // Relative paths resolve against workspace.
    if (p.startsWith("./") || p.startsWith("../") || p.startsWith(".\\") || p.startsWith("..\\")) {
      return resolve(workspace, p);
    }
    // Already absolute.
    return resolve(p);
  }

  private isAllowed(resolvedPath: string, allowedRoots: readonly string[]): boolean {
    if (allowedRoots.length === 0) return true; // No restrictions.
    return allowedRoots.some((root) => resolvedPath.startsWith(resolve(root)));
  }
}
