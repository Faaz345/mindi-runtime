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
 * OpenAI-compatible provider.
 *
 * One adapter supports any OpenAI-compatible API:
 *   - OpenAI (api.openai.com/v1)
 *   - OpenRouter
 *   - Groq, Together, Fireworks, vLLM, LM Studio
 *   - Any future OpenAI-compatible server
 *
 * Declared native capabilities:
 *   - chat        (always — that's what /chat/completions is for)
 *   - vision      (model-dependent; we declare it for known multimodal models)
 *   - embeddings  (via /embeddings)
 *   - image_generation (via /images/generations — DALL-E class)
 */
export interface OpenAIProviderOptions {
  apiKey: string;
  baseUrl?: string;
  orgId?: string;
  /** Override capability table for non-standard models */
  models?: Record<string, { capabilities: CapabilityType[]; contextWindow?: number }>;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** Models we know support vision. Used only if user doesn't override. */
const KNOWN_VISION_MODELS = [
  "gpt-4o", "gpt-4o-mini", "gpt-4o-2024",
  "gpt-4-turbo", "gpt-4-vision",
  "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
];

export class OpenAIProvider extends BaseProvider {
  readonly id = "openai";
  readonly label = "OpenAI-compatible";
  protected readonly providerCapabilities: ReadonlySet<CapabilityType> = new Set([
    Cap.Chat,
    Cap.Vision,
    Cap.Embeddings,
    Cap.ImageGeneration,
  ]);

  private readonly opts: Required<OpenAIProviderOptions>;

  constructor(opts: OpenAIProviderOptions) {
    super();
    this.opts = {
      baseUrl: DEFAULT_BASE_URL,
      orgId: "",
      models: {},
      ...opts,
    };
  }

  protected modelCapabilities(modelId: string): CapabilityType[] {
    const override = this.opts.models?.[modelId];
    if (override) return override.capabilities;
    const caps: CapabilityType[] = [Cap.Chat];
    if (KNOWN_VISION_MODELS.some((p) => modelId.startsWith(p))) caps.push(Cap.Vision);
    if (modelId.includes("text-embedding")) caps.push(Cap.Embeddings);
    if (modelId.startsWith("dall-e") || modelId.includes("image")) caps.push(Cap.ImageGeneration);
    return caps;
  }

  /**
   * Real capability discovery for OpenAI-compatible models.
   * Calls /models to get metadata, then infers capabilities from model id
   * + known patterns. User-provided override table takes precedence.
   */
  protected async resolveDeclaration(modelId: string): Promise<ProviderCapabilityDeclaration> {
    const caps = this.modelCapabilities(modelId);
    const isVision = caps.includes(Cap.Vision);
    const isEmbedding = caps.includes(Cap.Embeddings);
    const isImageGen = caps.includes(Cap.ImageGeneration);
    const isGpt4 = modelId.startsWith("gpt-4");
    const isO1 = modelId.startsWith("o1") || modelId.startsWith("o3") || modelId.startsWith("o4");

    // Try to get context window from the models endpoint.
    let maxContext = 8192;
    let label = modelId;
    try {
      const ctx = makeSyntheticContext();
      const res = await this.http(`${this.opts.baseUrl}/models/${modelId}`, { method: "GET" }, ctx);
      const data = (await res.json()) as { id: string; context_window?: number; max_tokens?: number };
      if (data.context_window) maxContext = data.context_window;
      label = data.id ?? modelId;
    } catch {
      // If the /models/{id} endpoint doesn't exist (some compatible servers),
      // fall back to heuristic context window.
      maxContext = inferContextWindow(modelId);
    }

    return {
      providerId: this.id,
      modelId,
      label,
      capabilities: caps,
      streaming: !isO1, // o1/o3/o4 models don't support streaming initially
      toolCalling: isGpt4 || modelId.startsWith("gpt-3.5-turbo") || isO1,
      multimodal: isVision,
      embeddingSupport: isEmbedding,
      imageGeneration: isImageGen,
      audioSupport: modelId.includes("audio") || modelId.includes("whisper") || modelId.includes("tts"),
      maxContext,
      maxOutputTokens: isGpt4 ? 4096 : 2048,
      metadata: {
        baseUrl: this.opts.baseUrl,
        family: inferModelFamily(modelId),
      },
      resolvedAt: Date.now(),
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    const ctx = makeSyntheticContext();
    const res = await this.http(`${this.opts.baseUrl}/models`, { method: "GET" }, ctx);
    const data = (await res.json()) as { data: Array<{ id: string }> };
    return data.data.map((m) => {
      const caps = this.modelCapabilities(m.id);
      return {
        id: m.id,
        label: m.id,
        capabilities: caps,
      };
    });
  }

  async *chat(request: ChatRequest, ctx: ExecutionContext): AsyncIterable<ChatChunk> {
    const url = `${this.opts.baseUrl}/chat/completions`;
    // Build clean request body — only include defined fields.
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toOpenAIMessage),
      stream: true,
    };
    if (request.maxTokens) body.max_tokens = request.maxTokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.stop && request.stop.length > 0) body.stop = request.stop;
    const res = await this.http(
      url,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        timeoutMs: 0, // No timeout — let the stream run until the model finishes.
      },
      ctx,
    );

    if (!res.body) {
      throw new ProviderError("E_PROVIDER_ERROR", `OpenAI: empty response body`, {
        providerId: this.id,
      });
    }

    yield* parseSSEStream(res.body, ctx);
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
      case Cap.ImageGeneration:
        return this.imageGeneration(input, ctx, start);
      case Cap.Vision:
        return this.vision(input, ctx, start);
      default:
        return super.executeCapability(type, input, ctx);
    }
  }

  /** Generate an embedding for the given text. */
  private async embeddings(
    input: CapabilityInput,
    ctx: ExecutionContext,
    start: number,
  ): Promise<CapabilityResult> {
    const text = String(input.params.text ?? "");
    const model = String(input.params.model ?? "text-embedding-3-small");
    const url = `${this.opts.baseUrl}/embeddings`;
    const res = await this.http(
      url,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ model, input: text }),
      },
      ctx,
    );
    const data = (await res.json()) as { data: Array<{ embedding: number[] }>; usage?: { total_tokens?: number } };
    return {
      type: Cap.Embeddings,
      source: this.id,
      ok: true,
      payload: { kind: "embedding", vector: data.data[0]!.embedding, model },
      usage: { totalTokens: data.usage?.total_tokens },
      durationMs: Date.now() - start,
    };
  }

  /** Generate an image from a text prompt (DALL-E class). */
  private async imageGeneration(
    input: CapabilityInput,
    ctx: ExecutionContext,
    start: number,
  ): Promise<CapabilityResult> {
    const prompt = String(input.params.prompt ?? "");
    const model = String(input.params.model ?? "dall-e-3");
    const size = String(input.params.size ?? "1024x1024");
    const url = `${this.opts.baseUrl}/images/generations`;
    const res = await this.http(
      url,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ model, prompt, n: 1, size, response_format: "b64_json" }),
      },
      ctx,
    );
    const data = (await res.json()) as { data: Array<{ b64_json?: string; url?: string }> };
    const item = data.data[0]!;
    return {
      type: Cap.ImageGeneration,
      source: this.id,
      ok: true,
      payload: { kind: "image", mimeType: "image/png", base64: item.b64_json ?? "", url: item.url },
      durationMs: Date.now() - start,
    };
  }

  /** Native OpenAI vision — send image+prompt, get a text description. */
  private async vision(
    input: CapabilityInput,
    ctx: ExecutionContext,
    start: number,
  ): Promise<CapabilityResult> {
    const prompt = String(input.params.prompt ?? "Describe this image.");
    const image = String(input.params.image ?? ""); // base64 data URI or URL
    const model = String(input.params.model ?? "gpt-4o");
    const url = `${this.opts.baseUrl}/chat/completions`;
    const res = await this.http(
      url,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: image } },
              ],
            },
          ],
          max_tokens: 1000,
        }),
      },
      ctx,
    );
    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    return {
      type: Cap.Vision,
      source: this.id,
      ok: true,
      payload: { kind: "text", text: data.choices[0]?.message?.content ?? "" },
      usage: {
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
        totalTokens: data.usage?.total_tokens,
      },
      durationMs: Date.now() - start,
    };
  }

  async health(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      const ctx = makeSyntheticContext();
      const res = await this.http(`${this.opts.baseUrl}/models`, { method: "GET" }, ctx);
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

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.opts.apiKey}`,
    };
    if (this.opts.orgId) h["OpenAI-Organization"] = this.opts.orgId;
    return h;
  }
}

/** Convert normalized ChatMessage to OpenAI wire format. */
function toOpenAIMessage(m: ChatRequest["messages"][number]): Record<string, unknown> {
  // Convert non-standard roles to OpenAI-compatible roles.
  const role = m.role === "capability" ? "system" : m.role;
  const out: Record<string, unknown> = { role, content: normalizeContent(m.content) };
  if (m.name) out.name = m.name;
  return out;
}

function normalizeContent(content: ChatContent): unknown {
  if (typeof content === "string") return content;
  return content.map((part) => {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "image":
        return { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.base64}` } };
      case "image_url":
        return { type: "image_url", image_url: { url: part.url } };
    }
  });
}

