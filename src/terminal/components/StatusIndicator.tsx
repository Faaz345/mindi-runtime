/** Compact live status indicator with thinking animation — blue palette. */

import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { RuntimeStage } from "../types.js";
import { COLORS } from "../colors.js";

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

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function StatusIndicator({ stage, detail }: { stage: RuntimeStage; detail: string }): React.ReactElement | null {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  if (stage === "idle") return null;

  const label = STAGE_LABELS[stage];
  const color = STAGE_COLORS[stage];
  const spinner = SPINNER_FRAMES[frame]!;

  return (
    <Box flexDirection="row" gap={1}>
      <Text color={color}>{spinner}</Text>
      <Text color={color} bold>{label}</Text>
      {detail && <Text color={COLORS.dim}>— {detail}</Text>}
    </Box>
  );
}
