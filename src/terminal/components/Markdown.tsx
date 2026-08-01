/**
 * Markdown renderer — uses Layout Engine for wrapping.
 *
 * Architecture:
 *   Raw text → parseBlocks → BlockView (memoized) → wrapText(width) → render
 *
 * No wrapped text is ever stored. All wrapping is computed at render time
 * using the current terminal width from LayoutContext.
 *
 * All block components are memoized to prevent re-rendering completed blocks.
 */

import React, { memo } from "react";
import { Box, Text } from "ink";
import fs from "node:fs";
import path from "node:path";
import { useLayout, wrapText } from "../layout/LayoutEngine.js";
import { COLORS } from "../colors.js";

interface MarkdownProps {
  text: string;
  isStreaming?: boolean;
  expandCode?: boolean;
}

export const Markdown = memo(function Markdown({ text, isStreaming, expandCode }: MarkdownProps): React.ReactElement {
  const { regions } = useLayout();
  const blocks = parseBlocks(text);
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} width={regions.contentWidth} isStreaming={isStreaming} expandCode={expandCode} />
      ))}
    </Box>
  );
}, (prev, next) => prev.text === next.text && prev.isStreaming === next.isStreaming && prev.expandCode === next.expandCode);

// ---------------------------------------------------------------------------
// Block types + parser
// ---------------------------------------------------------------------------

