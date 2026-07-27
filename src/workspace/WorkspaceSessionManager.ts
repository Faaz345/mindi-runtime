/**
 * WorkspaceSessionManager — the heart of MINDI's persistent sessions.
 *
 * Responsibilities:
 *
 *   1. **Per-directory isolation.** Each directory has its own `.mindi` folder.
 *      Sessions from one project never leak into another.
 *
 *   2. **Auto-restore.** On launch, if a `.mindi` workspace exists and has an
 *      active session, it is restored automatically (no prompt). The
 *      provider, model, history, timeline, attachments, and working files
 *      all come back. The model receives the restored messages before the
 *      first user prompt, so the conversation continues naturally.
 *
 *   3. **Provider/model fallback.** When restoring, if the saved provider is
 *      no longer registered, fall back to another compatible provider and
 *      inform the caller. If the saved model no longer exists, suggest
 *      similar models but keep the history.
 *
 *   4. **Auto-save.** After every completed response, the session is
 *      persisted to disk. Crash-safe via atomic writes in WorkspaceStore.
 *
 *   5. **Context compression.** Long histories are folded into a rolling
 *      summary so the model's context window is never blown.
 *
 *   6. **Slash command surface.** /sessions /new /switch /rename /delete
 *      /archive /history /resume /clear — all operate on this manager.
 *
 *   7. **Project memory bridge.** Exposes the ProjectMemoryManager so the
 *      runtime can inject durable project context into every system prompt.
 */

import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../core/types.js";
import type { SessionInit } from "../session/SessionManager.js";
import { SessionError, WorkspaceError } from "../core/errors.js";
import { WorkspaceStore } from "./WorkspaceStore.js";
import type { ProjectMemoryManager } from "./ProjectMemory.js";
import type { ContextCompressor } from "./ContextCompressor.js";
import type { SessionSearch } from "./SessionSearch.js";
import type {
  ExecutionEvent,
  SessionAttachment,
  SessionRecord,
  SessionSummary,
  WorkspaceMeta,
} from "./types.js";

/** Result of a restore operation. */
export interface RestoreResult {
  session: SessionRecord;
  /** Whether the original provider was available */
  providerAvailable: boolean;
  /** Whether the original model was available */
  modelAvailable: boolean;
  /** Provider id actually in use after fallback */
  effectiveProviderId: string;
  /** Model id actually in use after fallback */
  effectiveModelId: string;
  /** Human-readable notice shown to the user (e.g. fallback reason) */
  notice?: string;
  /** Similar model suggestions if the original model is gone */
  modelSuggestions?: string[];
}

/** Callback the manager uses to validate provider/model availability. */
export interface AvailabilityProbe {
  isProviderAvailable(providerId: string): boolean;
  isModelAvailable(providerId: string, modelId: string): Promise<boolean> | boolean;
  /** List model ids for a provider, used to suggest similar models. */
  listModels(providerId: string): Promise<string[]>;
  /** Pick a fallback provider that supports chat. */
  fallbackProviderId(unavailableId: string): string | undefined;
}

export class WorkspaceSessionManager {
  private meta: WorkspaceMeta;
  private readonly records = new Map<string, SessionRecord>();
  private activeId: string | null = null;

  constructor(
    private readonly store: WorkspaceStore,
    /** Project memory — exposed for callers that want to read/write it. */
    readonly projectMemory: ProjectMemoryManager,
    private readonly compressor: ContextCompressor,
    readonly search: SessionSearch,
  ) {
    if (!store.exists()) {
      this.meta = store.initWorkspace();
    } else {
      this.meta = store.readWorkspace();
    }
  }

  // ---- Lifecycle ------------------------------------------------------

  /** Get the active session id (or null if none). */
  getActiveId(): string | null {
    return this.activeId ?? this.meta.activeSessionId;
  }

  /**
   * Auto-restore the last active session. Called on launch. If no session
   * exists, creates a fresh one. Returns the session + fallback info.
   */
  async restore(
    probe: AvailabilityProbe,
    defaults: { providerId: string; modelId: string },
  ): Promise<RestoreResult> {
    const id = this.meta.activeSessionId;
    if (id) {
      const rec = this.loadRecord(id);
      if (rec && !rec.archived) {
        return this.activateRestored(rec, probe);
      }
    }

    // No active session — create a fresh one with the defaults.
    const session = this.create({
      providerId: defaults.providerId,
      modelId: defaults.modelId,
    });
    return {
      session,
      providerAvailable: true,
      modelAvailable: true,
      effectiveProviderId: session.providerId,
      effectiveModelId: session.modelId,
    };
  }

