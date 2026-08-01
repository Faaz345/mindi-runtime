/**
 * GitAugment — augmentation module for repository inspection and access.
 *
 * Fires when: the request references a GitHub/GitLab/Bitbucket repository.
 *
 * COST-AWARE STRATEGY (cheapest first):
 *   1. HTTP inspection (cost: 1) — fetch README, file tree, metadata via API
 *   2. Web search (cost: 2) — search for repo information
 *   3. Clone (cost: 5) — ONLY if the user's intent requires code modification
 *
 * The planner ALWAYS prefers the least expensive workflow. Cloning a
 * repository just to "tell me about it" is NEVER correct — HTTP inspection
 * provides README, description, stats, and file tree without cloning.
 *
 * This module ELIMINATES unnecessary git clone operations.
 */

import type { CapabilityType } from "../../core/types.js";
import { CapabilityType as Cap } from "../../core/types.js";
import type {
  AugmentationContext,
  AugmentationModule,
  RequestAnalysis,
  StructuredContextBlock,
} from "../types.js";

export class GitAugment implements AugmentationModule {
  readonly id = "git-augment";
  readonly capability: CapabilityType = Cap.Git;
  readonly label = "Repository Access";

  /**
   * Detect: fires when repository references are present.
   */
  detect(input: RequestAnalysis): boolean {
    return input.repositories.length > 0;
  }

  /**
   * Execute: apply cost-aware strategy for each referenced repository.
   *
   * Decision tree:
   *   repo.needsClone === false → HTTP inspection only (README + metadata)
   *   repo.needsClone === true  → Clone via Git provider
   */
  async execute(input: RequestAnalysis, ctx: AugmentationContext): Promise<StructuredContextBlock> {
    const start = Date.now();
    const repos = input.repositories;

    if (repos.length === 0) {
      return {
        capability: Cap.Git,
        source: this.id,
        ok: false,
        summary: "No repositories detected",
        detail: "Git augmentation triggered but no repositories found in request.",
        metadata: {},
        durationMs: Date.now() - start,
        error: "No repositories",
      };
    }

    const results: Array<{ repo: string; strategy: string; ok: boolean; content: string; error?: string }> = [];

    for (const repo of repos) {
      if (repo.needsClone) {
        // EXPENSIVE PATH: user wants to modify/run/test the code.
        const result = await this.cloneRepo(repo.url, repo.fullName, input, ctx);
        results.push({ repo: repo.fullName, strategy: "clone", ...result });
      } else {
        // CHEAP PATH: user wants information ABOUT the repo.
        const result = await this.inspectRepo(repo.url, repo.fullName, repo.host, input, ctx);
        results.push({ repo: repo.fullName, strategy: "http-inspect", ...result });
      }
    }

    const successful = results.filter((r) => r.ok);
    const sections = results.map((r) => {
      const header = `### ${r.repo} (strategy: ${r.strategy})`;
      return r.ok ? `${header}\n${r.content}` : `${header}\n[Failed: ${r.error}]`;
    });

    return {
      capability: Cap.Git,
      source: this.id,
      ok: successful.length > 0,
      summary: `Inspected ${successful.length}/${repos.length} repo(s)`,
      detail: [
        "Repository information gathered by the runtime:",
        "",
        ...sections,
        "",
        "Use this information to answer the user's question.",
        "Do not claim you cloned or fetched the repository yourself.",
      ].join("\n"),
      metadata: {
        repos: results.map((r) => ({ repo: r.repo, strategy: r.strategy, ok: r.ok })),
        totalRepos: repos.length,
        cloned: results.filter((r) => r.strategy === "clone").length,
        inspected: results.filter((r) => r.strategy === "http-inspect").length,
      },
      durationMs: Date.now() - start,
      error: successful.length === 0 ? "All repository operations failed" : undefined,
    };
  }

  /**
   * Cost: dynamic based on whether cloning is needed.
   * Inspection = 1 (HTTP), Clone = 5 (expensive).
   */
  costEstimate(input: RequestAnalysis): number {
    // If any repo needs cloning, report high cost.
    if (input.repositories.some((r) => r.needsClone)) return 5;
    // Otherwise, cheap HTTP inspection.
    return 1;
  }

  // ---- HTTP Inspection (cheap) -----------------------------------------

