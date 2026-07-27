import { describe, it, expect, vi, afterEach } from "vitest";
import {
  AGENT_TOOLS,
  buildAgentSystemPrompt,
  buildNativeToolDefs,
  fromNativeToolName,
  toNativeToolName,
} from "../src/agent/toolProtocol.js";
import { AgentOrchestrator } from "../src/agent/AgentOrchestrator.js";
import { CapabilityRegistry } from "../src/registry/CapabilityRegistry.js";
import { CapabilityType } from "../src/core/types.js";
import type {
  CapabilityInput,
  CapabilityResult,
  ChatChunk,
  ChatRequest,
  ExecutionContext,
  IProvider,
} from "../src/core/types.js";
import type { TaskPlan } from "../src/planner/TaskPlanner.js";
import { OpenAIProvider } from "../src/providers/openai/OpenAIProvider.js";

function makeCtx(): ExecutionContext {
  const ctrl = new AbortController();
  return {
    requestId: "t",
    sessionId: "s",
    signal: ctrl.signal,
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
    events: { emit() {}, on() { return () => {} }, clear() {} },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Name mapping + tool defs
// ---------------------------------------------------------------------------

describe("native tool name mapping", () => {
  it("round-trips every agent tool", () => {
    for (const t of AGENT_TOOLS) {
      const native = toNativeToolName(t.name);
      expect(native).toMatch(/^[a-zA-Z0-9_-]{1,64}$/); // provider-safe
      expect(fromNativeToolName(native)).toBe(t.name);
    }
  });

  it("returns null for unknown native names", () => {
    expect(fromNativeToolName("not_a_tool")).toBeNull();
  });

  it("builds native defs with JSON schemas", () => {
    const defs = buildNativeToolDefs(AGENT_TOOLS.filter((t) => t.name === "fs.write"));
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe("fs_write");
    expect(defs[0]!.parameters).toMatchObject({ type: "object", required: ["path", "content"] });
  });
});

describe("buildAgentSystemPrompt — native variant", () => {
  const base = { goal: "g", taskType: "artifact-save", chain: ["filesystem"], workspace: "C:\\ws", availableTools: AGENT_TOOLS };

  it("native mode forbids textual <tool_call> blocks", () => {
    const p = buildAgentSystemPrompt({ ...base, nativeTools: true });
    expect(p).toContain("function-calling interface");
    expect(p).toContain("fs_write");
    expect(p).not.toContain("emit at the END of your response");
  });

  it("text mode teaches the <tool_call> protocol", () => {
    const p = buildAgentSystemPrompt({ ...base, nativeTools: false });
    expect(p).toContain(`<tool_call>{"name":"<tool>","arguments":{...}}</tool_call>`);
  });
});

// ---------------------------------------------------------------------------
// OpenAIProvider wire behavior
// ---------------------------------------------------------------------------

describe("OpenAIProvider native tools + strict routing", () => {
  it("sends tools/tool_choice and accumulates streamed tool_calls fragments", async () => {
    const postedBodies: Array<Record<string, unknown>> = [];
    const sse = [
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"fs_read","arguments":""}}]}}]}`,
      ``,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}`,
      ``,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x.txt\\"}"}}]}}]}`,
      ``,
      `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}`,
      ``,
      `data: [DONE]`,
      ``,
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      postedBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }));

    const p = new OpenAIProvider({ apiKey: "k", baseUrl: "http://x/v1", displayName: "custom" });
    const chunks: ChatChunk[] = [];
    for await (const c of p.chat({
      model: "m",
      messages: [{ role: "user", content: "read x.txt" }],
      tools: [{ name: "fs_read", description: "Read a file", parameters: { type: "object" } }],
    }, makeCtx())) {
      chunks.push(c);
    }

    // Request carried the native tools.
    const body = postedBodies[0]!;
    expect(Array.isArray(body.tools)).toBe(true);
    expect((body.tools as Array<{ function: { name: string } }>)[0]!.function.name).toBe("fs_read");
    expect(body.tool_choice).toBe("auto");

    // Stream assembled one complete call.
    const last = chunks[chunks.length - 1]!;
    expect(last.done).toBe(true);
    expect(last.finishReason).toBe("tool_call");
    expect(last.toolCalls).toEqual([{ id: "call_abc", name: "fs_read", argumentsJson: `{"path":"x.txt"}` }]);
  });

  it("echoes assistant tool_calls and tool results on the wire", async () => {
    const postedBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      postedBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(`data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n`, { status: 200 });
    }));

    const p = new OpenAIProvider({ apiKey: "k", baseUrl: "http://x/v1", displayName: "custom" });
    const req: ChatRequest = {
      model: "m",
      messages: [
        { role: "user", content: "read x.txt" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_abc", name: "fs_read", argumentsJson: `{"path":"x.txt"}` }] },
        { role: "tool", toolCallId: "call_abc", name: "fs_read", content: "[fs.read ok]\nfile contents" },
      ],
    };
    for await (const _ of p.chat(req, makeCtx())) { /* drain */ }

    const msgs = postedBodies[0]!.messages as Array<Record<string, unknown>>;
    expect(msgs[1]!.tool_calls).toEqual([
      { id: "call_abc", type: "function", function: { name: "fs_read", arguments: `{"path":"x.txt"}` } },
    ]);
    expect(msgs[2]!.role).toBe("tool");
    expect(msgs[2]!.tool_call_id).toBe("call_abc");
  });

  it("adds provider.require_parameters on openrouter.ai by default", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(`data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n`, { status: 200 });
    }));
    const p = new OpenAIProvider({ apiKey: "k", baseUrl: "https://openrouter.ai/api/v1", displayName: "custom" });
    for await (const _ of p.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }, makeCtx())) { /* drain */ }
    expect(bodies[0]!.provider).toEqual({ require_parameters: true });
  });

  it("omits provider routing for non-OpenRouter hosts and honors explicit opt-out", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(`data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n`, { status: 200 });
    }));

    const plain = new OpenAIProvider({ apiKey: "k", baseUrl: "http://localhost:1234/v1", displayName: "local" });
    for await (const _ of plain.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }, makeCtx())) { /* drain */ }
    expect(bodies[0]!.provider).toBeUndefined();

    const optedOut = new OpenAIProvider({ apiKey: "k", baseUrl: "https://openrouter.ai/api/v1", displayName: "custom", requireParameters: false });
    for await (const _ of optedOut.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }, makeCtx())) { /* drain */ }
    expect(bodies[1]!.provider).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AgentOrchestrator native loop
// ---------------------------------------------------------------------------

function fakeRegistry(calls: CapabilityInput[]): CapabilityRegistry {
  const r = new CapabilityRegistry();
  const exec = async (input: CapabilityInput): Promise<CapabilityResult> => {
    calls.push(input);
    if (input.params.op === "write") {
      return { type: CapabilityType.Filesystem, source: "tool.fs", ok: true, payload: { kind: "structured", data: { written: true, path: String(input.params.path), bytes: 5 } }, durationMs: 1 };
    }
    return { type: CapabilityType.Filesystem, source: "tool.fs", ok: true, payload: { kind: "file", path: String(input.params.path ?? ""), content: "hello", encoding: "utf8" }, durationMs: 1 };
  };
  r.register({ id: "tool.fs", type: CapabilityType.Filesystem, source: "tool", label: "FS", priority: 100, execute: exec, canHandle: () => true });
  return r;
}

function fakeTaskPlan(): TaskPlan {
  return { kind: "agentic", taskType: "artifact-save", chain: [CapabilityType.Filesystem], reasoning: "test", goal: "write out.txt" };
}

describe("AgentOrchestrator — native function calling", () => {
  it("executes native tool calls and feeds results back as tool-role messages", async () => {
    const seenRequests: ChatRequest[] = [];
    const provider: IProvider = {
      id: "mock",
      label: "Mock",
      capabilities: new Set([CapabilityType.Chat]),
      listModels: async () => [],
      hasModel: async () => true,
      hasCapability: () => false,
      declareCapability: async () => { throw new Error("n/a"); },
      health: async () => ({ providerId: "mock", ok: true }),
      executeCapability: async () => { throw new Error("n/a"); },
      chat: (req: ChatRequest) => {
        seenRequests.push(req);
        const turn = seenRequests.length;
        return (async function* (): AsyncIterable<ChatChunk> {
          if (turn === 1) {
            yield {
              done: true,
              finishReason: "tool_call",
              toolCalls: [{ id: "call_1", name: "fs_write", argumentsJson: JSON.stringify({ path: "out.txt", content: "hello" }) }],
            };
          } else {
            yield { delta: "Wrote out.txt for you." };
            yield { done: true, finishReason: "stop" };
          }
        })();
      },
    };

    const calls: CapabilityInput[] = [];
    const orch = new AgentOrchestrator();
    const events: string[] = [];
    const iter = orch.run({
      provider,
      modelId: "mock-model",
      baseMessages: [{ role: "user", content: "create out.txt with hello" }],
      userText: "create out.txt with hello",
      taskPlan: fakeTaskPlan(),
      ctx: makeCtx(),
      registry: fakeRegistry(calls),
      workspace: "C:\\ws",
      nativeTools: true,
    });
    let result;
    while (true) {
      const step = await iter.next();
      if (step.done) { result = step.value; break; }
      events.push(step.value.type);
    }

    // Native tools were attached to the request.
    expect(seenRequests[0]!.tools?.some((t) => t.name === "fs_write")).toBe(true);
    // The write executed through the registry.
    expect(calls.some((c) => c.params.op === "write" && String(c.params.path).endsWith("out.txt"))).toBe(true);
    // The second turn contains assistant tool_calls + a tool-role result.
    const turn2 = seenRequests[1]!;
    const assistant = turn2.messages.find((m) => m.role === "assistant" && m.toolCalls?.length);
    expect(assistant?.toolCalls?.[0]?.id).toBe("call_1");
    const toolMsg = turn2.messages.find((m) => m.role === "tool");
    expect(toolMsg?.toolCallId).toBe("call_1");
    expect(String(toolMsg?.content)).toContain("fs.write ok");
    // Goal completed.
    expect(result.goalCompleted).toBe(true);
    expect(events).toContain("file");
  });

  it("still honors the textual <tool_call> protocol when native tools are enabled", async () => {
    let turn = 0;
    const provider: IProvider = {
      id: "mock",
      label: "Mock",
      capabilities: new Set([CapabilityType.Chat]),
      listModels: async () => [],
      hasModel: async () => true,
      hasCapability: () => false,
      declareCapability: async () => { throw new Error("n/a"); },
      health: async () => ({ providerId: "mock", ok: true }),
      executeCapability: async () => { throw new Error("n/a"); },
      chat: () => {
        turn++;
        return (async function* (): AsyncIterable<ChatChunk> {
          if (turn === 1) {
            yield { delta: `<tool_call>{"name":"fs.write","arguments":{"path":"out.txt","content":"hello"}}</tool_call>` };
            yield { done: true, finishReason: "stop" };
          } else {
            yield { delta: "Done." };
            yield { done: true, finishReason: "stop" };
          }
        })();
      },
    };

    const calls: CapabilityInput[] = [];
    const orch = new AgentOrchestrator();
    const iter = orch.run({
      provider,
      modelId: "mock-model",
      baseMessages: [{ role: "user", content: "create out.txt" }],
      userText: "create out.txt",
      taskPlan: fakeTaskPlan(),
      ctx: makeCtx(),
      registry: fakeRegistry(calls),
      workspace: "C:\\ws",
      nativeTools: true,
    });
    let result;
    while (true) {
      const step = await iter.next();
      if (step.done) { result = step.value; break; }
    }
    expect(calls.some((c) => c.params.op === "write")).toBe(true);
    expect(result.goalCompleted).toBe(true);
  });
});
