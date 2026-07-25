/**
 * ProviderManager — owns every provider instance.
 *
 * Enhanced with:
 *   - addProvider() / removeProvider() / updateProvider() / testProvider()
 *   - listProviders() / listModels() / getCapabilities()
 *   - streamChat() / chat() / cancel()
 *   - Automatic provider failover
 *   - Retry with exponential backoff
 *   - Usage reporting (tokens, latency, cost, retries)
 *
 * The UI never touches HTTP — it calls runtime.chat() or runtime.streamChat().
 */

import type {
  CapabilityInput,
  CapabilityResult,
  CapabilityType,
  ChatChunk,
  ChatRequest,
  ExecutionContext,
  IProvider,
  ProviderHealth,
  ProviderModel,
} from "../core/types.js";
import { ProviderError, toMindiError } from "../core/errors.js";
import { CapabilityRegistry } from "../registry/CapabilityRegistry.js";
import type { ProviderRetryPolicy } from "./provider-config.js";

// ---------------------------------------------------------------------------
// Usage Reporting
// ---------------------------------------------------------------------------

export interface UsageRecord {
  providerId: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  retryCount: number;
  cost?: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// ProviderManager
// ---------------------------------------------------------------------------

export class ProviderManager {
  private readonly providers = new Map<string, IProvider>();
  private readonly registry: CapabilityRegistry;
  private readonly usageRecords: UsageRecord[] = [];
  private readonly activeRequests = new Map<string, AbortController>();

  constructor(registry: CapabilityRegistry) {
    this.registry = registry;
  }

  // ---- Registration ----------------------------------------------------

  register(provider: IProvider): this {
    if (this.providers.has(provider.id)) {
      throw new ProviderError("E_PROVIDER_ERROR", `Provider already registered: ${provider.id}`, {
        providerId: provider.id,
      });
    }
    this.providers.set(provider.id, provider);
    for (const cap of provider.capabilities) {
      this.registry.register({
        id: `${provider.id}.${cap}`,
        type: cap,
        source: "provider",
        label: `${provider.label} ${cap}`,
        priority: 100,
        execute: (input, ctx) => provider.executeCapability(cap, input, ctx),
        canHandle: (input) => input.type === cap,
      });
    }
    return this;
  }

  /** Alias for register() — matches the requested API. */
  addProvider(provider: IProvider): this {
    return this.register(provider);
  }

  removeProvider(id: string): boolean {
    const provider = this.providers.get(id);
    if (!provider) return false;
    this.providers.delete(id);
    // Unregister capabilities.
    for (const cap of provider.capabilities) {
      this.registry.unregister(`${id}.${cap}`);
    }
    return true;
  }

  updateProvider(id: string, provider: IProvider): this {
    this.removeProvider(id);
    this.register(provider);
    return this;
  }

  // ---- Lookup ----------------------------------------------------------

  get(id: string): IProvider | undefined {
    return this.providers.get(id);
  }

  getPrimary(id: string): IProvider {
    const p = this.providers.get(id);
    if (!p) {
      throw new ProviderError(
        "E_PROVIDER_UNAVAILABLE",
        `Primary provider not registered: ${id}.`,
        { providerId: id, registered: Array.from(this.providers.keys()) },
      );
    }
    return p;
  }

  listProviders(): IProvider[] {
    return Array.from(this.providers.values());
  }

  /** Alias for backward compat. */
  list(): IProvider[] {
    return this.listProviders();
  }

  async listModels(): Promise<Array<ProviderModel & { providerId: string }>> {
    const out: Array<ProviderModel & { providerId: string }> = [];
    for (const p of this.providers.values()) {
      try {
        const models = await p.listModels();
        for (const m of models) out.push({ ...m, providerId: p.id });
      } catch {
        // A failing provider shouldn't break listing others.
      }
    }
    return out;
  }

  /** Alias for backward compat. */
  async listAllModels(): Promise<Array<ProviderModel & { providerId: string }>> {
    return this.listModels();
  }

  getCapabilities(providerId: string): CapabilityType[] {
    const p = this.providers.get(providerId);
    return p ? Array.from(p.capabilities) : [];
  }

  selectFor(type: CapabilityType): IProvider[] {
    return this.list().filter((p) => p.hasCapability(type));
  }

  // ---- Health + Testing ------------------------------------------------

  async healthAll(): Promise<ProviderHealth[]> {
    return Promise.all(this.list().map((p) => p.health()));
  }

  /** Test a provider's connectivity and credentials. */
  async testProvider(id: string): Promise<ProviderHealth> {
    const p = this.providers.get(id);
    if (!p) {
      return { providerId: id, ok: false, error: "Provider not registered" };
    }
    return p.health();
  }

  // ---- Chat / Streaming ------------------------------------------------

