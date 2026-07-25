/** `mindi config` — shows/validates resolved config. */

import type { Runtime } from "../../index.js";
import { header, section, info, warn, success, error, colors, formatMs } from "../format.js";
import { isOnboarded, hasOnboardingConfig } from "../runtime-loader.js";
import { loadConfig } from "../onboarding-config.js";

export function configCommand(rt: Runtime): void {
  header("MINDI Runtime — Configuration");

  // Show onboarding state
  section("Onboarding");
  const onboarded = isOnboarded();
  const hasConfig = hasOnboardingConfig();
  if (onboarded) {
    success("Onboarding completed.");
    const oc = loadConfig();
    if (oc) {
      info(`Primary model:     ${colors.cyan(oc.primaryProvider)}/${oc.primaryModel}`);
      info(`Prefer tools:      ${oc.preferDeterministicTools ? colors.green("yes") : colors.red("no")}`);
      if (Object.keys(oc.capabilityProviders).length > 0) {
        info(`Augmentation:      ${Object.keys(oc.capabilityProviders).length} capability provider(s) configured`);
      }
    }
  } else if (hasConfig) {
    warn("Onboarding incomplete. Run `mindi setup` to complete.");
  } else {
    warn("Not onboarded. Run `mindi setup` to get started.");
  }

  const cfg = rt.config;

  section("General");
  info(`Default provider:  ${colors.cyan(cfg.defaultProviderId)}`);
  info(`Default model:     ${colors.cyan(cfg.defaultModel)}`);
  info(`Log level:         ${cfg.logLevel}`);
  info(`Request timeout:   ${formatMs(cfg.requestTimeoutMs)}`);
  info(`Tool timeout:      ${formatMs(cfg.toolTimeoutMs)}`);
  info(`Max history:       ${cfg.maxHistoryMessages} messages`);

  section("Providers");
  const { openai, gemini } = cfg.providers;
  if (openai.apiKey) {
    success(`OpenAI: configured`);
    info(`  Base URL:  ${openai.baseUrl || "https://api.openai.com/v1"}`);
    info(`  Org ID:    ${openai.orgId || colors.dim("—")}`);
  } else {
    warn("OpenAI: not configured (OPENAI_API_KEY not set)");
  }
  if (gemini.apiKey) {
    success(`Gemini: configured`);
  } else {
    warn("Gemini: not configured (GEMINI_API_KEY not set)");
  }

  if (!openai.apiKey && !gemini.apiKey) {
    error("No providers configured. Run `mindi init` to create a .env file.");
  }

  section("Sandbox");
  info(`Allowed roots:     ${cfg.sandbox.allowedRoots.length > 0 ? cfg.sandbox.allowedRoots.join(", ") : colors.dim("(none — filesystem restricted)")}`);
  info(`Allowed commands:  ${cfg.sandbox.allowedCommands.length > 0 ? cfg.sandbox.allowedCommands.join(", ") : colors.dim("(none — terminal restricted)")}`);
  info(`Network access:    ${cfg.sandbox.allowNetwork ? colors.red("allowed") : colors.green("blocked")}`);
  info(`Tool timeout:      ${formatMs(cfg.sandbox.timeoutMs)}`);
  info(`Max output bytes:  ${cfg.sandbox.maxOutputBytes.toLocaleString()}`);

  section("Runtime State");
  info(`Providers:   ${rt.providers.list().length}`);
  info(`Tools:       ${rt.toolRuntime.list().length}`);
  info(`Capabilities: ${rt.registry.list().length}`);
  info(`Sessions:    ${rt.sessions.list().length}`);

  // Metrics summary
  const metrics = rt.getMetrics();
  if (metrics.requests.total > 0) {
    section("Metrics");
    info(`Total requests:     ${metrics.requests.total}`);
    info(`Succeeded:          ${metrics.requests.succeeded}`);
    info(`Failed:             ${metrics.requests.failed}`);
    info(`Avg latency:        ${formatMs(metrics.requests.avgLatencyMs)}`);
    info(`P50 latency:        ${formatMs(metrics.requests.p50LatencyMs)}`);
    info(`P99 latency:        ${formatMs(metrics.requests.p99LatencyMs)}`);
    info(`Capability execs:   ${metrics.capabilities.total}`);
    info(`Graph executions:   ${metrics.graph.total}`);
    info(`Tokens used:        ${metrics.tokensUsed.toLocaleString()}`);
  }

  process.stdout.write("\n");
}
