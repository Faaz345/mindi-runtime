import { describe, it, expect, beforeEach } from "vitest";
import { Runtime } from "../src/runtime/Runtime.js";
import { CapabilityType } from "../src/core/types.js";
import type {
  CapabilityInput,
  CapabilityResult,
  ChatChunk,
  ChatRequest,
  ExecutionContext,
  IProvider,
  ProviderCapabilityDeclaration,
  ProviderHealth,
  ProviderModel,
} from "../src/core/types.js";
import { BaseProvider } from "../src/providers/BaseProvider.js";

/**
 * A fake provider that ONLY supports chat — no vision, no filesystem, nothing.
 * This is the "model the user chose that lacks capabilities" scenario.
 *
 * It returns a deterministic canned response so tests can assert on it.
 */
class ChatOnlyProvider extends BaseProvider {
  readonly id = "fake";
  readonly label = "Fake";
  protected readonly providerCapabilities: ReadonlySet<CapabilityType> = new Set([CapabilityType.Chat]);

  protected modelCapabilities(): CapabilityType[] {
    return [CapabilityType.Chat];
  }

  protected async resolveDeclaration(modelId: string): Promise<ProviderCapabilityDeclaration> {
    return {
      providerId: this.id,
      modelId,
      label: "Fake Model",
      capabilities: [CapabilityType.Chat],
      streaming: true,
      toolCalling: false,
      multimodal: false,
      embeddingSupport: false,
      imageGeneration: false,
      audioSupport: false,
      maxContext: 8192,
      metadata: {},
      resolvedAt: Date.now(),
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    return [{ id: "fake-model", label: "Fake Model", capabilities: [CapabilityType.Chat] }];
  }

  async *chat(request: ChatRequest, _ctx: ExecutionContext): AsyncIterable<ChatChunk> {
    // Echo the last user message so tests can verify augmentation context landed.
    const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
    const caps = request.messages.filter((m) => m.role === "capability");
    const summary = caps.map((c) => typeof c.content === "string" ? c.content.slice(0, 30) : "").join("|");
    yield { delta: `ack: ${typeof lastUser?.content === "string" ? lastUser.content.slice(0, 20) : ""}` };
    if (caps.length > 0) {
      yield { delta: ` | ctx:${caps.length}:${summary}` };
    }
    yield { done: true, finishReason: "stop", usage: { totalTokens: 10 } };
  }

  async health(): Promise<ProviderHealth> {
    return { providerId: this.id, ok: true };
  }
}

/** A fake filesystem tool that returns a canned directory listing. */
class FakeFilesystemTool {
  readonly id = "tool.fs.fake";
  readonly capability: CapabilityType = CapabilityType.Filesystem;
  readonly label = "Fake FS";
  readonly deterministic = true as const;

