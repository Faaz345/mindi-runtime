/**
 * OCR Tool — extract text from images and PDFs.
 *
 * Operations: image (OCR from image), pdf (OCR from PDF)
 *
 * Uses the `tesseract.js` package for image OCR if available.
 * Falls back to a structured "not available" result if not installed.
 */

import type {
  CapabilityInput,
  CapabilityResult,
  CapabilityType,
  ExecutionContext,
} from "../../core/types.js";
import { ToolError } from "../../core/errors.js";
import { ToolBase, type ToolMetadata, type ToolRetryPolicy, assertPermissions } from "../sdk/ToolBase.js";

const CAP: CapabilityType = "ocr";

const METADATA: ToolMetadata = {
  id: "tool.ocr",
  label: "OCR",
  description: "Extract text from images and PDFs using Tesseract OCR",
  capability: CAP,
  version: "1.0.0",
  permissions: ["filesystem.read"],
  operations: ["image", "pdf"],
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["image", "pdf"] },
      image: { type: "string", description: "base64 data or file path" },
      file: { type: "string", description: "file path to OCR" },
      lang: { type: "string", default: "eng" },
    },
    required: ["op"],
  },
  streaming: false,
  defaultTimeoutMs: 60_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableErrors: [] } as ToolRetryPolicy,
};

export class OcrTool extends ToolBase {
  readonly id = "tool.ocr";
  readonly label = "OCR";
  readonly capability: CapabilityType = CAP;
  readonly metadata = METADATA;

  protected async run(input: CapabilityInput, ctx: ExecutionContext): Promise<CapabilityResult> {
    assertPermissions(this.sb.getPolicy(), this.metadata.permissions);

    const op = String(input.params.op ?? "image");
    const lang = String(input.params.lang ?? "eng");
    const imageData = String(input.params.image ?? input.params.file ?? "");

    if (!imageData) {
      throw new ToolError("E_TOOL_FAILED", "OcrTool: missing image data or file path", {});
    }

    const start = Date.now();
    ctx.log.debug("ocr.execute", { op, lang, hasImage: !!imageData });

    try {
      // Lazily import tesseract.js.
      const { createWorker } = await importTesseract();
      const worker = await createWorker(lang);
      const { data } = await worker.recognize(imageData.startsWith("data:") ? imageData : this.sb.resolvePath(imageData));
      await worker.terminate();

      const capped = this.sb.capOutput(data.text);
      return {
        type: CAP,
        source: this.id,
        ok: true,
        payload: {
          kind: "structured",
          data: {
            text: capped.data + (capped.truncated ? "\n[...truncated]" : ""),
            confidence: data.confidence,
            lang,
          },
        },
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        type: CAP,
        source: this.id,
        ok: false,
        payload: { kind: "text", text: `OCR failed: ${err instanceof Error ? err.message : String(err)}` },
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }
}

async function importTesseract(): Promise<typeof import("tesseract.js")> {
  try {
    return await import("tesseract.js");
  } catch {
    throw new ToolError(
      "E_TOOL_FAILED",
      "tesseract.js is not installed. Run: npm install tesseract.js",
      {},
    );
  }
}
