/**
 * Renderer Registry — plugin-style event renderers.
 *
 * Each RuntimeEvent type has a dedicated renderer component.
 * Adding a new capability = define event type + register renderer.
 * The registry auto-selects the correct renderer based on event type.
 *
 * The Runtime never knows how events are displayed.
 */

import React, { memo } from "react";
import { Box, Text } from "ink";
import { COLORS } from "../colors.js";
import { useLayout, wrapText } from "../layout/LayoutEngine.js";
import type { RuntimeEvent2 } from "./RuntimeEvents.js";
import { statusIcon, statusColor, eventIcon } from "./RuntimeEvents.js";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export type EventRenderer = (event: RuntimeEvent2) => React.ReactElement;

const registry = new Map<string, EventRenderer>();

export function registerRenderer(eventType: string, renderer: EventRenderer): void {
  registry.set(eventType, renderer);
}

export function renderEvent(event: RuntimeEvent2): React.ReactElement {
  const renderer = registry.get(event.type);
  if (renderer) return renderer(event);
  return <DefaultRenderer key={event.meta.id} event={event} />;
}

// ---------------------------------------------------------------------------
// Default renderer (fallback)
// ---------------------------------------------------------------------------

const DefaultRenderer = memo(function DefaultRenderer({ event }: { event: RuntimeEvent2 }): React.ReactElement {
  const { regions } = useLayout();
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={statusColor(event.meta.status)}>{statusIcon(event.meta.status)}</Text>
      <Text color={COLORS.dim}>{eventIcon(event.type)}</Text>
      <Text color={COLORS.white} wrap="truncate">{wrapText(event.type, regions.contentWidth - 4)}</Text>
      {event.meta.durationMs > 0 && <Text color={COLORS.dim}>{event.meta.durationMs}ms</Text>}
    </Box>
  );
}, (prev, next) => prev.event === next.event);

// ---------------------------------------------------------------------------
// Built-in renderers
// ---------------------------------------------------------------------------

// --- User Message ---
registerRenderer("user_message", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "user_message" }>;
  return (
    <Box flexDirection="column" marginTop={0}>
      <Text color={COLORS.user} bold wrap="truncate">{"› "}{e.content}</Text>
    </Box>
  );
});

// --- Planning ---
registerRenderer("planning", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "planning" }>;
  return (
    <Box flexDirection="column" marginTop={0}>
      <Box flexDirection="row" gap={1}>
        <Text color={statusColor(e.meta.status)}>{statusIcon(e.meta.status)}</Text>
        <Text color={COLORS.azure} bold>Planning</Text>
        {e.meta.durationMs > 0 && <Text color={COLORS.dim}>{e.meta.durationMs}ms</Text>}
      </Box>
      {e.steps.map((step, i) => (
        <Text key={i} color={i === e.currentStep ? COLORS.sky : COLORS.dim}>
          {"  "}{i < (e.currentStep ?? 0) ? "✓" : i === e.currentStep ? "◉" : "○"} {step}
        </Text>
      ))}
    </Box>
  );
});

// --- Thinking ---
registerRenderer("thinking", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "thinking" }>;
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={statusColor(e.meta.status)}>{statusIcon(e.meta.status)}</Text>
      <Text color={COLORS.ice}>{e.summary}</Text>
    </Box>
  );
});

// --- Chat Response ---
registerRenderer("chat_response", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "chat_response" }>;
  return (
    <Box flexDirection="column" marginTop={0}>
      <Box flexDirection="row" gap={1}>
        <Text color={COLORS.assistant} bold>{e.meta.model || "assistant"}</Text>
        {e.meta.durationMs > 0 && <Text color={COLORS.dim}>{(e.meta.durationMs / 1000).toFixed(1)}s</Text>}
        {e.tokens && <Text color={COLORS.dim}>{e.tokens} tokens</Text>}
        {e.isStreaming && <Text color={COLORS.sky}> streaming...</Text>}
      </Box>
      <Text wrap="truncate">{e.content}</Text>
    </Box>
  );
});

// --- Tool Started ---
registerRenderer("tool_started", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "tool_started" }>;
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={COLORS.sky}>{statusIcon("running")}</Text>
      <Text color={COLORS.ice}>🔧 {e.toolName}</Text>
      <Text color={COLORS.dim}>{e.description}</Text>
    </Box>
  );
});

