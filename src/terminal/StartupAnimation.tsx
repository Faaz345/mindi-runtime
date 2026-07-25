/**
 * Startup animation — electrical signals travelling through circuit paths.
 *
 * The brain is rasterized from the official SVG (brain-only crop).
 * "MINDIGENOUS" and the tagline are rendered as terminal-native text.
 *
 * Phases:
 *   1. Dim brain with pulse wave from center outward
 *   2. Brain brightens to full visibility
 *   3. Underline draws left to right
 *   4. "MINDIGENOUS" text appears (terminal monospace, bold cyan)
 *   5. Tagline appears (dim gray)
 *
 * Any key skips. Total under 2 seconds.
 */

import React, { useState, useEffect, useMemo } from "react";
import { Text, Box } from "ink";
import { renderLogo, clearLogoCache, type RenderResult } from "./logo-renderer.js";

type Phase = "pulse" | "reveal" | "underline" | "wordmark" | "tagline" | "done";

export function StartupAnimation({ onDone }: { onDone: () => void }): React.ReactElement {
  const logo = useMemo<RenderResult>(() => {
    clearLogoCache();
    try {
      return renderLogo({});
    } catch {
      return { lines: ["  [brain]"], brightness: [], width: 20, height: 1, wordmark: "MINDIGENOUS", tagline: "One Runtime. Any Model. Unlimited Capabilities." };
    }
  }, []);

  const [phase, setPhase] = useState<Phase>("pulse");
  const [pulseProgress, setPulseProgress] = useState(0);
  const [globalBrightness, setGlobalBrightness] = useState(0.2);
  const [underlineLen, setUnderlineLen] = useState(0);
  const [wordmarkVisible, setWordmarkVisible] = useState(false);
  const [taglineVisible, setTaglineVisible] = useState(false);

  // No useInput — animation auto-completes.

  useEffect(() => {

    const FRAME_MS = 30;
    let elapsed = 0;

    // Timing (total ~1800ms):
    //   0-700ms:    pulse (electrical signals from center outward)
    //   700-1100ms: reveal (brain brightens to full)
    //   1100-1300ms: underline draws
    //   1300-1500ms: wordmark appears
    //   1500-1800ms: tagline appears
    const T = {
      pulse: 700,
      reveal: 400,
      underline: 200,
      wordmark: 200,
      tagline: 300,
    };

    const timer = setInterval(() => {
      elapsed += FRAME_MS;

      if (elapsed < T.pulse) {
        const p = elapsed / T.pulse;
        setPhase("pulse");
        setPulseProgress(p);
        setGlobalBrightness(0.2 + p * 0.3);
      } else if (elapsed < T.pulse + T.reveal) {
        const p = (elapsed - T.pulse) / T.reveal;
        setPhase("reveal");
        setPulseProgress(1);
        setGlobalBrightness(0.5 + p * 0.5);
      } else if (elapsed < T.pulse + T.reveal + T.underline) {
        const p = (elapsed - T.pulse - T.reveal) / T.underline;
        setPhase("underline");
        setGlobalBrightness(1);
        setUnderlineLen(Math.floor(p * logo.wordmark.length));
      } else if (elapsed < T.pulse + T.reveal + T.underline + T.wordmark) {
        const p = (elapsed - T.pulse - T.reveal - T.underline) / T.wordmark;
        setPhase("wordmark");
        setUnderlineLen(logo.wordmark.length);
        setWordmarkVisible(p > 0.3);
      } else if (elapsed < T.pulse + T.reveal + T.underline + T.wordmark + T.tagline) {
        const p = (elapsed - T.pulse - T.reveal - T.underline - T.wordmark) / T.tagline;
        setPhase("tagline");
        setTaglineVisible(p > 0.3);
      } else {
        setPhase("done");
        setTaglineVisible(true);
        clearInterval(timer);
        setTimeout(onDone, 200);
      }
    }, FRAME_MS);

    return () => clearInterval(timer);
  }, [onDone, logo.wordmark.length]);

  // Compute display lines with brightness modulation.
  const displayLines = useMemo(() => {
    if (globalBrightness >= 1 && phase !== "pulse") return logo.lines;

    const centerY = Math.floor(logo.height / 2);
    const centerX = Math.floor(logo.width / 2);
    const maxDist = Math.sqrt(centerX ** 2 + centerY ** 2);

    return logo.lines.map((line, y) => {
      let result = "";
      for (let x = 0; x < line.length; x++) {
        const ch = line[x]!;
        if (ch === " ") { result += " "; continue; }

        if (phase === "pulse") {
          const dist = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2) / maxDist;
          if (dist > pulseProgress + 0.08) {
            // Ahead of wavefront —
            result += dimChar(ch);
          } else {
            result += ch;
          }
        } else {
          result += ch;
        }
      }
      return result;
    });
  }, [logo.lines, logo.height, logo.width, globalBrightness, pulseProgress, phase]);

  function dimChar(ch: string): string {
    switch (ch) {
      case "█": return "▒";
      case "▓": return "░";
      case "▒": return " ";
      case "▀": return "░";
      case "▄": return "░";
      default: return ch;
    }
  }

  const padLeft = Math.max(0, Math.floor((80 - logo.width) / 2));
  const brainColor = phase === "pulse" ? "cyan" : "white";

  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center">
      {displayLines.map((line, i) => (
        <Text key={i} color={brainColor}>
          {" ".repeat(padLeft)}{line}
        </Text>
      ))}
      {underlineLen > 0 && (
        <Text color="cyan">{"─".repeat(underlineLen)}</Text>
      )}
      {wordmarkVisible && (
        <Text bold color="cyan">{logo.wordmark}</Text>
      )}
      {taglineVisible && (
        <Text>{logo.tagline}</Text>
      )}
    </Box>
  );
}
