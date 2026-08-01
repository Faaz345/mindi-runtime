/**
 * WebSearchAugment — augmentation module for web search.
 *
 * Fires when: the request has search/research intent signals (freshness
 *             language, factual questions, real-time data references).
 *
 * Execution: executes a web search via the runtime's search provider,
 *            collects results, and injects them as structured context.
 *
 * Cost: 2 (network call, but lightweight — no page rendering).
 */

import type { CapabilityType } from "../../core/types.js";
import { CapabilityType as Cap } from "../../core/types.js";
import type {
  AugmentationContext,
  AugmentationModule,
  RequestAnalysis,
  StructuredContextBlock,
} from "../types.js";

/** Minimum confidence threshold to trigger search augmentation. */
const MIN_CONFIDENCE = 0.65;
/** Maximum search results to inject. */
const MAX_RESULTS = 8;

export class WebSearchAugment implements AugmentationModule {
  readonly id = "web-search-augment";
  readonly capability: CapabilityType = Cap.WebSearch;
  readonly label = "Web Search";

  /**
   * Detect: fires when search intent is detected with sufficient confidence.
   */
  detect(input: RequestAnalysis): boolean {
    if (!input.searchIntent) return false;
    return input.searchIntent.confidence >= MIN_CONFIDENCE;
  }

  /**
   * Execute: perform web search and inject results.
   */
  async execute(input: RequestAnalysis, ctx: AugmentationContext): Promise<StructuredContextBlock> {
    const start = Date.now();
    const intent = input.searchIntent;

    if (!intent) {
      return {
        capability: Cap.WebSearch,
        source: this.id,
        ok: false,
        summary: "No search intent detected",
        detail: "Search augmentation was triggered but no search intent is present.",
        metadata: {},
        durationMs: Date.now() - start,
        error: "No search intent",
      };
    }

    // Find a web search provider.
    const providers = ctx.providersFor(Cap.WebSearch);
    if (providers.length === 0) {
      return {
        capability: Cap.WebSearch,
        source: this.id,
        ok: false,
        summary: "No web search provider available",
        detail: "The runtime has no configured provider with web search capability.",
        metadata: { query: intent.query },
        durationMs: Date.now() - start,
        error: "No web search provider configured",
      };
    }

    const provider = providers[0]!;

    try {
      const result = await provider.executeCapability(
        Cap.WebSearch,
        {
          type: Cap.WebSearch,
          params: {
            query: intent.query,
            maxResults: MAX_RESULTS,
          },
          requestId: input.requestId,
          sessionId: input.sessionId,
        },
        ctx.ctx,
      );

      if (!result.ok) {
        return {
          capability: Cap.WebSearch,
          source: `${this.id} via ${provider.id}`,
          ok: false,
          summary: `Web search failed via ${provider.label}`,
          detail: `Search for "${intent.query}" failed: ${result.error ?? "unknown error"}`,
          metadata: { query: intent.query, provider: provider.id },
          durationMs: Date.now() - start,
          error: result.error,
        };
      }

      // Format search results.
      const formatted = this.formatSearchResults(result.payload);

      return {
        capability: Cap.WebSearch,
        source: `${this.id} via ${provider.id}`,
        ok: true,
        summary: `Web search: "${truncate(intent.query, 60)}" (${formatted.count} results)`,
        detail: [
          `Web search results for: "${intent.query}"`,
          `(Search reason: ${intent.reason})`,
          "",
          formatted.text,
          "",
          "Use these results to answer the user's question. Cite sources where appropriate.",
          "Do not claim you searched the web yourself — the runtime performed this search.",
        ].join("\n"),
        metadata: {
          query: intent.query,
          provider: provider.id,
          resultCount: formatted.count,
          confidence: intent.confidence,
        },
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        capability: Cap.WebSearch,
        source: `${this.id} via ${provider.id}`,
        ok: false,
        summary: "Web search threw an exception",
        detail: `Search error: ${err instanceof Error ? err.message : String(err)}`,
        metadata: { query: intent.query },
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Cost: 2 — network call but lightweight. */
  costEstimate(_input: RequestAnalysis): number {
    return 2;
  }

  // ---- Helpers ---------------------------------------------------------

  private formatSearchResults(payload: { kind: string; [key: string]: unknown }): { text: string; count: number } {
    if (payload.kind === "search") {
      const results = (payload as any).results as Array<{ title: string; url: string; snippet: string }> ?? [];
      const text = results
        .slice(0, MAX_RESULTS)
        .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
        .join("\n\n");
      return { text: text || "No results returned.", count: results.length };
    }

    if (payload.kind === "text") {
      const text = (payload as any).text ?? "";
      return { text, count: text ? 1 : 0 };
    }

    if (payload.kind === "json") {
      const data = (payload as any).data;
      return { text: JSON.stringify(data, null, 2), count: 1 };
    }

    return { text: JSON.stringify(payload, null, 2), count: 1 };
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + "...";
}
