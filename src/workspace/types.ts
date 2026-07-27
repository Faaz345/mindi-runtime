/**
 * MINDI Workspace — Type System
 *
 * A Workspace is the persistent, per-directory container for everything MINDI
 * remembers about a project. It is intentionally separated into three layers:
 *
 *   1. Conversation history   — recent messages (transient, rolling)
 *   2. Project memory         — architecture, decisions, conventions (durable)
 *   3. Workspace state        — provider, model, tasks, timeline (durable)
 *
 * This separation lets MINDI scale to long-lived projects without hitting the
 * model's context window on every request: project memory is compact and
 * always injected, while conversation history is compressed/rolling.
 */

import type { CapabilityType, ChatMessage } from "../core/types.js";

// ---------------------------------------------------------------------------
// Workspace root
// ---------------------------------------------------------------------------

/**
 * Workspace-level metadata, persisted at `.mindi/workspace.json`.
 * Holds the list of sessions and the active session pointer. The actual
 * session bodies live in `.mindi/sessions/<id>.json`.
 */
export interface WorkspaceMeta {
  /** Schema version */
  version: 1;
  /** Absolute path of the project directory this workspace belongs to */
  rootDir: string;
  /** When the workspace was first created (epoch ms) */
  createdAt: number;
  /** When the workspace was last touched (epoch ms) */
  updatedAt: number;
  /** Id of the session that should be restored on next launch */
  activeSessionId: string | null;
  /** All known session summaries (lightweight — no message bodies) */
  sessions: SessionSummary[];
  /** Archived sessions (hidden from default listings) */
  archived: SessionSummary[];
  /** Workspace runtime settings (provider/model defaults, preferences) */
  settings: WorkspaceSettings;
}

export interface WorkspaceSettings {
  /** Default provider id when a new session doesn't override it */
  defaultProviderId?: string;
  /** Default model id when a new session doesn't override it */
  defaultModelId?: string;
  /** Max messages kept verbatim before compression kicks in */
  maxHistoryMessages?: number;
  /** Whether to auto-restore the last session on launch (default true) */
  autoRestore?: boolean;
  /** Whether to auto-save after every response (default true) */
  autoSave?: boolean;
  /** User preferences learned over time */
  preferences: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Lightweight session descriptor used in listings. Does NOT include message
 * bodies — those live in the full SessionRecord.
 */
export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  openedAt: number;
  providerId: string;
  modelId: string;
  messageCount: number;
  archived: boolean;
  pinned: boolean;
  tags: string[];
}

/**
 * Full persisted session. Stored at `.mindi/sessions/<id>.json`.
 * Contains everything required to resume a conversation exactly where it
 * left off — provider, model, history, execution timeline, attachments.
 */
export interface SessionRecord {
  /** Stable unique id */
  id: string;
  /** Human-readable title (auto-derived from first user message) */
  title: string;
  /** Creation time (epoch ms) */
  createdAt: number;
  /** Last update time (epoch ms) */
  updatedAt: number;
  /** Last time this session was opened (epoch ms) */
  openedAt: number;
  /** Provider id used in this session */
  providerId: string;
  /** Model id used in this session */
  modelId: string;
  /** Original system prompt (if any) seeded at creation */
  systemPrompt?: string;
  /** Full message history (system + user + assistant + capability) */
  messages: ChatMessage[];
  /** Execution events timeline (intent, plan, capability results, tokens) */
  timeline: ExecutionEvent[];
  /** File paths that were referenced or edited during the session */
  workingFiles: string[];
  /** Attachments (images, docs) preserved for the session */
  attachments: SessionAttachment[];
  /** Cumulative token usage */
  usage: SessionUsage;
  /** Arbitrary metadata (client, locale, ...) */
  meta: Record<string, unknown>;
  /** Tags for organization / search */
  tags: string[];
  /** Whether this session is archived */
  archived: boolean;
  /** Whether this session is pinned */
  pinned: boolean;
  /** If the session was forked from another, its id */
  forkedFrom?: string;
  /** Rolling summary of older (dropped) messages, if compression ran */
  summary?: SessionSummary2;
}

/** (Name intentionally distinct from SessionSummary above.) */
export interface SessionSummary2 {
  /** When the summary was last regenerated (epoch ms) */
  generatedAt: number;
  /** Compressed prose summary of dropped messages */
  text: string;
  /** How many original messages were folded into the summary */
  foldedMessageCount: number;
  /** Token estimate of the summary text */
  tokenEstimate: number;
}

export interface ExecutionEvent {
  /** When the event happened (epoch ms) */
  timestamp: number;
  /** Event kind */
  kind:
    | "request:start"
    | "request:end"
    | "intent"
    | "plan"
    | "capability:dispatch"
    | "capability:success"
    | "capability:error"
    | "provider:stream"
    | "provider:done"
    | "memory:written";
  /** Free-form payload specific to the kind */
  data: Record<string, unknown>;
}

