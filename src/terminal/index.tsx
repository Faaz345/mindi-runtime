#!/usr/bin/env node
/**
 * MINDIGENOUS — the official interactive terminal client.
 *
 * Entry point: `mindi` or `mindigenous`
 *
 * Flow:
 *   1. Fade-in clear (cool effect)
 *   2. Silent health check
 *   3. If healthy → startup animation → boot → terminal
 *   4. If not healthy → onboarding (with API key auto-detection) → terminal
 *
 * The user never has to run another command. Everything happens inside
 * this single process.
 */

import React, { useState, useEffect, useCallback } from "react";
import { render, Box, Text } from "ink";
import { StartupAnimation } from "./StartupAnimation.js";
import { BootSequence } from "./BootSequence.js";
import { Terminal } from "./Terminal.js";
import { OnboardingFlow } from "./OnboardingFlow.js";
import { WorkspaceTrust, trustWorkspace } from "./WorkspaceTrust.js";
import { SessionPicker, resumableSessions } from "./SessionPicker.js";
import { silentHealthCheck } from "../cli/health-check.js";
import { loadEnvFile, bootRuntime } from "../cli/runtime-loader.js";
import { toRuntimeConfig } from "../cli/onboarding-config.js";
import { COLORS } from "./colors.js";
import type { Runtime } from "../index.js";
import type { OnboardingConfig } from "../cli/onboarding-config.js";
import { messageFromChat, type Message } from "./types.js";
import type { SessionSummary } from "../workspace/types.js";

type Phase = "fade-in" | "health-check" | "onboarding" | "workspace-trust" | "startup" | "boot" | "session-select" | "terminal" | "error";

