/** Shared types for the terminal UI. */

export interface Message {
  role: "user" | "assistant" | "system" | "capability";
  content: string;
  attachments?: Attachment[];
  timestamp: number;
  /** Elapsed time for the response (assistant messages only). */
  durationMs?: number;
  /** Model name that generated this response. */
  modelId?: string;
  /** Backend steps that produced this response (assistant messages only). */
  activities?: ActivityItem[];
  /** Render every code line instead of the normal long-block preview. */
  expandCode?: boolean;
}

/** Convert persisted runtime chat content into terminal-renderable text. */
export function messageFromChat(message: { role: string; content: unknown }): Message {
  const content = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content
        .map((part) => typeof part === "object" && part !== null && "text" in part
          ? String((part as { text?: unknown }).text ?? "")
          : "[attachment]")
        .join("")
      : String(message.content ?? "");
  const role: Message["role"] = message.role === "user" || message.role === "assistant" || message.role === "system" || message.role === "capability"
    ? message.role
    : "system";
  return { role, content, timestamp: Date.now() };
}

export interface Attachment {
  name: string;
  mimeType: string;
  data: string;
  isImage: boolean;
}

/**
 * One entry in the live activity feed — a single backend step shown to the
 * user while a request runs (Claude Code style transparency). Each step has
 * an icon, a human label, an optional detail, a status, and a duration so
 * the user always knows what the AI is doing and how long it took.
 */
export interface ActivityItem {
  /** Stable id for this activity entry */
  id: string;
  /** Icon shown at the left (unicode) */
  icon: string;
  /** Short label, e.g. "Analyzing intent" */
  label: string;
  /** Optional detail, e.g. "vision via openrouter" */
  detail?: string;
  /** Current status */
  status: "running" | "done" | "failed";
  /** Wall-clock duration in ms (set when status becomes done/failed) */
  durationMs?: number;
}

export type RuntimeStage =
  | "idle"
  | "thinking"
  | "negotiating"
  | "planning"
  | "executing"
  | "capability"
  | "context"
  | "generating";

export interface RuntimeStatus {
  stage: RuntimeStage;
  detail: string;
}

/** Action suggestion from the model (e.g. "Would you like me to..."). */
export interface ActionSuggestion {
  label: string;
  description: string;
}
