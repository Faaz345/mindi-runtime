/**
 * AgentOrchestrator — the true execution loop.
 *
 *   Plan → Execute → Observe → Reflect → Continue until goal completed
 *
 * The MODEL orchestrates; the RUNTIME executes. Each iteration:
 *   1. The model streams a response (deltas forwarded to the user, with
 *      tool-call JSON filtered out of the display).
 *   2. <tool_call> blocks are parsed from the completed response.
 *   3. The runtime executes each tool call through the CapabilityRegistry
 *      (the same sandboxed tools as pre-flight augmentation).
 *   4. fs.write calls are auto-verified with fs.read (artifact workflow).
 *   5. <tool_result> messages are appended and the loop continues.
 *   6. When the model responds with NO tool calls → goal completed.
 *
 * A single model response NEVER terminates a task that requested tools.
 */

import type {
  CapabilityResult,
  ChatMessage,
  ExecutionContext,
  IProvider,
  NativeToolCall,
} from "../core/types.js";
import path from "node:path";
import { toMindiError } from "../core/errors.js";
import type { CapabilityRegistry } from "../registry/CapabilityRegistry.js";
import type { StreamEvent } from "../streaming/StreamingEngine.js";
import type { TaskPlan } from "../planner/TaskPlanner.js";
import {
  AGENT_TOOLS,
  ToolCallStreamFilter,
  buildAgentSystemPrompt,
  buildNativeToolDefs,
  formatToolResultMessage,
  fromNativeToolName,
  parseToolCalls,
  toolCallToCapability,
  type ToolCall,
} from "./toolProtocol.js";
import { extractCodeBlocks, pickTargetPath, writeArtifact } from "./artifactRescue.js";

export interface AgentRunOptions {
  provider: IProvider;
  modelId: string;
  /** System + history + user message (+embedded images + pre-flight context). */
  baseMessages: ChatMessage[];
  /** The raw user prompt (used to detect requested artifact paths). */
  userText: string;
  taskPlan: TaskPlan;
  ctx: ExecutionContext;
  registry: CapabilityRegistry;
  workspace: string;
  maxIterations?: number;
  /**
   * When true, attach native function tools to chat requests (OpenAI-style
   * function calling). The textual <tool_call> protocol stays active as a
   * fallback — models that ignore native tools can still emit it.
   */
  nativeTools?: boolean;
}

export interface AgentRunResult {
  finalText: string;
  iterations: number;
  toolsExecuted: number;
  goalCompleted: boolean;
  /** Tool interaction messages for session persistence. */
  transcript: ChatMessage[];
}

const DEFAULT_MAX_ITERATIONS = 8;
const TOOL_RESULT_CAP = 6000; // chars fed back to the model per tool result

export class AgentOrchestrator {
  run(opts: AgentRunOptions): AsyncGenerator<StreamEvent, AgentRunResult, unknown> {
    return this.runInternal(opts);
  }

