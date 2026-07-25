/**
 * Search Tool — pluggable web search with provider interface.
 *
 * Providers:
 *   - Brave Search API
 *   - Tavily Search API
 *   - DuckDuckGo (Lite, no API key needed)
 *
 * All providers implement the SearchProvider interface.
 * Results are normalized to a common format.
 */

import type {
  CapabilityInput,
  CapabilityResult,
  CapabilityType,
  ExecutionContext,
} from "../../core/types.js";
import { ToolError } from "../../core/errors.js";
import { ToolBase, type ToolMetadata, type ToolRetryPolicy, assertPermissions } from "../sdk/ToolBase.js";

const CAP: CapabilityType = "web_search";

// ---------------------------------------------------------------------------
// Search Provider Interface
// ---------------------------------------------------------------------------

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  readonly id: string;
  readonly label: string;
  readonly requiresApiKey: boolean;
  search(query: string, opts: SearchOptions, ctx: ExecutionContext): Promise<SearchResult[]>;
}

export interface SearchOptions {
  maxResults?: number;
  apiKey?: string;
}

// ---------------------------------------------------------------------------
// DuckDuckGo Provider (no API key needed)
// ---------------------------------------------------------------------------

export class DuckDuckGoProvider implements SearchProvider {
  readonly id = "duckduckgo";
  readonly label = "DuckDuckGo";
  readonly requiresApiKey = false;

  async search(query: string, opts: SearchOptions, ctx: ExecutionContext): Promise<SearchResult[]> {
    const max = opts.maxResults ?? 10;
    // Use the DuckDuckGo Instant Answer API (no key required).
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const onParentAbort = () => ctrl.abort();
    if (ctx.signal.aborted) onParentAbort();
    else ctx.signal.addEventListener("abort", onParentAbort, { once: true });

    try {
      const res = await fetch(url, { signal: ctrl.signal });
      const data = (await res.json()) as {
        Abstract?: string;
        AbstractURL?: string;
        Heading?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
        Results?: Array<{ Text?: string; FirstURL?: string }>;
      };

      const results: SearchResult[] = [];

      // Primary result.
      if (data.Heading && data.Abstract) {
        results.push({
          title: data.Heading,
          url: data.AbstractURL ?? "",
          snippet: data.Abstract,
        });
      }

      // Related topics.
      for (const topic of data.RelatedTopics ?? []) {
        if (topic.Text && topic.FirstURL) {
          results.push({
            title: topic.Text.slice(0, 80),
            url: topic.FirstURL,
            snippet: topic.Text,
          });
        }
        if (results.length >= max) break;
      }

      // Direct results.
      for (const result of data.Results ?? []) {
        if (result.Text && result.FirstURL) {
          results.push({
            title: result.Text.slice(0, 80),
            url: result.FirstURL,
            snippet: result.Text,
          });
        }
        if (results.length >= max) break;
      }

      return results.slice(0, max);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onParentAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// Brave Search Provider
// ---------------------------------------------------------------------------

export class BraveSearchProvider implements SearchProvider {
  readonly id = "brave";
  readonly label = "Brave Search";
  readonly requiresApiKey = true;

  async search(query: string, opts: SearchOptions, ctx: ExecutionContext): Promise<SearchResult[]> {
    if (!opts.apiKey) {
      throw new ToolError("E_TOOL_FAILED", "Brave Search requires an API key", {});
    }
    const max = opts.maxResults ?? 10;
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const onParentAbort = () => ctrl.abort();
    if (ctx.signal.aborted) onParentAbort();
    else ctx.signal.addEventListener("abort", onParentAbort, { once: true });

    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          "X-Subscription-Token": opts.apiKey,
          "Accept": "application/json",
        },
      });
      const data = (await res.json()) as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
      };

      return (data.web?.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.description ?? "",
      })).slice(0, max);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onParentAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// Tavily Search Provider
// ---------------------------------------------------------------------------

export class TavilySearchProvider implements SearchProvider {
  readonly id = "tavily";
  readonly label = "Tavily Search";
  readonly requiresApiKey = true;

  async search(query: string, opts: SearchOptions, ctx: ExecutionContext): Promise<SearchResult[]> {
    if (!opts.apiKey) {
      throw new ToolError("E_TOOL_FAILED", "Tavily Search requires an API key", {});
    }
    const max = opts.maxResults ?? 10;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const onParentAbort = () => ctrl.abort();
    if (ctx.signal.aborted) onParentAbort();
    else ctx.signal.addEventListener("abort", onParentAbort, { once: true });

    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: opts.apiKey,
          query,
          max_results: max,
        }),
      });
      const data = (await res.json()) as {
        results?: Array<{ title?: string; url?: string; content?: string }>;
      };

      return (data.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.content ?? "",
      })).slice(0, max);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onParentAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// Search Tool
// ---------------------------------------------------------------------------

const METADATA: ToolMetadata = {
  id: "tool.search",
  label: "Web Search",
  description: "Pluggable web search: DuckDuckGo (free), Brave, Tavily. Normalized results.",
  capability: CAP,
  version: "1.0.0",
  permissions: ["network"],
  operations: ["search"],
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      maxResults: { type: "number" },
      provider: { type: "string", enum: ["duckduckgo", "brave", "tavily"] },
      apiKey: { type: "string" },
    },
    required: ["query"],
  },
  streaming: false,
  defaultTimeoutMs: 15_000,
  retryPolicy: { maxAttempts: 2, backoffMs: 500, retryableErrors: ["E_TOOL_TIMEOUT"] } as ToolRetryPolicy,
};

export class SearchTool extends ToolBase {
  readonly id = "tool.search";
  readonly label = "Web Search";
  readonly capability: CapabilityType = CAP;
  readonly metadata = METADATA;

  private readonly providers = new Map<string, SearchProvider>();

  constructor(policy: Required<import("../../core/types.js").SandboxPolicy>) {
    super(policy);
    // Register built-in providers.
    this.registerProvider(new DuckDuckGoProvider());
    this.registerProvider(new BraveSearchProvider());
    this.registerProvider(new TavilySearchProvider());
  }

  /** Register a custom search provider. */
  registerProvider(provider: SearchProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  protected async run(input: CapabilityInput, ctx: ExecutionContext): Promise<CapabilityResult> {
    assertPermissions(this.sb.getPolicy(), this.metadata.permissions);

    const query = String(input.params.query ?? "");
    const maxResults = Number(input.params.maxResults ?? 10);
    const providerId = String(input.params.provider ?? "duckduckgo");
    const apiKey = input.params.apiKey ? String(input.params.apiKey) : undefined;

    if (!query) {
      throw new ToolError("E_TOOL_FAILED", "SearchTool: missing query", {});
    }

    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new ToolError("E_TOOL_FAILED", `SearchTool: unknown provider "${providerId}"`, { providerId });
    }

    const start = Date.now();
    ctx.log.debug("search.execute", { provider: providerId, query, maxResults });

    try {
      const results = await provider.search(query, { maxResults, apiKey }, ctx);
      return {
        type: CAP,
        source: this.id,
        ok: true,
        payload: { kind: "search", results },
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        type: CAP,
        source: this.id,
        ok: false,
        payload: { kind: "text", text: `Search failed: ${err instanceof Error ? err.message : String(err)}` },
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }
}