  /**
   * Stream a chat completion. Yields chunks one at a time.
   * The UI calls runtime.streamChat() and renders tokens as they arrive.
   *
   * Features:
   *   - Automatic retry with exponential backoff
   *   - Provider failover (if active provider fails, try a compatible one)
   *   - Request cancellation via AbortController
   *   - Usage reporting
   */
  async *streamChat(
    request: ChatRequest,
    ctx: ExecutionContext,
    opts: {
      providerId: string;
      retryPolicy?: ProviderRetryPolicy;
      failover?: boolean;
    },
  ): AsyncIterable<ChatChunk> {
    const { providerId, failover = true } = opts;
    const retryPolicy = opts.retryPolicy ?? {
      maxAttempts: 3,
      baseBackoffMs: 500,
      maxBackoffMs: 10_000,
      retryableErrors: ["E_PROVIDER_TIMEOUT", "E_PROVIDER_RATE_LIMIT", "E_PROVIDER_UNAVAILABLE"],
    };

    // Build failover list: primary provider first, then compatible alternatives.
    const failoverList = this.buildFailoverList(providerId);

    const ctrl = new AbortController();
    const requestId = ctx.requestId;
    this.activeRequests.set(requestId, ctrl);

    const onParentAbort = () => ctrl.abort();
    if (ctx.signal.aborted) onParentAbort();
    else ctx.signal.addEventListener("abort", onParentAbort, { once: true });

    let lastError: unknown;
    let retryCount = 0;
    const startTime = Date.now();

    for (const provider of failoverList) {
      if (!failover && provider.id !== providerId) break;

      for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt++) {
        try {
          let completionTokens = 0;
          for await (const chunk of provider.chat(request, ctx)) {
            if (chunk.delta) completionTokens += Math.ceil(chunk.delta.length / 4);
            if (chunk.usage?.completionTokens) completionTokens = chunk.usage.completionTokens;
            yield chunk;
          }

          // Record usage.
          this.recordUsage({
            providerId: provider.id,
            modelId: request.model,
            promptTokens: 0,
            completionTokens,
            totalTokens: completionTokens,
            latencyMs: Date.now() - startTime,
            retryCount,
            timestamp: Date.now(),
          });

          this.activeRequests.delete(requestId);
          ctx.signal.removeEventListener("abort", onParentAbort);
          return;
        } catch (err) {
          lastError = err;
          retryCount++;
          const mindiErr = toMindiError(err);

          // Check if retryable.
          if (attempt < retryPolicy.maxAttempts && retryPolicy.retryableErrors.includes(mindiErr.code)) {
            const backoff = Math.min(
              retryPolicy.baseBackoffMs * Math.pow(2, attempt - 1),
              retryPolicy.maxBackoffMs,
            );
            await sleep(backoff);
            continue;
          }

          // Not retryable or exhausted retries for this provider.
          // Try next provider in failover list.
          break;
        }
      }
    }

    // All providers failed.
    this.activeRequests.delete(requestId);
    ctx.signal.removeEventListener("abort", onParentAbort);
    throw toMindiError(lastError);
  }

  /**
   * Non-streaming chat. Collects all chunks and returns the full response.
   */
  async chat(
    request: ChatRequest,
    ctx: ExecutionContext,
    opts: { providerId: string; retryPolicy?: ProviderRetryPolicy; failover?: boolean },
  ): Promise<{ text: string; usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }; finishReason?: string }> {
    let text = "";
    let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
    let finishReason: string | undefined;

    for await (const chunk of this.streamChat(request, ctx, opts)) {
      if (chunk.delta) text += chunk.delta;
      if (chunk.usage) usage = chunk.usage;
      if (chunk.finishReason) finishReason = chunk.finishReason;
    }

    return { text, usage, finishReason };
  }

  /** Cancel an active streaming request. */
  cancel(requestId: string): boolean {
    const ctrl = this.activeRequests.get(requestId);
    if (ctrl) {
      ctrl.abort();
      this.activeRequests.delete(requestId);
      return true;
    }
    return false;
  }

  // ---- Usage Reporting -------------------------------------------------

  getUsageRecords(): readonly UsageRecord[] {
    return this.usageRecords;
  }

  clearUsageRecords(): void {
    this.usageRecords.length = 0;
  }

  private recordUsage(record: UsageRecord): void {
    this.usageRecords.push(record);
    if (this.usageRecords.length > 1000) this.usageRecords.shift();
  }

  // ---- Failover --------------------------------------------------------

  /**
   * Build a failover list: the primary provider first, then all other
   * providers that support the Chat capability.
   */
  private buildFailoverList(primaryId: string): IProvider[] {
    const primary = this.providers.get(primaryId);
    if (!primary) {
      // If primary not found, return all chat-capable providers.
      return this.selectFor("chat" as CapabilityType);
    }
    const alternatives = this.list().filter(
      (p) => p.id !== primaryId && p.hasCapability("chat" as CapabilityType),
    );
    return [primary, ...alternatives];
  }

  // ---- Legacy compat ---------------------------------------------------

  async executeCapability(
    providerId: string,
    type: CapabilityType,
    input: CapabilityInput,
    ctx: ExecutionContext,
  ): Promise<CapabilityResult> {
    const p = this.get(providerId);
    if (!p) {
      throw new ProviderError("E_PROVIDER_UNAVAILABLE", `Provider not found: ${providerId}`, { providerId });
    }
    return p.executeCapability(type, input, ctx);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
