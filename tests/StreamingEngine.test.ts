import { describe, it, expect } from "vitest";
import { streamFromChatChunks, collectStream } from "../src/streaming/StreamingEngine.js";
import type { ChatChunk, ExecutionContext } from "../src/core/types.js";
import { RequestError } from "../src/core/errors.js";

function makeCtx(): ExecutionContext {
  const ctrl = new AbortController();
  return {
    requestId: "r", sessionId: "s", signal: ctrl.signal,
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
    events: { emit() {}, on() { return () => {} }, clear() {} },
  };
}

async function* chunks(xs: ChatChunk[]): AsyncIterable<ChatChunk> {
  for (const x of xs) yield x;
}

describe("streamFromChatChunks", () => {
  it("emits delta events for content chunks", async () => {
    const src = chunks([{ delta: "hello" }, { delta: " world" }, { done: true, finishReason: "stop" }]);
    const out = [];
    for await (const e of streamFromChatChunks(src, makeCtx())) out.push(e);
    expect(out.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("")).toBe("hello world");
    expect(out.find((e) => e.type === "done")).toBeDefined();
  });

  it("passes through usage stats", async () => {
    const src = chunks([{ delta: "x" }, { done: true, usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } }]);
    const out = [];
    for await (const e of streamFromChatChunks(src, makeCtx())) out.push(e);
    const done = out.find((e) => e.type === "done") as { usage?: { totalTokens?: number } };
    expect(done.usage?.totalTokens).toBe(8);
  });

  it("emits synthetic done if stream ends without one", async () => {
    const src = chunks([{ delta: "x" }]);
    const out = [];
    for await (const e of streamFromChatChunks(src, makeCtx())) out.push(e);
    expect(out.find((e) => e.type === "done")).toBeDefined();
  });

  it("emits error event when source throws", async () => {
    async function* throwing() {
      yield { delta: "x" };
      throw new Error("source broke");
    }
    const out = [];
    for await (const e of streamFromChatChunks(throwing(), makeCtx())) out.push(e);
    expect(out.find((e) => e.type === "error")).toBeDefined();
  });
});

describe("collectStream", () => {
  it("collects full text + usage", async () => {
    const src = chunks([{ delta: "a" }, { delta: "b" }, { delta: "c" }, { done: true, usage: { totalTokens: 10 } }]);
    const res = await collectStream(src, makeCtx());
    expect(res.text).toBe("abc");
    expect(res.usage?.totalTokens).toBe(10);
  });

  it("throws RequestError if ctx aborted", async () => {
    const ctrl = new AbortController();
    const ctx = makeCtx();
    ctx.signal = ctrl.signal;
    ctrl.abort();
    async function* src() {
      yield { delta: "x" } as ChatChunk;
    }
    await expect(collectStream(src(), ctx)).rejects.toBeInstanceOf(RequestError);
  });
});
