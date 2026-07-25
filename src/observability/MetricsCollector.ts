import type { RuntimeEvent } from "../core/types.js";

/**
 * MetricsCollector
 *
 * Subscribes to RuntimeEvents and accumulates runtime metrics.
 * Non-invasive: it only listens — it never blocks or interferes.
 *
 * Collected metrics:
 *  - request latency (p50, p99, avg, count)
 *  - provider latency
 *  - capability execution time (per type)
 *  - graph execution time
 *  - retry counts
 *  - cache hits (capability declaration cache)
 *  - failures (per error code)
 *  - token usage
 */
export interface MetricsSnapshot {
  requests: {
    total: number;
    succeeded: number;
    failed: number;
    avgLatencyMs: number;
    p50LatencyMs: number;
    p99LatencyMs: number;
  };
  capabilities: {
    total: number;
    succeeded: number;
    failed: number;
    avgLatencyMs: number;
    perType: Map<string, { count: number; avgLatencyMs: number; failures: number }>;
  };
  graph: {
    total: number;
    succeeded: number;
    failed: number;
    avgDurationMs: number;
  };
  retries: number;
  cacheHits: number;
  cacheMisses: number;
  tokensUsed: number;
  errorsByCode: Map<string, number>;
}

export class MetricsCollector {
  private requestLatencies: number[] = [];
  private requestCount = 0;
  private requestSucceeded = 0;
  private requestFailed = 0;

  private capabilityCount = 0;
  private capabilitySucceeded = 0;
  private capabilityFailed = 0;
  private capabilityLatencies: number[] = [];
  private capabilityPerType = new Map<string, { count: number; totalLatency: number; failures: number }>();

  private graphCount = 0;
  private graphSucceeded = 0;
  private graphFailed = 0;
  private graphDurations: number[] = [];

  private retries = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private tokensUsed = 0;
  private errorsByCode = new Map<string, number>();

  // Track in-flight request start times
  private requestStarts = new Map<string, number>();

  /** Subscribe this collector to a runtime event emitter. */
  attach(emit: (handler: (event: RuntimeEvent) => void) => () => void): () => void {
    return emit((event) => this.onEvent(event));
  }

  onEvent(event: RuntimeEvent): void {
    switch (event.type) {
      case "request:start":
        this.requestStarts.set(event.requestId, event.timestamp);
        this.requestCount++;
        break;
      case "request:end": {
        const start = this.requestStarts.get(event.requestId);
        if (start !== undefined) {
          const latency = event.timestamp - start;
          this.requestLatencies.push(latency);
          this.requestStarts.delete(event.requestId);
        }
        if (event.ok) this.requestSucceeded++;
        else this.requestFailed++;
        break;
      }
      case "capability:dispatch":
        this.capabilityCount++;
        break;
      case "capability:success":
        this.capabilitySucceeded++;
        this.capabilityLatencies.push(event.durationMs);
        this.updatePerType(event.capabilityId, event.durationMs, false);
        break;
      case "capability:error":
        this.capabilityFailed++;
        this.updatePerType(event.capabilityId, 0, true);
        this.incrementError("capability");
        break;
      case "node_failed":
        this.retries++; // Approximation: failed nodes that were retried
        break;
      case "graph_completed":
        this.graphCount++;
        this.graphDurations.push(event.durationMs);
        if (event.ok) this.graphSucceeded++;
        else this.graphFailed++;
        break;
      case "node_completed":
        if (!event.ok) {
          this.incrementError("node");
        }
        break;
      case "provider:done":
        // Token usage is tracked in provider:chunk/done events
        break;
      default:
        break;
    }
  }

  /** Record a cache hit (capability declaration cache). */
  recordCacheHit(): void {
    this.cacheHits++;
  }

  /** Record a cache miss (capability declaration cache). */
  recordCacheMiss(): void {
    this.cacheMisses++;
  }

  /** Record token usage. */
  recordTokens(tokens: number): void {
    this.tokensUsed += tokens;
  }

  /** Record a retry. */
  recordRetry(): void {
    this.retries++;
  }

  /** Record an error by code. */
  recordError(code: string): void {
    this.incrementError(code);
  }

  private updatePerType(capabilityId: string, latencyMs: number, isFailure: boolean): void {
    // Extract the capability type from the id (e.g. "tool.filesystem" -> "filesystem")
    const parts = capabilityId.split(".");
    const typeKey = parts.length > 1 ? parts[parts.length - 1]! : capabilityId;
    const entry = this.capabilityPerType.get(typeKey) ?? { count: 0, totalLatency: 0, failures: 0 };
    entry.count++;
    entry.totalLatency += latencyMs;
    if (isFailure) entry.failures++;
    this.capabilityPerType.set(typeKey, entry);
  }

  private incrementError(code: string): void {
    this.errorsByCode.set(code, (this.errorsByCode.get(code) ?? 0) + 1);
  }

  /** Get a point-in-time snapshot of all metrics. */
  snapshot(): MetricsSnapshot {
    const sorted = [...this.requestLatencies].sort((a, b) => a - b);
    const capSorted = [...this.capabilityLatencies].sort((a, b) => a - b);
    const graphSorted = [...this.graphDurations].sort((a, b) => a - b);

    const perType = new Map<string, { count: number; avgLatencyMs: number; failures: number }>();
    for (const [key, val] of this.capabilityPerType) {
      perType.set(key, {
        count: val.count,
        avgLatencyMs: val.count > 0 ? Math.round(val.totalLatency / val.count) : 0,
        failures: val.failures,
      });
    }

    return {
      requests: {
        total: this.requestCount,
        succeeded: this.requestSucceeded,
        failed: this.requestFailed,
        avgLatencyMs: sorted.length > 0 ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0,
        p50LatencyMs: percentile(sorted, 0.5),
        p99LatencyMs: percentile(sorted, 0.99),
      },
      capabilities: {
        total: this.capabilityCount,
        succeeded: this.capabilitySucceeded,
        failed: this.capabilityFailed,
        avgLatencyMs: capSorted.length > 0 ? Math.round(capSorted.reduce((a, b) => a + b, 0) / capSorted.length) : 0,
        perType,
      },
      graph: {
        total: this.graphCount,
        succeeded: this.graphSucceeded,
        failed: this.graphFailed,
        avgDurationMs: graphSorted.length > 0 ? Math.round(graphSorted.reduce((a, b) => a + b, 0) / graphSorted.length) : 0,
      },
      retries: this.retries,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      tokensUsed: this.tokensUsed,
      errorsByCode: new Map(this.errorsByCode),
    };
  }

  /** Reset all metrics. */
  reset(): void {
    this.requestLatencies = [];
    this.requestCount = 0;
    this.requestSucceeded = 0;
    this.requestFailed = 0;
    this.capabilityCount = 0;
    this.capabilitySucceeded = 0;
    this.capabilityFailed = 0;
    this.capabilityLatencies = [];
    this.capabilityPerType.clear();
    this.graphCount = 0;
    this.graphSucceeded = 0;
    this.graphFailed = 0;
    this.graphDurations = [];
    this.retries = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.tokensUsed = 0;
    this.errorsByCode.clear();
    this.requestStarts.clear();
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}
