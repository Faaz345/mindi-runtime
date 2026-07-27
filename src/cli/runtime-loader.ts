/**
 * Runtime loader — shared by all CLI commands.
 *
 * Loads config from:
 *   1. .mindi/config.json (if present, written by `mindi setup`)
 *   2. .env file (if present)
 *   3. process.env
 *   4. User-provided overrides
 *
 * Then boots a Runtime instance and returns it.
 */

import fs from "node:fs";
import path from "node:path";
import {
  Runtime,
  configFromEnv,
  type RuntimeConfig,
} from "../index.js";
import {
  loadConfig,
  toRuntimeConfig,
  configExists,
} from "./onboarding-config.js";

/** Load .env file into process.env (if present). */
export function loadEnvFile(dir: string = process.cwd()): void {
  const envPath = path.join(dir, ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

/** Load .mindi/config.json if it exists. */
function loadOnboardingConfig(dir: string = process.cwd()): RuntimeConfig | null {
  if (!configExists(dir)) return null;
  const onboardConfig = loadConfig(dir);
  if (!onboardConfig) return null;
  return toRuntimeConfig(onboardConfig);
}

/** Boot a Runtime from all config sources. */
export function bootRuntime(overrides?: Partial<RuntimeConfig>): Runtime {
  loadEnvFile();

  // Layer 1: env vars (lowest priority)
  const envConfig = configFromEnv(process.env);

  // Layer 2: onboarding config (.mindi/config.json)
  const onboardConfig = loadOnboardingConfig() ?? {};

  // Layer 3: user overrides (highest priority)
  const config: RuntimeConfig = { ...envConfig, ...onboardConfig, ...overrides };

  // Enable the persistent workspace session system for the terminal.
  // This gives Claude Code / Cursor-style auto-restore of sessions, provider,
  // model, history, and project memory across launches.
  config.workspace = {
    enabled: true,
    rootDir: process.cwd(),
    autoRestore: true,
    autoSave: true,
    maxHistoryMessages: overrides?.workspace?.maxHistoryMessages ?? 50,
    ...overrides?.workspace,
  };

  // Trust is granted once per workspace by the terminal. Ensure that trusted
  // root is always writable even when an older config saved an empty roots
  // array; other configured roots remain available for explicit reads.
  const workspaceRoot = config.workspace.rootDir ?? process.cwd();
  config.sandbox = {
    ...config.sandbox,
    allowedRoots: Array.from(new Set([workspaceRoot, ...(config.sandbox?.allowedRoots ?? [])])),
  };

  if (!overrides?.logLevel && process.env.MINDI_CLI_VERBOSE !== "1") {
    config.logLevel = "error";
  }

  return new Runtime(config);
}

/** Check if a .env file exists. */
export function hasEnvFile(dir: string = process.cwd()): boolean {
  return fs.existsSync(path.join(dir, ".env"));
}

/** Check if onboarding has been completed. */
export function isOnboarded(dir: string = process.cwd()): boolean {
  const config = loadConfig(dir);
  return config?.onboarded ?? false;
}

/** Check if onboarding config exists. */
export function hasOnboardingConfig(dir: string = process.cwd()): boolean {
  return configExists(dir);
}
