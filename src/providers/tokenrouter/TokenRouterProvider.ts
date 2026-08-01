/**
 * TokenRouter provider — OpenAI-compatible.
 *
 * Implements the TokenRouter API exactly as documented:
 *   - Base URL: https://api.tokenrouter.com/v1 (configurable)
 *   - Endpoint: /chat/completions (OpenAI-compatible)
 *   - Auth: Bearer API key
 *   - Streaming: Server-Sent Events (SSE), same format as OpenAI
 *   - Models: any opaque model name (z-ai/glm-5.2-free, claude-opus-4.8, qwen-max, etc.)
 *
 * No model validation — model names are opaque strings passed through as-is.
 *
 * This is the reference implementation for any OpenAI-compatible provider.
 * The same adapter covers OpenAI, OpenRouter, Groq, Together, DeepSeek,
 * Fireworks, Ollama, LM Studio, Azure, vLLM, and any future compatible server
 * — just by changing the baseUrl and apiKey.
 */

import type {
  CapabilityInput,
  CapabilityResult,
  CapabilityType,
  ChatChunk,
  ChatRequest,
  ExecutionContext,
  ProviderHealth,
  ProviderModel,
} from "../../core/types.js";
import { CapabilityType as Cap } from "../../core/types.js";
import { BaseProvider } from "../BaseProvider.js";
import {
  buildProfile,
  normalizeOpenAIModelMetadata,
} from "../../capability/CapabilityDetector.js";
import type { RawModelMetadata } from "../../capability/types.js";

export interface TokenRouterProviderOptions {
  apiKey: string;
  baseUrl?: string;
  displayName?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  models?: Record<string, { capabilities: CapabilityType[]; contextWindow?: number }>;
  /** The primary chat model configured by the user. Used as vision fallback. */
  primaryModel?: string;
}

const DEFAULT_BASE_URL = "https://api.tokenrouter.com/v1";

export class TokenRouterProvider extends BaseProvider {
  readonly id = "tokenrouter";
  readonly label: string;
  protected readonly providerCapabilities: ReadonlySet<CapabilityType> = new Set([Cap.Chat, Cap.Vision]);
  protected readonly opts: Required<TokenRouterProviderOptions>;

  constructor(opts: TokenRouterProviderOptions) {
    super();
    this.opts = {
      baseUrl: DEFAULT_BASE_URL,
      displayName: "TokenRouter",
      headers: {},
      timeoutMs: 60_000,
      models: {},
      primaryModel: "",
      ...opts,
    };
    this.label = this.opts.displayName;
  }

  protected modelCapabilities(modelId: string): CapabilityType[] {
    const override = this.opts.models?.[modelId];
    if (override) return override.capabilities;
    // Delegate to the shared detector (universal heuristic) — TokenRouter
    // model names are opaque, but multimodal naming conventions still apply.
    return buildProfile(this.id, modelId).nativeCapabilities;
  }

