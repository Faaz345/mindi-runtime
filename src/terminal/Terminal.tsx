/**
 * Terminal — refactored rendering architecture.
 *
 * Layout: Header (fixed) + Conversation (scrollable) + Prompt (fixed) + Footer (fixed)
 *
 * Rendering pipeline:
 *   State (raw markdown) → Layout Engine (dimensions/wrapping) → Ink Renderer
 *
 * Rerender throttling:
 *   - Stream flush: 150ms (batched tokens)
 *   - ETA timer: 500ms
 *   - Spinner: isolated via ref (no React state)
 *   - All static components memoized
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Box, Text, Static, useInput, useApp } from "ink";
import type { Runtime, RuntimeEvent } from "../index.js";
import { LayoutProvider } from "./layout/LayoutEngine.js";
import { COLORS } from "./colors.js";
import { Header } from "./components/Header.js";
import { PromptInput } from "./components/PromptInput.js";
import { MessageView, StreamingMessage } from "./components/Conversation.js";
import { StatusLine } from "./components/StatusLine.js";
import { ActivityFeed } from "./components/ActivityFeed.js";
import { Inspector } from "./panels/Inspector.js";
import { LogsPanel } from "./panels/LogsPanel.js";
import { GraphPanel } from "./panels/GraphPanel.js";
import { CommandPalette } from "./panels/CommandPalette.js";
import { ModelPicker } from "./panels/ModelPicker.js";
import type { Message, Attachment, RuntimeStatus, ActivityItem } from "./types.js";
import { closesPanel, type ActivePanel } from "./panelKeyboard.js";

export interface TerminalProps {
  runtime: Runtime;
  sessionId: string;
  providerId: string;
  modelId: string;
  workspace: string;
  /** Messages restored from the previous workspace session. */
  restoredMessages?: Message[];
  /** Called when a slash command switches to a different session. */
  onSwitchSession?: (sessionId: string) => void;
}

interface QueuedPrompt {
  text: string;
  attachments: Attachment[];
}

// ---------------------------------------------------------------------------
// Memoized child components (never rerender unless their props change)
// ---------------------------------------------------------------------------

const MemoHeader = React.memo(Header);
const MemoPromptInput = React.memo(PromptInput, (prev, next) => {
  return prev.value === next.value &&
    prev.isStreaming === next.isStreaming &&
    prev.attachments === next.attachments &&
    prev.mode === next.mode &&
    prev.slashCommands === next.slashCommands &&
    prev.slashSelectedIdx === next.slashSelectedIdx;
});
const MemoActivityFeed = React.memo(ActivityFeed);
const MemoInspector = React.memo(Inspector);
const MemoLogsPanel = React.memo(LogsPanel);
const MemoGraphPanel = React.memo(GraphPanel);
const MemoCommandPalette = React.memo(CommandPalette);

// ---------------------------------------------------------------------------
// Main Terminal
// ---------------------------------------------------------------------------

export function Terminal(props: TerminalProps): React.ReactElement {
  return (
    <LayoutProvider>
      <TerminalInner {...props} />
    </LayoutProvider>
  );
}