  async execute(input: CapabilityInput): Promise<CapabilityResult> {
    return {
      type: CapabilityType.Filesystem,
      source: this.id,
      ok: true,
      payload: {
        kind: "files",
        entries: [
          { path: "/repo/package.json", type: "file" },
          { path: "/repo/src", type: "dir" },
        ],
      },
      durationMs: 1,
    };
  }
  canHandle(input: CapabilityInput): boolean {
    return input.type === CapabilityType.Filesystem;
  }
}

describe("Runtime end-to-end", () => {
  let rt: Runtime;

  beforeEach(() => {
    rt = new Runtime({ providers: {}, sandbox: { allowedRoots: [process.cwd()], allowedCommands: ["git", "node", "npm", "npx", "tsx"] } });
    rt.registerProvider(new ChatOnlyProvider());
    rt.registerTool(new FakeFilesystemTool() as never);
  });

  it("creates a session against the fake provider", () => {
    const s = rt.createSession({ providerId: "fake", modelId: "fake-model" });
    expect(s.id.length).toBeGreaterThan(0);
    expect(s.providerId).toBe("fake");
  });

  it("augments a chat-only model with filesystem capability", async () => {
    const s = rt.createSession({ providerId: "fake", modelId: "fake-model" });
    const res = await rt.requestOnce({
      sessionId: s.id,
      text: "list the files in the current directory",
    });

    // The filesystem capability should have been augmented.
    const fsCap = res.capabilities.find((c) => c.type === CapabilityType.Filesystem);
    expect(fsCap).toBeDefined();
    expect(fsCap!.ok).toBe(true);

    // The primary model should have received the context and responded.
    expect(res.text).toContain("ack: list the files in t");
    expect(res.text).toContain("ctx:");

    // No error.
    expect(res.error).toBeUndefined();
  });

  it("does not augment when the primary model already has the capability", async () => {
    // Register a second provider that has BOTH chat AND filesystem.
    class ChatWithFsProvider extends ChatOnlyProvider {
      readonly id = "fake-full";
      protected readonly providerCapabilities = new Set([CapabilityType.Chat, CapabilityType.Filesystem]);
      protected modelCapabilities() {
        return [CapabilityType.Chat, CapabilityType.Filesystem];
      }
      protected async resolveDeclaration(modelId: string): Promise<ProviderCapabilityDeclaration> {
        return {
          providerId: this.id,
          modelId,
          label: "Fake Full",
          capabilities: [CapabilityType.Chat, CapabilityType.Filesystem],
          streaming: true,
          toolCalling: false,
          multimodal: false,
          embeddingSupport: false,
          imageGeneration: false,
          audioSupport: false,
          maxContext: 8192,
          metadata: {},
          resolvedAt: Date.now(),
        };
      }
    }
    const rt2 = new Runtime({ providers: {} });
    rt2.registerProvider(new ChatWithFsProvider());

    const s = rt2.createSession({ providerId: "fake-full", modelId: "fake-model" });
    const res = await rt2.requestOnce({
      sessionId: s.id,
      text: "list the files in the directory",
    });

    // Filesystem is satisfied by the primary model — no augmentation.
    expect(res.capabilities).toHaveLength(0);
  });

  it("streams delta events to the client", async () => {
    const s = rt.createSession({ providerId: "fake", modelId: "fake-model" });
    const events = [];
    for await (const e of rt.request({ sessionId: s.id, text: "say hi" })) {
      events.push(e);
    }
    const types = events.map((e) => e.type);
    expect(types).toContain("intent");
    expect(types).toContain("plan");
    expect(types).toContain("delta");
    expect(types).toContain("done");
  });

  it("emits runtime events on the bus", async () => {
    const seen: string[] = [];
    rt.onAny((e) => seen.push(e.type));
    const s = rt.createSession({ providerId: "fake", modelId: "fake-model" });
    await rt.requestOnce({ sessionId: s.id, text: "hello" });

    expect(seen).toContain("request:start");
    expect(seen).toContain("intent:analyzed");
    expect(seen).toContain("planner:plan");
    expect(seen).toContain("context:assembled");
    expect(seen).toContain("provider:stream");
    expect(seen).toContain("request:end");
  });

  it("preserves conversation continuity across turns", async () => {
    const s = rt.createSession({ providerId: "fake", modelId: "fake-model" });
    await rt.requestOnce({ sessionId: s.id, text: "first message" });
    await rt.requestOnce({ sessionId: s.id, text: "second message" });
    const history = await rt.sessions.recall(s.id);
    // Two user + two assistant messages minimum.
    const userMsgs = history.filter((m) => m.role === "user");
    const assistantMsgs = history.filter((m) => m.role === "assistant");
    expect(userMsgs.length).toBe(2);
    expect(assistantMsgs.length).toBe(2);
  });

  it("throws when sessionId is missing", async () => {
    await expect(
      rt.requestOnce({ sessionId: "", text: "x" } as never),
    ).rejects.toThrow();
  });

  it("throws when primary provider is not registered", async () => {
    const s = rt.createSession({ providerId: "fake", modelId: "fake-model" });
    rt.sessions.setModel(s.id, "nonexistent", "no-model");
    await expect(
      rt.requestOnce({ sessionId: s.id, text: "hello" }),
    ).rejects.toThrow();
  });

  it("degrades gracefully when capability has no executor", async () => {
    // Request audio (no audio executor registered).
    const s = rt.createSession({ providerId: "fake", modelId: "fake-model" });
    const res = await rt.requestOnce({
      sessionId: s.id,
      text: "transcribe this audio file recording.mp3",
    });
    // The runtime should NOT throw — it should mark audio as unavailable and
    // still stream the primary model's response.
    expect(res.error).toBeUndefined();
    expect(res.text.length).toBeGreaterThan(0);
  });
});
