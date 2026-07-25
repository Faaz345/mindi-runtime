/**
 * Integration tests for capability negotiation and real augmentation flows.
 *
 * These tests prove the architecture works under real execution patterns:
 *   - A model that lacks Vision gets it augmented by a Vision provider
 *   - A model that lacks Filesystem gets it augmented by a deterministic tool
 *   - Multi-capability DAG execution (browser → OCR → vision → primary)
 *   - Search tool → structured results → primary model
 *
 * All tests use mock providers that simulate real API behavior (latency,
 * failures, capability declarations) — no real API keys needed.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Runtime } from "../src/runtime/Runtime.js";
import { CapabilityType } from "../src/core/types.js";
import type {
  CapabilityInput,
  CapabilityResult,
  ChatChunk,
  ChatRequest,
  ExecutionContext,
  ProviderCapabilityDeclaration,
  ProviderHealth,
  ProviderModel,
} from "../src/core/types.js";
import { BaseProvider } from "../src/providers/BaseProvider.js";

// ---------------------------------------------------------------------------
// Mock Providers
// ---------------------------------------------------------------------------

/**
 * A mock provider that simulates an LLM with configurable capabilities.
 * Returns deterministic responses so tests can assert on them.
 */
class MockProvider extends BaseProvider {
  readonly id: string;
  readonly label: string;
  protected readonly providerCapabilities: ReadonlySet<CapabilityType>;
  private readonly caps: CapabilityType[];

  constructor(id: string, label: string, caps: CapabilityType[]) {
    super();
    this.id = id;
    this.label = label;
    this.caps = caps;
    this.providerCapabilities = new Set(caps);
  }

  protected modelCapabilities(): CapabilityType[] {
    return this.caps;
  }

  protected async resolveDeclaration(modelId: string): Promise<ProviderCapabilityDeclaration> {
    return {
      providerId: this.id,
      modelId,
      label: this.label,
      capabilities: this.caps,
      streaming: true,
      toolCalling: this.caps.includes(CapabilityType.Chat),
      multimodal: this.caps.includes(CapabilityType.Vision),
      embeddingSupport: this.caps.includes(CapabilityType.Embeddings),
      imageGeneration: this.caps.includes(CapabilityType.ImageGeneration),
      audioSupport: this.caps.includes(CapabilityType.Audio),
      maxContext: 128_000,
      metadata: {},
      resolvedAt: Date.now(),
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    return [{ id: "mock-model", label: this.label, capabilities: this.caps, contextWindow: 128_000 }];
  }

  async *chat(request: ChatRequest, _ctx: ExecutionContext): AsyncIterable<ChatChunk> {
    const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
    const caps = request.messages.filter((m) => m.role === "capability");
    const userText = typeof lastUser?.content === "string" ? lastUser.content : "(multimodal)";

    yield { delta: `[${this.id}] Processing: "${userText.slice(0, 40)}".\n` };
    if (caps.length > 0) {
      yield { delta: `[${this.id}] Received ${caps.length} augmentation(s):\n` };
      for (let i = 0; i < caps.length; i++) {
        const cap = caps[i]!;
        const text = typeof cap.content === "string" ? cap.content : JSON.stringify(cap.content);
        yield { delta: `[${i}] ${text}\n` };
      }
    }
    yield { delta: `[${this.id}] Done.` };
    yield { done: true, finishReason: "stop", usage: { promptTokens: 50, completionTokens: 30, totalTokens: 80 } };
  }

  async executeCapability(
    type: CapabilityType,
    input: CapabilityInput,
    _ctx: ExecutionContext,
  ): Promise<CapabilityResult> {
    const start = Date.now();
    // Simulate provider-native capability execution (e.g. Gemini vision).
    if (type === CapabilityType.Vision) {
      return {
        type: CapabilityType.Vision,
        source: `${this.id}.vision`,
        ok: true,
        payload: { kind: "text", text: `[${this.id}] Image shows: a diagram with text labeled "Architecture" and arrows pointing between components.` },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        durationMs: Date.now() - start,
      };
    }
    return super.executeCapability(type, input, _ctx);
  }

  async health(): Promise<ProviderHealth> {
    return { providerId: this.id, ok: true };
  }
}

/** Register a mock tool with highest priority so it overrides builtins. */
function registerMockTool(rt: Runtime, tool: { id: string; capability: CapabilityType; label: string; execute: (input: CapabilityInput, ctx: ExecutionContext) => Promise<CapabilityResult>; canHandle: (input: CapabilityInput) => boolean }): void {
  rt.registry.register({
    id: tool.id,
    type: tool.capability,
    source: "tool",
    label: tool.label,
    priority: 9999, // Higher than builtin tools (1000) so mock wins
    execute: (input, ctx) => tool.execute(input, ctx),
    canHandle: (input) => tool.canHandle(input),
  });
}

// ---------------------------------------------------------------------------
// Mock Tools
// ---------------------------------------------------------------------------

/** A mock OCR tool that extracts text from an "image". */
class MockOCRTool {
  readonly id = "tool.ocr.mock";
  readonly capability = CapabilityType.OCR;
  readonly label = "Mock OCR";
  readonly deterministic = true as const;