/**
 * Parse an SSE stream from a fetch Response body into ChatChunks.
 * Handles OpenAI's `data: {json}` / `data: [DONE]` format.
 */
async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  ctx: ExecutionContext,
): AsyncIterable<ChatChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let totalCompletionTokens = 0;
  let gotContent = false;

  try {
    while (true) {
      if (ctx.signal.aborted) {
        await reader.cancel();
        return;
      }
      let done = false;
      let value: Uint8Array | undefined;
      try {
        const result = await reader.read();
        done = result.done;
        value = result.value as Uint8Array;
      } catch {
        // Connection terminated prematurely — emit done with whatever we have.
        break;
      }
      if (done) break;
      if (!value) continue;
      buffer += decoder.decode(value, { stream: true });

      let nlIdx: number;
      while ((nlIdx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nlIdx).trim();
        buffer = buffer.slice(nlIdx + 1);
        if (!line || line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          yield { done: true, finishReason: "stop", usage: { completionTokens: totalCompletionTokens } };
          return;
        }
        try {
          const json = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          };
          const choice = json.choices?.[0];
          const delta = choice?.delta?.content;
          if (delta) {
            gotContent = true;
            totalCompletionTokens += Math.ceil(delta.length / 4);
            yield { delta };
          }
          if (choice?.finish_reason) {
            yield {
              done: true,
              finishReason: choice.finish_reason as ChatChunk["finishReason"],
              usage: {
                promptTokens: json.usage?.prompt_tokens,
                completionTokens: json.usage?.completion_tokens ?? totalCompletionTokens,
                totalTokens: json.usage?.total_tokens,
              },
            };
            return;
          }
        } catch {
          // Skip malformed chunks.
        }
      }
    }
    yield { done: true, finishReason: gotContent ? "stop" : "length", usage: { completionTokens: totalCompletionTokens } };
  } finally {
    reader.releaseLock();
  }
}

