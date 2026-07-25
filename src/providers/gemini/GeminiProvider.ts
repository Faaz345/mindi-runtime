import type {
  CapabilityInput,
  CapabilityResult,
  CapabilityType,
  ChatChunk,
  ChatContent,
  ChatRequest,
  ExecutionContext,
  ProviderCapabilityDeclaration,
  ProviderHealth,
  ProviderModel,
} from "../../core/types.js";
import { CapabilityType as Cap } from "../../core/types.js";
import { ProviderError } from "../../core/errors.js";
import { BaseProvider } from "../BaseProvider.js";

/**
 * Google Gemini provider.
 *
 * Gemini uses a different wire format from OpenAI:
 *   - Endpoint: /v1beta/models/{model}:generateContent (or :streamGenerateContent)
 *   - Roles: "user" / "model" (not "assistant")
 *   - Multimodal: parts[] with text / inlineData / fileData
 *   - Embeddings: /v1beta/models/{model}:embedContent
 *
 * This adapter proves the runtime can absorb provider differences: the
 * CapabilityRouter and ContextBuilder only see normalized CapabilityResult,
 * never Gemini-specific shapes.
 *
 * Declared native capabilities:
 *   - chat        (generateContent)
 *   - vision      (all Gemini 1.5+ models accept inline image parts)
 *   - embeddings  (text-embedding-004 etc.)
 */
export interface GeminiProviderOptions {
  apiKey: string;
  /** Override capability table for non-standard models */
  models?: Record<string, { capabilities: CapabilityType[]; contextWindow?: number }>;
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

export class GeminiProvider extends BaseProvider {
  readonly id = "gemini";
  readonly label = "Google Gemini";
  protected readonly providerCapabilities: ReadonlySet<CapabilityType> = new Set([
    Cap.Chat,
    Cap.Vision,
    Cap.Embeddings,
  ]);

  private readonly opts: Required<GeminiProviderOptions>;

  constructor(opts: GeminiProviderOptions) {
    super();
    this.opts = { models: {}, ...opts };
  }

  protected modelCapabilities(modelId: string): CapabilityType[] {
    const override = this.opts.models?.[modelId];
    if (override) return override.capabilities;
    const caps: CapabilityType[] = [Cap.Chat];
    // All Gemini 1.5+ models are multimodal
    if (modelId.includes("1.5") || modelId.includes("2.0") || modelId.includes("2.5") || modelId.includes("gemini-")) {
      caps.push(Cap.Vision);
    }
    if (modelId.includes("embedding")) caps.push(Cap.Embeddings);
    return caps;
  }

