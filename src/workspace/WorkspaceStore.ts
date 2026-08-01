/**
 * WorkspaceStore — low-level persistence for the `.mindi` folder.
 *
 * Owns the on-disk layout and all atomic file I/O. Every higher-level
 * component (WorkspaceSessionManager, ProjectMemory, ContextCompressor) goes
 * through this layer so there is exactly one place that knows the folder
 * structure:
 *
 *   .mindi/
 *     workspace.json          ← WorkspaceMeta (sessions index + settings)
 *     sessions/
 *       <id>.json             ← full SessionRecord
 *     memory/
 *       project.json          ← ProjectMemory
 *       summaries.json        ← SummaryStore
 *     cache/
 *     logs/
 *
 * All writes are atomic (write tmp → rename) so a crash mid-write never
 * corrupts a session file. Reads are tolerant of missing files.
 */

import fs from "node:fs";
import path from "node:path";
import type {
  ProjectMemory,
  SessionRecord,
  SessionSummary,
  SummaryStore,
  WorkspaceMeta,
  WorkspaceSettings,
} from "./types.js";
import { WorkspaceError } from "../core/errors.js";

const WORKSPACE_VERSION = 1 as const;
const MINDI_DIR = ".mindi";

export interface WorkspacePaths {
  root: string;
  mindi: string;
  sessions: string;
  memory: string;
  cache: string;
  logs: string;
  workspaceJson: string;
  projectJson: string;
  summariesJson: string;
}

export class WorkspaceStore {
  readonly paths: WorkspacePaths;
  /** Debounce timer for coalesced writes (Phase 8 performance). */
  private writeTimers = new Map<string, NodeJS.Timeout>();
  /** Pending data for debounced writes. */
  private pendingWrites = new Map<string, unknown>();
  /** Debounce interval in ms for non-critical writes. */
  private readonly writeDebounceMs: number;

  constructor(rootDir: string, opts?: { writeDebounceMs?: number }) {
    const mindi = path.join(rootDir, MINDI_DIR);
    this.paths = {
      root: rootDir,
      mindi,
      sessions: path.join(mindi, "sessions"),
      memory: path.join(mindi, "memory"),
      cache: path.join(mindi, "cache"),
      logs: path.join(mindi, "logs"),
      workspaceJson: path.join(mindi, "workspace.json"),
      projectJson: path.join(mindi, "memory", "project.json"),
      summariesJson: path.join(mindi, "memory", "summaries.json"),
    };
    this.writeDebounceMs = opts?.writeDebounceMs ?? 150;
  }

  // ---- Existence / creation -------------------------------------------

  /** Does a `.mindi` workspace already exist in this directory? */
  exists(): boolean {
    return fs.existsSync(this.paths.workspaceJson);
  }

  /** Create the full folder scaffold. Idempotent. */
  ensureDirs(): void {
    for (const d of [this.paths.mindi, this.paths.sessions, this.paths.memory, this.paths.cache, this.paths.logs]) {
      fs.mkdirSync(d, { recursive: true });
    }
  }

  /** Initialize a fresh workspace.json. Returns the default meta. */
  initWorkspace(settings?: Partial<WorkspaceSettings>): WorkspaceMeta {
    this.ensureDirs();
    const now = Date.now();
    const meta: WorkspaceMeta = {
      version: WORKSPACE_VERSION,
      rootDir: this.paths.root,
      createdAt: now,
      updatedAt: now,
      activeSessionId: null,
      sessions: [],
      archived: [],
      settings: {
        autoRestore: true,
        autoSave: true,
        maxHistoryMessages: 50,
        preferences: {},
        ...settings,
      },
    };
    this.writeWorkspace(meta);
    return meta;
  }

  // ---- Workspace meta -------------------------------------------------

  readWorkspace(): WorkspaceMeta {
    return this.readJson<WorkspaceMeta>(this.paths.workspaceJson, {
      version: WORKSPACE_VERSION,
      rootDir: this.paths.root,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      activeSessionId: null,
      sessions: [],
      archived: [],
      settings: { autoRestore: true, autoSave: true, preferences: {} },
    });
  }

  writeWorkspace(meta: WorkspaceMeta): void {
    meta.updatedAt = Date.now();
    this.writeJson(this.paths.workspaceJson, meta);
  }

  /**
   * Debounced workspace write — coalesces rapid index updates during a
   * single request cycle. Phase 8 performance optimization.
   */
  writeWorkspaceDebounced(meta: WorkspaceMeta): void {
    meta.updatedAt = Date.now();
    this.writeJsonDebounced(this.paths.workspaceJson, meta);
  }

  // ---- Sessions -------------------------------------------------------

  /** List session ids present on disk (regardless of the index). */
  listSessionFiles(): string[] {
    if (!fs.existsSync(this.paths.sessions)) return [];
    return fs
      .readdirSync(this.paths.sessions)
      .filter((f) => (f.endsWith(".json") || f.endsWith(".json.archived")) && !f.endsWith(".tmp"))
      .map((f) => f.endsWith(".json.archived") ? f.slice(0, -14) : f.slice(0, -5));
  }

