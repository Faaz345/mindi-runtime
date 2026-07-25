/**
 * Tests for the onboarding system: config persistence, validation,
 * and non-interactive setup.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  createEmptyConfig,
  loadConfig,
  saveConfig,
  configExists,
  configFilePath,
  toRuntimeConfig,
} from "../src/cli/onboarding-config.js";
import { filterChatModels, modelLabel } from "../src/cli/validator.js";
import type { ProviderModel } from "../src/core/types.js";
import { CapabilityTypes as Caps } from "../src/index.js";
import { bootRuntime } from "../src/cli/runtime-loader.js";

describe("Onboarding: Config Persistence", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "mindi-onboard-"));
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("creates an empty config with defaults", () => {
    const cfg = createEmptyConfig();
    expect(cfg.version).toBe(1);
    expect(cfg.onboarded).toBe(false);
    expect(cfg.primaryProvider).toBe("");
    expect(cfg.primaryModel).toBe("");
    expect(cfg.preferDeterministicTools).toBe(true);
    expect(cfg.sandbox.allowedRoots).toEqual([]);
  });

  it("saves and loads config from file", () => {
    const cfg = createEmptyConfig();
    cfg.primaryProvider = "openai";
    cfg.primaryModel = "gpt-4o-mini";
    cfg.onboarded = true;
    cfg.providers.openai = { apiKey: "sk-test", baseUrl: "https://api.openai.com/v1", orgId: "" };

    saveConfig(cfg, tmp);

    expect(configExists(tmp)).toBe(true);
    expect(fs.existsSync(configFilePath(tmp))).toBe(true);

    const loaded = loadConfig(tmp);
    expect(loaded).not.toBeNull();
    expect(loaded!.primaryProvider).toBe("openai");
    expect(loaded!.primaryModel).toBe("gpt-4o-mini");
    expect(loaded!.onboarded).toBe(true);
    expect(loaded!.providers.openai?.apiKey).toBe("sk-test");
  });

  it("returns null when config file does not exist", () => {
    expect(loadConfig(tmp)).toBeNull();
  });

  it("configExists returns false when no config file", () => {
    expect(configExists(tmp)).toBe(false);
  });

  it("creates directory structure on save", () => {
    const cfg = createEmptyConfig();
    saveConfig(cfg, tmp);
    expect(fs.existsSync(path.join(tmp, ".mindi"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, ".mindi", "config.json"))).toBe(true);
  });

  it("updates updatedAt on save", async () => {
    const cfg = createEmptyConfig();
    const origTime = cfg.updatedAt;
    // Ensure time difference
    await new Promise((r) => setTimeout(r, 10));
    saveConfig(cfg, tmp);
    const loaded = loadConfig(tmp)!;
    expect(loaded.updatedAt).toBeGreaterThanOrEqual(origTime);
  });

  it("converts to RuntimeConfig correctly", () => {
    const cfg = createEmptyConfig();
    cfg.primaryProvider = "gemini";
    cfg.primaryModel = "gemini-1.5-flash";
    cfg.providers.gemini = { apiKey: "test-key" };
    cfg.sandbox.allowedRoots = ["/tmp"];
    cfg.sandbox.allowedCommands = ["git"];
    cfg.sandbox.allowNetwork = true;

    const rc = toRuntimeConfig(cfg);
    expect(rc.defaultProviderId).toBe("gemini");
    expect(rc.defaultModel).toBe("gemini-1.5-flash");
    expect(rc.providers?.gemini?.apiKey).toBe("test-key");
    expect(rc.sandbox?.allowedRoots).toEqual(["/tmp"]);
    expect(rc.sandbox?.allowedCommands).toEqual(["git"]);
    expect(rc.sandbox?.allowNetwork).toBe(true);
  });
});

describe("Onboarding: Model Filtering", () => {
  it("filters to chat-capable models only", () => {
    const models: ProviderModel[] = [
      { id: "gpt-4o", label: "GPT-4o", capabilities: [Caps.Chat, Caps.Vision] },
      { id: "text-embedding-3", label: "Embedding", capabilities: [Caps.Embeddings] },
      { id: "dall-e-3", label: "DALL-E 3", capabilities: [Caps.ImageGeneration] },
      { id: "gpt-4o-mini", label: "GPT-4o Mini", capabilities: [Caps.Chat] },
      { id: "unknown-model", label: "Unknown", capabilities: [] },
    ];

    const filtered = filterChatModels(models);
    expect(filtered).toHaveLength(3); // gpt-4o, gpt-4o-mini, unknown-model
    expect(filtered.map((m) => m.id)).toContain("gpt-4o");
    expect(filtered.map((m) => m.id)).toContain("gpt-4o-mini");
    expect(filtered.map((m) => m.id)).not.toContain("text-embedding-3");
    expect(filtered.map((m) => m.id)).not.toContain("dall-e-3");
  });

  it("includes models with empty capabilities (assumed chat)", () => {
    const models: ProviderModel[] = [
      { id: "custom-model", label: "Custom", capabilities: [] },
    ];
    expect(filterChatModels(models)).toHaveLength(1);
  });
});

describe("Onboarding: Model Labels", () => {
  it("formats model label with capabilities", () => {
    const model: ProviderModel = {
      id: "gpt-4o",
      label: "GPT-4o",
      capabilities: [Caps.Chat, Caps.Vision],
      contextWindow: 128000,
    };
    const label = modelLabel(model);
    expect(label).toContain("gpt-4o");
    expect(label).toContain("chat");
    expect(label).toContain("vision");
    expect(label).toContain("128,000");
  });

  it("formats model label without capabilities", () => {
    const model: ProviderModel = { id: "custom", label: "Custom", capabilities: [] };
    const label = modelLabel(model);
    expect(label).toBe("custom");
  });
});

describe("Onboarding: Runtime Loader Integration", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "mindi-load-"));
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("bootRuntime loads .mindi/config.json when present", () => {
    const cfg = createEmptyConfig();
    cfg.primaryProvider = "openai";
    cfg.primaryModel = "gpt-4o-mini";
    cfg.providers.openai = { apiKey: "sk-test-loader", baseUrl: "https://api.openai.com/v1", orgId: "" };
    cfg.onboarded = true;
    saveConfig(cfg, tmp);

    // Change cwd to tmp for this test
    const origCwd = process.cwd();
    process.chdir(tmp);
    try {
      const rt = bootRuntime();
      expect(rt.config.defaultProviderId).toBe("openai");
      expect(rt.config.defaultModel).toBe("gpt-4o-mini");
      expect(rt.config.providers.openai.apiKey).toBe("sk-test-loader");
    } finally {
      process.chdir(origCwd);
    }
  });
});
