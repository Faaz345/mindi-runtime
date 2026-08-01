/**
 * Layout Engine — separates layout computation from rendering.
 *
 * Responsibilities:
 *   - Track terminal dimensions (width, height)
 *   - Compute word wrapping for the current width
 *   - Compute viewport regions (header, conversation, prompt, footer)
 *   - Provide stable layout context to all components
 *
 * This is the single source of truth for all dimensions.
 * Components read from LayoutContext, never from process.stdout directly.
 */

import React, { createContext, useContext, useState, useEffect, useMemo } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TerminalDimensions {
  width: number;
  height: number;
}

export interface LayoutRegions {
  /** Total terminal dimensions */
  terminal: TerminalDimensions;
  /** Header height in rows */
  headerHeight: number;
  /** Footer (status + hints) height in rows */
  footerHeight: number;
  /** Prompt box height in rows (including border) */
  promptHeight: number;
  /** Available conversation viewport height */
  conversationHeight: number;
  /** Available width for content (excluding padding) */
  contentWidth: number;
}

export interface LayoutContextValue {
  dims: TerminalDimensions;
  regions: LayoutRegions;
}

const DEFAULT_DIMS: TerminalDimensions = { width: 80, height: 24 };

const DEFAULT_REGIONS: LayoutRegions = {
  terminal: DEFAULT_DIMS,
  headerHeight: 3,
  footerHeight: 1,
  promptHeight: 3,
  conversationHeight: 17,
  contentWidth: 78,
};

const LayoutContext = createContext<LayoutContextValue>({
  dims: DEFAULT_DIMS,
  regions: DEFAULT_REGIONS,
});

// ---------------------------------------------------------------------------
// Word wrapping (computed at render time, never stored)
// ---------------------------------------------------------------------------

/**
 * Wrap text to fit within `width` columns.
 * Preserves existing newlines — only wraps lines that exceed width.
 * Never stores wrapped text. Always computed fresh from raw text.
 */
export function wrapText(text: string, width: number): string {
  if (width <= 0) return text;
  const inputLines = text.split("\n");
  const outputLines: string[] = [];

  for (const line of inputLines) {
    if (line.length <= width) {
      outputLines.push(line);
      continue;
    }
    // Wrap long lines at word boundaries.
    let remaining = line;
    while (remaining.length > width) {
      // Find the last space within the width.
      let breakAt = remaining.lastIndexOf(" ", width);
      if (breakAt <= 0) {
        // No space found — hard break at width.
        breakAt = width;
      }
      outputLines.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt).trimStart();
    }
    if (remaining.length > 0) {
      outputLines.push(remaining);
    }
  }

  return outputLines.join("\n");
}

/**
 * Truncate a line to fit within `width`, adding ellipsis if truncated.
 */
export function truncateLine(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 3) return text.slice(0, width);
  return text.slice(0, width - 3) + "...";
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function LayoutProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [dims, setDims] = useState<TerminalDimensions>(() => ({
    width: process.stdout.columns ?? 80,
    height: process.stdout.rows ?? 24,
  }));

  useEffect(() => {
    let debounceTimer: NodeJS.Timeout | null = null;
    const onResize = () => {
      // Debounce rapid resize events (e.g. window drag) to prevent flicker.
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        const newDims = {
          width: process.stdout.columns ?? 80,
          height: process.stdout.rows ?? 24,
        };
        setDims(newDims);
        // Soft clear: erase scrollback + screen without cursor jump.
        // This prevents ghost text without the jarring full-screen flash.
        process.stdout.write("\x1b[3J\x1b[2J\x1b[H");
      }, 80);
    };
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, []);

  const regions = useMemo<LayoutRegions>(() => {
    const headerHeight = 3;   // border + content + border
    const footerHeight = 1;   // status/hints line
    const promptHeight = 3;   // border + input + hints (tighter)
    const conversationHeight = Math.max(3, dims.height - headerHeight - footerHeight - promptHeight);
    const contentWidth = Math.max(20, dims.width - 2); // 1 char padding each side

    return {
      terminal: dims,
      headerHeight,
      footerHeight,
      promptHeight,
      conversationHeight,
      contentWidth,
    };
  }, [dims]);

  const value = useMemo(() => ({ dims, regions }), [dims, regions]);

  return React.createElement(LayoutContext.Provider, { value }, children);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useLayout(): LayoutContextValue {
  return useContext(LayoutContext);
}
