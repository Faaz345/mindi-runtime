import type {
  CapabilityInput,
  CapabilityResult,
  CapabilityType,
  ChatChunk,
  ChatRequest,
  ExecutionContext,
  IProvider,
  ProviderCapabilityDeclaration,
  ProviderHealth,
  ProviderModel,
} from "../core/types.js";
import { CapabilityError, ProviderError, toMindiError } from "../core/errors.js";

type ProviderErrorCode =
  | "E_PROVIDER_UNAVAILABLE"
  | "E_PROVIDER_AUTH"
  | "E_PROVIDER_RATE_LIMIT"
  | "E_PROVIDER_TIMEOUT"
  | "E_PROVIDER_ERROR";

/**
 * BaseProvider
 *
 * Shared scaffolding for every provider adapter:
 *  - HTTP fetch helper with retries + abort + auth mapping to typed errors
 *  - capability lookup against a per-model declaration table
 *  - declareCapability() with built-in caching (TTL-based)
 *  - default executeCapability() that throws E_CAPABILITY_NOT_FOUND for
 *    capabilities the provider did not override
 *
 * Concrete providers (OpenAI, Gemini, ...) only override:
 *   - listModels()
 *   - chat()
 *   - resolveDeclaration(modelId) — provider-specific capability discovery
 *   - executeCapability() for the capabilities they natively support
 *   - health()
 */
export abstract class BaseProvider implements IProvider {
  abstract readonly id: string;
  abstract readonly label: string;
  protected abstract readonly providerCapabilities: ReadonlySet<CapabilityType>;

  /** Cache: modelId -> declaration. TTL is 5 minutes by default. */
  private readonly declarationCache = new Map<string, { decl: ProviderCapabilityDeclaration; expiresAt: number }>();
  private readonly cacheTtlMs = 5 * 60 * 1000;

  /** Public capabilities accessor (satisfies IProvider.capabilities). */
  get capabilities(): ReadonlySet<CapabilityType> {
    return this.providerCapabilities;
  }

  abstract listModels(): Promise<ProviderModel[]>;
  abstract chat(request: ChatRequest, ctx: ExecutionContext): AsyncIterable<ChatChunk>;
  abstract health(): Promise<ProviderHealth>;

  /**
   * Provider-specific capability discovery.
   * Subclasses call their API's model metadata endpoint and return a
   * fully-populated ProviderCapabilityDeclaration.
   */
  protected abstract resolveDeclaration(modelId: string): Promise<ProviderCapabilityDeclaration>;

  /**
   * Resolve the full capability declaration for a specific model.
   * Uses the cache if fresh; otherwise calls resolveDeclaration() and caches.
   */
  async declareCapability(modelId: string): Promise<ProviderCapabilityDeclaration> {
    const cached = this.declarationCache.get(modelId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.decl;
    }
    const decl = await this.resolveDeclaration(modelId);
    this.declarationCache.set(modelId, {
      decl,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    return decl;
  }

  /** Invalidate the capability declaration cache for a model (or all). */
  invalidateCapabilityCache(modelId?: string): void {
    if (modelId) {
      this.declarationCache.delete(modelId);
    } else {
      this.declarationCache.clear();
    }
  }

  /**
   * Per-model capability overrides. Subclasses populate this from their
   * config (user-provided model table) + hardcoded defaults.
   * Kept for backward compatibility with existing tests.
   */
  protected abstract modelCapabilities(modelId: string): CapabilityType[];

  hasCapability(type: CapabilityType): boolean {
    return this.providerCapabilities.has(type);
  }

  async hasModel(modelId: string): Promise<boolean> {
    const models = await this.listModels();
    return models.some((m) => m.id === modelId);
  }

  /**
   * Default executeCapability throws. Providers that natively support a
   * capability (e.g. Gemini supports Vision) override this method for the
   * specific capability types.
   */
  async executeCapability(
    type: CapabilityType,
    _input: CapabilityInput,
    _ctx: ExecutionContext,
  ): Promise<CapabilityResult> {
    throw new CapabilityError(
      "E_CAPABILITY_NOT_FOUND",
      `Provider "${this.id}" does not implement capability "${type}"`,
      { providerId: this.id, capabilityType: type },
    );
  }

  /**
   * HTTP fetch helper that maps HTTP failures to typed ProviderErrors and
   * honors the execution context's AbortSignal.
   */
  protected async http(
    url: string,
    opts: RequestInit & { timeoutMs?: number },
    ctx: ExecutionContext,
  ): Promise<Response> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const ctrl = new AbortController();
    // timeoutMs = 0 means no timeout (for long streaming responses).
    const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    const onParentAbort = () => ctrl.abort();
    if (ctx.signal.aborted) onParentAbort();
    else ctx.signal.addEventListener("abort", onParentAbort, { once: true });

    try {
      const res = await fetch(url, {
        ...opts,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw mapHttpError(res.status, body, this.id, url);
      }
      return res;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if ((err as Error)?.name === "AbortError") {
        throw new ProviderError("E_PROVIDER_TIMEOUT", `Request to ${url} aborted/timed out`, {
          providerId: this.id,
          url,
          cause: err,
        });
      }
      throw toMindiError(err, "E_PROVIDER_ERROR");
    } finally {
      if (timer) clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onParentAbort);
    }
  }
}

/** Map an HTTP status to the most specific ProviderError code. */
export function mapHttpError(
  status: number,
  body: string,
  providerId: string,
  url: string,
): ProviderError {
  let code: ProviderErrorCode;
  if (status === 401 || status === 403) code = "E_PROVIDER_AUTH";
  else if (status === 429) code = "E_PROVIDER_RATE_LIMIT";
  else if (status >= 500) code = "E_PROVIDER_UNAVAILABLE";
  else code = "E_PROVIDER_ERROR";
  return new ProviderError(code, `Provider ${providerId} HTTP ${status}: ${truncate(body, 500)}`, {
    providerId,
    url,
    status,
    body: truncate(body, 2000),
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "..." : s;
}