  /**
   * Raw metadata discovery — TokenRouter is OpenAI-compatible, so if it
   * exposes /models we normalize whatever it returns.
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

  protected async resolveDeclaration(modelId: string) {
    const override = this.opts.models[modelId];
    if (override) {
      return {
        providerId: this.id,
        modelId,
        label: modelId,
        capabilities: override.capabilities,
        streaming: true,
        toolCalling: true,
        multimodal: override.capabilities.includes(Cap.Vision),
        embeddingSupport: override.capabilities.includes(Cap.Embeddings),
        imageGeneration: false,
        audioSupport: false,
        maxContext: override.contextWindow ?? 8192,
        metadata: { baseUrl: this.opts.baseUrl, metadataSource: "manual" },
        resolvedAt: Date.now(),
      };
    }
    // Metadata-first: try /models/{id}, fall back to the universal heuristic.
    let raw: RawModelMetadata | undefined;
    try {
      const ctx = makeSyntheticContext();
      const res = await this.http(`${this.opts.baseUrl}/models/${modelId}`, { method: "GET" }, ctx);
      raw = normalizeOpenAIModelMetadata((await res.json()) as Record<string, unknown>);
    } catch {
      raw = undefined;
    }
    const profile = buildProfile(this.id, modelId, raw, raw ? "api" : "heuristic");
    return {
      providerId: this.id,
      modelId,
      label: profile.label ?? modelId,
      capabilities: profile.nativeCapabilities,
      streaming: true,
      toolCalling: profile.toolCalling,
      multimodal: profile.vision,
      embeddingSupport: profile.embeddings,
      imageGeneration: profile.imageGeneration,
      audioSupport: profile.audioInput || profile.audioOutput,
      maxContext: profile.contextWindow ?? 8192,
      maxOutputTokens: profile.maxOutputTokens,
      metadata: { baseUrl: this.opts.baseUrl, metadataSource: profile.metadataSource },
      resolvedAt: Date.now(),
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    // TokenRouter may not have a /models endpoint.
    // Return an empty list — the runtime treats model names as opaque strings.
    try {
      const ctx = makeSyntheticContext();
      const res = await this.http(`${this.opts.baseUrl}/models`, { method: "GET" }, ctx);
      const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
      if (data.data) {
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
    } catch {
      // No /models endpoint — return empty. Model names are opaque.
    }
    return [];
  }

  async *chat(request: ChatRequest, ctx: ExecutionContext): AsyncIterable<ChatChunk> {
    const url = `${this.opts.baseUrl}/chat/completions`;

    // Build clean request body — only include defined fields.
    // TokenRouter (and free models) may reject undefined/null values.
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toOpenAIMessage),
      stream: true,
    };
    // Only set max_tokens if explicitly provided — otherwise let the
    // provider decide. Some free models reject high token counts.
    if (request.maxTokens) {
      body.max_tokens = request.maxTokens;
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.stop && request.stop.length > 0) {
      body.stop = request.stop;
    }

    // Connection timeout — stream idle is handled by Runtime's streamChatTurn.
    const res = await this.http(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      timeoutMs: 60_000,
    }, ctx);

    if (!res.body) {
      throw new Error(`TokenRouter: empty response body`);
    }

    yield* parseSSEStream(res.body, ctx);
  }

  async health(): Promise<ProviderHealth> {
    const start = Date.now();
    const ctx = makeSyntheticContext();

    // Try /models first (fast, lightweight).
    try {
      await this.http(`${this.opts.baseUrl}/models`, {
        method: "GET",
        headers: this.headers(),
        timeoutMs: 15_000,
      }, ctx);
      return { providerId: this.id, ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Auth error = key is wrong, don't bother with chat test.
      if (msg.includes("401") || msg.includes("403") || msg.includes("Token not provided")) {
        return { providerId: this.id, ok: false, latencyMs: Date.now() - start, error: `Authentication failed: ${msg}` };
      }

      // If it's a timeout, the provider might be slow or unreachable.
      if (msg.includes("aborted") || msg.includes("timeout") || msg.includes("TIMED_OUT")) {
        return { providerId: this.id, ok: false, latencyMs: Date.now() - start, error: `Connection timed out (15s). Check your network and base URL.` };
      }

      // For 400/404/422 — the provider is reachable, just the endpoint doesn't exist.
      // Try a chat completion to verify credentials.
      try {
        await this.http(`${this.opts.baseUrl}/chat/completions`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            model: "z-ai/glm-5.2-free",
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 1,
            stream: false,
          }),
          timeoutMs: 20_000,
        }, ctx);
        return { providerId: this.id, ok: true, latencyMs: Date.now() - start };
      } catch (err2) {
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        if (msg2.includes("401") || msg2.includes("403") || msg2.includes("Token not provided")) {
          return { providerId: this.id, ok: false, latencyMs: Date.now() - start, error: `Authentication failed: ${msg2}` };
        }
        // 400/404/422 = provider reachable, credentials valid, just model not found.
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
    for (const [k, v] of Object.entries(this.opts.headers)) {
      h[k] = v;
    }
    return h;
  }

  // ---- Vision capability (Capability Augmentation Router) ----

  async executeCapability(
    type: CapabilityType,
    input: CapabilityInput,
    ctx: ExecutionContext,
  ): Promise<CapabilityResult> {
    if (type === Cap.Vision) {
      return this.vision(input, ctx);
    }
    return super.executeCapability(type, input, ctx);
  }

  /**
   * Native vision — send image+prompt to a vision-capable model.
   * Uses the same OpenAI-compatible chat completions endpoint with
   * multimodal content parts.
   */
  private async vision(
    input: CapabilityInput,
    ctx: ExecutionContext,
  ): Promise<CapabilityResult> {
    const start = Date.now();
    const prompt = String(input.params.prompt ?? "Analyze this image in detail.");
    const image = String(input.params.image ?? ""); // base64 data URI or URL

    // Resolve a vision-capable model.
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
        error: `No vision-capable model available on provider "${this.id}". The model list returned no multimodal models.`,
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
      stream: false,
    };

