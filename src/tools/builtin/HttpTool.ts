/**
 * HTTP Tool — deterministic HTTP client.
 *
 * Operations: GET, POST, PUT, DELETE
 * Features: custom headers, timeout, retries, JSON body, file download
 *
 * Requires `network` permission in the sandbox policy.
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

const CAP: CapabilityType = "browser";

const METADATA: ToolMetadata = {
  id: "tool.http",
  label: "HTTP Client",
  description: "Deterministic HTTP client: GET, POST, PUT, DELETE with headers, timeout, retries, JSON, file download",
  capability: CAP,
  version: "1.0.0",
  permissions: ["network"],
  operations: ["GET", "POST", "PUT", "DELETE"],
  inputSchema: {
    type: "object",
    properties: {
      method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"] },
      url: { type: "string" },
      headers: { type: "object" },
      body: { type: "string" },
      json: { type: "object" },
      timeoutMs: { type: "number" },
      downloadTo: { type: "string" },
    },
    required: ["method", "url"],
  },
  streaming: false,
  defaultTimeoutMs: 30_000,
  retryPolicy: { maxAttempts: 3, backoffMs: 500, retryableErrors: ["E_TOOL_TIMEOUT"] } as ToolRetryPolicy,
};

export class HttpTool extends ToolBase {
  readonly id = "tool.http";
  readonly label = "HTTP Client";
  readonly capability: CapabilityType = CAP;
  readonly metadata = METADATA;

  protected async run(input: CapabilityInput, ctx: ExecutionContext): Promise<CapabilityResult> {
    assertPermissions(this.sb.getPolicy(), this.metadata.permissions);

    const method = String(input.params.method ?? "GET").toUpperCase();
    const url = String(input.params.url ?? "");
    const headers = (input.params.headers as Record<string, string>) ?? {};
    const timeoutMs = Number(input.params.timeoutMs ?? this.timeoutMs);
    const downloadTo = input.params.downloadTo ? String(input.params.downloadTo) : null;

    if (!url) {
      throw new ToolError("E_TOOL_FAILED", "HttpTool: missing url", {});
    }
    if (!this.metadata.operations.includes(method)) {
      throw new ToolError("E_TOOL_FAILED", `HttpTool: unsupported method "${method}"`, { method });
    }

    // Build request body.
    let body: string | undefined;
    if (input.params.json !== undefined) {
      body = JSON.stringify(input.params.json);
      headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
    } else if (input.params.body !== undefined) {
      body = String(input.params.body);
    }

    const start = Date.now();
    ctx.log.debug("http.request", { method, url, hasBody: !!body });

    // Create an AbortController for timeout.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onParentAbort = () => ctrl.abort();
    if (ctx.signal.aborted) onParentAbort();
    else ctx.signal.addEventListener("abort", onParentAbort, { once: true });

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ?? undefined,
        signal: ctrl.signal,
      });

      if (downloadTo) {
        // File download mode — stream to disk.
        const downloadPath = this.sb.resolvePath(downloadTo);
        const buffer = Buffer.from(await res.arrayBuffer());
        fs.mkdirSync(path.dirname(downloadPath), { recursive: true });
        fs.writeFileSync(downloadPath, buffer);

        return {
          type: CAP,
          source: this.id,
          ok: res.ok,
          payload: {
            kind: "structured",
            data: {
              status: res.status,
              statusText: res.statusText,
              downloadedTo: downloadPath,
              bytes: buffer.length,
            },
          },
          durationMs: Date.now() - start,
        };
      }

      const text = await res.text();
      const capped = this.sb.capOutput(text);

      // Try to parse as JSON for structured output.
      let payload: CapabilityResult["payload"];
      try {
        const json = JSON.parse(capped.data);
        payload = {
          kind: "structured",
          data: {
            status: res.status,
            statusText: res.statusText,
            headers: Object.fromEntries(res.headers.entries()),
            body: json,
          },
        };
      } catch {
        payload = {
          kind: "text",
          text: capped.data + (capped.truncated ? "\n[...truncated]" : ""),
        };
        // Embed status info in the text.
        if (!res.ok) {
          payload = { kind: "text", text: `HTTP ${res.status} ${res.statusText}\n\n${capped.data}` };
        }
      }

      return {
        type: CAP,
        source: this.id,
        ok: res.ok,
        payload,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      if (ctrl.signal.aborted || ctx.signal.aborted) {
        throw new ToolError("E_TOOL_TIMEOUT", `HTTP request to ${url} timed out after ${timeoutMs}ms`, { url, timeoutMs });
      }
      throw toMindiError(err);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onParentAbort);
    }
  }
}

function toMindiError(err: unknown): ToolError {
  const msg = err instanceof Error ? err.message : String(err);
  return new ToolError("E_TOOL_FAILED", `HTTP request failed: ${msg}`, { cause: err });
}