// --- Tool Finished ---
registerRenderer("tool_finished", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "tool_finished" }>;
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={e.success ? COLORS.assistant : "#ef4444"}>{statusIcon(e.success ? "completed" : "failed")}</Text>
      <Text color={COLORS.ice}>🔧 {e.toolName}</Text>
      <Text color={COLORS.dim}>{e.summary}</Text>
      {e.meta.durationMs > 0 && <Text color={COLORS.dim}>{e.meta.durationMs}ms</Text>}
    </Box>
  );
});

// --- Bash Command ---
registerRenderer("bash_command", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "bash_command" }>;
  return (
    <Box flexDirection="column" marginY={0} borderStyle="single" borderColor={COLORS.border} paddingX={1}>
      <Box flexDirection="row" gap={1}>
        <Text color={e.isRunning ? COLORS.sky : (e.exitCode === 0 ? COLORS.assistant : "#ef4444")}>
          {e.isRunning ? "◉" : statusIcon(e.exitCode === 0 ? "completed" : "failed")}
        </Text>
        <Text color={COLORS.azure} bold>$ {e.command}</Text>
      </Box>
      <Text color={COLORS.dim}>  cwd: {e.cwd}</Text>
      {e.stdout && <Text color={COLORS.white} wrap="truncate">  {e.stdout.split("\n").slice(0, 5).join("\n  ")}</Text>}
      {e.stderr && <Text color="#ef4444" wrap="truncate">  {e.stderr.split("\n").slice(0, 3).join("\n  ")}</Text>}
      {!e.isRunning && e.exitCode !== undefined && <Text color={COLORS.dim}>  exit: {e.exitCode}</Text>}
    </Box>
  );
});

// --- File Modified (Diff) ---
registerRenderer("file_modified", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "file_modified" }>;
  return (
    <Box flexDirection="column" marginY={0}>
      <Box flexDirection="row" gap={1}>
        <Text color={COLORS.assistant}>✓</Text>
        <Text color={COLORS.sky} bold>✏️ {e.filePath}</Text>
        <Text color={COLORS.assistant}>+{e.linesAdded}</Text>
        <Text color="#ef4444">-{e.linesRemoved}</Text>
      </Box>
      {e.diff && (
        <Box flexDirection="column" marginLeft={2}>
          {e.diff.split("\n").slice(0, 15).map((line, i) => (
            <Text key={i} color={line.startsWith("+") ? COLORS.assistant : line.startsWith("-") ? "#ef4444" : COLORS.dim} wrap="truncate">
              {"  "}{line}
            </Text>
          ))}
          {e.diff.split("\n").length > 15 && <Text color={COLORS.dim}>  ... {e.diff.split("\n").length - 15} more lines</Text>}
        </Box>
      )}
    </Box>
  );
});

// --- File Created ---
registerRenderer("file_created", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "file_created" }>;
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={COLORS.assistant}>✓</Text>
      <Text color={COLORS.sky} bold>📄 {e.filePath}</Text>
      {e.lines && <Text color={COLORS.dim}>{e.lines} lines</Text>}
    </Box>
  );
});

// --- File Deleted ---
registerRenderer("file_deleted", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "file_deleted" }>;
  return (
    <Box flexDirection="row" gap={1}>
      <Text color="#ef4444">✗</Text>
      <Text color="#ef4444">🗑 {e.filePath}</Text>
    </Box>
  );
});

// --- Git Changes ---
registerRenderer("git_changes", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "git_changes" }>;
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={COLORS.assistant}>🌿</Text>
      <Text color={COLORS.sky} bold>{e.branch}</Text>
      <Text color={COLORS.dim}>{e.filesChanged} files</Text>
      <Text color={COLORS.assistant}>+{e.insertions}</Text>
      <Text color="#ef4444">-{e.deletions}</Text>
    </Box>
  );
});

