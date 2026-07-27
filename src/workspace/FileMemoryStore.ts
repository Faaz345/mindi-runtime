/**
 * FileMemoryStore — a filesystem-backed MemoryStore.
 *
 * The in-memory store vanishes when the process exits. This store writes each
 * session's history to `.mindi/sessions/<id>.json` and reads it back on the
 * next launch, giving MINDI persistent conversation history across restarts.
 *
 * It implements the same MemoryStore contract so the existing MemoryLayer can
 * use it with zero core changes.
 */

import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "../core/types.js";
import type { MemoryStore } from "../memory/MemoryLayer.js";
import { toMindiError } from "../core/errors.js";

export interface FileMemoryStoreOptions {
  /** Directory containing session files (typically .mindi/sessions) */
  sessionsDir: string;
}

export class FileMemoryStore implements MemoryStore {
  private readonly sessionsDir: string;
  private readonly cache = new Map<string, ChatMessage[]>();
  private loaded = new Set<string>();

  constructor(opts: FileMemoryStoreOptions) {
    this.sessionsDir = opts.sessionsDir;
  }

  async append(sessionId: string, messages: ChatMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const list = await this.loadRaw(sessionId);
    list.push(...messages);
    await this.persist(sessionId, list);
  }

  async load(sessionId: string, limit?: number): Promise<ChatMessage[]> {
    const list = await this.loadRaw(sessionId);
    if (!limit || limit >= list.length) return [...list];
    return list.slice(list.length - limit);
  }

  async clear(sessionId: string): Promise<void> {
    this.cache.delete(sessionId);
    this.loaded.delete(sessionId);
    const file = this.sessionFile(sessionId);
    try {
      await fs.promises.unlink(file);
    } catch {
      // already gone — fine
    }
  }

  async count(sessionId: string): Promise<number> {
    const list = await this.loadRaw(sessionId);
    return list.length;
  }

  // ---- internal -------------------------------------------------------

  private sessionFile(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  private async loadRaw(sessionId: string): Promise<ChatMessage[]> {
    if (this.loaded.has(sessionId)) {
      return this.cache.get(sessionId) ?? [];
    }
    const file = this.sessionFile(sessionId);
    let list: ChatMessage[] = [];
    try {
      const raw = await fs.promises.readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        list = parsed as ChatMessage[];
      } else if (parsed && Array.isArray((parsed as { messages?: unknown }).messages)) {
        // Tolerate a wrapped { messages: [...] } envelope too.
        list = (parsed as { messages: ChatMessage[] }).messages;
      }
    } catch {
      // missing / corrupt file → empty history
      list = [];
    }
    this.cache.set(sessionId, list);
    this.loaded.add(sessionId);
    return list;
  }

  private async persist(sessionId: string, list: ChatMessage[]): Promise<void> {
    this.cache.set(sessionId, list);
    const file = this.sessionFile(sessionId);
    try {
      await fs.promises.mkdir(this.sessionsDir, { recursive: true });
      // Atomic write: tmp + rename for crash safety.
      const tmp = `${file}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(list), "utf8");
      await fs.promises.rename(tmp, file);
    } catch (err) {
      throw toMindiError(err, "E_MEMORY");
    }
  }
}
