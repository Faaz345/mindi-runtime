/**
 * Model Picker — interactive model/provider switcher.
 *
 * Clean, paginated list with:
 *   - One model per line (no label duplication)
 *   - Active model marked with ✔
 *   - Selected model highlighted with ❯
 *   - Only shows visible items (scrollable window)
 *   - "Add new provider" at the bottom
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { COLORS } from "../colors.js";
import type { Runtime, ProviderModel } from "../../index.js";

interface ModelPickerProps {
  runtime: Runtime;
  sessionId: string;
  currentProviderId: string;
  currentModelId: string;
  onSwitch: (providerId: string, modelId: string) => void;
  onClose: () => void;
}

type Phase = "loading" | "select" | "enter-name" | "enter-url" | "enter-key" | "enter-model" | "connecting" | "done" | "error";

const VISIBLE_COUNT = 12; // Models visible at once

export function ModelPicker({ runtime, sessionId, currentProviderId, currentModelId, onSwitch, onClose }: ModelPickerProps): React.ReactElement {
  const [phase, setPhase] = useState<Phase>("loading");
  const [models, setModels] = useState<Array<ProviderModel & { providerId: string }>>([]);
  const [cursor, setCursor] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [providerName, setProviderName] = useState("");
  const [providerUrl, setProviderUrl] = useState("");
  const [providerKey, setProviderKey] = useState("");
  const [providerModel, setProviderModel] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    runtime.providers.listModels().then((m) => {
      setModels(m);
      const idx = m.findIndex((x) => x.providerId === currentProviderId && x.id === currentModelId);
      setCursor(idx >= 0 ? idx : 0);
      setPhase("select");
    }).catch(() => {
      setPhase("select");
    });
  }, []);

  // Filter models by search query.
  const filteredModels = searchQuery
    ? models.filter((m) => `${m.providerId}/${m.id}`.toLowerCase().includes(searchQuery.toLowerCase()))
    : models;

  // Compute scroll window.
  const totalItems = filteredModels.length + 1; // +1 for "Add new provider"
  const clampedCursor = Math.min(cursor, totalItems - 1);
  const scrollStart = Math.max(0, clampedCursor - Math.floor(VISIBLE_COUNT / 2));
  const visibleStart = Math.min(scrollStart, Math.max(0, totalItems - VISIBLE_COUNT));
  const visibleEnd = Math.min(visibleStart + VISIBLE_COUNT, totalItems);

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") { onClose(); return; }
    if (key.escape && phase !== "error") {
      // Esc clears an active search filter first; closes only when no filter.
      if (phase === "select" && searchQuery) { setSearchQuery(""); setCursor(0); return; }
      onClose();
      return;
    }

    if (phase === "select") {
      // Arrow keys navigate WITHIN the filtered list — the search query stays
      // intact so the user keeps their narrowed-down results while selecting.
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => Math.min(totalItems - 1, c + 1));
        return;
      }
      // Enter: select the highlighted model.
      if (key.return) {
        if (filteredModels.length === 1) {
          // Only one match — select it directly.
          const m = filteredModels[0]!;
          onSwitch(m.providerId, m.id);
          onClose();
          return;
        }
        if (clampedCursor < filteredModels.length) {
          const m = filteredModels[clampedCursor]!;
          onSwitch(m.providerId, m.id);
          onClose();
        } else {
          setPhase("enter-name");
        }
        return;
      }
      // Tab: auto-complete — if search matches exactly one model, select it.
      if (key.tab) {
        if (filteredModels.length === 1) {
          const m = filteredModels[0]!;
          onSwitch(m.providerId, m.id);
          onClose();
          return;
        }
        if (filteredModels.length > 1) {
          // Auto-complete to the common prefix.
          const first = filteredModels[0]!;
          const fullId = `${first.providerId}/${first.id}`;
          // Find common prefix across all matches.
          let prefix = fullId;
          for (const m of filteredModels) {
            const id = `${m.providerId}/${m.id}`;
            let i = 0;
            while (i < prefix.length && i < id.length && prefix[i] === id[i]) i++;
            prefix = prefix.slice(0, i);
          }
          if (prefix.length > searchQuery.length) {
            setSearchQuery(prefix);
          }
        }
        return;
      }
      // Typing filters the list in real-time.
      if (key.backspace || key.delete) {
        setSearchQuery((q) => q.slice(0, -1));
        setCursor(0);
        return;
      }
      if (ch && !key.ctrl && !key.meta && ch.charCodeAt(0) >= 32) {
        setSearchQuery((q) => q + ch);
        setCursor(0);
        return;
      }
    }

    if (phase === "enter-name") {
      if (key.return) { if (providerName.trim()) setPhase("enter-url"); return; }
      if (key.escape) { setPhase("select"); return; }
      if (key.backspace || key.delete) { setProviderName((v) => v.slice(0, -1)); return; }
      if (ch && !key.ctrl && ch.charCodeAt(0) >= 32) { setProviderName((v) => v + ch); return; }
    }

    if (phase === "enter-url") {
      if (key.return) { if (providerUrl.trim()) setPhase("enter-key"); return; }
      if (key.escape) { setPhase("enter-name"); return; }
      if (key.backspace || key.delete) { setProviderUrl((v) => v.slice(0, -1)); return; }
      if (ch && !key.ctrl && ch.charCodeAt(0) >= 32) { setProviderUrl((v) => v + ch); return; }
    }

    if (phase === "enter-key") {
      if (key.return) { if (providerKey.trim()) setPhase("enter-model"); return; }
      if (key.escape) { setPhase("enter-url"); return; }
      if (key.backspace || key.delete) { setProviderKey((v) => v.slice(0, -1)); return; }
      if (ch && !key.ctrl && ch.charCodeAt(0) >= 32) { setProviderKey((v) => v + ch); return; }
    }

    if (phase === "enter-model") {
      if (key.return) { setPhase("connecting"); return; }
      if (key.escape) { setPhase("enter-key"); return; }
      if (key.backspace || key.delete) { setProviderModel((v) => v.slice(0, -1)); return; }
      if (ch && !key.ctrl && ch.charCodeAt(0) >= 32) { setProviderModel((v) => v + ch); return; }
    }

    if (phase === "error") {
      setPhase("enter-name");
      setError(null);
      return;
    }
  });

  // Handle provider connection.
  useEffect(() => {
    if (phase !== "connecting") return;
    const addProvider = async () => {
      try {
        const { loadProvidersFromConfig } = await import("../../providers/provider-loader.js");
        const { resolveProviderEntry } = await import("../../providers/provider-config.js");
        const { loadConfig, saveConfig, createEmptyConfig } = await import("../../cli/onboarding-config.js");

        const entry = resolveProviderEntry(providerName, {
          type: "openai-compatible",
          apiKey: providerKey,
          baseUrl: providerUrl,
          displayName: providerName,
          enabled: true,
        });

        const providers = loadProvidersFromConfig({ [providerName]: entry });
        if (providers.length === 0) {
          setError("Could not create provider. Check the URL and API key.");
          setPhase("error");
          return;
        }

        const p = providers[0]!;
        runtime.providers.addProvider(p);

        const cfg = loadConfig() ?? createEmptyConfig();
        cfg.providers[providerName] = entry;
        saveConfig(cfg);

        const mdl = providerModel || "gpt-4o-mini";
        runtime.sessions.setModel(sessionId, providerName, mdl);
        onSwitch(providerName, mdl);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    };
    addProvider();
  }, [phase]);

  // ---- Render ----

  if (phase === "loading") {
    return (
      <Box flexDirection="column" borderStyle="double" borderColor={COLORS.azure} paddingX={1}>
        <Text bold color={COLORS.azure}>Select Model</Text>
        <Text color={COLORS.dim}>Loading models...</Text>
      </Box>
    );
  }

  if (phase === "done" || phase === "connecting") {
    return (
      <Box flexDirection="column" borderStyle="double" borderColor={COLORS.azure} paddingX={1}>
        <Text bold color={COLORS.azure}>{phase === "connecting" ? "Adding provider..." : "Done"}</Text>
        {phase === "connecting" && <Text color={COLORS.sky}>◉ Connecting to {providerName}...</Text>}
      </Box>
    );
  }

  if (phase === "select") {
    return (
      <Box flexDirection="column" borderStyle="double" borderColor={COLORS.azure} paddingX={1}>
        <Text bold color={COLORS.azure}>Select Model</Text>
        {searchQuery ? (
          <Text color={COLORS.dim}>Search: <Text color={COLORS.sky}>{searchQuery}▏</Text> ({filteredModels.length} match{filteredModels.length === 1 ? "" : "es"} · ↑↓ navigate · Enter select · Esc clear)</Text>
        ) : (
          <Text color={COLORS.dim}>Type to filter · ↑↓ Navigate · Tab Auto-complete · Enter Select · Esc Cancel</Text>
        )}
        <Box marginTop={0} flexDirection="column">
          {filteredModels.slice(visibleStart, visibleEnd).map((m, i) => {
            const actualIdx = visibleStart + i;
            const isActive = m.providerId === currentProviderId && m.id === currentModelId;
            const isSelected = actualIdx === clampedCursor;
            return (
              <Text key={`${m.providerId}/${m.id}`} wrap="truncate">
                {"  "}{isSelected ? <Text color={COLORS.sky}>❯</Text> : " "}
                {" "}{isSelected ? <Text color={COLORS.sky} bold>{m.providerId}/{m.id}</Text> : <Text color={isActive ? COLORS.assistant : COLORS.white}>{m.providerId}/{m.id}</Text>}
                {isActive ? <Text color={COLORS.assistant}> ✔</Text> : ""}
              </Text>
            );
          })}
          {/* "Add new provider" row */}
          {visibleStart + VISIBLE_COUNT > filteredModels.length && (
            <Text wrap="truncate">
              {"  "}{clampedCursor === filteredModels.length ? <Text color={COLORS.sky}>❯</Text> : " "}
              {" "}{clampedCursor === filteredModels.length
                ? <Text color={COLORS.sky} bold>+ Add new provider...</Text>
                : <Text color={COLORS.dim}>+ Add new provider...</Text>}
            </Text>
          )}
        </Box>
        {totalItems > VISIBLE_COUNT && (
          <Text color={COLORS.dim}> {clampedCursor + 1}/{totalItems}</Text>
        )}
      </Box>
    );
  }

  if (phase === "enter-name" || phase === "enter-url" || phase === "enter-key" || phase === "enter-model") {
    const steps = [
      { id: "enter-name", label: "Provider name", value: providerName, placeholder: "e.g. openrouter" },
      { id: "enter-url", label: "Base URL", value: providerUrl, placeholder: "e.g. https://openrouter.ai/api/v1" },
      { id: "enter-key", label: "API Key", value: providerKey, placeholder: "e.g. sk-or-v1-..." },
      { id: "enter-model", label: "Default model", value: providerModel, placeholder: "e.g. meta-llama/llama-3.2-90b-vision-instruct" },
    ];
    const currentIdx = steps.findIndex((s) => s.id === phase);

    return (
      <Box flexDirection="column" borderStyle="double" borderColor={COLORS.azure} paddingX={1}>
        <Text bold color={COLORS.azure}>Add New Provider</Text>
        <Text color={COLORS.dim}>Step {currentIdx + 1} of {steps.length}</Text>
        <Box marginTop={1} flexDirection="column">
          {steps.map((s, i) => (
            <Box key={s.id} flexDirection="row" gap={1}>
              <Text color={i === currentIdx ? COLORS.sky : i < currentIdx ? COLORS.assistant : COLORS.dim}>
                {i === currentIdx ? "❯" : i < currentIdx ? "✓" : "○"}
              </Text>
              <Text color={i <= currentIdx ? COLORS.white : COLORS.dim} bold={i === currentIdx}>
                {s.label}:
              </Text>
              <Text color={i === currentIdx ? COLORS.sky : i < currentIdx ? COLORS.assistant : COLORS.dim}>
                {i === currentIdx ? `${s.value}▏` : i < currentIdx ? s.value : s.placeholder}
              </Text>
            </Box>
          ))}
        </Box>
        {error && <Text color="#ef4444">{error}</Text>}
        <Box marginTop={1}>
          <Text color={COLORS.dim}>Type and press Enter · Esc to go back</Text>
        </Box>
      </Box>
    );
  }

  if (phase === "error") {
    return (
      <Box flexDirection="column" borderStyle="double" borderColor="#ef4444" paddingX={1}>
        <Text bold color="#ef4444">Failed to add provider</Text>
        <Text color="#ef4444">{error}</Text>
        <Box marginTop={1}>
          <Text color={COLORS.dim}>Press any key to go back</Text>
        </Box>
      </Box>
    );
  }

  return <Box><Text color={COLORS.dim}>...</Text></Box>;
}
