/** Runtime Inspector panel (Tab) — timeline, negotiation, providers, tools, metrics. */

import React from "react";
import { Box, Text } from "ink";
import type { Runtime, RuntimeEvent } from "../../index.js";

interface InspectorProps {
  runtime: Runtime;
  events: RuntimeEvent[];
  onClose: () => void;
}

export function Inspector({ runtime, events, onClose: _onClose }: InspectorProps): React.ReactElement {
  const metrics = runtime.getMetrics();
  const recentEvents = events.slice(-15);

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">Runtime Inspector</Text>
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column">
          <Text color="gray">─ Metrics ────────</Text>
          <Text>Requests: <Text color="white">{metrics.requests.total}</Text> (✓{metrics.requests.succeeded} ✗{metrics.requests.failed})</Text>
          <Text>Capabilities: <Text color="white">{metrics.capabilities.total}</Text> (✓{metrics.capabilities.succeeded} ✗{metrics.capabilities.failed})</Text>
          <Text>Graphs: <Text color="white">{metrics.graph.total}</Text> (✓{metrics.graph.succeeded} ✗{metrics.graph.failed})</Text>
          <Text>Retries: <Text color="yellow">{metrics.retries}</Text></Text>
          <Text>Tokens: <Text color="white">{metrics.tokensUsed.toLocaleString()}</Text></Text>
          <Text>Cache: <Text color="green">{metrics.cacheHits}</Text> hit / <Text color="red">{metrics.cacheMisses}</Text> miss</Text>
        </Box>
        <Box flexDirection="column">
          <Text color="gray">─ Latency ────────</Text>
          <Text>Avg request: <Text color="white">{metrics.requests.avgLatencyMs}ms</Text></Text>
          <Text>P50: <Text color="white">{metrics.requests.p50LatencyMs}ms</Text></Text>
          <Text>P99: <Text color="white">{metrics.requests.p99LatencyMs}ms</Text></Text>
          <Text>Avg cap: <Text color="white">{metrics.capabilities.avgLatencyMs}ms</Text></Text>
          <Text>Avg graph: <Text color="white">{metrics.graph.avgDurationMs}ms</Text></Text>
        </Box>
      </Box>
      <Text color="gray">─ Event Timeline ────</Text>
      {recentEvents.map((ev, i) => (
        <Text key={i} color={eventColor(ev.type)}>
          {eventIcon(ev.type)} {ev.type}
        </Text>
      ))}
      {recentEvents.length === 0 && <Text color="gray">No events yet.</Text>}
    </Box>
  );
}

function eventColor(type: string): string {
  if (type.includes("error") || type.includes("failed")) return "red";
  if (type.includes("success") || type.includes("completed")) return "green";
  if (type.includes("start") || type.includes("dispatch")) return "cyan";
  if (type.includes("provider")) return "blue";
  return "gray";
}

function eventIcon(type: string): string {
  if (type.includes("error") || type.includes("failed")) return "✗";
  if (type.includes("success") || type.includes("completed")) return "✓";
  if (type.includes("start")) return "▶";
  return "·";
}
