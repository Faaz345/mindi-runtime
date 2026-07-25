/**
 * Playwright Tool — browser automation.
 *
 * Operations: launch, navigate, screenshot, click, type, evaluate, wait, snapshot, extract
 *
 * NOTE: Requires the `playwright` npm package. If not installed, the tool
 * reports a helpful error. The tool lazily imports Playwright so the runtime
 * doesn't hard-depend on it.
 */

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
  id: "tool.playwright",
  label: "Playwright Browser",
  description: "Browser automation: launch, navigate, screenshot, click, type, evaluate, wait, accessibility snapshot, DOM extraction",
  capability: CAP,
  version: "1.0.0",
  permissions: ["process.spawn", "network"],
  operations: ["launch", "navigate", "screenshot", "click", "type", "evaluate", "wait", "snapshot", "extract"],
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["launch", "navigate", "screenshot", "click", "type", "evaluate", "wait", "snapshot", "extract"] },
      url: { type: "string" },
      selector: { type: "string" },
      text: { type: "string" },
      script: { type: "string" },
      waitMs: { type: "number" },
    },
    required: ["action"],
  },
  streaming: false,
  defaultTimeoutMs: 60_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableErrors: [] } as ToolRetryPolicy,
};

interface BrowserState {
  browser: unknown;
  page: unknown;
}

export class PlaywrightTool extends ToolBase {
  readonly id = "tool.playwright";
  readonly label = "Playwright Browser";
  readonly capability: CapabilityType = CAP;
  readonly metadata = METADATA;

  private state: BrowserState | null = null;

  protected async run(input: CapabilityInput, ctx: ExecutionContext): Promise<CapabilityResult> {
    assertPermissions(this.sb.getPolicy(), this.metadata.permissions);

    const action = String(input.params.action ?? "");
    const start = Date.now();

    try {
      switch (action) {
        case "launch":
          return await this.launch(ctx, start);
        case "navigate":
          return await this.navigate(String(input.params.url ?? ""), ctx, start);
        case "screenshot":
          return await this.screenshot(ctx, start);
        case "click":
          return await this.click(String(input.params.selector ?? ""), ctx, start);
        case "type":
          return await this.type(String(input.params.selector ?? ""), String(input.params.text ?? ""), ctx, start);
        case "evaluate":
          return await this.evaluate(String(input.params.script ?? ""), ctx, start);
        case "wait":
          return await this.wait(String(input.params.selector ?? ""), Number(input.params.waitMs ?? 5000), ctx, start);
        case "snapshot":
          return await this.snapshot(ctx, start);
        case "extract":
          return await this.extract(ctx, start);
        default:
          throw new ToolError("E_TOOL_FAILED", `PlaywrightTool: unknown action "${action}"`, { action });
      }
    } catch (err) {
      return {
        type: CAP,
        source: this.id,
        ok: false,
        payload: { kind: "text", text: `Playwright ${action} failed: ${err instanceof Error ? err.message : String(err)}` },
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  private async launch(_ctx: ExecutionContext, start: number): Promise<CapabilityResult> {
    const pw = await importPlaywright();
    const browser = await pw.chromium.launch({ headless: true });
    const page = await browser.newPage();
    this.state = { browser, page };
    return {
      type: CAP, source: this.id, ok: true,
      payload: { kind: "text", text: "Browser launched (Chromium, headless)" },
      durationMs: Date.now() - start,
    };
  }

  private async navigate(url: string, _ctx: ExecutionContext, start: number): Promise<CapabilityResult> {
    this.requireBrowser();
    await (this.state!.page as { goto: (url: string) => Promise<unknown> }).goto(url);
    return {
      type: CAP, source: this.id, ok: true,
      payload: { kind: "text", text: `Navigated to ${url}` },
      durationMs: Date.now() - start,
    };
  }

  private async screenshot(_ctx: ExecutionContext, start: number): Promise<CapabilityResult> {
    this.requireBrowser();
    const buf = await (this.state!.page as { screenshot: () => Promise<Buffer> }).screenshot();
    return {
      type: CAP, source: this.id, ok: true,
      payload: { kind: "image", mimeType: "image/png", base64: buf.toString("base64") },
      durationMs: Date.now() - start,
    };
  }

  private async click(selector: string, _ctx: ExecutionContext, start: number): Promise<CapabilityResult> {
    this.requireBrowser();
    await (this.state!.page as { click: (s: string) => Promise<unknown> }).click(selector);
    return {
      type: CAP, source: this.id, ok: true,
      payload: { kind: "text", text: `Clicked: ${selector}` },
      durationMs: Date.now() - start,
    };
  }

  private async type(selector: string, text: string, _ctx: ExecutionContext, start: number): Promise<CapabilityResult> {
    this.requireBrowser();
    await (this.state!.page as { fill: (s: string, t: string) => Promise<unknown> }).fill(selector, text);
    return {
      type: CAP, source: this.id, ok: true,
      payload: { kind: "text", text: `Typed into: ${selector}` },
      durationMs: Date.now() - start,
    };
  }

  private async evaluate(script: string, _ctx: ExecutionContext, start: number): Promise<CapabilityResult> {
    this.requireBrowser();
    const result = await (this.state!.page as { evaluate: (s: string) => Promise<unknown> }).evaluate(script);
    return {
      type: CAP, source: this.id, ok: true,
      payload: { kind: "json", data: result },
      durationMs: Date.now() - start,
    };
  }

  private async wait(selector: string, waitMs: number, _ctx: ExecutionContext, start: number): Promise<CapabilityResult> {
    this.requireBrowser();
    if (selector) {
      await (this.state!.page as { waitForSelector: (s: string, o: { timeout: number }) => Promise<unknown> }).waitForSelector(selector, { timeout: waitMs });
    } else {
      await new Promise((r) => setTimeout(r, waitMs));
    }
    return {
      type: CAP, source: this.id, ok: true,
      payload: { kind: "text", text: `Waited ${waitMs}ms` },
      durationMs: Date.now() - start,
    };
  }

  private async snapshot(_ctx: ExecutionContext, start: number): Promise<CapabilityResult> {
    this.requireBrowser();
    const snapshot = await (this.state!.page as { accessibility: { snapshot: () => Promise<unknown> } }).accessibility.snapshot();
    return {
      type: CAP, source: this.id, ok: true,
      payload: { kind: "json", data: snapshot },
      durationMs: Date.now() - start,
    };
  }

  private async extract(_ctx: ExecutionContext, start: number): Promise<CapabilityResult> {
    this.requireBrowser();
    const html = await (this.state!.page as { content: () => Promise<string> }).content();
    const capped = this.sb.capOutput(html);
    return {
      type: CAP, source: this.id, ok: true,
      payload: { kind: "text", text: capped.data + (capped.truncated ? "\n[...truncated]" : "") },
      durationMs: Date.now() - start,
    };
  }

  private requireBrowser(): void {
    if (!this.state) {
      throw new ToolError("E_TOOL_FAILED", "PlaywrightTool: browser not launched. Call action=launch first.", {});
    }
  }
}

/** Lazily import Playwright. Throws a helpful error if not installed. */
async function importPlaywright(): Promise<typeof import("playwright")> {
  try {
    return await import("playwright");
  } catch {
    throw new ToolError(
      "E_TOOL_FAILED",
      "Playwright is not installed. Run: npm install playwright",
      {},
    );
  }
}
