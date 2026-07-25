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
  { id: "tokenrouter", label: "TokenRouter", description: "Access any model via TokenRouter", type: "openai-compatible", baseUrl: "https://api.tokenrouter.com/v1", needsApiKey: true },
  { id: "openrouter", label: "OpenRouter", description: "100+ models through one API", type: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", needsApiKey: true },
  { id: "openai", label: "OpenAI", description: "GPT-4o, o1, and more", type: "openai-compatible", baseUrl: "https://api.openai.com/v1", needsApiKey: true },
  { id: "gemini", label: "Google Gemini", description: "Gemini 2.5 Pro/Flash", type: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", needsApiKey: true },
  { id: "groq", label: "Groq", description: "Ultra-fast inference", type: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", needsApiKey: true },
  { id: "together", label: "Together AI", description: "Open-source models at scale", type: "openai-compatible", baseUrl: "https://api.together.xyz/v1", needsApiKey: true },
  { id: "fireworks", label: "Fireworks AI", description: "Fast + cheap inference", type: "openai-compatible", baseUrl: "https://api.fireworks.ai/inference/v1", needsApiKey: true },
  { id: "deepseek", label: "DeepSeek", description: "DeepSeek models", type: "openai-compatible", baseUrl: "https://api.deepseek.com/v1", needsApiKey: true },
  { id: "ollama", label: "Ollama", description: "Run models locally (no API key)", type: "openai-compatible", baseUrl: "http://localhost:11434/v1", authMethod: "none", needsApiKey: false },
  { id: "lmstudio", label: "LM Studio", description: "Local model server (no API key)", type: "openai-compatible", baseUrl: "http://localhost:1234/v1", authMethod: "none", needsApiKey: false },
  { id: "azure", label: "Azure OpenAI", description: "Enterprise OpenAI on Azure", type: "openai-compatible", needsApiKey: true },
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

export function OnboardingFlow({ onComplete }: { onComplete: (config: OnboardingConfig) => void }): React.ReactElement {
  const { exit } = useApp();
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const [phase, setPhase] = useState<Phase>("welcome");
  const [selectedPreset, setSelectedPreset] = useState<ProviderPreset | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [customUrl, setCustomUrl] = useState("");
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
      // For custom provider, start with empty URL.
      if (preset.id === "custom") {
        setCustomUrl("");
        setPhase("custom-url");
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
      { label: `Detecting capabilities...`, status: "pending" },
    ]);

    // Build provider entry — use customUrl if set (for custom providers).
    const baseUrl = customUrl.trim() || preset.baseUrl;
    const entry: ProviderEntry = {
      type: preset.type,
      apiKey: key || undefined,
      baseUrl: baseUrl,
      authMethod: preset.authMethod ?? (key ? "bearer" : "none"),
      displayName: displayName,
      enabled: true,
    };
    const resolved = resolveProviderEntry(preset.id, entry);

    // Instantiate provider.
    try {
      const providers = loadProvidersFromConfig({ [preset.id]: resolved });
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
        // No models listed — let user type a model name (opaque providers like TokenRouter).
        setPhase("model-select");
      }
    } catch (err) {
      setProgress((prev) => prev.map((s) => s.status === "active" ? { ...s, status: "failed" } : s));
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // ---- Capabilities + Save ----
  useEffect(() => {
    if (phase !== "capabilities" || !selectedPreset || !selectedModel) return;

    // Auto-enable free deterministic tools + save config.
    const config = createEmptyConfig();
    config.primaryProvider = selectedPreset.id;
    config.primaryModel = selectedModel;

    // Save the provider entry — use the actual baseUrl (customUrl or preset default).
    const actualBaseUrl = customUrl.trim() || selectedPreset.baseUrl;
    const entry: ProviderEntry = {
      type: selectedPreset.type,
      apiKey: apiKey || undefined,
      baseUrl: actualBaseUrl,
      authMethod: selectedPreset.authMethod ?? (apiKey ? "bearer" : "none"),
      displayName: selectedPreset.label,
      enabled: true,
    };
    config.providers[selectedPreset.id] = resolveProviderEntry(selectedPreset.id, entry);

    // Auto-enable free deterministic tools.
    config.preferDeterministicTools = true;
    config.sandbox.allowedRoots = [process.cwd()];
    config.sandbox.allowedCommands = ["git", "node", "npm", "npx", "tsx"];
    config.onboarded = true;

    // Save.
    setPhase("saving");
    saveConfig(config);

    // Transition to terminal after a brief pause.
    const t = setTimeout(() => {
      setPhase("done");
      onCompleteRef.current(config);
    }, 500);

    return () => clearTimeout(t);
  }, [phase, selectedPreset, selectedModel, apiKey]);

  // ---- Render ----

  if (phase === "welcome") {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" padding={2}>
        <Text color="cyan" bold>
          ██████╗██╗███╗   ███╗██╗   ██╗███████╗██╗  ██╗██╗██████╗ ███████╗██████╗
        </Text>
        <Text color="cyan" bold>
          ██╔════╝██║████╗ ████║██║   ██║██╔════╝██║  ██║██║██╔══██╗██╔════╝██╔══██╗
        </Text>
        <Text color="cyan" bold>
          ██║     ██║██╔████╔██║██║   ██║███████╗███████║██║██║  ██║█████╗  ██████╔╝
        </Text>
        <Text color="cyan" bold>
          ██║     ██║██║╚██╔╝██║██║   ██║╚════██║██╔══██║██║██║  ██║██╔══╝  ██╔══██╗
        </Text>
        <Text color="cyan" bold>
          ╚██████╗██║██║ ╚═╝██║╚██████╔╝███████║██║  ██║██║██████╔╝███████╗██║  ██║
        </Text>
        <Text color="cyan" bold>
          ╚═════╝╚═╝╚═╝     ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝╚═════╝ ╚══════╝╚═╝  ╚═╝
        </Text>
        <Box marginTop={1}>
          <Text>One Runtime. Any Model. Unlimited Capabilities.</Text>
        </Box>
        <Box marginTop={2}>
          <Text color="gray">Welcome to MINDIGENOUS. Let's get you set up.</Text>
        </Box>
        <Box marginTop={1}>
          <Text color="cyan" bold>Press Enter to begin →</Text>
        </Box>
      </Box>
    );
  }

  if (phase === "scanning") {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" padding={2}>
        <Text color="#3b82f6" bold>🔍 Scanning system for API keys...</Text>
        <Box marginTop={1}>
          <Text color="#1e3a5f">Checking environment variables</Text>
        </Box>
        <Text color="#1e3a5f">Checking .env files</Text>
        <Text color="#1e3a5f">Checking Claude Code config</Text>
        <Text color="#1e3a5f">Checking project directories</Text>
      </Box>
    );
  }

  if (phase === "key-select") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="#3b82f6">Found {detectedKeys.length} API key(s) on your system</Text>
        <Text>Select a key to use, or skip to enter manually:</Text>
        <Box marginTop={1} flexDirection="column">
          {detectedKeys.map((dk, i) => (
            <Box key={i} gap={1}>
              <Text color={i === cursor ? "#60a5fa" : "#6b6b80"}>
                {i === cursor ? "❯" : " "}
              </Text>
              <Text color={i === cursor ? "#93c5fd" : "#ffffff"} bold={i === cursor}>
                {dk.label}
              </Text>
              <Text color="#6b6b80">{maskKey(dk.key)}</Text>
              <Text color="#6b6b80">({dk.source})</Text>
            </Box>
          ))}
          <Box gap={1} marginTop={1}>
            <Text color={cursor === detectedKeys.length ? "#60a5fa" : "#6b6b80"}>
              {cursor === detectedKeys.length ? "❯" : " "}
            </Text>
            <Text color={cursor === detectedKeys.length ? "#93c5fd" : "#6b6b80"}>
              Skip — enter manually
            </Text>
          </Box>
        </Box>
        <Box marginTop={1}>
          <Text color="#6b6b80">↑↓ Navigate · Enter Select</Text>
        </Box>
      </Box>
    );
  }

  if (phase === "provider-select") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">Select your AI provider</Text>
        <Text>Choose the provider you want as your primary reasoning engine.</Text>
        <Box marginTop={1} flexDirection="column">
          {PRESETS.map((preset, i) => (
            <Box key={preset.id} gap={1}>
              <Text color={i === cursor ? "cyan" : "gray"}>
                {i === cursor ? "❯" : " "}
              </Text>
              <Text color={i === cursor ? "cyan" : "white"} bold={i === cursor}>
                {preset.label.padEnd(20)}
              </Text>
              <Text color="gray">
                {preset.description}
              </Text>
            </Box>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text>↑↓ Navigate · Enter Select · Ctrl+C Exit</Text>
        </Box>
      </Box>
    );
  }

  if (phase === "api-key") {
    const displayName = selectedPreset?.label ?? "Provider";
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">Enter your {displayName} API key</Text>
        <Text>Your key is stored locally and never sent anywhere except {displayName}.</Text>
        <Box marginTop={1}>
          <Text color="cyan">{"› "}</Text>
          <TextInput
            value={apiKey}
            onChange={setApiKey}
            placeholder="Paste your API key here..."
            mask="*"
          />
        </Box>
        <Box marginTop={1}>
          <Text>Press Enter when done · Ctrl+C Exit</Text>
        </Box>
        {error && <Text color="red">✗ {error}</Text>}
      </Box>
    );
  }

  if (phase === "custom-url") {
    const displayName = selectedPreset?.label ?? "Provider";
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">Configure {displayName}</Text>
        <Text>Base URL (edit if needed, or press Enter to accept):</Text>
        <Box marginTop={1}>
          <Text color="cyan">{"› "}</Text>
          <TextInput
            value={customUrl}
            onChange={setCustomUrl}
            placeholder="https://api.your-provider.com/v1"
          />
        </Box>
        <Box marginTop={1}>
          <Text>Press Enter to continue</Text>
        </Box>
      </Box>
    );
  }

  if (phase === "connecting") {
    const displayName = selectedPreset?.label ?? "Provider";
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">Setting up {displayName}</Text>
        <Box marginTop={1} flexDirection="column">
          {progress.map((step, i) => (
            <Box key={i} gap={1}>
              <Text color={step.status === "done" ? "green" : step.status === "active" ? "cyan" : step.status === "failed" ? "red" : "gray"}>
                {step.status === "done" ? "✓" : step.status === "active" ? "◉" : step.status === "failed" ? "✗" : "○"}
              </Text>
              <Text color={step.status === "done" ? "green" : step.status === "active" ? "white" : step.status === "failed" ? "red" : "gray"}>
                {step.label}
              </Text>
              {step.status === "active" && <Text color="cyan">...</Text>}
            </Box>
          ))}
        </Box>
        {error && (
          <Box marginTop={1} flexDirection="column">
            <Text color="red" bold>✗ {error}</Text>
            <Text color="gray">Press any key to go back and try again.</Text>
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
        <Text bold color="cyan">Select your primary model</Text>
        <Text>Available models from {displayName}:</Text>
        {models.length === 0 && (
          <Box marginTop={1} flexDirection="column">
            <Text color="yellow">{displayName} doesn't expose a model list.</Text>
            <Text>Type your model name (e.g. z-ai/glm-5.2-free):</Text>
            <Box marginTop={1}>
              <Text color="cyan">{"› "}</Text>
              <TextInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="z-ai/glm-5.2-free"
              />
            </Box>
            {searchQuery && (
              <Box marginTop={1}>
                <Text color="cyan" bold>Press Enter to use "{searchQuery}"</Text>
              </Box>
            )}
          </Box>
        )}
        {filtered.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            <Box marginBottom={1}>
              <Text color="cyan">{"› "}</Text>
              <TextInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Type to search models..."
              />
            </Box>
            {filtered.slice(0, 12).map((model, i) => (
              <Box key={model.id} gap={1}>
                <Text color={i === cursor ? "cyan" : "gray"}>
                  {i === cursor ? "❯" : " "}
                </Text>
                <Text color={i === cursor ? "cyan" : "white"} bold={i === cursor}>
                  {model.id}
                </Text>
                {model.capabilities.length > 0 && (
                  <Text color="gray">[{model.capabilities.join(", ")}]</Text>
                )}
              </Box>
            ))}
          </Box>
        )}
        <Box marginTop={1}>
          <Text>↑↓ Navigate · Type to search · Enter Select · Esc Clear</Text>
        </Box>
      </Box>
    );
  }

  if (phase === "capabilities" || phase === "saving") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">Configuring runtime...</Text>
        <Text>Enabling deterministic tools (Filesystem, Terminal, Git, etc.)</Text>
        <Text color="green" bold>✓ Free tools auto-enabled</Text>
        <Text>Saving configuration...</Text>
        <Text color="green" bold>✓ Configuration saved</Text>
      </Box>
    );
  }

  return <Text>Starting...</Text>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function filterModels(models: ProviderModel[], query: string): ProviderModel[] {
  if (!query) return models;
  const q = query.toLowerCase();
  return models.filter((m) => m.id.toLowerCase().includes(q));
}