  private async *runInternal(opts: AgentRunOptions): AsyncGenerator<StreamEvent, AgentRunResult, unknown> {
    const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const { provider, modelId, taskPlan, ctx, registry } = opts;
    const transcript: ChatMessage[] = [];
    let toolsExecuted = 0;
    let finalText = "";

    // Insert the agent protocol system prompt BEFORE the last user message,
    // so the user's request stays the most recent instruction.
    const availableTools = AGENT_TOOLS.filter((t) => registry.has(t.capability));
    const useNativeTools = opts.nativeTools === true && availableTools.length > 0;
    const systemMsg: ChatMessage = {
      role: "system",
      content: buildAgentSystemPrompt({
        goal: taskPlan.goal,
        taskType: taskPlan.taskType,
        chain: taskPlan.chain,
        workspace: opts.workspace,
        availableTools,
        nativeTools: useNativeTools,
      }),
    };
    const messages: ChatMessage[] = insertBeforeLastUser(opts.baseMessages, systemMsg);
    const nativeDefs = useNativeTools ? buildNativeToolDefs(availableTools) : undefined;

    yield { type: "task", taskType: taskPlan.taskType, chain: taskPlan.chain.map(String), reasoning: taskPlan.reasoning };

    // Track whether the model itself wrote any artifact this run (used by
    // the artifact rescue to avoid double-writes).
    let verifiedArtifact = false;
    let artifactNoActionTurns = 0;
    let generalNoActionTurns = 0;
    // Capability preflight may already have completed the requested read or
    // search before the agent turn. In that case a plain answer is valid; only
    // tasks with no injected runtime result need a model-issued tool call.
    const hasPreflightContext = opts.baseMessages.some((message) => message.role === "capability");

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      if (ctx.signal.aborted) {
        yield { type: "goal", status: "failed", reason: "Cancelled by user" };
        yield { type: "done", finishReason: "stop" };
        return result(finalText, iteration - 1, toolsExecuted, false, transcript);
      }

      yield { type: "reflection", note: `Iteration ${iteration}/${maxIterations}`, iteration };

      // ---- 1. MODEL TURN (stream; filter tool-call JSON from display) ----
      const filter = new ToolCallStreamFilter();
      let full = "";
      let nativeCalls: NativeToolCall[] = [];
      const suppressIntermediateProse = isArtifactTask(taskPlan.taskType) && artifactNoActionTurns > 0 && !verifiedArtifact;
      let streamFailed: { code: string; message: string } | null = null;
      try {
        const chatStream = provider.chat(
          { model: modelId, messages, ...(nativeDefs ? { tools: nativeDefs } : {}) },
          ctx,
        );
        for await (const chunk of chatStream) {
          if (chunk.delta) {
            full += chunk.delta;
            const displayable = filter.push(chunk.delta);
            if (displayable && !suppressIntermediateProse) yield { type: "delta", text: displayable };
          }
          if (chunk.toolCalls && chunk.toolCalls.length > 0) {
            nativeCalls = chunk.toolCalls;
          }
          if (chunk.done) break;
        }
        const tail = filter.flush();
        if (tail && !suppressIntermediateProse) yield { type: "delta", text: tail };
      } catch (err) {
        const e = toMindiError(err);
        streamFailed = { code: e.code, message: e.message };
      }

      if (streamFailed) {
        // Surface partial text if any, then fail the goal cleanly.
        yield { type: "error", code: streamFailed.code, message: streamFailed.message };
        yield { type: "goal", status: "failed", reason: streamFailed.message };
        yield { type: "done", finishReason: "error" };
        return result(full, iteration, toolsExecuted, false, transcript);
      }

      finalText = full;
      // Preserve the assistant turn before feeding tool results or correction
      // messages back. Without this, many OpenAI-compatible models see an
      // orphaned <tool_result> and repeat their previous narration forever.
      // Native tool calls ride along on the assistant message (API contract).
      const assistantTurn: ChatMessage = {
        role: "assistant",
        content: full,
        ...(nativeCalls.length > 0 ? { toolCalls: nativeCalls } : {}),
      };
      messages.push(assistantTurn);
      transcript.push(assistantTurn);

      // ---- 2. PARSE tool calls from the completed response ----------------
      // Native function calls (API tool_calls channel) AND textual
      // <tool_call> blocks (fallback protocol) are both honored — some
      // models mix them, weak models only manage the text form.
      const { calls: textCalls } = parseToolCalls(full);
      const allCalls: Array<{ call: ToolCall; native?: NativeToolCall }> = [
        ...nativeCalls.map((nc) => ({
          native: nc,
          call: {
            name: fromNativeToolName(nc.name) ?? nc.name,
            arguments: parseArgsJson(nc.argumentsJson),
            raw: nc.argumentsJson,
          } as ToolCall,
        })),
        ...textCalls.map((call) => ({ call })),
      ];

      if (allCalls.length === 0) {
        // ---- ARTIFACT RESCUE ---------------------------------------------
        // Weak models dump code in chat instead of calling fs.write. For
        // artifact-type tasks, rescue the artifact: extract the code blocks
        // and write them to disk ourselves. The user always gets a real file.
        if (isArtifactTask(taskPlan.taskType) && !verifiedArtifact) {
          const rescued = yield* this.rescueArtifacts(full, opts);
          if (rescued > 0) {
            yield { type: "reflection", note: `Rescued ${rescued} artifact(s) — goal complete`, iteration };
            yield { type: "goal", status: "completed", reason: `Artifact(s) written and verified by runtime rescue` };
            yield { type: "done", finishReason: "stop" };
            return result(full, iteration, toolsExecuted, true, transcript);
          }
          artifactNoActionTurns++;
          if (artifactNoActionTurns >= 2) {
            const reason = "The selected model did not emit a tool call or a complete artifact after a runtime correction. Try a stronger instruction-following model, or ask it to return one complete fenced code block.";
            yield { type: "error", code: "E_AGENT_TOOL_PROTOCOL", message: reason };
            yield { type: "goal", status: "failed", reason };
            yield { type: "done", finishReason: "stop" };
            return result(full, iteration, toolsExecuted, false, transcript);
          }
          const correction = formatToolResultMessage(
            "artifact.required",
            false,
            "The requested file does not exist yet. Respond with exactly ONE of these: (1) an fs.write <tool_call> containing the COMPLETE file, or (2) one fenced code block containing the COMPLETE artifact so the runtime can save it for you. Do not narrate, promise, ask permission, inspect again, or tell the user to save it manually.",
          );
          messages.push({ role: "user", content: correction });
          transcript.push({ role: "user", content: correction });
          yield { type: "reflection", note: "Artifact not written — requiring filesystem execution", iteration };
          continue;
        }
        if (toolsExecuted === 0 && taskPlan.kind === "agentic" && !hasPreflightContext) {
          generalNoActionTurns++;
          if (generalNoActionTurns >= 2) {
            const reason = "The selected model did not execute any required tools after a runtime correction. This model may not reliably follow the MINDI tool protocol; try another instruction-following model.";
            yield { type: "error", code: "E_AGENT_TOOL_PROTOCOL", message: reason };
            yield { type: "goal", status: "failed", reason };
            yield { type: "done", finishReason: "stop" };
            return result(full, iteration, toolsExecuted, false, transcript);
          }
          const correction = formatToolResultMessage(
            "tool.required",
            false,
            `This task requires real tool execution (${taskPlan.chain.join(", ")}). Call the appropriate available tool now. Do not narrate or claim completion without a successful tool result.`,
          );
          messages.push({ role: "user", content: correction });
          transcript.push({ role: "user", content: correction });
          yield { type: "reflection", note: "No tool executed — requiring agent action", iteration };
          continue;
        }
        // No requested actions → the goal is complete.
        yield { type: "reflection", note: "No further actions requested — goal complete", iteration };
        yield { type: "goal", status: "completed", reason: "Model finished without requesting more tools" };
        yield { type: "done", finishReason: "stop" };
        return result(full, iteration, toolsExecuted, true, transcript);
      }

      // ---- 3. EXECUTE tool calls ------------------------------------------
      for (const { call: parsedCall, native } of allCalls) {
        const call = normalizeToolCall(parsedCall, opts.workspace);
        toolsExecuted++;
        const toolResult = await this.executeCall(call, opts);
        // Emit tool lifecycle events.
        yield {
          type: "tool",
          phase: "finished",
          name: call.name,
          ok: toolResult.ok,
          durationMs: toolResult.durationMs,
          preview: previewOf(toolResult),
        };

        // ---- 4. ARTIFACT VERIFICATION (fs.write → fs.read) ----------------
        if (call.name === "fs.write" && toolResult.ok) {
          const verify = await this.verifyWrite(call, opts);
          verifiedArtifact ||= verify;
          yield {
            type: "file",
            path: String(call.arguments.path ?? ""),
            bytes: bytesOf(toolResult),
            verified: verify,
          };
        }

        // ---- 5. Feed result back ------------------------------------------
        let body = resultBody(toolResult);
        if (call.name === "fs.write" && toolResult.ok && !verifiedArtifact) {
          body += "\nWrite verification failed. The artifact is not complete; retry the write.";
        }
        if (native) {
          // Native function-calling contract: results go back as tool-role
          // messages keyed by the call id.
          const toolMsg: ChatMessage = {
            role: "tool",
            toolCallId: native.id,
            name: native.name,
            content: `[${call.name} ${toolResult.ok ? "ok" : "failed"}]\n${body}`,
          };
          messages.push(toolMsg);
          transcript.push(toolMsg);
        } else {
          const msg = formatToolResultMessage(call.name, toolResult.ok, body);
          messages.push({ role: "user", content: msg });
          transcript.push({ role: "user", content: msg });
        }
      }

      // ---- 6. REFLECT → continue ------------------------------------------
      yield {
        type: "reflection",
        note: `${allCalls.length} tool call(s) executed — continuing`,
        iteration,
      };
    }

