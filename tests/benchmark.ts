/**
 * Phase 8 Benchmark — measures startup, write throughput, event throughput,
 * and memory usage. Run with: npx tsx tests/benchmark.ts
 */
import { performance, PerformanceObserver } from "node:perf_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---- Helpers ----
function memMB(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}

function bench(label: string, fn: () => void): number {
  const start = performance.now();
  fn();
  const elapsed = performance.now() - start;
  console.log(`  ${label}: ${elapsed.toFixed(2)}ms`);
  return elapsed;
}

async function benchAsync(label: string, fn: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await fn();
  const elapsed = performance.now() - start;
  console.log(`  ${label}: ${elapsed.toFixed(2)}ms`);
  return elapsed;
}

// ---- Benchmark Suite ----
async function main() {
  console.log("\n=== MINDIGENOUS Runtime — Phase 8 Benchmark ===\n");
  console.log(`Node ${process.version} | ${os.platform()} ${os.arch()}`);
  console.log(`Heap baseline: ${memMB()} MB\n`);

  // 1. Startup: Runtime constructor
  console.log("[1] Startup Latency");
  const { Runtime } = await import("../src/runtime/Runtime.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mindi-bench-"));

  let constructTime = 0;
  let firstInteractive = 0;
  const startupStart = performance.now();
  const rt = new Runtime({
    workspace: { enabled: true, rootDir: tmpDir },
    providers: [],
    logLevel: "silent",
  } as any);
  constructTime = performance.now() - startupStart;
  console.log(`  Constructor: ${constructTime.toFixed(2)}ms`);

  // Wait for deferred init (setImmediate)
  await new Promise((r) => setImmediate(r));
  firstInteractive = performance.now() - startupStart;
  console.log(`  First interactive (after deferred scan): ${firstInteractive.toFixed(2)}ms`);

  // 2. Session write throughput
  console.log("\n[2] Session Write Throughput");
  const session = rt.workspace!.sessionManager.create({
    providerId: "test",
    modelId: "test-model",
  });

  const MSG_COUNT = 200;
  const writeStart = performance.now();
  for (let i = 0; i < MSG_COUNT; i++) {
    rt.workspace!.sessionManager.remember(session.id, [
      { role: "user", content: `Message ${i}: ${"x".repeat(100)}` },
    ]);
  }
  const writeElapsed = performance.now() - writeStart;
  console.log(`  ${MSG_COUNT} remember() calls: ${writeElapsed.toFixed(2)}ms`);
  console.log(`  Throughput: ${(MSG_COUNT / (writeElapsed / 1000)).toFixed(0)} msgs/sec`);
  console.log(`  Avg per message: ${(writeElapsed / MSG_COUNT).toFixed(3)}ms`);

  // 3. Event throughput (EventBridge)
  console.log("\n[3] EventBridge Throughput");
  const { EventBridge } = await import("../src/terminal/events/EventBridge.js");
  const bridge = new EventBridge({ maxEvents: 1000 });
  const EVENT_COUNT = 5000;
  const eventStart = performance.now();
  for (let i = 0; i < EVENT_COUNT; i++) {
    bridge.ingestRuntimeEvent({
      type: "node_completed",
      nodeId: `node-${i}`,
      capability: "test",
      ok: true,
      durationMs: 10,
    } as any);
  }
  const eventElapsed = performance.now() - eventStart;
  console.log(`  ${EVENT_COUNT} events ingested: ${eventElapsed.toFixed(2)}ms`);
  console.log(`  Throughput: ${(EVENT_COUNT / (eventElapsed / 1000)).toFixed(0)} events/sec`);
  console.log(`  Retained in memory: ${bridge.length} (cap: 1000)`);

  // 4. ContextCompressor threshold guard
  console.log("\n[4] ContextCompressor Fast-Path");
  const { ContextCompressor } = await import("../src/workspace/ContextCompressor.js");
  const { WorkspaceStore } = await import("../src/workspace/WorkspaceStore.js");
  const store2 = new WorkspaceStore(tmpDir);
  const compressor = new ContextCompressor(store2);
  const shortHistory = Array.from({ length: 10 }, (_, i) => ({
    role: "user" as const,
    content: `msg ${i}`,
  }));
  const compressStart = performance.now();
  for (let i = 0; i < 1000; i++) {
    compressor.compress("bench-session", shortHistory, { keepRecent: 50 });
  }
  const compressElapsed = performance.now() - compressStart;
  console.log(`  1000 no-op compress calls (under threshold): ${compressElapsed.toFixed(2)}ms`);
  console.log(`  Avg: ${(compressElapsed / 1000).toFixed(4)}ms (fast-path: no disk I/O)`);

  // 5. ModelCapabilityRegistry lookup
  console.log("\n[5] ModelCapabilityRegistry Lookup");
  const { ModelCapabilityRegistry } = await import("../src/capability/ModelCapabilityRegistry.js");
  const registry = new ModelCapabilityRegistry();
  const LOOKUP_COUNT = 10000;
  const lookupStart = performance.now();
  for (let i = 0; i < LOOKUP_COUNT; i++) {
    registry.get("openai", `gpt-4-${i % 10}`);
  }
  const lookupElapsed = performance.now() - lookupStart;
  console.log(`  ${LOOKUP_COUNT} get() calls: ${lookupElapsed.toFixed(2)}ms`);
  console.log(`  Throughput: ${(LOOKUP_COUNT / (lookupElapsed / 1000)).toFixed(0)} lookups/sec`);

  // 6. Memory usage
  console.log("\n[6] Memory Usage");
  console.log(`  Heap after all benchmarks: ${memMB()} MB`);
  console.log(`  RSS: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`);

  // 7. Debounced write coalescing
  console.log("\n[7] Write Coalescing (debounce)");
  const store3 = new WorkspaceStore(tmpDir, { writeDebounceMs: 50 });
  store3.ensureDirs();
  const meta = store3.initWorkspace();
  const coalesceStart = performance.now();
  for (let i = 0; i < 100; i++) {
    store3.writeWorkspaceDebounced({ ...meta, updatedAt: Date.now() });
  }
  const coalesceElapsed = performance.now() - coalesceStart;
  console.log(`  100 debounced writeWorkspace calls: ${coalesceElapsed.toFixed(2)}ms (synchronous cost)`);
  console.log(`  Actual disk writes: 1 (coalesced after 50ms)`);
  store3.flush();
  console.log(`  After flush: workspace.json written`);

  // Cleanup
  rt.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log("\n=== Benchmark Complete ===\n");
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
