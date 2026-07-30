/**
 * Tool Protocol — the channel that lets ANY chat model drive tools.
 *
 * Native function-calling is unreliable across the free/cheap models users
 * actually run (OpenRouter :free tiers, local servers, proxies). Instead,
 * the orchestrator teaches the model a simple textual protocol:
 *
 *   <tool_call>{"name":"fs.write","arguments":{"path":"...","content":"..."}}</tool_call>
 *
 * The model emits tool calls at the END of its response; the orchestrator
 * parses them, executes the tools, feeds <tool_result> messages back, and
 * the loop continues. When the model responds with no tool calls, the goal
 * is complete.
 *
 * This module is pure: parsing, prompt building, and result formatting.
 */

import type { CapabilityType, NativeToolDefinition } from "../core/types.js";
import { CapabilityType as Cap } from "../core/types.js";

// ---------------------------------------------------------------------------
// Tool definitions exposed to the model
// ---------------------------------------------------------------------------

export interface AgentToolDef {
  /** Protocol name the model calls, e.g. "fs.write" */
  name: string;
  /** Runtime capability type it maps to */
  capability: CapabilityType;
  /** One-line description shown in the system prompt */
  description: string;
  /** Argument schema shown in the system prompt */
  args: string;
}

/** The deterministic tools the orchestrator may offer the model. */
export const AGENT_TOOLS: AgentToolDef[] = [
  { name: "fs.read", capability: Cap.Filesystem, description: "Read a file's contents", args: `{"path": "string"}` },
  { name: "fs.write", capability: Cap.Filesystem, description: "Write content to a file (creates dirs)", args: `{"path": "string", "content": "string"}` },
  { name: "fs.mkdir", capability: Cap.Filesystem, description: "Create a directory and any missing parents", args: `{"path": "string"}` },
  { name: "fs.list", capability: Cap.Filesystem, description: "List files in a directory", args: `{"path": "string"}` },
  { name: "terminal.run", capability: Cap.Terminal, description: "Run a shell command (build/test/git/etc.)", args: `{"command": "string"}` },
  { name: "git.run", capability: Cap.Git, description: "Run a git command (status/clone/log/diff)", args: `{"command": "string"}` },
  { name: "web.search", capability: Cap.WebSearch, description: "Search the web, returns titles/urls/snippets", args: `{"query": "string"}` },
  { name: "http.get", capability: Cap.Browser, description: "Fetch a URL and return page content", args: `{"url": "string"}` },
];

// ---------------------------------------------------------------------------
// Native function calling (OpenAI-style tools)
// ---------------------------------------------------------------------------
//
// Provider APIs reject dots in function names, so protocol names ("fs.read")
// are mapped to safe native names ("fs_read") and back. The agent loop uses
// these when the model's capability profile reports toolCalling support.

/** Map a protocol tool name to an API-safe native function name. */
export function toNativeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Map a native function name back to its protocol name (null = unknown). */
export function fromNativeToolName(nativeName: string): string | null {
  const def = AGENT_TOOLS.find((t) => toNativeToolName(t.name) === nativeName);
  return def?.name ?? null;
}

/** JSON Schemas for each agent tool, keyed by protocol name. */
export const AGENT_TOOL_SCHEMAS: Record<string, Record<string, unknown>> = {
  "fs.read": {
    type: "object",
    properties: { path: { type: "string", description: "File path (absolute or workspace-relative)" } },
    required: ["path"],
  },
  "fs.write": {
    type: "object",
    properties: {
      path: { type: "string", description: "Target file path (absolute or workspace-relative)" },
      content: { type: "string", description: "COMPLETE file content to write" },
    },
    required: ["path", "content"],
  },
  "fs.mkdir": {
    type: "object",
    properties: { path: { type: "string", description: "Directory path to create" } },
    required: ["path"],
  },
  "fs.list": {
    type: "object",
    properties: { path: { type: "string", description: "Directory to list (defaults to workspace root)" } },
  },
  "terminal.run": {
    type: "object",
    properties: { command: { type: "string", description: "Shell command to execute (must be allow-listed)" } },
    required: ["command"],
  },
  "git.run": {
    type: "object",
    properties: { command: { type: "string", description: "Git command without the leading 'git' (e.g. 'status')" } },
    required: ["command"],
  },
  "web.search": {
    type: "object",
    properties: { query: { type: "string", description: "Search query" } },
    required: ["query"],
  },
  "http.get": {
    type: "object",
    properties: { url: { type: "string", description: "URL to fetch" } },
    required: ["url"],
  },
};

