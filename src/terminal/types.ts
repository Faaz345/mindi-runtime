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
}

export interface Attachment {
  name: string;
  mimeType: string;
  data: string;
  isImage: boolean;
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
