/** Command palette — pure display, no useInput. Terminal handles keys. */

import React, { useState } from "react";
import { Box, Text } from "ink";
import { COLORS } from "../colors.js";

const COMMANDS = [
  { label: "Help", value: "/help", desc: "Show available commands" },
  { label: "Providers", value: "/providers", desc: "List registered providers" },
  { label: "Models", value: "/models", desc: "List available models" },
  { label: "Graph", value: "/graph", desc: "Show execution graph" },
  { label: "Logs", value: "/logs", desc: "Show live runtime logs" },
  { label: "Doctor", value: "/doctor", desc: "Health-check all providers" },
  { label: "Config", value: "/config", desc: "Show resolved config" },
  { label: "Sessions", value: "/sessions", desc: "List active sessions" },
  { label: "Clear", value: "/clear", desc: "Clear conversation" },
  { label: "New", value: "/new", desc: "Start a new session" },
  { label: "Exit", value: "/exit", desc: "Quit the application" },
];

interface CommandPaletteProps {
  onCommand: (cmd: string) => boolean;
  onClose: () => void;
}

export function CommandPalette({ onCommand: _onCommand, onClose: _onClose }: CommandPaletteProps): React.ReactElement {
  const [query, _setQuery] = useState("");
  const [selected, _setSelected] = useState(0);

  const filtered = COMMANDS.filter((c) =>
    c.label.toLowerCase().includes(query.toLowerCase()) ||
    c.value.toLowerCase().includes(query.toLowerCase())
  );

  // No useInput — Terminal handles all keyboard.
  // This is a display-only component.

  return (
    <Box flexDirection="column" borderStyle="double" borderColor={COLORS.azure} paddingX={1}>
      <Text bold color={COLORS.azure}>Command Palette</Text>
      <Text color={COLORS.dim}>{"›"} {query}{"▏"}</Text>
      <Box flexDirection="column">
        {filtered.slice(0, 8).map((cmd, i) => (
          <Text key={cmd.value} color={i === selected ? COLORS.sky : COLORS.white}>
            {i === selected ? "❯ " : "  "}{cmd.label} <Text color={COLORS.dim}>— {cmd.desc}</Text>
          </Text>
        ))}
        {filtered.length === 0 && <Text color={COLORS.dim}>No matches.</Text>}
      </Box>
    </Box>
  );
}

export { COMMANDS };