/** Build native tool definitions for a chat request from protocol tool defs. */
export function buildNativeToolDefs(tools: AgentToolDef[]): NativeToolDefinition[] {
  return tools.map((t) => ({
    name: toNativeToolName(t.name),
    description: t.description,
    parameters: AGENT_TOOL_SCHEMAS[t.name] ?? { type: "object", properties: {} },
  }));
}

// ---------------------------------------------------------------------------
// Tool-call parsing
// ---------------------------------------------------------------------------

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** Raw JSON text of the call (for logging). */
  raw: string;
}

const TOOL_CALL_RE = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
const FENCED_TOOL_CALL_RE = /```(?:tool_call|tool|json)\s*\n\s*(\{\s*"name"\s*:\s*"(?:fs\.|terminal\.|git\.|web\.|http\.)[\s\S]*?\})\s*```/g;

/**
 * Extract tool calls from a completed model response.
 * Returns the parsed calls plus the response text with the call blocks
 * stripped (for display).
 */
export function parseToolCalls(text: string): { calls: ToolCall[]; textWithout: string } {
  const calls: ToolCall[] = [];
  let textWithout = text;
  for (const match of [...text.matchAll(TOOL_CALL_RE), ...text.matchAll(FENCED_TOOL_CALL_RE)]) {
    const raw = match[1]!;
    try {
      const parsed = JSON.parse(raw) as { name?: unknown; arguments?: unknown };
      if (typeof parsed.name === "string" && parsed.name.length > 0) {
        calls.push({
          name: parsed.name,
          arguments: (parsed.arguments && typeof parsed.arguments === "object" ? parsed.arguments : {}) as Record<string, unknown>,
          raw,
        });
      }
    } catch {
      // Malformed JSON in a call block — ignore the call, keep the text.
    }
  }
  textWithout = textWithout.replace(TOOL_CALL_RE, "").trim();
  textWithout = textWithout.replace(FENCED_TOOL_CALL_RE, "").trim();
  return { calls, textWithout };
}

/** True if the text contains a (possibly complete) tool call marker. */
export function hasToolCallMarker(text: string): boolean {
  return text.includes("<tool_call>");
}

// ---------------------------------------------------------------------------
// Stream filter — hide tool-call spans from the user display
// ---------------------------------------------------------------------------

/**
 * Stateful filter applied to streaming deltas. Everything before the first
 * `<tool_call>` marker is displayable; everything from the marker onward is
 * held back (it's tool-call JSON, not prose). Handles markers split across
 * chunk boundaries by keeping a small unflushed tail.
 */
export class ToolCallStreamFilter {
  private buf = "";
  private suppressing = false;

  /** Push a delta; returns the displayable portion (may be ""). */
  push(delta: string): string {
    if (this.suppressing) {
      this.buf += delta;
      return "";
    }
    this.buf += delta;
    const idx = this.buf.indexOf("<tool_call>");
    if (idx >= 0) {
      const out = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx);
      this.suppressing = true;
      return out;
    }
    // Keep a tail so a marker split across chunks isn't half-shown.
    const keep = "<tool_call>".length;
    if (this.buf.length > keep) {
      const out = this.buf.slice(0, this.buf.length - keep);
      this.buf = this.buf.slice(-keep);
      return out;
    }
    return "";
  }

  /** Flush at stream end. Suppressed content is never shown. */
  flush(): string {
    return this.suppressing ? "" : this.buf;
  }
}

// ---------------------------------------------------------------------------
// Capability input mapping
// ---------------------------------------------------------------------------

