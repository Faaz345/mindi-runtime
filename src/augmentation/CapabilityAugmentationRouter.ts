/**
 * CapabilityAugmentationRouter — the core architectural component.
 *
 * Core principle: The Runtime enriches BEFORE the model reasons.
 *
 * Every request passes through this router FIRST. It:
 *   1. Analyzes input (via InputAnalyzer)
 *   2. Resolves the model's native capability profile
 *   3. Detects capability gaps (required − native)
 *   4. Executes augmentation modules for gaps (parallel, cost-ordered)
 *   5. Builds enriched messages with StructuredContextBlocks
 *   6. Produces an EffectiveCapabilityCard for the prompt builder
 *   7. Decides routing (simple vs agentic)
 *
 * The model NEVER receives a raw request. It receives an enriched request
 * where all obtainable context has already been injected.
 */

import type { CapabilityType, ChatMessage } from "../core/types.js";
import { CapabilityType as Cap } from "../core/types.js";
import type { ModelCapabilityProfile } from "../capability/types.js";
import type {
  AugmentationContext,
  AugmentationInput,
  AugmentationRecord,
  AugmentationResult,
  EffectiveCapabilityCard,
  IAugmentationPolicy,
  RequestAnalysis,
  StructuredContextBlock,
} from "./types.js";
import { AugmentationModuleRegistry } from "./AugmentationModuleRegistry.js";
import { InputAnalyzer } from "./InputAnalyzer.js";

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export class CapabilityAugmentationRouter {
  private readonly analyzer = new InputAnalyzer();

  constructor(
    private readonly registry: AugmentationModuleRegistry,
    private readonly policy: IAugmentationPolicy,
    private readonly augmentationCtx: AugmentationContext,
  ) {}

  /**
   * Route a request through the full augmentation pipeline.
   * Returns enriched messages + metadata ready for the primary model.
   */
  async route(input: AugmentationInput): Promise<AugmentationResult> {
    // 1. INPUT ANALYSIS — parse the raw request into structured form.
    const analysis = this.analyzer.analyze({
      text: input.text,
      attachments: input.attachments,
      sessionId: input.sessionId,
      requestId: input.requestId,
    });

    // 2. NATIVE CAPABILITY RESOLUTION — what the model can do itself.
    const nativeCaps = this.resolveNativeCapabilities(input.modelProfile);

    // 3. DETECT REQUIRED AUGMENTATIONS — which modules fire for this request.
    const detectedModules = this.registry.detectAll(analysis);

    // 4. CAPABILITY GAP ANALYSIS — filter out natively-handled capabilities.
    const gaps = this.computeGaps(detectedModules, nativeCaps, analysis);

    // 5. CHECK POLICY — respect user consent preferences.
    const allowed = this.filterByPolicy(gaps);

    // 6. EXECUTE AUGMENTATIONS — run modules in parallel, cost-ordered.
    const blocks = await this.executeAugmentations(allowed, analysis);

    // 7. BUILD ENRICHED MESSAGES — inject context into the conversation.
    const enrichedMessages = this.buildEnrichedMessages(input, blocks, nativeCaps);

    // 8. BUILD EFFECTIVE CAPABILITY CARD — unified view for prompt builder.
    const effectiveCard = this.buildEffectiveCard(input, nativeCaps, blocks);

    // 9. BUILD AUGMENTATION RECORDS — transparency trail.
    const augmentations = this.buildRecords(nativeCaps, blocks, gaps, allowed);

    // 10. ROUTING DECISION — simple vs agentic.
    const route = this.decideRoute(analysis, input);

    // 11. NATIVE IMAGE PARTS — if model has native vision, embed images directly.
    const nativeImageParts = nativeCaps.has(Cap.Vision)
      ? this.extractNativeImageParts(input)
      : [];

    // 12. UNAVAILABLE — capabilities that neither model nor runtime can handle.
    const unavailable = this.computeUnavailable(gaps, allowed, blocks);

    return {
      enrichedMessages,
      augmentations,
      effectiveCard,
      route,
      unavailable,
      nativeImageParts,
      analysis,
    };
  }

  // ---- Step 2: Native capability resolution ----------------------------

  private resolveNativeCapabilities(profile: ModelCapabilityProfile): Set<CapabilityType> {
    return new Set(profile.nativeCapabilities);
  }

  // ---- Step 3-4: Gap analysis ------------------------------------------

  private computeGaps(
    detectedModules: ReturnType<AugmentationModuleRegistry["detectAll"]>,
    nativeCaps: Set<CapabilityType>,
    _analysis: RequestAnalysis,
  ): Array<{ module: (typeof detectedModules)[number]; capability: CapabilityType }> {
    const gaps: Array<{ module: (typeof detectedModules)[number]; capability: CapabilityType }> = [];
    for (const mod of detectedModules) {
      // If the model handles this natively, skip augmentation.
      if (nativeCaps.has(mod.capability)) continue;
      gaps.push({ module: mod, capability: mod.capability });
    }
    return gaps;
  }

  // ---- Step 5: Policy filtering ----------------------------------------

  private filterByPolicy(
    gaps: Array<{ module: any; capability: CapabilityType }>,
  ): Array<{ module: any; capability: CapabilityType }> {
    return gaps.filter(({ capability }) => {
      const allowed = this.policy.isAllowed(capability);
      // null = not yet asked → default to allowed (non-blocking).
      // The UI can prompt separately; the router doesn't block.
      return allowed !== false;
    });
  }

  // ---- Step 6: Execute augmentations -----------------------------------

  private async executeAugmentations(
    modules: Array<{ module: any; capability: CapabilityType }>,
    analysis: RequestAnalysis,
  ): Promise<StructuredContextBlock[]> {
    if (modules.length === 0) return [];

    // Execute all in parallel — modules are independent.
    const promises = modules.map(async ({ module }) => {
      const start = Date.now();
      try {
        const block: StructuredContextBlock = await module.execute(analysis, this.augmentationCtx);
        return block;
      } catch (err) {
        // Modules should never throw, but be defensive.
        return {
          capability: module.capability,
          source: module.id,
          ok: false,
          summary: `${module.label} failed`,
          detail: `Augmentation module "${module.id}" threw: ${err instanceof Error ? err.message : String(err)}`,
          metadata: {},
          durationMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        } satisfies StructuredContextBlock;
      }
    });

    return Promise.all(promises);
  }

  // ---- Step 7: Build enriched messages ---------------------------------

  private buildEnrichedMessages(
    input: AugmentationInput,
    blocks: StructuredContextBlock[],
    _nativeCaps: Set<CapabilityType>,
  ): ChatMessage[] {
    const messages: ChatMessage[] = [];

    // Include session history.
    messages.push(...input.history);

    // Inject augmentation results as capability messages.
    const successfulBlocks = blocks.filter((b) => b.ok);
    if (successfulBlocks.length > 0) {
      // Preamble: tell the model what was gathered on its behalf.
      const capList = successfulBlocks.map((b) => `- ${b.capability} (via ${b.source})`).join("\n");
      messages.push({
        role: "system",
        content: [
          "The MINDI Runtime gathered the following context on your behalf before this request.",
          "Use this information to answer the user's question. Do NOT claim you fetched it yourself.",
          "",
          "Context gathered:",
          capList,
        ].join("\n"),
      });

      // Each block becomes a capability message.
      for (const block of successfulBlocks) {
        messages.push({
          role: "capability",
          content: this.formatBlock(block),
          name: block.source,
        });
      }
    }

    // Inject failed blocks as warnings (so the model can inform the user).
    const failedBlocks = blocks.filter((b) => !b.ok);
    if (failedBlocks.length > 0) {
      const warnings = failedBlocks
        .map((b) => `- ${b.capability}: ${b.error ?? "unknown error"}`)
        .join("\n");
      messages.push({
        role: "system",
        content: [
          "The following augmentations FAILED. Inform the user if relevant:",
          warnings,
        ].join("\n"),
      });
    }

    // The user's actual message (with image parts if native vision).
    const userContent = input.text;
    messages.push({ role: "user", content: userContent });

    return messages;
  }

  private formatBlock(block: StructuredContextBlock): string {
    const header = `[Capability: ${block.capability} | Source: ${block.source} | ${block.ok ? "OK" : "FAILED"} | ${block.durationMs}ms]`;
    return `${header}\n${block.detail}`;
  }

  // ---- Step 8: Effective Capability Card -------------------------------

  private buildEffectiveCard(
    input: AugmentationInput,
    nativeCaps: Set<CapabilityType>,
    blocks: StructuredContextBlock[],
  ): EffectiveCapabilityCard {
    const augmented = blocks
      .filter((b) => b.ok)
      .map((b) => ({ capability: b.capability, via: b.source }));

    // Runtime tools = all registered modules (available on-demand in agent mode).
    const runtimeTools = this.registry.listAll().map((m) => ({
      name: m.id,
      capability: m.capability,
      description: m.label,
    }));

    const unavailable = this.computeUnavailable([], [], blocks);

    return {
      provider: input.providerId,
      model: input.modelId,
      native: [...nativeCaps],
      augmented,
      runtimeTools,
      unavailable,
    };
  }

  // ---- Step 9: Augmentation records ------------------------------------

  private buildRecords(
    nativeCaps: Set<CapabilityType>,
    blocks: StructuredContextBlock[],
    gaps: Array<{ module: any; capability: CapabilityType }>,
    allowed: Array<{ module: any; capability: CapabilityType }>,
  ): AugmentationRecord[] {
    const records: AugmentationRecord[] = [];

    // Native capabilities that were relevant.
    for (const cap of nativeCaps) {
      records.push({
        capability: cap,
        action: "native",
        reason: `${cap} handled natively by the model`,
        durationMs: 0,
      });
    }

    // Augmented capabilities.
    for (const block of blocks) {
      records.push({
        capability: block.capability,
        action: "augmented",
        via: block.source,
        reason: block.ok
          ? `${block.capability} augmented via ${block.source}`
          : `${block.capability} augmentation failed: ${block.error}`,
        durationMs: block.durationMs,
        ok: block.ok,
      });
    }

    // Denied by policy.
    const allowedCaps = new Set(allowed.map((a) => a.capability));
    for (const gap of gaps) {
      if (!allowedCaps.has(gap.capability)) {
        records.push({
          capability: gap.capability,
          action: "skipped",
          reason: `${gap.capability} augmentation denied by user policy`,
          durationMs: 0,
        });
      }
    }

    return records;
  }

  // ---- Step 10: Routing decision ---------------------------------------

  private decideRoute(analysis: RequestAnalysis, input: AugmentationInput): "simple" | "agentic" {
    // Explicit plan mode → always simple.
    if (input.mode === "plan") return "simple";

    // Agentic signals: command intent, repo modification, multi-step operations.
    if (analysis.commandIntent && analysis.commandIntent.confidence >= 0.8) return "agentic";
    if (analysis.repositories.some((r) => r.needsClone)) return "agentic";

    // If the text explicitly asks for iterative operations.
    const agenticPatterns = /\b(create|build|implement|refactor|fix|debug|write|generate|deploy|install|setup|configure)\b/i;
    if (agenticPatterns.test(analysis.text) && analysis.filePaths.length > 0) return "agentic";

    return "simple";
  }

  // ---- Step 11: Native image parts -------------------------------------

  private extractNativeImageParts(
    input: AugmentationInput,
  ): Array<{ type: "image"; mimeType: string; base64: string } | { type: "image_url"; url: string }> {
    const parts: Array<{ type: "image"; mimeType: string; base64: string } | { type: "image_url"; url: string }> = [];
    for (const att of input.attachments) {
      if (!att.mimeType?.startsWith("image/") || !att.data) continue;
      // Strip data URI prefix if present.
      const base64 = att.data.replace(/^data:[^;]+;base64,/, "");
      parts.push({ type: "image", mimeType: att.mimeType, base64 });
    }
    return parts;
  }

  // ---- Step 12: Unavailable computation --------------------------------

  private computeUnavailable(
    _gaps: Array<{ module: any; capability: CapabilityType }>,
    _allowed: Array<{ module: any; capability: CapabilityType }>,
    blocks: StructuredContextBlock[],
  ): Array<{ capability: CapabilityType; reason: string }> {
    // Capabilities where augmentation was attempted but failed AND
    // no alternate module exists for the same capability.
    const unavailable: Array<{ capability: CapabilityType; reason: string }> = [];
    for (const block of blocks) {
      if (!block.ok) {
        // Check if there's another module that could handle this.
        const alternates = this.registry.getByCapability(block.capability);
        if (alternates.length <= 1) {
          unavailable.push({
            capability: block.capability,
            reason: block.error ?? `${block.capability} augmentation failed with no alternate available`,
          });
        }
      }
    }
    return unavailable;
  }
}
