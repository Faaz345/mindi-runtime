/**
 * ArtifactRescue — the safety net for weak models.
 *
 * The tool protocol asks the model to write artifacts via fs.write. Strong
 * models comply; weak free-tier models often dump the code in a markdown
 * fence and declare victory instead. Rather than letting the task fail
 * silently, the orchestrator runs this rescue when an artifact-type task
 * finishes WITHOUT any fs.write:
 *
 *   1. Extract code blocks (≥20 lines) from the model's response.
 *   2. Determine the target path: the user's requested path if present,
 *      else a sensible name derived from the language (index.html, ...).
 *   3. Write via the sandboxed filesystem capability and verify by read-back.
 *
 * The user always ends up with a real file on disk — regardless of whether
 * the model followed the protocol.
 */

import type { CapabilityResult, ExecutionContext } from "../core/types.js";
import type { CapabilityRegistry } from "../registry/CapabilityRegistry.js";

export interface RescuedArtifact {
  path: string;
  bytes: number;
  lang: string;
  verified: boolean;
}

export interface CodeBlock {
  lang: string;
  content: string;
  lineCount: number;
}

const MIN_RESCUE_LINES = 20;

/** Extract fenced code blocks with at least `minLines` lines. */
export function extractCodeBlocks(text: string, minLines = MIN_RESCUE_LINES): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const re = /```([\w+-]*)\n([\s\S]*?)```/g;
  for (const m of text.matchAll(re)) {
    const lang = (m[1] ?? "").toLowerCase().trim();
    const content = (m[2] ?? "").replace(/\n$/, "");
    const lineCount = content.split("\n").length;
    if (lineCount >= minLines && content.trim().length > 0) {
      blocks.push({ lang, content, lineCount });
    }
  }
  // Some instruction-weak models output a complete HTML document without a
  // fence. Recover only an unambiguous full document; never guess at snippets.
  const html = text.match(/(<!doctype\s+html[\s\S]*?<\/html>)/i) ?? text.match(/(<html\b[\s\S]*?<\/html>)/i);
  if (html?.[1] && !blocks.some((block) => block.content.includes(html[1]!))) {
    const content = html[1].trim();
    blocks.push({ lang: "html", content, lineCount: content.split("\n").length });
  }
  // Sort largest first — the primary artifact comes first.
  return blocks.sort((a, b) => b.lineCount - a.lineCount);
}

/** Pick the target path for a block: user's path if given, else derived name. */
export function pickTargetPath(block: CodeBlock, userText: string, workspace: string, used: Set<string>): string {
  const requested = extractRequestedPath(userText);
  const name = requested ?? derivedName(block.lang, used);
  const abs = requested && isAbsolute(requested)
    ? requested
    : joinPath(workspace, name);
  used.add(abs.toLowerCase());
  return abs;
}

/** Extract an explicit file path from the user's text, if any. */
function extractRequestedPath(text: string): string | null {
  const quoted = text.match(/"([^"]+\.[a-zA-Z0-9]{2,5})"/) ?? text.match(/'([^']+\.[a-zA-Z0-9]{2,5})'/);
  if (quoted?.[1] && looksLikeFilePath(quoted[1]) && !isSourceAttachment(quoted[1])) return quoted[1];
  const bare = text.match(/([A-Za-z]:[\\\/][^\s"']+\.[a-zA-Z0-9]{2,5})|(\/[^\s"']+\.[a-zA-Z0-9]{2,5})/);
  const p = bare?.[1] ?? bare?.[2];
  if (p && looksLikeFilePath(p) && !isSourceAttachment(p)) return p;
  return null;
}

function isSourceAttachment(p: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|bmp|tiff?|svg|pdf)$/i.test(p);
}

function looksLikeFilePath(p: string): boolean {
  // Must look like a path (has a separator), not just a bare filename mention.
  return /[\\\/]/.test(p);
}

function derivedName(lang: string, used: Set<string>): string {
  const base: Record<string, string> = {
    html: "index.html",
    css: "style.css",
    js: "script.js", javascript: "script.js", mjs: "script.js",
    ts: "index.ts", typescript: "index.ts",
    jsx: "App.jsx", tsx: "App.tsx",
    py: "main.py", python: "main.py",
    json: "data.json",
    md: "README.md", markdown: "README.md",
    yaml: "config.yaml", yml: "config.yml",
    sql: "query.sql",
    sh: "script.sh", bash: "script.sh", shell: "script.sh",
  };
  const primary = base[lang] ?? `output.${langToExt(lang)}`;
  if (!used.has(primary.toLowerCase())) return primary;
  // De-duplicate: style-2.css, style-3.css, ...
  const dot = primary.lastIndexOf(".");
  const stem = dot > 0 ? primary.slice(0, dot) : primary;
  const ext = dot > 0 ? primary.slice(dot) : "";
  for (let i = 2; i < 100; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

function langToExt(lang: string): string {
  const m: Record<string, string> = {
    javascript: "js", typescript: "ts", python: "py", markdown: "md", yaml: "yml", shell: "sh",
  };
  return m[lang] ?? (lang || "txt");
}

function isAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\\/]/.test(p) || p.startsWith("/");
}

function joinPath(a: string, b: string): string {
  const sep = a.endsWith("\\") || a.endsWith("/") ? "" : "\\";
  return a + sep + b;
}

/** Write + verify one artifact via the filesystem capability. */
export async function writeArtifact(
  registry: CapabilityRegistry,
  ctx: ExecutionContext,
  target: string,
  content: string,
): Promise<{ result: CapabilityResult; verified: boolean }> {
  const cap = registry.getByType("filesystem" as never)[0];
  if (!cap) {
    return {
      result: { type: "filesystem", source: "agent", ok: false, payload: { kind: "text", text: "" }, error: "No filesystem executor", durationMs: 0 },
      verified: false,
    };
  }
  const input = { requestId: ctx.requestId, sessionId: ctx.sessionId };
  let result: CapabilityResult;
  try {
    result = await cap.execute({ type: "filesystem", params: { op: "write", path: target, content }, ...input }, ctx);
  } catch (err) {
    result = {
      type: "filesystem",
      source: cap.id,
      ok: false,
      payload: { kind: "text", text: "" },
      error: err instanceof Error ? err.message : String(err),
      durationMs: 0,
    };
  }
  if (!result.ok) return { result, verified: false };
  try {
    const verify = await cap.execute({ type: "filesystem", params: { op: "read", path: target }, ...input }, ctx);
    return { result, verified: verify.ok };
  } catch {
    return { result, verified: false };
  }
}
