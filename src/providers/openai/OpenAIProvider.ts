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
import {
  buildProfile,
  normalizeOpenAIModelMetadata,
} from "../../capability/CapabilityDetector.js";
import type { RawModelMetadata } from "../../capability/types.js";

/**
 * OpenAI-compatible provider.
 *
 * One adapter supports any OpenAI-compatible API:
 *   - OpenAI (api.openai.com/v1)
 *   - OpenRouter
 *   - Groq, Together, Fireworks, vLLM, LM Studio
 *   - Any future OpenAI-compatible server
 *
 * Capability detection is MODEL-CENTRIC and metadata-first:
 *   - discoverModels() returns raw metadata from /models (OpenRouter returns
 *     rich architecture/modality data; plain OpenAI returns bare ids).
 *   - The shared CapabilityDetector derives capabilities from that metadata.
 *   - A universal naming heuristic is the last-resort fallback only.
 *   - NO hardcoded model lists. New multimodal models are detected
 *     automatically whenever the provider exposes modality metadata.
 */
export interface OpenAIProviderOptions {
  apiKey: string;
  baseUrl?: string;
  orgId?: string;
  displayName?: string;
  models?: Record<string, { capabilities: CapabilityType[]; contextWindow?: number }>;
  /**
   * OpenRouter-style strict routing: send `provider.require_parameters=true`
   * so requests only route to upstreams that accept every parameter in the
   * request (including image content parts). Defaults to true when the
   * baseUrl points at openrouter.ai, false elsewhere.
   */
  requireParameters?: boolean;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export class OpenAIProvider extends BaseProvider {
  readonly id: string;
  readonly label: string;
  protected readonly providerCapabilities: ReadonlySet<CapabilityType> = new Set([
    Cap.Chat,
    Cap.Vision,
    Cap.Embeddings,
    Cap.ImageGeneration,
  ]);

  private readonly opts: Required<Omit<OpenAIProviderOptions, "requireParameters">>;
  /** Strict-routing flag; undefined = auto (on for openrouter.ai). */
  private readonly requireParameters?: boolean;

  constructor(opts: OpenAIProviderOptions) {
    super();
    const { requireParameters, ...rest } = opts;
    this.requireParameters = requireParameters;
    this.opts = {
      baseUrl: DEFAULT_BASE_URL,
      orgId: "",
      displayName: "",
      models: {},
      ...rest,
    };
    this.id = this.opts.displayName?.toLowerCase().replace(/\s+/g, "-") || "openai";
    this.label = this.opts.displayName || "OpenAI-compatible";
  }

  /**
   * Effective strict-routing setting. On OpenRouter, default ON: image
   * requests then fail loudly (404) instead of being silently routed to an
   * upstream that drops the image parts.
   */
  private get strictRouting(): boolean {
    return this.requireParameters ?? this.opts.baseUrl.includes("openrouter.ai");
  }

  protected modelCapabilities(modelId: string): CapabilityType[] {
    const override = this.opts.models?.[modelId];
    if (override) return override.capabilities;
    // Delegate to the shared detector — no hardcoded lists here.
    return buildProfile(this.id, modelId).nativeCapabilities;
  }

  /**
   * Raw metadata discovery: returns whatever /models exposes.
   * OpenRouter returns architecture/modality/parameter data per model;
   * plain OpenAI-compatible servers return bare ids (detection falls back
   * to the universal heuristic for those).
   */
  async discoverModels(): Promise<RawModelMetadata[] | undefined> {
    try {
      const ctx = makeSyntheticContext();
      const res = await this.http(`${this.opts.baseUrl}/models`, { method: "GET" }, ctx);
      const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
      if (!Array.isArray(data.data)) return undefined;
      return data.data.map(normalizeOpenAIModelMetadata);
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve a capability declaration for one model. Metadata-first:
   * tries /models/{id} for OpenRouter-style modality data, then falls back
   * to the shared detector's heuristic.
   */
  protected async resolveDeclaration(modelId: string): Promise<ProviderCapabilityDeclaration> {
    const override = this.opts.models?.[modelId];

    let raw: RawModelMetadata | undefined;
    try {
      const ctx = makeSyntheticContext();
      const res = await this.http(`${this.opts.baseUrl}/models/${modelId}`, { method: "GET" }, ctx);
      raw = normalizeOpenAIModelMetadata((await res.json()) as Record<string, unknown>);
    } catch {
      raw = undefined;
    }

    const profile = buildProfile(this.id, modelId, raw, raw ? "api" : "heuristic");

    // Manual per-model override always wins.
    const capabilities = override?.capabilities ?? profile.nativeCapabilities;
    const isVision = capabilities.includes(Cap.Vision);
    const isEmbedding = capabilities.includes(Cap.Embeddings);
    const isImageGen = capabilities.includes(Cap.ImageGeneration);
    const isO1 = modelId.startsWith("o1") || modelId.startsWith("o3") || modelId.startsWith("o4");

    return {
      providerId: this.id,
      modelId,
      label: profile.label ?? modelId,
      capabilities,
      streaming: !isO1,
      toolCalling: profile.toolCalling,
      multimodal: isVision,
      embeddingSupport: isEmbedding,
      imageGeneration: isImageGen,
      audioSupport: profile.audioInput || profile.audioOutput || modelId.includes("audio") || modelId.includes("whisper") || modelId.includes("tts"),
      maxContext: override?.contextWindow ?? profile.contextWindow ?? 8192,
      maxOutputTokens: profile.maxOutputTokens,
      metadata: {
        baseUrl: this.opts.baseUrl,
        metadataSource: profile.metadataSource,
      },
      resolvedAt: Date.now(),
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    const ctx = makeSyntheticContext();
    const res = await this.http(`${this.opts.baseUrl}/models`, { method: "GET" }, ctx);
    const data = (await res.json()) as { data: Array<Record<string, unknown>> };
    return data.data.map((m) => {
      const raw = normalizeOpenAIModelMetadata(m);
      const profile = buildProfile(this.id, raw.id, raw, raw.inputModalities || raw.modality ? "api" : "heuristic");
      const override = this.opts.models?.[raw.id];
      return {
        id: raw.id,
        label: raw.label ?? raw.id,
        capabilities: override?.capabilities ?? profile.nativeCapabilities,
        contextWindow: override?.contextWindow ?? profile.contextWindow,
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
    // Native function calling: only when the caller supplied tool defs.
    // Models that don't support tools simply ignore these fields.
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = "auto";
    }
    // OpenRouter strict routing: only use upstreams that accept every
    // parameter in this request (prevents silent image dropping).
    if (this.strictRouting) body.provider = { require_parameters: true };
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

  /** Native vision — send image+prompt to a vision-capable model on this provider. */
  private async vision(
    input: CapabilityInput,
    ctx: ExecutionContext,
    start: number,
  ): Promise<CapabilityResult> {
    const prompt = String(input.params.prompt ?? "Analyze this image in detail.");
    const image = String(input.params.image ?? ""); // base64 data URI or URL

    // Resolve the model to use for vision. The planner usually does NOT pass
    // params.model, and the provider's displayName ("custom", "OpenRouter",
    // ...) is NOT a model id — sending it yields HTTP 400 "not a valid model
    // ID". Resolve a real vision-capable model from this provider instead.
    let model = typeof input.params.model === "string" ? input.params.model : "";
    if (!model || model === this.id || model === this.opts.displayName) {
      model = (await this.resolveVisionModel()) ?? "";
    }
    if (!model) {
      return {
        type: Cap.Vision,
        source: this.id,
        ok: false,
        payload: { kind: "text", text: "" },
        error: `No vision-capable model available on provider "${this.id}". Register one or attach the image directly.`,
        durationMs: Date.now() - start,
      };
    }

    const url = `${this.opts.baseUrl}/chat/completions`;
    const visionBody: Record<string, unknown> = {
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
      max_tokens: 2000,
    };
    if (this.strictRouting) visionBody.provider = { require_parameters: true };
    const res = await this.http(
      url,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(visionBody),
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

  /**
   * Resolve a vision-capable model from this provider's own model list.
   * Prefers free-tier variants (":free" suffix) to avoid burning paid quota
   * on augmentation, then any vision-capable model. Cached for 5 minutes so
   * repeated vision calls don't re-hit /models.
   */
  private visionModelCache: { model: string; expiresAt: number } | null = null;
  private async resolveVisionModel(): Promise<string | null> {
    if (this.visionModelCache && this.visionModelCache.expiresAt > Date.now()) {
      return this.visionModelCache.model;
    }
    try {
      const models = await this.listModels();
      const visionModels = models.filter((m) => m.capabilities.includes(Cap.Vision));
      if (visionModels.length === 0) return null;
      // Prefer free-tier variants first, then the rest in listed order.
      const free = visionModels.find((m) => m.id.endsWith(":free"));
      const picked = (free ?? visionModels[0]!).id;
      this.visionModelCache = { model: picked, expiresAt: Date.now() + 5 * 60 * 1000 };
      return picked;
    } catch {
      return null;
    }
  }

  async health(): Promise<ProviderHealth> {
    const start = Date.now();
    const ctx = makeSyntheticContext();

    // Try /models first.
    try {
      await this.http(`${this.opts.baseUrl}/models`, {
        method: "GET",
        headers: this.headers(),
        timeoutMs: 15_000,
      }, ctx);
      return { providerId: this.id, ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Auth error = key is wrong.
      if (msg.includes("401") || msg.includes("403")) {
        return { providerId: this.id, ok: false, latencyMs: Date.now() - start, error: msg };
      }

      // Timeout = provider unreachable.
      if (msg.includes("aborted") || msg.includes("timeout")) {
        return { providerId: this.id, ok: false, latencyMs: Date.now() - start, error: `Connection timed out. Check your base URL: ${this.opts.baseUrl}` };
      }

      // For 404/400/etc — try a chat completion to verify credentials.
      try {
        await this.http(`${this.opts.baseUrl}/chat/completions`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 1,
            stream: false,
          }),
          timeoutMs: 20_000,
        }, ctx);
        return { providerId: this.id, ok: true, latencyMs: Date.now() - start };
      } catch (err2) {
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        if (msg2.includes("401") || msg2.includes("403")) {
          return { providerId: this.id, ok: false, latencyMs: Date.now() - start, error: msg2 };
        }
        // 400/404 = provider reachable, just the test model doesn't exist.
        if (msg2.includes("400") || msg2.includes("404") || msg2.includes("422")) {
          return { providerId: this.id, ok: true, latencyMs: Date.now() - start };
        }
        return { providerId: this.id, ok: false, latencyMs: Date.now() - start, error: msg2 };
      }
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
  // Native function-calling wire fields.
  if (role === "tool" && m.toolCallId) out.tool_call_id = m.toolCallId;
  if (m.toolCalls && m.toolCalls.length > 0) {
    out.tool_calls = m.toolCalls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.argumentsJson },
    }));
  }
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
  // Native tool calls stream in index-addressed fragments:
  //   delta.tool_calls: [{ index, id?, function?: { name?, arguments? } }]
  // Accumulate per index; emit the complete set on the final chunk.
  const toolCallAcc = new Map<number, { id: string; name: string; args: string }>();
  const collectToolCalls = (): ChatChunk["toolCalls"] => {
    if (toolCallAcc.size === 0) return undefined;
    return [...toolCallAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c], pos) => ({ id: c.id || `call_${pos}`, name: c.name, argumentsJson: c.args }));
  };

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
          yield {
            done: true,
            finishReason: toolCallAcc.size > 0 ? "tool_call" : "stop",
            usage: { completionTokens: totalCompletionTokens },
            toolCalls: collectToolCalls(),
          };
          return;
        }
        try {
          const json = JSON.parse(data) as {
            choices?: Array<{
              delta?: {
                content?: string;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  type?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string;
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          };
          const choice = json.choices?.[0];
          const delta = choice?.delta?.content;
          if (delta) {
            gotContent = true;
            totalCompletionTokens += Math.ceil(delta.length / 4);
            yield { delta };
          }
          const tcFragments = choice?.delta?.tool_calls;
          if (tcFragments) {
            gotContent = true;
            for (const frag of tcFragments) {
              const idx = frag.index ?? 0;
              const cur = toolCallAcc.get(idx) ?? { id: "", name: "", args: "" };
              if (frag.id) cur.id = frag.id;
              if (frag.function?.name) cur.name += frag.function.name;
              if (frag.function?.arguments) cur.args += frag.function.arguments;
              toolCallAcc.set(idx, cur);
            }
          }
          if (choice?.finish_reason) {
            yield {
              done: true,
              finishReason: (choice.finish_reason === "tool_calls" ? "tool_call" : choice.finish_reason) as ChatChunk["finishReason"],
              usage: {
                promptTokens: json.usage?.prompt_tokens,
                completionTokens: json.usage?.completion_tokens ?? totalCompletionTokens,
                totalTokens: json.usage?.total_tokens,
              },
              toolCalls: collectToolCalls(),
            };
            return;
          }
        } catch {
          // Skip malformed chunks.
        }
      }
    }
    yield {
      done: true,
      finishReason: toolCallAcc.size > 0 ? "tool_call" : gotContent ? "stop" : "length",
      usage: { completionTokens: totalCompletionTokens },
      toolCalls: collectToolCalls(),
    };
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
