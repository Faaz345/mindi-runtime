import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AgentOrchestrator, normalizeToolCall, type AgentRunResult } from "../src/agent/AgentOrchestrator.js";
import { TaskPlanner } from "../src/planner/TaskPlanner.js";
import { Runtime } from "../src/runtime/Runtime.js";
import { CapabilityType } from "../src/core/types.js";
import type {
  CapabilityResult,
  ChatChunk,
  ChatRequest,
  ExecutionContext,
  IProvider,
  ProviderCapabilityDeclaration,
  ProviderHealth,
  ProviderModel,
} from "../src/core/types.js";
import { CapabilityRegistry } from "../src/registry/CapabilityRegistry.js";
import { ToolRuntime } from "../src/tools/ToolRuntime.js";
import type { StreamEvent } from "../src/streaming/StreamingEngine.js";

// ---------------------------------------------------------------------------
// Scripted provider — returns queued responses, one per chat() call.
// ---------------------------------------------------------------------------

class ScriptedProvider implements IProvider {
  readonly id = "scripted";
  readonly label = "Scripted";
  readonly capabilities = new Set([CapabilityType.Chat, CapabilityType.Vision]);
  readonly calls: ChatRequest[] = [];
  private queue: string[];

  constructor(responses: string[]) {
    this.queue = [...responses];
  }

  async listModels(): Promise<ProviderModel[]> {
    return [{ id: "scripted-model", label: "S", capabilities: [CapabilityType.Chat, CapabilityType.Vision] }];
  }
  async hasModel(): Promise<boolean> { return true; }
  hasCapability(t: CapabilityType): boolean { return this.capabilities.has(t); }
  async declareCapability(modelId: string): Promise<ProviderCapabilityDeclaration> {
    return { providerId: this.id, modelId, label: "S", capabilities: [CapabilityType.Chat, CapabilityType.Vision], streaming: true, toolCalling: false, multimodal: true, embeddingSupport: false, imageGeneration: false, audioSupport: false, maxContext: 8192, metadata: {}, resolvedAt: Date.now() };
  }
  async *chat(request: ChatRequest, _ctx: ExecutionContext): AsyncIterable<ChatChunk> {
    this.calls.push(request);
    const next = this.queue.length > 0 ? this.queue.shift()! : "Done. No further actions.";
    yield { delta: next };
    yield { done: true, finishReason: "stop" };
  }
  async executeCapability(): Promise<CapabilityResult> { throw new Error("not used"); }
  async health(): Promise<ProviderHealth> { return { providerId: this.id, ok: true }; }
}

function makeCtx(signal?: AbortSignal): ExecutionContext {
  const ctrl = new AbortController();
  if (signal) signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  return {
    requestId: "test-req",
    sessionId: "test-session",
    signal: ctrl.signal,
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
    events: { emit() {}, on() { return () => {} }, clear() {} },
  };
}

