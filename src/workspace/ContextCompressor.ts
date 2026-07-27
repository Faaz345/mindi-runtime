/**
 * ContextCompressor — rolling summaries for long-lived conversations.
 *
 * When a session's verbatim history grows past the rolling window, the older
 * messages are folded into a compact prose summary and dropped from the
 * verbatim history. The summary is persisted in `.mindi/memory/summaries.json`
 * and injected before the recent messages on every request.
 *
 * This keeps the model's context bounded while preserving long-term
 * conversational memory — exactly how Claude Code / Cursor scale to
 * long-lived projects.
 *
 * The compression itself is deterministic and local (no model round-trip):
 * it extracts the salient user intents and assistant outcomes from the
 * dropped messages and concatenates them with the previous summary. This is
 * intentionally cheap so it can run after every response. A richer LLM-based
 * summary can be layered on later by injecting a summarization capability.
 */

import type { ChatMessage } from "../core/types.js";
import type { SessionSummary2 } from "./types.js";
import type { WorkspaceStore } from "./WorkspaceStore.js";

export interface CompressOptions {
  /** Max verbatim messages to keep after compression */
  keepRecent: number;
}

export interface CompressResult {
  /** Whether compression happened */
  compressed: boolean;
  /** Number of messages folded into the summary */
  foldedCount: number;
  /** New summary (if regenerated) */
  summary?: SessionSummary2;
  /** The trimmed history to keep verbatim (recent + protected system msgs) */
  kept?: ChatMessage[];
}

export class ContextCompressor {
  constructor(private readonly store: WorkspaceStore) {}

  /**
   * Compress a session's history in place. If `messages.length <= keepRecent`
   * nothing happens. Otherwise the leading (older) messages are folded into
   * the rolling summary and removed from the returned history.
   *
   * Returns the trimmed verbatim history (recent messages) and the new
   * summary. The caller is responsible for persisting the trimmed history
   * (via MemoryStore) and the summary (via this store).
   */
  compress(
    sessionId: string,
    messages: ChatMessage[],
    opts: CompressOptions,
  ): CompressResult {
    const { keepRecent } = opts;
    if (messages.length <= keepRecent) {
      return { compressed: false, foldedCount: 0 };
    }

    // Preserve the leading system message(s) — they define the assistant's
    // persona and must never be folded into a summary.
    const systemCount = this.countLeadingSystem(messages);
    const protectedCount = Math.max(systemCount, 0);
    const window = Math.max(keepRecent, protectedCount);

    if (messages.length <= window) {
      return { compressed: false, foldedCount: 0 };
    }

    // The slice to fold = everything between the protected system messages
    // and the recent window.
    const toFold = messages.slice(protectedCount, messages.length - (window - protectedCount));
    const toKeep: ChatMessage[] = [
      ...messages.slice(0, protectedCount),
      ...messages.slice(messages.length - (window - protectedCount)),
    ];

    if (toFold.length === 0) {
      return { compressed: false, foldedCount: 0 };
    }

    const store = this.store.readSummaries();
    const prev = store.summaries[sessionId];
    const text = this.summarize(toFold, prev?.text);
    const summary: SessionSummary2 = {
      generatedAt: Date.now(),
      text,
      foldedMessageCount: (prev?.foldedMessageCount ?? 0) + toFold.length,
      tokenEstimate: Math.ceil(text.length / 4),
    };
    store.summaries[sessionId] = summary;
    this.store.writeSummaries(store);

    return { compressed: true, foldedCount: toFold.length, summary, kept: toKeep };
  }

  /** Retrieve the current rolling summary for a session (if any). */
  getSummary(sessionId: string): SessionSummary2 | undefined {
    return this.store.readSummaries().summaries[sessionId];
  }

  /** Drop the summary for a session (e.g. when the session is deleted). */
  clearSummary(sessionId: string): void {
    const store = this.store.readSummaries();
    if (store.summaries[sessionId]) {
      delete store.summaries[sessionId];
      this.store.writeSummaries(store);
    }
  }

  // ---- Internal -------------------------------------------------------

  private countLeadingSystem(messages: ChatMessage[]): number {
    let n = 0;
    for (const m of messages) {
      if (m.role === "system") n++;
      else break;
    }
    return n;
  }

  /**
   * Deterministic local summarizer. Builds a compact bullet list of the
   * salient user intents and assistant outcomes from the dropped messages,
   * prefixed with any prior summary so memory accumulates over time.
   *
   * This is deliberately not LLM-driven: it's fast, free, and offline. The
   * hooks for an LLM summarizer are present (the function is the only seam)
   * so a future capability can replace it without touching callers.
   */
  private summarize(messages: ChatMessage[], prevSummary?: string): string {
    const bullets: string[] = [];
    if (prevSummary) {
      bullets.push(prevSummary.trim());
    }

    for (const m of messages) {
      const text = toText(m.content);
      if (!text) continue;
      const snippet = truncate(text, 240);
      if (m.role === "user") {
        bullets.push(`User asked: ${snippet}`);
      } else if (m.role === "assistant") {
        bullets.push(`Assistant: ${snippet}`);
      } else if (m.role === "capability" || m.role === "tool") {
        bullets.push(`[${m.role}] ${m.name ?? ""}: ${snippet}`);
      }
      // system messages are preserved verbatim elsewhere; skip here.
    }

    // Cap the accumulated summary so it doesn't grow without bound across
    // many compressions. Keep the most recent bullets.
    const maxBullets = 40;
    if (bullets.length > maxBullets) {
      return bullets.slice(bullets.length - maxBullets).join("\n");
    }
    return bullets.join("\n");
  }
}

function toText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p.type === "text" ? p.text : p.type === "image_url" ? p.url : "[image]"))
      .join(" ");
  }
  return "";
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}