// --- Web Search ---
registerRenderer("web_search", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "web_search" }>;
  return (
    <Box flexDirection="column" marginY={0}>
      <Box flexDirection="row" gap={1}>
        <Text color={COLORS.sky}>🔍</Text>
        <Text color={COLORS.azure} bold>{e.query}</Text>
        {e.meta.durationMs > 0 && <Text color={COLORS.dim}>{e.meta.durationMs}ms</Text>}
      </Box>
      {e.results.slice(0, 5).map((r, i) => (
        <Box key={i} flexDirection="column" marginLeft={2}>
          <Text color={COLORS.sky} wrap="truncate">{i + 1}. {r.title}</Text>
          <Text color={COLORS.dim} wrap="truncate">   {r.url}</Text>
          <Text color={COLORS.dim} wrap="truncate">   {r.snippet.slice(0, 80)}</Text>
        </Box>
      ))}
      {e.results.length > 5 && <Text color={COLORS.dim}>  ... {e.results.length - 5} more results</Text>}
    </Box>
  );
});

// --- HTTP Request ---
registerRenderer("http_request", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "http_request" }>;
  return (
    <Box flexDirection="column" marginY={0}>
      <Box flexDirection="row" gap={1}>
        <Text color={e.statusCode && e.statusCode < 400 ? COLORS.assistant : "#ef4444"}>
          {statusIcon(e.statusCode && e.statusCode < 400 ? "completed" : "failed")}
        </Text>
        <Text color={COLORS.azure} bold>{e.method}</Text>
        <Text color={COLORS.white} wrap="truncate">{e.url}</Text>
        {e.statusCode && <Text color={COLORS.dim}>{e.statusCode}</Text>}
      </Box>
    </Box>
  );
});

// --- Progress Update ---
registerRenderer("progress_update", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "progress_update" }>;
  const bar = "█".repeat(Math.floor(e.percent * 10)) + "░".repeat(10 - Math.floor(e.percent * 10));
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color={COLORS.sky}>{bar}</Text>
        <Text color={COLORS.dim}>{Math.round(e.percent * 100)}%</Text>
        <Text color={COLORS.azure}>{e.phase}</Text>
      </Box>
      <Text color={COLORS.dim}> {e.tasksRunning} running · {e.tasksWaiting} waiting · {e.tasksCompleted} completed</Text>
    </Box>
  );
});

// --- Warning ---
registerRenderer("warning", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "warning" }>;
  return (
    <Box flexDirection="row" gap={1}>
      <Text color="#f59e0b">⚠</Text>
      <Text color="#f59e0b">{e.message}</Text>
    </Box>
  );
});

// --- Error ---
registerRenderer("error", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "error" }>;
  return (
    <Box flexDirection="column" marginY={0}>
      <Box flexDirection="row" gap={1}>
        <Text color="#ef4444">✗</Text>
        <Text color="#ef4444" bold>{e.code}</Text>
        <Text color="#ef4444" wrap="truncate">{e.message}</Text>
      </Box>
      {e.details && <Text color={COLORS.dim} wrap="truncate">  {e.details}</Text>}
    </Box>
  );
});

// --- Success ---
registerRenderer("success", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "success" }>;
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={COLORS.assistant}>✓</Text>
      <Text color={COLORS.assistant}>{e.message}</Text>
    </Box>
  );
});

// --- Completion ---
registerRenderer("completion", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "completion" }>;
  return (
    <Box flexDirection="column" marginY={0}>
      <Text color={COLORS.border}>{"─".repeat(40)}</Text>
      <Box flexDirection="row" gap={1}>
        <Text color={COLORS.assistant}>🏁</Text>
        <Text color={COLORS.assistant} bold>{e.summary}</Text>
      </Box>
      <Text color={COLORS.dim}> {(e.totalDurationMs / 1000).toFixed(1)}s · {e.tokensUsed} tokens · {e.toolsExecuted} tools</Text>
    </Box>
  );
});

// --- Intent Analyzed ---
registerRenderer("intent_analyzed", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "intent_analyzed" }>;
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={COLORS.ice}>🧠</Text>
      <Text color={COLORS.dim}>{e.summary}</Text>
      <Text color={COLORS.dim}>[{e.capabilities.join(", ")}]</Text>
    </Box>
  );
});

