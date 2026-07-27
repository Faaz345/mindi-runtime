/**
 * ProjectMemory — durable, cross-session knowledge about a project.
 *
 * Stored at `.mindi/memory/project.json`. Distinct from chat history: this
 * is what lets every new session immediately understand the project without
 * re-explaining. MINDI injects a compact projection of this into the system
 * prompt on every request, so the model always knows the project context.
 *
 * This module provides:
 *   - read/write lifecycle
 *   - mutation helpers (addDecision, observeCommand, markFileImportant, ...)
 *   - auto-detection of tech stack / frequent commands from observed signals
 *   - serialization to a compact system-prompt fragment
 */

import type {
  ArchitecturalDecision,
  ConventionEntry,
  FrequentCommand,
  ProjectMemory,
  TechStackEntry,
} from "./types.js";
import type { CapabilityType } from "../core/types.js";
import type { WorkspaceStore } from "./WorkspaceStore.js";
import { randomUUID } from "node:crypto";

export class ProjectMemoryManager {
  private mem: ProjectMemory;

  constructor(private readonly store: WorkspaceStore) {
    this.mem = store.readProjectMemory();
  }

  /** Get the in-memory project memory (read-only view). */
  get(): Readonly<ProjectMemory> {
    return this.mem;
  }

  /** Persist the current memory to disk. */
  save(): void {
    this.store.writeProjectMemory(this.mem);
  }

  // ---- Overview -------------------------------------------------------

  setOverview(overview: string): void {
    this.mem.overview = overview.trim();
    this.save();
  }

  // ---- Tech stack -----------------------------------------------------

  addTechStack(entry: TechStackEntry): void {
    const existing = this.mem.techStack.find(
      (t) => t.name.toLowerCase() === entry.name.toLowerCase() && t.category === entry.category,
    );
    if (existing) {
      if (entry.version && existing.version !== entry.version) existing.version = entry.version;
      if (entry.notes && existing.notes !== entry.notes) existing.notes = entry.notes;
    } else {
      this.mem.techStack.push(entry);
    }
    this.save();
  }

  // ---- Decisions ------------------------------------------------------

  addDecision(input: Omit<ArchitecturalDecision, "id" | "decidedAt"> & { id?: string }): ArchitecturalDecision {
    const d: ArchitecturalDecision = {
      id: input.id ?? randomUUID(),
      decidedAt: Date.now(),
      ...input,
    };
    this.mem.decisions.push(d);
    this.save();
    return d;
  }

