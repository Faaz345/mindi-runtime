/**
 * Onboarding configuration schema.
 *
 * Persisted to `.mindi/config.json`. Uses the generic ProvidersConfig
 * (Record<string, ProviderEntry>) so any provider can be stored.
 */

import type { CapabilityType } from "../core/types.js";
import type { RuntimeConfig } from "../core/config.js";
import type { ProviderEntry } from "../providers/provider-config.js";
import fs from "node:fs";

export interface OnboardingConfig {
  version: 1;
  createdAt: number;
  updatedAt: number;

  primaryProvider: string;
  primaryModel: string;

  /** Generic provider map — any provider can be stored here. */
  providers: Record<string, ProviderEntry>;

  capabilityProviders: Partial<Record<CapabilityType, string>>;
  preferDeterministicTools: boolean;

  sandbox: {
    allowedRoots: string[];
    allowedCommands: string[];
    allowNetwork: boolean;
  };

  onboarded: boolean;
}

export function createEmptyConfig(): OnboardingConfig {
  return {
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    primaryProvider: "",
    primaryModel: "",
    providers: {},
    capabilityProviders: {},
    preferDeterministicTools: true,
    sandbox: {
      allowedRoots: [],
      allowedCommands: [],
      allowNetwork: false,
    },
    onboarded: false,
  };
}

export const CONFIG_DIR = ".mindi";
export const CONFIG_FILE = "config.json";

export function configFilePath(dir: string = process.cwd()): string {
  return `${dir}/${CONFIG_DIR}/${CONFIG_FILE}`;
}

export function configExists(dir: string = process.cwd()): boolean {
  return fs.existsSync(configFilePath(dir));
}

export function loadConfig(dir: string = process.cwd()): OnboardingConfig | null {
  try {
    const p = configFilePath(dir);
    if (!fs.existsSync(p)) return null;
    const content = fs.readFileSync(p, "utf8");
    return JSON.parse(content) as OnboardingConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: OnboardingConfig, dir: string = process.cwd()): void {
  const configDir = `${dir}/${CONFIG_DIR}`;
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  config.updatedAt = Date.now();
  fs.writeFileSync(configFilePath(dir), JSON.stringify(config, null, 2), "utf8");
}

export function toRuntimeConfig(config: OnboardingConfig): RuntimeConfig {
  return {
    defaultProviderId: config.primaryProvider,
    defaultModel: config.primaryModel,
    providers: config.providers,
    sandbox: {
      allowedRoots: config.sandbox.allowedRoots,
      allowedCommands: config.sandbox.allowedCommands,
      allowNetwork: config.sandbox.allowNetwork,
      timeoutMs: 30_000,
      maxOutputBytes: 1_048_576,
    },
  };
}
