/**
 * Workspace trust prompt — shown on first launch in a new directory.
 *
 * Like Claude Code's "Accessing workspace" flow.
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import fs from "node:fs";
import path from "node:path";
import { COLORS } from "./colors.js";

interface WorkspaceTrustProps {
  workspace: string;
  onTrust: () => void;
}

export function WorkspaceTrust({ workspace, onTrust }: WorkspaceTrustProps): React.ReactElement {
  const { exit } = useApp();
  const [selected, setSelected] = useState(0);
  const trusted = isWorkspaceTrusted(workspace);

  // If already trusted, call onTrust AFTER render via useEffect.
  useEffect(() => {
    if (trusted) {
      onTrust();
    }
  }, [trusted, onTrust]);

  useInput((_input, key) => {
    if (trusted) return;
    if (key.upArrow || key.downArrow) {
      setSelected((s) => (s === 0 ? 1 : 0));
      return;
    }
    if (key.return) {
      if (selected === 0) {
        trustWorkspace(workspace);
        onTrust();
      } else {
        exit();
      }
      return;
    }
    if (key.escape) {
      exit();
      return;
    }
  });

  if (trusted) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center">
        <Text color={COLORS.dim}>  Loading workspace...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingY={1}>
      <Text color={COLORS.azure} bold>{"─".repeat(60)}</Text>
      <Box marginTop={1}>
        <Text color={COLORS.sky} bold>  Accessing workspace:</Text>
      </Box>
      <Box marginTop={0}>
        <Text color={COLORS.white}>  {workspace}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={COLORS.dim}>  Quick safety check: Is this a project you created or one you trust?</Text>
        <Text color={COLORS.dim}>  MINDIGENOUS will be able to read, edit, and execute files here.</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={selected === 0 ? COLORS.sky : COLORS.dim}>
          {selected === 0 ? "❯" : " "} 1. Yes, I trust this folder
        </Text>
        <Text color={selected === 1 ? COLORS.sky : COLORS.dim}>
          {selected === 1 ? "❯" : " "} 2. No, exit
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={COLORS.dim}>  Enter to confirm · Esc to cancel</Text>
      </Box>
    </Box>
  );
}

function isWorkspaceTrusted(workspace: string): boolean {
  try {
    return fs.existsSync(path.join(workspace, ".mindi", "trusted"));
  } catch {
    return false;
  }
}

function trustWorkspace(workspace: string): void {
  try {
    const dir = path.join(workspace, ".mindi");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(dir, "trusted"), new Date().toISOString(), "utf8");
  } catch {
    // Non-fatal.
  }
}