  readSession(id: string): SessionRecord | null {
    assertSessionId(id);
    const normal = this.sessionFile(id);
    const archived = `${normal}.archived`;
    return this.readJson<SessionRecord | null>(fs.existsSync(normal) ? normal : archived, null);
  }

  writeSession(record: SessionRecord): void {
    assertSessionId(record.id);
    this.writeJson(this.sessionFile(record.id), record);
  }

  /**
   * Debounced session write — coalesces rapid mutations (remember +
   * recordEvent + addUsage within a single request cycle) into one disk
   * write. Phase 8 performance optimization. Used by persist() internally.
   */
  writeSessionDebounced(record: SessionRecord): void {
    assertSessionId(record.id);
    this.writeJsonDebounced(this.sessionFile(record.id), record);
  }

  deleteSession(id: string): void {
    assertSessionId(id);
    try {
      fs.unlinkSync(this.sessionFile(id));
    } catch {
      // already gone
    }
    try { fs.unlinkSync(`${this.sessionFile(id)}.archived`); } catch { /* already gone */ }
  }

  /** Move a session file into the archive by appending `.archived`. */
  archiveSessionFile(id: string): void {
    assertSessionId(id);
    const from = this.sessionFile(id);
    const to = `${from}.archived`;
    try {
      fs.renameSync(from, to);
    } catch {
      // best-effort
    }
  }

  /** Restore an archived session file to its normal path. */
  unarchiveSessionFile(id: string): void {
    assertSessionId(id);
    const from = `${this.sessionFile(id)}.archived`;
    const to = this.sessionFile(id);
    try {
      if (fs.existsSync(from)) fs.renameSync(from, to);
    } catch {
      // best-effort; the normal session write already restored the record
    }
  }

  private sessionFile(id: string): string {
    assertSessionId(id);
    return path.join(this.paths.sessions, `${id}.json`);
  }

  // ---- Project memory -------------------------------------------------

  readProjectMemory(): ProjectMemory {
    return this.readJson<ProjectMemory>(this.paths.projectJson, {
      version: 1,
      updatedAt: Date.now(),
      overview: "",
      techStack: [],
      decisions: [],
      conventions: [],
      importantFiles: [],
      goals: [],
      ignoredPaths: [],
      frequentCommands: [],
      userPreferences: {},
      capabilitiesUsed: [],
    });
  }

  writeProjectMemory(mem: ProjectMemory): void {
    mem.updatedAt = Date.now();
    this.writeJson(this.paths.projectJson, mem);
  }

  // ---- Summaries ------------------------------------------------------

  readSummaries(): SummaryStore {
    return this.readJson<SummaryStore>(this.paths.summariesJson, {
      version: 1,
      summaries: {},
      updatedAt: Date.now(),
    });
  }

  writeSummaries(store: SummaryStore): void {
    store.updatedAt = Date.now();
    this.writeJson(this.paths.summariesJson, store);
  }

  // ---- Logs -----------------------------------------------------------

  appendLog(line: string): void {
    const logFile = path.join(this.paths.logs, `mindi-${new Date().toISOString().slice(0, 10)}.log`);
    try {
      fs.appendFileSync(logFile, line + "\n", "utf8");
    } catch {
      // best-effort logging
    }
  }

  // ---- Summary helpers exposed to the index -------------------------

  /** Build a SessionSummary from a full SessionRecord. */
  static toSummary(rec: SessionRecord): SessionSummary {
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

  // ---- Internal: atomic JSON I/O -------------------------------------

  private readJson<T>(file: string, fallback: T): T {
    try {
      const raw = fs.readFileSync(file, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private writeJson(file: string, data: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmp, file);
    } catch (err) {
      throw new WorkspaceError("E_WORKSPACE", `Failed to write ${path.basename(file)}`, {
        file,
        cause: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  /**
   * Debounced write — coalesces multiple writes to the same file within a
   * short window. Only the LAST data wins. This eliminates redundant disk
   * I/O during rapid mutations (remember + recordEvent + addUsage in a single
   * request cycle). Phase 8 performance optimization.
   */
  writeJsonDebounced(file: string, data: unknown): void {
    this.pendingWrites.set(file, data);
    const existing = this.writeTimers.get(file);
    if (existing) clearTimeout(existing);
    this.writeTimers.set(file, setTimeout(() => {
      this.writeTimers.delete(file);
      const pending = this.pendingWrites.get(file);
      this.pendingWrites.delete(file);
      if (pending !== undefined) {
        this.writeJson(file, pending);
      }
    }, this.writeDebounceMs));
  }

  /** Flush all pending debounced writes immediately (e.g. on exit). */
  flush(): void {
    for (const [file, timer] of this.writeTimers) {
      clearTimeout(timer);
      const pending = this.pendingWrites.get(file);
      if (pending !== undefined) {
        this.writeJson(file, pending);
      }
    }
    this.writeTimers.clear();
    this.pendingWrites.clear();
  }
}

function assertSessionId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new WorkspaceError("E_WORKSPACE", `Invalid session id: ${id}`, { sessionId: id });
  }
}
