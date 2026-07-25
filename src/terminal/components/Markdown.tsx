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
import { useLayout, wrapText } from "../layout/LayoutEngine.js";
import { COLORS } from "../colors.js";

interface MarkdownProps {
  text: string;
  isStreaming?: boolean;
}

export const Markdown = memo(function Markdown({ text, isStreaming }: MarkdownProps): React.ReactElement {
  const { regions } = useLayout();
  const blocks = parseBlocks(text);
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} width={regions.contentWidth} isStreaming={isStreaming} />
      ))}
    </Box>
  );
}, (prev, next) => prev.text === next.text && prev.isStreaming === next.isStreaming);

// ---------------------------------------------------------------------------
// Block types + parser
// ---------------------------------------------------------------------------

type Block =
  | { type: "code"; lang: string; content: string }
  | { type: "heading"; level: number; content: string }
  | { type: "text"; content: string }
  | { type: "list"; items: string[] }
  | { type: "quote"; content: string }
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
    if (line.startsWith("> ")) {
      const q: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("> ")) { q.push(lines[i]!.slice(2)); i++; }
      blocks.push({ type: "quote", content: q.join("\n") }); continue;
    }
    if (line.match(/^\s*[-*]\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i]!.match(/^\s*[-*]\s+/)) { items.push(lines[i]!.replace(/^\s*[-*]\s+/, "")); i++; }
      blocks.push({ type: "list", items }); continue;
    }
    if (line.match(/^\s*\d+\.\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i]!.match(/^\s*\d+\.\s+/)) { items.push(lines[i]!.replace(/^\s*\d+\.\s+/, "")); i++; }
      blocks.push({ type: "list", items }); continue;
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

const BlockView = memo(function BlockView({ block, width, isStreaming }: { block: Block; width: number; isStreaming?: boolean }): React.ReactElement {
  switch (block.type) {
    case "code": {
      const lines = block.content.split("\n");
      return lines.length <= 40
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
            <Text key={i} wrap="truncate">  <Text color={COLORS.dim}>•</Text> {renderInline(wrapText(item, width - 2))}</Text>
          ))}
        </Box>
      );
    case "quote":
      return <Text color={COLORS.dim} wrap="truncate">│ {wrapText(block.content, width - 2)}</Text>;
    case "hr":
      return <Text color={COLORS.border}>{"─".repeat(Math.min(width, 60))}</Text>;
  }
}, (prev, next) => prev.block === next.block && prev.width === next.width && prev.isStreaming === next.isStreaming);

const ShortCodeBlock = memo(function ShortCodeBlock({ lang, lines, width }: { lang: string; lines: string[]; width: number }): React.ReactElement {
  return (
    <Box flexDirection="column" marginY={0}>
      <Box flexDirection="row" gap={1}>
        <Text color={COLORS.codeLang}>  {lang || "code"}</Text>
        <Text color={COLORS.dim}> {lines.length} lines</Text>
      </Box>
      {lines.map((line, i) => (
        <Text key={i} wrap="truncate">{highlightLine(wrapText(line, width - 2), lang)}</Text>
      ))}
    </Box>
  );
}, (prev, next) => prev.lang === next.lang && prev.lines === next.lines && prev.width === next.width);

const LongCodeBlock = memo(function LongCodeBlock({ lang, lines, width, isStreaming }: { lang: string; lines: string[]; width: number; isStreaming?: boolean }): React.ReactElement {
  const [state, setState] = React.useState<"idle" | "asking" | "saved" | "skipped">("idle");

  React.useEffect(() => {
    if (isStreaming) return undefined;
    if (state === "idle") {
      const t = setTimeout(() => setState("asking"), 200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [state, isStreaming]);

  const ext = langToExtension(lang);
  const suggestedPath = `${process.cwd()}/output.${ext}`;
  const previewLines = lines.slice(0, 15);
  const hiddenCount = lines.length - 15;

  return (
    <Box flexDirection="column" marginY={0}>
      <Box flexDirection="row" gap={1}>
        <Text color={COLORS.codeLang}>  {lang || "code"}</Text>
        <Text color={COLORS.dim}> {lines.length} lines</Text>
      </Box>
      {previewLines.map((line, i) => (
        <Text key={i} wrap="truncate">{highlightLine(wrapText(line, width - 2), lang)}</Text>
      ))}
      {hiddenCount > 0 && <Text color={COLORS.dim}>  ... {hiddenCount} more lines</Text>}
      {state === "asking" && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={COLORS.sky} bold>  Save to file? (Y/n)</Text>
          <Text color={COLORS.dim}>  Path: {suggestedPath}</Text>
        </Box>
      )}
      {state === "saved" && <Text color={COLORS.assistant}>  Saved: {suggestedPath}</Text>}
      {state === "skipped" && <Text color={COLORS.dim}>  (not saved)</Text>}
    </Box>
  );
}, (prev, next) => prev.lang === next.lang && prev.lines === next.lines && prev.width === next.width && prev.isStreaming === next.isStreaming);

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
      else tokens.push({ text: w, color: COLORS.codeDefault });
      remaining = remaining.slice(w.length); continue;
    }
    const fnMatch = remaining.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
    if (fnMatch) { tokens.push({ text: fnMatch[1]!, color: COLORS.codeType }); tokens.push({ text: "(", color: COLORS.codeDefault }); remaining = remaining.slice(fnMatch[0]!.length); continue; }
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
