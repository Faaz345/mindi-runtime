/** Prompt input — pure display, no hooks. Terminal handles all input. */

import React from "react";
import { Box, Text } from "ink";
import { CustomTextInput } from "./CustomTextInput.js";
import type { Attachment } from "../types.js";
import { COLORS } from "../colors.js";

interface SlashCommand {
  cmd: string;
  desc: string;
}

interface PromptInputProps {
  value: string;
  isStreaming: boolean;
  attachments: Attachment[];
  slashCommands?: SlashCommand[];
  slashSelectedIdx?: number;
}

export function PromptInput({
  value,
  isStreaming,
  attachments,
  slashCommands,
  slashSelectedIdx = -1,
}: PromptInputProps): React.ReactElement {
  const showSlashHints = slashCommands && slashCommands.length > 0;

  return (
    <Box flexDirection="column">
      {/* Slash command suggestions — above the prompt box */}
      {showSlashHints && (
        <Box flexDirection="column" marginBottom={0}>
          {slashCommands!.map((c, i) => {
            const isSelected = i === slashSelectedIdx;
            return (
              <Text key={c.cmd} color={isSelected ? COLORS.sky : COLORS.dim} bold={isSelected}>
                {"  "}{isSelected ? "❯" : " "} {c.cmd.padEnd(14)} {c.desc}
              </Text>
            );
          })}
        </Box>
      )}

      {attachments.length > 0 && (
        <Box flexDirection="row" gap={1}>
          {attachments.map((a, i) => (
            <Text key={i} color={a.isImage ? COLORS.ice : COLORS.sky}>
              {a.isImage ? "[img]" : "[file]"} {a.name}
            </Text>
          ))}
        </Box>
      )}

      <Box flexDirection="row" borderStyle="single" borderColor={COLORS.azure} paddingX={1}>
        <Text color={COLORS.azure} bold>{">"}</Text>
        <CustomTextInput
          value={value}
          placeholder={value.startsWith("/") ? "type a command..." : "Ask anything, or type / for commands"}
        />
      </Box>

      <Box justifyContent="space-between">
        <Text color={COLORS.dim}>
          {isStreaming ? "queue mode" : value.startsWith("/") ? "command mode" : "chat mode"}
        </Text>
        <Text color={COLORS.dim}>
          Enter to send · Esc Interrupt · Ctrl+D Exit · ↑↓ Navigate · → Select
        </Text>
      </Box>
    </Box>
  );
}