/** A minimal execution context for provider self-initiated calls (e.g. listModels). */
function makeSyntheticContext(): ExecutionContext {
  const ctrl = new AbortController();
  return {
    requestId: `provider-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: "provider-internal",
    signal: ctrl.signal,
    log: {
      trace() {}, debug() {}, info() {}, warn() {}, error() {},
      child() { return this; },
    },
    events: { emit() {}, on() { return () => {} }, clear() {} },
  };
}

/** Heuristic context window inference for models without /models/{id} metadata. */
function inferContextWindow(modelId: string): number {
  if (modelId.startsWith("gpt-4o")) return 128_000;
  if (modelId.startsWith("gpt-4.1")) return 1_000_000;
  if (modelId.startsWith("gpt-4-turbo")) return 128_000;
  if (modelId.startsWith("gpt-4")) return 8192;
  if (modelId.startsWith("gpt-3.5-turbo")) return 16_385;
  if (modelId.startsWith("o1")) return 200_000;
  if (modelId.startsWith("o3") || modelId.startsWith("o4")) return 200_000;
  if (modelId.startsWith("text-embedding-3")) return 8191;
  if (modelId.startsWith("text-embedding-ada")) return 8191;
  return 8192;
}

/** Infer model family for metadata. */
function inferModelFamily(modelId: string): string {
  if (modelId.startsWith("gpt-4o")) return "gpt-4o";
  if (modelId.startsWith("gpt-4.1")) return "gpt-4.1";
  if (modelId.startsWith("gpt-4")) return "gpt-4";
  if (modelId.startsWith("gpt-3.5")) return "gpt-3.5";
  if (modelId.startsWith("o1") || modelId.startsWith("o3") || modelId.startsWith("o4")) return "reasoning";
  if (modelId.startsWith("dall-e")) return "dall-e";
  if (modelId.startsWith("text-embedding")) return "embeddings";
  if (modelId.startsWith("whisper")) return "whisper";
  if (modelId.startsWith("tts")) return "tts";
  return "unknown";
}
