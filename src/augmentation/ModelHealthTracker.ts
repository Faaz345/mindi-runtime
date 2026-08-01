/**
 * ModelHealthTracker — operational state tracking for providers and models.
 *
 * Tracks real-time health signals:
 *   - Success/failure rates per (provider, model) pair
 *   - Latency percentiles (p50, p95, p99)
 *   - Rate limit encounters
 *   - Consecutive failures (for circuit-breaking)
 *   - Last successful request timestamp
 *
 * The CapabilityAugmentationRouter and ProviderRouter can consult this
 * tracker to avoid routing to unhealthy models. This is ADDITIVE — it
 * never blocks, only informs routing decisions.
 *
 * Health states:
 *   HEALTHY   — normal operation
 *   DEGRADED  — elevated error rate or latency, but still functional
 *   UNHEALTHY — circuit breaker open, avoid routing here
 */

export type HealthState = "healthy" | "degraded" | "unhealthy";

export interface ModelHealthSnapshot {
  providerId: string;
  modelId: string;
  state: HealthState;
  /** Total requests tracked in the current window */
  totalRequests: number;
  /** Successful requests */
  successes: number;
  /** Failed requests */
  failures: number;
  /** Current consecutive failure count */
  consecutiveFailures: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Median latency in ms */
  p50LatencyMs: number;
  /** 95th percentile latency in ms */
  p95LatencyMs: number;
  /** Last successful request (epoch ms, 0 = never) */
  lastSuccessAt: number;
  /** Last failure (epoch ms, 0 = never) */
  lastFailureAt: number;
  /** Number of rate limit hits in the window */
  rateLimitHits: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface HealthConfig {
  /** Sliding window size in ms (default: 5 minutes) */
  windowMs: number;
  /** Consecutive failures before marking unhealthy (default: 5) */
  circuitBreakerThreshold: number;
  /** Success rate below which the model is degraded (default: 0.7) */
  degradedThreshold: number;
  /** Maximum latency entries to keep per model (default: 100) */
  maxLatencyEntries: number;
}

const DEFAULT_CONFIG: HealthConfig = {
  windowMs: 5 * 60 * 1000,
  circuitBreakerThreshold: 5,
  degradedThreshold: 0.7,
  maxLatencyEntries: 100,
};

// ---------------------------------------------------------------------------
// Internal tracking state
// ---------------------------------------------------------------------------

interface TrackedModel {
  providerId: string;
  modelId: string;
  entries: Array<{ timestamp: number; ok: boolean; latencyMs: number; rateLimited: boolean }>;
  consecutiveFailures: number;
  lastSuccessAt: number;
  lastFailureAt: number;
}

// ---------------------------------------------------------------------------
// ModelHealthTracker
// ---------------------------------------------------------------------------

export class ModelHealthTracker {
  private readonly models = new Map<string, TrackedModel>();
  private readonly config: HealthConfig;

  constructor(config?: Partial<HealthConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Record a completed request.
   */
  record(providerId: string, modelId: string, ok: boolean, latencyMs: number, rateLimited = false): void {
    const key = `${providerId}:${modelId}`;
    let tracked = this.models.get(key);
    if (!tracked) {
      tracked = {
        providerId,
        modelId,
        entries: [],
        consecutiveFailures: 0,
        lastSuccessAt: 0,
        lastFailureAt: 0,
      };
      this.models.set(key, tracked);
    }

    const now = Date.now();
    tracked.entries.push({ timestamp: now, ok, latencyMs, rateLimited });

    // Trim to window.
    const cutoff = now - this.config.windowMs;
    tracked.entries = tracked.entries.filter((e) => e.timestamp >= cutoff);

    // Trim to max entries.
    if (tracked.entries.length > this.config.maxLatencyEntries) {
      tracked.entries = tracked.entries.slice(-this.config.maxLatencyEntries);
    }

    // Update streaks.
    if (ok) {
      tracked.consecutiveFailures = 0;
      tracked.lastSuccessAt = now;
    } else {
      tracked.consecutiveFailures++;
      tracked.lastFailureAt = now;
    }
  }

  /**
   * Get the current health state for a model.
   */
  getState(providerId: string, modelId: string): HealthState {
    const key = `${providerId}:${modelId}`;
    const tracked = this.models.get(key);
    if (!tracked || tracked.entries.length === 0) return "healthy";

    // Circuit breaker: consecutive failures.
    if (tracked.consecutiveFailures >= this.config.circuitBreakerThreshold) {
      return "unhealthy";
    }

    // Success rate check.
    const snapshot = this.getSnapshot(providerId, modelId);
    if (snapshot.totalRequests >= 3 && snapshot.successRate < this.config.degradedThreshold) {
      return "degraded";
    }

    return "healthy";
  }

  /**
   * Get a full health snapshot for a model.
   */
  getSnapshot(providerId: string, modelId: string): ModelHealthSnapshot {
    const key = `${providerId}:${modelId}`;
    const tracked = this.models.get(key);

    if (!tracked || tracked.entries.length === 0) {
      return {
        providerId,
        modelId,
        state: "healthy",
        totalRequests: 0,
        successes: 0,
        failures: 0,
        consecutiveFailures: 0,
        successRate: 1,
        p50LatencyMs: 0,
        p95LatencyMs: 0,
        lastSuccessAt: 0,
        lastFailureAt: 0,
        rateLimitHits: 0,
      };
    }

    const entries = tracked.entries;
    const successes = entries.filter((e) => e.ok).length;
    const failures = entries.length - successes;
    const rateLimitHits = entries.filter((e) => e.rateLimited).length;
    const latencies = entries.map((e) => e.latencyMs).sort((a, b) => a - b);

    return {
      providerId,
      modelId,
      state: this.getState(providerId, modelId),
      totalRequests: entries.length,
      successes,
      failures,
      consecutiveFailures: tracked.consecutiveFailures,
      successRate: entries.length > 0 ? successes / entries.length : 1,
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      lastSuccessAt: tracked.lastSuccessAt,
      lastFailureAt: tracked.lastFailureAt,
      rateLimitHits,
    };
  }

  /**
   * Check if a model should be avoided (circuit breaker open).
   */
  shouldAvoid(providerId: string, modelId: string): boolean {
    return this.getState(providerId, modelId) === "unhealthy";
  }

  /**
   * Get all tracked models sorted by health (best first).
   */
  getAllSnapshots(): ModelHealthSnapshot[] {
    const snapshots: ModelHealthSnapshot[] = [];
    for (const tracked of this.models.values()) {
      snapshots.push(this.getSnapshot(tracked.providerId, tracked.modelId));
    }
    // Sort: healthy first, then by success rate descending.
    const stateOrder: Record<HealthState, number> = { healthy: 0, degraded: 1, unhealthy: 2 };
    snapshots.sort((a, b) => {
      const stateDiff = stateOrder[a.state] - stateOrder[b.state];
      if (stateDiff !== 0) return stateDiff;
      return b.successRate - a.successRate;
    });
    return snapshots;
  }

  /**
   * Reset tracking for a specific model (or all).
   */
  reset(providerId?: string, modelId?: string): void {
    if (providerId && modelId) {
      this.models.delete(`${providerId}:${modelId}`);
    } else {
      this.models.clear();
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, idx)]!;
}
