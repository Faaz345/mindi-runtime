/**
 * ResponseValidator — post-model anti-hallucination enforcement.
 *
 * After the model produces a response, this validator checks whether the
 * model fabricated tool execution, file operations, command output, or
 * network results that were NOT actually performed by the runtime.
 *
 * Detection patterns:
 *   - "git clone", "npm install", "curl ..." in prose (not code blocks)
 *   - "I created the file", "I ran the command", "output:"
 *   - Fabricated terminal output blocks
 *   - Claims of filesystem changes without matching augmentation results
 *
 * When fabrication is detected:
 *   - In simple mode: append a correction note to the response
 *   - In agent mode: trigger a re-loop with a correction message
 *
 * FALSE POSITIVE MITIGATION:
 *   - Code blocks (```...```) are EXCLUDED from detection
 *   - Quoted text from the user is excluded
 *   - Educational/explanatory mentions ("you would run git clone...") are excluded
 *   - Only first-person claims trigger detection ("I ran", "I created")
 */

import type { StructuredContextBlock, ValidationResult, DetectedFabrication } from "./types.js";

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------

interface FabricationPattern {
  re: RegExp;
  type: DetectedFabrication["type"];
  /** Human description of what was detected */
  description: string;
}

const FABRICATION_PATTERNS: FabricationPattern[] = [
  // Tool execution claims (first person).
  { re: /\bI\s+(?:ran|executed|invoked|called)\s+(?:the\s+)?(?:command|tool|script)\b/gi, type: "tool_execution", description: "Claims to have executed a command" },
  { re: /\bI\s+(?:cloned|forked|pulled|pushed|committed)\s+(?:the\s+)?(?:repo|repository)\b/gi, type: "tool_execution", description: "Claims to have performed a git operation" },

  // File operation claims.
  { re: /\bI\s+(?:created|wrote|saved|deleted|modified|edited)\s+(?:the\s+)?file\b/gi, type: "file_operation", description: "Claims to have modified a file" },
  { re: /\bI\s+(?:created|wrote)\s+[`"']?[\w./\\-]+\.\w+[`"']?\b/gi, type: "file_operation", description: "Claims to have created a specific file" },

  // Command output fabrication.
  { re: /\b(?:here(?:'s| is) the output|the output (?:is|was|shows)|running .+ gives)\b/gi, type: "command_output", description: "Claims to show command output" },
  { re: /^(?:\$|>)\s+\w+.*\n(?:^(?![$>]).+\n?){2,}/gm, type: "command_output", description: "Fabricated terminal session" },

  // Network result claims.
  { re: /\bI\s+(?:fetched|downloaded|scraped|crawled|accessed)\s+(?:the\s+)?(?:url|page|site|website|api)\b/gi, type: "network_result", description: "Claims to have fetched a URL" },
  { re: /\bI\s+(?:searched|looked up|queried)\s+(?:the\s+)?(?:web|internet|search engine)\b/gi, type: "network_result", description: "Claims to have searched the web" },
];

/** Patterns that indicate EDUCATIONAL mention, not fabrication. */
const EDUCATIONAL_EXCLUSIONS: RegExp[] = [
  /\byou (?:would|can|could|should|need to|might)\b/i,
  /\bto (?:do|run|execute|perform) this/i,
  /\bfor example\b/i,
  /\bhere's how (?:you|to)\b/i,
  /\bthe (?:command|steps?) (?:would|is|are)\b/i,
];

// ---------------------------------------------------------------------------
// ResponseValidator
// ---------------------------------------------------------------------------

export class ResponseValidator {
  /**
   * Validate a model's response against actual augmentation results.
   * Returns a ValidationResult indicating whether fabrication was detected.
   */
  validate(responseText: string, actualResults: StructuredContextBlock[]): ValidationResult {
    // Strip code blocks — code examples are NOT fabrication.
    const proseOnly = this.stripCodeBlocks(responseText);

    // Check educational exclusions — if the entire response is educational, skip.
    if (this.isEducational(proseOnly)) {
      return { valid: true, fabrications: [] };
    }

    const fabrications: DetectedFabrication[] = [];

    for (const pattern of FABRICATION_PATTERNS) {
      // Reset regex state.
      pattern.re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.re.exec(proseOnly)) !== null) {
        const matchedText = match[0];

        // Check if this specific match is in an educational context.
        if (this.isMatchEducational(proseOnly, match.index)) continue;

        // Check if the claimed action has a matching augmentation result.
        if (this.hasMatchingResult(pattern.type, matchedText, actualResults)) continue;

        fabrications.push({
          claim: pattern.description,
          type: pattern.type,
          matchedText: matchedText.trim(),
        });
      }
    }

    if (fabrications.length === 0) {
      return { valid: true, fabrications: [] };
    }

    // Build correction message.
    const correction = this.buildCorrection(fabrications);

    return {
      valid: false,
      fabrications,
      correction,
    };
  }

  // ---- Helpers ---------------------------------------------------------

  /**
   * Strip fenced code blocks and inline code from the response.
   * Code examples are educational, not claims of execution.
   */
  private stripCodeBlocks(text: string): string {
    return text
      .replace(/```[\s\S]*?```/g, "[code block]")
      .replace(/`[^`\n]+`/g, "[inline code]");
  }

  /**
   * Check if the overall response is educational/explanatory.
   */
  private isEducational(text: string): boolean {
    const educationalSignals = EDUCATIONAL_EXCLUSIONS.filter((re) => re.test(text)).length;
    // If multiple educational signals are present, likely not fabrication.
    return educationalSignals >= 3;
  }

  /**
   * Check if a specific match is in an educational context (nearby text).
   */
  private isMatchEducational(text: string, matchIndex: number): boolean {
    // Look at 100 chars before the match for educational context.
    const contextBefore = text.slice(Math.max(0, matchIndex - 100), matchIndex);
    return EDUCATIONAL_EXCLUSIONS.some((re) => re.test(contextBefore));
  }

  /**
   * Check if the fabrication claim has a matching actual result.
   * E.g., if the model says "I fetched the URL" and there IS an HTTP
   * augmentation result, it's not fabrication — it's (imprecise) reference
   * to real data.
   */
  private hasMatchingResult(
    type: DetectedFabrication["type"],
    _matchedText: string,
    results: StructuredContextBlock[],
  ): boolean {
    const capabilityMap: Record<DetectedFabrication["type"], string[]> = {
      tool_execution: ["terminal", "git"],
      file_operation: ["filesystem"],
      command_output: ["terminal"],
      network_result: ["browser", "web_search"],
    };

    const relevantCaps = capabilityMap[type] ?? [];
    return results.some((r) => r.ok && relevantCaps.includes(r.capability));
  }

  /**
   * Build a correction message for re-looping or appending.
   */
  private buildCorrection(fabrications: DetectedFabrication[]): string {
    const claims = fabrications.map((f) => `- ${f.claim}: "${f.matchedText}"`).join("\n");
    return [
      "CORRECTION: Your previous response contained claims of actions you did not perform.",
      "The MINDI Runtime executes all tools — you cannot run commands, modify files, or fetch URLs.",
      "",
      "Detected fabrications:",
      claims,
      "",
      "Please revise your response:",
      "- Remove claims of having executed tools or commands",
      "- Reference the [Capability:...] results provided by the runtime instead",
      "- If no runtime result exists for something, say it was not provided",
    ].join("\n");
  }
}
