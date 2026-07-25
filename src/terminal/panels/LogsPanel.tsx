/** Live logs panel (Ctrl+L) — color-coded runtime event stream. */

import React from "react";
import { Box, Text } from "ink";
import type { RuntimeEvent } from "../../index.js";

interface LogsPanelProps {
  events: RuntimeEvent[];
  onClose: () => void;
}

export function LogsPanel({ events, onClose: _onClose }: LogsPanelProps): React.ReactElement {
  const recent = events.slice(-30);
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="blue" paddingX={1}>
      <Text bold color="blue">Runtime Logs (live)</Text>
      <Box flexDirection="column">
        {recent.map((ev, i) => {
          const ts = new Date(ev.timestamp).toISOString().slice(11, 23);
          const color = eventColor(ev.type);
          return (
            <Text key={i} wrap="truncate">
              <Text color="gray">{ts} </Text>
              <Text color={color}>{eventIcon(ev.type)} </Text>
              <Text bold color={color}>{ev.type.padEnd(26)}</Text>
              <Text> {eventDetail(ev)}</Text>
            </Text>
          );
        })}
        {recent.length === 0 && <Text color="gray">No events.</Text>}
      </Box>
    </Box>
  );
}

function eventColor(type: string): string {
  if (type.includes("error") || type.includes("failed")) return "red";
  if (type.includes("success") || type.includes("completed")) return "green";
  if (type.includes("start")) return "cyan";
  if (type.includes("provider")) return "blue";
  if (type.includes("capability") || type.includes("node")) return "magenta";
  return "gray";
}

function eventIcon(type: string): string {
  if (type.includes("error") || type.includes("failed")) return "✗";
  if (type.includes("success") || type.includes("completed")) return "✓";
  if (type.includes("start") || type.includes("dispatch")) return "▶";
  return "·";
}

function eventDetail(ev: RuntimeEvent): string {
  switch (ev.type) {
    case "request:start": return `${ev.model} "${ev.input.slice(0, 40)}"`;
    case "request:end": return `${ev.ok ? "OK" : "FAIL"} ${ev.durationMs}ms`;
    case "capability:dispatch": return `${ev.capabilityType} → ${ev.executor}:${ev.capabilityId}`;
    case "capability:success": return `${ev.durationMs}ms ${ev.capabilityId}`;
    case "capability:error": return `${ev.capabilityId}: ${ev.error}`;
    case "provider:stream": return `${ev.providerId}/${ev.model}`;
    case "provider:chunk": return `"${ev.delta.slice(0, 30)}"`;
    case "provider:done": return `finish=${ev.finishReason}`;
    case "node_started": return `${ev.capability} (${ev.nodeId})`;
    case "node_completed": return `${ev.ok ? "OK" : "FAIL"} ${ev.durationMs}ms`;
    case "graph_completed": return `${ev.ok ? "OK" : "FAIL"} ${ev.durationMs}ms`;
    default: return "";
  }
}