export interface SessionAttachment {
  name: string;
  mimeType: string;
  /** Path on disk (if file-backed) or inline base64 */
  path?: string;
  base64?: string;
  /** When the attachment was added */
  addedAt: number;
}

export interface SessionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Estimated cost in USD */
  estimatedCost?: number;
  /** Number of requests made in this session */
  requestCount: number;
}

// ---------------------------------------------------------------------------
// Project memory — durable, cross-session
// ---------------------------------------------------------------------------

/**
 * Persistent project memory, stored at `.mindi/memory/project.json`.
 * Survives across sessions so every new session immediately understands the
 * project without re-explaining. Distinct from chat history.
 */
export interface ProjectMemory {
  version: 1;
  updatedAt: number;
  /** One-paragraph project description */
  overview: string;
  /** Detected/declared tech stack */
  techStack: TechStackEntry[];
  /** Architectural decisions (ADR-lite) */
  decisions: ArchitecturalDecision[];
  /** Coding conventions extracted from the codebase */
  conventions: ConventionEntry[];
  /** Important files MINDI should always be aware of */
  importantFiles: ImportantFile[];
  /** Project goals / milestones */
  goals: string[];
  /** Paths to ignore (in addition to .gitignore) */
  ignoredPaths: string[];
  /** Frequently used commands (build, test, lint, ...) */
  frequentCommands: FrequentCommand[];
  /** User preferences (preferred language, style, verbosity, ...) */
  userPreferences: Record<string, unknown>;
  /** Capabilities the project relies on */
  capabilitiesUsed: CapabilityType[];
}

export interface TechStackEntry {
  name: string;
  version?: string;
  category: "language" | "framework" | "runtime" | "database" | "tooling" | "other";
  notes?: string;
}

export interface ArchitecturalDecision {
  id: string;
  title: string;
  decision: string;
  rationale?: string;
  decidedAt: number;
  tags?: string[];
}

export interface ConventionEntry {
  id: string;
  topic: string;
  rule: string;
  examples?: string[];
}

export interface ImportantFile {
  path: string;
  reason: string;
  /** When this file was marked important */
  markedAt: number;
}

export interface FrequentCommand {
  command: string;
  description?: string;
  /** How many times MINDI has observed this command */
  useCount: number;
  lastUsedAt: number;
}

// ---------------------------------------------------------------------------
// Rolling summaries — `.mindi/memory/summaries.json`
// ---------------------------------------------------------------------------

/**
 * Per-session rolling summaries. When conversation history exceeds the
 * rolling window, older messages are folded into a compact summary and
 * dropped from the verbatim history. The summary is always injected so the
 * model retains long-term context without the token cost.
 */
export interface SummaryStore {
  version: 1;
  /** Map of sessionId -> latest rolling summary */
  summaries: Record<string, SessionSummary2>;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchQuery {
  /** Free-text keyword(s) */
  query?: string;
  /** Filter by session id(s) */
  sessionIds?: string[];
  /** Filter by provider id */
  providerId?: string;
  /** Filter by model id */
  modelId?: string;
  /** Only sessions created after this timestamp */
  since?: number;
  /** Only sessions created before this timestamp */
  until?: number;
  /** Minimum message count */
  minMessages?: number;
  /** Whether to include archived sessions */
  includeArchived?: boolean;
}

export interface SessionSearchResult {
  /** Session id that matched */
  sessionId: string;
  /** Session title */
  title: string;
  /** Why this session matched (matched snippets / field) */
  matchedOn: string[];
  /** Relevance score 0..1 */
  score: number;
  /** Message index that matched (if any) */
  messageIndex?: number;
  /** Preview snippet of the matched content */
  snippet?: string;
  /** Session summary */
  summary: SessionSummary;
}

// ---------------------------------------------------------------------------
// Slash command contract
// ---------------------------------------------------------------------------

export interface SlashCommandContext {
  /** Current session id */
  sessionId: string;
  /** All args after the command name */
  args: string[];
  /** Full raw input line */
  raw: string;
}

export interface SlashCommandResult {
  /** Whether the command was handled (false = unknown command) */
  handled: boolean;
  /** Optional message to display to the user */
  message?: string;
  /** Optional new session id to switch to */
  switchToSessionId?: string;
  /** Whether to clear the current screen */
  clearScreen?: boolean;
  /** Whether the runtime should exit */
  exit?: boolean;
}

export interface SlashCommand {
  /** Command name without the leading slash, e.g. "new" */
  name: string;
  /** Short description shown in /help */
  description: string;
  /** Usage hint, e.g. "/switch <session-id>" */
  usage?: string;
  /** Execute the command */
  execute(ctx: SlashCommandContext): Promise<SlashCommandResult> | SlashCommandResult;
}