  /**
   * Real capability discovery for Gemini models.
   * Calls /models/{model} to get supportedGenerationMethods + token limits.
   */
  protected async resolveDeclaration(modelId: string): Promise<ProviderCapabilityDeclaration> {
    const cleanId = modelId.replace(/^models\//, "");
    const caps = this.modelCapabilities(cleanId);
    const isEmbedding = caps.includes(Cap.Embeddings);
    const isMultimodal = caps.includes(Cap.Vision);
    const isFlash = cleanId.includes("flash");
    const isPro = cleanId.includes("pro");

    let maxContext = 32_000;
    let label = cleanId;
    let supportedMethods: string[] = [];

    try {
      const ctx = makeSyntheticContext();
      const url = `${GEMINI_BASE}/models/${cleanId}?key=${encodeURIComponent(this.opts.apiKey)}`;
      const res = await this.http(url, { method: "GET" }, ctx);
      const data = (await res.json()) as {
        name: string;
        displayName?: string;
        supportedGenerationMethods?: string[];
        inputTokenLimit?: number;
        outputTokenLimit?: number;
      };
      label = data.displayName ?? cleanId;
      supportedMethods = data.supportedGenerationMethods ?? [];
      if (data.inputTokenLimit) maxContext = data.inputTokenLimit;
    } catch {
      // Fallback: infer from model id.
      maxContext = inferGeminiContextWindow(cleanId);
    }

    return {
      providerId: this.id,
      modelId: cleanId,
      label,
      capabilities: caps,
      streaming: supportedMethods.includes("streamGenerateContent") || true,
      toolCalling: supportedMethods.includes("generateContent") && !isEmbedding,
      multimodal: isMultimodal,
      embeddingSupport: isEmbedding,
      imageGeneration: false, // Gemini doesn't expose image generation via this API
      audioSupport: cleanId.includes("audio") || supportedMethods.includes("generateContent") && isPro,
      maxContext,
      maxOutputTokens: supportedMethods.length > 0 ? 8192 : undefined,
      metadata: {
        family: isFlash ? "gemini-flash" : isPro ? "gemini-pro" : "gemini",
        supportedMethods,
      },
      resolvedAt: Date.now(),
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    const ctx = makeSyntheticContext();
    const url = `${GEMINI_BASE}/models?key=${encodeURIComponent(this.opts.apiKey)}`;
    const res = await this.http(url, { method: "GET" }, ctx);
    const data = (await res.json()) as {
      models: Array<{
        name: string;
        displayName?: string;
        supportedGenerationMethods?: string[];
        inputTokenLimit?: number;
      }>;
    };
    return data.models
      .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent") || (m.supportedGenerationMethods ?? []).includes("embedContent"))
      .map((m) => {
        const id = m.name.replace(/^models\//, "");
        return {
          id,
          label: m.displayName ?? id,
          capabilities: this.modelCapabilities(id),
          contextWindow: m.inputTokenLimit,
        };
      });
  }

  async *chat(request: ChatRequest, ctx: ExecutionContext): AsyncIterable<ChatChunk> {
    const model = request.model.replace(/^models\//, "");
    const url = `${GEMINI_BASE}/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.opts.apiKey)}`;
    const body = {
      contents: request.messages
        .filter((m) => m.role !== "system")
        .map(toGeminiContent),
      systemInstruction: extractSystem(request.messages),
      generationConfig: {
        temperature: request.temperature ?? 0.7,
        maxOutputTokens: request.maxTokens,
        stopSequences: request.stop,
      },
    };
    const res = await this.http(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      ctx,
    );
    if (!res.body) {
      throw new ProviderError("E_PROVIDER_ERROR", `Gemini: empty response body`, { providerId: this.id });
    }
    yield* parseGeminiSSE(res.body, ctx);
  }

  async executeCapability(
    type: CapabilityType,
    input: CapabilityInput,
    ctx: ExecutionContext,
  ): Promise<CapabilityResult> {
    const start = Date.now();
    switch (type) {
      case Cap.Embeddings:
        return this.embeddings(input, ctx, start);
      case Cap.Vision:
        return this.vision(input, ctx, start);
      default:
        return super.executeCapability(type, input, ctx);
    }
  }

  private async embeddings(
    input: CapabilityInput,
    ctx: ExecutionContext,
    start: number,
  ): Promise<CapabilityResult> {
    const text = String(input.params.text ?? "");
    const model = String(input.params.model ?? "text-embedding-004").replace(/^models\//, "");
    const url = `${GEMINI_BASE}/models/${model}:embedContent?key=${encodeURIComponent(this.opts.apiKey)}`;
    const res = await this.http(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `models/${model}`,
          content: { parts: [{ text }] },
        }),
      },
      ctx,
    );
    const data = (await res.json()) as { embedding?: { values?: number[] } };
    return {
      type: Cap.Embeddings,
      source: this.id,
      ok: true,
      payload: { kind: "embedding", vector: data.embedding?.values ?? [], model },
      durationMs: Date.now() - start,
    };
  }

  /** Gemini's chat endpoint already accepts images inline, so vision reuses it. */
  private async vision(
    input: CapabilityInput,
    ctx: ExecutionContext,
    start: number,
  ): Promise<CapabilityResult> {
    const prompt = String(input.params.prompt ?? "Describe this image.");
    const image = String(input.params.image ?? "");
    const model = String(input.params.model ?? "gemini-1.5-flash").replace(/^models\//, "");
    const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${encodeURIComponent(this.opts.apiKey)}`;

    // Accept either a data URI or raw base64
    let inlineData: { mimeType: string; data: string };
    if (image.startsWith("data:")) {
      const m = image.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) throw new ProviderError("E_PROVIDER_ERROR", "Gemini: invalid data URI", { providerId: this.id });
      inlineData = { mimeType: m[1]!, data: m[2]! };
    } else {
      inlineData = { mimeType: String(input.params.mimeType ?? "image/png"), data: image };
    }

    const res = await this.http(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, { inlineData }] }],
        }),
      },
      ctx,
    );
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
    };
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    return {
      type: Cap.Vision,
      source: this.id,
      ok: true,
      payload: { kind: "text", text },
      usage: {
        promptTokens: data.usageMetadata?.promptTokenCount,
        completionTokens: data.usageMetadata?.candidatesTokenCount,
        totalTokens: data.usageMetadata?.totalTokenCount,
      },
      durationMs: Date.now() - start,
    };
  }

  async health(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      const ctx = makeSyntheticContext();
      const url = `${GEMINI_BASE}/models?key=${encodeURIComponent(this.opts.apiKey)}&pageSize=1`;
      const res = await this.http(url, { method: "GET" }, ctx);
      return { providerId: this.id, ok: res.ok, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        providerId: this.id,
        ok: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/** Convert normalized ChatMessage to Gemini's `contents[]` format. */
function toGeminiContent(m: ChatRequest["messages"][number]): Record<string, unknown> {
  const role = m.role === "assistant" ? "model" : "user";
  return {
    role,
    parts: partsFromContent(m.content),
  };
}

function partsFromContent(content: ChatContent): unknown[] {
  if (typeof content === "string") return [{ text: content }];
  return content.map((part) => {
    switch (part.type) {
      case "text":
        return { text: part.text };
      case "image":
        return { inlineData: { mimeType: part.mimeType, data: part.base64 } };
      case "image_url":
        return { fileData: { fileUri: part.url } };
    }
  });
}

function extractSystem(messages: ChatRequest["messages"]): unknown {
  const system = messages.filter((m) => m.role === "system");
  if (system.length === 0) return undefined;
  return { parts: [{ text: system.map((m) => contentToString(m.content)).join("\n") }] };
}

function contentToString(content: ChatContent): string {
  if (typeof content === "string") return content;
  return content.filter((p) => p.type === "text").map((p) => p.text).join("");
}

/**
 * Parse Gemini's SSE stream into normalized ChatChunks.
 * Gemini returns `data: {json}` events where each json is a GenerateContentResponse.
 */
async function* parseGeminiSSE(
  body: ReadableStream<Uint8Array>,
  ctx: ExecutionContext,
): AsyncIterable<ChatChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let totalTokens = 0;

  try {
    while (true) {
      if (ctx.signal.aborted) {
        await reader.cancel();
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nlIdx: number;
      while ((nlIdx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nlIdx).trim();
        buffer = buffer.slice(nlIdx + 1);
        if (!line || !line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        try {
          const json = JSON.parse(data) as {
            candidates?: Array<{
              content?: { parts?: Array<{ text?: string }> };
              finishReason?: string;
            }>;
            usageMetadata?: { totalTokenCount?: number };
          };
          const parts = json.candidates?.[0]?.content?.parts ?? [];
          const text = parts.map((p) => p.text ?? "").join("");
          if (text) {
            totalTokens += Math.ceil(text.length / 4);
            yield { delta: text };
          }
          const finish = json.candidates?.[0]?.finishReason;
          if (finish && finish !== "FINISH_REASON_UNSPECIFIED") {
            yield {
              done: true,
              finishReason: finish === "STOP" ? "stop" : finish === "MAX_TOKENS" ? "length" : "stop",
              usage: {
                totalTokens: json.usageMetadata?.totalTokenCount ?? totalTokens,
                completionTokens: totalTokens,
              },
            };
            return;
          }
        } catch {
          // Skip malformed chunks.
        }
      }
    }
    yield { done: true, finishReason: "stop", usage: { completionTokens: totalTokens } };
  } finally {
    reader.releaseLock();
  }
}

function makeSyntheticContext(): ExecutionContext {
  const ctrl = new AbortController();
  return {
    requestId: `gemini-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: "provider-internal",
    signal: ctrl.signal,
    log: {
      trace() {}, debug() {}, info() {}, warn() {}, error() {},
      child() { return this; },
    },
    events: { emit() {}, on() { return () => {} }, clear() {} },
  };
}

/** Heuristic context window inference for Gemini models. */
function inferGeminiContextWindow(modelId: string): number {
  if (modelId.includes("2.5")) return 1_000_000;
  if (modelId.includes("2.0")) return 1_000_000;
  if (modelId.includes("1.5-pro")) return 2_000_000;
  if (modelId.includes("1.5-flash")) return 1_000_000;
  if (modelId.includes("1.0-pro")) return 32_000;
  if (modelId.includes("embedding")) return 2048;
  return 32_000;
}
