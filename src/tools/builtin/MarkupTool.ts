/**
 * Markdown / HTML Tool — convert between Markdown and HTML.
 *
 * Operations:
 *   - md2html: convert Markdown to HTML
 *   - html2md: convert HTML to Markdown
 *   - extract: extract text from HTML
 *   - toc: generate table of contents from Markdown
 */

import type {
  CapabilityInput,
  CapabilityResult,
  CapabilityType,
  ExecutionContext,
} from "../../core/types.js";
import { ToolError } from "../../core/errors.js";
import { ToolBase, type ToolMetadata, type ToolRetryPolicy, assertPermissions } from "../sdk/ToolBase.js";

const CAP: CapabilityType = "filesystem";

const METADATA: ToolMetadata = {
  id: "tool.markup",
  label: "Markdown/HTML",
  description: "Convert between Markdown and HTML, extract text, generate TOC",
  capability: CAP,
  version: "1.0.0",
  permissions: [],
  operations: ["md2html", "html2md", "extract", "toc"],
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["md2html", "html2md", "extract", "toc"] },
      text: { type: "string" },
    },
    required: ["op", "text"],
  },
  streaming: false,
  defaultTimeoutMs: 10_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableErrors: [] } as ToolRetryPolicy,
};

export class MarkupTool extends ToolBase {
  readonly id = "tool.markup";
  readonly label = "Markdown/HTML";
  readonly capability: CapabilityType = CAP;
  readonly metadata = METADATA;

  protected async run(input: CapabilityInput, _ctx: ExecutionContext): Promise<CapabilityResult> {
    assertPermissions(this.sb.getPolicy(), this.metadata.permissions);

    const op = String(input.params.op ?? "md2html");
    const text = String(input.params.text ?? "");
    const start = Date.now();

    if (!text) {
      throw new ToolError("E_TOOL_FAILED", "MarkupTool: missing text", {});
    }

    switch (op) {
      case "md2html": {
        const html = mdToHtml(text);
        const capped = this.sb.capOutput(html);
        return {
          type: CAP, source: this.id, ok: true,
          payload: { kind: "text", text: capped.data + (capped.truncated ? "[...truncated]" : "") },
          durationMs: Date.now() - start,
        };
      }
      case "html2md": {
        const md = htmlToMd(text);
        const capped = this.sb.capOutput(md);
        return {
          type: CAP, source: this.id, ok: true,
          payload: { kind: "text", text: capped.data + (capped.truncated ? "[...truncated]" : "") },
          durationMs: Date.now() - start,
        };
      }
      case "extract": {
        const plain = extractText(text);
        const capped = this.sb.capOutput(plain);
        return {
          type: CAP, source: this.id, ok: true,
          payload: { kind: "text", text: capped.data + (capped.truncated ? "[...truncated]" : "") },
          durationMs: Date.now() - start,
        };
      }
      case "toc": {
        const toc = generateToc(text);
        const capped = this.sb.capOutput(toc);
        return {
          type: CAP, source: this.id, ok: true,
          payload: { kind: "text", text: capped.data + (capped.truncated ? "[...truncated]" : "") },
          durationMs: Date.now() - start,
        };
      }
      default:
        throw new ToolError("E_TOOL_FAILED", `MarkupTool: unknown op "${op}"`, { op });
    }
  }
}

/** Simple Markdown → HTML converter (no deps). */
function mdToHtml(md: string): string {
  let html = md;
  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  // Headers
  html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Bold / italic
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Images
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
  // Lists
  html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
  // Paragraphs (lines not already tagged)
  html = html.replace(/^(?!<[a-z])((?!<[a-z]).+)$/gm, "<p>$1</p>");
  return html;
}

/** Simple HTML → Markdown converter (no deps). */
function htmlToMd(html: string): string {
  let md = html;
  md = md.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, "```\n$1\n```");
  md = md.replace(/<h1>(.+?)<\/h1>/g, "# $1\n");
  md = md.replace(/<h2>(.+?)<\/h2>/g, "## $1\n");
  md = md.replace(/<h3>(.+?)<\/h3>/g, "### $1\n");
  md = md.replace(/<h4>(.+?)<\/h4>/g, "#### $1\n");
  md = md.replace(/<h5>(.+?)<\/h5>/g, "##### $1\n");
  md = md.replace(/<h6>(.+?)<\/h6>/g, "###### $1\n");
  md = md.replace(/<strong>(.+?)<\/strong>/g, "**$1**");
  md = md.replace(/<b>(.+?)<\/b>/g, "**$1**");
  md = md.replace(/<em>(.+?)<\/em>/g, "*$1*");
  md = md.replace(/<i>(.+?)<\/i>/g, "*$1*");
  md = md.replace(/<a href="([^"]+)">([^<]+)<\/a>/g, "[$2]($1)");
  md = md.replace(/<img src="([^"]+)" alt="([^"]*)">/g, "![$2]($1)");
  md = md.replace(/<li>(.+?)<\/li>/g, "- $1\n");
  md = md.replace(/<\/?(ul|ol|div|p)>/g, "");
  md = md.replace(/<br\s*\/?>/g, "\n");
  md = md.replace(/<[^>]+>/g, ""); // strip remaining tags
  return md.trim();
}

/** Extract plain text from HTML. */
function extractText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Generate a table of contents from Markdown headings. */
function generateToc(md: string): string {
  const lines = md.split("\n");
  const toc: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (m) {
      const level = m[1]!.length;
      const text = m[2]!.trim();
      const anchor = text.toLowerCase().replace(/[^\w]+/g, "-").replace(/^-|-$/g, "");
      const indent = "  ".repeat(level - 1);
      toc.push(`${indent}- [${text}](#${anchor})`);
    }
  }
  return toc.join("\n");
}
