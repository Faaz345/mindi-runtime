/**
 * VisionAugment — augmentation module for image understanding.
 *
 * Fires when: the request contains image attachments or image file paths
 *             AND the primary model lacks native vision.
 *
 * Execution: selects the best available vision provider (deterministic),
 *            sends the image for analysis, and produces a structured
 *            description (objects, text, layout, colors, UI structure).
 *
 * This module ELIMINATES "I cannot see the image" responses. The model
 * always receives either the raw image (native) or a rich text description
 * (augmented) — never nothing.
 */

import type { CapabilityType } from "../../core/types.js";
import { CapabilityType as Cap } from "../../core/types.js";
import type {
  AugmentationContext,
  AugmentationModule,
  RequestAnalysis,
  StructuredContextBlock,
} from "../types.js";

export class VisionAugment implements AugmentationModule {
  readonly id = "vision-augment";
  readonly capability: CapabilityType = Cap.Vision;
  readonly label = "Vision Analysis";

  /**
   * Detect: fires when images are present in the request.
   * The Router handles the native-vision skip — this module only detects
   * whether vision is NEEDED, not whether it's natively available.
   */
  detect(input: RequestAnalysis): boolean {
    // Image attachments.
    if (input.attachments.some((a) => a.kind === "image" && a.data)) return true;
    // Image file paths referenced in text.
    if (input.filePaths.some((p) => p.isImage)) return true;
    return false;
  }

  /**
   * Execute: analyze all images via the best vision provider.
   * Produces a single StructuredContextBlock with combined analysis.
   */
  async execute(input: RequestAnalysis, ctx: AugmentationContext): Promise<StructuredContextBlock> {
    const start = Date.now();

    // Collect all image data to analyze.
    const images = this.collectImages(input, ctx);
    if (images.length === 0) {
      return {
        capability: Cap.Vision,
        source: this.id,
        ok: false,
        summary: "No image data available for analysis",
        detail: "Image was referenced but no data could be loaded.",
        metadata: {},
        durationMs: Date.now() - start,
        error: "No image data",
      };
    }

    // Find a vision-capable provider.
    const visionProviders = ctx.providersFor(Cap.Vision);
    if (visionProviders.length === 0) {
      return {
        capability: Cap.Vision,
        source: this.id,
        ok: false,
        summary: "No vision provider available",
        detail: "The runtime has no configured provider with vision capability. Add a provider that supports image analysis.",
        metadata: { imageCount: images.length },
        durationMs: Date.now() - start,
        error: "No vision provider configured",
      };
    }

    // Use the first available vision provider (deterministic — sorted by registry).
    const provider = visionProviders[0]!;

    // Analyze each image and combine results.
    const analyses: string[] = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i]!;
      try {
        const result = await provider.executeCapability(
          Cap.Vision,
          {
            type: Cap.Vision,
            params: {
              image: img.data,
              mimeType: img.mimeType,
              prompt: VISION_ANALYSIS_PROMPT,
            },
            requestId: input.requestId,
            sessionId: input.sessionId,
          },
          ctx.ctx,
        );

        if (result.ok) {
          const text = extractText(result.payload);
          analyses.push(
            images.length > 1
              ? `### Image ${i + 1}${img.name ? ` (${img.name})` : ""}\n${text}`
              : text,
          );
        } else {
          analyses.push(
            `### Image ${i + 1}${img.name ? ` (${img.name})` : ""}\n[Analysis failed: ${result.error ?? "unknown error"}]`,
          );
        }
      } catch (err) {
        analyses.push(
          `### Image ${i + 1}\n[Analysis error: ${err instanceof Error ? err.message : String(err)}]`,
        );
      }
    }

    const combined = analyses.join("\n\n");
    const allOk = analyses.some((a) => !a.includes("[Analysis failed") && !a.includes("[Analysis error"));

    return {
      capability: Cap.Vision,
      source: `${this.id} via ${provider.id}`,
      ok: allOk,
      summary: `Analyzed ${images.length} image(s) via ${provider.label}`,
      detail: [
        "The following is a structured analysis of the attached image(s):",
        "",
        combined,
        "",
        "Use this analysis to answer the user's question about the image(s).",
      ].join("\n"),
      metadata: {
        imageCount: images.length,
        provider: provider.id,
        imageNames: images.map((img) => img.name).filter(Boolean),
      },
      durationMs: Date.now() - start,
      error: allOk ? undefined : "Some images could not be analyzed",
    };
  }

  /**
   * Cost: 2 (requires a network call to a vision model, but not expensive
   * like cloning a repo or running a browser).
   */
  costEstimate(_input: RequestAnalysis): number {
    return 2;
  }

  // ---- Helpers ---------------------------------------------------------

  private collectImages(
    input: RequestAnalysis,
    _ctx: AugmentationContext,
  ): Array<{ data: string; mimeType: string; name?: string }> {
    const images: Array<{ data: string; mimeType: string; name?: string }> = [];

    // From attachments.
    for (const att of input.attachments) {
      if (att.kind === "image" && att.data) {
        images.push({
          data: att.data,
          mimeType: att.mimeType ?? "image/png",
          name: att.name,
        });
      }
    }

    // From file paths that reference images (read from disk via provider).
    // Note: actual file reading is delegated to the vision provider's
    // executeCapability which can handle file paths.
    for (const fp of input.filePaths) {
      if (fp.isImage && fp.kind === "file") {
        // Pass the path — the provider will read it.
        images.push({
          data: `file://${fp.path}`,
          mimeType: guessImageMime(fp.path),
          name: fp.path.split(/[/\\]/).pop(),
        });
      }
    }

    return images;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VISION_ANALYSIS_PROMPT = [
  "Analyze this image comprehensively. Provide:",
  "1. **Overall description**: What the image shows (scene, subject, context)",
  "2. **Objects & elements**: Key objects, people, UI components, or diagrams",
  "3. **Text content**: Any visible text (OCR), labels, annotations",
  "4. **Layout & structure**: Spatial arrangement, hierarchy, composition",
  "5. **Colors & style**: Dominant colors, design style, visual theme",
  "6. **Technical details**: If code/screenshot — identify language, framework, errors",
  "",
  "Be thorough and precise. The analysis will be used by another AI model",
  "that cannot see the image directly.",
].join("\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(payload: { kind: string; [key: string]: unknown }): string {
  if (payload.kind === "text") return (payload as any).text ?? "";
  if (payload.kind === "json") return JSON.stringify((payload as any).data, null, 2);
  return JSON.stringify(payload, null, 2);
}

function guessImageMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    tiff: "image/tiff",
    tif: "image/tiff",
  };
  return map[ext] ?? "image/png";
}
