/**
 * SlashCommands — registry + built-in commands for the workspace session system.
 *
 * Built-in commands:
 *
 *   /sessions   List all conversations (newest first)
 *   /new        Create a fresh conversation in the same project
 *   /switch <id|query>   Restore another saved conversation
 *   /rename <title>      Rename the current conversation
 *   /delete [id]         Permanently delete a conversation
 *   /archive [id]        Archive a conversation (hide, keep on disk)
 *   /history   List previous sessions with timestamps, providers, models, counts
 *   /resume    Continue the most recent session
 *   /clear     Clear the current session's history (keep the session)
 *   /help      List available commands
 *
 * The registry is pluggable: callers can register custom commands too.
 */

import type {
  SlashCommand,
  SlashCommandResult,
} from "./types.js";
import type { WorkspaceSessionManager } from "./WorkspaceSessionManager.js";
import type { ModelCapabilityProfile, RefreshReport } from "../capability/types.js";
import { describeSource } from "../capability/CapabilityDetector.js";

/**
 * Bridge that lets capability-aware slash commands (/model, /refresh-models)
 * reach back into the runtime's ModelCapabilityRegistry and ProviderManager.
 * Optional — when absent, those commands report themselves unavailable.
 */
export interface RuntimeCommandBridge {
  /** Currently selected provider+model (active session or runtime default). */
  getCurrentSelection(): { providerId: string; modelId: string } | null;
  /** Human label for a provider id. */
  getProviderLabel(providerId: string): string;
  /** Look up a model's capability profile. */
  getProfile(providerId: string, modelId: string): ModelCapabilityProfile | null;
  /** Rebuild the capability registry from fresh provider metadata. */
  refreshModels(): Promise<RefreshReport>;
}

export class SlashCommandRegistry {
  private readonly commands = new Map<string, SlashCommand>();

  constructor(
    private readonly manager: WorkspaceSessionManager,
    private readonly bridge?: RuntimeCommandBridge,
  ) {
    this.register(this.sessionsCommand());
    this.register(this.newCommand());
    this.register(this.switchCommand());
    this.register(this.renameCommand());
    this.register(this.deleteCommand());
    this.register(this.archiveCommand());
    this.register(this.historyCommand());
    this.register(this.resumeCommand());
    this.register(this.clearCommand());
    this.register(this.helpCommand());
    this.register(this.searchCommand());
    this.register(this.exitCommand());
    this.register(this.modelCommand());
    this.register(this.refreshModelsCommand());
  }

  /** Register a custom command. */
  register(cmd: SlashCommand): this {
    this.commands.set(cmd.name, cmd);
    return this;
  }

  /** Look up a command by name. */
  get(name: string): SlashCommand | undefined {
    return this.commands.get(name);
  }

  /** List all registered commands. */
  list(): SlashCommand[] {
    return Array.from(this.commands.values());
  }

  /** Parse a raw input line and dispatch to the matching command. */
  async dispatch(raw: string): Promise<SlashCommandResult> {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("/")) return { handled: false };

    const withoutSlash = trimmed.slice(1);
    const spaceIdx = withoutSlash.indexOf(" ");
    const name = spaceIdx < 0 ? withoutSlash : withoutSlash.slice(0, spaceIdx);
    const argsStr = spaceIdx < 0 ? "" : withoutSlash.slice(spaceIdx + 1).trim();
    const args = argsStr ? argsStr.split(/\s+/) : [];

    const cmd = this.commands.get(name);
    if (!cmd) {
      return { handled: false, message: `Unknown command: /${name}. Type /help for available commands.` };
    }

