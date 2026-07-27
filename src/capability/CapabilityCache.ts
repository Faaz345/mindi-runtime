/**
 * CapabilityCache — persistent storage for model capability profiles.
 *
 * Stored at `.mindi/cache/capabilities.json`. Reconnecting providers is
 * instantaneous: profiles are loaded from disk and only re-derived when the
 * provider's metadata changed.
 *
 * Merge semantics on refresh:
 *   - New models       → added
 *   - Changed metadata → updated
 *   - Deleted models   → removed
 *   - Unchanged        → preserved (metadataSource: "cached")
 */

import fs from "node:fs";
import path from "node:path";
import type { ModelCapabilityProfile } from "./types.js";

interface CacheFile {
  version: 1;
  updatedAt: number;
  profiles: Record<string, ModelCapabilityProfile>;
}

export class CapabilityCache {
  private readonly file: string | null;
  private profiles = new Map<string, ModelCapabilityProfile>();

  /**
   * @param file Absolute path to the cache JSON file. Pass `null` for an
   *   in-memory-only cache (used by tests / SDK consumers without a
   *   workspace).
   */
  constructor(file: string | null) {
    this.file = file;
    this.load();
  }

  get(key: string): ModelCapabilityProfile | undefined {
    return this.profiles.get(key);
  }

  set(profile: ModelCapabilityProfile): void {
    this.profiles.set(profile.id, profile);
  }

  delete(key: string): boolean {
    return this.profiles.delete(key);
  }

  keys(): string[] {
    return [...this.profiles.keys()];
  }

  values(): ModelCapabilityProfile[] {
    return [...this.profiles.values()];
  }

  clear(): void {
    this.profiles.clear();
  }

  /** Persist to disk (no-op for in-memory caches). Atomic write. */
  save(): void {
    if (!this.file) return;
    const data: CacheFile = {
      version: 1,
      updatedAt: Date.now(),
      profiles: Object.fromEntries(this.profiles),
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmp, this.file);
    } catch {
      // Best-effort cache — never crash the runtime over a cache write.
    }
  }

  private load(): void {
    if (!this.file) return;
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const data = JSON.parse(raw) as CacheFile;
      if (data && typeof data === "object" && data.profiles) {
        for (const [key, profile] of Object.entries(data.profiles)) {
          // Mark disk-loaded profiles as cached (unless manually overridden).
          if (profile.metadataSource !== "manual") {
            profile.metadataSource = "cached";
          }
          this.profiles.set(key, profile);
        }
      }
    } catch {
      // Missing/corrupt cache → start empty.
    }
  }
}
