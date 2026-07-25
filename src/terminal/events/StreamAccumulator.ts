/**
 * Event Stream Accumulator
 *
 * Accumulates streamed tokens into stable paragraphs, markdown blocks, and
 * code blocks. Only commits stable chunks to the renderer at 30fps max.
 *
 * This eliminates:
 *   - Excessive rerendering (no per-token renders)
 *   - Duplicated text
 *   - Terminal flickering
 *
 * Pipeline:
 *   Token → Accumulator buffer → Detect block boundaries → Commit stable chunk → Render
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AccumulatedChunk {
  /** The raw markdown text of this chunk */
  text: string;
  /** Type of block this chunk belongs to */
  kind: "paragraph" | "code-block" | "heading" | "list" | "quote" | "hr";
  /** Whether this chunk is still being streamed (incomplete) */
  isStreaming: boolean;
  /** Whether this chunk is complete (final) */
  isComplete: boolean;
}

// ---------------------------------------------------------------------------
// Accumulator
// ---------------------------------------------------------------------------

export class StreamAccumulator {
  private buffer = "";
  private committedChunks: AccumulatedChunk[] = [];
  private lastFlushTime = 0;
  private readonly flushIntervalMs: number;

  constructor(flushIntervalMs = 33) {
    // 33ms = ~30fps
    this.flushIntervalMs = flushIntervalMs;
  }

  /** Append a token to the buffer. */
  append(token: string): void {
    this.buffer += token;
  }

  /**
   * Check if enough time has passed since the last flush.
   * Returns true if a flush should occur.
   */
  shouldFlush(): boolean {
    return Date.now() - this.lastFlushTime >= this.flushIntervalMs;
  }

  /**
   * Flush the accumulated buffer into stable chunks.
   * Returns the updated list of all chunks.
   */
  flush(): AccumulatedChunk[] {
    this.lastFlushTime = Date.now();
    this.committedChunks = this.parseChunks(this.buffer);
    return this.committedChunks;
  }

  /**
   * Finalize — mark all chunks as complete and stop streaming.
   */
  finalize(): AccumulatedChunk[] {
    this.lastFlushTime = Date.now();
    this.committedChunks = this.parseChunks(this.buffer, true);
    return this.committedChunks;
  }

  /** Get the current committed chunks without flushing. */
  getChunks(): AccumulatedChunk[] {
    return this.committedChunks;
  }

  /** Get the full raw text accumulated so far. */
  getRawText(): string {
    return this.buffer;
  }

  /** Reset the accumulator. */
  reset(): void {
    this.buffer = "";
    this.committedChunks = [];
    this.lastFlushTime = 0;
  }

  // ---------------------------------------------------------------------------
  // Block detection
  // ---------------------------------------------------------------------------

  private parseChunks(text: string, complete = false): AccumulatedChunk[] {
    const lines = text.split("\n");
    const chunks: AccumulatedChunk[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i]!;
      const isLastLine = i === lines.length - 1;

      // Code block.
      if (line.startsWith("```")) {
        const codeLines: string[] = [line];
        i++;
        let closed = false;
        while (i < lines.length) {
          codeLines.push(lines[i]!);
          if (lines[i]!.startsWith("```")) { closed = true; i++; break; }
          i++;
        }
        chunks.push({
          text: codeLines.join("\n"),
          kind: "code-block",
          isStreaming: !closed && complete === false,
          isComplete: closed,
        });
        continue;
      }

      // Heading.
      const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (hMatch) {
        chunks.push({ text: line, kind: "heading", isStreaming: false, isComplete: true });
        i++;
        continue;
      }

      // Horizontal rule.
      if (line.trim() === "---" || line.trim() === "***") {
        chunks.push({ text: line, kind: "hr", isStreaming: false, isComplete: true });
        i++;
        continue;
      }

      // Block quote.
      if (line.startsWith("> ")) {
        const q: string[] = [];
        while (i < lines.length && lines[i]!.startsWith("> ")) { q.push(lines[i]!); i++; }
        chunks.push({ text: q.join("\n"), kind: "quote", isStreaming: false, isComplete: true });
        continue;
      }

      // List items.
      if (line.match(/^\s*[-*]\s+/) || line.match(/^\s*\d+\.\s+/)) {
        const items: string[] = [];
        while (i < lines.length && (lines[i]!.match(/^\s*[-*]\s+/) || lines[i]!.match(/^\s*\d+\.\s+/))) {
          items.push(lines[i]!); i++;
        }
        chunks.push({ text: items.join("\n"), kind: "list", isStreaming: isLastLine && !complete, isComplete: !isLastLine || complete });
        continue;
      }

      // Paragraph (text until blank line or special block start).
      const para: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== "" && !lines[i]!.startsWith("```") && !lines[i]!.match(/^#{1,6}\s/) && !lines[i]!.startsWith("> ") && !lines[i]!.match(/^\s*[-*]\s+/) && !lines[i]!.match(/^\s*\d+\.\s+/)) {
        para.push(lines[i]!); i++;
      }
      if (para.length > 0) {
        chunks.push({ text: para.join(" "), kind: "paragraph", isStreaming: isLastLine && !complete, isComplete: !isLastLine || complete });
      } else {
        i++;
      }
    }

    return chunks;
  }
}