function TerminalInner({ runtime, sessionId, providerId: initialProviderId, modelId: initialModelId, workspace, restoredMessages = [], onSwitchSession }: TerminalProps): React.ReactElement {
  const { exit } = useApp();
  const [currentProviderId, setCurrentProviderId] = useState(initialProviderId);
  const [currentModelId, setCurrentModelId] = useState(initialModelId);
  const [messages, setMessages] = useState<Message[]>(restoredMessages);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState<RuntimeStatus>({ stage: "idle", detail: "" });
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [activePanel, setActivePanel] = useState<ActivePanel>("none");
  const [currentStream, setCurrentStream] = useState<string>("");
  const [metricsVersion, setMetricsVersion] = useState(0);
  const [queue, setQueue] = useState<QueuedPrompt[]>([]);
  const [queueNavIdx, setQueueNavIdx] = useState(-1);
  const [slashCmdIdx, setSlashCmdIdx] = useState(-1); // -1 = no selection, 0..N = highlighted command
  const [activities, setActivities] = useState<ActivityItem[]>([]); // live backend steps for the in-flight request
  const [epoch, setEpoch] = useState(0); // bumped on /clear to remount the Static region
  const [mode, setMode] = useState<"plan" | "build">("build");

  // Hydrate on startup and replace the visible transcript when /switch or
  // /new activates another workspace session without remounting Terminal.
  useEffect(() => {
    setMessages(restoredMessages);
    setEpoch((current) => current + 1);
  }, [sessionId, restoredMessages]);

  const abortRef = useRef<AbortController | null>(null);
  const startTimeRef = useRef(0);
  const tokenCountRef = useRef(0);
  const firstTokenTimeRef = useRef(0);
  const streamBufferRef = useRef("");
  const flushTimerRef = useRef<NodeJS.Timeout | null>(null);
  const eventsRef = useRef<RuntimeEvent[]>([]);

  const flushStream = useCallback(() => {
    flushTimerRef.current = null;
    setCurrentStream(streamBufferRef.current);
  }, []);

  // Suppress stderr log lines.
  useEffect(() => {
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
      const str = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
      if (str.startsWith("{") && str.includes('"level"')) return true;
      return (orig as Function)(chunk, ...args);
    }) as typeof process.stderr.write;
    return () => { process.stderr.write = orig; };
  }, []);

  // Runtime events → ref (no rerender) + status (conditional rerender).
  useEffect(() => {
    const off = runtime.onAny((event) => {
      eventsRef.current = [...eventsRef.current.slice(-200), event];
      const s = statusFromEvent(event);
      if (s) setStatus(s);
    });
    return off;
  }, [runtime]);

  useEffect(() => { if (!isStreaming) setMetricsVersion((v) => v + 1); }, [isStreaming]);

  const metrics = useMemo(() => runtime.getMetrics(), [runtime, metricsVersion]);

  const statusFromEvent = (event: RuntimeEvent): RuntimeStatus | null => {
    switch (event.type) {
      case "intent:analyzed": return { stage: "negotiating", detail: "Analyzing required capabilities" };
      case "planner:plan": return { stage: "planning", detail: `${event.plan.missing.length} augmentation(s) needed` };
      case "execution_graph_created": return { stage: "executing", detail: `Graph: ${event.nodeCount} nodes` };
      case "capability:dispatch": return { stage: "capability", detail: `${event.capabilityType} via ${event.capabilityId}` };
      case "context:assembled": return { stage: "context", detail: "Preparing context" };
      case "provider:stream": return { stage: "generating", detail: `${event.providerId}/${event.model}` };
      case "provider:done": return { stage: "idle", detail: "" };
      case "request:end": return { stage: "idle", detail: "" };
      default: return null;
    }
  };

  const handleCommand = useCallback((cmd: string): boolean => {
    const c = cmd.startsWith("/") ? cmd.slice(1).trim().toLowerCase() : cmd.slice(1).trim().toLowerCase();
    // Handle commands with arguments (like /switch model-name).
    const cBase = c.split(/\s+/)[0] ?? c;
    switch (cBase) {
      case "exit": case "quit": exit(); return true;
      case "clear": {
        // Clear the terminal (including scrollback) and remount the Static
        // region, then drop all messages — Claude Code /clear behavior.
        process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
        setMessages([]);
        setEpoch((e) => e + 1);
        return true;
      }
      case "plan":
        setMode("plan");
        setMessages((p) => [...p, { role: "system", content: "Plan mode enabled. I will discuss the approach without changing files or running tools.", timestamp: Date.now() }]);
        return true;
      case "build":
        setMode("build");
        setMessages((p) => [...p, { role: "system", content: "Build mode enabled. I will execute tasks automatically within workspace permissions.", timestamp: Date.now() }]);
        return true;
      case "help": setMessages((p) => [...p, { role: "system", content: "Commands: /help /clear /models /providers /settings /doctor /config /new /exit", timestamp: Date.now() }]); return true;
      case "providers": { const l = runtime.providers.list().map((p) => `  ${p.id} — ${p.label}`).join("\n"); setMessages((p) => [...p, { role: "system", content: `Registered Providers:\n${l}`, timestamp: Date.now() }]); return true; }
      case "models": runtime.providers.listModels().then((m) => { const l = m.map((x) => `  ${x.providerId}/${x.id}`).join("\n"); setMessages((p) => [...p, { role: "system", content: `Available Models:\n${l}`, timestamp: Date.now() }]); }); return true;
      case "settings": setActivePanel("palette"); return true;
      case "doctor": runtime.health().then((h) => { const l = h.map((x) => `  ${x.providerId}: ${x.ok ? "OK" : "DOWN"}`).join("\n"); setMessages((p) => [...p, { role: "system", content: `Provider Health:\n${l}`, timestamp: Date.now() }]); }); return true;
      case "config": { const c = runtime.config; setMessages((p) => [...p, { role: "system", content: `Provider: ${c.defaultProviderId}\nModel: ${c.defaultModel}\nTools: ${runtime.toolRuntime.list().length}`, timestamp: Date.now() }]); return true; }
      case "capabilities": {
        const { collectManifests, formatManifestTable } = require("../tools/CapabilityManifest.js");
        const tools = runtime.toolRuntime.list().map((id: string) => {
          const cap = runtime.registry.get(id);
          return { id, capability: cap?.type ?? "filesystem", label: cap?.label ?? id };
        });
        const manifests = collectManifests(tools, runtime.config.sandbox);
        const table = formatManifestTable(manifests, process.cwd(), runtime.config.defaultProviderId, runtime.config.defaultModel);
        setMessages((p) => [...p, { role: "system", content: table, timestamp: Date.now() }]);
        return true;
      }
      case "health": {
        const { formatHealthTable } = require("../tools/CapabilityAvailabilityTracker.js");
        const { formatNetworkPolicy } = require("../tools/NetworkPolicy.js");
        const netLabel = formatNetworkPolicy(runtime.networkPolicy);
        const table = formatHealthTable(runtime.availability, netLabel);
        setMessages((p) => [...p, { role: "system", content: table, timestamp: Date.now() }]);
        return true;
      }
      case "logs": setActivePanel("logs"); return true;
      case "expand": {
        let lastIndex = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]!;
          if (message.role === "assistant" && message.content.includes("```")) {
            lastIndex = i;
            break;
          }
        }
        if (lastIndex < 0) {
          setMessages((p) => [...p, { role: "system", content: "No assistant response to expand yet.", timestamp: Date.now() }]);
          return true;
        }
        setMessages((current) => current.map((message, index) => index === lastIndex ? { ...message, expandCode: true } : message));
        return true;
      }
      case "graph": setActivePanel("graph"); return true;
      case "new": {
        // Create a fresh session in the same workspace and switch to it.
        const sm = runtime.workspace?.sessionManager;
        if (sm) {
          const rec = sm.create({ providerId: currentProviderId, modelId: currentModelId });
          void runtime.activateWorkspaceSession(rec.id).then((restored) => {
            if (restored) {
              onSwitchSession?.(restored.session.id);
              process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
              setMessages([]);
              setEpoch((e) => e + 1);
            }
          });
        } else {
          setMessages((p) => [...p, { role: "system", content: "Start a new session with `mindigenous`.", timestamp: Date.now() }]);
        }
        return true;
      }
      case "add-provider": {
        // /add-provider <id> <baseUrl> <apiKey> [model]
        const parts = cmd.split(/\s+/);
        if (parts.length < 4) {
          setMessages((p) => [...p, { role: "system", content: "Usage: /add-provider <id> <baseUrl> <apiKey> [model]\nExample: /add-provider openrouter https://openrouter.ai/api/v1 sk-or-v1-xxx meta-llama/llama-3.2-90b-vision-instruct", timestamp: Date.now() }]);
          return true;
        }
        const newId = parts[1]!;
        const newBaseUrl = parts[2]!;
        const newApiKey = parts[3]!;
        const defaultModel = parts[4] ?? "";
        try {
          const { loadProvidersFromConfig } = require("../providers/provider-loader.js");
          const { resolveProviderEntry } = require("../providers/provider-config.js");
          const entry = resolveProviderEntry(newId, {
            type: "openai-compatible",
            apiKey: newApiKey,
            baseUrl: newBaseUrl,
            displayName: newId,
            enabled: true,
          });
          const providers = loadProvidersFromConfig({ [newId]: entry });
          if (providers.length > 0) {
            const p = providers[0]!;
            runtime.providers.addProvider(p);
            // Save to .mindi/config.json
          const { loadConfig, saveConfig } = require("../cli/onboarding-config.js");
          const cfg = loadConfig() ?? require("../cli/onboarding-config.js").createEmptyConfig();
          cfg.providers[newId] = entry;
          saveConfig(cfg);
          // Switch to the new provider
          const mdl = defaultModel || "gpt-4o-mini";
          runtime.sessions.setModel(sessionId, newId, mdl);
          setCurrentProviderId(newId);
          setCurrentModelId(mdl);
          setMessages((p) => [...p, { role: "system", content: `Added and switched to ${newId}/${mdl}`, timestamp: Date.now() }]);
          } else {
            setMessages((p) => [...p, { role: "system", content: `Failed to create provider "${newId}"`, timestamp: Date.now() }]);
          }
        } catch (err) {
          setMessages((p) => [...p, { role: "system", content: `Error adding provider: ${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() }]);
        }
        return true;
      }
      case "switch":
      case "model": {
        const rawArg = cmd.split(/\s+/).slice(1).join(" ").trim();
        if (rawArg) {
          // 1. Try SESSION switch first: numeric index or session id prefix.
          const sm = runtime.workspace?.sessionManager;
          if (sm) {
            const sessions = sm.listSessions({ includeArchived: false });
            const asNum = Number(rawArg);
            const byNum = Number.isInteger(asNum) && asNum >= 1 && asNum <= sessions.length ? sessions[asNum - 1] : undefined;
            const byId = sessions.find((s) => s.id.startsWith(rawArg) || s.id === rawArg);
            const target = byNum ?? byId;
            if (target) {
              void runtime.activateWorkspaceSession(target.id).then((restored) => {
                if (restored) {
                  onSwitchSession?.(restored.session.id);
                  setCurrentProviderId(restored.effectiveProviderId);
                  setCurrentModelId(restored.effectiveModelId);
                  setMessages((p) => [...p, { role: "system", content: `Switched to session: ${restored.session.title}`, timestamp: Date.now() }]);
                }
              });
              return true;
            }
          }
          // 2. Otherwise treat as MODEL switch: /model provider/model or /model model
          let prov: string;
          let mdl: string;
          if (rawArg.includes("/")) {
            const parts = rawArg.split("/");
            prov = parts[0]!.trim().replace(/[<>]/g, "");
            mdl = parts[1]!.trim().replace(/[<>]/g, "");
          } else {
            prov = currentProviderId;
            mdl = rawArg.replace(/[<>]/g, "");
          }
          if (prov && mdl) {
            runtime.sessions.setModel(sessionId, prov, mdl);
            setCurrentProviderId(prov);
            setCurrentModelId(mdl);
            setMessages((p) => [...p, { role: "system", content: `Switched to ${prov}/${mdl}`, timestamp: Date.now() }]);
            return true;
          }
        }
        // No args — open the interactive model picker.
        setActivePanel("model-picker");
        return true;
      }
      case "setup": {
        setMessages((p) => [...p, { role: "system", content: "To add a new provider or reconfigure, exit and run `mindigenous` again.\nThe onboarding wizard will appear automatically if config is invalid.", timestamp: Date.now() }]);
        return true;
      }
      default: {
        // Fall through to the workspace slash commands (/sessions /new
        // /switch /resume /history /model /refresh-models /rename /archive
        // /delete /search /help). These are async — fire and update UI.
        void runtime.dispatchSlashCommand(cmd).then(async (res) => {
          if (!res.handled) {
            setMessages((p) => [...p, { role: "system", content: `Unknown command: ${cmd}`, timestamp: Date.now() }]);
            return;
          }
          if (res.clearScreen) {
            process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
            setMessages([]);
            setEpoch((e) => e + 1);
          }
          if (res.switchToSessionId) {
            // Mirror the target workspace session into the live runtime and switch.
            const restored = await runtime.activateWorkspaceSession(res.switchToSessionId);
            if (restored) {
              onSwitchSession?.(restored.session.id);
              setCurrentProviderId(restored.effectiveProviderId);
              setCurrentModelId(restored.effectiveModelId);
            }
          }
          if (res.message) {
            setMessages((p) => [...p, { role: "system", content: res.message!, timestamp: Date.now() }]);
          }
          if (res.exit) exit();
        });
        return true;
      }
    }
  }, [runtime, exit, onSwitchSession]);

  // ---- Live activity feed helpers -------------------------------------
  // Each backend step becomes a visible row with its own timing, so the user
  // always sees what the AI is doing (Claude Code style transparency).
  // A ref mirrors the state so we can synchronously snapshot on completion.
  const activityStartRef = useRef<Map<string, number>>(new Map());
  const activitiesRef = useRef<ActivityItem[]>([]);

  const setActs = useCallback((updater: (prev: ActivityItem[]) => ActivityItem[]) => {
    activitiesRef.current = updater(activitiesRef.current);
    setActivities(activitiesRef.current);
  }, []);

  const startActivity = useCallback((item: Omit<ActivityItem, "status">) => {
    activityStartRef.current.set(item.id, Date.now());
    setActs((prev) => [...prev, { ...item, status: "running" }]);
  }, [setActs]);

  const finishActivity = useCallback((id: string, ok = true, detail?: string) => {
    const start = activityStartRef.current.get(id);
    const durationMs = start !== undefined ? Date.now() - start : undefined;
    activityStartRef.current.delete(id);
    setActs((prev) =>
      prev.map((a) => (a.id === id ? { ...a, status: ok ? "done" : "failed", durationMs, ...(detail ? { detail } : {}) } : a)),
    );
  }, [setActs]);

  const executePrompt = useCallback(async (text: string, attach: Attachment[]) => {
    setHistory((p) => [...p, text]); setHistoryIdx(-1);
    setMessages((p) => [...p, { role: "user", content: text, attachments: attach.length > 0 ? attach : undefined, timestamp: Date.now() }]);
    setIsStreaming(true); setStatus({ stage: "thinking", detail: "Processing..." });
    setCurrentStream("");
    activitiesRef.current = []; setActivities([]); activityStartRef.current.clear();
    startTimeRef.current = Date.now(); streamBufferRef.current = ""; tokenCountRef.current = 0; firstTokenTimeRef.current = 0;
    const ctrl = new AbortController(); abortRef.current = ctrl;
    try {
      let st = "";
      for await (const ev of runtime.request({ sessionId, text, mode, signal: ctrl.signal, modelId: currentModelId, attachments: attach.length > 0 ? attach.map((a) => ({ name: a.name, mimeType: a.mimeType, data: a.data })) : undefined })) {
        switch (ev.type) {
          case "intent":
            startActivity({ id: "intent", icon: "✻", label: "Analyzed intent", detail: ev.summary.slice(0, 50) });
            finishActivity("intent", true);
            break;
          case "plan": {
            const detail = ev.missing.length > 0
              ? `augmenting: ${ev.missing.join(", ")}`
              : ev.unavailable.length > 0
                ? `unavailable: ${ev.unavailable.map((u) => u.type).join(", ")}`
                : "all native";
            startActivity({ id: "plan", icon: "⚡", label: "Planned capabilities", detail });
            finishActivity("plan", true);
            break;
          }
          case "capability": {
            const id = `cap-${ev.capabilityType}`;
            startActivity({ id, icon: "🔧", label: String(ev.capabilityType), detail: `via ${ev.source}` });
            // Mark done with the real measured duration from the runtime.
            setActs((prev) => prev.map((a) => (a.id === id ? { ...a, status: ev.ok ? "done" : "failed", durationMs: ev.durationMs } : a)));
            activityStartRef.current.delete(id);
            break;
          }
          case "attachment": {
            setStatus({ stage: "context", detail: "Vision processing" });
            // Show that an image was embedded into the request — the user can
            // verify the image actually made it to the model.
            const sizeKb = Math.round(ev.sizeBytes / 1024);
            const sizeLabel = sizeKb >= 1024 ? `${(sizeKb / 1024).toFixed(1)} MB` : `${sizeKb} KB`;
            startActivity({ id: "attach", icon: "📎", label: `Attached ${ev.count} image${ev.count > 1 ? "s" : ""}`, detail: sizeLabel });
            finishActivity("attach", true);
            break;
          }
          // ---- Agentic lifecycle events ----------------------------------
          case "task": {
            setStatus({ stage: "planning", detail: ev.taskType });
            startActivity({ id: "task", icon: "🎯", label: `Task: ${ev.taskType}`, detail: ev.chain.join(" → ") });
            finishActivity("task", true);
            break;
          }
          case "tool": {
            setStatus({ stage: "capability", detail: ev.name === "fs.write" || ev.name === "fs.mkdir" ? "Writing files" : `Running ${ev.name}` });
            const id = `agent-tool-${ev.name}-${Date.now()}`;
            if (ev.phase === "finished") {
              startActivity({ id, icon: "🔧", label: ev.name, detail: ev.preview });
              setActs((prev) => prev.map((a) => (a.id === id ? { ...a, status: ev.ok ? "done" : "failed", durationMs: ev.durationMs } : a)));
              activityStartRef.current.delete(id);
            } else {
              startActivity({ id, icon: "🔧", label: ev.name, detail: ev.phase });
            }
            break;
          }
          case "file": {
            setStatus({ stage: "capability", detail: `Writing ${ev.path}` });
            const id = `file-${ev.path}`;
            startActivity({ id, icon: "📄", label: "Wrote file", detail: `${ev.path} (${ev.bytes} bytes)` });
            finishActivity(id, ev.verified, ev.verified ? "✓ verified" : "⚠ unverified");
            break;
          }
          case "reflection": {
            setStatus({ stage: "thinking", detail: ev.note });
            // Keep only the latest reflection row visible — update in place.
            const id = "reflection";
            setActs((prev) => {
              const others = prev.filter((a) => a.id !== id);
              return [...others, { id, icon: "🧠", label: ev.note, status: "done" as const }];
            });
            break;
          }
          case "goal": {
            setStatus({ stage: "generating", detail: ev.status === "completed" ? "Success" : "Recovering" });
            startActivity({ id: "goal", icon: ev.status === "completed" ? "🏁" : "⚠️", label: ev.status === "completed" ? "Goal completed" : "Goal failed", detail: ev.reason });
            finishActivity("goal", ev.status === "completed");
            break;
          }
          case "delta": st += ev.text; streamBufferRef.current = st; tokenCountRef.current += Math.ceil(ev.text.length / 4);
            if (firstTokenTimeRef.current === 0) firstTokenTimeRef.current = Date.now();
            if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flushStream, 150); break;
          case "done": if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
            setCurrentStream(st);
            if (st.trim()) {
              // Snapshot synchronously — React 19 defers state updaters until
              // render, by which time the finally block has cleared the ref.
              const activitySnapshot = [...activitiesRef.current];
              setMessages((p) => [...p, { role: "assistant", content: st, timestamp: Date.now(), durationMs: Date.now() - startTimeRef.current, modelId: currentModelId, activities: activitySnapshot }]);
            }
            setCurrentStream(""); break;
          case "error": if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
            if (st.trim()) {
              const activitySnapshot = [...activitiesRef.current];
              setMessages((p) => [...p, { role: "assistant", content: st, timestamp: Date.now(), durationMs: Date.now() - startTimeRef.current, modelId: currentModelId, activities: activitySnapshot }]);
            }
            setMessages((p) => [...p, { role: "system", content: `Error: ${ev.code} — ${ev.message}${errorHint(ev.code)}`, timestamp: Date.now() }]);
            setCurrentStream(""); break;
        }
      }
    } catch (err) { setMessages((p) => [...p, { role: "system", content: `Request failed: ${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() }]); }
    finally { if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
      setIsStreaming(false); setStatus({ stage: "idle", detail: "" }); abortRef.current = null;
      activitiesRef.current = []; setActivities([]); activityStartRef.current.clear(); }
  }, [runtime, sessionId, currentModelId, mode, flushStream, startActivity, finishActivity, setActs]);

  // Process queue.
  useEffect(() => {
    if (isStreaming || queue.length === 0) return;
    const [next, ...rest] = queue; setQueue(rest); setQueueNavIdx(-1);
    if (next) executePrompt(next.text, next.attachments);
  }, [isStreaming, queue, executePrompt]);

  const submitInput = useCallback((text: string) => {
    if (!text.trim()) return;
    if (text.startsWith("/")) { if (!handleCommand(text)) setMessages((p) => [...p, { role: "system", content: `Unknown command: ${text}`, timestamp: Date.now() }]); return; }
    const att = attachments; setAttachments([]);
    if (isStreaming) { setQueue((p) => [...p, { text, attachments: att }]); setInput(""); setQueueNavIdx(-1); }
    else { executePrompt(text, att); setInput(""); }
  }, [isStreaming, attachments, handleCommand, executePrompt]);

  // Slash command list + filtering.
  const SLASH_COMMANDS = [
    { cmd: "/build", desc: "Execute tasks and edit files automatically" },
    { cmd: "/plan", desc: "Discuss only; never run tools or edit files" },
    { cmd: "/help", desc: "Show available commands" },
    { cmd: "/add-provider", desc: "Add a new provider (id url key [model])" },
    { cmd: "/switch", desc: "Switch provider/model or session" },
    { cmd: "/model", desc: "Show current model capabilities" },
    { cmd: "/refresh-models", desc: "Refresh model metadata & rebuild capability registry" },
    { cmd: "/sessions", desc: "List all conversations in this workspace" },
    { cmd: "/new", desc: "Start a fresh conversation" },
    { cmd: "/resume", desc: "Resume the most recent session" },
    { cmd: "/history", desc: "Session history with providers and models" },
    { cmd: "/rename", desc: "Rename the current session" },
    { cmd: "/archive", desc: "Archive the current session" },
    { cmd: "/delete", desc: "Delete a session" },
    { cmd: "/search", desc: "Search previous conversations" },
    { cmd: "/expand", desc: "Print the last response's full code" },
    { cmd: "/models", desc: "List available models" },
    { cmd: "/capabilities", desc: "Show tool capabilities & permissions" },
    { cmd: "/health", desc: "Show runtime health status" },
    { cmd: "/clear", desc: "Clear conversation" },
    { cmd: "/providers", desc: "List registered providers" },
    { cmd: "/settings", desc: "Open settings" },
    { cmd: "/doctor", desc: "Health check providers" },
    { cmd: "/config", desc: "Show configuration" },
    { cmd: "/setup", desc: "Reconfigure / add new provider" },
    { cmd: "/exit", desc: "Quit MINDIGENOUS" },
  ];

  const isSlashMode = input.startsWith("/") && !input.includes(" ");
  const filteredCmds = isSlashMode
    ? SLASH_COMMANDS.filter((c) => c.cmd.startsWith(input))
    : [];

  // SINGLE useInput.
  useInput((ch, key) => {
    // Panels own the keyboard while mounted. This must run before every
    // prompt handler: previously the early return below swallowed Tab/Escape,
    // leaving Inspector open forever and allowing competing Ink renders.
    if (activePanel !== "none") {
      if (activePanel === "model-picker") return;
      if (closesPanel(activePanel, key, ch)) {
        setActivePanel("none");
      }
      return;
    }
    if (key.tab && key.shift && !isStreaming) {
      setMode((current) => current === "build" ? "plan" : "build");
      return;
    }
    if (key.ctrl) {
      if (ch === "c") { if (abortRef.current) { abortRef.current.abort(); if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; } setCurrentStream(streamBufferRef.current); } setIsStreaming(false); setStatus({ stage: "idle", detail: "" }); return; }
      if (ch === "d") { exit(); return; } return;
    }
    // ---- Escape: interrupt OR close panels OR exit slash mode ----
    if (key.escape) {
      if (isStreaming) {
        if (abortRef.current) { abortRef.current.abort(); if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; } setCurrentStream(streamBufferRef.current); }
        setIsStreaming(false); setStatus({ stage: "idle", detail: "" });
      } else if (isSlashMode) {
        setInput(""); setSlashCmdIdx(-1);
      } else {
        setActivePanel("none");
      }
      return;
    }
    if (key.tab) {
      if (!isStreaming) setActivePanel("inspector");
      return;
    }

    // ---- Slash command autocomplete mode ----
    if (isSlashMode && filteredCmds.length > 0) {
      // Up/Down navigate through filtered commands.
      if (key.upArrow) {
        const ni = slashCmdIdx < 0 ? filteredCmds.length - 1 : Math.max(0, slashCmdIdx - 1);
        setSlashCmdIdx(ni);
        return;
      }
      if (key.downArrow) {
        if (slashCmdIdx < 0) { setSlashCmdIdx(0); return; }
        const ni = slashCmdIdx + 1;
        if (ni >= filteredCmds.length) { setSlashCmdIdx(-1); }
        else { setSlashCmdIdx(ni); }
        return;
      }
      // Right arrow or Tab or Enter selects the highlighted command.
      if (key.rightArrow || key.tab) {
        if (slashCmdIdx >= 0 && filteredCmds[slashCmdIdx]) {
          setInput(filteredCmds[slashCmdIdx]!.cmd + " ");
          setSlashCmdIdx(-1);
        }
        return;
      }
      if (key.return) {
        if (slashCmdIdx >= 0 && filteredCmds[slashCmdIdx]) {
          const cmd = filteredCmds[slashCmdIdx]!.cmd;
          setSlashCmdIdx(-1);
          if (!isStreaming) { submitInput(cmd); setInput(""); }
        } else if (input.trim()) {
          setSlashCmdIdx(-1);
          if (!isStreaming) { submitInput(input); setInput(""); }
        }
        return;
      }
      // Regular typing within slash mode — update filter, reset selection.
      if (key.backspace || key.delete) { setInput((v) => v.slice(0, -1)); setSlashCmdIdx(-1); return; }
      if (ch && !key.ctrl && !key.meta && ch.length > 0 && ch.charCodeAt(0) >= 32) {
        setInput((v) => v + ch); setSlashCmdIdx(-1);
      }
      return;
    }

    // ---- Normal mode (not slash autocomplete) ----
    if (isStreaming) {
      if (key.upArrow) { if (queue.length === 0) return; const ni = queueNavIdx < 0 ? queue.length - 1 : Math.max(0, queueNavIdx - 1); if (queue[ni]) { setQueueNavIdx(ni); setInput(queue[ni]!.text); setAttachments(queue[ni]!.attachments); } return; }
      if (key.downArrow) { if (queueNavIdx < 0) return; const ni = queueNavIdx + 1; if (ni >= queue.length) { setQueueNavIdx(-1); setInput(""); setAttachments([]); } else { setQueueNavIdx(ni); setInput(queue[ni]?.text ?? ""); setAttachments(queue[ni]?.attachments ?? []); } return; }
    } else {
      if (key.upArrow) { if (history.length > 0) { const ni = historyIdx < 0 ? history.length - 1 : Math.max(0, historyIdx - 1); setHistoryIdx(ni); setInput(history[ni] ?? ""); } return; }
      if (key.downArrow) { if (history.length > 0) { const ni = Math.min(history.length, historyIdx + 1); if (ni >= history.length) { setHistoryIdx(-1); setInput(""); } else { setHistoryIdx(ni); setInput(history[ni] ?? ""); } } return; }
    }

    if (key.return) {
      if (isStreaming && queueNavIdx >= 0) { if (input.trim()) { const ut = input, ua = attachments; setQueue((p) => p.map((item, i) => i === queueNavIdx ? { text: ut, attachments: ua } : item)); } else { setQueue((p) => p.filter((_, i) => i !== queueNavIdx)); }
        setInput(""); setAttachments([]); const nl = queue.length - (input.trim() ? 0 : 1); setQueueNavIdx(nl > 0 ? Math.min(queueNavIdx, nl - 1) : -1); return; }
      if (input.trim()) { submitInput(input); } return;
    }
    if (key.backspace || key.delete) { setInput((v) => v.slice(0, -1)); return; }
    if (ch && !key.ctrl && !key.meta && !key.escape && ch.length > 0 && ch.charCodeAt(0) >= 32) { setInput((v) => v + ch); }
  });

  const queueHasItems = queue.length > 0;

  return (
    <Box flexDirection="column">
      {/*
        Static region: completed messages. Each is rendered ONCE and never
        re-rendered (Ink <Static>) — the same architecture Claude Code uses.
        History scrolls naturally in the terminal's native scrollback, and
        token flushes only redraw the small live region below. This is the
        primary fix for flicker/ghosting during generation.
      */}
      <Static items={messages} key={epoch}>
        {(msg, i) => (
          <Box key={i} paddingX={1}>
            <MessageView message={msg} />
          </Box>
        )}
      </Static>

      {/* Live region — only this part re-renders while streaming. */}
      <MemoHeader providerId={currentProviderId} modelId={currentModelId} sessionId={sessionId} workspace={workspace} metrics={metrics} />

      {/* Live backend activity feed — what the AI is doing right now. */}
      {isStreaming && activities.length > 0 && (
        <Box marginTop={1} paddingX={1}>
          <MemoActivityFeed items={activities} showSpinner={true} />
        </Box>
      )}

      {/* Live streaming text — re-renders on flush (150ms batches). */}
      {isStreaming && currentStream && (
        <Box paddingX={1}>
          <StreamingMessage modelId={currentModelId} text={currentStream} />
        </Box>
      )}

      {/* Single self-contained status row (spinner + stage + elapsed/ETA). */}
      {isStreaming && (
        <Box paddingX={1}>
          <StatusLine
            stage={status.stage}
            detail={status.detail}
            startTime={startTimeRef.current}
            tokenCountRef={tokenCountRef}
            firstTokenTimeRef={firstTokenTimeRef}
          />
        </Box>
      )}

      {queueHasItems && (
        <Box flexDirection="column" marginTop={0}>
          <Text color={COLORS.sky}> {"  "}📋 {queue.length} prompt(s) queued{isStreaming ? " — waiting" : " — processing..."}</Text>
          {queue.map((q, i) => (
            <Text key={i} color={i === queueNavIdx ? COLORS.azure : COLORS.dim} wrap="truncate">
              {"  "}{i === queueNavIdx ? "❯" : " "} [{i + 1}] {q.text.slice(0, 80)}{q.text.length > 80 ? "..." : ""}
            </Text>
          ))}
        </Box>
      )}

      {/* Fixed prompt */}
      <MemoPromptInput
        value={input}
        isStreaming={isStreaming}
        attachments={attachments}
        mode={mode}
        slashCommands={isSlashMode ? filteredCmds : undefined}
        slashSelectedIdx={slashCmdIdx}
      />

      {/* Panels (conditionally mounted) */}
      {activePanel === "inspector" && <MemoInspector runtime={runtime} events={eventsRef.current} onClose={() => setActivePanel("none")} />}
      {activePanel === "logs" && <MemoLogsPanel events={eventsRef.current} onClose={() => setActivePanel("none")} />}
      {activePanel === "graph" && <MemoGraphPanel runtime={runtime} events={eventsRef.current} onClose={() => setActivePanel("none")} />}
      {activePanel === "palette" && <MemoCommandPalette onCommand={handleCommand} onClose={() => setActivePanel("none")} />}
      {activePanel === "model-picker" && (
        <ModelPicker
          runtime={runtime}
          sessionId={sessionId}
          currentProviderId={currentProviderId}
          currentModelId={currentModelId}
          onSwitch={(prov, mdl) => {
            runtime.sessions.setModel(sessionId, prov, mdl);
            setCurrentProviderId(prov);
            setCurrentModelId(mdl);
            setMessages((p) => [...p, { role: "system", content: `Switched to ${prov}/${mdl}`, timestamp: Date.now() }]);
          }}
          onClose={() => setActivePanel("none")}
        />
      )}
    </Box>
  );
}

/** Actionable hint appended to provider errors so users know what to do next. */
function errorHint(code: string): string {
  switch (code) {
    case "E_PROVIDER_RATE_LIMIT":
      return "\nHint: rate-limited by the provider. Free-tier models have strict per-minute and daily caps — wait a bit, or /switch to another model.";
    case "E_PROVIDER_AUTH":
      return "\nHint: the API key was rejected. Check it with /add-provider or by re-running setup.";
    case "E_PROVIDER_UNAVAILABLE":
      return "\nHint: the provider is unreachable or down. Check your network, or /switch to another provider.";
    case "E_PROVIDER_TIMEOUT":
      return "\nHint: the request timed out. The provider may be overloaded — try again.";
    default:
      return "";
  }
}
