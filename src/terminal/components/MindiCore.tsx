import React from "react";
import { Text } from "ink";
import type { RuntimeStage } from "../types.js";
import { COLORS } from "../colors.js";

export type MindiCoreState = "waiting" | "thinking" | "planning" | "tool" | "vision" | "writing" | "generating" | "error" | "success";
export type MindiRenderMode = "kitty" | "iterm" | "sixel" | "braille" | "block" | "ascii";

const FRAMES: Record<MindiCoreState, readonly string[]> = {
  waiting: ["·◇·", "·◈·", "·◇·", " ◇ "],
  thinking: ["⟡◇⟡", "⟡◈⟡", "·◆·", "⟡◈⟡"],
  planning: ["⌄◇⌄", "⌄◈⌄", "⌄◆⌄", "·◈·"],
  tool: ["○◇○", "◌◈◌", "◉◆◉", "◌◈◌"],
  vision: ["‹◇›", "‹◈›", "«◆»", "‹◈›"],
  writing: ["˙◇˙", "·◈·", "˙◆˙", "·◈·"],
  generating: ["‹◈›", "⟨◆⟩", "‹◈›", "·◆·"],
  error: ["·◇·", " ◇ ", "·◈·", " ◇ "],
  success: ["·◈·", "○◆○", "·◈·", " ◇ "],
};

const ASCII_FRAMES: Record<MindiCoreState, readonly string[]> = {
  waiting: ["<o>", "<O>"], thinking: ["<o>", "<O>", "[O]"], planning: ["vov", "vOv"],
  tool: ["(O)", "[O]"], vision: ["<O>", "[O]"], writing: [".O.", "^O^"],
  generating: ["<O>", "<#>"], error: ["<.>", "<o>"], success: ["(O)", "<O>"],
};

export function stateForStage(stage: RuntimeStage, detail = ""): MindiCoreState {
  const lower = detail.toLowerCase();
  if (lower.includes("vision") || lower.includes("image")) return "vision";
  if (lower.includes("write") || lower.includes("file")) return "writing";
  if (stage === "capability" || stage === "executing") return "tool";
  if (stage === "planning" || stage === "negotiating") return "planning";
  if (stage === "generating") return "generating";
  if (stage === "thinking" || stage === "context") return "thinking";
  return "waiting";
}

export function detectMindiRenderMode(env: NodeJS.ProcessEnv = process.env): MindiRenderMode {
  if (env.KITTY_WINDOW_ID) return "kitty";
  if (env.TERM_PROGRAM === "iTerm.app") return "iterm";
  if (/sixel/i.test(env.TERM_FEATURES ?? "")) return "sixel";
  if (env.LANG && /utf-?8/i.test(env.LANG)) return "braille";
  if (env.TERM && env.TERM !== "dumb") return "block";
  return "ascii";
}

export function MindiCore({ state, frame, mode = detectMindiRenderMode() }: { state: MindiCoreState; frame: number; mode?: MindiRenderMode }): React.ReactElement {
  // Inline graphics protocols cannot be safely emitted inside Ink's diffed
  // status row. Capable terminals still receive the high-fidelity Unicode
  // crystal; ASCII is reserved for terminals without Unicode support.
  const frames = mode === "ascii" ? ASCII_FRAMES[state] : FRAMES[state];
  const value = frames[frame % frames.length]!;
  const bright = state === "tool" || state === "generating" || state === "success";
  return <Text color={bright ? COLORS.white : state === "error" ? COLORS.dim : COLORS.azure} bold={bright}>{value}</Text>;
}
