import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../core/types.js";
import { SessionError } from "../core/errors.js";
import { MemoryLayer, InMemoryMemoryStore } from "../memory/MemoryLayer.js";

/**
 * Session Manager
 *
 * Owns the lifecycle of conversations. A Session is the user-facing unit of
 * conversational continuity: it remembers the chosen primary model, the
 * conversation history, and per-session metadata.
 *
 * Sessions are decoupled from the runtime — the runtime is stateless across
 * sessions; all continuity lives here.
 */

export interface SessionInit {
  /** User-chosen reasoning provider (e.g. "openai" or "gemini") */
  providerId: string;
  /** User-chosen model id (e.g. "gpt-4o-mini") */
  modelId: string;
  /** Optional initial system prompt */
  systemPrompt?: string;
  /** Optional metadata (client, locale, user id, etc.) */
  meta?: Record<string, unknown>;
}

export interface Session extends SessionInit {
  readonly id: string;
  readonly createdAt: number;
  updatedAt: number;
  meta: Record<string, unknown>;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly memory: MemoryLayer;

  constructor(memory?: MemoryLayer) {
    this.memory = memory ?? new MemoryLayer(new InMemoryMemoryStore(), 50);
  }

  create(init: SessionInit): Session {
    const id = randomUUID();
    const now = Date.now();
    const session: Session = {
      id,
      providerId: init.providerId,
      modelId: init.modelId,
      systemPrompt: init.systemPrompt,
      meta: { ...(init.meta ?? {}) },
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(id, session);

    // Seed the history with the system prompt if provided.
    if (init.systemPrompt) {
      void this.memory.remember(id, [{ role: "system", content: init.systemPrompt }]);
    }
    return session;
  }

  /**
   * Restore a session with a KNOWN id and prior history (used when mirroring
   * a persisted workspace session into the in-memory manager on launch).
   * If a session with this id already exists it is returned unchanged.
   */
  restore(id: string, init: SessionInit, history: ChatMessage[]): Session {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const now = Date.now();
    const session: Session = {
      id,
      providerId: init.providerId,
      modelId: init.modelId,
      systemPrompt: init.systemPrompt,
      meta: { ...(init.meta ?? {}) },
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(id, session);
    if (history.length > 0) {
      void this.memory.remember(id, history);
    }
    return session;
  }

  get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) {
      throw new SessionError("E_SESSION_NOT_FOUND", `Session not found: ${id}`, { sessionId: id });
    }
    return s;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  touch(id: string): void {
    const s = this.get(id);
    s.updatedAt = Date.now();
  }

  async destroy(id: string): Promise<void> {
    this.sessions.delete(id);
    await this.memory.forget(id);
  }

  getMemory(): MemoryLayer {
    return this.memory;
  }

  /** Update the chosen primary model for a session (model swap is user-initiated). */
  setModel(id: string, providerId: string, modelId: string): void {
    const s = this.get(id);
    s.providerId = providerId;
    s.modelId = modelId;
    s.updatedAt = Date.now();
  }

  /** Append messages to a session's history. */
  async remember(id: string, messages: ChatMessage[]): Promise<void> {
    this.touch(id);
    await this.memory.remember(id, messages);
  }

  /** Recall recent history for a session. */
  async recall(id: string, limit?: number): Promise<ChatMessage[]> {
    return this.memory.recall(id, limit);
  }
}