type Block =
  | { type: "code"; lang: string; content: string }
  | { type: "heading"; level: number; content: string }
  | { type: "text"; content: string }
  | { type: "list"; items: string[]; ordered: boolean }
  | { type: "quote"; content: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "hr" };

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) { codeLines.push(lines[i]!); i++; }
      i++;
      blocks.push({ type: "code", lang, content: codeLines.join("\n") });
      continue;
    }
    const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) { blocks.push({ type: "heading", level: hMatch[1]!.length, content: hMatch[2]! }); i++; continue; }
    if (line.trim() === "---" || line.trim() === "***") { blocks.push({ type: "hr" }); i++; continue; }
    // Table detection: line with | separators followed by a |---|---| separator row.
    if (line.includes("|") && i + 1 < lines.length && lines[i + 1]!.match(/^\s*\|?[\s\-:|]+\|/)) {
      const headers = line.split("|").map((c) => c.trim()).filter(Boolean);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        rows.push(lines[i]!.split("|").map((c) => c.trim()).filter(Boolean));
        i++;
      }
      blocks.push({ type: "table", headers, rows }); continue;
    }
    if (line.startsWith("> ")) {
      const q: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("> ")) { q.push(lines[i]!.slice(2)); i++; }
      blocks.push({ type: "quote", content: q.join("\n") }); continue;
    }
    if (line.match(/^\s*[-*]\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i]!.match(/^\s*[-*]\s+/)) { items.push(lines[i]!.replace(/^\s*[-*]\s+/, "")); i++; }
      blocks.push({ type: "list", items, ordered: false }); continue;
    }
    if (line.match(/^\s*\d+\.\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i]!.match(/^\s*\d+\.\s+/)) { items.push(lines[i]!.replace(/^\s*\d+\.\s+/, "")); i++; }
      blocks.push({ type: "list", items, ordered: true }); continue;
    }
    const t: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !lines[i]!.startsWith("```") && !lines[i]!.match(/^#{1,6}\s/) && !lines[i]!.startsWith("> ") && !lines[i]!.match(/^\s*[-*]\s+/) && !lines[i]!.match(/^\s*\d+\.\s+/)) { t.push(lines[i]!); i++; }
    if (t.length > 0) blocks.push({ type: "text", content: t.join(" ") });
    else i++;
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Memoized block views
// ---------------------------------------------------------------------------

const BlockView = memo(function BlockView({ block, width, isStreaming, expandCode }: { block: Block; width: number; isStreaming?: boolean; expandCode?: boolean }): React.ReactElement {
  switch (block.type) {
    case "code": {
      const lines = block.content.split("\n");
      // Diff blocks get special rendering.
      if (block.lang === "diff" || block.lang === "patch") {
        return <DiffBlock lines={lines} width={width} />;
      }
      return expandCode || lines.length <= 40
        ? <ShortCodeBlock lang={block.lang} lines={lines} width={width} />
        : <LongCodeBlock lang={block.lang} lines={lines} width={width} isStreaming={isStreaming} />;
    }
    case "heading":
      return <Text bold color={COLORS.header}>{wrapText("#".repeat(block.level) + " " + block.content, width)}</Text>;
    case "text":
      return <Text wrap="truncate">{renderInline(wrapText(block.content, width))}</Text>;
    case "list":
      return (
        <Box flexDirection="column">
          {block.items.map((item, i) => (
            <Text key={i} wrap="truncate">  <Text color={COLORS.dim}>{block.ordered ? `${i + 1}.` : "•"}</Text> {renderInline(wrapText(item, width - 4))}</Text>
          ))}
        </Box>
      );
    case "quote":
      return <Text color={COLORS.dim} wrap="truncate">│ {wrapText(block.content, width - 2)}</Text>;
    case "table":
      return <TableView headers={block.headers} rows={block.rows} width={width} />;
    case "hr":
      return <Text color={COLORS.border}>{"─".repeat(Math.min(width, 60))}</Text>;
    default:
      return <Text>{""}</Text>;
  }
}, (prev, next) => prev.block === next.block && prev.width === next.width && prev.isStreaming === next.isStreaming && prev.expandCode === next.expandCode);

const ShortCodeBlock = memo(function ShortCodeBlock({ lang, lines, width }: { lang: string; lines: string[]; width: number }): React.ReactElement {
  return (
    <Box flexDirection="column" marginY={0} borderStyle="single" borderColor={COLORS.border} borderLeft={true} borderTop={false} borderBottom={false} borderRight={false} paddingLeft={1}>
      <Box flexDirection="row" gap={1}>
        <Text color={COLORS.codeLang}>{lang || "code"}</Text>
        <Text color={COLORS.dim}> {lines.length} lines</Text>
      </Box>
      {lines.map((line, i) => (
        <Text key={i} wrap="truncate"><Text color={COLORS.codeLineNumber}>{String(i + 1).padStart(String(lines.length).length)} │</Text>{highlightLine(wrapText(line, width - 10), lang)}</Text>
      ))}
    </Box>
  );
}, (prev, next) => prev.lang === next.lang && prev.lines === next.lines && prev.width === next.width);

const LongCodeBlock = memo(function LongCodeBlock({ lang, lines, width, isStreaming }: { lang: string; lines: string[]; width: number; isStreaming?: boolean }): React.ReactElement {
  // Auto-save the full code block to .mindi/cache/code-blocks/ once streaming
  // completes, then offer a Ctrl+Click hyperlink (OSC 8) to open it — plus a
  // hint for /expand to print it inline. This replaces the old dead
  // "Save to file? (Y/n)" prompt that had no input handler.
  const ext = langToExtension(lang);
  const [savedPath, setSavedPath] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (isStreaming) return; // wait for the complete block
    setSavedPath((prev) => prev ?? saveCodeBlock(lines.join("\n"), ext));
    return undefined;
  }, [isStreaming, lines, ext]);

  const previewLines = lines.slice(0, 15);
  const hiddenCount = lines.length - 15;

  return (
    <Box flexDirection="column" marginY={0}>
      <Box flexDirection="row" gap={1}>
        <Text color={COLORS.codeLang}>  {lang || "code"}</Text>
        <Text color={COLORS.dim}> {lines.length} lines</Text>
      </Box>
      {previewLines.map((line, i) => (
        <Text key={i} wrap="truncate"><Text color={COLORS.codeLineNumber}>{String(i + 1).padStart(String(lines.length).length)} │</Text>{highlightLine(wrapText(line, width - 8), lang)}</Text>
      ))}
      {hiddenCount > 0 && <Text color={COLORS.dim}>  ... {hiddenCount} more lines</Text>}
      {!isStreaming && savedPath && (
        <Text color={COLORS.dim}>  {"  "}💾 Full code saved — <Text color={COLORS.link} underline>{hyperlink(`Ctrl+Click to open`, savedPath)}</Text>
          <Text color={COLORS.dim}> · or type /expand</Text>
        </Text>
      )}
    </Box>
  );
}, (prev, next) => prev.lang === next.lang && prev.lines === next.lines && prev.width === next.width && prev.isStreaming === next.isStreaming);

