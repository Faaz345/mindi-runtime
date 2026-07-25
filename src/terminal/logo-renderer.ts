/**
 * SVG → Terminal logo renderer (layered).
 *
 * The official SVG contains:
 *   - Brain icon (y=0..~710 of the 1536×1024 canvas)
 *   - Underline + "MINDIGENOUS" wordmark (y=~747..~816)
 *
 * This renderer splits the SVG into layers:
 *   - Brain layer: rasterized from a brain-only viewBox crop
 *   - Text layer: rendered as ANSI terminal text (bold cyan monospace)
 *
 * Pipeline (brain only):
 *   SVG (cropped to brain region) → Rasterize → Brightness sampling → Unicode blocks
 *
 * No cropping of the brain. No rasterization of the text.
 * The brain is the only rasterized element.
 */

import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RenderOptions {
  width?: number;
  height?: number;
  compact?: boolean;
  color?: string;
  terminalCapabilities?: TerminalCapabilities;
}

export interface TerminalCapabilities {
  kittyGraphics: boolean;
  iterm2Images: boolean;
  sixel: boolean;
  inlineImages: boolean;
}

export interface RenderResult {
  /** Brain block-art lines */
  lines: string[];
  /** Per-pixel brightness 0..1 (for animation) */
  brightness: number[][];
  width: number;
  height: number;
  /** The wordmark text to render separately */
  wordmark: string;
  /** The tagline to render separately */
  tagline: string;
}

// ---------------------------------------------------------------------------
// SVG Loading + Brain Extraction
// ---------------------------------------------------------------------------

const SVG_WIDTH = 1536;

// Brain occupies y=0..720 of the full 1024-height canvas.
const BRAIN_VIEWBOX_H = 720;
const BRAIN_ASPECT = SVG_WIDTH / BRAIN_VIEWBOX_H; // 1536/720 = 2.133

