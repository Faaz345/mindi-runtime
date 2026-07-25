import type { IEventBus, RuntimeEvent } from "../core/types.js";

type Handler = (event: RuntimeEvent) => void;

/**
 * Tiny typed in-process event bus.
 *
 * Every internal communication in MINDI Runtime flows through events.
 * This keeps subsystems decoupled — a provider does not call the logger,
 * it emits an event; logging, metrics, tracing all subscribe independently.
 *
 * The bus is synchronous (handlers run inline on emit) because:
 *  1. Ordering matters for observability (logs must appear in order).
 *  2. Async handlers introduce interleaving bugs that are painful to debug.
 *  3. Handlers are expected to be fast (logging, metric increment).
 *
 * Handlers that need to do async work should enqueue it themselves.
 */
export class EventBus implements IEventBus {
  private readonly handlers = new Map<RuntimeEvent["type"], Set<Handler>>();
  private readonly wildcards = new Set<Handler>();
  private readonly history: RuntimeEvent[] = [];
  private readonly keepHistory: boolean;
  private readonly maxHistory: number;

  constructor(opts?: { keepHistory?: boolean; maxHistory?: number }) {
    this.keepHistory = opts?.keepHistory ?? false;
    this.maxHistory = opts?.maxHistory ?? 1000;
  }

  emit<T extends RuntimeEvent>(event: T): void {
    if (this.keepHistory) {
      this.history.push(event);
      if (this.history.length > this.maxHistory) this.history.shift();
    }
    // Type-specific handlers
    const set = this.handlers.get(event.type);
    if (set) {
      for (const h of set) {
        try {
          h(event);
        } catch (err) {
          // A handler must never break the emitter. Swallow + log to stderr.
          // (We cannot use the logger here — the logger itself listens to events.)
          // eslint-disable-next-line no-console
          console.error("[EventBus] handler error:", err);
        }
      }
    }
    // Wildcards
    for (const h of this.wildcards) {
      try {
        h(event);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[EventBus] wildcard handler error:", err);
      }
    }
  }

  on<T extends RuntimeEvent["type"]>(
    type: T,
    handler: (event: Extract<RuntimeEvent, { type: T }>) => void,
  ): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as Handler);
    return () => {
      set?.delete(handler as Handler);
    };
  }

  /** Subscribe to every event. Useful for logging / tracing sinks. */
  onAny(handler: (event: RuntimeEvent) => void): () => void {
    this.wildcards.add(handler);
    return () => {
      this.wildcards.delete(handler);
    };
  }

  /** Remove all handlers — used in tests. */
  clear(): void {
    this.handlers.clear();
    this.wildcards.clear();
    this.history.length = 0;
  }

  /** Snapshot of emitted events (only if keepHistory=true). */
  getHistory(): readonly RuntimeEvent[] {
    return this.history;
  }
}