/** Diff block — green for additions, red for deletions, dim for context. */
const DiffBlock = memo(function DiffBlock({ lines, width }: { lines: string[]; width: number }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color={COLORS.codeLang}>  diff</Text>
      {lines.map((line, i) => {
        if (line.startsWith("+")) return <Text key={i} color="#4ec959" wrap="truncate">{wrapText(line, width)}</Text>;
        if (line.startsWith("-")) return <Text key={i} color="#f14c4c" wrap="truncate">{wrapText(line, width)}</Text>;
        if (line.startsWith("@@")) return <Text key={i} color={COLORS.codeLang} wrap="truncate">{wrapText(line, width)}</Text>;
        return <Text key={i} color={COLORS.dim} wrap="truncate">{wrapText(line, width)}</Text>;
      })}
    </Box>
  );
}, (prev, next) => prev.lines === next.lines && prev.width === next.width);

/** Table view — aligned columns with header separator. */
const TableView = memo(function TableView({ headers, rows, width }: { headers: string[]; rows: string[][]; width: number }): React.ReactElement {
  // Compute column widths (capped to fit terminal).
  const colWidths = headers.map((h, ci) => {
    const maxData = rows.reduce((max, row) => Math.max(max, (row[ci] ?? "").length), 0);
    return Math.min(Math.max(h.length, maxData), Math.floor((width - 4) / headers.length));
  });
  const pad = (s: string, w: number) => s.length > w ? s.slice(0, w - 1) + "…" : s.padEnd(w);
  const sep = colWidths.map((w) => "─".repeat(w)).join("─┼─");

  return (
    <Box flexDirection="column">
      <Text bold color={COLORS.header} wrap="truncate"> {headers.map((h, i) => pad(h, colWidths[i]!)).join(" │ ")}</Text>
      <Text color={COLORS.border} wrap="truncate"> {sep}</Text>
      {rows.map((row, ri) => (
        <Text key={ri} wrap="truncate"> {row.map((cell, ci) => pad(cell, colWidths[ci] ?? 8)).join(" │ ")}</Text>
      ))}
    </Box>
  );
}, (prev, next) => prev.headers === next.headers && prev.rows === next.rows && prev.width === next.width);

// ---------------------------------------------------------------------------
// Syntax highlighting (unchanged)
// ---------------------------------------------------------------------------

const KEYWORDS = new Set([
  "const","let","var","function","return","if","else","for","while","do","switch","case","break","continue","new","delete","typeof","instanceof","void","this","class","extends","super","import","export","from","default","async","await","try","catch","finally","throw","yield","static","get","set","public","private","protected","readonly","interface","type","enum","namespace","declare","abstract","implements","def","elif","lambda","pass","with","as","in","is","not","and","or","None","True","False","self","func","go","chan","select","defer","package","struct","map","range","nil",
]);
const TYPES = new Set([
  "string","number","boolean","object","any","unknown","never","void","Array","Map","Set","Promise","Date","RegExp","Error","JSON","Object","String","Number","Boolean","Symbol","BigInt","Record","Partial","Readonly","Pick","Omit","Uint8Array","Buffer","ReadableStream","Response","Request",
]);

