/**
 * Metrics tests for the MINDI Runtime.
 *
 * Validates that MetricsCollector correctly tracks:
 *   - Request latency (avg, p50, p99)
 *   - Capability execution time
 *   - Graph execution time
 *   - Retry counts
 *   - Cache hits / misses
 *   - Failure counts
 *   - Token usage
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MetricsCollector } from "../src/observability/MetricsCollector.js";
import { EventBus } from "../src/events/EventBus.js";
import type { RuntimeEvent } from "../src/core/types.js";

describe("MetricsCollector", () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  it("tracks request count + success/failure", () => {
    collector.onEvent({ type: "request:start", requestId: "r1", sessionId: "s1", input: "", model: "m", timestamp: 100 });
    collector.onEvent({ type: "request:end", requestId: "r1", sessionId: "s1", ok: true, durationMs: 50, timestamp: 150 });
    collector.onEvent({ type: "request:start", requestId: "r2", sessionId: "s1", input: "", model: "m", timestamp: 200 });
    collector.onEvent({ type: "request:end", requestId: "r2", sessionId: "s1", ok: false, durationMs: 30, timestamp: 230 });

    const m = collector.snapshot();
    expect(m.requests.total).toBe(2);
    expect(m.requests.succeeded).toBe(1);
    expect(m.requests.failed).toBe(1);
  });

  it("calculates average latency", () => {
    emitRequest(collector, "r1", 100, 150); // 50ms
    emitRequest(collector, "r2", 200, 250); // 50ms
    emitRequest(collector, "r3", 300, 400); // 100ms

    const m = collector.snapshot();
    expect(m.requests.avgLatencyMs).toBe(Math.round((50 + 50 + 100) / 3));
  });

  it("calculates p50 and p99 latency", () => {
    // 10 requests with latencies 10..100ms
    for (let i = 0; i < 10; i++) {
      emitRequest(collector, `r${i}`, 0, (i + 1) * 10);
    }

    const m = collector.snapshot();
    expect(m.requests.p50LatencyMs).toBeGreaterThan(0);
    expect(m.requests.p99LatencyMs).toBeGreaterThanOrEqual(m.requests.p50LatencyMs);
  });

  it("tracks capability executions + per-type stats", () => {
    collector.onEvent({ type: "capability:dispatch", requestId: "r1", capabilityId: "tool.fs", capabilityType: "filesystem", executor: "tool", timestamp: 0 });
    collector.onEvent({ type: "capability:success", requestId: "r1", capabilityId: "tool.fs", durationMs: 10, timestamp: 10 });
    collector.onEvent({ type: "capability:dispatch", requestId: "r1", capabilityId: "tool.search", capabilityType: "web_search", executor: "tool", timestamp: 0 });
    collector.onEvent({ type: "capability:error", requestId: "r1", capabilityId: "tool.search", error: "timeout", timestamp: 5 });

    const m = collector.snapshot();
    expect(m.capabilities.total).toBe(2);
    expect(m.capabilities.succeeded).toBe(1);
    expect(m.capabilities.failed).toBe(1);
    expect(m.capabilities.perType.size).toBe(2);
    expect(m.capabilities.perType.get("fs")!.count).toBe(1);
    expect(m.capabilities.perType.get("search")!.failures).toBe(1);
  });

  it("tracks graph execution metrics", () => {
    collector.onEvent({ type: "graph_completed", requestId: "r1", graphId: "g1", ok: true, durationMs: 100, completedNodes: 3, failedNodes: 0, timestamp: 100 });
    collector.onEvent({ type: "graph_completed", requestId: "r2", graphId: "g2", ok: false, durationMs: 200, completedNodes: 1, failedNodes: 1, timestamp: 200 });

    const m = collector.snapshot();
    expect(m.graph.total).toBe(2);
    expect(m.graph.succeeded).toBe(1);
    expect(m.graph.failed).toBe(1);
    expect(m.graph.avgDurationMs).toBe(150);
  });

  it("tracks cache hits and misses", () => {
    collector.recordCacheHit();
    collector.recordCacheHit();
    collector.recordCacheMiss();

    const m = collector.snapshot();
    expect(m.cacheHits).toBe(2);
    expect(m.cacheMisses).toBe(1);
  });

  it("tracks token usage", () => {
    collector.recordTokens(100);
    collector.recordTokens(50);

    const m = collector.snapshot();
    expect(m.tokensUsed).toBe(150);
  });

  it("tracks errors by code", () => {
    collector.recordError("E_PROVIDER_TIMEOUT");
    collector.recordError("E_PROVIDER_TIMEOUT");
    collector.recordError("E_TOOL_FAILED");

    const m = collector.snapshot();
    expect(m.errorsByCode.get("E_PROVIDER_TIMEOUT")).toBe(2);
    expect(m.errorsByCode.get("E_TOOL_FAILED")).toBe(1);
  });

  it("tracks retries", () => {
    collector.recordRetry();
    collector.recordRetry();
    collector.recordRetry();

    const m = collector.snapshot();
    expect(m.retries).toBe(3);
  });

  it("reset() clears all metrics", () => {
    emitRequest(collector, "r1", 0, 100);
    collector.recordTokens(50);
    collector.recordCacheHit();

    collector.reset();

    const m = collector.snapshot();
    expect(m.requests.total).toBe(0);
    expect(m.tokensUsed).toBe(0);
    expect(m.cacheHits).toBe(0);
  });

  it("attaches to EventBus and receives events automatically", () => {
    const bus = new EventBus();
    const off = collector.attach((h) => bus.onAny(h));

    bus.emit({ type: "request:start", requestId: "r1", sessionId: "s1", input: "", model: "m", timestamp: 0 });
    bus.emit({ type: "request:end", requestId: "r1", sessionId: "s1", ok: true, durationMs: 50, timestamp: 50 });

    const m = collector.snapshot();
    expect(m.requests.total).toBe(1);
    expect(m.requests.succeeded).toBe(1);

    off();
    bus.emit({ type: "request:start", requestId: "r2", sessionId: "s1", input: "", model: "m", timestamp: 100 });
    expect(collector.snapshot().requests.total).toBe(1); // still 1, listener removed
  });
});

/** Helper: emit a complete request lifecycle. */
function emitRequest(c: MetricsCollector, id: string, start: number, end: number): void {
  c.onEvent({ type: "request:start", requestId: id, sessionId: "s", input: "", model: "m", timestamp: start });
  c.onEvent({ type: "request:end", requestId: id, sessionId: "s", ok: true, durationMs: end - start, timestamp: end });
}
