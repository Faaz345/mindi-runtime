/**
 * CapabilityDetector — pure functions that convert raw model metadata into a
 * ModelCapabilityProfile.
 *
 * Detection strategy (in priority order):
 *
 *   1. **API metadata** — if the provider returned modality/architecture/
 *      generation-method/parameter metadata, capabilities are derived
 *      directly from it. NO hardcoded model names are consulted.
 *
 *   2. **Universal heuristic** — only used to fill gaps the metadata left
 *      undetermined. Recognizes naming conventions across every major vendor
 *      (GPT, Claude, Gemini, Qwen-VL, Pixtral, InternVL, LLaVA, MiniCPM-V,
 *      Florence, Janus, Molmo, Phi Vision, Llama Vision, Nemotron VL,
 *      DeepSeek VL, Kosmos, CogVLM, ...).
 *
 * Hardcoded model names are a last-resort fallback, never the primary
 * detection mechanism.
 */

import type { CapabilityType, ProviderCapabilityDeclaration } from "../core/types.js";
import { CapabilityType as Cap } from "../core/types.js";
import type { MetadataSource, ModelCapabilityProfile, RawModelMetadata } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Composite key for a (provider, model) pair. */
export function profileKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/** Build a profile from raw metadata, filling gaps with the heuristic. */
export function buildProfile(
  provider: string,
  model: string,
  raw?: RawModelMetadata,
  source: MetadataSource = raw ? "api" : "heuristic",
): ModelCapabilityProfile {
  const profile = emptyProfile(provider, model);
  if (raw) applyMetadata(profile, raw);
  applyHeuristic(profile, model);
  finalize(profile);
  profile.metadataSource = source;
  profile.resolvedAt = Date.now();
  return profile;
}

/**
 * Bridge: convert a legacy ProviderCapabilityDeclaration into a profile.
 * Used for providers that don't yet expose raw metadata discovery.
 */
export function profileFromDeclaration(decl: ProviderCapabilityDeclaration): ModelCapabilityProfile {
  const p = emptyProfile(decl.providerId, decl.modelId);
  const caps = new Set(decl.capabilities);

  p.chat = caps.has(Cap.Chat) || true;
  p.vision = caps.has(Cap.Vision) || decl.multimodal;
  p.imageGeneration = caps.has(Cap.ImageGeneration) || decl.imageGeneration;
  p.embeddings = caps.has(Cap.Embeddings) || decl.embeddingSupport;
  p.audioInput = caps.has(Cap.Audio) || decl.audioSupport;
  p.audioOutput = decl.audioSupport;
  p.toolCalling = decl.toolCalling;
  p.functionCalling = decl.toolCalling;
  p.structuredOutput = decl.toolCalling;
  p.streaming = decl.streaming;
  p.supportsImages = p.vision;
  p.supportsFiles = p.vision;
  p.supportsJSON = decl.toolCalling;
  p.supportsWebSearch = caps.has(Cap.WebSearch);
  p.supportsComputerUse = caps.has(Cap.Browser);
  p.contextWindow = decl.maxContext;
  p.maxOutputTokens = decl.maxOutputTokens;
  p.label = decl.label;

  finalize(p, decl.capabilities);
  p.metadataSource = "api";
  p.resolvedAt = decl.resolvedAt;
  return p;
}

/**
 * Convert a profile back to the runtime CapabilityType list the planner
 * and prompt builder consume.
 */
export function profileToCapabilityTypes(profile: ModelCapabilityProfile): CapabilityType[] {
  return [...profile.nativeCapabilities];
}

/** Format a profile for display (used by /model). */
export function describeSource(source: MetadataSource): string {
  switch (source) {
    case "api": return "API Metadata";
    case "heuristic": return "Heuristic (name-based)";
    case "cached": return "Cache";
    case "manual": return "Manual Override";
  }
}

// ---------------------------------------------------------------------------
// Metadata-first detection
// ---------------------------------------------------------------------------

