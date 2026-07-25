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
import { Box, Text, useInput, useApp } from "ink";
import type { Runtime, RuntimeEvent } from "../index.js";
import { LayoutProvider } from "./layout/LayoutEngine.js";
import { Header } from "./components/Header.js";
import { PromptInput } from "./components/PromptInput.js";
import { Conversation } from "./components/Conversation.js";
import { StatusIndicator } from "./components/StatusIndicator.js";
import { Inspector } from "./panels/Inspector.js";
import { LogsPanel } from "./panels/LogsPanel.js";
import { GraphPanel } from "./panels/GraphPanel.js";
import { CommandPalette } from "./panels/CommandPalette.js";
import { COLORS } from "./colors.js";
import type { Message, Attachment, RuntimeStatus } from "./types.js";

export interface TerminalProps {
  runtime: Runtime;
  sessionId: string;
  providerId: string;
  modelId: string;
  workspace: string;
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
    prev.slashCommands === next.slashCommands &&
    prev.slashSelectedIdx === next.slashSelectedIdx;
});
const MemoConversation = React.memo(Conversation);
const MemoStatusIndicator = React.memo(StatusIndicator);
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

function TerminalInner({ runtime, sessionId, providerId, modelId, workspace }: TerminalProps): React.ReactElement {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState<RuntimeStatus>({ stage: "idle", detail: "" });
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [activePanel, setActivePanel] = useState<"none" | "inspector" | "logs" | "graph" | "palette">("none");
  const [currentStream, setCurrentStream] = useState<string>("");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [etaMs, setEtaMs] = useState(0);
  const [metricsVersion, setMetricsVersion] = useState(0);
  const [queue, setQueue] = useState<QueuedPrompt[]>([]);
  const [queueNavIdx, setQueueNavIdx] = useState(-1);
  const [slashCmdIdx, setSlashCmdIdx] = useState(-1); // -1 = no selection, 0..N = highlighted command

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

  // ETA timer — 500ms, only during streaming.
  useEffect(() => {
    if (!isStreaming) return;
    const timer = setInterval(() => {
      setElapsedMs(Date.now() - startTimeRef.current);
      const t = tokenCountRef.current;
      if (t > 5) {
        const rate = (Date.now() - firstTokenTimeRef.current) / t;
        setEtaMs(Math.round(Math.max(0, Math.max(t * 2, 500) - t) * rate));
      }
    }, 500);
    return () => clearInterval(timer);
  }, [isStreaming]);

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
    switch (c) {
      case "exit": case "quit": exit(); return true;
      case "clear": setMessages([]); return true;
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
      case "graph": setActivePanel("graph"); return true;
      case "new": setMessages((p) => [...p, { role: "system", content: "Start a new session with `mindigenous`.", timestamp: Date.now() }]); return true;
      case "switch": {
        // Check if args were provided: /switch provider/model
        const parts = c.split(/\s+/);
        if (parts.length > 1 && parts[1]!.includes("/")) {
          const [prov, mdl] = parts[1]!.split("/");
          if (prov && mdl) {
            // Switch the session's provider/model.
            runtime.sessions.setModel(sessionId, prov, mdl);
            setMessages((p) => [...p, { role: "system", content: `Switched to ${prov}/${mdl}`, timestamp: Date.now() }]);
            return true;
          }
        }
        // No args — list available models.
        runtime.providers.listModels().then((m) => {
          const current = `Current: ${providerId}/${modelId}`;
          const l = m.map((x) => `  ${x.providerId}/${x.id}${x.providerId === providerId && x.id === modelId ? " ← active" : ""}`).join("\n");
          setMessages((p) => [...p, { role: "system", content: `${current}\n\nAvailable Models:\n${l}\n\nUse: /switch <provider>/<model> to switch.`, timestamp: Date.now() }]);
        });
        return true;
      }
      case "setup": {
        setMessages((p) => [...p, { role: "system", content: "To add a new provider or reconfigure, exit and run `mindigenous` again.\nThe onboarding wizard will appear automatically if config is invalid.", timestamp: Date.now() }]);
        return true;
      }
      default: return false;
    }
  }, [runtime, exit]);

  const executePrompt = useCallback(async (text: string, attach: Attachment[]) => {
    setHistory((p) => [...p, text]); setHistoryIdx(-1);
    setMessages((p) => [...p, { role: "user", content: text, attachments: attach.length > 0 ? attach : undefined, timestamp: Date.now() }]);
    setIsStreaming(true); setStatus({ stage: "thinking", detail: "Processing..." });
    setCurrentStream(""); setElapsedMs(0); setEtaMs(0);
    startTimeRef.current = Date.now(); streamBufferRef.current = ""; tokenCountRef.current = 0; firstTokenTimeRef.current = 0;
    const ctrl = new AbortController(); abortRef.current = ctrl;
    try {
      let st = "";
      for await (const ev of runtime.request({ sessionId, text, signal: ctrl.signal, attachments: attach.length > 0 ? attach.map((a) => ({ name: a.name, mimeType: a.mimeType, data: a.data })) : undefined })) {
        switch (ev.type) {
          case "delta": st += ev.text; streamBufferRef.current = st; tokenCountRef.current += Math.ceil(ev.text.length / 4);
            if (firstTokenTimeRef.current === 0) firstTokenTimeRef.current = Date.now();
            if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flushStream, 150); break;
          case "capability": setStatus({ stage: "capability", detail: `${ev.capabilityType} ${ev.ok ? "done" : "failed"}` }); break;
          case "done": if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
            setCurrentStream(st); if (st.trim()) setMessages((p) => [...p, { role: "assistant", content: st, timestamp: Date.now(), durationMs: Date.now() - startTimeRef.current, modelId }]);
            setCurrentStream(""); break;
          case "error": if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
            if (st.trim()) setMessages((p) => [...p, { role: "assistant", content: st, timestamp: Date.now(), durationMs: Date.now() - startTimeRef.current, modelId }]);
            setMessages((p) => [...p, { role: "system", content: `Error: ${ev.code} — ${ev.message}`, timestamp: Date.now() }]);
            setCurrentStream(""); break;
        }
      }
    } catch (err) { setMessages((p) => [...p, { role: "system", content: `Request failed: ${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() }]); }
    finally { if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
      setIsStreaming(false); setStatus({ stage: "idle", detail: "" }); setElapsedMs(0); setEtaMs(0); abortRef.current = null; }
  }, [runtime, sessionId, modelId, flushStream]);

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
    { cmd: "/help", desc: "Show available commands" },
    { cmd: "/capabilities", desc: "Show tool capabilities & permissions" },
    { cmd: "/health", desc: "Show runtime health status" },
    { cmd: "/clear", desc: "Clear conversation" },
    { cmd: "/models", desc: "List available models" },
    { cmd: "/switch", desc: "Switch provider/model" },
    { cmd: "/providers", desc: "List registered providers" },
    { cmd: "/settings", desc: "Open settings" },
    { cmd: "/doctor", desc: "Health check providers" },
    { cmd: "/config", desc: "Show configuration" },
    { cmd: "/sessions", desc: "List active sessions" },
    { cmd: "/setup", desc: "Reconfigure / add new provider" },
    { cmd: "/new", desc: "Start new session" },
    { cmd: "/exit", desc: "Quit MINDIGENOUS" },
  ];

  const isSlashMode = input.startsWith("/") && !input.includes(" ");
  const filteredCmds = isSlashMode
    ? SLASH_COMMANDS.filter((c) => c.cmd.startsWith(input))
    : [];

  // SINGLE useInput.
  useInput((ch, key) => {
    if (activePanel === "palette") { if (key.escape || key.return) setActivePanel("none"); return; }
    if (activePanel !== "none") return;
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
    if (key.tab) { setActivePanel((p) => p === "inspector" ? "none" : "inspector"); return; }

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
    <Box flexDirection="column" height="100%">
      {/* Fixed header */}
      <MemoHeader providerId={providerId} modelId={modelId} sessionId={sessionId} workspace={workspace} metrics={metrics} />

      {/* Scrollable conversation viewport */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        <MemoConversation messages={messages} currentStream={currentStream} isStreaming={isStreaming} modelId={modelId} elapsedMs={elapsedMs} etaMs={etaMs} />
        {isStreaming && <MemoStatusIndicator stage={status.stage} detail={status.detail} />}
        {isStreaming && elapsedMs > 0 && <Text color={COLORS.timer}> {"  "}{formatMs(elapsedMs)}{etaMs > 1000 ? ` ~${formatMs(etaMs)} left` : ""}</Text>}
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
      </Box>

      {/* Fixed prompt */}
      <MemoPromptInput
        value={input}
        isStreaming={isStreaming}
        attachments={attachments}
        slashCommands={isSlashMode ? filteredCmds : undefined}
        slashSelectedIdx={slashCmdIdx}
      />

      {/* Panels (conditionally mounted) */}
      {activePanel === "inspector" && <MemoInspector runtime={runtime} events={eventsRef.current} onClose={() => setActivePanel("none")} />}
      {activePanel === "logs" && <MemoLogsPanel events={eventsRef.current} onClose={() => setActivePanel("none")} />}
      {activePanel === "graph" && <MemoGraphPanel runtime={runtime} events={eventsRef.current} onClose={() => setActivePanel("none")} />}
      {activePanel === "palette" && <MemoCommandPalette onCommand={handleCommand} onClose={() => setActivePanel("none")} />}
    </Box>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60); const rs = Math.round(s % 60);
  return `${m}m${rs}s`;
}
