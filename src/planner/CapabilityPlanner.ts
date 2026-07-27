import type {
  CapabilityInput,
  CapabilityPlan,
  CapabilityType,
  ChatMessage,
  IntentDescriptor,
  PlannedCapability,
} from "../core/types.js";
import { readFileSync } from "node:fs";
import { CapabilityType as Cap } from "../core/types.js";
import type { IProvider } from "../core/types.js";
import type { CapabilityRegistry } from "../registry/CapabilityRegistry.js";
import type { CapabilityAvailabilityTracker } from "../tools/CapabilityAvailabilityTracker.js";
import type { ModelCapabilityRegistry } from "../capability/ModelCapabilityRegistry.js";
import { profileToCapabilityTypes } from "../capability/CapabilityDetector.js";

/**
 * CapabilityPlanner
 *
 * Takes an IntentDescriptor + the selected primary model's capability
 * profile and produces a CapabilityPlan.
 *
 * The planner NEVER infers capabilities itself — it always queries the
 * ModelCapabilityRegistry (the single source of truth). The registry is
 * model-centric: metadata-first detection, heuristic fallback.
 *
 * The planner also checks AVAILABILITY before planning:
 *   - If a capability is registered but UNAVAILABLE, it goes to `unavailable`
 *     with a structured reason, NOT to `missing`.
 *   - The planner never schedules execution of unavailable capabilities.
 */
export class CapabilityPlanner {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly availabilityTracker?: CapabilityAvailabilityTracker,
    private readonly modelRegistry?: ModelCapabilityRegistry,
  ) {}

  async plan(
    intent: IntentDescriptor,
    primaryProvider: IProvider,
    primaryModelId: string,
    request: { requestId: string; sessionId: string; messages: ChatMessage[]; input: string; attachments?: Array<{ name?: string; mimeType?: string; data?: string }> },
  ): Promise<CapabilityPlan> {
    const modelCaps = await this.resolveModelCapabilities(primaryProvider, primaryModelId);

    const satisfied: CapabilityType[] = [];
    const missing: PlannedCapability[] = [];
    const unavailable: Array<{ type: CapabilityType; reason: string }> = [];

    for (const type of intent.requiredCapabilities) {
      // Chat is always satisfied by the primary provider.
      if (type === Cap.Chat) {
        satisfied.push(type);
        continue;
      }
      // Model already has the capability natively.
      if (modelCaps.has(type)) {
        satisfied.push(type);
        continue;
      }

      // Check if any executor is REGISTERED.
      if (!this.registry.has(type)) {
        unavailable.push({
          type,
          reason: `No executor registered for capability "${type}"`,
        });
        continue;
      }

      // CHECK AVAILABILITY — the key change.
      // If the tracker says unavailable, don't plan it.
      if (this.availabilityTracker && !this.availabilityTracker.isAvailable(type)) {
        const avail = this.availabilityTracker.getAvailability(type);
        unavailable.push({
          type,
          reason: avail?.unavailableReason ?? `Capability "${type}" is currently unavailable`,
        });
        continue;
      }

      // Capability is registered AND available — plan augmentation.
      const input = this.buildInput(type, request);
      missing.push({
        type,
        input,
        preferTool: isPreferableAsTool(type),
      });
    }

    return { satisfied, missing, unavailable };
  }

  private async resolveModelCapabilities(
    provider: IProvider,
    modelId: string,
  ): Promise<Set<CapabilityType>> {
    // Registry is the single source of truth when wired (always, in the
    // real Runtime). The legacy path only exists for standalone unit tests
    // that construct a planner without a registry.
    if (this.modelRegistry) {
      const profile = await this.modelRegistry.ensure(provider.id, modelId);
      return new Set(profileToCapabilityTypes(profile));
    }
    try {
      const decl = await provider.declareCapability(modelId);
      return new Set(decl.capabilities);
    } catch {
      return new Set(provider.capabilities);
    }
  }

  private buildInput(
    type: CapabilityType,
    request: { requestId: string; sessionId: string; messages: ChatMessage[]; input: string; attachments?: Array<{ name?: string; mimeType?: string; data?: string }> },
  ): CapabilityInput {
    const base = {
      requestId: request.requestId,
      sessionId: request.sessionId,
    };
    switch (type) {
      case Cap.WebSearch:
        return { ...base, type, params: { query: request.input } };
      case Cap.Vision: {
        // Try to extract an image from attachments first.
        const attachment = request.attachments?.find((a) => a.mimeType?.startsWith("image/") && a.data);
        let imageData = attachment
          ? (attachment.data!.startsWith("data:") ? attachment.data : `data:${attachment.mimeType};base64,${attachment.data}`)
          : extractFirstImage(request.messages);
        // If no image in attachments, try to extract a file path from the input text.
        if (!imageData) {
          imageData = extractImagePathFromText(request.input);
        }
        return { ...base, type, params: { prompt: "Analyze this image/screenshot in detail.", image: imageData } };
      }
      case Cap.OCR:
        return { ...base, type, params: { image: extractFirstImage(request.messages) } };
      case Cap.ImageGeneration:
        return { ...base, type, params: { prompt: request.input } };
      case Cap.Embeddings:
        return { ...base, type, params: { text: request.input } };
      case Cap.Filesystem: {
        // If the user mentioned a concrete file/dir, READ it up front so the
        // model gets the real content as context — instead of being told it
        // "has filesystem tools" it can never invoke in single-shot chat.
        const target = extractFileTargetFromText(request.input);
        if (target) {
          return {
            ...base,
            type,
            params: target.kind === "dir"
              ? { op: "list", path: target.path }
              : { op: "read", path: target.path },
          };
        }
        return { ...base, type, params: { op: "list", path: "" } };
      }
      case Cap.Git:
        return { ...base, type, params: { command: "status" } };
      case Cap.Terminal:
        return { ...base, type, params: { command: request.input } };
      case Cap.Browser:
        return { ...base, type, params: { url: extractFirstUrl(request.input), action: "navigate" } };
      case Cap.Database:
        return { ...base, type, params: { query: request.input } };
      case Cap.Audio:
        return { ...base, type, params: { audio: "" } };
      default:
        return { ...base, type, params: {} };
    }
  }
}