  private async inspectRepo(
    url: string,
    fullName: string,
    host: string,
    input: RequestAnalysis,
    ctx: AugmentationContext,
  ): Promise<{ ok: boolean; content: string; error?: string }> {
    // Try to fetch repo metadata via HTTP (GitHub/GitLab API or raw page).
    if (!ctx.isNetworkAllowed(url)) {
      return { ok: false, content: "", error: "Network access denied by policy" };
    }

    try {
      // Use browser/http provider if available.
      const providers = ctx.providersFor(Cap.Browser);
      if (providers.length > 0) {
        const provider = providers[0]!;
        const apiUrl = this.buildApiUrl(url, fullName, host);
        const result = await provider.executeCapability(
          Cap.Browser,
          {
            type: Cap.Browser,
            params: { action: "fetch", url: apiUrl },
            requestId: input.requestId,
            sessionId: input.sessionId,
          },
          ctx.ctx,
        );
        if (result.ok) {
          return { ok: true, content: this.formatRepoInspection(fullName, result.payload) };
        }
      }

      // Fallback: direct fetch of the repo page.
      const response = await fetch(url, {
        signal: ctx.ctx.signal,
        headers: {
          "User-Agent": "MINDI-Runtime/1.0",
          Accept: "text/html,application/json",
        },
      });

      if (!response.ok) {
        return { ok: false, content: "", error: `HTTP ${response.status}` };
      }

      const text = await response.text();
      // Extract basic info from the page.
      const description = this.extractMetaDescription(text);
      const title = this.extractTitle(text);

      return {
        ok: true,
        content: [
          `Repository: ${fullName}`,
          `URL: ${url}`,
          title ? `Title: ${title}` : "",
          description ? `Description: ${description}` : "",
          "",
          "Note: Full inspection available. Clone not performed (inspection sufficient for this request).",
        ].filter(Boolean).join("\n"),
      };
    } catch (err) {
      return {
        ok: false,
        content: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ---- Clone (expensive, last resort) ----------------------------------

  private async cloneRepo(
    url: string,
    fullName: string,
    input: RequestAnalysis,
    ctx: AugmentationContext,
  ): Promise<{ ok: boolean; content: string; error?: string }> {
    // Use the Git provider/tool if available.
    const gitProviders = ctx.providersFor(Cap.Git);
    if (gitProviders.length > 0) {
      const provider = gitProviders[0]!;
      try {
        const result = await provider.executeCapability(
          Cap.Git,
          {
            type: Cap.Git,
            params: { action: "clone", url, fullName },
            requestId: input.requestId,
            sessionId: input.sessionId,
          },
          ctx.ctx,
        );
        if (result.ok) {
          return {
            ok: true,
            content: `Repository ${fullName} cloned successfully.\n${extractPayloadText(result.payload)}`,
          };
        }
        return { ok: false, content: "", error: result.error ?? "Clone failed" };
      } catch (err) {
        return { ok: false, content: "", error: err instanceof Error ? err.message : String(err) };
      }
    }

    // No git provider — try terminal.
    const terminalProviders = ctx.providersFor(Cap.Terminal);
    if (terminalProviders.length > 0) {
      const provider = terminalProviders[0]!;
      const cloneDir = `${ctx.workspace}/.mindi/clones/${fullName.replace("/", "-")}`;
      try {
        const result = await provider.executeCapability(
          Cap.Terminal,
          {
            type: Cap.Terminal,
            params: { command: `git clone --depth 1 "${url}" "${cloneDir}"` },
            requestId: input.requestId,
            sessionId: input.sessionId,
          },
          ctx.ctx,
        );
        if (result.ok) {
          return {
            ok: true,
            content: `Repository ${fullName} cloned to ${cloneDir}.\n${extractPayloadText(result.payload)}`,
          };
        }
        return { ok: false, content: "", error: result.error ?? "Clone failed" };
      } catch (err) {
        return { ok: false, content: "", error: err instanceof Error ? err.message : String(err) };
      }
    }

    return {
      ok: false,
      content: "",
      error: "No Git or Terminal provider available for cloning",
    };
  }

  // ---- Helpers ---------------------------------------------------------

  private buildApiUrl(url: string, fullName: string, host: string): string {
    if (host === "github") return `https://api.github.com/repos/${fullName}`;
    if (host === "gitlab") return `https://gitlab.com/api/v4/projects/${encodeURIComponent(fullName)}`;
    return url; // Bitbucket etc. — just use the page URL.
  }

  private formatRepoInspection(fullName: string, payload: { kind: string; [key: string]: unknown }): string {
    const text = extractPayloadText(payload);
    // Try to parse as JSON (GitHub API response).
    try {
      const data = JSON.parse(text);
      return [
        `Repository: ${data.full_name ?? fullName}`,
        `Description: ${data.description ?? "N/A"}`,
        `Language: ${data.language ?? "N/A"}`,
        `Stars: ${data.stargazers_count ?? "?"} | Forks: ${data.forks_count ?? "?"} | Issues: ${data.open_issues_count ?? "?"}`,
        `Created: ${data.created_at ?? "?"} | Updated: ${data.updated_at ?? "?"}`,
        `License: ${data.license?.name ?? "N/A"}`,
        `Topics: ${(data.topics ?? []).join(", ") || "N/A"}`,
        `Default branch: ${data.default_branch ?? "main"}`,
      ].join("\n");
    } catch {
      // Not JSON — return raw text truncated.
      return text.slice(0, 4000);
    }
  }

  private extractMetaDescription(html: string): string {
    const match = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
    return match?.[1] ?? "";
  }

  private extractTitle(html: string): string {
    const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return match?.[1]?.trim() ?? "";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractPayloadText(payload: { kind: string; [key: string]: unknown }): string {
  if (payload.kind === "text") return (payload as any).text ?? "";
  if (payload.kind === "json") return JSON.stringify((payload as any).data, null, 2);
  if (payload.kind === "command") {
    const p = payload as any;
    return [p.stdout ?? "", p.stderr ?? ""].filter(Boolean).join("\n");
  }
  return JSON.stringify(payload, null, 2);
}
