/** Header bar — blue gradient palette. */

import React from "react";
import { Box, Text } from "ink";
import type { MetricsSnapshot } from "../../index.js";
import { COLORS } from "../colors.js";

interface HeaderProps {
  providerId: string;
  modelId: string;
  sessionId: string;
  workspace: string;
  metrics: MetricsSnapshot;
}

export function Header({ providerId, modelId, sessionId, workspace, metrics }: HeaderProps): React.ReactElement {
  return (
    <Box flexDirection="row" justifyContent="space-between" borderStyle="single" borderColor={COLORS.border} paddingX={1}>
      <Box gap={2}>
        <Text bold color={COLORS.header}>MINDIGENOUS</Text>
        <Text color={COLORS.dim}>│</Text>
        <Text color={COLORS.azure}>{providerId}</Text>
        <Text color={COLORS.dim}>/</Text>
        <Text color={COLORS.white}>{modelId}</Text>
        <Text color={COLORS.dim}>│</Text>
        <Text color={COLORS.dim}>{sessionId.slice(0, 8)}</Text>
      </Box>
      <Box gap={2}>
        <Text color={COLORS.dim}>{workspace}</Text>
        <Text color={COLORS.dim}>│</Text>
        <Text color={COLORS.dim}>↑{metrics.requests.total}</Text>
        <Text color={COLORS.dim}>◇{metrics.capabilities.total}</Text>
        <Text color={COLORS.dim}>∑{metrics.tokensUsed}</Text>
      </Box>
    </Box>
  );
}