function findSvgPath(): string {
  const candidates = [
    path.join(process.cwd(), "mindigenous-lineart.svg"),
    path.join(process.cwd(), "src", "terminal", "mindigenous-lineart.svg"),
    path.resolve(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")),
      "../../../mindigenous-lineart.svg",
    ),
    path.resolve(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")),
      "../../mindigenous-lineart.svg",
    ),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("mindigenous-lineart.svg not found.");
}

let svgBuffer: Buffer | null = null;
let svgString: string | null = null;
let renderCache: Map<string, RenderResult> = new Map();

function loadSvg(): Buffer {
  if (svgBuffer) return svgBuffer;
  svgBuffer = fs.readFileSync(findSvgPath());
  return svgBuffer;
}

function loadSvgString(): string {
  if (svgString) return svgString;
  svgString = fs.readFileSync(findSvgPath(), "utf8");
  return svgString;
}

/**
 * Create a brain-only SVG by injecting a viewBox that crops to the brain region.
 * The original SVG has no viewBox attribute, so we add one that crops to
 * y=0..720 (the brain area, excluding the wordmark/underline at y=747+).
 */
function getBrainSvg(): Buffer {
  const original = loadSvgString();

  // Inject viewBox to crop to brain region.
  // The original SVG tag: <svg ... width="1536" height="1024">
  // We add: viewBox="0 0 1536 720" and change height to "720".
  // This makes the renderer only process the brain, not the text.
  let brainSvg = original.replace(
    /(<svg[^>]*?)\swidth="1536"\s+height="1024"/,
    '$1 width="1536" height="720" viewBox="0 0 1536 720"',
  );

  // If the replacement didn't match (different attribute order), try another pattern.
  if (!brainSvg.includes('viewBox="0 0 1536 720"')) {
    brainSvg = original.replace(
      /(<svg\b)([^>]*)(>)/,
      '$1$2 viewBox="0 0 1536 720"$3',
    );
  }

  return Buffer.from(brainSvg);
}

// ---------------------------------------------------------------------------
// Terminal Detection
// ---------------------------------------------------------------------------

export function detectTerminalCapabilities(): TerminalCapabilities {
  const termProgram = process.env.TERM_PROGRAM || "";
  const kittyWindowId = process.env.KITTY_WINDOW_ID;
  return {
    kittyGraphics: termProgram === "kitty" || kittyWindowId !== undefined,
    iterm2Images: termProgram === "iTerm.app" || termProgram === "WezTerm" || termProgram === "ghostty",
    sixel: false,
    inlineImages: termProgram === "iTerm.app" || termProgram === "WezTerm" || termProgram === "ghostty" || termProgram === "kitty",
  };
}

// ---------------------------------------------------------------------------
// Brightness → Unicode Block Mapping
// ---------------------------------------------------------------------------

function brightnessToChar(topBright: number, botBright: number): string {
  const t = topBright > 0.5 ? 1 : topBright > 0.15 ? 0.5 : 0;
  const b = botBright > 0.5 ? 1 : botBright > 0.15 ? 0.5 : 0;

  if (t === 1 && b === 1) return "█";
  if (t === 1 && b === 0.5) return "▀";
  if (t === 1 && b === 0) return "▀";
  if (t === 0.5 && b === 1) return "▄";
  if (t === 0 && b === 1) return "▄";
  if (t === 0.5 && b === 0.5) return "▓";
  if (t === 0.5 && b === 0) return "▀";
  if (t === 0 && b === 0.5) return "▄";
  return " ";
}

// ---------------------------------------------------------------------------
// Main Render
// ---------------------------------------------------------------------------

/**
 * Render the MINDIGENOUS brain logo from the official SVG.
 *
 * Only the brain region is rasterized. The wordmark and tagline are
 * returned as separate strings for terminal-native rendering.
 */
export function renderLogo(opts: RenderOptions = {}): RenderResult {
  const termWidth = opts.width ?? process.stdout.columns ?? 80;

  // Target: 16-18 terminal rows for the brain (compact enough to leave
  // room for text + tagline below).
  // Each terminal row = 2 pixel rows (half-block).
  // Brain aspect: 1536/720 = 2.133
  // terminalCols = terminalRows * 2 * brainAspect = terminalRows * 4.267
  // For 16 rows: ~68 cols. For 18 rows: ~77 cols. Both fit in 80.

  let targetRows = opts.compact ? 12 : 16;

  // If terminal is narrow, scale down.
  let targetCols = Math.round(targetRows * 2 * BRAIN_ASPECT);
  if (targetCols > termWidth - 4) {
    targetCols = termWidth - 4;
    targetRows = Math.round(targetCols / (2 * BRAIN_ASPECT));
  }

  if (opts.height) {
    targetRows = Math.min(opts.height - 4, 18);
    targetCols = Math.round(targetRows * 2 * BRAIN_ASPECT);
  }

  // Check cache.
  const cacheKey = `${targetCols}x${targetRows}`;
  const cached = renderCache.get(cacheKey);
  if (cached) return cached;

  // Rasterize the brain-only SVG.
  const pixelWidth = targetCols;
  const pixelHeight = targetRows * 2;

  const brainSvg = getBrainSvg();
  const resvg = new Resvg(brainSvg, {
    fitTo: { mode: "width", value: pixelWidth },
    background: "rgba(0,0,0,0)",
  });
  const rendered = resvg.render();
  const rgba = rendered.pixels;
  const rw = rendered.width;
  const rh = rendered.height;

  // Sample brightness and convert to block art.
  const lines: string[] = [];
  const brightness: number[][] = [];

  for (let py = 0; py < pixelHeight; py += 2) {
    let line = "";
    const lineBrightness: number[] = [];

    for (let px = 0; px < pixelWidth; px++) {
      const sx = Math.min(rw - 1, Math.floor((px / pixelWidth) * rw));
      const sy1 = Math.min(rh - 1, Math.floor((py / pixelHeight) * rh));
      const sy2 = Math.min(rh - 1, Math.floor(((py + 1) / pixelHeight) * rh));

      const idx1 = (sy1 * rw + sx) * 4 + 3;
      const idx2 = (sy2 * rw + sx) * 4 + 3;
      const a1 = idx1 < rgba.length ? rgba[idx1]! / 255 : 0;
      const a2 = idx2 < rgba.length ? rgba[idx2]! / 255 : 0;

      lineBrightness.push(a1, a2);
      line += brightnessToChar(a1, a2);
    }

    lines.push(line);
    brightness.push(lineBrightness);
  }

  const result: RenderResult = {
    lines,
    brightness,
    width: targetCols,
    height: lines.length,
    wordmark: "MINDIGENOUS",
    tagline: "One Runtime. Any Model. Unlimited Capabilities.",
  };

  renderCache.set(cacheKey, result);
  return result;
}

/** Clear the render cache. */
export function clearLogoCache(): void {
  renderCache = new Map();
  svgBuffer = null;
  svgString = null;
}

/** Check if the SVG file exists. */
export function hasSvgLogo(): boolean {
  try {
    loadSvg();
    return true;
  } catch {
    return false;
  }
}