function applyMetadata(p: ModelCapabilityProfile, raw: RawModelMetadata): void {
  // Modalities — the strongest signal.
  const input = new Set((raw.inputModalities ?? parseModalityInput(raw.modality)).map((s) => s.toLowerCase()));
  const output = new Set((raw.outputModalities ?? parseModalityOutput(raw.modality)).map((s) => s.toLowerCase()));
  const methods = new Set((raw.supportedGenerationMethods ?? []).map((s) => s.toLowerCase()));
  const params = new Set((raw.supportedParameters ?? []).map((s) => s.toLowerCase()));
  const features = new Set((raw.features ?? []).map((s) => s.toLowerCase()));
  const declaredCaps = new Set((raw.capabilities ?? []).map((s) => s.toLowerCase()));

  if (input.has("text") || methods.has("generatecontent") || methods.has("chat")) p.chat = true;
  if (input.has("image")) { p.vision = true; p.supportsImages = true; p.supportsFiles = true; }
  if (input.has("video")) { p.supportsVideo = true; p.vision = true; p.supportsImages = true; }
  if (input.has("audio")) p.audioInput = true;
  if (input.has("file") || input.has("pdf")) { p.supportsFiles = true; p.supportsPDF = true; }

  if (output.has("image")) p.imageGeneration = true;
  if (output.has("audio")) p.audioOutput = true;

  // Generation methods (Gemini style).
  if (methods.has("embedcontent") || methods.has("embedtext")) p.embeddings = true;
  if (methods.has("generatecontent")) p.chat = true;

  // Supported parameters (OpenRouter style).
  if (params.has("tools") || params.has("tool_choice") || params.has("functions")) {
    p.toolCalling = true;
    p.functionCalling = true;
  }
  if (params.has("structured_outputs") || params.has("structured_output")) {
    p.structuredOutput = true;
    p.supportsJSON = true;
  }
  if (params.has("response_format") || params.has("json_mode")) p.supportsJSON = true;
  if (params.has("reasoning")) { p.reasoning = true; p.supportsThinking = true; }
  if (params.has("web_search") || params.has("websearch")) p.supportsWebSearch = true;

  // Provider-declared features / capabilities.
  if (features.has("vision") || declaredCaps.has("vision")) { p.vision = true; p.supportsImages = true; }
  if (features.has("web_search") || declaredCaps.has("web_search")) p.supportsWebSearch = true;
  if (features.has("computer_use") || declaredCaps.has("computer_use")) p.supportsComputerUse = true;
  if (features.has("reasoning") || declaredCaps.has("reasoning")) { p.reasoning = true; p.supportsThinking = true; }
  if (features.has("tool_calling") || declaredCaps.has("tool_calling")) { p.toolCalling = true; p.functionCalling = true; }
  if (declaredCaps.has("embeddings") || declaredCaps.has("embedding")) p.embeddings = true;
  if (declaredCaps.has("image_generation")) p.imageGeneration = true;

  // Limits.
  if (raw.contextLength && raw.contextLength > 0) p.contextWindow = raw.contextLength;
  if (raw.maxOutputTokens && raw.maxOutputTokens > 0) p.maxOutputTokens = raw.maxOutputTokens;
  if (raw.label) p.label = raw.label;
}

/** Parse "text+image->text" into its input side: ["text","image"]. */
function parseModalityInput(modality?: string): string[] {
  if (!modality) return [];
  const inputSide = modality.split("->")[0] ?? "";
  return inputSide.split("+").map((s) => s.trim()).filter(Boolean);
}