/** Map a protocol tool call to a runtime capability type + params. */
export function toolCallToCapability(call: ToolCall): { type: CapabilityType; params: Record<string, unknown> } | null {
  const def = AGENT_TOOLS.find((t) => t.name === call.name);
  if (!def) return null;
  switch (call.name) {
    case "fs.read":
      return { type: def.capability, params: { op: "read", path: call.arguments.path } };
    case "fs.write":
      return { type: def.capability, params: { op: "write", path: call.arguments.path, content: call.arguments.content } };
    case "fs.mkdir":
      return { type: def.capability, params: { op: "mkdir", path: call.arguments.path } };
    case "fs.list":
      return { type: def.capability, params: { op: "list", path: call.arguments.path ?? "" } };
    case "terminal.run":
      return { type: def.capability, params: { command: call.arguments.command } };
    case "git.run":
      return { type: def.capability, params: { command: call.arguments.command } };
    case "web.search":
      return { type: def.capability, params: { query: call.arguments.query } };
    case "http.get":
      return { type: def.capability, params: { url: call.arguments.url } };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

/**
 * Build the system prompt that teaches the model the tool protocol and the
 * artifact workflow for this task.
 *
 * When `nativeTools` is true, the model has real function-calling tools
 * attached to the request — the prompt instructs it to call them directly
 * instead of emitting textual <tool_call> blocks (which remain the fallback
 * for models without native tool support).
 */
export function buildAgentSystemPrompt(opts: {
  goal: string;
  taskType: string;
  chain: string[];
  workspace: string;
  availableTools: AgentToolDef[];
  nativeTools?: boolean;
}): string {
  const toolLines = opts.availableTools
    .map((t) => `  - ${t.name} ${t.args} — ${t.description}`)
    .join("\n");

  const protocolSection = opts.nativeTools
    ? [
        `## Tool use`,
        `You have native function tools attached to this request. To take an`,
        `action, CALL the tool directly through the function-calling interface.`,
        `Do NOT write <tool_call> blocks, do NOT print tool JSON as text.`,
        `Available functions (same names with dots, e.g. fs.write → fs_write):`,
        toolLines,
        ``,
        `Rules:`,
        `1. After each call, the runtime executes it and returns the result as a tool message. Continue from those results.`,
        `2. When the goal is FULLY complete, reply with a summary and make NO further tool calls.`,
        `3. Never pretend a tool ran. Never claim a file exists unless you wrote it with fs.write and verified it.`,
      ]
    : [
        `## Tool protocol`,
        `To use a tool, emit at the END of your response, one per line:`,
        `<tool_call>{"name":"<tool>","arguments":{...}}</tool_call>`,
        `Available tools:`,
        toolLines,
        ``,
        `Rules:`,
        `1. After you emit tool calls, the runtime executes them and returns <tool_result> messages. Continue from those results.`,
        `2. When the goal is FULLY complete, reply with a summary and NO tool calls.`,
        `3. Never pretend a tool ran. Never claim a file exists unless you wrote it with fs.write and verified it.`,
      ];

  return [
    `You are an autonomous coding agent running inside the MINDI Runtime.`,
    `The runtime executes tools FOR you. You decide WHAT to do; the runtime does it.`,
    `You are in BUILD MODE. Execute the task autonomously using every tool permitted by the sandbox.`,
    `Do not ask the user for permission before normal reads, writes, edits, or verification inside the workspace.`,
    ``,
    `GOAL: ${opts.goal}`,
    `Task type: ${opts.taskType}. Required execution chain: ${opts.chain.join(" → ")}.`,
    `Workspace: ${opts.workspace}`,
    ``,
    `## HARD RULE (most important)`,
    `When the deliverable is a file (code, HTML, CSS, JS, Markdown, config, ...):`,
    `you MUST write it with the fs.write tool call. NEVER output a complete file`,
    `as a chat code block and stop — that is a FAILED task. Write the file FIRST,`,
    `then reply with a short summary. If you output a code block instead of calling`,
    `fs.write, the runtime will treat the task as INCOMPLETE.`,
    ``,
    ...protocolSection,
    ``,
    `## Sandbox rules (the runtime enforces these — do not fight them)`,
    `  - fs.* tools only access paths INSIDE the workspace. Absolute paths`,
    `    outside it are rewritten or rejected — an ENOENT after such a rewrite`,
    `    means "outside the sandbox", not "file missing".`,
    `  - If the user references a file outside the workspace, the RUNTIME`,
    `    attaches it — you cannot. Never probe for it with terminal commands`,
    `    (dir/ls/test/stat are not allow-listed and WILL fail).`,
    `  - terminal.run only executes allow-listed commands. For file inspection`,
    `    always prefer fs.list / fs.read over shell commands.`,
    ``,
    `## Artifact workflow (MANDATORY for file-based output)`,
    `When the user asks for code, HTML, CSS, JS, Markdown, config, or any file:`,
    `  a. Generate the COMPLETE content.`,
    `  b. Write it with fs.write to the user's requested path (or a sensible name in the workspace).`,
    `  c. Verify with fs.read that it was written correctly.`,
    `  d. Reply with an ARTIFACT SUMMARY: file path, size, and how to open it. Do NOT paste the full file in chat — only short snippets when helpful.`,
    ``,
    `Work step by step. Use as many iterations as you need. The runtime keeps the loop alive until you stop calling tools.`,
  ].join("\n");
}

/** Format a tool result for the model (fed back as a user message). */
export function formatToolResultMessage(name: string, ok: boolean, body: string): string {
  return `<tool_result name="${name}" status="${ok ? "ok" : "failed"}">\n${body}\n</tool_result>`;
}
