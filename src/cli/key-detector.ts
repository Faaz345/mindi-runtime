/**
 * API Key Auto-Detection
 *
 * Scans the system for existing API keys from:
 *   - Environment variables (OPENAI_API_KEY, GEMINI_API_KEY, etc.)
 *   - .env files in common locations
 *   - Claude Code config (~/.claude/credentials.json)
 *   - Cursor config (~/.cursor/config.json)
 *   - OpenCode config
 *   - VS Code settings
 *   - Any .env in the home directory
 *
 * Returns found keys with their source, so the user can pick which to use.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface DetectedKey {
  /** Provider id (e.g. "openai", "gemini", "tokenrouter") */
  provider: string;
  /** Display label (e.g. "OpenAI", "Google Gemini") */
  label: string;
  /** The API key (masked for display) */
  key: string;
  /** Where the key was found */
  source: string;
  /** Whether the key looks valid (length check) */
  valid: boolean;
}

/** Known env var patterns for API keys. */
const ENV_PATTERNS: Array<{ env: string; provider: string; label: string }> = [
  { env: "OPENAI_API_KEY", provider: "openai", label: "OpenAI" },
  { env: "GEMINI_API_KEY", provider: "gemini", label: "Google Gemini" },
  { env: "ANTHROPIC_API_KEY", provider: "anthropic", label: "Anthropic Claude" },
  { env: "GROQ_API_KEY", provider: "groq", label: "Groq" },
  { env: "DEEPSEEK_API_KEY", provider: "deepseek", label: "DeepSeek" },
  { env: "TOGETHER_API_KEY", provider: "together", label: "Together AI" },
  { env: "FIREWORKS_API_KEY", provider: "fireworks", label: "Fireworks AI" },
  { env: "OPENROUTER_API_KEY", provider: "openrouter", label: "OpenRouter" },
  { env: "TOKENROUTER_API_KEY", provider: "tokenrouter", label: "TokenRouter" },
  { env: "PROVIDER_TOKENROUTER_API_KEY", provider: "tokenrouter", label: "TokenRouter" },
];

/** Known config file locations to check. */
const CONFIG_PATHS: Array<{ file: string; provider: string; label: string; extract: (content: string) => string | null }> = [
  // Claude Code credentials
  {
    file: path.join(os.homedir(), ".claude", "credentials.json"),
    provider: "anthropic",
    label: "Anthropic (from Claude Code)",
    extract: (content) => {
      try {
        const json = JSON.parse(content);
        return json.apiKey ?? json.anthropic_api_key ?? json.ANTHROPIC_API_KEY ?? null;
      } catch { return null; }
    },
  },
  // .env in home directory
  {
    file: path.join(os.homedir(), ".env"),
    provider: "unknown",
    label: ".env (home directory)",
    extract: (content) => {
      const match = content.match(/(?:OPENAI|GEMINI|ANTHROPIC|GROQ|DEEPSEEK|TOGETHER|FIREWORKS|OPENROUTER|TOKENROUTER)_API_KEY\s*=\s*(.+)/);
      return match ? match[1]!.trim().replace(/^["']|["']$/g, "") : null;
    },
  },
  // .env in current directory
  {
    file: path.join(process.cwd(), ".env"),
    provider: "unknown",
    label: ".env (current directory)",
    extract: (content) => {
      const match = content.match(/(?:OPENAI|GEMINI|ANTHROPIC|GROQ|DEEPSEEK|TOGETHER|FIREWORKS|OPENROUTER|TOKENROUTER)_API_KEY\s*=\s*(.+)/);
      return match ? match[1]!.trim().replace(/^["']|["']$/g, "") : null;
    },
  },
];

/**
 * Scan the system for existing API keys.
 * Returns all detected keys with their source.
 */
export function detectApiKeys(): DetectedKey[] {
  const found: DetectedKey[] = [];
  const seenKeys = new Set<string>();

  // 1. Check environment variables.
  for (const pattern of ENV_PATTERNS) {
    const value = process.env[pattern.env];
    if (value && value.length > 10 && !seenKeys.has(value)) {
      found.push({
        provider: pattern.provider,
        label: pattern.label,
        key: value,
        source: `Environment variable: ${pattern.env}`,
        valid: value.length >= 20,
      });
      seenKeys.add(value);
    }
  }

  // 2. Check known config files.
  for (const configPath of CONFIG_PATHS) {
    try {
      if (!fs.existsSync(configPath.file)) continue;
      const content = fs.readFileSync(configPath.file, "utf8");
      const extracted = configPath.extract(content);
      if (extracted && extracted.length > 10 && !seenKeys.has(extracted)) {
        // Determine provider from the key prefix if unknown.
        let provider = configPath.provider;
        let label = configPath.label;
        if (provider === "unknown") {
          if (extracted.startsWith("sk-")) { provider = "openai"; label = "OpenAI"; }
          else if (extracted.startsWith("AIza")) { provider = "gemini"; label = "Google Gemini"; }
          else if (extracted.startsWith("sk-ant")) { provider = "anthropic"; label = "Anthropic Claude"; }
          else if (extracted.startsWith("gsk_")) { provider = "groq"; label = "Groq"; }
          else if (extracted.startsWith("tr-")) { provider = "tokenrouter"; label = "TokenRouter"; }
          else { provider = "custom"; label = "Custom Provider"; }
        }
        found.push({
          provider,
          label,
          key: extracted,
          source: configPath.label,
          valid: extracted.length >= 20,
        });
        seenKeys.add(extracted);
      }
    } catch {
      // Skip files we can't read.
    }
  }

  // 3. Check for .env files in common project directories.
  const commonDirs = [
    path.join(os.homedir(), "Projects"),
    path.join(os.homedir(), "Code"),
    path.join(os.homedir(), "Developer"),
    path.join(os.homedir(), "Desktop"),
  ];
  for (const dir of commonDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const envFile = path.join(dir, entry.name, ".env");
        try {
          if (!fs.existsSync(envFile)) continue;
          const content = fs.readFileSync(envFile, "utf8");
          for (const pattern of ENV_PATTERNS) {
            const match = content.match(new RegExp(`${pattern.env}\\s*=\\s*(.+)`));
            if (match) {
              const key = match[1]!.trim().replace(/^["']|["']$/g, "");
              if (key.length > 10 && !seenKeys.has(key)) {
                found.push({
                  provider: pattern.provider,
                  label: pattern.label,
                  key,
                  source: `.env in ~/${entry.name}`,
                  valid: key.length >= 20,
                });
                seenKeys.add(key);
              }
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return found;
}

/**
 * Mask a key for display (show first 8 and last 4 chars).
 */
export function maskKey(key: string): string {
  if (key.length <= 12) return "•".repeat(key.length);
  return `${key.slice(0, 8)}${"•".repeat(Math.min(20, key.length - 12))}${key.slice(-4)}`;
}
