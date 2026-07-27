/** Prompt input — pure display, no hooks. Terminal handles all input.
 *  Width-safe: hint text truncates on narrow terminals so the box never
 *  wraps (wrapping breaks Ink's line accounting → duplicated output). */

import React from "react";
import { Box, Text, useWindowSize } from "ink";
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
  mode: "plan" | "build";
}

export function PromptInput({
  value,
  isStreaming,
  attachments,
  slashCommands,
  slashSelectedIdx = -1,
  mode,
}: PromptInputProps): React.ReactElement {
  const showSlashHints = slashCommands && slashCommands.length > 0;
  const { columns } = useWindowSize();

  // Full hint on wide terminals, compact on narrow.
  const hints = columns >= 90
    ? "Enter to send · Esc Interrupt · Ctrl+D Exit · ↑↓ Navigate · → Select"
    : columns >= 60
      ? "Enter send · Esc interrupt · ↑↓ navigate"
      : "Enter send";
  const inputMode = isStreaming ? "queue" : value.startsWith("/") ? "command" : mode;
  const showMode = columns >= 40;

  return (
    <Box flexDirection="column">
      {/* Slash command suggestions — above the prompt box */}
      {showSlashHints && (
        <Box flexDirection="column" marginBottom={0}>
          {slashCommands!.map((c, i) => {
            const isSelected = i === slashSelectedIdx;
            return (
              <Text key={c.cmd} color={isSelected ? COLORS.sky : COLORS.dim} bold={isSelected} wrap="truncate">
                {"  "}{isSelected ? "❯" : " "} {c.cmd.padEnd(14)} {c.desc}
              </Text>
            );
          })}
        </Box>
      )}

      {attachments.length > 0 && (
        <Box flexDirection="row" gap={1}>
          {attachments.map((a, i) => (
            <Text key={i} color={a.isImage ? COLORS.ice : COLORS.sky} wrap="truncate">
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
        {showMode ? <Text color={mode === "build" ? COLORS.sky : COLORS.dim}>{inputMode} mode · Shift+Tab to switch</Text> : <Text> </Text>}
        <Text color={COLORS.dim} wrap="truncate">{hints}</Text>
      </Box>
    </Box>
  );
}