  removeDecision(id: string): boolean {
    const before = this.mem.decisions.length;
    this.mem.decisions = this.mem.decisions.filter((d) => d.id !== id);
    if (this.mem.decisions.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  // ---- Conventions ----------------------------------------------------

  addConvention(input: Omit<ConventionEntry, "id"> & { id?: string }): ConventionEntry {
    const c: ConventionEntry = {
      id: input.id ?? randomUUID(),
      topic: input.topic,
      rule: input.rule,
      examples: input.examples,
    };
    this.mem.conventions.push(c);
    this.save();
    return c;
  }

  // ---- Important files ------------------------------------------------

  markFileImportant(path: string, reason: string): void {
    const existing = this.mem.importantFiles.find((f) => f.path === path);
    if (existing) {
      existing.reason = reason;
      existing.markedAt = Date.now();
    } else {
      this.mem.importantFiles.push({ path, reason, markedAt: Date.now() });
    }
    this.save();
  }

  unmarkFileImportant(path: string): boolean {
    const before = this.mem.importantFiles.length;
    this.mem.importantFiles = this.mem.importantFiles.filter((f) => f.path !== path);
    if (this.mem.importantFiles.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  // ---- Goals ----------------------------------------------------------

  addGoal(goal: string): void {
    if (!this.mem.goals.includes(goal)) {
      this.mem.goals.push(goal);
      this.save();
    }
  }

  // ---- Ignored paths --------------------------------------------------

  ignorePath(path: string): void {
    if (!this.mem.ignoredPaths.includes(path)) {
      this.mem.ignoredPaths.push(path);
      this.save();
    }
  }

  // ---- Frequent commands (observed automatically) --------------------

  /** Record that a command was run. Increments use count. */
  observeCommand(command: string, description?: string): void {
    const cmd = command.trim();
    if (!cmd) return;
    const existing = this.mem.frequentCommands.find((c) => c.command === cmd);
    const now = Date.now();
    if (existing) {
      existing.useCount++;
      existing.lastUsedAt = now;
      if (description && !existing.description) existing.description = description;
    } else {
      this.mem.frequentCommands.push({
        command: cmd,
        description,
        useCount: 1,
        lastUsedAt: now,
      });
    }
    this.save();
  }

  /** Top N frequent commands by use count. */
  topCommands(n = 10): FrequentCommand[] {
    return [...this.mem.frequentCommands].sort((a, b) => b.useCount - a.useCount).slice(0, n);
  }

  // ---- User preferences ----------------------------------------------

  setPreference(key: string, value: unknown): void {
    this.mem.userPreferences[key] = value;
    this.save();
  }

  getPreference<T = unknown>(key: string, fallback?: T): T | undefined {
    return (this.mem.userPreferences[key] as T) ?? fallback;
  }

  // ---- Capabilities ---------------------------------------------------

  observeCapability(type: CapabilityType): void {
    if (!this.mem.capabilitiesUsed.includes(type)) {
      this.mem.capabilitiesUsed.push(type);
      this.save();
    }
  }

  // ---- Serialization to system-prompt fragment -----------------------

  /**
   * Compact, human-readable rendering of the project memory suitable for
   * injection into the primary model's system prompt. Kept short so it
   * doesn't blow the context budget on every request.
   */
  toPromptFragment(): string {
    const m = this.mem;
    const lines: string[] = [];

    if (m.overview) {
      lines.push(`## Project`, m.overview);
    }

    if (m.techStack.length > 0) {
      lines.push(`## Tech stack`);
      for (const t of m.techStack) {
        lines.push(`- ${t.name}${t.version ? `@${t.version}` : ""} (${t.category})${t.notes ? ` — ${t.notes}` : ""}`);
      }
    }

    if (m.decisions.length > 0) {
      lines.push(`## Architectural decisions`);
      for (const d of m.decisions) {
        lines.push(`- ${d.title}: ${d.decision}${d.rationale ? ` (because ${d.rationale})` : ""}`);
      }
    }

    if (m.conventions.length > 0) {
      lines.push(`## Conventions`);
      for (const c of m.conventions) {
        lines.push(`- ${c.topic}: ${c.rule}`);
      }
    }

    if (m.importantFiles.length > 0) {
      lines.push(`## Important files`);
      for (const f of m.importantFiles) {
        lines.push(`- ${f.path} — ${f.reason}`);
      }
    }

    if (m.goals.length > 0) {
      lines.push(`## Goals`, ...m.goals.map((g) => `- ${g}`));
    }

    const cmds = this.topCommands(5);
    if (cmds.length > 0) {
      lines.push(`## Frequent commands`);
      for (const c of cmds) {
        lines.push(`- ${c.command}${c.description ? ` — ${c.description}` : ""}`);
      }
    }

    if (m.ignoredPaths.length > 0) {
      lines.push(`## Ignored paths`, ...m.ignoredPaths.map((p) => `- ${p}`));
    }

    const prefs = Object.entries(m.userPreferences);
    if (prefs.length > 0) {
      lines.push(`## User preferences`);
      for (const [k, v] of prefs) lines.push(`- ${k}: ${String(v)}`);
    }

    return lines.join("\n");
  }

  /** True if there is any meaningful content worth injecting. */
  hasContent(): boolean {
    const m = this.mem;
    return (
      !!m.overview ||
      m.techStack.length > 0 ||
      m.decisions.length > 0 ||
      m.conventions.length > 0 ||
      m.importantFiles.length > 0 ||
      m.goals.length > 0 ||
      m.frequentCommands.length > 0
    );
  }
}