// --- Capability Plan ---
registerRenderer("capability_plan", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "capability_plan" }>;
  return (
    <Box flexDirection="column" marginY={0}>
      {e.satisfied.length > 0 && <Text color={COLORS.assistant}>  ✓ Satisfied: [{e.satisfied.join(", ")}]</Text>}
      {e.missing.length > 0 && <Text color={COLORS.sky}>  ⚡ Augmenting: [{e.missing.join(", ")}]</Text>}
      {e.unavailable.length > 0 && <Text color="#ef4444">  ✗ Unavailable: [{e.unavailable.map((u) => u.type).join(", ")}]</Text>}
    </Box>
  );
});

// --- Capability Dispatch ---
registerRenderer("capability_dispatch", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "capability_dispatch" }>;
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={COLORS.sky}>⚡</Text>
      <Text color={COLORS.ice}>{e.capability}</Text>
      <Text color={COLORS.dim}>via {e.executor}</Text>
    </Box>
  );
});

// --- Database Query ---
registerRenderer("database_query", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "database_query" }>;
  return (
    <Box flexDirection="column" marginY={0}>
      <Box flexDirection="row" gap={1}>
        <Text color={COLORS.assistant}>✓</Text>
        <Text color={COLORS.ice}>🗄 {e.database}</Text>
        {e.rowsAffected !== undefined && <Text color={COLORS.dim}>{e.rowsAffected} rows</Text>}
      </Box>
      <Text color={COLORS.dim} wrap="truncate">  {e.query.slice(0, 80)}</Text>
    </Box>
  );
});

// --- Image Generation ---
registerRenderer("image_generation", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "image_generation" }>;
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={COLORS.assistant}>✓</Text>
      <Text color={COLORS.ice}>🎨 {e.model}</Text>
      <Text color={COLORS.dim} wrap="truncate">{e.prompt.slice(0, 60)}</Text>
    </Box>
  );
});

// --- OCR ---
registerRenderer("ocr", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "ocr" }>;
  return (
    <Box flexDirection="column" marginY={0}>
      <Box flexDirection="row" gap={1}>
        <Text color={COLORS.assistant}>✓</Text>
        <Text color={COLORS.ice}>📝 OCR</Text>
        {e.confidence !== undefined && <Text color={COLORS.dim}>{Math.round(e.confidence)}% confidence</Text>}
      </Box>
      <Text color={COLORS.dim} wrap="truncate">  {e.text.slice(0, 80)}</Text>
    </Box>
  );
});

// --- Memory Access ---
registerRenderer("memory_access", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "memory_access" }>;
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={COLORS.assistant}>✓</Text>
      <Text color={COLORS.ice}>🧠 Memory {e.operation}</Text>
      <Text color={COLORS.dim}>{e.entries} entries</Text>
    </Box>
  );
});

// --- Browser Automation ---
registerRenderer("browser_automation", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "browser_automation" }>;
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={COLORS.assistant}>✓</Text>
      <Text color={COLORS.ice}>🖱 {e.action}</Text>
      {e.url && <Text color={COLORS.dim} wrap="truncate">{e.url}</Text>}
    </Box>
  );
});

// --- Permission Checked ---
registerRenderer("permission_checked", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "permission_checked" }>;
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={e.allowed ? COLORS.assistant : "#ef4444"}>{e.allowed ? "✓" : "✗"}</Text>
      <Text color={COLORS.dim}>🔐 {e.tool}.{e.operation}</Text>
      <Text color={COLORS.dim}>{e.reason}</Text>
    </Box>
  );
});

// --- Permission Denied ---
registerRenderer("permission_denied", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "permission_denied" }>;
  return (
    <Box flexDirection="column" marginY={0}>
      <Box flexDirection="row" gap={1}>
        <Text color="#ef4444">🚫</Text>
        <Text color="#ef4444" bold>{e.tool}.{e.operation} denied</Text>
      </Box>
      <Text color={COLORS.dim} wrap="truncate">  {e.reason}</Text>
      {e.alternative && <Text color={COLORS.dim} wrap="truncate">  {e.alternative}</Text>}
    </Box>
  );
});

// --- Tool Unavailable ---
registerRenderer("tool_unavailable", (event) => {
  const e = event as Extract<RuntimeEvent2, { type: "tool_unavailable" }>;
  return (
    <Box flexDirection="row" gap={1}>
      <Text color="#f59e0b">⚠</Text>
      <Text color="#f59e0b">{e.tool}</Text>
      <Text color={COLORS.dim}>{e.reason}</Text>
    </Box>
  );
});
