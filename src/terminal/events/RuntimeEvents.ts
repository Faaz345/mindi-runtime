/**
 * Runtime Event Type System
 *
 * Every action performed by the runtime is represented as a typed event.
 * The UI renders each event using its own dedicated renderer component.
 *
 * Architecture:
 *   Runtime emits structured events → Event Bus → Timeline → Renderer Registry → Component
 *
 * The Runtime never knows how events are displayed.
 * Adding a new capability = define a new event type + register a renderer.
 */

// ---------------------------------------------------------------------------
// Base event metadata (every event has this)
// ---------------------------------------------------------------------------

export interface EventMeta {
  /** Unique id for this event */
  id: string;
  /** Timestamp when the event was created (epoch ms) */
  timestamp: number;
  /** Duration of the action (ms). 0 for instantaneous events. */
  durationMs: number;
  /** Current status */
  status: EventStatus;
  /** Provider that emitted this event (e.g. "tokenrouter", "openai") */
  provider?: string;
  /** Model used (e.g. "z-ai/glm-5.2-free") */
  model?: string;
  /** Tool that produced this event (e.g. "tool.git", "tool.http") */
  tool?: string;
  /** Optional progress 0..1 */
  progress?: number;
  /** Optional parent event id (for grouping) */
  parentId?: string;
  /** Optional icon override */
  icon?: string;
}

export type EventStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "warning";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type RuntimeEventType =
  | "planning"
  | "thinking"
  | "chat_response"
  | "tool_started"
  | "tool_finished"
  | "tool_output"
  | "bash_command"
  | "command_output"
  | "file_created"
  | "file_modified"
  | "file_deleted"
  | "git_changes"
  | "diff"
  | "web_search"
  | "http_request"
  | "browser_automation"
  | "database_query"
  | "memory_access"
  | "image_generation"
  | "ocr"
  | "progress_update"
  | "warning"
  | "error"
  | "success"
  | "timeline_checkpoint"
  | "completion"
  | "user_message"
  | "capability_dispatch"
  | "intent_analyzed"
  | "capability_plan"
  | "permission_checked"
  | "permission_denied"
  | "tool_unavailable";

// ---------------------------------------------------------------------------
// Typed event definitions
// ---------------------------------------------------------------------------

export interface PlanningEvent {
  type: "planning";
  meta: EventMeta;
  title: string;
  steps: string[];
  currentStep?: number;
}

export interface ThinkingEvent {
  type: "thinking";
  meta: EventMeta;
  summary: string;
}

export interface ChatResponseEvent {
  type: "chat_response";
  meta: EventMeta;
  /** Raw markdown content (never pre-wrapped) */
  content: string;
  /** Whether this is still streaming */
  isStreaming: boolean;
  /** Token count */
  tokens?: number;
}

export interface ToolStartedEvent {
  type: "tool_started";
  meta: EventMeta;
  toolName: string;
  toolId: string;
  description: string;
}

export interface ToolFinishedEvent {
  type: "tool_finished";
  meta: EventMeta;
  toolName: string;
  toolId: string;
  success: boolean;
  summary: string;
}

export interface ToolOutputEvent {
  type: "tool_output";
  meta: EventMeta;
  toolId: string;
  output: string;
  outputType: "stdout" | "stderr" | "result" | "json";
}

export interface BashCommandEvent {
  type: "bash_command";
  meta: EventMeta;
  command: string;
  cwd: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** True while command is running */
  isRunning: boolean;
}

export interface CommandOutputEvent {
  type: "command_output";
  meta: EventMeta;
  stream: "stdout" | "stderr";
  text: string;
}

export interface FileCreatedEvent {
  type: "file_created";
  meta: EventMeta;
  filePath: string;
  content?: string;
  lines?: number;
}

export interface FileModifiedEvent {
  type: "file_modified";
  meta: EventMeta;
  filePath: string;
  linesAdded: number;
  linesRemoved: number;
  diff?: string;
}

export interface FileDeletedEvent {
  type: "file_deleted";
  meta: EventMeta;
  filePath: string;
}

export interface GitChangesEvent {
  type: "git_changes";
  meta: EventMeta;
  branch: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  status: string;
}

export interface DiffEvent {
  type: "diff";
  meta: EventMeta;
  filePath: string;
  diff: string;
  linesAdded: number;
  linesRemoved: number;
}

export interface WebSearchEvent {
  type: "web_search";
  meta: EventMeta;
  query: string;
  results: Array<{
    title: string;
    url: string;
    snippet: string;
  }>;
  sourcesVisited?: number;
  summary?: string;
}

export interface HttpRequestEvent {
  type: "http_request";
  meta: EventMeta;
  method: string;
  url: string;
  statusCode?: number;
  responseSize?: number;
  requestBody?: string;
  responseBody?: string;
}

export interface BrowserAutomationEvent {
  type: "browser_automation";
  meta: EventMeta;
  action: string;
  url?: string;
  screenshot?: string;
  dom?: string;
}

export interface DatabaseQueryEvent {
  type: "database_query";
  meta: EventMeta;
  query: string;
  database: string;
  rowsAffected?: number;
  results?: unknown[];
  duration?: number;
}

export interface MemoryAccessEvent {
  type: "memory_access";
  meta: EventMeta;
  operation: "read" | "write" | "delete";
  sessionId: string;
  entries: number;
}

export interface ImageGenerationEvent {
  type: "image_generation";
  meta: EventMeta;
  prompt: string;
  model: string;
  imageBase64?: string;
  url?: string;
}

export interface OcrEvent {
  type: "ocr";
  meta: EventMeta;
  source: string;
  text: string;
  confidence?: number;
}

