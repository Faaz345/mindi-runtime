import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WorkspaceStore } from "../src/workspace/WorkspaceStore.js";
import { ProjectMemoryManager } from "../src/workspace/ProjectMemory.js";
import { ContextCompressor } from "../src/workspace/ContextCompressor.js";
import { SessionSearch } from "../src/workspace/SessionSearch.js";
import { WorkspaceSessionManager } from "../src/workspace/WorkspaceSessionManager.js";
import { SlashCommandRegistry } from "../src/workspace/SlashCommands.js";
import type { RuntimeCommandBridge } from "../src/workspace/SlashCommands.js";
import { ModelCapabilityRegistry } from "../src/capability/ModelCapabilityRegistry.js";
import { FileMemoryStore } from "../src/workspace/FileMemoryStore.js";
import type { AvailabilityProbe } from "../src/workspace/WorkspaceSessionManager.js";
import type { ChatMessage } from "../src/core/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mindi-workspace-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSystem(root: string) {
  const store = new WorkspaceStore(root);
  const projectMemory = new ProjectMemoryManager(store);
  const compressor = new ContextCompressor(store);
  const search = new SessionSearch(store);
  const sessionManager = new WorkspaceSessionManager(store, projectMemory, compressor, search);
  const slash = new SlashCommandRegistry(sessionManager);
  return { store, projectMemory, compressor, search, sessionManager, slash };
}

const fakeProbe: AvailabilityProbe = {
  isProviderAvailable: () => true,
  isModelAvailable: () => true,
  listModels: async () => ["gpt-4o-mini"],
  fallbackProviderId: () => undefined,
};

function userMsg(text: string): ChatMessage {
  return { role: "user", content: text };
}
function assistantMsg(text: string): ChatMessage {
  return { role: "assistant", content: text };
}

