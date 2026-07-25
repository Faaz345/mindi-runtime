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
import { WorkspaceTrust } from "./WorkspaceTrust.js";
import { silentHealthCheck } from "../cli/health-check.js";
import { loadEnvFile, bootRuntime } from "../cli/runtime-loader.js";
import { toRuntimeConfig } from "../cli/onboarding-config.js";
import type { Runtime } from "../index.js";
import type { OnboardingConfig } from "../cli/onboarding-config.js";

type Phase = "fade-in" | "health-check" | "onboarding" | "workspace-trust" | "startup" | "boot" | "terminal" | "error";

function App(): React.ReactElement {
  const [phase, setPhase] = useState<Phase>("fade-in");
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [sessionId, setSessionId] = useState<string>("");
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
    silentHealthCheck().then((result) => {
      if (result.ok && result.config) {
        try {
          const rt = bootRuntime(toRuntimeConfig(result.config));
          setRuntime(rt);
          const sessions = rt.sessions.list();
          if (sessions.length > 0) {
            setSessionId(sessions[0]!.id);
          } else {
            const s = rt.createSession({
              providerId: rt.config.defaultProviderId,
              modelId: rt.config.defaultModel,
            });
            setSessionId(s.id);
          }
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
    try {
      loadEnvFile();
      const rt = bootRuntime(toRuntimeConfig(config));
      setRuntime(rt);
      const s = rt.createSession({
        providerId: rt.config.defaultProviderId,
        modelId: rt.config.defaultModel,
      });
      setSessionId(s.id);
      setPhase("workspace-trust");
    } catch (err) {
      setTimeout(() => {
        try {
          loadEnvFile();
          const rt = bootRuntime(toRuntimeConfig(config));
          setRuntime(rt);
          const s = rt.createSession({
            providerId: rt.config.defaultProviderId,
            modelId: rt.config.defaultModel,
          });
          setSessionId(s.id);
          setPhase("workspace-trust");
        } catch {
          setPhase("error");
        }
      }, 500);
    }
  }, []);

  // ---- Render ----

  if (phase === "fade-in") {
    const dots = "·".repeat(fadeStep * 2);
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center">
        <Text color="#1e3a5f">{dots}</Text>
      </Box>
    );
  }

  if (phase === "health-check") {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center">
        <Text color="#3b82f6">Initializing MINDIGENOUS Runtime...</Text>
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
    return <BootSequence onDone={() => setPhase("terminal")} />;
  }

  if (phase === "terminal" && runtime) {
    return (
      <Terminal
        runtime={runtime}
        sessionId={sessionId}
        providerId={runtime.config.defaultProviderId}
        modelId={runtime.config.defaultModel}
        workspace={process.cwd()}
      />
    );
  }

  if (phase === "error") {
    return (
      <Box flexDirection="column" padding={2}>
        <Text color="red" bold>✗ Failed to start MINDIGENOUS</Text>
        <Text color="gray">Please check your configuration and try again.</Text>
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