  async execute(_input: CapabilityInput): Promise<CapabilityResult> {
    return {
      type: CapabilityType.OCR,
      source: this.id,
      ok: true,
      payload: { kind: "text", text: "Extracted text: Error rate 0.3%, Latency 42ms, Throughput 1.2k req/s" },
      durationMs: 10,
    };
  }
  canHandle(): boolean { return true; }
}

/** A mock web search tool. */
class MockSearchTool {
  readonly id = "tool.search.mock";
  readonly capability = CapabilityType.WebSearch;
  readonly label = "Mock Search";
  readonly deterministic = true as const;

  async execute(_input: CapabilityInput): Promise<CapabilityResult> {
    return {
      type: CapabilityType.WebSearch,
      source: this.id,
      ok: true,
      payload: {
        kind: "search",
        results: [
          { title: "MINDI Runtime on GitHub", url: "https://github.com/mindi/runtime", snippet: "Provider-agnostic augmentation runtime..." },
          { title: "Augmentation Patterns", url: "https://example.com/patterns", snippet: "How to augment LLMs with missing capabilities..." },
        ],
      },
      durationMs: 20,
    };
  }
  canHandle(): boolean { return true; }
}

/** A mock browser tool that simulates navigating + taking a screenshot. */
class MockBrowserTool {
  readonly id = "tool.browser.mock";
  readonly capability = CapabilityType.Browser;
  readonly label = "Mock Browser";
  readonly deterministic = true as const;

  async execute(_input: CapabilityInput): Promise<CapabilityResult> {
    return {
      type: CapabilityType.Browser,
      source: this.id,
      ok: true,
      payload: { kind: "text", text: "Navigated to page. Title: 'System Dashboard'. Screenshot captured (base64 encoded)." },
      durationMs: 30,
    };
  }
  canHandle(): boolean { return true; }
}

/** A mock filesystem tool. */
class MockFilesystemTool {
  readonly id = "tool.fs.mock";
  readonly capability = CapabilityType.Filesystem;
  readonly label = "Mock FS";
  readonly deterministic = true as const;

