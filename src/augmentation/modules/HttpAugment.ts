/**
 * HttpAugment — augmentation module for URL content fetching.
 *
 * Fires when: the request text contains one or more URLs that are NOT
 *             repository URLs (those are handled by GitAugment).
 *
 * Execution: fetches each URL, parses HTML/content, extracts the main
 *            readable content, and injects it as structured context.
 *
 * Cost: 1 (cheapest network operation — simple HTTP GET + parse).
 *
 * This module ELIMINATES "I cannot access URLs" responses.
 */

import type { CapabilityType } from "../../core/types.js";
import { CapabilityType as Cap } from "../../core/types.js";
import type {
  AugmentationContext,
  AugmentationModule,
  RequestAnalysis,
  StructuredContextBlock,
} from "../types.js";

export class HttpAugment implements AugmentationModule {
  readonly id = "http-augment";
  readonly capability: CapabilityType = Cap.Browser;
  readonly label = "URL Content Fetch";

  /**
   * Detect: fires when non-repository URLs are present.
   * Repository URLs are excluded — GitAugment handles those with
   * cost-aware strategy (HTTP inspect first, clone only if needed).
   */
  detect(input: RequestAnalysis): boolean {
    return input.urls.some((u) => !u.isRepository);
  }

  /**
   * Execute: fetch each non-repo URL and extract main content.
   */
  async execute(input: RequestAnalysis, ctx: AugmentationContext): Promise<StructuredContextBlock> {
    const start = Date.now();
    const targetUrls = input.urls.filter((u) => !u.isRepository);

    if (targetUrls.length === 0) {
      return {
        capability: Cap.Browser,
        source: this.id,
        ok: false,
        summary: "No URLs to fetch",
        detail: "No non-repository URLs detected in the request.",
        metadata: {},
        durationMs: Date.now() - start,
        error: "No URLs",
      };
    }

    const results: Array<{ url: string; ok: boolean; content: string; error?: string }> = [];

    for (const target of targetUrls) {
      // Check network policy.
      if (!ctx.isNetworkAllowed(target.url)) {
        results.push({
          url: target.url,
          ok: false,
          content: "",
          error: "Network access denied by policy",
        });
        continue;
      }

      try {
        // Use the browser/http provider if available, otherwise direct fetch.
        const providers = ctx.providersFor(Cap.Browser);
        if (providers.length > 0) {
          const provider = providers[0]!;
          const result = await provider.executeCapability(
            Cap.Browser,
            {
              type: Cap.Browser,
              params: { action: "fetch", url: target.url },
              requestId: input.requestId,
              sessionId: input.sessionId,
            },
            ctx.ctx,
          );
          if (result.ok) {
            results.push({ url: target.url, ok: true, content: extractPayloadText(result.payload) });
          } else {
            results.push({ url: target.url, ok: false, content: "", error: result.error });
          }
        } else {
          // Fallback: direct HTTP fetch.
          const content = await directFetch(target.url, ctx.ctx.signal);
          results.push({ url: target.url, ok: true, content });
        }
      } catch (err) {
        results.push({
          url: target.url,
          ok: false,
          content: "",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const successful = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);

    // Build combined detail.
    const sections = results.map((r) => {
      if (r.ok) {
        return `### ${r.url}\n${truncateContent(r.content, 8000)}`;
      }
      return `### ${r.url}\n[Fetch failed: ${r.error}]`;
    });

    return {
      capability: Cap.Browser,
      source: this.id,
      ok: successful.length > 0,
      summary: `Fetched ${successful.length}/${targetUrls.length} URL(s)`,
      detail: [
        "The following web page content was fetched by the runtime:",
        "",
        ...sections,
        "",
        "Use this content to answer the user's question. Do not claim you fetched it.",
      ].join("\n"),
      metadata: {
        totalUrls: targetUrls.length,
        successful: successful.length,
        failed: failed.length,
        urls: results.map((r) => ({ url: r.url, ok: r.ok })),
      },
      durationMs: Date.now() - start,
      error: failed.length > 0 ? `${failed.length} URL(s) failed to fetch` : undefined,
    };
  }

  /** Cost: 1 — cheapest network operation. */
  costEstimate(_input: RequestAnalysis): number {
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function directFetch(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    signal,
    headers: {
      "User-Agent": "MINDI-Runtime/1.0 (Capability Augmentation)",
      Accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();

  // If HTML, extract readable content (basic extraction).
  if (contentType.includes("text/html")) {
    return extractReadableContent(text);
  }

  return text;
}

/**
 * Basic readable content extraction from HTML.
 * Strips scripts, styles, nav, footer — keeps main content.
 */
function extractReadableContent(html: string): string {
  // Remove script/style/nav/footer/header tags and their content.
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  // Extract title.
  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch?.[1]?.trim() ?? "";

  // Try to find main/article content.
  const mainMatch = text.match(/<(?:main|article)[^>]*>([\s\S]*?)<\/(?:main|article)>/i);
  if (mainMatch) {
    text = mainMatch[1]!;
  }

  // Strip remaining HTML tags.
  text = text
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  return title ? `Title: ${title}\n\n${text}` : text;
}

function extractPayloadText(payload: { kind: string; [key: string]: unknown }): string {
  if (payload.kind === "text") return (payload as any).text ?? "";
  if (payload.kind === "json") return JSON.stringify((payload as any).data, null, 2);
  return JSON.stringify(payload, null, 2);
}

function truncateContent(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n\n[Content truncated — ${text.length - maxChars} more characters]`;
}
