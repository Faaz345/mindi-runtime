/**
 * SessionSearch — search previous conversations.
 *
 * Supports:
 *   - keyword / fuzzy search across message bodies and titles
 *   - filtering by provider, model, date range, message count
 *   - quick switching (returns ranked session ids)
 *
 * The fuzzy matcher is a lightweight subsequence scorer (no dependencies),
 * good enough for fast switching across hundreds of sessions. Exact word
 * matches rank higher than fuzzy subsequence matches.
 */

import type { SearchQuery, SessionSearchResult, SessionRecord, SessionSummary } from "./types.js";
import type { WorkspaceStore } from "./WorkspaceStore.js";

export class SessionSearch {
  /**
   * Optional in-memory record provider. When set, search prefers live
   * in-memory records over disk reads — this ensures debounced writes
   * (Phase 8) don't cause stale search results.
   */
  private liveRecords: (() => Map<string, SessionRecord>) | null = null;

  constructor(private readonly store: WorkspaceStore) {}

  /** Attach a live record source (called by WorkspaceSessionManager). */
  attachLiveRecords(provider: () => Map<string, SessionRecord>): void {
    this.liveRecords = provider;
  }

  /** Run a search against all sessions (in-memory first, disk fallback). */
  search(query: SearchQuery): SessionSearchResult[] {
    const q = (query.query ?? "").trim().toLowerCase();
    const terms = q ? q.split(/\s+/).filter(Boolean) : [];
    const results: SessionSearchResult[] = [];

    // Phase 8: Prefer in-memory records (always up-to-date) over disk reads.
    // Merge both sources: in-memory records take priority, but disk-only
    // sessions (not yet loaded) are also included.
    const live = this.liveRecords?.();
    const diskIds = this.store.listSessionFiles();
    const allIds = live
      ? [...new Set([...live.keys(), ...diskIds])]
      : diskIds;

    for (const id of allIds) {
      const rec = live?.get(id) ?? this.store.readSession(id);
      if (!rec) continue;
      if (rec.archived && !query.includeArchived) continue;
      if (query.providerId && rec.providerId !== query.providerId) continue;
      if (query.modelId && rec.modelId !== query.modelId) continue;
      if (query.sessionIds && !query.sessionIds.includes(rec.id)) continue;
      if (query.since && rec.createdAt < query.since) continue;
      if (query.until && rec.createdAt > query.until) continue;
      if (query.minMessages && rec.messages.length < query.minMessages) continue;

      const matchedOn: string[] = [];
      let score = 0;
      let messageIndex: number | undefined;
      let snippet: string | undefined;

      if (terms.length > 0) {
        // Title match (highest weight)
        const titleScore = fuzzyScore(terms, rec.title);
        if (titleScore > 0) {
          matchedOn.push("title");
          score += titleScore * 2;
        }

        // Message body match
        for (let i = 0; i < rec.messages.length; i++) {
          const msg = rec.messages[i]!;
          const text = toText(msg.content).toLowerCase();
          if (!text) continue;
          let msgScore = 0;
          for (const term of terms) {
            if (text.includes(term)) msgScore += 1; // exact word match
            else if (subsequence(term, text)) msgScore += 0.3; // fuzzy
          }
          if (msgScore > 0) {
            matchedOn.push("message");
            score += msgScore;
            if (messageIndex === undefined || msgScore > (score - msgScore)) {
              messageIndex = i;
              snippet = makeSnippet(text, terms[0]!);
            }
          }
        }

        // Tag match
        for (const tag of rec.tags) {
          if (fuzzyScore(terms, tag) > 0) {
            matchedOn.push("tag");
            score += 0.5;
          }
        }

        // Working files match
        for (const f of rec.workingFiles) {
          if (fuzzyScore(terms, f) > 0) {
            matchedOn.push("file");
            score += 0.5;
          }
        }

        if (matchedOn.length === 0) continue;
      } else {
        // No query → list mode: rank by recency.
        score = 1 / (1 + (Date.now() - rec.updatedAt) / 86_400_000);
      }

      results.push({
        sessionId: rec.id,
        title: rec.title,
        matchedOn,
        score: Math.min(score, 1),
        messageIndex,
        snippet,
        summary: toSummary(rec),
      });
    }

    results.sort((a, b) => b.score - a.score || b.summary.updatedAt - a.summary.updatedAt);
    return results;
  }

  /** Quick switch: return the single best match for a query. */
  quickSwitch(query: string): SessionSearchResult | null {
    const results = this.search({ query, includeArchived: false });
    return results[0] ?? null;
  }
}

// ---- helpers ---------------------------------------------------------

function toSummary(rec: SessionRecord): SessionSummary {
  return {
    id: rec.id,
    title: rec.title,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    openedAt: rec.openedAt,
    providerId: rec.providerId,
    modelId: rec.modelId,
    messageCount: rec.messages.length,
    archived: rec.archived,
    pinned: rec.pinned,
    tags: rec.tags,
  };
}

function toText(content: SessionRecord["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p.type === "text" ? p.text : p.type === "image_url" ? p.url : "[image]"))
      .join(" ");
  }
  return "";
}

/** True if `needle` appears as a subsequence of `haystack` (fuzzy match). */
function subsequence(needle: string, haystack: string): boolean {
  if (!needle) return true;
  let ni = 0;
  for (let hi = 0; hi < haystack.length && ni < needle.length; hi++) {
    if (haystack[hi] === needle[ni]) ni++;
  }
  return ni === needle.length;
}

/** Score how well `terms` match against `text`. Higher = better. */
function fuzzyScore(terms: string[], text: string): number {
  const hay = text.toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (hay.includes(term)) total += 1;
    else if (subsequence(term, hay)) total += 0.3;
  }
  return total;
}

/** Build a ~80-char snippet centered on the first match of `term`. */
function makeSnippet(text: string, term: string): string {
  const idx = text.indexOf(term);
  if (idx < 0) return text.slice(0, 80);
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + term.length + 30);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}