describe("WorkspaceStore", () => {
  it("creates the .mindi folder scaffold", () => {
    const store = new WorkspaceStore(tmpDir);
    expect(store.exists()).toBe(false);
    store.initWorkspace();
    expect(store.exists()).toBe(true);
    expect(fs.existsSync(store.paths.sessions)).toBe(true);
    expect(fs.existsSync(store.paths.memory)).toBe(true);
    expect(fs.existsSync(store.paths.cache)).toBe(true);
    expect(fs.existsSync(store.paths.logs)).toBe(true);
  });

  it("round-trips workspace meta, sessions, and project memory", () => {
    const store = new WorkspaceStore(tmpDir);
    store.initWorkspace();
    const meta = store.readWorkspace();
    expect(meta.version).toBe(1);
    expect(meta.sessions).toEqual([]);

    store.writeSession({
      id: "s1",
      title: "test",
      createdAt: 1,
      updatedAt: 2,
      openedAt: 2,
      providerId: "openai",
      modelId: "gpt-4o-mini",
      messages: [userMsg("hi")],
      timeline: [],
      workingFiles: [],
      attachments: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, requestCount: 0 },
      meta: {},
      tags: [],
      archived: false,
      pinned: false,
    });
    const rec = store.readSession("s1");
    expect(rec?.title).toBe("test");
    expect(rec?.messages).toHaveLength(1);

    const pm = store.readProjectMemory();
    expect(pm.overview).toBe("");
    pm.overview = "a project";
    store.writeProjectMemory(pm);
    expect(store.readProjectMemory().overview).toBe("a project");
  });

  it("per-directory isolation: another root has no access to this workspace", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "mindi-other-"));
    try {
      const storeA = new WorkspaceStore(tmpDir);
      storeA.initWorkspace();
      const storeB = new WorkspaceStore(other);
      expect(storeB.exists()).toBe(false);
      expect(storeB.listSessionFiles()).toEqual([]);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("WorkspaceSessionManager", () => {
  it("creates and lists sessions sorted by updated time", () => {
    const { sessionManager: sm } = makeSystem(tmpDir);
    const a = sm.create({ providerId: "openai", modelId: "gpt-4o" });
    const b = sm.create({ providerId: "gemini", modelId: "gemini-1.5" });
    const list = sm.listSessions();
    expect(list).toHaveLength(2);
    // newest first
    expect(list[0]!.id).toBe(b.id);
    expect(list[1]!.id).toBe(a.id);
  });

  it("auto-restores the last active session", async () => {
    const sys1 = makeSystem(tmpDir);
    const s = sys1.sessionManager.create({ providerId: "openai", modelId: "gpt-4o" });
    sys1.sessionManager.remember(s.id, [userMsg("hello"), assistantMsg("hi there")]);
    // simulate relaunch: new manager over the same .mindi folder
    const sys2 = makeSystem(tmpDir);
    const restored = await sys2.sessionManager.restore(fakeProbe, {
      providerId: "openai",
      modelId: "gpt-4o-mini",
    });
    expect(restored.session.id).toBe(s.id);
    expect(restored.providerAvailable).toBe(true);
    const hist = sys2.sessionManager.recall(s.id);
    expect(hist.map((m) => m.content)).toContain("hello");
    expect(hist.map((m) => m.content)).toContain("hi there");
  });

  it("creates a fresh session when no active session exists", async () => {
    const { sessionManager: sm } = makeSystem(tmpDir);
    const restored = await sm.restore(fakeProbe, { providerId: "openai", modelId: "gpt-4o" });
    expect(restored.session).toBeDefined();
    expect(restored.session.providerId).toBe("openai");
  });

  it("falls back to another provider when saved provider is unavailable", async () => {
    const sys1 = makeSystem(tmpDir);
    const s = sys1.sessionManager.create({ providerId: "openai", modelId: "gpt-4o" });
    // relaunch with a probe that says openai is gone, gemini is available
    const sys2 = makeSystem(tmpDir);
    const probe: AvailabilityProbe = {
      isProviderAvailable: (id) => id === "gemini",
      isModelAvailable: () => true,
      listModels: async () => ["gemini-1.5"],
      fallbackProviderId: (unavail) => (unavail === "openai" ? "gemini" : undefined),
    };
    const restored = await sys2.sessionManager.restore(probe, { providerId: "openai", modelId: "gpt-4o" });
    expect(restored.providerAvailable).toBe(false);
    expect(restored.effectiveProviderId).toBe("gemini");
    expect(restored.notice).toContain("openai");
  });

  it("switch, rename, clear, archive, delete", () => {
    const { sessionManager: sm } = makeSystem(tmpDir);
    const a = sm.create({ providerId: "openai", modelId: "m" });
    const b = sm.create({ providerId: "openai", modelId: "m" });
    sm.remember(a.id, [userMsg("in a")]);
    sm.remember(b.id, [userMsg("in b")]);

    sm.switch(a.id);
    expect(sm.getActiveId()).toBe(a.id);
    expect(sm.recall(a.id).map((m) => m.content)).toContain("in a");

    const renamed = sm.rename(a.id, "my session");
    expect(renamed.title).toBe("my session");

    const cleared = sm.clear(a.id);
    expect(cleared.messages).toHaveLength(0);

    sm.archive(b.id);
    expect(sm.listSessions({ includeArchived: false }).find((s) => s.id === b.id)).toBeUndefined();
    expect(sm.listSessions({ includeArchived: true }).find((s) => s.id === b.id)).toBeDefined();

    expect(sm.delete(a.id)).toBe(true);
    expect(sm.get(a.id)).toBeNull();
  });

  it("derives title from the first user message", () => {
    const { sessionManager: sm } = makeSystem(tmpDir);
    const s = sm.create({ providerId: "openai", modelId: "m" });
    sm.remember(s.id, [userMsg("How do I parse JSON in TypeScript?")]);
    const rec = sm.get(s.id)!;
    expect(rec.title).toContain("parse JSON");
  });

  it("auto-compresses long history into a rolling summary", () => {
    const { sessionManager: sm, compressor } = makeSystem(tmpDir);
    // shrink the window for the test
    (sm as unknown as { meta: { settings: { maxHistoryMessages: number } } }).meta.settings.maxHistoryMessages = 4;
    const s = sm.create({ providerId: "openai", modelId: "m" });
    for (let i = 0; i < 10; i++) {
      sm.remember(s.id, [userMsg(`turn ${i}`), assistantMsg(`reply ${i}`)]);
    }
    const rec = sm.get(s.id)!;
    // verbatim history should be bounded
    expect(rec.messages.length).toBeLessThanOrEqual(4);
    // a rolling summary should exist
    const summary = compressor.getSummary(s.id);
    expect(summary).toBeDefined();
    expect(summary!.foldedMessageCount).toBeGreaterThan(0);

    // recall injects the summary as a system message
    const recalled = sm.recall(s.id);
    const sysMsg = recalled.find((m) => m.role === "system" && typeof m.content === "string" && m.content.includes("Summary of earlier"));
    expect(sysMsg).toBeDefined();
  });

  it("tracks usage and working files", () => {
    const { sessionManager: sm } = makeSystem(tmpDir);
    const s = sm.create({ providerId: "openai", modelId: "m" });
    sm.addUsage(s.id, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    sm.addUsage(s.id, { promptTokens: 20, completionTokens: 10, totalTokens: 30 });
    sm.addWorkingFile(s.id, "/a/b.ts");
    const rec = sm.get(s.id)!;
    expect(rec.usage.totalTokens).toBe(45);
    expect(rec.usage.requestCount).toBe(2);
    expect(rec.workingFiles).toContain("/a/b.ts");
  });
});

describe("ProjectMemory", () => {
  it("persists decisions, conventions, commands across instances", () => {
    const sys1 = makeSystem(tmpDir);
    sys1.projectMemory.setOverview("a test project");
    sys1.projectMemory.addTechStack({ name: "TypeScript", category: "language", version: "5.6" });
    sys1.projectMemory.addDecision({ title: "use vitest", decision: "vitest for tests" });
    sys1.projectMemory.observeCommand("npm test");
    sys1.projectMemory.observeCommand("npm test");
    sys1.projectMemory.markFileImportant("src/index.ts", "entry point");

    // relaunch
    const sys2 = makeSystem(tmpDir);
    const pm = sys2.projectMemory;
    expect(pm.get().overview).toBe("a test project");
    expect(pm.get().techStack[0]?.name).toBe("TypeScript");
    expect(pm.get().decisions[0]?.title).toBe("use vitest");
    expect(pm.topCommands(1)[0]?.useCount).toBe(2);
    expect(pm.get().importantFiles[0]?.path).toBe("src/index.ts");
    expect(pm.hasContent()).toBe(true);
  });

  it("serializes to a compact prompt fragment", () => {
    const { projectMemory: pm } = makeSystem(tmpDir);
    pm.setOverview("my project");
    pm.addTechStack({ name: "React", category: "framework" });
    pm.addGoal("ship v1");
    const frag = pm.toPromptFragment();
    expect(frag).toContain("my project");
    expect(frag).toContain("React");
    expect(frag).toContain("ship v1");
  });
});

describe("SessionSearch", () => {
  it("finds sessions by keyword in message bodies and titles", () => {
    const { sessionManager: sm, search } = makeSystem(tmpDir);
    const a = sm.create({ providerId: "openai", modelId: "m" });
    sm.remember(a.id, [userMsg("how to parse JSON with TypeScript")]);
    const b = sm.create({ providerId: "openai", modelId: "m" });
    sm.remember(b.id, [userMsg("deploy to vercel")]);

    const results = search.search({ query: "vercel" });
    expect(results).toHaveLength(1);
    expect(results[0]!.sessionId).toBe(b.id);

    const results2 = search.search({ query: "JSON" });
    expect(results2[0]!.sessionId).toBe(a.id);
  });

  it("filters by provider and model", () => {
    const { sessionManager: sm, search } = makeSystem(tmpDir);
    const a = sm.create({ providerId: "openai", modelId: "gpt-4o" });
    const b = sm.create({ providerId: "gemini", modelId: "gemini-1.5" });
    sm.remember(a.id, [userMsg("hello")]);
    sm.remember(b.id, [userMsg("hello")]);

    const results = search.search({ providerId: "gemini" });
    expect(results.every((r) => r.summary.providerId === "gemini")).toBe(true);
    expect(results.some((r) => r.sessionId === b.id)).toBe(true);
  });

  it("quickSwitch returns the best match", () => {
    const { sessionManager: sm, search } = makeSystem(tmpDir);
    const a = sm.create({ providerId: "openai", modelId: "m" });
    sm.remember(a.id, [userMsg("setup docker compose")]);
    const best = search.quickSwitch("docker");
    expect(best?.sessionId).toBe(a.id);
  });
});

describe("SlashCommands", () => {
  it("/new creates a fresh session", async () => {
    const { slash, sessionManager: sm } = makeSystem(tmpDir);
    const first = sm.create({ providerId: "openai", modelId: "m" });
    const res = await slash.dispatch("/new");
    expect(res.handled).toBe(true);
    expect(res.switchToSessionId).toBeDefined();
    expect(res.switchToSessionId).not.toBe(first.id);
  });

  it("/switch by number restores a session", async () => {
    const { slash, sessionManager: sm } = makeSystem(tmpDir);
    sm.create({ providerId: "openai", modelId: "m" });
    const b = sm.create({ providerId: "openai", modelId: "m" });
    const res = await slash.dispatch("/switch 1");
    expect(res.handled).toBe(true);
    expect(res.switchToSessionId).toBe(b.id);
  });

  it("/rename updates the title", async () => {
    const { slash, sessionManager: sm } = makeSystem(tmpDir);
    const s = sm.create({ providerId: "openai", modelId: "m" });
    sm.switch(s.id);
    const res = await slash.dispatch(`/rename my cool session`);
    expect(res.handled).toBe(true);
    expect(res.message).toContain("my cool session");
    expect(sm.get(s.id)!.title).toBe("my cool session");
  });

  it("/clear wipes history but keeps the session", async () => {
    const { slash, sessionManager: sm } = makeSystem(tmpDir);
    const s = sm.create({ providerId: "openai", modelId: "m" });
    sm.switch(s.id);
    sm.remember(s.id, [userMsg("hi"), assistantMsg("hello")]);
    const res = await slash.dispatch("/clear");
    expect(res.handled).toBe(true);
    expect(sm.get(s.id)!.messages).toHaveLength(0);
  });

  it("/sessions lists all conversations", async () => {
    const { slash, sessionManager: sm } = makeSystem(tmpDir);
    sm.create({ providerId: "openai", modelId: "gpt-4o" });
    sm.create({ providerId: "gemini", modelId: "gemini-1.5" });
    const res = await slash.dispatch("/sessions");
    expect(res.handled).toBe(true);
    expect(res.message).toContain("gpt-4o");
    expect(res.message).toContain("gemini-1.5");
  });

  it("/resume continues the most recent session", async () => {
    const { slash, sessionManager: sm } = makeSystem(tmpDir);
    const a = sm.create({ providerId: "openai", modelId: "m" });
    sm.remember(a.id, [userMsg("first")]);
    const b = sm.create({ providerId: "openai", modelId: "m" });
    sm.remember(b.id, [userMsg("second")]);
    const res = await slash.dispatch("/resume");
    expect(res.handled).toBe(true);
    expect(res.switchToSessionId).toBe(b.id);
  });

  it("non-slash input returns handled=false", async () => {
    const { slash } = makeSystem(tmpDir);
    const res = await slash.dispatch("just a normal prompt");
    expect(res.handled).toBe(false);
  });

  it("unknown command returns a helpful message", async () => {
    const { slash } = makeSystem(tmpDir);
    const res = await slash.dispatch("/nonexistent");
    expect(res.handled).toBe(false);
    expect(res.message).toContain("Unknown command");
  });

  it("/help lists all commands", async () => {
    const { slash } = makeSystem(tmpDir);
    const res = await slash.dispatch("/help");
    expect(res.handled).toBe(true);
    expect(res.message).toContain("/new");
    expect(res.message).toContain("/switch");
    expect(res.message).toContain("/sessions");
    expect(res.message).toContain("/model");
    expect(res.message).toContain("/refresh-models");
  });
});

describe("SlashCommands — capability commands", () => {
  function makeBridge(sessionManager: WorkspaceSessionManager): RuntimeCommandBridge {
    const registry = new ModelCapabilityRegistry();
    return {
      getCurrentSelection: () => {
        const active = sessionManager.getActive();
        return active
          ? { providerId: active.providerId, modelId: active.modelId }
          : { providerId: "openrouter", modelId: "nvidia/nemotron-nano-12b-v2-vl:free" };
      },
      getProviderLabel: (id) => (id === "openrouter" ? "OpenRouter" : id),
      getProfile: (pid, mid) => registry.get(pid, mid),
      refreshModels: async () => ({
        providersScanned: 2,
        modelsDiscovered: 150,
        capabilitiesUpdated: 3,
        cacheRefreshed: true,
        added: 5,
        removed: 1,
        preserved: 144,
        errors: {},
      }),
    };
  }

  it("/model shows the current model with detected capabilities", async () => {
    const { sessionManager: sm } = makeSystem(tmpDir);
    const slash = new SlashCommandRegistry(sm, makeBridge(sm));
    const res = await slash.dispatch("/model");
    expect(res.handled).toBe(true);
    expect(res.message).toContain("nvidia/nemotron-nano-12b-v2-vl:free");
    expect(res.message).toContain("OpenRouter");
    expect(res.message).toContain("✓ Chat");
    expect(res.message).toContain("✓ Vision");
    expect(res.message).toContain("Detected From:");
  });

  it("/model reports unavailable bridge gracefully", async () => {
    const { slash } = makeSystem(tmpDir); // no bridge
    const res = await slash.dispatch("/model");
    expect(res.handled).toBe(true);
    expect(res.message).toContain("unavailable");
  });

  it("/refresh-models prints the refresh report", async () => {
    const { sessionManager: sm } = makeSystem(tmpDir);
    const slash = new SlashCommandRegistry(sm, makeBridge(sm));
    const res = await slash.dispatch("/refresh-models");
    expect(res.handled).toBe(true);
    expect(res.message).toContain("Providers scanned:      2");
    expect(res.message).toContain("Models discovered:      150");
    expect(res.message).toContain("Capabilities updated:   3");
    expect(res.message).toContain("Cache refreshed:        yes");
  });
});

describe("FileMemoryStore", () => {
  it("persists messages to disk across instances", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const store1 = new FileMemoryStore({ sessionsDir });
    await store1.append("s1", [userMsg("hello"), assistantMsg("hi")]);
    expect(await store1.count("s1")).toBe(2);

    // new instance over the same dir
    const store2 = new FileMemoryStore({ sessionsDir });
    expect(await store2.count("s1")).toBe(2);
    const loaded = await store2.load("s1");
    expect(loaded.map((m) => m.content)).toEqual(["hello", "hi"]);
  });

  it("clear removes the session file", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const store = new FileMemoryStore({ sessionsDir });
    await store.append("s1", [userMsg("x")]);
    await store.clear("s1");
    expect(await store.count("s1")).toBe(0);
  });
});