async function collect(iter: AsyncGenerator<StreamEvent, AgentRunResult, unknown>): Promise<{ events: StreamEvent[]; result: AgentRunResult }> {
  const events: StreamEvent[] = [];
  let result: AgentRunResult | undefined;
  while (true) {
    const step = await iter.next();
    if (step.done) { result = step.value; break; }
    events.push(step.value);
  }
  return { events, result: result! };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmpDir: string;
let registry: CapabilityRegistry;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mindi-agent-test-"));
  registry = new CapabilityRegistry();
  new ToolRuntime({
    allowedRoots: [tmpDir],
    allowedCommands: ["echo", "node", "git"],
    allowNetwork: false,
    timeoutMs: 10_000,
    maxOutputBytes: 100_000,
  }, registry).registerBuiltin();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const websitePlan = new TaskPlanner().classify({
  text: "create a standalone html website from this image",
  hasImages: true,
});

describe("AgentOrchestrator — Plan → Execute → Observe → Reflect → Continue", () => {
  it("redirects an image attachment path to a workspace artifact path", () => {
    const call = normalizeToolCall({
      name: "fs.write",
      arguments: { path: "C:\\Users\\me\\Downloads\\reference.png", content: "<!doctype html><html></html>" },
      raw: "",
    }, tmpDir);
    expect(call.arguments.path).toBe(path.join(tmpDir, "index.html"));
  });

  it("keeps absolute write paths inside the workspace", () => {
    const call = normalizeToolCall({
      name: "fs.write",
      arguments: { path: path.join(tmpDir, "nested", "site.html"), content: "<html></html>" },
      raw: "",
    }, tmpDir);
    expect(call.arguments.path).toBe(path.join(tmpDir, "nested", "site.html"));
  });

  it("creates nested folders through the filesystem agent tool", async () => {
    const target = path.join(tmpDir, "src", "components");
    const provider = new ScriptedProvider([
      `<tool_call>{"name":"fs.mkdir","arguments":{"path":"src/components"}}</tool_call>`,
      "Directory created.",
    ]);
    const plan = new TaskPlanner().classify({ text: "search latest directory patterns", hasImages: false });
    const { result } = await collect(new AgentOrchestrator().run({
      provider,
      modelId: "scripted-model",
      baseMessages: [{ role: "user", content: "create src/components" }],
      userText: "create src/components",
      taskPlan: plan,
      ctx: makeCtx(),
      registry,
      workspace: tmpDir,
    }));
    expect(result.goalCompleted).toBe(true);
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });

  it("executes tool calls end-to-end: model writes a real file, verifies, completes", async () => {
    const target = path.join(tmpDir, "index.html");
    const provider = new ScriptedProvider([
      // Iteration 1: model writes the file via tool call.
      `I'll create the website for you.\n<tool_call>{"name":"fs.write","arguments":{"path":"${target.replace(/\\/g, "\\\\")}","content":"<html><body>Hello</body></html>"}}</tool_call>`,
      // Iteration 2: model confirms with no tool calls → goal complete.
      `The website has been created and verified at index.html (29 bytes).`,
    ]);

    const orch = new AgentOrchestrator();
    const { events, result } = await collect(orch.run({
      provider,
      modelId: "scripted-model",
      baseMessages: [{ role: "user", content: "create a website" }],

      userText: "test",
      taskPlan: websitePlan,
      ctx: makeCtx(),
      registry,
      workspace: tmpDir,
    }));

    // The loop did NOT stop after the first text response — it executed the tool.
    expect(result.goalCompleted).toBe(true);
    expect(result.iterations).toBe(2);
    expect(result.toolsExecuted).toBe(1);

    // The artifact REALLY exists on disk.
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("<html><body>Hello</body></html>");

    // Lifecycle events were emitted in order.
    const types = events.map((e) => e.type);
    expect(types).toContain("task");
    expect(types).toContain("tool");
    expect(types).toContain("file");
    expect(types).toContain("reflection");
    expect(types).toContain("goal");

    const fileEv = events.find((e) => e.type === "file");
    expect(fileEv && fileEv.verified).toBe(true);

    const toolEv = events.find((e) => e.type === "tool" && e.phase === "finished") as
      | Extract<StreamEvent, { type: "tool" }>
      | undefined;
    expect(toolEv && toolEv.phase).toBe("finished");
    expect(toolEv && toolEv.ok).toBe(true);

    const goalEv = events.find((e) => e.type === "goal");
    expect(goalEv && goalEv.status).toBe("completed");
  });

  it("feeds tool results back to the model (observe → reflect)", async () => {
    const provider = new ScriptedProvider([
      `<tool_call>{"name":"fs.list","arguments":{"path":"."}}</tool_call>`,
      "Based on the listing, the project has 3 files. Done.",
    ]);
    const orch = new AgentOrchestrator();
    const { result } = await collect(orch.run({
      provider,
      modelId: "scripted-model",
      baseMessages: [{ role: "user", content: "what's here?" }],

      userText: "test",
      taskPlan: new TaskPlanner().classify({ text: "search the latest project information", hasImages: false }),
      ctx: makeCtx(),
      registry,
      workspace: tmpDir,
    }));
    expect(result.goalCompleted).toBe(true);
    // The model's second call must include a <tool_result> message.
    const secondCallMessages = provider.calls[1]!.messages;
    const toolResultMsg = secondCallMessages.find((m) => typeof m.content === "string" && m.content.includes("<tool_result"));
    expect(toolResultMsg).toBeDefined();
  });

  it("does not falsely complete an artifact task when the model requests no tools", async () => {
    const provider = new ScriptedProvider(["Just a plain answer, no tools needed."]);
    const orch = new AgentOrchestrator();
    const { result } = await collect(orch.run({
      provider,
      modelId: "scripted-model",
      baseMessages: [{ role: "user", content: "hi" }],

      userText: "test",
      taskPlan: websitePlan,
      ctx: makeCtx(),
      registry,
      workspace: tmpDir,
      maxIterations: 1,
    }));
    expect(result.iterations).toBe(1);
    expect(result.toolsExecuted).toBe(0);
    expect(result.goalCompleted).toBe(false);
  });

  it("fails fast after a model repeats narration instead of using tools", async () => {
    const provider = new ScriptedProvider([
      "I will inspect the image and create the landing page.",
      "I will now write the complete file.",
    ]);
    const { events, result } = await collect(new AgentOrchestrator().run({
      provider,
      modelId: "scripted-model",
      baseMessages: [{ role: "user", content: "create a website and save it" }],
      userText: "create a website and save it",
      taskPlan: websitePlan,
      ctx: makeCtx(),
      registry,
      workspace: tmpDir,
      maxIterations: 8,
    }));
    expect(result.goalCompleted).toBe(false);
    expect(result.iterations).toBe(2);
    expect(events.some((event) => event.type === "error" && event.code === "E_AGENT_TOOL_PROTOCOL")).toBe(true);
    expect(provider.calls[1]!.messages.some((message) => message.role === "assistant")).toBe(true);
  });

  it("executes fenced textual tool calls from tool-protocol-capable models", async () => {
    const target = path.join(tmpDir, "fenced.html");
    const provider = new ScriptedProvider([
      `\n\`\`\`tool_call\n{"name":"fs.write","arguments":{"path":"${target.replace(/\\/g, "\\\\")}","content":"<html>fenced</html>"}}\n\`\`\``,
      "Done.",
    ]);
    const { result } = await collect(new AgentOrchestrator().run({
      provider,
      modelId: "scripted-model",
      baseMessages: [{ role: "user", content: "create a site" }],
      userText: "create a site and save it",
      taskPlan: websitePlan,
      ctx: makeCtx(),
      registry,
      workspace: tmpDir,
    }));
    expect(result.goalCompleted).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("<html>fenced</html>");
  });

  it("requires read-back verification before an artifact task completes", async () => {
    const target = path.join(tmpDir, "verified.html");
    const provider = new ScriptedProvider([
      `<tool_call>{"name":"fs.write","arguments":{"path":"${target.replace(/\\/g, "\\\\")}","content":"<html>verified</html>"}}</tool_call>`,
      "The verified artifact is complete.",
    ]);
    const { events, result } = await collect(new AgentOrchestrator().run({
      provider,
      modelId: "scripted-model",
      baseMessages: [{ role: "user", content: "create a website" }],
      userText: "create a website and save it",
      taskPlan: websitePlan,
      ctx: makeCtx(),
      registry,
      workspace: tmpDir,
    }));

    expect(result.goalCompleted).toBe(true);
    expect(events.find((event) => event.type === "file")).toMatchObject({ verified: true });
  });

  it("handles unknown tools gracefully — failure fed back, model recovers", async () => {
    const provider = new ScriptedProvider([
      `<tool_call>{"name":"rm.rf","arguments":{"path":"/"}}</tool_call>`,
      "That tool doesn't exist — I'll answer directly instead.",
    ]);
    const orch = new AgentOrchestrator();
    const { events, result } = await collect(orch.run({
      provider,
      modelId: "scripted-model",
      baseMessages: [{ role: "user", content: "do something" }],

      userText: "test",
      taskPlan: new TaskPlanner().classify({ text: "search the latest information", hasImages: false }),
      ctx: makeCtx(),
      registry,
      workspace: tmpDir,
    }));
    expect(result.goalCompleted).toBe(true);
    const toolEv = events.find((e) => e.type === "tool" && e.phase === "finished") as
      | Extract<StreamEvent, { type: "tool" }>
      | undefined;
    expect(toolEv && toolEv.ok).toBe(false);
  });

  it("hard-stops at max iterations when the model never stops calling tools", async () => {
    const infinite = Array.from({ length: 20 }, () => `<tool_call>{"name":"fs.list","arguments":{"path":"."}}</tool_call>`);
    const provider = new ScriptedProvider(infinite);
    const orch = new AgentOrchestrator();
    const { result } = await collect(orch.run({
      provider,
      modelId: "scripted-model",
      baseMessages: [{ role: "user", content: "loop forever" }],

      userText: "test",
      taskPlan: websitePlan,
      ctx: makeCtx(),
      registry,
      workspace: tmpDir,
      maxIterations: 3,
    }));
    expect(result.iterations).toBe(3);
    expect(result.goalCompleted).toBe(false);
  });

  it("filters tool-call JSON out of the displayed stream", async () => {
    const provider = new ScriptedProvider([
      `Creating now.\n<tool_call>{"name":"fs.list","arguments":{"path":"."}}</tool_call>`,
      "All done.",
    ]);
    const orch = new AgentOrchestrator();
    const { events } = await collect(orch.run({
      provider,
      modelId: "scripted-model",
      baseMessages: [{ role: "user", content: "go" }],

      userText: "test",
      taskPlan: websitePlan,
      ctx: makeCtx(),
      registry,
      workspace: tmpDir,
    }));
    const deltas = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
    expect(deltas).toContain("Creating now.");
    expect(deltas).not.toContain("tool_call");
    expect(deltas).not.toContain("fs.list");
  });
});

// ---------------------------------------------------------------------------
// End-to-end via the Runtime: recreate a website from an image (agentic)
// ---------------------------------------------------------------------------

describe("Runtime — agentic task end-to-end (website from image)", () => {
  it("planner classifies as agentic; orchestrator writes + verifies the artifact", async () => {
    const target = path.join(tmpDir, "site.html");
    const provider = new ScriptedProvider([
      `Analyzing the image layout.\n<tool_call>{"name":"fs.write","arguments":{"path":"${target.replace(/\\/g, "\\\\")}","content":"<!DOCTYPE html><title>Dashboard</title>"}}</tool_call>`,
      "Done — site.html written and verified (45 bytes).",
    ]);

    const rt = new Runtime({ providers: {}, sandbox: { allowedRoots: [tmpDir], allowedCommands: ["node"], allowNetwork: false } });
    rt.registerProvider(provider);
    const s = rt.createSession({ providerId: "scripted", modelId: "scripted-model" });

    // A quoted image path forces the vision-native embed path → hasImages=true.
    const imgPath = path.join(tmpDir, "ref.png");
    fs.writeFileSync(imgPath, Buffer.from("89504e470d0a1a0a", "hex"));

    const events: StreamEvent[] = [];
    for await (const ev of rt.request({ sessionId: s.id, text: `"${imgPath}" recreate this dashboard as a standalone html website and save it` })) {
      events.push(ev);
    }

    // TaskPlanner classified it as an agentic task (not "all native").
    const taskEv = events.find((e) => e.type === "task");
    expect(taskEv).toBeDefined();
    expect(taskEv && ["recreate-from-image", "artifact-save", "code-modification", "scaffold"]).toContain(taskEv.taskType);

    // The orchestrator wrote the file via fs.write.
    expect(fs.existsSync(target)).toBe(true);

    // Verification + goal events flowed through the stream.
    const fileEv = events.find((e) => e.type === "file");
    expect(fileEv && fileEv.verified).toBe(true);
    const goalEv = events.find((e) => e.type === "goal");
    expect(goalEv && goalEv.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Artifact rescue — weak model dumps code without calling fs.write
// ---------------------------------------------------------------------------

describe("AgentOrchestrator — artifact rescue (weak model safety net)", () => {
  const bigHtml = "```html\n" + Array.from({ length: 40 }, (_, i) => `<div class="row">${i}</div>`).join("\n") + "\n```";

  it("rescues a dumped code block into a real file when the model never calls fs.write", async () => {
    const provider = new ScriptedProvider([
      // Weak model behavior: dump code in chat, no tool calls, declare done.
      `Here is your website:\n${bigHtml}\nSave it as index.html and enjoy!`,
    ]);
    const orch = new AgentOrchestrator();
    const { events, result } = await collect(orch.run({
      provider,
      modelId: "scripted-model",
      baseMessages: [{ role: "user", content: "create an html website" }],
      userText: "create an html website",
      taskPlan: new TaskPlanner().classify({ text: "create an html website and save it", hasImages: false }),
      ctx: makeCtx(),
      registry,
      workspace: tmpDir,
    }));

    expect(result.goalCompleted).toBe(true);

    // The runtime wrote the file itself.
    const target = path.join(tmpDir, "index.html");
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toContain('<div class="row">0</div>');
    expect(fs.readFileSync(target, "utf8")).toContain('<div class="row">39</div>');

    // Events show the rescue: file verified + goal completed.
    const fileEv = events.find((e) => e.type === "file");
    expect(fileEv).toBeDefined();
    expect(fileEv && fileEv.verified).toBe(true);
    const goalEv = events.find((e) => e.type === "goal");
    expect(goalEv && goalEv.status).toBe("completed");
    // The user sees the rescue summary in the stream.
    const deltas = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
    expect(deltas).toContain("Artifact");
    expect(deltas).toContain("index.html");
  });

  it("rescues an unfenced complete HTML document", async () => {
    const html = "<!DOCTYPE html>\n<html>\n<head><title>Recovered</title></head>\n<body>complete</body>\n</html>";
    const provider = new ScriptedProvider([`Here is the complete page:\n${html}`]);
    const { result } = await collect(new AgentOrchestrator().run({
      provider,
      modelId: "scripted-model",
      baseMessages: [{ role: "user", content: "create a website" }],
      userText: "create a website and save it",
      taskPlan: websitePlan,
      ctx: makeCtx(),
      registry,
      workspace: tmpDir,
    }));
    expect(result.goalCompleted).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "index.html"), "utf8")).toBe(html);
  });

  it("honors the user's requested path for rescued artifacts", async () => {
    const requested = path.join(tmpDir, "my-site.html");
    const provider = new ScriptedProvider([`Here's the site:\n${bigHtml}`]);
    const orch = new AgentOrchestrator();
    await collect(orch.run({
      provider,
      modelId: "scripted-model",
      baseMessages: [{ role: "user", content: "make a site" }],
      userText: `make a site and save it to "${requested}"`,
      taskPlan: new TaskPlanner().classify({ text: "create website save file", hasImages: false }),
      ctx: makeCtx(),
      registry,
      workspace: tmpDir,
    }));
    expect(fs.existsSync(requested)).toBe(true);
  });

  it("does NOT double-write when the model wrote the artifact itself", async () => {
    const target = path.join(tmpDir, "model-wrote.html");
    const provider = new ScriptedProvider([
      `<tool_call>{"name":"fs.write","arguments":{"path":"${target.replace(/\\/g, "\\\\")}","content":"<html>by model</html>"}}</tool_call>`,
      `Done — and here's a snippet:\n${bigHtml}`,
    ]);
    const orch = new AgentOrchestrator();
    const { events } = await collect(orch.run({
      provider,
      modelId: "scripted-model",
      baseMessages: [{ role: "user", content: "create a site" }],
      userText: "create a site",
      taskPlan: new TaskPlanner().classify({ text: "create website save", hasImages: false }),
      ctx: makeCtx(),
      registry,
      workspace: tmpDir,
    }));
    // Model wrote it.
    expect(fs.readFileSync(target, "utf8")).toBe("<html>by model</html>");
    // Rescue must NOT have overwritten it or created index.html.
    expect(fs.readFileSync(target, "utf8")).not.toContain('class="row"');
    expect(fs.existsSync(path.join(tmpDir, "index.html"))).toBe(false);
    const fileEvents = events.filter((e) => e.type === "file");
    expect(fileEvents).toHaveLength(1); // only the model's own write
  });

  it("does not rescue on non-artifact tasks", async () => {
    const provider = new ScriptedProvider([
      `Here's some example code:\n${bigHtml}`,
    ]);
    const orch = new AgentOrchestrator();
    await collect(orch.run({
      provider,
      modelId: "scripted-model",
      baseMessages: [{ role: "user", content: "search the latest news" }],
      userText: "search the latest news",
      taskPlan: new TaskPlanner().classify({ text: "search the latest news", hasImages: false }),
      ctx: makeCtx(),
      registry,
      workspace: tmpDir,
    }));
    expect(fs.existsSync(path.join(tmpDir, "index.html"))).toBe(false);
  });
});
