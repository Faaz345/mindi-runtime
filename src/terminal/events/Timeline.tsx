/**
 * Execution Timeline — chronological event display.
 *
 * Features:
 *   - Virtualized rendering (only visible events render)
 *   - Collapse/expand long outputs
 *   - Colored icons + status indicators
 *   - Smooth appearance without flickering
 *   - Stable React keys
 */

import React, { useState, useMemo, memo } from "react";
import { Box } from "ink";
import { useLayout } from "../layout/LayoutEngine.js";
import { renderEvent } from "./RendererRegistry.js";
import type { RuntimeEvent2 } from "./RuntimeEvents.js";

interface TimelineProps {
  events: RuntimeEvent2[];
  maxWidth: number;
}

export const Timeline = memo(function Timeline({ events, maxWidth }: TimelineProps): React.ReactElement {
  const { regions } = useLayout();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Virtualization: only render events that fit in the viewport.
  const visibleEvents = useMemo(() => {
    const viewportHeight = regions.conversationHeight;
    // Simple approach: render last N events that fit.
    // Start from the end (most recent) and work backward.
    const result: RuntimeEvent2[] = [];
    let estimatedHeight = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      // Estimate height per event (1-3 lines depending on type).
      const estHeight = estimateEventHeight(event);
      if (estimatedHeight + estHeight > viewportHeight && result.length > 0) break;
      result.unshift(event);
      estimatedHeight += estHeight;
    }
    return result;
  }, [events, regions.conversationHeight]);

  return (
    <Box flexDirection="column" gap={0}>
      {visibleEvents.map((event) => (
        <TimelineEntry
          key={event.meta.id}
          event={event}
          expanded={expandedIds.has(event.meta.id)}
          onToggle={() => {
            setExpandedIds((prev) => {
              const next = new Set(prev);
              if (next.has(event.meta.id)) next.delete(event.meta.id);
              else next.add(event.meta.id);
              return next;
            });
          }}
          maxWidth={maxWidth}
        />
      ))}
    </Box>
  );
}, (prev, next) => prev.events === next.events && prev.maxWidth === next.maxWidth);

const TimelineEntry = memo(function TimelineEntry({
  event,
}: {
  event: RuntimeEvent2;
  expanded: boolean;
  onToggle: () => void;
  maxWidth: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      {renderEvent(event)}
    </Box>
  );
}, (prev, next) => prev.event === next.event && prev.expanded === next.expanded);

function estimateEventHeight(event: RuntimeEvent2): number {
  switch (event.type) {
    case "chat_response": return Math.max(2, Math.ceil(event.content.length / 80) + 1);
    case "bash_command": return 3 + (event.stdout?.split("\n").length ?? 0);
    case "file_modified": return 2 + (event.diff?.split("\n").length ?? 0);
    case "web_search": return 2 + event.results.length;
    case "planning": return 1 + event.steps.length;
    default: return 1;
  }
}
