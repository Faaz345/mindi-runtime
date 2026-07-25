import type {
  CapabilityInput,
  CapabilityPlan,
  CapabilityType,
  ChatMessage,
  IntentDescriptor,
  PlannedCapability,
} from "../core/types.js";
import { CapabilityType as Cap } from "../core/types.js";
import type { IProvider } from "../core/types.js";
import type { CapabilityRegistry } from "../registry/CapabilityRegistry.js";
import type { CapabilityAvailabilityTracker } from "../tools/CapabilityAvailabilityTracker.js";

/**
 * CapabilityPlanner
 *
 * Takes an IntentDescriptor + the selected primary model's declared
 * capabilities and produces a CapabilityPlan.
 *
 * The planner now checks AVAILABILITY before planning:
 *   - If a capability is registered but UNAVAILABLE, it goes to `unavailable`
 *     with a structured reason, NOT to `missing`.
 *   - The planner never schedules execution of unavailable capabilities.
 *
 * This eliminates avoidable failed tool calls.
 */
export class CapabilityPlanner {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly availabilityTracker?: CapabilityAvailabilityTracker,
  ) {}

  async plan(
    intent: IntentDescriptor,
    primaryProvider: IProvider,
    primaryModelId: string,
    request: { requestId: string; sessionId: string; messages: ChatMessage[]; input: string },
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
    try {
      const decl = await provider.declareCapability(modelId);
      return new Set(decl.capabilities);
    } catch {
      return new Set(provider.capabilities);
    }
  }

  private buildInput(
    type: CapabilityType,
    request: { requestId: string; sessionId: string; messages: ChatMessage[]; input: string },
  ): CapabilityInput {
    const base = {
      requestId: request.requestId,
      sessionId: request.sessionId,
    };
    switch (type) {
      case Cap.WebSearch:
        return { ...base, type, params: { query: request.input } };
      case Cap.Vision:
        return { ...base, type, params: { prompt: "Describe this image.", image: extractFirstImage(request.messages) } };
      case Cap.OCR:
        return { ...base, type, params: { image: extractFirstImage(request.messages) } };
      case Cap.ImageGeneration:
        return { ...base, type, params: { prompt: request.input } };
      case Cap.Embeddings:
        return { ...base, type, params: { text: request.input } };
      case Cap.Filesystem:
        return { ...base, type, params: { op: "list", path: "" } };
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

function extractFirstUrl(input: string): string {
  const m = input.match(/https?:\/\/[^\s)]+/i);
  return m ? m[0] : "";
}
