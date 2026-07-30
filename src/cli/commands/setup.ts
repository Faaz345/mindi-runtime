/** `mindi-cli setup` — first-run onboarding wizard. */

import fs from "node:fs";
import path from "node:path";
import {
  type OnboardingConfig,
  createEmptyConfig,
  loadConfig,
  saveConfig,
} from "../onboarding-config.js";
import {
  validateOpenAIKey,
  validateGeminiKey,
  filterChatModels,
  type ValidationResult,
} from "../validator.js";
import {
  promptText,
  promptPassword,
  promptSelect,
  promptConfirm,
  banner,
  step,
  setNonInteractive,
} from "../prompt.js";
import {
  colors,
  icons,
  info,
  success,
  warn,
  error,
} from "../format.js";
import type { CapabilityType, ProviderModel, IProvider } from "../../index.js";
import { CapabilityTypes as Caps, OpenAIProvider, GeminiProvider } from "../../index.js";

interface CapabilityMeta {
  type: CapabilityType;
  label: string;
  nature: "deterministic" | "generative" | "either";
  hasFreeTool: boolean;
  toolName?: string;
}

const CAPABILITY_META: CapabilityMeta[] = [
  { type: Caps.Vision, label: "Vision (image understanding)", nature: "generative", hasFreeTool: false },
  { type: Caps.OCR, label: "OCR (text extraction)", nature: "either", hasFreeTool: false },
  { type: Caps.WebSearch, label: "Web Search", nature: "either", hasFreeTool: false },
  { type: Caps.Browser, label: "Browser Automation", nature: "either", hasFreeTool: false },
  { type: Caps.Filesystem, label: "Filesystem", nature: "deterministic", hasFreeTool: true, toolName: "tool.filesystem" },
  { type: Caps.Git, label: "Git", nature: "deterministic", hasFreeTool: true, toolName: "tool.terminal (git)" },
  { type: Caps.Terminal, label: "Terminal", nature: "deterministic", hasFreeTool: true, toolName: "tool.terminal" },
  { type: Caps.ImageGeneration, label: "Image Generation", nature: "generative", hasFreeTool: false },
  { type: Caps.Audio, label: "Audio Processing", nature: "either", hasFreeTool: false },
  { type: Caps.Embeddings, label: "Embeddings", nature: "either", hasFreeTool: false },
  { type: Caps.Database, label: "Database", nature: "deterministic", hasFreeTool: true, toolName: "future tool" },
];

export interface SetupOptions {
  nonInteractive?: boolean;
  provider?: string;
  model?: string;
  openaiKey?: string;
  geminiKey?: string;
  baseUrl?: string;
}