  /** Explicitly resume the most recently updated session. */
  resumeMostRecent(): SessionRecord {
    const all = this.listSessions({ includeArchived: false });
    if (all.length === 0) {
      throw new WorkspaceError("E_WORKSPACE_NOT_FOUND", "No sessions to resume.");
    }
    const latest = all[0]!;
    return this.switch(latest.id);
  }

  // ---- CRUD -----------------------------------------------------------

  /** Create a new session in this workspace. */
  create(init: SessionInit): SessionRecord {
    const id = randomUUID();
    const now = Date.now();
    const title = init.systemPrompt ? deriveTitle(init.systemPrompt) : "New session";
    const rec: SessionRecord = {
      id,
      title,
      createdAt: now,
      updatedAt: now,
      openedAt: now,
      providerId: init.providerId,
      modelId: init.modelId,
      systemPrompt: init.systemPrompt,
      messages: init.systemPrompt ? [{ role: "system", content: init.systemPrompt }] : [],
      timeline: [],
      workingFiles: [],
      attachments: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, requestCount: 0 },
      meta: { ...(init.meta ?? {}) },
      tags: [],
      archived: false,
      pinned: false,
    };
    this.records.set(id, rec);
    this.store.writeSession(rec);
    this.meta.sessions.push(WorkspaceStore.toSummary(rec));
    this.meta.activeSessionId = id;
    this.activeId = id;
    this.store.writeWorkspace(this.meta);
    return rec;
  }

  /** Switch to an existing session by id. Loads it if not cached. */
  switch(id: string): SessionRecord {
    const rec = this.loadRecord(id);
    if (!rec) throw new SessionError("E_SESSION_NOT_FOUND", `Session not found: ${id}`, { sessionId: id });
    if (rec.archived) throw new WorkspaceError("E_SESSION_ARCHIVED", `Session ${id} is archived. Unarchive it first.`, { sessionId: id });
    rec.openedAt = Date.now();
    this.records.set(id, rec);
    this.activeId = id;
    this.meta.activeSessionId = id;
    this.upsertSummary(rec);
    this.store.writeSession(rec);
    this.store.writeWorkspace(this.meta);
    return rec;
  }

  /** Get a session record (from cache or disk). */
  get(id: string): SessionRecord | null {
    return this.loadRecord(id);
  }

  /** Get the active session record (or null). */
  getActive(): SessionRecord | null {
    const id = this.getActiveId();
    return id ? this.loadRecord(id) : null;
  }

  /** Rename a session. */
  rename(id: string, title: string): SessionRecord {
    const rec = this.loadRecord(id);
    if (!rec) throw new SessionError("E_SESSION_NOT_FOUND", `Session not found: ${id}`, { sessionId: id });
    rec.title = title.trim() || rec.title;
    rec.updatedAt = Date.now();
    this.persist(rec);
    return rec;
  }

  /** Permanently delete a session (history + index + summary). */
  delete(id: string): boolean {
    const rec = this.loadRecord(id);
    this.records.delete(id);
    this.store.deleteSession(id);
    this.compressor.clearSummary(id);
    this.meta.sessions = this.meta.sessions.filter((s) => s.id !== id);
    this.meta.archived = this.meta.archived.filter((s) => s.id !== id);
    if (this.meta.activeSessionId === id) this.meta.activeSessionId = null;
    if (this.activeId === id) this.activeId = null;
    this.store.writeWorkspace(this.meta);
    return !!rec;
  }

  /** Archive a session (hide from default listings, keep on disk). */
  archive(id: string): SessionRecord {
    const rec = this.loadRecord(id);
    if (!rec) throw new SessionError("E_SESSION_NOT_FOUND", `Session not found: ${id}`, { sessionId: id });
    rec.archived = true;
    rec.updatedAt = Date.now();
    this.persist(rec);
    this.store.archiveSessionFile(id);
    this.meta.sessions = this.meta.sessions.filter((s) => s.id !== id);
    this.meta.archived.push(WorkspaceStore.toSummary(rec));
    if (this.meta.activeSessionId === id) this.meta.activeSessionId = null;
    if (this.activeId === id) this.activeId = null;
    this.store.writeWorkspace(this.meta);
    return rec;
  }

  /** Unarchive a session. */
  unarchive(id: string): SessionRecord {
    const rec = this.loadRecord(id);
    if (!rec) throw new SessionError("E_SESSION_NOT_FOUND", `Session not found: ${id}`, { sessionId: id });
    rec.archived = false;
    rec.updatedAt = Date.now();
    this.persist(rec);
    this.store.unarchiveSessionFile(id);
    this.meta.archived = this.meta.archived.filter((s) => s.id !== id);
    this.upsertSummary(rec);
    this.store.writeWorkspace(this.meta);
    return rec;
  }

  /** Pin / unpin a session. */
  setPinned(id: string, pinned: boolean): SessionRecord {
    const rec = this.loadRecord(id);
    if (!rec) throw new SessionError("E_SESSION_NOT_FOUND", `Session not found: ${id}`, { sessionId: id });
    rec.pinned = pinned;
    this.persist(rec);
    return rec;
  }

  // ---- Listing --------------------------------------------------------

  /** List session summaries, sorted by last-modified (newest first). */
  listSessions(opts: { includeArchived?: boolean } = {}): SessionSummary[] {
    const out: SessionSummary[] = [];
    out.push(...this.meta.sessions);
    if (opts.includeArchived) out.push(...this.meta.archived);
    // Reconcile with disk: pick up any session files not in the index.
    const known = new Set(out.map((s) => s.id));
    for (const id of this.store.listSessionFiles()) {
      if (known.has(id)) continue;
      const rec = this.store.readSession(id);
      if (rec && (opts.includeArchived || !rec.archived)) out.push(WorkspaceStore.toSummary(rec));
    }
    out.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
    return out;
  }

  // ---- History mutation ------------------------------------------------

  /** Update the provider/model for a session. */
  setModel(id: string, providerId: string, modelId: string): SessionRecord {
    const rec = this.loadRecord(id);
    if (!rec) throw new SessionError("E_SESSION_NOT_FOUND", `Session not found: ${id}`, { sessionId: id });
    rec.providerId = providerId;
    rec.modelId = modelId;
    rec.updatedAt = Date.now();
    this.persist(rec);
    return rec;
  }

  /** Append messages to a session's history (auto-saves). */
  remember(id: string, messages: ChatMessage[]): void {
    if (messages.length === 0) return;
    const rec = this.loadRecord(id);
    if (!rec) throw new SessionError("E_SESSION_NOT_FOUND", `Session not found: ${id}`, { sessionId: id });
    rec.messages.push(...messages);

    // Derive a better title from the first user message if still default.
    if ((rec.title === "New session" || !rec.title) && messages.length > 0) {
      const firstUser = messages.find((m) => m.role === "user");
      if (firstUser) rec.title = deriveTitle(toText(firstUser.content));
    }

    // Auto-compress if over the rolling window.
    const keep = this.meta.settings.maxHistoryMessages ?? 50;
    const result = this.compressor.compress(id, rec.messages, { keepRecent: keep });
    if (result.compressed && result.summary && result.kept) {
      rec.messages = result.kept;
      rec.summary = result.summary;
    }

    rec.updatedAt = Date.now();
    this.persist(rec);
  }

  /** Recall a session's history, prepending the rolling summary if present. */
  recall(id: string, limit?: number): ChatMessage[] {
    const rec = this.loadRecord(id);
    if (!rec) return [];
    let msgs = rec.messages;
    if (limit && msgs.length > limit) {
      msgs = msgs.slice(msgs.length - limit);
    }
    // Inject the rolling summary as a system message so the model retains
    // long-term context that was folded away.
    if (rec.summary && rec.summary.text) {
      const summaryMsg: ChatMessage = {
        role: "system",
        content: `## Summary of earlier conversation\n${rec.summary.text}`,
      };
      // Place after any leading system prompt.
      const lead = msgs.findIndex((m) => m.role !== "system");
      const insertAt = lead < 0 ? msgs.length : lead;
      return [...msgs.slice(0, insertAt), summaryMsg, ...msgs.slice(insertAt)];
    }
    return [...msgs];
  }

  /** Record an execution event on the session timeline. */
  recordEvent(id: string, event: ExecutionEvent): void {
    const rec = this.loadRecord(id);
    if (!rec) return;
    rec.timeline.push(event);
    // Keep timeline bounded.
    if (rec.timeline.length > 500) rec.timeline.shift();
    this.persist(rec);
  }

  /** Track token usage for a session. */
  addUsage(
    id: string,
    usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number },
  ): void {
    const rec = this.loadRecord(id);
    if (!rec) return;
    rec.usage.promptTokens += usage.promptTokens ?? 0;
    rec.usage.completionTokens += usage.completionTokens ?? 0;
    rec.usage.totalTokens += usage.totalTokens ?? 0;
    rec.usage.requestCount += 1;
    this.persist(rec);
  }

  /** Track a working file for the session. */
  addWorkingFile(id: string, file: string): void {
    const rec = this.loadRecord(id);
    if (!rec) return;
    if (!rec.workingFiles.includes(file)) {
      rec.workingFiles.push(file);
      this.persist(rec);
    }
  }

  /** Track an attachment. */
  addAttachment(id: string, att: SessionAttachment): void {
    const rec = this.loadRecord(id);
    if (!rec) return;
    rec.attachments.push(att);
    this.persist(rec);
  }

  /** Clear history but keep the session (and its provider/model). */
  clear(id: string): SessionRecord {
    const rec = this.loadRecord(id);
    if (!rec) throw new SessionError("E_SESSION_NOT_FOUND", `Session not found: ${id}`, { sessionId: id });
    rec.messages = rec.systemPrompt ? [{ role: "system", content: rec.systemPrompt }] : [];
    rec.timeline = [];
    rec.usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requestCount: 0 };
    rec.updatedAt = Date.now();
    this.compressor.clearSummary(id);
    rec.summary = undefined;
    this.persist(rec);
    return rec;
  }

  // ---- Internal -------------------------------------------------------

  private async activateRestored(rec: SessionRecord, probe: AvailabilityProbe): Promise<RestoreResult> {
    const providerAvailable = probe.isProviderAvailable(rec.providerId);
    let effectiveProviderId = rec.providerId;
    let notice: string | undefined;
    let modelSuggestions: string[] | undefined;
    let modelAvailable = true;

    if (!providerAvailable) {
      const fallback = probe.fallbackProviderId(rec.providerId);
      if (fallback) {
        effectiveProviderId = fallback;
        notice = `Provider "${rec.providerId}" is unavailable. Falling back to "${fallback}".`;
      } else {
        notice = `Provider "${rec.providerId}" is unavailable. No fallback found — using default.`;
      }
    } else {
      // Provider ok — check model.
      const isOk = await probe.isModelAvailable(rec.providerId, rec.modelId);
      if (!isOk) {
        modelAvailable = false;
        // Suggest similar models from the same provider (best-effort, sync).
        notice = `Model "${rec.modelId}" no longer exists on provider "${rec.providerId}". Conversation history is preserved; please choose a model.`;
        modelSuggestions = await probe.listModels(rec.providerId);
      }
    }

    rec.openedAt = Date.now();
    if (effectiveProviderId !== rec.providerId) {
      rec.providerId = effectiveProviderId;
    }
    this.records.set(rec.id, rec);
    this.activeId = rec.id;
    this.meta.activeSessionId = rec.id;
    this.upsertSummary(rec);
    this.store.writeSession(rec);
    this.store.writeWorkspace(this.meta);

    return {
      session: rec,
      providerAvailable,
      modelAvailable,
      effectiveProviderId,
      effectiveModelId: rec.modelId,
      notice,
      modelSuggestions,
    };
  }

  private loadRecord(id: string): SessionRecord | null {
    const cached = this.records.get(id);
    if (cached) return cached;
    const rec = this.store.readSession(id);
    if (rec) this.records.set(id, rec);
    return rec;
  }

  private persist(rec: SessionRecord): void {
    rec.updatedAt = Date.now();
    this.records.set(rec.id, rec);
    this.store.writeSession(rec);
    this.upsertSummary(rec);
    this.store.writeWorkspace(this.meta);
  }

  private upsertSummary(rec: SessionRecord): void {
    const sum = WorkspaceStore.toSummary(rec);
    const idx = this.meta.sessions.findIndex((s) => s.id === rec.id);
    if (idx >= 0) this.meta.sessions[idx] = sum;
    else this.meta.sessions.push(sum);
    if (rec.archived) {
      this.meta.archived = this.meta.archived.filter((s) => s.id !== rec.id);
    }
  }
}

// ---- helpers ---------------------------------------------------------

function deriveTitle(content: string): string {
  const text = toText(content);
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "New session";
  return flat.length > 60 ? flat.slice(0, 59) + "…" : flat;
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
