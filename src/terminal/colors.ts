/**
 * Blue-only color palette for MINDIGENOUS terminal.
 *
 * Uses Ink's 256-color + hex support for blue gradients.
 * White stays white. Everything else is a shade of blue.
 *
 * Hierarchy (darkest → lightest):
 *   navy    — borders, dividers, very dim metadata
 *   blue    — secondary text, dim labels
 *   azure   — primary accent, model names, headings
 *   sky     — highlights, active states, user text
 *   ice     — bright accents, code keywords
 *   white   — regular text, pure white
 */

// Ink color values (hex for true-color terminals).
export const BLUE = {
  navy: "#0a1628",      // Darkest — borders, dividers
  deep: "#1e3a5f",      // Deep blue — dim labels, metadata
  blue: "#2563eb",      // Standard blue — secondary text
  azure: "#3b82f6",     // Azure — primary accent (model names, headings)
  sky: "#60a5fa",       // Sky blue — highlights, active states, user text
  ice: "#93c5fd",       // Ice blue — bright accents, code keywords
  frost: "#bfdbfe",     // Frost — very light accents
  white: "#ffffff",     // Pure white — regular text
} as const;

// Semantic mapping (so components don't hardcode hex).
// Includes raw blue names for direct access.
export const COLORS = {
  // Raw blue shades (for direct access)
  navy: BLUE.navy,
  deep: BLUE.deep,
  blue: BLUE.blue,
  azure: BLUE.azure,
  sky: BLUE.sky,
  ice: BLUE.ice,
  frost: BLUE.frost,
  white: BLUE.white,

  // Semantic aliases
  text: BLUE.white,
  dim: BLUE.deep,
  muted: BLUE.blue,

  // Roles
  user: BLUE.sky,
  assistant: BLUE.azure,
  system: BLUE.deep,

  // UI elements
  header: BLUE.azure,
  accent: BLUE.azure,
  border: BLUE.navy,
  highlight: BLUE.sky,
  active: BLUE.sky,

  // Code syntax
  // VS Code Dark+ token colors.
  codeKeyword: "#c586c0",
  codeString: "#ce9178",
  codeComment: "#6a9955",
  codeNumber: "#b5cea8",
  codeType: "#4ec9b0",
  codeFunction: "#dcdcaa",
  codeDefault: "#d4d4d4",
  codeLang: "#569cd6",
  codeLineNumber: "#858585",

  // Status
  thinking: BLUE.azure,
  generating: BLUE.sky,
  planning: BLUE.blue,
  executing: BLUE.blue,
  capability: BLUE.ice,
  context: BLUE.azure,
  negotiating: BLUE.ice,

  // Timer
  timer: BLUE.deep,

  // Links
  link: BLUE.sky,

  // User prompt echo — light background band (Claude Code style)
  promptBg: "#dbe4f0",      // Light bluish-white band behind the user's prompt
  promptText: "#0a1628",    // Deep navy text on the light band
} as const;
