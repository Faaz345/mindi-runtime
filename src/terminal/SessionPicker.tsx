import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { SessionSummary } from "../workspace/types.js";
import { COLORS } from "./colors.js";

interface SessionPickerProps {
  sessions: SessionSummary[];
  onResume: (sessionId: string) => void;
  onNew: () => void;
  onDelete: (sessionId: string) => void;
}

const VISIBLE_SESSIONS = 8;

export function SessionPicker({ sessions, onResume, onNew, onDelete }: SessionPickerProps): React.ReactElement {
  const [cursor, setCursor] = useState(0);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const total = sessions.length + 1;

  useEffect(() => {
    setCursor((current) => Math.min(current, sessions.length));
    if (pendingDeleteId && !sessions.some((session) => session.id === pendingDeleteId)) setPendingDeleteId(null);
  }, [sessions, pendingDeleteId]);
  const start = Math.min(
    Math.max(0, cursor - Math.floor(VISIBLE_SESSIONS / 2)),
    Math.max(0, total - VISIBLE_SESSIONS),
  );
  const end = Math.min(total, start + VISIBLE_SESSIONS);

  useInput((input, key) => {
    if (key.upArrow) { setPendingDeleteId(null); setCursor((current) => Math.max(0, current - 1)); }
    if (key.downArrow) { setPendingDeleteId(null); setCursor((current) => Math.min(total - 1, current + 1)); }
    if (key.return) {
      setPendingDeleteId(null);
      if (cursor < sessions.length) onResume(sessions[cursor]!.id);
      else onNew();
    }
    if (input.toLowerCase() === "d" && cursor < sessions.length) {
      const id = sessions[cursor]!.id;
      if (pendingDeleteId === id) onDelete(id);
      else setPendingDeleteId(id);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="double" borderColor={COLORS.azure} paddingX={2} paddingY={1}>
      <Text color={COLORS.azure} bold>Continue a conversation</Text>
      <Text color={COLORS.dim}>Most recent first · ↑↓ Navigate · Enter Select · D Delete</Text>
      {pendingDeleteId && <Text color="#ef4444">Press D again to permanently delete this conversation.</Text>}
      <Box flexDirection="column" marginTop={1}>
        {sessions.map((session, index) => ({ session, index }))
          .filter(({ index }) => index >= start && index < end)
          .map(({ session, index }) => {
            const selected = cursor === index;
            return (
              <Box key={session.id} flexDirection="column" marginBottom={index === Math.min(sessions.length - 1, end - 1) ? 1 : 0}>
                <Text color={selected ? COLORS.sky : COLORS.white} bold={selected} wrap="truncate">
                  {selected ? "❯" : " "} {session.title || "Untitled conversation"}
                </Text>
                <Text color={COLORS.dim} wrap="truncate">
                  {"   "}{session.providerId}/{session.modelId} · {session.messageCount} messages · {formatRelativeTime(session.updatedAt)}
                </Text>
              </Box>
            );
          })}
        {sessions.length >= start && sessions.length < end && (
          <Text color={cursor === sessions.length ? COLORS.sky : COLORS.dim} bold={cursor === sessions.length}>
            {cursor === sessions.length ? "❯" : " "} + Start a new conversation
          </Text>
        )}
      </Box>
      {total > VISIBLE_SESSIONS && <Text color={COLORS.dim}>{cursor + 1}/{total}</Text>}
    </Box>
  );
}

export function resumableSessions(sessions: SessionSummary[]): SessionSummary[] {
  return sessions
    .filter((session) => !session.archived && session.messageCount > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function formatRelativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
