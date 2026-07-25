/**
 * Boot sequence — shows runtime initialization progress.
 *
 * Displays a compact list of initialization steps with check marks
 * as each completes, then transitions into the main terminal.
 */

import React, { useState, useEffect } from "react";
import { Text, Box } from "ink";

interface BootStep {
  label: string;
  status: "pending" | "running" | "done";
}

const BOOT_STEPS: BootStep[] = [
  { label: "Configuration", status: "pending" },
  { label: "Providers", status: "pending" },
  { label: "Capability Registry", status: "pending" },
  { label: "Tool SDK", status: "pending" },
  { label: "Sessions", status: "pending" },
  { label: "Event Bus", status: "pending" },
  { label: "Runtime", status: "pending" },
];

const STEP_DURATION = 120; // ms per step

export function BootSequence({ onDone }: { onDone: () => void }): React.ReactElement {
  const [steps, setSteps] = useState<BootStep[]>(BOOT_STEPS);
  const [currentStep, setCurrentStep] = useState(0);

  useEffect(() => {
    if (currentStep >= BOOT_STEPS.length) {
      const t = setTimeout(onDone, 200);
      return () => clearTimeout(t);
    }

    // Mark current step as running.
    setSteps((prev) => prev.map((s, i) => i === currentStep ? { ...s, status: "running" } : s));

    const t = setTimeout(() => {
      setSteps((prev) => prev.map((s, i) => i === currentStep ? { ...s, status: "done" } : s));
      setCurrentStep((n) => n + 1);
    }, STEP_DURATION);

    return () => clearTimeout(t);
  }, [currentStep, onDone]);

  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" paddingY={1}>
      <Box flexDirection="column">
        {steps.map((step, i) => (
          <Box key={i} gap={1}>
            <Text>
              {step.status === "done" ? "✓" : step.status === "running" ? "◉" : "○"}
            </Text>
            <Text
              color={step.status === "done" ? "green" : step.status === "running" ? "cyan" : "gray"}
            >
              {step.label}
            </Text>
            {step.status === "running" && (
              <Text color="cyan">...</Text>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