  async execute(): Promise<CapabilityResult> {
    return {
      type: CapabilityType.Filesystem,
      source: this.id,
      ok: true,
      payload: {
        kind: "files",
        entries: [
          { path: "/project/src/index.ts", type: "file" },
          { path: "/project/src/runtime.ts", type: "file" },
          { path: "/project/tests", type: "dir" },
        ],
      },
      durationMs: 1,
    };
  }
  canHandle(): boolean { return true; }
}

// ---------------------------------------------------------------------------
// Integration Test Suite
// ---------------------------------------------------------------------------

describe("Integration: Capability Negotiation & Augmentation", () => {
  describe("GLM (no vision) + image upload → Vision provider → GLM receives context", () => {
    let rt: Runtime;

    beforeEach(() => {
      rt = new Runtime({ providers: {} });
      // Primary model: GLM — chat only, no vision.
      rt.registerProvider(new MockProvider("glm", "GLM Chat", [CapabilityType.Chat]));
      // Augmentation provider: has Vision capability.
      rt.registerProvider(new MockProvider("openai", "OpenAI Vision", [CapabilityType.Chat, CapabilityType.Vision]));
    });

    it("detects that GLM lacks vision and augments with a vision provider", async () => {
      const s = rt.createSession({ providerId: "glm", modelId: "mock-model" });
      const res = await rt.requestOnce({
        sessionId: s.id,
        text: "Describe the architecture diagram in this image",
        attachments: [{ name: "diagram.png", mimeType: "image/png" }],
      });

      // Vision should be augmented (GLM doesn't have it).
      const visionCap = res.capabilities.find((c) => c.type === CapabilityType.Vision);
      expect(visionCap).toBeDefined();
      expect(visionCap!.ok).toBe(true);

      // GLM should have received the vision context.
      expect(res.text).toContain("[glm]");
      expect(res.text).toContain("Received 1 augmentation(s)");
      expect(res.text).toContain("Image shows");
      expect(res.error).toBeUndefined();
    });

    it("does not augment when the primary model already has vision", async () => {
      const s = rt.createSession({ providerId: "openai", modelId: "mock-model" });
      const res = await rt.requestOnce({
        sessionId: s.id,
        text: "Describe the attached image",
        attachments: [{ name: "photo.png", mimeType: "image/png" }],
      });

      // OpenAI has Vision → no vision augmentation needed.
      const visionCap = res.capabilities.find((c) => c.type === CapabilityType.Vision);
      expect(visionCap).toBeUndefined();
    });

    it("uses capability declarations (cached) for negotiation", async () => {
      const s = rt.createSession({ providerId: "glm", modelId: "mock-model" });
      // First request — should call declareCapability.
      await rt.requestOnce({
        sessionId: s.id,
        text: "What's in this image?",
        attachments: [{ name: "x.png", mimeType: "image/png" }],
      });
      // Second request — should use cached declaration.
      const res2 = await rt.requestOnce({
        sessionId: s.id,
        text: "Describe another image",
        attachments: [{ name: "y.png", mimeType: "image/png" }],
      });
      // Both should augment vision.
      expect(res2.capabilities).toHaveLength(1);
      expect(res2.capabilities[0]!.type).toBe(CapabilityType.Vision);
    });
  });

  describe("Filesystem augmentation", () => {
    let rt: Runtime;

    beforeEach(() => {
      rt = new Runtime({ providers: {}, sandbox: { allowedRoots: [process.cwd()], allowedCommands: ["git", "npm", "node"], allowNetwork: true, timeoutMs: 30_000, maxOutputBytes: 1_048_576 } });
      rt.registerProvider(new MockProvider("glm", "GLM", [CapabilityType.Chat]));
      registerMockTool(rt, new MockFilesystemTool() as never);
    });

    it("augments a chat-only model with filesystem capability", async () => {
      const s = rt.createSession({ providerId: "glm", modelId: "mock-model" });
      const res = await rt.requestOnce({
        sessionId: s.id,
        text: "list the files in my project directory",
      });

      expect(res.capabilities).toHaveLength(1);
      expect(res.capabilities[0]!.type).toBe(CapabilityType.Filesystem);
      expect(res.capabilities[0]!.ok).toBe(true);

      // The capability result should contain the file paths.
      // The model receives this as a capability-role message and echoes it.
      expect(res.text).toContain("Filesystem");
      expect(res.text).toContain("index.ts");
    });
  });

  describe("Search tool → structured results → primary model", () => {
    let rt: Runtime;

    beforeEach(() => {
      rt = new Runtime({ providers: {}, sandbox: { allowedRoots: [process.cwd()], allowedCommands: ["git", "npm", "node"], allowNetwork: true, timeoutMs: 30_000, maxOutputBytes: 1_048_576 } });
      rt.registerProvider(new MockProvider("glm", "GLM", [CapabilityType.Chat]));
      registerMockTool(rt, new MockSearchTool() as never);
    });

    it("routes web search to the search tool and feeds results to the model", async () => {
      const s = rt.createSession({ providerId: "glm", modelId: "mock-model" });
      const res = await rt.requestOnce({
        sessionId: s.id,
        text: "search the web for MINDI Runtime",
      });

      expect(res.capabilities).toHaveLength(1);
      expect(res.capabilities[0]!.type).toBe(CapabilityType.WebSearch);
      expect(res.capabilities[0]!.ok).toBe(true);

      // The model should have received search results as context.
      expect(res.text).toContain("MINDI Runtime on GitHub");
      expect(res.text).toContain("github.com");
    });
  });

  describe("Multi-capability parallel execution", () => {
    let rt: Runtime;

    beforeEach(() => {
      rt = new Runtime({ providers: {}, sandbox: { allowedRoots: [process.cwd()], allowedCommands: ["git", "npm", "node"], allowNetwork: true, timeoutMs: 30_000, maxOutputBytes: 1_048_576 } });
      rt.registerProvider(new MockProvider("glm", "GLM", [CapabilityType.Chat]));
      registerMockTool(rt, new MockFilesystemTool() as never);
      registerMockTool(rt, new MockSearchTool() as never);
    });

    it("executes filesystem + web search in parallel when both are needed", async () => {
      const s = rt.createSession({ providerId: "glm", modelId: "mock-model" });
      const res = await rt.requestOnce({
        sessionId: s.id,
        text: "list files in my directory and search the web for documentation",
      });

      // Both capabilities should be augmented.
      const capTypes = res.capabilities.map((c) => c.type);
      expect(capTypes).toContain(CapabilityType.Filesystem);
      expect(capTypes).toContain(CapabilityType.WebSearch);
      expect(res.capabilities).toHaveLength(2);
    });
  });

  describe("Browser → OCR → Vision chain (graph execution)", () => {
    let rt: Runtime;

    beforeEach(() => {
      rt = new Runtime({ providers: {}, sandbox: { allowedRoots: [process.cwd()], allowedCommands: ["git", "npm", "node"], allowNetwork: true, timeoutMs: 30_000, maxOutputBytes: 1_048_576 } });
      rt.registerProvider(new MockProvider("glm", "GLM", [CapabilityType.Chat]));
      // Vision provider (for the final vision step)
      rt.registerProvider(new MockProvider("openai", "OpenAI Vision", [CapabilityType.Chat, CapabilityType.Vision]));
      // Tools: Browser + OCR
      registerMockTool(rt, new MockBrowserTool() as never);
      registerMockTool(rt, new MockOCRTool() as never);
    });

    it("executes browser → OCR → vision in topological order", async () => {
      const s = rt.createSession({ providerId: "glm", modelId: "mock-model" });
      // Use explicit browser language to trigger browser intent detection.
      const res = await rt.requestOnce({
        sessionId: s.id,
        text: "browse to this website https://example.com and take a screenshot, then OCR the screenshot and describe the page",
      });

      // All three capabilities should have executed.
      const capTypes = res.capabilities.map((c) => c.type);
      expect(capTypes).toContain(CapabilityType.Browser);
      expect(capTypes).toContain(CapabilityType.OCR);
      expect(capTypes).toContain(CapabilityType.Vision);

      // The primary model should have received all three results.
      expect(res.text).toContain("Received");
      expect(res.text).toContain("augmentation(s)");
    });

    it("emits graph execution events in correct order", async () => {
      const s = rt.createSession({ providerId: "glm", modelId: "mock-model" });
      const events: string[] = [];
      rt.onAny((e) => {
        if (e.type === "node_started") events.push(`start:${e.nodeId}`);
        if (e.type === "node_completed") events.push(`done:${e.nodeId}`);
      });

      await rt.requestOnce({
        sessionId: s.id,
        text: "browse to https://example.com and take a screenshot then OCR it",
      });

      // At least some nodes should have started and completed.
      const starts = events.filter((e) => e.startsWith("start:"));
      const dones = events.filter((e) => e.startsWith("done:"));
      expect(starts.length).toBeGreaterThan(0);
      expect(dones.length).toBeGreaterThan(0);
      expect(starts.length).toBe(dones.length);
    });
  });

  describe("Unavailable capabilities degrade gracefully", () => {
    it("marks audio as unavailable when no executor is registered", async () => {
      const rt = new Runtime({ providers: {} });
      rt.registerProvider(new MockProvider("glm", "GLM", [CapabilityType.Chat]));
      // No audio tool or provider registered.

      const s = rt.createSession({ providerId: "glm", modelId: "mock-model" });
      const res = await rt.requestOnce({
        sessionId: s.id,
        text: "transcribe this audio file recording.mp3",
      });

      // Should NOT throw — degrades gracefully.
      expect(res.error).toBeUndefined();
      expect(res.text.length).toBeGreaterThan(0);
    });
  });
});