    try {
      const res = await this.http(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(visionBody),
        timeoutMs: 90_000, // Vision analysis can be slow on free models.
      }, ctx);
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
    } catch (err) {
      return {
        type: Cap.Vision,
        source: this.id,
        ok: false,
        payload: { kind: "text", text: "" },
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  /**
   * Resolve a vision-capable model from this provider's model list.
   * Prefers free-tier variants (":free" / "-free" suffix) to avoid burning
   * paid quota on augmentation. Cached for 5 minutes.
   *
   * Fallback chain:
   *   1. Explicitly vision-capable models from /models
   *   2. The configured primary model (many aggregator models support vision
   *      without declaring it in metadata)
   *   3. null (genuinely no vision available)
   */
  private visionModelCache: { model: string | null; expiresAt: number } | null = null;
  private async resolveVisionModel(): Promise<string | null> {
    if (this.visionModelCache && this.visionModelCache.expiresAt > Date.now()) {
      return this.visionModelCache.model;
    }
    try {
      const models = await this.listModels();
      const visionModels = models.filter((m) => m.capabilities.includes(Cap.Vision));
      if (visionModels.length > 0) {
        // Prefer free-tier variants first.
        const free = visionModels.find((m) => m.id.includes("free"));
        const picked = (free ?? visionModels[0]!).id;
        this.visionModelCache = { model: picked, expiresAt: Date.now() + 5 * 60 * 1000 };
        return picked;
      }
      // No explicitly vision-capable models found. Fall back to the primary
      // model — on aggregators, many models support vision without declaring it.
      if (this.opts.primaryModel) {
        this.visionModelCache = { model: this.opts.primaryModel, expiresAt: Date.now() + 5 * 60 * 1000 };
        return this.opts.primaryModel;
      }
      // Last resort: if models were returned but none matched, try the first one.
      if (models.length > 0) {
        const picked = models[0]!.id;
        this.visionModelCache = { model: picked, expiresAt: Date.now() + 5 * 60 * 1000 };
        return picked;
      }
      this.visionModelCache = { model: null, expiresAt: Date.now() + 5 * 60 * 1000 };
      return null;
    } catch {
      // /models endpoint failed — fall back to primary model.
      if (this.opts.primaryModel) {
        this.visionModelCache = { model: this.opts.primaryModel, expiresAt: Date.now() + 5 * 60 * 1000 };
        return this.opts.primaryModel;
      }
      this.visionModelCache = { model: null, expiresAt: Date.now() + 5 * 60 * 1000 };
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible message conversion (shared by all OpenAI-compatible providers)
// ---------------------------------------------------------------------------

function toOpenAIMessage(m: ChatRequest["messages"][number]): Record<string, unknown> {
  // Convert non-standard roles to OpenAI-compatible roles.
  // "capability" messages (from MINDI augmentation) become "system" messages
  // so the model treats them as context instructions.
  const role = m.role === "capability" ? "system" : m.role;
  const out: Record<string, unknown> = { role, content: normalizeContent(m.content) };
  if (m.name) out.name = m.name;
  return out;
}

function normalizeContent(content: import("../../core/types.js").ChatContent): unknown {
  if (typeof content === "string") return content;
  return content.map((part) => {
    switch (part.type) {
      case "text": return { type: "text", text: part.text };
      case "image": return { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.base64}` } };
      case "image_url": return { type: "image_url", image_url: { url: part.url } };
    }
  });
}

// ---------------------------------------------------------------------------
// SSE stream parser (OpenAI-compatible format)
// ---------------------------------------------------------------------------

/** Race a promise against an AbortSignal to interrupt stalled reads. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

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
        const result = await raceAbort(reader.read(), ctx.signal);
        done = result.done;
        value = result.value as Uint8Array;
      } catch {
        // Connection terminated or aborted (ERR_STREAM_PREMATURE_CLOSE, timeout, etc.)
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
    // Stream ended (either naturally or terminated) — emit done.
    yield { done: true, finishReason: gotContent ? "stop" : "length", usage: { completionTokens: totalCompletionTokens } };
  } finally {
    reader.releaseLock();
  }
}

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