    try {
      return await cmd.execute({ sessionId: this.manager.getActiveId() ?? "", args, raw });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { handled: true, message: `/${name} failed: ${msg}` };
    }
  }

  // ---- Built-in commands ----------------------------------------------

  private sessionsCommand(): SlashCommand {
    return {
      name: "sessions",
      description: "List all conversations in this workspace (newest first).",
      execute: () => {
        const all = this.manager.listSessions({ includeArchived: false });
        if (all.length === 0) return { handled: true, message: "No sessions yet. Use /new to start one." };
        const activeId = this.manager.getActiveId();
        const lines = all.map((s, i) => {
          const marker = s.id === activeId ? "* " : "  ";
          const pin = s.pinned ? "📌 " : "";
          const when = new Date(s.updatedAt).toLocaleString();
          return `${marker}${pin}${i + 1}. ${s.title}  [${s.providerId}/${s.modelId}] ${s.messageCount} msgs · ${when}  (${s.id.slice(0, 8)})`;
        });
        return { handled: true, message: lines.join("\n") };
      },
    };
  }

  private newCommand(): SlashCommand {
    return {
      name: "new",
      description: "Create a fresh conversation in the same project.",
      execute: () => {
        const active = this.manager.getActive();
        const providerId = active?.providerId ?? "openai";
        const modelId = active?.modelId ?? "gpt-4o-mini";
        const rec = this.manager.create({ providerId, modelId });
        return {
          handled: true,
          switchToSessionId: rec.id,
          message: `New session: ${rec.title} (${rec.id.slice(0, 8)})`,
        };
      },
    };
  }

  private switchCommand(): SlashCommand {
    return {
      name: "switch",
      description: "Switch to another saved conversation.",
      usage: "/switch <session-id | number | search query>",
      execute: (ctx) => {
        const arg = ctx.args[0] ?? "";
        if (!arg) return { handled: true, message: "Usage: /switch <session-id | number | search query>" };
        const all = this.manager.listSessions({ includeArchived: false });

        // By number (1-based, as shown by /sessions)
        const asNum = Number(arg);
        if (Number.isInteger(asNum) && asNum >= 1 && asNum <= all.length) {
          const target = all[asNum - 1]!;
          const rec = this.manager.switch(target.id);
          return { handled: true, switchToSessionId: rec.id, clearScreen: true, message: `Switched to: ${rec.title}` };
        }

        // By id prefix
        const byId = all.find((s) => s.id.startsWith(arg) || s.id === arg);
        if (byId) {
          const rec = this.manager.switch(byId.id);
          return { handled: true, switchToSessionId: rec.id, clearScreen: true, message: `Switched to: ${rec.title}` };
        }

        // By fuzzy search on title
        const byTitle = all.find((s) => s.title.toLowerCase().includes(arg.toLowerCase()));
        if (byTitle) {
          const rec = this.manager.switch(byTitle.id);
          return { handled: true, switchToSessionId: rec.id, clearScreen: true, message: `Switched to: ${rec.title}` };
        }

        return { handled: true, message: `No session matched "${arg}". Use /sessions to list them.` };
      },
    };
  }

  private renameCommand(): SlashCommand {
    return {
      name: "rename",
      description: "Rename the current conversation.",
      usage: "/rename <new title>",
      execute: (ctx) => {
        const id = ctx.sessionId;
        if (!id) return { handled: true, message: "No active session." };
        const title = ctx.args.join(" ");
        if (!title) return { handled: true, message: "Usage: /rename <new title>" };
        const rec = this.manager.rename(id, title);
        return { handled: true, message: `Renamed to: ${rec.title}` };
      },
    };
  }

  private deleteCommand(): SlashCommand {
    return {
      name: "delete",
      description: "Permanently delete a conversation.",
      usage: "/delete [session-id]",
      execute: (ctx) => {
        const arg = ctx.args[0];
        const id = arg ?? ctx.sessionId;
        if (!id) return { handled: true, message: "No session to delete." };
        const ok = this.manager.delete(id);
        if (!ok) return { handled: true, message: `Session not found: ${id}` };
        const remaining = this.manager.listSessions({ includeArchived: false });
        const switchTo = remaining[0]?.id;
        return {
          handled: true,
          message: `Deleted session ${id.slice(0, 8)}.`,
          switchToSessionId: switchTo,
          clearScreen: !!switchTo,
        };
      },
    };
  }

  private archiveCommand(): SlashCommand {
    return {
      name: "archive",
      description: "Archive a conversation (hide it, keep it on disk).",
      usage: "/archive [session-id]",
      execute: (ctx) => {
        const arg = ctx.args[0];
        const id = arg ?? ctx.sessionId;
        if (!id) return { handled: true, message: "No session to archive." };
        const rec = this.manager.archive(id);
        const remaining = this.manager.listSessions({ includeArchived: false });
        return {
          handled: true,
          message: `Archived: ${rec.title}`,
          switchToSessionId: remaining[0]?.id,
          clearScreen: !!remaining[0],
        };
      },
    };
  }

  private historyCommand(): SlashCommand {
    return {
      name: "history",
      description: "List previous sessions with timestamps, providers, models, and message counts.",
      execute: () => {
        const all = this.manager.listSessions({ includeArchived: true });
        if (all.length === 0) return { handled: true, message: "No history yet." };
        const lines = all.map((s, i) => {
          const created = new Date(s.createdAt).toLocaleDateString();
          const updated = new Date(s.updatedAt).toLocaleString();
          const arch = s.archived ? " [archived]" : "";
          const pin = s.pinned ? "📌 " : "";
          return `${pin}${i + 1}. ${s.title}${arch}\n     ${s.providerId}/${s.modelId} · ${s.messageCount} msgs · created ${created} · last ${updated}`;
        });
        return { handled: true, message: lines.join("\n") };
      },
    };
  }

  private resumeCommand(): SlashCommand {
    return {
      name: "resume",
      description: "Continue the most recent session.",
      execute: () => {
        try {
          const rec = this.manager.resumeMostRecent();
          return { handled: true, switchToSessionId: rec.id, clearScreen: true, message: `Resumed: ${rec.title}` };
        } catch {
          return { handled: true, message: "No sessions to resume." };
        }
      },
    };
  }

  private clearCommand(): SlashCommand {
    return {
      name: "clear",
      description: "Clear the current session's history (keep the session).",
      execute: (ctx) => {
        if (!ctx.sessionId) return { handled: true, message: "No active session." };
        this.manager.clear(ctx.sessionId);
        return { handled: true, clearScreen: true, message: "History cleared." };
      },
    };
  }

  private searchCommand(): SlashCommand {
    return {
      name: "search",
      description: "Search previous conversations by keyword.",
      usage: "/search <query>",
      execute: (ctx) => {
        const q = ctx.args.join(" ");
        if (!q) return { handled: true, message: "Usage: /search <query>" };
        const results = this.manager.search.search({ query: q, includeArchived: false });
        if (results.length === 0) return { handled: true, message: `No sessions matched "${q}".` };
        const lines = results.slice(0, 20).map((r, i) => {
          const snip = r.snippet ? ` — ${r.snippet}` : "";
          return `${i + 1}. ${r.title} (score ${r.score.toFixed(2)}, ${r.matchedOn.join(",")})${snip}  (${r.sessionId.slice(0, 8)})`;
        });
        return { handled: true, message: lines.join("\n") };
      },
    };
  }

  private helpCommand(): SlashCommand {
    return {
      name: "help",
      description: "List available slash commands.",
      execute: () => {
        const lines = this.list().map((c) => {
          const u = c.usage ? `  ${c.usage}` : `  /${c.name}`;
          return `${u}\n    ${c.description}`;
        });
        return { handled: true, message: lines.join("\n") };
      },
    };
  }

  private exitCommand(): SlashCommand {
    return {
      name: "exit",
      description: "Exit MINDIGENOUS.",
      execute: () => ({ handled: true, exit: true }),
    };
  }

  // ---- Capability-aware commands (/model, /refresh-models) -------------

  private modelCommand(): SlashCommand {
    return {
      name: "model",
      description: "Show the current model and its detected capabilities.",
      execute: () => {
        if (!this.bridge) {
          return { handled: true, message: "Model capability registry unavailable (no runtime bridge)." };
        }
        const sel = this.bridge.getCurrentSelection();
        if (!sel) return { handled: true, message: "No model selected." };
        const profile = this.bridge.getProfile(sel.providerId, sel.modelId);
        if (!profile) return { handled: true, message: `No capability profile for ${sel.providerId}/${sel.modelId}.` };

        const check = (ok: boolean) => (ok ? "✓" : "✗");
        const lines: string[] = [
          `Model:`,
          profile.model,
          ``,
          `Provider:`,
          this.bridge.getProviderLabel(sel.providerId),
          ``,
          `Capabilities`,
          ``,
          `${check(profile.chat)} Chat`,
          `${check(profile.vision)} Vision`,
          `${check(profile.streaming)} Streaming`,
          `${check(profile.toolCalling)} Tool Calling`,
          `${check(profile.structuredOutput)} Structured Output`,
          `${check(profile.supportsJSON)} JSON Mode`,
          `${check(profile.functionCalling)} Function Calling`,
          `${check(profile.reasoning)} Reasoning`,
          `${check(profile.supportsWebSearch)} Web Search`,
          ``,
          `${check(profile.imageGeneration)} Image Generation`,
          `${check(profile.audioInput)} Audio Input`,
          `${check(profile.audioOutput)} Audio Output`,
          `${check(profile.embeddings)} Embeddings`,
          `${check(profile.supportsVideo)} Video`,
          `${check(profile.supportsComputerUse)} Computer Use`,
          ``,
          `Context Window:`,
          profile.contextWindow ? formatTokens(profile.contextWindow) : "unknown",
          ``,
          `Max Output:`,
          profile.maxOutputTokens ? profile.maxOutputTokens.toLocaleString() : "unknown",
          ``,
          `Detected From:`,
          describeSource(profile.metadataSource),
        ];
        return { handled: true, message: lines.join("\n") };
      },
    };
  }

  private refreshModelsCommand(): SlashCommand {
    return {
      name: "refresh-models",
      description: "Reconnect to every provider, refresh metadata, rebuild the capability registry.",
      execute: async () => {
        if (!this.bridge) {
          return { handled: true, message: "Model capability registry unavailable (no runtime bridge)." };
        }
        const report = await this.bridge.refreshModels();
        const lines: string[] = [
          `Providers scanned:      ${report.providersScanned}`,
          `Models discovered:      ${report.modelsDiscovered}`,
          `Capabilities updated:   ${report.capabilitiesUpdated}`,
          `Cache refreshed:        ${report.cacheRefreshed ? "yes" : "no (in-memory)"}`,
        ];
        if (report.added > 0) lines.push(`Added:                  ${report.added}`);
        if (report.removed > 0) lines.push(`Removed:                ${report.removed}`);
        if (report.preserved > 0) lines.push(`Preserved:              ${report.preserved}`);
        const errEntries = Object.entries(report.errors);
        if (errEntries.length > 0) {
          lines.push(``, `Errors:`);
          for (const [providerId, msg] of errEntries) lines.push(`  ${providerId}: ${msg}`);
        }
        return { handled: true, message: lines.join("\n") };
      },
    };
  }
}

/** 128000 -> "128K", 1000000 -> "1M" */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
