/** Conversation view — memoized to prevent flicker during streaming. */

import React from "react";
import { Box, Text } from "ink";
import type { Message } from "../types.js";
import { Markdown } from "./Markdown.js";
import { ActivityFeed } from "./ActivityFeed.js";
import { COLORS } from "../colors.js";

interface ConversationProps {
  messages: Message[];
  currentStream: string;
  isStreaming: boolean;
  modelId: string;
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

export function Conversation({ messages, currentStream, isStreaming, modelId }: ConversationProps): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1} gap={0}>
      <MemoizedMessages messages={messages} />
      {isStreaming && currentStream && (
        <StreamingMessage modelId={modelId} text={currentStream} />
      )}
    </Box>
  );
}

/** Live streaming message — only this re-renders as tokens arrive. */
export function StreamingMessage({ modelId, text }: { modelId: string; text: string }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color={COLORS.assistant} bold>{modelId}</Text>
      </Box>
      <Markdown text={text} isStreaming={true} />
    </Box>
  );
}

export const MessageView = React.memo(function MessageView({ message }: { message: Message }): React.ReactElement {
  if (message.role === "user") {
    // Claude Code style: the user's own prompt is echoed on a light
    // background band so it stands out clearly from the AI's output.
    const attachNote = message.attachments && message.attachments.length > 0
      ? `[${message.attachments.length} attachment(s)] `
      : "";
    const displayContent = markImagePaths(message.content);
    return (
      <Box flexDirection="column" marginTop={0}>
        <Box>
          <Text backgroundColor={COLORS.promptBg} color={COLORS.promptText} bold>
            {" › "}{attachNote}{displayContent}{" "}
          </Text>
        </Box>
      </Box>
    );
  }
  if (message.role === "assistant") {
    return (
      <Box flexDirection="column" marginTop={0}>
        {/* Persisted backend steps that produced this response. */}
        {message.activities && message.activities.length > 0 && (
          <Box marginBottom={0}>
            <ActivityFeed items={message.activities} showSpinner={false} />
          </Box>
        )}
        <Box flexDirection="row" gap={1}>
          <Text color={COLORS.assistant} bold>{message.modelId || "assistant"}</Text>
          {message.durationMs !== undefined && message.durationMs > 0 && (
            <Text color={COLORS.timer}> {formatMs(message.durationMs)}</Text>
          )}
        </Box>
        <Markdown text={message.content} expandCode={message.expandCode} />
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {/* Error messages wrap fully so the real upstream reason + hint is
          visible; other system lines stay compact/truncated. */}
      {message.content.startsWith("Error:") ? (
        <Box flexDirection="column">
          <Text color="#ef4444">{message.content.split("\n")[0]}</Text>
          {message.content.includes("\n") && (
            <Text color={COLORS.dim}>{message.content.split("\n").slice(1).join("\n")}</Text>
          )}
        </Box>
      ) : (
        <Text color={COLORS.system} wrap="truncate">{message.content}</Text>
      )}
    </Box>
  );
});

function markImagePaths(text: string): string {
  return text.replace(
    /("[^"\r\n]+\.(?:png|jpe?g|gif|webp|bmp|tiff?)"|'[^'\r\n]+\.(?:png|jpe?g|gif|webp|bmp|tiff?)'|(?:[A-Za-z]:[\\/]|\/)[^\s"']+\.(?:png|jpe?g|gif|webp|bmp|tiff?))/gi,
    "[image]",
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
