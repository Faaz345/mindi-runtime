/** Conversation view — memoized to prevent flicker during streaming. */

import React from "react";
import { Box, Text } from "ink";
import type { Message } from "../types.js";
import { Markdown } from "./Markdown.js";
import { COLORS } from "../colors.js";

interface ConversationProps {
  messages: Message[];
  currentStream: string;
  isStreaming: boolean;
  modelId: string;
  elapsedMs?: number;
  etaMs?: number;
}

// Memoize the message list so it doesn't re-render when currentStream changes.
const MemoizedMessages = React.memo(function MemoizedMessages({ messages }: { messages: readonly Message[] }) {
  return (
    <>
      {messages.map((msg, i) => (
        <MessageView key={i} message={msg} />
      ))}
    </>
  );
}, (prev, next) => prev.messages === next.messages);

export function Conversation({ messages, currentStream, isStreaming, modelId, elapsedMs, etaMs }: ConversationProps): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1} gap={0}>
      <MemoizedMessages messages={messages} />
      {isStreaming && currentStream && (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text color={COLORS.assistant} bold>{modelId}</Text>
            {elapsedMs !== undefined && elapsedMs > 0 && (
              <Text color={COLORS.timer}> {formatMs(elapsedMs)}</Text>
            )}
            {etaMs !== undefined && etaMs > 0 && (
              <Text color={COLORS.dim}> ~{formatMs(etaMs)} remaining</Text>
            )}
          </Box>
          <Markdown text={currentStream} isStreaming={true} />
        </Box>
      )}
    </Box>
  );
}

const MessageView = React.memo(function MessageView({ message }: { message: Message }): React.ReactElement {
  if (message.role === "user") {
    return (
      <Box flexDirection="column" marginTop={0}>
        <Text color={COLORS.user} bold wrap="truncate">{"› "}{message.attachments && message.attachments.length > 0
          ? `[${message.attachments.length} attachment(s)] `
          : ""}{message.content}</Text>
      </Box>
    );
  }
  if (message.role === "assistant") {
    return (
      <Box flexDirection="column" marginTop={0}>
        <Box flexDirection="row" gap={1}>
          <Text color={COLORS.assistant} bold>{message.modelId || "assistant"}</Text>
          {message.durationMs !== undefined && message.durationMs > 0 && (
            <Text color={COLORS.timer}> {formatMs(message.durationMs)}</Text>
          )}
        </Box>
        <Markdown text={message.content} />
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text color={COLORS.system} wrap="truncate">{message.content}</Text>
    </Box>
  );
});

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m${rs}s`;
}
