import type { ChatMessage, ChatRole } from "../core/types.js";
import { SessionError } from "../core/errors.js";

/**
 * Memory Layer
 *
 * Pluggable persistence for conversation history. Default implementation is
 * in-process (RAM) — sufficient for CLI / Desktop use.
 *
 * Swap in a persistent MemoryStore (SQLite, Postgres, Redis, ...) by
 * implementing the same interface. No core changes required.
 */
export interface MemoryStore {
  /** Append messages to a session's history. */
  append(sessionId: string, messages: ChatMessage[]): Promise<void>;
  /** Load (up to limit) most-recent messages for a session. */
  load(sessionId: string, limit?: number): Promise<ChatMessage[]>;
  /** Clear history for a session. */
  clear(sessionId: string): Promise<void>;
  /** Total message count for a session. */
  count(sessionId: string): Promise<number>;
}

/** In-memory store — fine for CLI / Desktop. */
export class InMemoryMemoryStore implements MemoryStore {
  private readonly data = new Map<string, ChatMessage[]>();

  async append(sessionId: string, messages: ChatMessage[]): Promise<void> {
    const list = this.data.get(sessionId) ?? [];
    list.push(...messages);
    this.data.set(sessionId, list);
  }
  async load(sessionId: string, limit?: number): Promise<ChatMessage[]> {
    const list = this.data.get(sessionId) ?? [];
    if (!limit || limit >= list.length) return [...list];
    return list.slice(list.length - limit);
  }
  async clear(sessionId: string): Promise<void> {
    this.data.delete(sessionId);
  }
  async count(sessionId: string): Promise<number> {
    return this.data.get(sessionId)?.length ?? 0;
  }
}

/** Filter messages by role — used when reconstructing history for a request. */
export function filterByRole(messages: ChatMessage[], roles: ChatRole[]): ChatMessage[] {
  const set = new Set(roles);
  return messages.filter((m) => set.has(m.role));
}

/**
 * Apply a sliding-window truncation policy to keep history bounded.
 * Always preserves the first system message (if any).
 */
export function truncateHistory(messages: ChatMessage[], maxMessages: number): ChatMessage[] {
  if (messages.length <= maxMessages) return messages;
  const first = messages[0];
  const rest = first?.role === "system" ? messages.slice(1) : messages.slice();
  const keep = rest.slice(rest.length - (maxMessages - 1));
  return first?.role === "system" ? [first, ...keep] : keep;
}

export class MemoryLayer {
  constructor(private readonly store: MemoryStore, private readonly maxHistory: number) {}

  async remember(sessionId: string, messages: ChatMessage[]): Promise<void> {
    await this.store.append(sessionId, messages);
    // Apply sliding-window truncation if over limit.
    const count = await this.store.count(sessionId);
    if (count > this.maxHistory * 2) {
      const recent = await this.store.load(sessionId, this.maxHistory);
      await this.store.clear(sessionId);
      await this.store.append(sessionId, recent);
    }
  }

  async recall(sessionId: string, limit?: number): Promise<ChatMessage[]> {
    const history = await this.store.load(sessionId, limit ?? this.maxHistory);
    return truncateHistory(history, this.maxHistory);
  }

  async forget(sessionId: string): Promise<void> {
    await this.store.clear(sessionId);
  }

  getStore(): MemoryStore {
    return this.store;
  }
}

export { SessionError };
