/** Execution graph panel (Ctrl+G) — visualizes the runtime DAG. */

import React from "react";
import { Box, Text } from "ink";
import type { Runtime, RuntimeEvent } from "../../index.js";

interface GraphPanelProps {
  runtime: Runtime;
  events: RuntimeEvent[];
  onClose: () => void;
}

export function GraphPanel({ runtime: _runtime, events, onClose: _onClose }: GraphPanelProps): React.ReactElement {
  const graphEvents = events.filter((e) =>
    e.type.startsWith("execution_") || e.type.startsWith("node_") || e.type.startsWith("graph_")
  );

  const nodes = graphEvents.filter((e) => e.type === "node_started");
  const completed = graphEvents.filter((e) => e.type === "node_completed");
  const graphInfo = graphEvents.find((e) => e.type === "execution_graph_created");

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">Execution Graph</Text>
      {graphInfo && (
        <Text color="gray">Graph {graphInfo.graphId.slice(0, 8)} — {graphInfo.nodeCount} nodes</Text>
      )}
      <Box flexDirection="column" marginY={0}>
        {nodes.map((ev, i) => {
          const nodeEv = ev as Extract<RuntimeEvent, { type: "node_started" }>;
          const isDone = completed.some((c) => {
            const cEv = c as Extract<RuntimeEvent, { type: "node_completed" }>;
            return cEv.nodeId === nodeEv.nodeId;
          });
          return (
            <Text key={i}>
              <Text color={isDone ? "green" : "magenta"}>{isDone ? "✓" : "▶"}</Text>{" "}
              <Text color="cyan">{nodeEv.capability}</Text>{" "}
              <Text color="gray">{nodeEv.nodeId}</Text>
            </Text>
          );
        })}
        {nodes.length === 0 && <Text color="gray">No graph events yet. Run a request that triggers augmentation.</Text>}
      </Box>
      {graphEvents.find((e) => e.type === "graph_completed") && (
        <Text color="gray">
          {(() => {
            const gc = graphEvents.find((e) => e.type === "graph_completed") as Extract<RuntimeEvent, { type: "graph_completed" }>;
            return `Completed: ${gc.completedNodes} ok, ${gc.failedNodes} failed, ${gc.durationMs}ms`;
          })()}
        </Text>
      )}
    </Box>
  );
}
