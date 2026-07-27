/** Header bar — blue gradient palette. Width-safe: never wraps, so Ink's
 *  line accounting stays exact (wrapping headers are the #1 cause of
 *  duplicated output in Ink apps). */

import React from "react";
import { Box, Text, useWindowSize } from "ink";
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
  const { columns } = useWindowSize();

  // Fixed segments.
  const brand = "MINDIGENOUS";
  const model = `${providerId}/${modelId}`;
  const session = sessionId.slice(0, 8);
  const stats = `↑${metrics.requests.total} ◇${metrics.capabilities.total} ∑${metrics.tokensUsed}`;

  // Budget: borders (2) + paddingX (2) + gaps between segments.
  // Progressively drop lower-priority segments as the terminal narrows.
  const baseLen = brand.length + model.length + session.length + stats.length + 14;
  const showWorkspace = columns > baseLen + 24;
  const showSession = columns > baseLen - 24;

  // Truncate the workspace path to whatever space remains.
  const wsBudget = showWorkspace ? Math.max(8, columns - baseLen - 4) : 0;
  const ws = showWorkspace ? truncateMiddle(workspace, wsBudget) : "";

  return (
    <Box flexDirection="row" justifyContent="space-between" borderStyle="single" borderColor={COLORS.border} paddingX={1}>
      <Box gap={1}>
        <Text bold color={COLORS.header} wrap="truncate">{brand}</Text>
        <Text color={COLORS.dim}>│</Text>
        <Text color={COLORS.azure} wrap="truncate">{providerId}</Text>
        <Text color={COLORS.dim}>/</Text>
        <Text color={COLORS.white} wrap="truncate">{modelId}</Text>
        {showSession && (
          <>
            <Text color={COLORS.dim}>│</Text>
            <Text color={COLORS.dim} wrap="truncate">{session}</Text>
          </>
        )}
      </Box>
      <Box gap={1}>
        {showWorkspace && <Text color={COLORS.dim} wrap="truncate">{ws}</Text>}
        {showWorkspace && <Text color={COLORS.dim}>│</Text>}
        <Text color={COLORS.dim} wrap="truncate">{stats}</Text>
      </Box>
    </Box>
  );
}

function truncateMiddle(s: string, n: number): string {
  if (s.length <= n) return s;
  if (n < 8) return s.slice(0, n);
  const half = Math.floor((n - 1) / 2);
  return s.slice(0, half) + "…" + s.slice(s.length - half);
}
