import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  buildProfile,
  profileFromDeclaration,
  profileToCapabilityTypes,
  normalizeOpenAIModelMetadata,
  normalizeGeminiModelMetadata,
  describeSource,
} from "../src/capability/CapabilityDetector.js";
import { ModelCapabilityRegistry } from "../src/capability/ModelCapabilityRegistry.js";
import { CapabilityCache } from "../src/capability/CapabilityCache.js";
import { CapabilityType } from "../src/core/types.js";
import type { RawModelMetadata } from "../src/capability/types.js";
import type { IProvider, ProviderCapabilityDeclaration } from "../src/core/types.js";

// ---------------------------------------------------------------------------
// Metadata-first detection (OpenRouter-style)
// ---------------------------------------------------------------------------

describe("CapabilityDetector — metadata-first", () => {
  it("detects vision from input_modalities=[text,image]", () => {
    const raw = normalizeOpenAIModelMetadata({
      id: "nvidia/nemotron-nano-12b-v2-vl:free",
      context_length: 131072,
      architecture: {
        modality: "text+image->text",
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
      },
      top_provider: { max_completion_tokens: 2048 },
      supported_parameters: ["tools", "response_format", "structured_outputs"],
    });
    const p = buildProfile("openrouter", raw.id, raw, "api");
    expect(p.vision).toBe(true);
    expect(p.chat).toBe(true);
    expect(p.supportsImages).toBe(true);
    expect(p.toolCalling).toBe(true);
    expect(p.structuredOutput).toBe(true);
    expect(p.supportsJSON).toBe(true);
    expect(p.contextWindow).toBe(131072);
    expect(p.maxOutputTokens).toBe(2048);
    expect(p.metadataSource).toBe("api");
    expect(profileToCapabilityTypes(p)).toContain(CapabilityType.Vision);
  });

  it("detects image generation from output_modalities=[image]", () => {
    const raw = normalizeOpenAIModelMetadata({
      id: "openai/dall-e-3",
      architecture: { input_modalities: ["text"], output_modalities: ["image"], modality: "text->image" },
    });
    const p = buildProfile("openrouter", raw.id, raw, "api");
    expect(p.imageGeneration).toBe(true);
  });

  it("detects audio input from input_modalities=[audio]", () => {
    const raw = normalizeOpenAIModelMetadata({
      id: "openai/whisper-1",
      architecture: { input_modalities: ["audio"], output_modalities: ["text"] },
    });
    const p = buildProfile("openrouter", raw.id, raw, "api");
    expect(p.audioInput).toBe(true);
  });

  it("detects Gemini style generation from supported_generation_methods", () => {
    const raw = normalizeGeminiModelMetadata({
      name: "models/gemini-2.5-flash",
      displayName: "Gemini 2.5 Flash",
      supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
      inputTokenLimit: 1048576,
      outputTokenLimit: 65536,
    });
    const p = buildProfile("gemini", raw.id, raw, "api");
    expect(p.chat).toBe(true);
    expect(p.contextWindow).toBe(1048576);
    expect(p.maxOutputTokens).toBe(65536);
  });

  it("detects Gemini embeddings from embedContent method", () => {
    const raw = normalizeGeminiModelMetadata({
      name: "models/text-embedding-004",
      supportedGenerationMethods: ["embedContent"],
      inputTokenLimit: 2048,
    });
    const p = buildProfile("gemini", raw.id, raw, "api");
    expect(p.embeddings).toBe(true);
  });

  it("bare OpenAI metadata (id only) falls back to heuristic for capabilities", () => {
    const raw = normalizeOpenAIModelMetadata({ id: "gpt-4o", object: "model", created: 1, owned_by: "openai" });
    const p = buildProfile("openai", raw.id, raw, "api");
    // No modality metadata — heuristic fills in vision for gpt-4o.
    expect(p.vision).toBe(true);
    expect(p.chat).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Universal heuristic — every major multimodal family
// ---------------------------------------------------------------------------

describe("CapabilityDetector — universal heuristic", () => {
  const visionModels = [
    "nvidia/nemotron-nano-12b-v2-vl:free",
    "qwen/qwen2.5-vl-72b-instruct",
    "qwen/qwen-vl-max",
    "mistralai/pixtral-12b",
    "opengvlab/internvl3-14b",
    "llava-hf/llava-1.5-7b",
    "openbmb/minicpm-v-2_6",
    "microsoft/florence-2",
    "deepseek-ai/janus-pro-7b",
    "allenai/molmo-7b",
    "meta-llama/llama-3.2-11b-vision-instruct",
    "microsoft/phi-3.5-vision-instruct",
    "deepseek/deepseek-vl2",
    "microsoft/kosmos-2",
    "THUDM/cogvlm2",
    "google/gemini-2.5-pro",
    "anthropic/claude-sonnet-4",
    "openai/gpt-4o",
    "openai/gpt-4.1",
  ];
  for (const id of visionModels) {
    it(`detects vision for ${id}`, () => {
      const p = buildProfile("any", id, undefined, "heuristic");
      expect(p.vision).toBe(true);
      expect(p.metadataSource).toBe("heuristic");
    });
  }

  it("does NOT flag text-only models as vision", () => {
    for (const id of ["openai/gpt-3.5-turbo", "meta-llama/llama-3.1-8b-instruct", "mistralai/mistral-7b-instruct", "deepseek/deepseek-chat"]) {
      const p = buildProfile("any", id, undefined, "heuristic");
      expect(p.vision).toBe(false);
    }
  });

  it("detects embeddings models and marks them non-chat", () => {
    const p = buildProfile("openai", "text-embedding-3-small", undefined, "heuristic");
    expect(p.embeddings).toBe(true);
    expect(p.chat).toBe(false);
  });

  it("detects reasoning models", () => {
    for (const id of ["openai/o1", "openai/o3-mini", "deepseek/deepseek-r1", "qwen/qwq-32b"]) {
      const p = buildProfile("any", id, undefined, "heuristic");
      expect(p.reasoning).toBe(true);
      expect(p.supportsThinking).toBe(true);
    }
  });

  it("detects image generation models", () => {
    for (const id of ["openai/dall-e-3", "stabilityai/sdxl", "black-forest-labs/flux-1.1-pro", "google/imagen-3"]) {
      const p = buildProfile("any", id, undefined, "heuristic");
      expect(p.imageGeneration).toBe(true);
    }
  });

  it("detects whisper as audio input", () => {
    const p = buildProfile("openai", "whisper-1", undefined, "heuristic");
    expect(p.audioInput).toBe(true);
  });

  it("grants chat to ordinary chat models by default (toolCalling/JSON require evidence)", () => {
    const p = buildProfile("any", "somevendor/some-chat-model", undefined, "heuristic");
    expect(p.chat).toBe(true);
    // toolCalling and supportsJSON are no longer assumed true for all models —
    // only when metadata or naming conventions indicate support.
    expect(p.toolCalling).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Declaration bridge
// ---------------------------------------------------------------------------

describe("CapabilityDetector — declaration bridge", () => {
  it("converts a legacy declaration into a profile", () => {
    const decl: ProviderCapabilityDeclaration = {
      providerId: "fake",
      modelId: "fake-model",
      label: "Fake",
      capabilities: [CapabilityType.Chat, CapabilityType.Filesystem],
      streaming: true,
      toolCalling: false,
      multimodal: false,
      embeddingSupport: false,
      imageGeneration: false,
      audioSupport: false,
      maxContext: 8192,
      metadata: {},
      resolvedAt: Date.now(),
    };
    const p = profileFromDeclaration(decl);
    expect(profileToCapabilityTypes(p)).toContain(CapabilityType.Filesystem);
    expect(profileToCapabilityTypes(p)).toContain(CapabilityType.Chat);
    expect(p.metadataSource).toBe("api");
  });
});

describe("describeSource", () => {
  it("renders human labels", () => {
    expect(describeSource("api")).toBe("API Metadata");
    expect(describeSource("heuristic")).toContain("Heuristic");
    expect(describeSource("cached")).toBe("Cache");
    expect(describeSource("manual")).toContain("Manual");
  });
});

// ---------------------------------------------------------------------------
// ModelCapabilityRegistry
// ---------------------------------------------------------------------------

function fakeProvider(id: string, raw?: RawModelMetadata[], declCaps?: CapabilityType[]): IProvider {
  return {
    id,
    label: id,
    capabilities: new Set(declCaps ?? [CapabilityType.Chat]),
    listModels: async () => [],
    hasModel: async () => true,
    hasCapability: (t) => (declCaps ?? [CapabilityType.Chat]).includes(t),
    declareCapability: async (modelId: string): Promise<ProviderCapabilityDeclaration> => ({
      providerId: id,
      modelId,
      label: modelId,
      capabilities: declCaps ?? [CapabilityType.Chat],
      streaming: true,
      toolCalling: false,
      multimodal: (declCaps ?? []).includes(CapabilityType.Vision),
      embeddingSupport: false,
      imageGeneration: false,
      audioSupport: false,
      maxContext: 8192,
      metadata: {},
      resolvedAt: Date.now(),
    }),
    chat: async function* () {},
    executeCapability: async () => { throw new Error("nope"); },
    health: async () => ({ providerId: id, ok: true }),
    discoverModels: raw ? async () => raw : undefined,
  };
}

describe("ModelCapabilityRegistry", () => {
  it("get() returns a heuristic profile synchronously for unknown models", () => {
    const reg = new ModelCapabilityRegistry();
    const p = reg.get("openrouter", "nvidia/nemotron-nano-12b-v2-vl:free");
    expect(p.vision).toBe(true);
    expect(p.metadataSource).toBe("heuristic");
  });

  it("refresh() builds API-sourced profiles from discoverModels metadata", async () => {
    const raw: RawModelMetadata[] = [
      normalizeOpenAIModelMetadata({
        id: "qwen/qwen2.5-vl-72b",
        context_length: 32768,
        architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
        supported_parameters: ["tools"],
      }),
    ];
    const provider = fakeProvider("openrouter", raw);
    const reg = new ModelCapabilityRegistry();
    reg.attachProviders({ get: (pid) => (pid === "openrouter" ? provider : undefined), listProviders: () => [provider] });

    const report = await reg.refresh();
    expect(report.providersScanned).toBe(1);
    expect(report.modelsDiscovered).toBe(1);
    expect(report.added).toBe(1);

    const p = reg.get("openrouter", "qwen/qwen2.5-vl-72b");
    expect(p.vision).toBe(true);
    expect(p.metadataSource).toBe("api");
    expect(p.contextWindow).toBe(32768);
  });

  it("ensure() upgrades heuristic profiles via the declaration bridge", async () => {
    const provider = fakeProvider("fake", undefined, [CapabilityType.Chat, CapabilityType.Filesystem]);
    const reg = new ModelCapabilityRegistry();
    reg.attachProviders({ get: () => provider, listProviders: () => [provider] });

    const p = await reg.ensure("fake", "fake-model");
    expect(p.nativeCapabilities).toContain(CapabilityType.Filesystem);
    expect(p.metadataSource).toBe("api");
  });

  it("manual overrides win over everything and survive refresh", async () => {
    const raw: RawModelMetadata[] = [normalizeOpenAIModelMetadata({ id: "m1", architecture: { input_modalities: ["text"] } })];
    const provider = fakeProvider("p", raw);
    const reg = new ModelCapabilityRegistry();
    reg.attachProviders({ get: () => provider, listProviders: () => [provider] });

    const manual = buildProfile("p", "m1", undefined, "manual");
    manual.vision = true;
    reg.registerManual(manual);

    await reg.refresh();
    const p = reg.get("p", "m1");
    expect(p.vision).toBe(true);
    expect(p.metadataSource).toBe("manual");
  });

  it("refresh() removes models the provider no longer offers", async () => {
    let models: RawModelMetadata[] = [normalizeOpenAIModelMetadata({ id: "old-model" })];
    const provider: IProvider = { ...fakeProvider("p"), discoverModels: async () => models };
    const reg = new ModelCapabilityRegistry();
    reg.attachProviders({ get: () => provider, listProviders: () => [provider] });

    await reg.refresh();
    expect(reg.get("p", "old-model").metadataSource).toBe("api");

    models = []; // provider drops the model
    const report = await reg.refresh();
    expect(report.removed).toBe(1);
  });

  it("invalidate() forces re-derivation on next get", async () => {
    const reg = new ModelCapabilityRegistry();
    reg.get("p", "m");
    reg.invalidate("p", "m");
    const p = reg.get("p", "m");
    expect(p.metadataSource).toBe("heuristic");
  });
});

// ---------------------------------------------------------------------------
// CapabilityCache persistence
// ---------------------------------------------------------------------------

describe("CapabilityCache", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mindi-capcache-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists profiles across instances", () => {
    const file = path.join(tmpDir, "capabilities.json");
    const cache1 = new CapabilityCache(file);
    const profile = buildProfile("openrouter", "qwen/qwen2.5-vl", undefined, "api");
    cache1.set(profile);
    cache1.save();

    const cache2 = new CapabilityCache(file);
    const loaded = cache2.get("openrouter:qwen/qwen2.5-vl");
    expect(loaded).toBeDefined();
    expect(loaded!.vision).toBe(true);
    expect(loaded!.metadataSource).toBe("cached");
  });

  it("in-memory cache (null file) works without disk", () => {
    const cache = new CapabilityCache(null);
    const profile = buildProfile("p", "m", undefined, "heuristic");
    cache.set(profile);
    expect(cache.get("p:m")).toBeDefined();
    cache.save(); // no-op, must not throw
  });
});

// ---------------------------------------------------------------------------
// Registry backed by a persistent cache (end-to-end)
// ---------------------------------------------------------------------------

describe("ModelCapabilityRegistry + persistent cache", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mindi-capreg-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reconnecting is instantaneous (profiles load from cache)", async () => {
    const file = path.join(tmpDir, "capabilities.json");
    const raw: RawModelMetadata[] = [
      normalizeOpenAIModelMetadata({
        id: "nvidia/nemotron-nano-12b-v2-vl:free",
        architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      }),
    ];
    const provider = fakeProvider("openrouter", raw);

    // First boot: refresh from API metadata.
    const reg1 = new ModelCapabilityRegistry(new CapabilityCache(file));
    reg1.attachProviders({ get: () => provider, listProviders: () => [provider] });
    await reg1.refresh();
    expect(reg1.get("openrouter", "nvidia/nemotron-nano-12b-v2-vl:free").vision).toBe(true);

    // Second boot: no providers attached — profile still known from cache.
    const reg2 = new ModelCapabilityRegistry(new CapabilityCache(file));
    const p = reg2.get("openrouter", "nvidia/nemotron-nano-12b-v2-vl:free");
    expect(p.vision).toBe(true);
    expect(p.metadataSource).toBe("cached");
  });
});