export async function setupCommand(opts: SetupOptions): Promise<void> {
  setNonInteractive(opts.nonInteractive ?? false);
  banner("MINDI Runtime — First-Run Setup");

  const totalSteps = opts.nonInteractive ? 4 : 7;
  let stepNum = 0;

  // ---- Step 1: Detect existing configuration ----
  stepNum++;
  step(stepNum, totalSteps, "Detecting existing configuration");
  const existingConfig = loadConfig();
  if (existingConfig?.onboarded) {
    success("Found existing configuration.");
    info(`Primary model: ${colors.cyan(existingConfig.primaryProvider)}/${existingConfig.primaryModel}`);
    if (!opts.nonInteractive) {
      const reconfigure = await promptConfirm("Reconfigure?", false);
      if (!reconfigure) {
        info("Setup cancelled. Existing configuration retained.");
        return;
      }
    }
  } else {
    info("No existing configuration found. Starting fresh.");
  }

  const envOpenAIKey = process.env.OPENAI_API_KEY ?? "";
  const envGeminiKey = process.env.GEMINI_API_KEY ?? "";
  if (envOpenAIKey) info(`Detected OPENAI_API_KEY in environment (${envOpenAIKey.slice(0, 8)}...)`);
  if (envGeminiKey) info(`Detected GEMINI_API_KEY in environment (${envGeminiKey.slice(0, 8)}...)`);

  // ---- Step 2: Collect API keys ----
  stepNum++;
  step(stepNum, totalSteps, "Configuring providers");
  const config = existingConfig ?? createEmptyConfig();

  let openaiKey = opts.openaiKey || envOpenAIKey;
  let baseUrl = opts.baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

  if (!opts.nonInteractive) {
    if (!openaiKey) {
      const wantOpenAI = await promptConfirm("Configure an OpenAI-compatible provider?", true);
      if (wantOpenAI) {
        openaiKey = await promptPassword("Enter your OpenAI API key", {
          validate: (v) => v.length < 10 ? "Key seems too short" : null,
        });
        if (openaiKey) {
          const customBaseUrl = await promptText("Base URL (Enter for default)", { default: baseUrl });
          baseUrl = customBaseUrl || baseUrl;
        }
      }
    } else {
      info("Using OPENAI_API_KEY from environment.");
    }
  }

  let geminiKey = opts.geminiKey || envGeminiKey;
  if (!opts.nonInteractive) {
    if (!geminiKey) {
      const wantGemini = await promptConfirm("Configure Google Gemini?", false);
      if (wantGemini) {
        geminiKey = await promptPassword("Enter your Gemini API key", {
          validate: (v) => v.length < 10 ? "Key seems too short" : null,
        });
      }
    } else {
      info("Using GEMINI_API_KEY from environment.");
    }
  }

  if (!openaiKey && !geminiKey) {
    warn("No API keys provided. Runtime will start with tools only.");
    config.onboarded = true;
    config.primaryProvider = "none";
    config.primaryModel = "none";
    saveConfig(config);
    success("Configuration saved (tools-only mode).");
    return;
  }

  // ---- Step 3: Validate keys + discover models ----
  stepNum++;
  step(stepNum, totalSteps, "Validating API keys + discovering models");
  const validationResults: ValidationResult[] = [];

  if (openaiKey) {
    process.stdout.write(`  ${icons.info} Validating OpenAI key... `);
    const result = await validateOpenAIKey(openaiKey, baseUrl);
    if (result.valid) {
      process.stdout.write(`${icons.ok} ${colors.green("valid")} (${result.models?.length ?? 0} models)\n`);
      config.providers.openai = { type: "openai-compatible", apiKey: openaiKey, baseUrl, orgId: "" };
    } else {
      process.stdout.write(`${icons.fail} ${colors.red("invalid")}\n`);
      error(`OpenAI: ${result.error}`);
    }
    validationResults.push(result);
  }

  if (geminiKey) {
    process.stdout.write(`  ${icons.info} Validating Gemini key... `);
    const result = await validateGeminiKey(geminiKey);
    if (result.valid) {
      process.stdout.write(`${icons.ok} ${colors.green("valid")} (${result.models?.length ?? 0} models)\n`);
      config.providers.gemini = { type: "gemini", apiKey: geminiKey };
    } else {
      process.stdout.write(`${icons.fail} ${colors.red("invalid")}\n`);
      error(`Gemini: ${result.error}`);
    }
    validationResults.push(result);
  }

  const validResults = validationResults.filter((r) => r.valid);
  if (validResults.length === 0) {
    error("No valid API keys. Cannot proceed with model selection.");
    warn("Check your API keys and try again with `mindi-cli setup`.");
    return;
  }

  // ---- Step 4: Select primary model ----
  stepNum++;
  step(stepNum, totalSteps, "Selecting primary reasoning model");

  const allModels: Array<ProviderModel & { providerId: string }> = [];
  for (const result of validResults) {
    const chatModels = filterChatModels(result.models ?? []);
    for (const m of chatModels) {
      allModels.push({ ...m, providerId: result.provider });
    }
  }

  if (opts.nonInteractive) {
    const provider = opts.provider || validResults[0]!.provider;
    const model = opts.model || allModels.find((m) => m.providerId === provider)?.id || allModels[0]!.id;
    config.primaryProvider = provider;
    config.primaryModel = model;
    info(`Non-interactive: using ${provider}/${model}`);
  } else {
    info(`Available models (${allModels.length}):`);
    const choices = allModels.slice(0, 20).map((m) => ({
      label: `${m.providerId}/${m.id}`,
      value: `${m.providerId}:${m.id}`,
      description: m.capabilities.length > 0 ? `[${m.capabilities.join(",")}]` : "",
    }));
    const selected = await promptSelect("Select your primary reasoning model", choices, {
      default: choices[0]?.value,
    });
    const [provider, model] = selected.split(":");
    config.primaryProvider = provider!;
    config.primaryModel = model!;
    success(`Primary model: ${colors.cyan(provider!)}/${model!}`);
  }

  // ---- Step 5: Detect model capabilities ----
  stepNum++;
  if (!opts.nonInteractive) {
    step(stepNum, totalSteps, "Detecting model capabilities");
  }

  let modelCaps: Set<CapabilityType> = new Set([Caps.Chat]);
  try {
    const provider = createProviderForConfig(config);
    if (provider) {
      const decl = await provider.declareCapability(config.primaryModel);
      modelCaps = new Set(decl.capabilities);
      if (!opts.nonInteractive) {
        info(`Model capabilities: [${Array.from(modelCaps).join(", ")}]`);
        info(`Streaming: ${decl.streaming ? colors.green("yes") : colors.red("no")}`);
        info(`Tool calling: ${decl.toolCalling ? colors.green("yes") : colors.red("no")}`);
        info(`Multimodal: ${decl.multimodal ? colors.green("yes") : colors.red("no")}`);
        info(`Max context: ${decl.maxContext.toLocaleString()} tokens`);
      }
    }
  } catch (err) {
    warn(`Could not fetch capability declaration: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ---- Step 6: Configure capability augmentation ----
  stepNum++;
  if (!opts.nonInteractive) {
    step(stepNum, totalSteps, "Configuring capability augmentation");
  }

  const missingCaps = CAPABILITY_META.filter((c) => !modelCaps.has(c.type));
  if (missingCaps.length === 0) {
    success("Your model has all capabilities. No augmentation needed.");
  } else if (!opts.nonInteractive) {
    info(`Your model is missing ${missingCaps.length} capabilities.`);
    info("Configure which executor to use for each missing capability:");
    process.stdout.write("\n");

    config.preferDeterministicTools = await promptConfirm(
      "Prefer free deterministic tools over paid API calls when available?",
      true,
    );

    for (const cap of missingCaps) {
      const choices: Array<{ label: string; value: string; description?: string }> = [];

      if (cap.hasFreeTool && config.preferDeterministicTools) {
        choices.push({
          label: `${cap.toolName} (free, deterministic)`,
          value: cap.toolName!,
          description: "Recommended",
        });
      }

      for (const result of validResults) {
        if (result.provider !== config.primaryProvider) {
          const providerCaps = getProviderCapabilities(result.provider, validResults);
          if (providerCaps.has(cap.type)) {
            choices.push({
              label: `${result.provider} (${cap.label})`,
              value: result.provider,
            });
          }
        }
      }

      choices.push({ label: "Skip (not available)", value: "skip" });

      if (choices.length > 1) {
        const selected = await promptSelect(
          `Executor for ${cap.label}`,
          choices,
          { default: choices[0]!.value },
        );
        if (selected !== "skip") {
          config.capabilityProviders[cap.type] = selected;
        }
      }
    }
  } else {
    // Non-interactive: auto-assign free tools for deterministic caps
    for (const cap of missingCaps) {
      if (cap.hasFreeTool) {
        config.capabilityProviders[cap.type] = cap.toolName!;
      }
    }
  }

  // ---- Step 7: Configure sandbox ----
  stepNum++;
  if (!opts.nonInteractive) {
    step(stepNum, totalSteps, "Configuring sandbox");
    const allowCwd = await promptConfirm(`Allow tools to access the current directory (${process.cwd()})?`, true);
    if (allowCwd) {
      config.sandbox.allowedRoots = [process.cwd()];
    }
    const allowGit = await promptConfirm("Allow git commands?", true);
    if (allowGit) {
      config.sandbox.allowedCommands = ["git", "node", "npm", "npx"];
    }
  } else {
    config.sandbox.allowedRoots = [process.cwd()];
    config.sandbox.allowedCommands = ["git", "node", "npm", "npx"];
  }

  // ---- Persist ----
  config.onboarded = true;
  saveConfig(config);

  // Also write .env file for backward compat
  writeEnvFile(config);

  success("\nConfiguration saved!");
  info(`  Config: ${colors.cyan(".mindi/config.json")}`);
  info(`  Env:    ${colors.cyan(".env")}`);
  info(`\n  Primary model: ${colors.cyan(config.primaryProvider)}/${config.primaryModel}`);

  if (Object.keys(config.capabilityProviders).length > 0) {
    info("\n  Augmentation configured:");
    for (const [cap, executor] of Object.entries(config.capabilityProviders)) {
      process.stdout.write(`    ${icons.bullet} ${cap} → ${colors.cyan(executor!)}\n`);
    }
  }

  process.stdout.write(`\n  ${colors.bold("Next steps:")}\n`);
  process.stdout.write(`    ${colors.dim("1.")} Run ${colors.cyan("mindi-cli doctor")} to verify\n`);
  process.stdout.write(`    ${colors.dim("2.")} Run ${colors.cyan("mindi-cli run")} to execute a request\n\n`);
}

// --- Helpers ---

function createProviderForConfig(config: OnboardingConfig): IProvider | null {
  if (config.primaryProvider === "openai" && config.providers.openai) {
    return new OpenAIProvider({
      apiKey: config.providers.openai.apiKey ?? "",
      baseUrl: config.providers.openai.baseUrl,
    });
  }
  if (config.primaryProvider === "gemini" && config.providers.gemini) {
    return new GeminiProvider({
      apiKey: config.providers.gemini.apiKey ?? "",
    });
  }
  return null;
}

function getProviderCapabilities(provider: string, results: ValidationResult[]): Set<CapabilityType> {
  const result = results.find((r) => r.provider === provider);
  if (!result?.models) return new Set();
  const caps = new Set<CapabilityType>();
  for (const m of result.models) {
    for (const c of m.capabilities) caps.add(c);
  }
  return caps;
}

function writeEnvFile(config: OnboardingConfig): void {
  const lines: string[] = [
    "# MINDI Runtime configuration (generated by `mindi-cli setup`)",
    `MINDI_DEFAULT_PROVIDER=${config.primaryProvider}`,
    `MINDI_DEFAULT_MODEL=${config.primaryModel}`,
  ];
  if (config.providers.openai) {
    lines.push(`OPENAI_API_KEY=${config.providers.openai.apiKey}`);
    lines.push(`OPENAI_BASE_URL=${config.providers.openai.baseUrl ?? "https://api.openai.com/v1"}`);
  }
  if (config.providers.gemini) {
    lines.push(`GEMINI_API_KEY=${config.providers.gemini.apiKey}`);
  }
  lines.push(`MINDI_LOG_LEVEL=info`);
  fs.writeFileSync(path.join(process.cwd(), ".env"), lines.join("\n") + "\n", "utf8");
}
