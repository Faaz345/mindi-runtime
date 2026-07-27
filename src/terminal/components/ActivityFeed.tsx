/**
 * ActivityFeed — live, event-driven view of what the AI is doing.
 *
 * Claude Code style transparency: every backend step appears as a compact
 * row with an icon, a label, a spinner while running, and a duration when
 * finished. Users never wonder whether the AI is working — they can see
 * intent analysis, planning, capability execution, and generation happen
 * in real time, each with its own timing.
 */

import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { ActivityItem } from "../types.js";
import { COLORS } from "../colors.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m${rs}s`;
}

export function ActivityFeed({ items, showSpinner = true }: { items: readonly ActivityItem[]; showSpinner?: boolean }): React.ReactElement | null {
  const [frame, setFrame] = useState(0);
  const hasRunning = showSpinner && items.some((a) => a.status === "running");

  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, [hasRunning]);

  if (items.length === 0) return null;

  return (
    <Box flexDirection="column" marginLeft={2}>
      {items.map((item) => (
        <Box key={item.id} flexDirection="row" gap={1}>
          <Text color={statusColor(item.status)}>
            {item.status === "running" ? SPINNER_FRAMES[frame]! : item.status === "done" ? "✓" : "✗"}
          </Text>
          <Text color={COLORS.ice}>{item.icon}</Text>
          <Text color={item.status === "running" ? COLORS.white : COLORS.dim} bold={item.status === "running"}>
            {item.label}
          </Text>
          {item.detail && <Text color={COLORS.dim}>{item.detail}</Text>}
          {item.durationMs !== undefined && item.status !== "running" && (
            <Text color={COLORS.timer}>{formatMs(item.durationMs)}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

function statusColor(status: ActivityItem["status"]): string {
  switch (status) {
    case "running": return COLORS.sky;
    case "done": return COLORS.assistant;
    case "failed": return "#ef4444";
  }
}