    // Hard iteration limit reached.
    yield { type: "goal", status: "failed", reason: `Reached max iterations (${maxIterations})` };
    yield { type: "done", finishReason: "length" };
    return result(finalText, maxIterations, toolsExecuted, false, transcript);

    function result(text: string, iterations: number, tools: number, ok: boolean, tr: ChatMessage[]): AgentRunResult {
      return { finalText: text, iterations, toolsExecuted: tools, goalCompleted: ok, transcript: tr };
    }
  }

  /** Execute one tool call through the registry. Never throws — errors are
   *  returned as failed results so the model can react to them. */
  private async executeCall(call: ToolCall, opts: AgentRunOptions): Promise<CapabilityResult> {
    const start = Date.now();
    const mapped = toolCallToCapability(call);
    if (!mapped) {
      return {
        type: "filesystem" as never,
        source: "agent",
        ok: false,
        payload: { kind: "text", text: "" },
        error: `Unknown tool: ${call.name}. Available: ${AGENT_TOOLS.map((t) => t.name).join(", ")}`,
        durationMs: Date.now() - start,
      };
    }
    const cap = opts.registry.getByType(mapped.type)[0];
    if (!cap) {
      return {
        type: mapped.type,
        source: "agent",
        ok: false,
        payload: { kind: "text", text: "" },
        error: `No executor registered for ${mapped.type}`,
        durationMs: Date.now() - start,
      };
    }
    try {
      const input = {
        type: mapped.type,
        params: mapped.params,
        requestId: opts.ctx.requestId,
        sessionId: opts.ctx.sessionId,
      };
      return await cap.execute(input, opts.ctx);
    } catch (err) {
      const e = toMindiError(err);
      return {
        type: mapped.type,
        source: cap.id,
        ok: false,
        payload: { kind: "text", text: "" },
        error: e.message,
        durationMs: Date.now() - start,
      };
    }
  }

  /** Verify an fs.write by reading the file back. */
  private async verifyWrite(call: ToolCall, opts: AgentRunOptions): Promise<boolean> {
    try {
      const cap = opts.registry.getByType("filesystem" as never)[0];
      if (!cap) return false;
      const res = await cap.execute(
        { type: "filesystem", params: { op: "read", path: call.arguments.path }, requestId: opts.ctx.requestId, sessionId: opts.ctx.sessionId },
        opts.ctx,
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Artifact rescue — extract large code blocks from the model's response
   * and write them to disk when the model failed to call fs.write itself.
   * Yields tool/file events and a user-facing summary delta.
   * Returns the number of artifacts written.
   */
  private async *rescueArtifacts(responseText: string, opts: AgentRunOptions): AsyncGenerator<StreamEvent, number, unknown> {
    const blocks = extractCodeBlocks(responseText);
    if (blocks.length === 0) return 0;

    const used = new Set<string>();
    let written = 0;
    const summaries: string[] = [];

    for (const block of blocks) {
      const target = pickTargetPath(block, opts.userText, opts.workspace, used);
      yield { type: "tool", phase: "selected", name: "fs.write", preview: `rescue → ${target}` };
      const start = Date.now();
      const { result, verified } = await writeArtifact(opts.registry, opts.ctx, target, block.content);
      yield {
        type: "tool",
        phase: "finished",
        name: "fs.write",
        ok: result.ok,
        durationMs: Date.now() - start,
        preview: target,
      };
      if (!result.ok) continue;
      const bytes = Buffer.byteLength(block.content);
      yield { type: "file", path: target, bytes, verified };
      written++;
      summaries.push(`${target} (${bytes.toLocaleString()} bytes${verified ? ", verified" : ""})`);
    }

    if (written > 0) {
      const note = `\n\n📦 Artifact${written > 1 ? "s" : ""} saved by runtime:\n${summaries.map((s) => `  • ${s}`).join("\n")}`;
      yield { type: "delta", text: note };
    }
    return written;
  }
}

/** Task types where an artifact file is the expected deliverable. */
function isArtifactTask(taskType: string): boolean {
  return taskType === "artifact-save" || taskType === "recreate-from-image" || taskType === "scaffold";
}

/** Parse a native tool call's raw arguments JSON (tolerant — {} on garbage). */
function parseArgsJson(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Keep weak-model filesystem calls inside the workspace and prevent an input
 * attachment path from being mistaken for the generated artifact target. */
export function normalizeToolCall(call: ToolCall, workspace: string): ToolCall {
  if (!call.name.startsWith("fs.")) return call;
  const raw = typeof call.arguments.path === "string" ? call.arguments.path.trim() : "";
  if (!raw) return call;

  let target = raw;
  if (call.name === "fs.write" && isSourceAttachment(raw)) {
    target = derivedOutputName(String(call.arguments.content ?? ""));
  } else if (path.isAbsolute(raw)) {
    const relative = path.relative(path.resolve(workspace), path.resolve(raw));
    if (relative.startsWith("..") || path.isAbsolute(relative)) target = path.basename(raw);
  }
  if (!path.isAbsolute(target)) target = path.join(workspace, target);

  return target === raw
    ? call
    : { ...call, arguments: { ...call.arguments, path: target } };
}

function isSourceAttachment(target: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|bmp|tiff?|svg|pdf)$/i.test(target);
}

function derivedOutputName(content: string): string {
  const trimmed = content.trimStart();
  if (/^<!doctype html|^<html\b/i.test(trimmed)) return "index.html";
  if (/^(?:import|export|const|let|var|function|class)\b/m.test(trimmed)) return "index.js";
  if (/^\s*[.#@\w-]+\s*\{/m.test(trimmed)) return "style.css";
  return "output.txt";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a system message before the LAST user message (keeps the user's
 *  request as the most recent instruction). */
function insertBeforeLastUser(messages: ChatMessage[], sys: ChatMessage): ChatMessage[] {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") { lastUser = i; break; }
  }
  if (lastUser < 0) return [...messages, sys];
  return [...messages.slice(0, lastUser), sys, ...messages.slice(lastUser)];
}

function previewOf(result: CapabilityResult): string {
  if (!result.ok) return result.error ?? "failed";
  const p = result.payload;
  switch (p.kind) {
    case "text": return p.text.slice(0, 80);
    case "structured": return JSON.stringify(p.data).slice(0, 80);
    case "file": return `${p.path} (${p.content.length} chars)`;
    case "files": return `${p.entries.length} entries`;
    case "command": return `exit ${p.exitCode}`;
    case "search": return `${p.results.length} results`;
    default: return "ok";
  }
}

function resultBody(result: CapabilityResult): string {
  if (!result.ok) return `Error: ${result.error ?? "unknown"}`;
  const p = result.payload;
  let body: string;
  switch (p.kind) {
    case "text": body = p.text; break;
    case "json": case "structured": body = JSON.stringify(p.data, null, 2); break;
    case "file": body = p.content; break;
    case "files": body = p.entries.map((e) => `${e.type === "dir" ? "[dir]" : "     "} ${e.path}`).join("\n"); break;
    case "command": body = `exit ${p.exitCode}\n${p.stdout}${p.stderr ? `\nstderr: ${p.stderr}` : ""}`; break;
    case "search": body = p.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n"); break;
    default: body = "ok";
  }
  return body.length > TOOL_RESULT_CAP ? body.slice(0, TOOL_RESULT_CAP) + `\n[...truncated]` : body;
}

function bytesOf(result: CapabilityResult): number {
  const p = result.payload;
  if (p.kind === "structured" && p.data && typeof p.data === "object" && "bytes" in p.data) {
    return Number((p.data as { bytes?: number }).bytes ?? 0);
  }
  return 0;
}