export interface ProgressUpdateEvent {
  type: "progress_update";
  meta: EventMeta;
  phase: string;
  percent: number;
  tasksRunning: number;
  tasksWaiting: number;
  tasksCompleted: number;
}

export interface WarningEvent {
  type: "warning";
  meta: EventMeta;
  message: string;
  details?: string;
}

export interface ErrorEvent {
  type: "error";
  meta: EventMeta;
  message: string;
  code: string;
  details?: string;
  stack?: string;
}

export interface SuccessEvent {
  type: "success";
  meta: EventMeta;
  message: string;
}

export interface TimelineCheckpointEvent {
  type: "timeline_checkpoint";
  meta: EventMeta;
  label: string;
  eventsBefore: number;
}

export interface CompletionEvent {
  type: "completion";
  meta: EventMeta;
  summary: string;
  totalDurationMs: number;
  tokensUsed: number;
  toolsExecuted: number;
}

export interface UserMessageEvent {
  type: "user_message";
  meta: EventMeta;
  content: string;
  attachments?: Array<{ name: string; mimeType: string }>;
}

export interface CapabilityDispatchEvent {
  type: "capability_dispatch";
  meta: EventMeta;
  capability: string;
  executor: string;
  executorType: "tool" | "provider";
}

export interface IntentAnalyzedEvent {
  type: "intent_analyzed";
  meta: EventMeta;
  summary: string;
  capabilities: string[];
  confidence: number;
}

export interface CapabilityPlanEvent {
  type: "capability_plan";
  meta: EventMeta;
  satisfied: string[];
  missing: string[];
  unavailable: Array<{ type: string; reason: string }>;
}

export interface PermissionCheckedEvent {
  type: "permission_checked";
  meta: EventMeta;
  tool: string;
  operation: string;
  allowed: boolean;
  reason: string;
}

export interface PermissionDeniedEvent {
  type: "permission_denied";
  meta: EventMeta;
  tool: string;
  operation: string;
  reason: string;
  alternative?: string;
}

export interface ToolUnavailableEvent {
  type: "tool_unavailable";
  meta: EventMeta;
  tool: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Union type — every possible runtime event
// ---------------------------------------------------------------------------

export type RuntimeEvent2 =
  | PlanningEvent
  | ThinkingEvent
  | ChatResponseEvent
  | ToolStartedEvent
  | ToolFinishedEvent
  | ToolOutputEvent
  | BashCommandEvent
  | CommandOutputEvent
  | FileCreatedEvent
  | FileModifiedEvent
  | FileDeletedEvent
  | GitChangesEvent
  | DiffEvent
  | WebSearchEvent
  | HttpRequestEvent
  | BrowserAutomationEvent
  | DatabaseQueryEvent
  | MemoryAccessEvent
  | ImageGenerationEvent
  | OcrEvent
  | ProgressUpdateEvent
  | WarningEvent
  | ErrorEvent
  | SuccessEvent
  | TimelineCheckpointEvent
  | CompletionEvent
  | UserMessageEvent
  | CapabilityDispatchEvent
  | IntentAnalyzedEvent
  | CapabilityPlanEvent
  | PermissionCheckedEvent
  | PermissionDeniedEvent
  | ToolUnavailableEvent;

// ---------------------------------------------------------------------------
// Event factory helpers
// ---------------------------------------------------------------------------

let eventCounter = 0;

export function genEventId(): string {
  eventCounter++;
  return `evt-${Date.now().toString(36)}-${eventCounter.toString(36)}`;
}

export function createMeta(partial: Partial<EventMeta> = {}): EventMeta {
  return {
    id: genEventId(),
    timestamp: Date.now(),
    durationMs: 0,
    status: "completed",
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Event status → icon + color
// ---------------------------------------------------------------------------

export function statusIcon(status: EventStatus): string {
  switch (status) {
    case "pending": return "○";
    case "running": return "◉";
    case "completed": return "✓";
    case "failed": return "✗";
    case "cancelled": return "⊘";
    case "warning": return "⚠";
  }
}

export function statusColor(status: EventStatus): string {
  switch (status) {
    case "pending": return "#6b6b80";
    case "running": return "#3b82f6";
    case "completed": return "#10b981";
    case "failed": return "#ef4444";
    case "cancelled": return "#6b6b80";
    case "warning": return "#f59e0b";
  }
}

// ---------------------------------------------------------------------------
// Event type → icon + default title
// ---------------------------------------------------------------------------

export function eventIcon(type: RuntimeEventType): string {
  const icons: Record<RuntimeEventType, string> = {
    planning: "🧩",
    thinking: "💭",
    chat_response: "💬",
    tool_started: "🔧",
    tool_finished: "🔧",
    tool_output: "📤",
    bash_command: "▶",
    command_output: "📋",
    file_created: "📄",
    file_modified: "✏️",
    file_deleted: "🗑",
    git_changes: "🌿",
    diff: "📋",
    web_search: "🔍",
    http_request: "🌐",
    browser_automation: "🖱",
    database_query: "🗄",
    memory_access: "🧠",
    image_generation: "🎨",
    ocr: "📝",
    progress_update: "📊",
    warning: "⚠",
    error: "✗",
    success: "✓",
    timeline_checkpoint: "📌",
    completion: "🏁",
    user_message: "›",
    capability_dispatch: "⚡",
    intent_analyzed: "🧠",
    capability_plan: "📋",
    permission_checked: "🔐",
    permission_denied: "🚫",
    tool_unavailable: "⚠",
  };
  return icons[type] ?? "•";
}