function highlightLine(line: string, lang: string): React.ReactNode {
  const tokens: Array<{ text: string; color?: string }> = [];
  const commentIdx = findCommentStart(line, lang);
  let codePart = line, commentPart = "";
  if (commentIdx >= 0) { codePart = line.slice(0, commentIdx); commentPart = line.slice(commentIdx); }
  let remaining = codePart;
  while (remaining.length > 0) {
    const strMatch = remaining.match(/^(['"`])(?:(?!\1).)*\1?/);
    if (strMatch) { tokens.push({ text: strMatch[0], color: COLORS.codeString }); remaining = remaining.slice(strMatch[0]!.length); continue; }
    const numMatch = remaining.match(/^\d+\.?\d*/);
    if (numMatch) { tokens.push({ text: numMatch[0], color: COLORS.codeNumber }); remaining = remaining.slice(numMatch[0]!.length); continue; }
    const idMatch = remaining.match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    if (idMatch) {
      const w = idMatch[0]!;
      if (KEYWORDS.has(w)) tokens.push({ text: w, color: COLORS.codeKeyword });
      else if (TYPES.has(w)) tokens.push({ text: w, color: COLORS.codeType });
      else if (w[0] === w[0]!.toUpperCase() && w[0] !== w[0]!.toLowerCase()) tokens.push({ text: w, color: COLORS.codeType });
      else if (remaining.slice(w.length).match(/^\s*\(/)) tokens.push({ text: w, color: COLORS.codeFunction });
      else tokens.push({ text: w, color: COLORS.codeDefault });
      remaining = remaining.slice(w.length); continue;
    }
    const wsMatch = remaining.match(/^\s+/);
    if (wsMatch) { tokens.push({ text: wsMatch[0] }); remaining = remaining.slice(wsMatch[0]!.length); continue; }
    tokens.push({ text: remaining[0]!, color: COLORS.codeDefault }); remaining = remaining.slice(1);
  }
  if (commentPart) tokens.push({ text: commentPart, color: COLORS.codeComment });
  return <>{" "}{tokens.map((tok, i) => <Text key={i} color={tok.color}>{tok.text}</Text>)}</>;
}

function findCommentStart(line: string, lang: string): number {
  const cc = lang === "python" || lang === "py" ? "#" : "//";
  let inStr = false, sc = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inStr) { if (ch === sc) inStr = false; }
    else {
      if (ch === '"' || ch === "'" || ch === "`") { inStr = true; sc = ch; }
      else if (cc === "#" && ch === "#") return i;
      else if (cc === "//" && ch === "/" && line[i+1] === "/") return i;
    }
  }
  return -1;
}

function langToExtension(lang: string): string {
  const m: Record<string,string> = { javascript:"js",js:"js",jsx:"jsx",typescript:"ts",ts:"ts",tsx:"tsx",python:"py",py:"py",html:"html",css:"css",scss:"scss",json:"json",yaml:"yml",yml:"yml",bash:"sh",sh:"sh",shell:"sh",sql:"sql",go:"go",rust:"rs",java:"java",c:"c",cpp:"cpp",php:"php",ruby:"rb",dart:"dart",xml:"xml",markdown:"md",md:"md" };
  return m[lang.toLowerCase()] ?? "txt";
}

// ---------------------------------------------------------------------------
// Full-code viewing: auto-save + OSC 8 hyperlink
// ---------------------------------------------------------------------------

/**
 * Save a complete code block to .mindi/cache/code-blocks/ and return the
 * absolute path. Returns null on failure (viewing is best-effort).
 */
function saveCodeBlock(content: string, ext: string): string | null {
  try {
    const dir = path.join(process.cwd(), ".mindi", "cache", "code-blocks");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `code-${Date.now()}.${ext}`);
    fs.writeFileSync(file, content, "utf8");
    return file;
  } catch {
    return null;
  }
}

/**
 * Wrap text in an OSC 8 terminal hyperlink. In Windows Terminal, iTerm2,
 * WezTerm, and most modern terminals, the text becomes Ctrl+Click-able and
 * opens the target in the default app (browser/editor).
 */
function hyperlink(text: string, filePath: string): string {
  const url = `file:///${filePath.replace(/\\/g, "/")}`;
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

// ---------------------------------------------------------------------------
// Inline formatting
// ---------------------------------------------------------------------------

function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = text, key = 0;
  while (remaining.length > 0) {
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) { parts.push(<Text key={key++} color={COLORS.codeString}>{codeMatch[1]}</Text>); remaining = remaining.slice(codeMatch[0]!.length); continue; }
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) { parts.push(<Text key={key++} bold>{boldMatch[1]}</Text>); remaining = remaining.slice(boldMatch[0]!.length); continue; }
    const italicMatch = remaining.match(/^\*(.+?)\*/);
    if (italicMatch) { parts.push(<Text key={key++} italic>{italicMatch[1]}</Text>); remaining = remaining.slice(italicMatch[0]!.length); continue; }
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) { parts.push(<Text key={key++} color={COLORS.link} underline>{linkMatch[1]}</Text>); remaining = remaining.slice(linkMatch[0]!.length); continue; }
    const nextSpecial = remaining.search(/[`*\[]/);
    if (nextSpecial < 0) { parts.push(<Text key={key++}>{remaining}</Text>); break; }
    if (nextSpecial === 0) { parts.push(<Text key={key++}>{remaining[0]}</Text>); remaining = remaining.slice(1); }
    else { parts.push(<Text key={key++}>{remaining.slice(0, nextSpecial)}</Text>); remaining = remaining.slice(nextSpecial); }
  }
  return <>{parts}</>;
}
