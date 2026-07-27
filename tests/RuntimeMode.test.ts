import { describe, expect, it } from "vitest";
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

class ModeProvider implements IProvider {
  readonly id = "mode-provider";
  readonly label = "Mode Provider";
  readonly capabilities = new Set([CapabilityType.Chat]);
  requests: ChatRequest[] = [];

  async listModels(): Promise<ProviderModel[]> {
    return [{ id: "mode-model", label: "Mode", capabilities: [CapabilityType.Chat] }];
  }
  async hasModel(): Promise<boolean> { return true; }
  hasCapability(type: CapabilityType): boolean { return this.capabilities.has(type); }
  async declareCapability(modelId: string): Promise<ProviderCapabilityDeclaration> {
    return { providerId: this.id, modelId, label: "Mode", capabilities: [CapabilityType.Chat], streaming: true, toolCalling: false, multimodal: false, embeddingSupport: false, imageGeneration: false, audioSupport: false, maxContext: 8192, metadata: {}, resolvedAt: Date.now() };
  }
  async *chat(request: ChatRequest, _ctx: ExecutionContext): AsyncIterable<ChatChunk> {
    this.requests.push(request);
    yield { delta: "Here is the implementation plan. Switch to Build mode when you want me to implement it." };
    yield { done: true, finishReason: "stop" };
  }
  async executeCapability(): Promise<CapabilityResult> { throw new Error("not used"); }
  async health(): Promise<ProviderHealth> { return { providerId: this.id, ok: true }; }
}

describe("Runtime modes", () => {
  it("keeps Plan mode read-only even for an implementation request", async () => {
    const provider = new ModeProvider();
    const runtime = new Runtime({ providers: {}, workspace: { enabled: false } });
    runtime.registerProvider(provider);
    const session = runtime.createSession({ providerId: provider.id, modelId: "mode-model" });
    const events: Array<{ type: string }> = [];

    for await (const event of runtime.request({
      sessionId: session.id,
      text: "create and save index.html",
      mode: "plan",
    })) events.push(event);

    expect(events.some((event) => event.type === "tool" || event.type === "file" || event.type === "capability")).toBe(false);
    expect(events.some((event) => event.type === "task")).toBe(false);
    const systemText = provider.requests[0]!.messages
      .filter((message) => message.role === "system")
      .map((message) => String(message.content))
      .join("\n");
    expect(systemText).toContain("PLAN MODE");
    expect(systemText).toContain("Do not call tools");
  });
});