/** Parse "text+image->text" into its output side: ["text"]. */
function parseModalityOutput(modality?: string): string[] {
  if (!modality) return [];
  const parts = modality.split("->");
  const outputSide = parts.length > 1 ? parts[parts.length - 1]! : "";
  return outputSide.split("+").map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Universal heuristic — last resort, fills gaps only
// ---------------------------------------------------------------------------

/**
 * Vision model families across every vendor. Matched against the lowercased
 * model id. Kept deliberately broad — the cost of a false positive (model
 * claims vision it lacks) is low; the cost of a false negative (the original
 * nemotron-vl bug) is a broken user experience.
 */
const VISION_PATTERNS = [
  /(^|[-_/.])vl([-_:.]|$)/,       // qwen2.5-vl, nemotron-v2-vl, internvl (via -vl-)
  /vision/,                        // gpt-4-vision, llama-3.2-vision, phi-vision
  /llava/,
  /pixtral/,
  /internvl/,
  /minicpm-v/,
  /qwen.*vl/,
  /qwen.*image/,
  /florence/,
  /janus/,
  /molmo/,
  /cogvlm/,
  /kosmos/,
  /nemotron.*vl/,
  /deepseek.*vl/,
  /llama.*vision/,
  /phi.*vision/,
  /gpt-4o/,
  /gpt-4\.1/,
  /gpt-4-turbo/,
  /claude-(3|4|sonnet|opus|haiku)/,
  /gemini/,
  /grok.*vision/,
  /omni/,                          // gpt-4o-omni, qwen-omni
  /multimodal/,
  /(^|[-_])mm([-_:.]|$)/,          // *-mm-*
  /\bimage\+text\b/,
  /kimi/,                          // moonshotai/kimi-k3, kimi-vl
  /moonshot/,                      // moonshotai/*
  /glm-4v/,                        // zhipu glm-4v (vision variant)
  /yi-vision/,                     // 01-ai yi-vision
  /step-1v/,                       // stepfun step-1v
  /emu/,                           // baa-emu (multimodal)
  /cogagent/,                      // thudm cogagent (GUI vision)
];

const AUDIO_INPUT_PATTERNS = [/whisper/, /speech/, /audio/, /voice/, /asr/, /transcribe/];
const AUDIO_OUTPUT_PATTERNS = [/tts/, /speech/, /audio/];
const EMBEDDING_PATTERNS = [/embed/, /bge[-_]/, /(^|[-_])e5([-_]|$)/, /gte[-_]/, /retrieval/];
const RERANK_PATTERNS = [/rerank/];
const REASONING_PATTERNS = [/reasoning/, /thinking/, /(^|[-_/])o1([-_:.]|$)/, /(^|[-_/])o3([-_:.]|$)/, /(^|[-_/])o4([-_:.]|$)/, /r1([-_:.]|$)/, /qwq/, /deepseek-r1/];
const IMAGE_GEN_PATTERNS = [/dall-e/, /sdxl/, /stable-diffusion/, /flux/, /imagen/, /seedream/, /ideogram/, /image-gen/, /(^|[-_])image$/, /playground/];
const CODE_PATTERNS = [/coder/, /code[-_]/, /codestral/, /codex/, /starcoder/, /deepseek-coder/];
const COMPUTER_USE_PATTERNS = [/computer-use/, /computer_use/, /ui-tars/, /operator/, /claude.*computer/];
const VIDEO_PATTERNS = [/video/, /veo/, /sora/];

function applyHeuristic(p: ModelCapabilityProfile, model: string): void {
  const id = model.toLowerCase();

  // Vision.
  if (!p.vision && VISION_PATTERNS.some((re) => re.test(id))) {
    p.vision = true;
    p.supportsImages = true;
    p.supportsFiles = true;
  }

  // Video understanding.
  if (!p.supportsVideo && VIDEO_PATTERNS.some((re) => re.test(id)) && (p.vision || /video/.test(id))) {
    p.supportsVideo = true;
  }

  // Audio.
  if (!p.audioInput && AUDIO_INPUT_PATTERNS.some((re) => re.test(id))) p.audioInput = true;
  if (!p.audioOutput && AUDIO_OUTPUT_PATTERNS.some((re) => re.test(id))) p.audioOutput = true;

  // Embeddings / rerank — these models are NOT chat models.
  if (!p.embeddings && EMBEDDING_PATTERNS.some((re) => re.test(id))) {
    p.embeddings = true;
    p.chat = false;
    p.toolCalling = false;
    p.functionCalling = false;
  }
  if (RERANK_PATTERNS.some((re) => re.test(id))) {
    p.embeddings = true;
    p.chat = false;
    p.toolCalling = false;
  }

  // Reasoning / thinking.
  if (!p.reasoning && REASONING_PATTERNS.some((re) => re.test(id))) {
    p.reasoning = true;
    p.supportsThinking = true;
  }

  // Image generation.
  if (!p.imageGeneration && IMAGE_GEN_PATTERNS.some((re) => re.test(id))) {
    p.imageGeneration = true;
  }

  // Computer use.
  if (!p.supportsComputerUse && COMPUTER_USE_PATTERNS.some((re) => re.test(id))) {
    p.supportsComputerUse = true;
  }

  // Code models get tool calling + JSON (modern convention).
  if (CODE_PATTERNS.some((re) => re.test(id))) {
    p.toolCalling = true;
    p.functionCalling = true;
    p.supportsJSON = true;
  }
}

// ---------------------------------------------------------------------------
// Finalization — defaults + derive nativeCapabilities
// ---------------------------------------------------------------------------

function emptyProfile(provider: string, model: string): ModelCapabilityProfile {
  return {
    id: profileKey(provider, model),
    provider,
    model,
    chat: true, // every model in the registry can chat unless proven otherwise
    vision: false,
    imageGeneration: false,
    embeddings: false,
    audioInput: false,
    audioOutput: false,
    reasoning: false,
    functionCalling: false,
    toolCalling: false,
    structuredOutput: false,
    streaming: true,
    supportsFiles: false,
    supportsPDF: false,
    supportsImages: false,
    supportsVideo: false,
    supportsThinking: false,
    supportsJSON: false,
    supportsComputerUse: false,
    supportsWebSearch: false,
    nativeCapabilities: [],
    metadataSource: "heuristic",
    resolvedAt: 0,
  };
}

function finalize(p: ModelCapabilityProfile, extraNative?: CapabilityType[]): void {
  // IMPORTANT: Do NOT blanket-assume tool calling for all chat models.
  // Many models (smaller, older, or provider-limited) do NOT support tools.
  // Tool calling is only set when:
  //   1. API metadata declares it (supportedParameters includes "tools")
  //   2. Provider declaration bridges it (decl.toolCalling)
  //   3. Heuristic detects a code/modern model family
  //   4. Manual override registers it
  //
  // The old behavior (if chat → assume toolCalling) caused the runtime to
  // attach native tool definitions to models that cannot use them, leading
  // to silent failures and hallucinated tool calls.

  // Consistency: functionCalling implies toolCalling and vice versa.
  if (p.functionCalling && !p.toolCalling) p.toolCalling = true;
  if (p.toolCalling && !p.functionCalling) p.functionCalling = true;

  // JSON mode is only guaranteed with structured output support.
  if (p.structuredOutput && !p.supportsJSON) p.supportsJSON = true;

  // Vision implies image support.
  if (p.vision && !p.supportsImages) p.supportsImages = true;

  // Derive native capability types from the VERIFIED boolean flags.
  const native = new Set<CapabilityType>(extraNative ?? []);
  if (p.chat) native.add(Cap.Chat);
  if (p.vision) native.add(Cap.Vision);
  if (p.imageGeneration) native.add(Cap.ImageGeneration);
  if (p.embeddings) native.add(Cap.Embeddings);
  if (p.audioInput || p.audioOutput) native.add(Cap.Audio);
  if (p.supportsWebSearch) native.add(Cap.WebSearch);
  if (p.supportsComputerUse) native.add(Cap.Browser);
  p.nativeCapabilities = [...native];
}

// ---------------------------------------------------------------------------
// OpenRouter / OpenAI wire format normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize a raw entry from an OpenAI-compatible `/models` response into
 * RawModelMetadata. Handles both the bare OpenAI shape (`{id, object, ...}`)
 * and the rich OpenRouter shape (`architecture`, `context_length`,
 * `top_provider`, `supported_parameters`).
 */
export function normalizeOpenAIModelMetadata(raw: Record<string, unknown>): RawModelMetadata {
  const arch = (raw.architecture ?? {}) as Record<string, unknown>;
  const top = (raw.top_provider ?? {}) as Record<string, unknown>;
  return {
    id: String(raw.id ?? ""),
    label: typeof raw.name === "string" ? raw.name : undefined,
    contextLength: num(raw.context_length) ?? num(top.context_length),
    maxOutputTokens: num(top.max_completion_tokens),
    inputModalities: strArr(arch.input_modalities),
    outputModalities: strArr(arch.output_modalities),
    modality: typeof arch.modality === "string" ? arch.modality : undefined,
    supportedParameters: strArr(raw.supported_parameters),
    raw,
  };
}

/** Normalize a Gemini `/models` entry into RawModelMetadata. */
export function normalizeGeminiModelMetadata(raw: Record<string, unknown>): RawModelMetadata {
  return {
    id: String(raw.name ?? raw.id ?? "").replace(/^models\//, ""),
    label: typeof raw.displayName === "string" ? raw.displayName : undefined,
    contextLength: num(raw.inputTokenLimit),
    maxOutputTokens: num(raw.outputTokenLimit),
    supportedGenerationMethods: strArr(raw.supportedGenerationMethods),
    raw,
  };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function strArr(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}
