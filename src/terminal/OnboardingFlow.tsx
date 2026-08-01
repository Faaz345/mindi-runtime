/**
 * OnboardingFlow — premium interactive onboarding wizard.
 *
 * Flow: self-check → provider picker → API key → connection test →
 *       model discovery → capability detection → save → continue.
 *
 * Never tells the user to run another command.
 * Seamlessly transitions into the terminal after completion.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { resolveProviderEntry, type ProviderEntry } from "../providers/provider-config.js";
import { loadProvidersFromConfig } from "../providers/provider-loader.js";
import type { IProvider, ProviderModel } from "../core/types.js";
import { saveConfig, createEmptyConfig, type OnboardingConfig } from "../cli/onboarding-config.js";
import { detectApiKeys, maskKey, type DetectedKey } from "../cli/key-detector.js";
import { COLORS } from "./colors.js";

// ---------------------------------------------------------------------------
// Provider presets
// ---------------------------------------------------------------------------

interface ProviderPreset {
  id: string;
  label: string;
  description: string;
  type: "openai-compatible" | "gemini" | "custom";
  baseUrl?: string;
  authMethod?: "bearer" | "none";
  needsApiKey: boolean;
}

const PRESETS: ProviderPreset[] = [
  { id: "openai", label: "OpenAI", description: "GPT-4o, o1, o3, and more", type: "openai-compatible", baseUrl: "https://api.openai.com/v1", needsApiKey: true },
  { id: "anthropic", label: "Anthropic", description: "Claude 4, Claude 3.5 Sonnet", type: "openai-compatible", baseUrl: "https://api.anthropic.com/v1", needsApiKey: true },
  { id: "gemini", label: "Google Gemini", description: "Gemini 2.5 Pro/Flash", type: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", needsApiKey: true },
  { id: "deepseek", label: "DeepSeek", description: "DeepSeek-V3, DeepSeek-R1", type: "openai-compatible", baseUrl: "https://api.deepseek.com/v1", needsApiKey: true },
  { id: "groq", label: "Groq", description: "Ultra-fast inference (Llama, Mixtral)", type: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", needsApiKey: true },
  { id: "mistral", label: "Mistral AI", description: "Mistral Large, Codestral", type: "openai-compatible", baseUrl: "https://api.mistral.ai/v1", needsApiKey: true },
  { id: "ollama", label: "Ollama (local)", description: "Run models locally (no API key)", type: "openai-compatible", baseUrl: "http://localhost:11434/v1", authMethod: "none", needsApiKey: false },
  { id: "lmstudio", label: "LM Studio (local)", description: "Local model server (no API key)", type: "openai-compatible", baseUrl: "http://localhost:1234/v1", authMethod: "none", needsApiKey: false },
  { id: "custom", label: "Custom Provider", description: "Any OpenAI-compatible endpoint", type: "openai-compatible", needsApiKey: true },
];

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

type Phase =
  | "welcome"
  | "scanning"
  | "key-select"
  | "provider-select"
  | "custom-name"
  | "api-key"
  | "custom-url"
  | "connecting"
  | "model-select"
  | "capabilities"
  | "saving"
  | "done";

interface ProgressStep {
  label: string;
  status: "pending" | "active" | "done" | "failed";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OnboardingFlow({ onComplete, repair }: { onComplete: (config: OnboardingConfig) => void; repair?: boolean }): React.ReactElement {
  const { exit } = useApp();
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const [phase, setPhase] = useState<Phase>(repair ? "provider-select" : "welcome");
  const [selectedPreset, setSelectedPreset] = useState<ProviderPreset | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customDisplayName, setCustomDisplayName] = useState("");
  const [_provider, setProvider] = useState<IProvider | null>(null);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressStep[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [detectedKeys, setDetectedKeys] = useState<DetectedKey[]>([]);

  // ---- Welcome ----
  useInput((input, key) => {
    if (phase === "welcome") {
      if (key.return || input === " ") {
        // Start scanning for keys.
        setPhase("scanning");
      }
      if (key.ctrl && input === "c") exit();
      return;
    }

    // ---- Key selection ----
    if (phase === "key-select") {
      if (key.upArrow) { setCursor((c) => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setCursor((c) => Math.min(detectedKeys.length, c + 1)); return; }
      if (key.return) {
        if (cursor < detectedKeys.length) {
          // User selected a detected key — use it directly.
          const selected = detectedKeys[cursor]!;
          const preset: ProviderPreset = {
            id: selected.provider,
            label: selected.label,
            description: selected.source,
            type: selected.provider === "gemini" ? "gemini" : "openai-compatible",
            baseUrl: undefined,
            needsApiKey: false,
          };
          setSelectedPreset(preset);
          setApiKey(selected.key);
          // Go directly to connecting with the detected key.
          startConnection(preset, selected.key);
        } else {
          // "Skip — enter manually" selected.
          setPhase("provider-select");
          setCursor(0);
        }
        return;
      }
      if (key.ctrl && input === "c") exit();
      return;
    }

    // If connecting phase has an error, any key goes back to api-key.
    if (phase === "connecting" && error) {
      setPhase("api-key");
      setError(null);
      setApiKey("");
      return;
    }
  });

  // ---- Custom Display Name Input ----
  useInput((_input, key) => {
    if (phase !== "custom-name") return;
    if (key.return) {
      const name = customDisplayName.trim();
      if (name) {
        // Apply the user-defined name as the preset label.
        const preset = selectedPreset!;
        preset.label = name;
        setCustomUrl("");
        setPhase("custom-url");
      }
      return;
    }
    if (key.ctrl && _input === "c") exit();
  });

  // ---- Scanning for API keys ----
  useEffect(() => {
    if (phase !== "scanning") return;
    const timer = setTimeout(() => {
      const keys = detectApiKeys();
      setDetectedKeys(keys);
      if (keys.length > 0) {
        setPhase("key-select");
        setCursor(0);
      } else {
        // No keys found — go to manual provider selection.
        setPhase("provider-select");
        setCursor(0);
      }
    }, 800); // Brief scan animation.
    return () => clearTimeout(timer);
  }, [phase]);

  // ---- Provider Select ----
  useInput((input, key) => {
    if (phase !== "provider-select") return;

    if (key.upArrow) { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.downArrow) { setCursor((c) => Math.min(PRESETS.length - 1, c + 1)); return; }
    if (key.return) {
      const preset = PRESETS[cursor]!;
      setSelectedPreset(preset);
      // For custom provider, first ask for a display name.
      if (preset.id === "custom") {
        setCustomDisplayName("");
        setPhase("custom-name");
      } else if (preset.needsApiKey) {
        // For known providers, pre-fill the base URL but let user edit it.
        setCustomUrl(preset.baseUrl ?? "");
        setPhase("custom-url");
      } else {
        // No API key needed (Ollama, LM Studio) — go straight to connecting.
        startConnection(preset, "");
      }
      return;
    }
    if (key.ctrl && input === "c") exit();
  });

  // ---- API Key Input (handled by TextInput component + useInput for Enter/Ctrl+C) ----
  useInput((_input, key) => {
    if (phase !== "api-key") return;
    if (key.return) {
      if (apiKey.trim()) {
        startConnection(selectedPreset!, apiKey.trim());
      }
      return;
    }
    if (key.ctrl && _input === "c") exit();
  });

  // ---- Custom URL Input ----
  useInput((_input, key) => {
    if (phase !== "custom-url") return;
    if (key.return) {
      const url = customUrl.trim() || "https://";
      const preset = selectedPreset!;
      preset.baseUrl = url;
      if (preset.needsApiKey) {
        setPhase("api-key");
      } else {
        startConnection(preset, "");
      }
      return;
    }
    if (key.ctrl && _input === "c") exit();
  });

  // ---- Model Select (TextInput handles search, useInput handles navigation) ----
  useInput((_input, key) => {
    if (phase !== "model-select") return;

    const filtered = filterModels(models, searchQuery);

    if (key.upArrow) { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.downArrow) { setCursor((c) => Math.min(Math.max(0, filtered.length - 1), c + 1)); return; }
    if (key.return) {
      // If there are filtered models, select the highlighted one.
      if (filtered.length > 0 && filtered[cursor]) {
        setSelectedModel(filtered[cursor]!.id);
        setPhase("capabilities");
        return;
      }
      // If no models listed but user typed a name, use that.
      if (models.length === 0 && searchQuery.trim()) {
        setSelectedModel(searchQuery.trim());
        setPhase("capabilities");
        return;
      }
      return;
    }
    if (key.escape) {
      setSearchQuery("");
      setCursor(0);
      return;
    }
    if (key.ctrl && _input === "c") exit();
  });

  // ---- Connection Logic ----
  const startConnection = useCallback(async (preset: ProviderPreset, key: string) => {
    setPhase("connecting");
    setError(null);

    const displayName = preset.label;
    setProgress([
      { label: `Connecting to ${displayName}...`, status: "active" },
      { label: `Validating credentials...`, status: "pending" },
      { label: `Discovering available models...`, status: "pending" },
      { label: `Probing model capabilities...`, status: "pending" },
    ]);

    // Build provider entry — use customUrl if set (for custom providers).
    const baseUrl = customUrl.trim() || preset.baseUrl;
    const providerId = preset.id === "custom" ? `custom-${Date.now().toString(36)}` : preset.id;
    const entry: ProviderEntry = {
      type: preset.type,
      apiKey: key || undefined,
      baseUrl: baseUrl,
      authMethod: preset.authMethod ?? (key ? "bearer" : "none"),
      displayName: displayName,
      enabled: true,
    };
    const resolved = resolveProviderEntry(providerId, entry);

    // Instantiate provider.
    try {
      const providers = loadProvidersFromConfig({ [providerId]: resolved });
      if (providers.length === 0) {
        throw new Error(`Could not initialize ${displayName} provider`);
      }
      const p = providers[0]!;

      // Step 1: Connect + validate.
      setProgress((prev) => prev.map((s, i) => i === 0 ? { ...s, status: "done" } : i === 1 ? { ...s, status: "active" } : s));

      const health = await p.health();
      if (!health.ok) {
        const err = health.error ?? "Unknown error";
        if (err.includes("401") || err.includes("403") || err.includes("auth")) {
          setProgress((prev) => prev.map((s, i) => i === 1 ? { ...s, status: "failed" } : s));
          setError(`Authentication failed. Check your API key and try again.`);
        } else {
          setProgress((prev) => prev.map((s, i) => i === 0 ? { ...s, status: "failed" } : s));
          setError(`Could not connect to ${displayName}: ${err}`);
        }
        return;
      }

      // Step 2: Credentials validated.
      setProgress((prev) => prev.map((s, i) => i === 1 ? { ...s, status: "done" } : i === 2 ? { ...s, status: "active" } : s));

      // Step 3: Discover models.
      let modelList: ProviderModel[] = [];
      try {
        modelList = await p.listModels();
      } catch {
        // Provider might not support /models — that's OK for opaque providers.
      }

      setProgress((prev) => prev.map((s, i) => i === 2 ? { ...s, status: "done" } : i === 3 ? { ...s, status: "active" } : s));

      // Step 4: Capabilities detected.
      setProgress((prev) => prev.map((s, i) => i === 3 ? { ...s, status: "done" } : s));

      setProvider(p);
      setModels(modelList);

      if (modelList.length > 0) {
        setPhase("model-select");
        setCursor(0);
      } else {
        // No models listed — let user type a model name (opaque aggregator providers).
        setPhase("model-select");
      }
    } catch (err) {
      setProgress((prev) => prev.map((s) => s.status === "active" ? { ...s, status: "failed" } : s));
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // ---- Capabilities + Save ----
  // Use a ref guard so this effect only runs ONCE.
  const hasSavedRef = useRef(false);
  useEffect(() => {
    if (phase !== "capabilities" || !selectedPreset || !selectedModel) return;
    if (hasSavedRef.current) return;
    hasSavedRef.current = true;

    const run = async () => {
      const config = createEmptyConfig();

      // Provider id: use preset id for known providers, slug for custom.
      const providerId = selectedPreset.id === "custom"
        ? `custom-${selectedPreset.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`
        : selectedPreset.id;
      const displayName = selectedPreset.label;

      config.primaryProvider = providerId;
      config.primaryModel = selectedModel;

      const actualBaseUrl = customUrl.trim() || selectedPreset.baseUrl;
      const entry: ProviderEntry = {
        type: selectedPreset.type,
        apiKey: apiKey || undefined,
        baseUrl: actualBaseUrl,
        authMethod: selectedPreset.authMethod ?? (apiKey ? "bearer" : "none"),
        displayName: displayName,
        enabled: true,
      };
      config.providers[providerId] = resolveProviderEntry(providerId, entry);

      // Probe model capabilities (non-blocking — best effort).
      try {
        const providers = loadProvidersFromConfig({ [providerId]: resolveProviderEntry(providerId, entry) });
        if (providers.length > 0) {
          const decl = await providers[0]!.declareCapability(selectedModel);
          // Store capability profile in provider metadata.
          config.providers[providerId]!.metadata = {
            capabilities: decl.capabilities,
            streaming: decl.streaming,
            toolCalling: decl.toolCalling,
            multimodal: decl.multimodal,
            maxContext: decl.maxContext,
            probedAt: Date.now(),
          };
        }
      } catch {
        // Capability probing is best-effort — don't block onboarding.
      }

      config.preferDeterministicTools = true;
      config.sandbox.allowedRoots = [process.cwd()];
      config.sandbox.allowedCommands = ["git", "node", "npm", "npx", "tsx"];
      config.sandbox.allowNetwork = true;
      config.onboarded = true;

      setPhase("saving");
      saveConfig(config);

      setTimeout(() => {
        onCompleteRef.current(config);
      }, 500);
    };

    void run();
  }, [phase, selectedPreset, selectedModel, apiKey, customUrl]);

  // ---- Render ----

  if (phase === "welcome") {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" padding={2}>
        <Text color={COLORS.azure} bold>
          ██████╗██╗███╗   ███╗██╗   ██╗███████╗██╗  ██╗██╗██████╗ ███████╗██████╗
        </Text>
        <Text color={COLORS.azure} bold>
          ██╔════╝██║████╗ ████║██║   ██║██╔════╝██║  ██║██║██╔══██╗██╔════╝██╔══██╗
        </Text>
        <Text color={COLORS.azure} bold>
          ██║     ██║██╔████╔██║██║   ██║███████╗███████║██║██║  ██║█████╗  ██████╔╝
        </Text>
        <Text color={COLORS.azure} bold>
          ██║     ██║██║╚██╔╝██║██║   ██║╚════██║██╔══██║██║██║  ██║██╔══╝  ██╔══██╗
        </Text>
        <Text color={COLORS.azure} bold>
          ╚██████╗██║██║ ╚═╝██║╚██████╔╝███████║██║  ██║██║██████╔╝███████╗██║  ██║
        </Text>
        <Text color={COLORS.azure} bold>
          ╚═════╝╚═╝╚═╝     ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝╚═════╝ ╚══════╝╚═╝  ╚═╝
        </Text>
        <Box marginTop={1}>
          <Text color={COLORS.white}>One Runtime. Any Model. Unlimited Capabilities.</Text>
        </Box>
        <Box marginTop={2}>
          <Text color={COLORS.dim}>Welcome to MINDIGENOUS. Let's get you set up.</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={COLORS.sky} bold>Press Enter to begin →</Text>
        </Box>
      </Box>
    );
  }

  if (phase === "scanning") {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" padding={2}>
        <Text color={COLORS.azure} bold>🔍 Scanning system for API keys...</Text>
        <Box marginTop={1}>
          <Text color={COLORS.deep}>Checking environment variables</Text>
        </Box>
        <Text color={COLORS.deep}>Checking .env files</Text>
        <Text color={COLORS.deep}>Checking Claude Code config</Text>
        <Text color={COLORS.deep}>Checking project directories</Text>
      </Box>
    );
  }

  if (phase === "key-select") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color={COLORS.azure}>Found {detectedKeys.length} API key(s) on your system</Text>
        <Text color={COLORS.white}>Select a key to use, or skip to enter manually:</Text>
        <Box marginTop={1} flexDirection="column">
          {detectedKeys.map((dk, i) => (
            <Box key={i} gap={1}>
              <Text color={i === cursor ? COLORS.sky : COLORS.dim}>
                {i === cursor ? "❯" : " "}
              </Text>
              <Text color={i === cursor ? COLORS.ice : COLORS.white} bold={i === cursor}>
                {dk.label}
              </Text>
              <Text color={COLORS.dim}>{maskKey(dk.key)}</Text>
              <Text color={COLORS.dim}>({dk.source})</Text>
            </Box>
          ))}
          <Box gap={1} marginTop={1}>
            <Text color={cursor === detectedKeys.length ? COLORS.sky : COLORS.dim}>
              {cursor === detectedKeys.length ? "❯" : " "}
            </Text>
            <Text color={cursor === detectedKeys.length ? COLORS.ice : COLORS.dim}>
              Skip — enter manually
            </Text>
          </Box>
        </Box>
        <Box marginTop={1}>
          <Text color={COLORS.dim}>↑↓ Navigate · Enter Select</Text>
        </Box>
      </Box>
    );
  }

  if (phase === "provider-select") {
    return (
      <Box flexDirection="column" padding={1}>
        {repair ? (
          <>
            <Text bold color="yellow">⚠ Provider configuration needs repair</Text>
            <Text color={COLORS.white}>Select a provider to restore connectivity.</Text>
          </>
        ) : (
          <>
            <Text bold color={COLORS.azure}>Select your AI provider</Text>
            <Text color={COLORS.white}>Choose the provider you want as your primary reasoning engine.</Text>
          </>
        )}
        <Box marginTop={1} flexDirection="column">
          {PRESETS.map((preset, i) => (
            <Box key={preset.id} gap={1}>
              <Text color={i === cursor ? COLORS.sky : COLORS.dim}>
                {i === cursor ? "❯" : " "}
              </Text>
              <Text color={i === cursor ? COLORS.sky : COLORS.white} bold={i === cursor}>
                {preset.label.padEnd(20)}
              </Text>
              <Text color={COLORS.dim}>
                {preset.description}
              </Text>
            </Box>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text color={COLORS.dim}>↑↓ Navigate · Enter Select · Ctrl+C Exit</Text>
        </Box>
      </Box>
    );
  }

  if (phase === "api-key") {
    const displayName = selectedPreset?.label ?? "Provider";
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color={COLORS.azure}>Enter your {displayName} API key</Text>
        <Text color={COLORS.white}>Your key is stored locally and never sent anywhere except {displayName}.</Text>
        <Box marginTop={1}>
          <Text color={COLORS.sky}>{"› "}</Text>
          <TextInput
            value={apiKey}
            onChange={setApiKey}
            placeholder="Paste your API key here..."
            mask="*"
          />
        </Box>
        <Box marginTop={1}>
          <Text color={COLORS.dim}>Press Enter when done · Ctrl+C Exit</Text>
        </Box>
        {error && <Text color="red">✗ {error}</Text>}
      </Box>
    );
  }

  if (phase === "custom-name") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color={COLORS.azure}>Name your provider</Text>
        <Text color={COLORS.white}>This name will be shown throughout the Runtime UI (header, status, diagnostics).</Text>
        <Box marginTop={1}>
          <Text color={COLORS.sky}>{"› "}</Text>
          <TextInput
            value={customDisplayName}
            onChange={setCustomDisplayName}
            placeholder="e.g. My Company AI, Internal LLM, etc."
          />
        </Box>
        <Box marginTop={1}>
          <Text color={COLORS.dim}>Press Enter to continue</Text>
        </Box>
      </Box>
    );
  }

  if (phase === "custom-url") {
    const displayName = selectedPreset?.label ?? "Provider";
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color={COLORS.azure}>Configure {displayName}</Text>
        <Text color={COLORS.white}>Base URL (edit if needed, or press Enter to accept):</Text>
        <Box marginTop={1}>
          <Text color={COLORS.sky}>{"› "}</Text>
          <TextInput
            value={customUrl}
            onChange={setCustomUrl}
            placeholder="https://api.your-provider.com/v1"
          />
        </Box>
        <Box marginTop={1}>
          <Text color={COLORS.dim}>Press Enter to continue</Text>
        </Box>
      </Box>
    );
  }

  if (phase === "connecting") {
    const displayName = selectedPreset?.label ?? "Provider";
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color={COLORS.azure}>Setting up {displayName}</Text>
        <Box marginTop={1} flexDirection="column">
          {progress.map((step, i) => (
            <Box key={i} gap={1}>
              <Text color={step.status === "done" ? COLORS.ice : step.status === "active" ? COLORS.sky : step.status === "failed" ? "red" : COLORS.dim}>
                {step.status === "done" ? "✓" : step.status === "active" ? "◉" : step.status === "failed" ? "✗" : "○"}
              </Text>
              <Text color={step.status === "done" ? COLORS.ice : step.status === "active" ? COLORS.white : step.status === "failed" ? "red" : COLORS.dim}>
                {step.label}
              </Text>
              {step.status === "active" && <Text color={COLORS.sky}>...</Text>}
            </Box>
          ))}
        </Box>
        {error && (
          <Box marginTop={1} flexDirection="column">
            <Text color="red" bold>✗ {error}</Text>
            <Text color={COLORS.dim}>Press any key to go back and try again.</Text>
          </Box>
        )}
      </Box>
    );
  }

  if (phase === "model-select") {
    const displayName = selectedPreset?.label ?? "Provider";
    const filtered = filterModels(models, searchQuery);

    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color={COLORS.azure}>Select your primary model</Text>
        <Text color={COLORS.white}>Available models from {displayName}:</Text>
        {models.length === 0 && (
          <Box marginTop={1} flexDirection="column">
            <Text color={COLORS.frost}>{displayName} doesn't expose a model list.</Text>
            <Text color={COLORS.white}>Type your model name (e.g. z-ai/glm-5.2-free):</Text>
            <Box marginTop={1}>
              <Text color={COLORS.sky}>{"› "}</Text>
              <TextInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="z-ai/glm-5.2-free"
              />
            </Box>
            {searchQuery && (
              <Box marginTop={1}>
                <Text color={COLORS.sky} bold>Press Enter to use "{searchQuery}"</Text>
              </Box>
            )}
          </Box>
        )}
        {filtered.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            <Box marginBottom={1}>
              <Text color={COLORS.sky}>{"› "}</Text>
              <TextInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Type to search models..."
              />
            </Box>
            {filtered.slice(0, 12).map((model, i) => (
              <Box key={model.id} gap={1}>
                <Text color={i === cursor ? COLORS.sky : COLORS.dim}>
                  {i === cursor ? "❯" : " "}
                </Text>
                <Text color={i === cursor ? COLORS.sky : COLORS.white} bold={i === cursor}>
                  {model.id}
                </Text>
                {model.capabilities.length > 0 && (
                  <Text color={COLORS.dim}>[{model.capabilities.join(", ")}]</Text>
                )}
              </Box>
            ))}
          </Box>
        )}
        <Box marginTop={1}>
          <Text color={COLORS.dim}>↑↓ Navigate · Type to search · Enter Select · Esc Clear</Text>
        </Box>
      </Box>
    );
  }

  if (phase === "capabilities" || phase === "saving") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color={COLORS.azure}>Configuring runtime...</Text>
        <Text color={COLORS.white}>Enabling deterministic tools (Filesystem, Terminal, Git, etc.)</Text>
        <Text color={COLORS.ice} bold>✓ Free tools auto-enabled</Text>
        <Text color={COLORS.white}>Saving configuration...</Text>
        <Text color={COLORS.ice} bold>✓ Configuration saved</Text>
        <Box marginTop={1}>
          <Text color={COLORS.dim}>Starting MINDIGENOUS...</Text>
        </Box>
      </Box>
    );
  }

  return <Text color={COLORS.azure}>Starting...</Text>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function filterModels(models: ProviderModel[], query: string): ProviderModel[] {
  if (!query) return models;
  const q = query.toLowerCase();
  return models.filter((m) => m.id.toLowerCase().includes(q));
}