function isPreferableAsTool(type: CapabilityType): boolean {
  return (
    type === Cap.Filesystem ||
    type === Cap.Git ||
    type === Cap.Terminal ||
    type === Cap.Database
  );
}

function extractFirstImage(messages: ChatMessage[]): string {
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const part of m.content) {
      if (part.type === "image") return String(part.base64);
      if (part.type === "image_url") return part.url;
    }
  }
  return "";
}

/**
 * Extract an image file path from text input and read it as base64.
 * Handles:
 *   - Quoted paths (may contain spaces): "C:\Users\me\My Screenshot.png"
 *   - Unquoted Windows paths: C:\Users\me\shot.png
 *   - Unquoted Unix paths: /home/me/shot.png
 */
function extractImagePathFromText(input: string): string {
  // 1. Quoted paths first — they may contain spaces.
  const quoted = input.match(/"([^"]+\.(?:png|jpe?g|gif|webp|bmp|tiff?))"/i)
    ?? input.match(/'([^']+\.(?:png|jpe?g|gif|webp|bmp|tiff?))'/i);
  if (quoted?.[1]) {
    const data = readImageAsDataUri(quoted[1]);
    if (data) return data;
  }

  // 2. Unquoted paths (no spaces).
  const match = input.match(/([A-Za-z]:[\\\/][^\s"']+\.(?:png|jpe?g|gif|webp|bmp|tiff?))|(\/[^\s"']+\.(?:png|jpe?g|gif|webp|bmp|tiff?))/i);
  const filePath = match?.[1] ?? match?.[2];
  if (!filePath) return "";
  return readImageAsDataUri(filePath) ?? "";
}

/** Read a file from disk and return a base64 data URI, or null on failure. */
function readImageAsDataUri(filePath: string): string | null {
  try {
    const buffer = readFileSync(filePath);
    const ext = filePath.match(/\.(\w+)$/)?.[1]?.toLowerCase() ?? "png";
    const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

function extractFirstUrl(input: string): string {
  const m = input.match(/https?:\/\/[^\s)]+/i);
  return m ? m[0] : "";
}

/** Image/binary extensions — those are handled by vision/OCR, not fs.read. */
const NON_TEXT_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|svg|pdf|zip|exe|dll|bin|mp3|wav|mp4|mov)$/i;

/** Known text-file extensions for bare filename detection. */
const TEXT_EXT_RE = /\.(?:txt|md|markdown|json|jsonc|ya?ml|csv|tsv|xml|html?|css|s[ac]ss|less|[jt]sx?|mjs|cjs|py|go|rs|java|kt|c|cpp|h|hpp|rb|php|sh|bash|ps1|sql|log|ini|cfg|conf?|toml|env|lock|gitignore|dockerfile|txt\.bak)$/i;

/**
 * Extract a concrete filesystem target from the user's text.
 * Handles quoted paths (may contain spaces), bare absolute/relative paths,
 * and bare filenames with known text extensions ("read package.json").
 * Returns null when nothing path-like is mentioned.
 */
function extractFileTargetFromText(input: string): { path: string; kind: "file" | "dir" } | null {
  // Strip URLs first — "https://example.com/file.json" is a web target,
  // not a filesystem target.
  const text = input.replace(/https?:\/\/[^\s"']+/gi, " ");
  const candidates: string[] = [];

  // 1. Quoted paths first — they may contain spaces.
  const quoted = text.match(/"([^"\r\n]+)"/) ?? text.match(/'([^'\r\n]+)'/);
  if (quoted?.[1]) candidates.push(quoted[1]);

  // Remove quoted spans so bare patterns can't match FRAGMENTS of a quoted
  // path (e.g. "C:\pics\shot" from "C:\pics\shot one.png").
  const unquoted = text.replace(/"[^"\r\n]*"|'[^'\r\n]*'/g, " ");

  // 2. Bare absolute/relative paths (no spaces): drive paths, rooted paths,
  //    and multi-segment relative paths ending in a file ("src\index.ts").
  const bare = unquoted.match(/([A-Za-z]:[\\\/][^\s"']+)|((?:\.{1,2}|~)?[\\\/][^\s"']+)|((?:[\w.-]+[\\\/])+[\w.-]+\.[A-Za-z0-9]{1,10})/);
  const barePath = bare?.[1] ?? bare?.[2] ?? bare?.[3];
  if (barePath) candidates.push(barePath);

  // 3. Bare filename with a known text extension ("read package.json").
  const bareFile = unquoted.match(/[\w][\w.-]*\.(?:txt|md|markdown|json|jsonc|ya?ml|csv|tsv|xml|html?|css|s[ac]ss|less|[jt]sx?|mjs|cjs|py|go|rs|java|kt|c|cpp|h|hpp|rb|php|sh|bash|ps1|sql|log|ini|cfg|conf|toml|env|lock)\b/i);
  if (bareFile?.[0]) candidates.push(bareFile[0]);

  for (const raw of candidates) {
    // Strip trailing punctuation the regex may have swallowed.
    const cleaned = raw.trim().replace(/[.,;:!?)\]'"+]+$/, "");
    if (!cleaned || cleaned.length < 2) continue;
    if (!looksLikeFsTarget(cleaned)) continue;
    if (NON_TEXT_EXT_RE.test(cleaned)) continue; // images etc. go to vision/OCR
    const kind = /[\\\/]$/.test(cleaned) || !TEXT_EXT_RE.test(cleaned) && !/\.[A-Za-z0-9]{1,10}$/.test(cleaned)
      ? "dir"
      : "file";
    return { path: cleaned, kind };
  }
  return null;
}

/** True when a string plausibly refers to a filesystem target. */
function looksLikeFsTarget(s: string): boolean {
  return (
    /^[A-Za-z]:[\\\/]/.test(s) || // Windows drive path
    s.startsWith("/") || // Unix absolute
    s.startsWith("./") || s.startsWith("../") || s.startsWith("~/") || // relative
    /\.[A-Za-z0-9]{1,10}$/.test(s) // filename with extension
  );
}
