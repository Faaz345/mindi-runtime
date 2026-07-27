import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAIProvider } from "../src/providers/openai/OpenAIProvider.js";
import type { CapabilityInput, ExecutionContext } from "../src/core/types.js";

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

function visionInput(model?: string): CapabilityInput {
  return {
    type: "vision",
    params: { prompt: "describe", image: "data:image/png;base64,AAAA", ...(model ? { model } : {}) },
    requestId: "t",
    sessionId: "s",
  };
}

/** OpenRouter-style /models payload with mixed vision/non-vision models. */
const MODELS_PAYLOAD = {
  data: [
    { id: "google/gemma-4-31b-it", architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
    { id: "anthropic/claude-opus-5", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
    { id: "nvidia/nemotron-nano-12b-v2-vl:free", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAIProvider.vision — model resolution", () => {
  it("never sends the provider displayName as the model id; resolves a vision model (prefers :free)", async () => {
    const postedBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify(MODELS_PAYLOAD), { status: 200 });
      }
      if (url.endsWith("/chat/completions")) {
        postedBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ choices: [{ message: { content: "a cat" } }] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));

    const p = new OpenAIProvider({ apiKey: "k", baseUrl: "http://x/v1", displayName: "custom" });
    const result = await p.executeCapability("vision", visionInput(), makeCtx());

    expect(result.ok).toBe(true);
    expect(postedBodies).toHaveLength(1);
    // Must be a real model id, never "custom".
    expect(postedBodies[0]!.model).not.toBe("custom");
    // Prefers the :free vision variant over paid ones.
    expect(postedBodies[0]!.model).toBe("nvidia/nemotron-nano-12b-v2-vl:free");
  });

  it("uses params.model when a real model id is provided", async () => {
    const postedBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify(MODELS_PAYLOAD), { status: 200 });
      }
      postedBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }));

    const p = new OpenAIProvider({ apiKey: "k", baseUrl: "http://x/v1", displayName: "custom" });
    await p.executeCapability("vision", visionInput("anthropic/claude-opus-5"), makeCtx());
    expect(postedBodies[0]!.model).toBe("anthropic/claude-opus-5");
  });

  it("returns a structured failure when no vision-capable model exists", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "text-only-model" }] }), { status: 200 });
      }
      return new Response("should not be called", { status: 500 });
    }));

    const p = new OpenAIProvider({ apiKey: "k", baseUrl: "http://x/v1", displayName: "custom" });
    const result = await p.executeCapability("vision", visionInput(), makeCtx());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No vision-capable model");
  });
});