function App(): React.ReactElement {
  const [phase, setPhase] = useState<Phase>("fade-in");
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [sessionId, setSessionId] = useState<string>("");
  const [providerId, setProviderId] = useState<string>("");
  const [modelId, setModelId] = useState<string>("");
  const [restoredMessages, setRestoredMessages] = useState<Message[]>([]);
  const [recentSessions, setRecentSessions] = useState<SessionSummary[]>([]);
  const [fadeStep, setFadeStep] = useState(0);

  // ---- Phase 0: Cool fade-in effect ----
  useEffect(() => {
    if (phase !== "fade-in") return;
    // Clear screen with a smooth fade effect.
    const frames = [
      "\x1b[2J\x1b[H",
      "\x1b[2J\x1b[H\x1b[38;5;235m",
      "\x1b[2J\x1b[H\x1b[38;5;240m",
      "\x1b[2J\x1b[H\x1b[38;5;245m",
      "\x1b[2J\x1b[H\x1b[38;5;250m",
      "\x1b[2J\x1b[H\x1b[0m",
    ];
    let i = 0;
    const timer = setInterval(() => {
      if (i < frames.length) {
        process.stdout.write(frames[i]!);
        setFadeStep(i);
        i++;
      } else {
        clearInterval(timer);
        setPhase("health-check");
      }
    }, 60);
    return () => clearInterval(timer);
  }, [phase]);

  // ---- Phase 1: Silent health check ----
  useEffect(() => {
    if (phase !== "health-check") return;
    loadEnvFile();
    silentHealthCheck().then(async (result) => {
      if (result.ok && result.config) {
        try {
          const rt = bootRuntime(toRuntimeConfig(result.config));
          setRuntime(rt);
           setRecentSessions(resumableSessions(rt.workspace?.sessionManager.listSessions() ?? []));
          setPhase("workspace-trust");
        } catch {
          setPhase("onboarding");
        }
      } else {
        setPhase("onboarding");
      }
    });
  }, [phase]);

  // ---- Phase 4: Onboarding complete ----
  const handleOnboardingComplete = useCallback((config: OnboardingConfig) => {
    // The user just explicitly configured MINDIGENOUS in this directory —
    // trust it implicitly and go straight to the startup animation instead
    // of showing a second, redundant trust prompt (which looked like a hang).
    const boot = async (): Promise<Runtime> => {
      loadEnvFile();
      const rt = bootRuntime(toRuntimeConfig(config));
      setRuntime(rt);
      setRecentSessions(resumableSessions(rt.workspace?.sessionManager.listSessions() ?? []));
      trustWorkspace(process.cwd());
      setPhase("startup");
      return rt;
    };

    try {
      void boot();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[MINDI] Onboarding boot error:", errMsg);
      // Retry once after a short delay (config may need a beat to settle).
      setTimeout(() => {
        boot().catch((err2) => {
          const errMsg2 = err2 instanceof Error ? err2.message : String(err2);
          console.error("[MINDI] Onboarding boot retry error:", errMsg2);
          setPhase("error");
        });
      }, 500);
    }
  }, []);

  const resumeSession = useCallback(async (id: string) => {
    if (!runtime) return;
    const restored = await runtime.activateWorkspaceSession(id);
    if (!restored) return;
    setSessionId(restored.session.id);
    setProviderId(restored.effectiveProviderId);
    setModelId(restored.effectiveModelId);
    const history = runtime.workspace?.sessionManager.recall(id) ?? restored.session.messages;
    setRestoredMessages(history.map(messageFromChat));
    setPhase("terminal");
  }, [runtime]);

  const startNewSession = useCallback(async () => {
    if (!runtime) return;
    const record = runtime.workspace?.sessionManager.create({
      providerId: runtime.config.defaultProviderId,
      modelId: runtime.config.defaultModel,
    });
    if (record) {
      const restored = await runtime.activateWorkspaceSession(record.id);
      if (!restored) return;
      setSessionId(record.id);
      setProviderId(restored.effectiveProviderId);
      setModelId(restored.effectiveModelId);
    } else {
      const session = runtime.createSession({ providerId: runtime.config.defaultProviderId, modelId: runtime.config.defaultModel });
      setSessionId(session.id);
      setProviderId(runtime.config.defaultProviderId);
      setModelId(runtime.config.defaultModel);
    }
    setRestoredMessages([]);
    setPhase("terminal");
  }, [runtime]);

  const deleteSession = useCallback((id: string) => {
    if (!runtime?.workspace) return;
    runtime.workspace.sessionManager.delete(id);
    setRecentSessions(resumableSessions(runtime.workspace.sessionManager.listSessions()));
  }, [runtime]);

  // ---- Render ----

  if (phase === "fade-in") {
    const dots = "·".repeat(fadeStep * 2);
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center">
        <Text color={COLORS.deep}>{dots}</Text>
      </Box>
    );
  }

  if (phase === "health-check") {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center">
        <Text color={COLORS.azure}>Initializing MINDIGENOUS Runtime...</Text>
      </Box>
    );
  }

  if (phase === "onboarding") {
    return <OnboardingFlow onComplete={handleOnboardingComplete} />;
  }

  if (phase === "workspace-trust") {
    return <WorkspaceTrust workspace={process.cwd()} onTrust={() => setPhase("startup")} />;
  }

  if (phase === "startup") {
    return <StartupAnimation onDone={() => setPhase("boot")} />;
  }

  if (phase === "boot") {
    return <BootSequence onDone={() => {
      if (recentSessions.length > 0) setPhase("session-select");
      else void startNewSession();
    }} />;
  }

  if (phase === "session-select") {
    return <SessionPicker sessions={recentSessions} onResume={(id) => void resumeSession(id)} onNew={() => void startNewSession()} onDelete={deleteSession} />;
  }

  if (phase === "terminal" && runtime) {
    return (
      <Terminal
        runtime={runtime}
        sessionId={sessionId}
        providerId={providerId || runtime.config.defaultProviderId}
        modelId={modelId || runtime.config.defaultModel}
        workspace={process.cwd()}
        restoredMessages={restoredMessages}
         onSwitchSession={(id) => {
           setSessionId(id);
           const record = runtime.workspace?.sessionManager.get(id);
           if (record) {
             setProviderId(record.providerId);
             setModelId(record.modelId);
           }
           const history = runtime.workspace?.sessionManager.recall(id) ?? [];
           setRestoredMessages(history.map(messageFromChat));
        }}
      />
    );
  }

  if (phase === "error") {
    return (
      <Box flexDirection="column" padding={2}>
        <Text color="red" bold>✗ Failed to start MINDIGENOUS</Text>
        <Text color={COLORS.dim}>Please check your configuration and try again.</Text>
      </Box>
    );
  }

  return <Text>Loading...</Text>;
}

// Suppress structured logger output to stderr.
const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
  const str = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
  if (str.startsWith("{") && str.includes('"level"')) return true;
  return (origStderrWrite as Function)(chunk, ...args);
}) as typeof process.stderr.write;

render(React.createElement(App));
