/**
 * StatusLine — the single live-status row shown while a request runs.
 *
 * Fully self-contained: owns its spinner timer (80ms) and elapsed/ETA timer
 * (500ms), so the parent Terminal never re-renders on a clock tick. This is
 * the key anti-flicker pattern: fast-updating UI lives in a tiny isolated
 * component; the rest of the tree renders only on real content changes.
 */

import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { RuntimeStage } from "../types.js";
import { COLORS } from "../colors.js";
import { MindiCore, stateForStage } from "./MindiCore.js";

const STAGE_LABELS: Record<RuntimeStage, string> = {
  idle: "",
  thinking: "Thinking",
  negotiating: "Capability Negotiation",
  planning: "Planning Augmentation",
  executing: "Executing Graph",
  capability: "Running Capability",
  context: "Building Context",
  generating: "Generating Response",
};

const STAGE_COLORS: Record<RuntimeStage, string> = {
  idle: COLORS.dim,
  thinking: COLORS.thinking,
  negotiating: COLORS.negotiating,
  planning: COLORS.planning,
  executing: COLORS.executing,
  capability: COLORS.capability,
  context: COLORS.context,
  generating: COLORS.generating,
};

interface StatusLineProps {
  stage: RuntimeStage;
  detail: string;
  /** Request start timestamp (Date.now()). */
  startTime: number;
  /** Refs read on each tick for the ETA estimate (no re-render on change). */
  tokenCountRef: React.MutableRefObject<number>;
  firstTokenTimeRef: React.MutableRefObject<number>;
}

export function StatusLine({ stage, detail, startTime, tokenCountRef, firstTokenTimeRef }: StatusLineProps): React.ReactElement | null {
  const [frame, setFrame] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [etaMs, setEtaMs] = useState(0);

  // MINDI's crystal motion is deliberately slower than a generic spinner.
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => f + 1), 240);
    return () => clearInterval(timer);
  }, []);

  // Elapsed + ETA — 500ms, contained.
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsedMs(Date.now() - startTime);
      const t = tokenCountRef.current;
      if (t > 5 && firstTokenTimeRef.current > 0) {
        const rate = (Date.now() - firstTokenTimeRef.current) / t;
        setEtaMs(Math.round(Math.max(0, Math.max(t * 2, 500) - t) * rate));
      }
    }, 500);
    return () => clearInterval(timer);
  }, [startTime, tokenCountRef, firstTokenTimeRef]);

  if (stage === "idle") return null;

  const label = STAGE_LABELS[stage];
  const color = STAGE_COLORS[stage];
  const coreState = stateForStage(stage, detail);

  return (
    <Box flexDirection="row" gap={1}>
      <MindiCore state={coreState} frame={frame} />
      <Text color={COLORS.azure} bold>MINDI</Text>
      <Text color={color} bold>{label}</Text>
      {detail && <Text color={COLORS.dim}>— {detail}</Text>}
      {elapsedMs > 0 && (
        <Text color={COLORS.timer}> {formatMs(elapsedMs)}{etaMs > 1000 ? ` ~${formatMs(etaMs)} left` : ""}</Text>
      )}
    </Box>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m${rs}s`;
}
