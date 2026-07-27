import { describe, it, expect } from "vitest";
import { MemoryLayer, InMemoryMemoryStore, truncateHistory } from "../src/memory/MemoryLayer.js";
import { SessionManager } from "../src/session/SessionManager.js";
import { SessionError } from "../src/core/errors.js";
import type { ChatMessage } from "../src/core/types.js";

describe("MemoryLayer", () => {
  it("appends and loads messages", async () => {
    const m = new MemoryLayer(new InMemoryMemoryStore(), 50);
    await m.remember("s1", [{ role: "user", content: "hi" }]);
    await m.remember("s1", [{ role: "assistant", content: "hello" }]);
    const hist = await m.recall("s1");
    expect(hist).toHaveLength(2);
  });

  it("applies sliding-window truncation over the limit", async () => {
    const m = new MemoryLayer(new InMemoryMemoryStore(), 3);
    for (let i = 0; i < 10; i++) {
      await m.remember("s1", [{ role: "user", content: String(i) }]);
    }
    const hist = await m.recall("s1");
    expect(hist.length).toBeLessThanOrEqual(3);
  });

  it("forgets a session", async () => {
    const m = new MemoryLayer(new InMemoryMemoryStore(), 50);
    await m.remember("s1", [{ role: "user", content: "x" }]);
    await m.forget("s1");
    expect(await m.recall("s1")).toEqual([]);
  });
});

describe("truncateHistory", () => {
  it("preserves the leading system message even when over limit", () => {
    const sys: ChatMessage = { role: "system", content: "sys" };
    const msgs: ChatMessage[] = [sys, ...Array.from({ length: 10 }, (_, i) => ({ role: "user" as const, content: String(i) }))];
    const out = truncateHistory(msgs, 5);
    expect(out[0]).toBe(sys);
    expect(out.length).toBe(5);
    expect(out[out.length - 1]!.content).toBe("9");
  });

  it("returns all messages when under limit", () => {
    const out = truncateHistory([{ role: "user", content: "hi" }], 5);
    expect(out).toHaveLength(1);
  });
});

describe("SessionManager", () => {
  it("creates a session with a system prompt seeded in memory", async () => {
    const sm = new SessionManager();
    const s = sm.create({ providerId: "openai", modelId: "gpt-4o-mini", systemPrompt: "be terse" });
    expect(s.id.length).toBeGreaterThan(0);
    expect(s.providerId).toBe("openai");
    const hist = await sm.recall(s.id);
    expect(hist[0]).toEqual({ role: "system", content: "be terse" });
  });

  it("get throws SessionError for unknown session", () => {
    const sm = new SessionManager();
    expect(() => sm.get("nope")).toThrow(SessionError);
  });

  it("setModel updates the chosen primary model", () => {
    const sm = new SessionManager();
    const s = sm.create({ providerId: "openai", modelId: "gpt-4o-mini" });
    sm.setModel(s.id, "gemini", "gemini-1.5-flash");
    const updated = sm.get(s.id);
    expect(updated.providerId).toBe("gemini");
    expect(updated.modelId).toBe("gemini-1.5-flash");
  });

  it("destroy clears session and memory", async () => {
    const sm = new SessionManager();
    const s = sm.create({ providerId: "openai", modelId: "gpt-4o-mini" });
    await sm.remember(s.id, [{ role: "user", content: "hi" }]);
    await sm.destroy(s.id);
    expect(() => sm.get(s.id)).toThrow(SessionError);
    expect(await sm.recall(s.id)).toEqual([]);
  });

  it("restore seeds a session with a known id and prior history", async () => {
    const sm = new SessionManager();
    const s = sm.restore(
      "ws-session-1",
      { providerId: "custom", modelId: "gemma-4-31b-it" },
      [
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
      ],
    );
    expect(s.id).toBe("ws-session-1");
    expect(s.providerId).toBe("custom");
    expect(s.modelId).toBe("gemma-4-31b-it");
    const hist = await sm.recall(s.id);
    expect(hist.map((m) => m.content)).toContain("earlier question");
    expect(hist.map((m) => m.content)).toContain("earlier answer");
  });

  it("restore is idempotent — returns the existing session unchanged", async () => {
    const sm = new SessionManager();
    const first = sm.restore("s1", { providerId: "a", modelId: "m1" }, [{ role: "user", content: "x" }]);
    const second = sm.restore("s1", { providerId: "b", modelId: "m2" }, []);
    expect(second).toBe(first);
    expect(second.providerId).toBe("a"); // unchanged
  });
});
