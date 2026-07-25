import { describe, it, expect } from "vitest";
import { EventBus } from "../src/events/EventBus.js";
import type { RuntimeEvent } from "../src/core/types.js";

describe("EventBus", () => {
  it("delivers typed events to type-specific handlers", () => {
    const bus = new EventBus();
    const got: string[] = [];
    bus.on("session:created", (e) => got.push(e.sessionId));

    bus.emit({ type: "session:created", sessionId: "s1", timestamp: 1 });
    bus.emit({ type: "request:start", requestId: "r1", sessionId: "s1", input: "", model: "x", timestamp: 1 });

    expect(got).toEqual(["s1"]);
  });

  it("supports wildcard handlers that receive every event", () => {
    const bus = new EventBus();
    const all: RuntimeEvent[] = [];
    bus.onAny((e) => all.push(e));

    bus.emit({ type: "session:created", sessionId: "s1", timestamp: 1 });
    bus.emit({ type: "request:start", requestId: "r1", sessionId: "s1", input: "", model: "x", timestamp: 1 });

    expect(all).toHaveLength(2);
  });

  it("unsubscribe handlers via returned disposer", () => {
    const bus = new EventBus();
    const got: string[] = [];
    const off = bus.on("session:created", (e) => got.push(e.sessionId));

    bus.emit({ type: "session:created", sessionId: "s1", timestamp: 1 });
    off();
    bus.emit({ type: "session:created", sessionId: "s2", timestamp: 2 });

    expect(got).toEqual(["s1"]);
  });

  it("keeps history when enabled", () => {
    const bus = new EventBus({ keepHistory: true });
    bus.emit({ type: "session:created", sessionId: "s1", timestamp: 1 });
    bus.emit({ type: "session:created", sessionId: "s2", timestamp: 2 });
    expect(bus.getHistory()).toHaveLength(2);
  });

  it("does not let a failing handler break the emitter", () => {
    const bus = new EventBus();
    let second = false;
    bus.on("session:created", () => {
      throw new Error("boom");
    });
    bus.on("session:created", () => {
      second = true;
    });
    bus.emit({ type: "session:created", sessionId: "s1", timestamp: 1 });
    expect(second).toBe(true);
  });

  it("clear() removes all handlers and history", () => {
    const bus = new EventBus({ keepHistory: true });
    const got: string[] = [];
    bus.on("session:created", (e) => got.push(e.sessionId));
    bus.emit({ type: "session:created", sessionId: "s1", timestamp: 1 });
    bus.clear();
    expect(bus.getHistory()).toHaveLength(0);
    bus.emit({ type: "session:created", sessionId: "s2", timestamp: 2 });
    expect(got).toEqual(["s1"]);
    expect(bus.getHistory()).toHaveLength(1);
  });
});
