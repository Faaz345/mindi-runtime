import type { ProvidersConfig, ProviderEntry } from "../providers/provider-config.js";
import { providersFromEnv } from "../providers/provider-config.js";

/**
 * Runtime configuration. All fields optional — sensible defaults exist.
 * Config can be loaded from env, file, or supplied programmatically.
 */
export interface RuntimeConfig {
  /** Default provider id for the primary reasoning engine (if request omits it) */
  defaultProviderId?: string;
  /** Default model id for the primary reasoning engine */
  defaultModel?: string;
  /** Logging threshold */
  logLevel?: "trace" | "debug" | "info" | "warn" | "error";
  /** Hard timeout for the whole request lifecycle (ms) */
  requestTimeoutMs?: number;
  /** Default timeout for tool execution (ms) */
  toolTimeoutMs?: number;
  /** Max conversation messages retained in memory per session */
  maxHistoryMessages?: number;
  /** Providers config — generic map of provider id → entry */
  providers?: ProvidersConfig;
  /** Sandbox policy applied to all tools */
  sandbox?: SandboxConfig;
}

export type { ProvidersConfig, ProviderEntry };

export interface SandboxConfig {
  allowedRoots?: string[];
  allowedCommands?: string[];
  allowNetwork?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ResolvedConfig {
  defaultProviderId: string;
  defaultModel: string;
  logLevel: "trace" | "debug" | "info" | "warn" | "error";
  requestTimeoutMs: number;
  toolTimeoutMs: number;
  maxHistoryMessages: number;
  providers: ProvidersConfig;
  sandbox: Required<SandboxConfig>;
}

const DEFAULTS = {
  defaultProviderId: "openai",
  defaultModel: "gpt-4o-mini",
  logLevel: "info" as const,
  requestTimeoutMs: 300_000, // 5 minutes — allows long code generation
  toolTimeoutMs: 30_000,
  maxHistoryMessages: 50,
  sandbox: {
    allowedRoots: [] as string[],
    allowedCommands: [] as string[],
    allowNetwork: false,
    timeoutMs: 30_000,
    maxOutputBytes: 1_048_576, // 1 MiB
  },
};

/** Merge user config over defaults. */
export function resolveConfig(user?: RuntimeConfig): ResolvedConfig {
  if (!user) {
    return {
      ...DEFAULTS,
      providers: {},
      sandbox: { ...DEFAULTS.sandbox },
    };
  }
  return {
    defaultProviderId: user.defaultProviderId ?? DEFAULTS.defaultProviderId,
    defaultModel: user.defaultModel ?? DEFAULTS.defaultModel,
    logLevel: user.logLevel ?? DEFAULTS.logLevel,
    requestTimeoutMs: user.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    toolTimeoutMs: user.toolTimeoutMs ?? DEFAULTS.toolTimeoutMs,
    maxHistoryMessages: user.maxHistoryMessages ?? DEFAULTS.maxHistoryMessages,
    providers: user.providers ?? {},
    sandbox: {
      allowedRoots: user.sandbox?.allowedRoots ?? DEFAULTS.sandbox.allowedRoots,
      allowedCommands: user.sandbox?.allowedCommands ?? DEFAULTS.sandbox.allowedCommands,
      allowNetwork: user.sandbox?.allowNetwork ?? DEFAULTS.sandbox.allowNetwork,
      timeoutMs: user.sandbox?.timeoutMs ?? DEFAULTS.sandbox.timeoutMs,
      maxOutputBytes: user.sandbox?.maxOutputBytes ?? DEFAULTS.sandbox.maxOutputBytes,
    },
  };
}

/** Load config from process.env, layered under user config. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const cfg: RuntimeConfig = {};
  if (env.MINDI_DEFAULT_PROVIDER) cfg.defaultProviderId = env.MINDI_DEFAULT_PROVIDER;
  if (env.MINDI_DEFAULT_MODEL) cfg.defaultModel = env.MINDI_DEFAULT_MODEL;
  if (env.MINDI_LOG_LEVEL) {
    const lvl = env.MINDI_LOG_LEVEL as RuntimeConfig["logLevel"];
    if (lvl) cfg.logLevel = lvl;
  }
  if (env.MINDI_REQUEST_TIMEOUT_MS) cfg.requestTimeoutMs = Number(env.MINDI_REQUEST_TIMEOUT_MS);
  if (env.MINDI_TOOL_TIMEOUT_MS) cfg.toolTimeoutMs = Number(env.MINDI_TOOL_TIMEOUT_MS);
  if (env.MINDI_MAX_HISTORY_MESSAGES) cfg.maxHistoryMessages = Number(env.MINDI_MAX_HISTORY_MESSAGES);

  // Use the generic provider env loader.
  cfg.providers = providersFromEnv(env);

  return cfg;
}
