/**
 * TaskPlanner — SEMANTIC, goal-based planner.
 *
 * Replaces keyword-only intent detection for task routing. The IntentAnalyzer
 * answers "what capabilities might this text mention?"; the TaskPlanner
 * answers "what is the user trying to ACCOMPLISH, and what execution chain
 * does that goal require?"
 *
 * Rules are multi-signal (goal verbs + artifact nouns + attachments + save
 * intent), and every classification carries a human-readable `reasoning`
 * string — printed in logs and shown in the UI so the planner's decision is
 * never a black box.
 *
 * Multi-step goals are NEVER classified as "native": if the goal requires
 * tools (vision analysis, filesystem writes, git, search, terminal), the
 * task is agentic and the AgentOrchestrator drives it end-to-end.
 */

import type { CapabilityType } from "../core/types.js";
import { CapabilityType as Cap } from "../core/types.js";
import type { ModelCapabilityProfile } from "../capability/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskType =
  | "recreate-from-image"   // image → vision → generate → save artifact
  | "web-research"          // search → fetch → extract → summarize
  | "repo-analysis"         // clone → read → analyze → explain
  | "fix-tests"             // run tests → read code → edit → re-run
  | "code-modification"     // read files → edit → verify
  | "scaffold"              // create project/files → verify
  | "artifact-save"         // generate content → write file → verify
  | "simple";               // plain chat — no tool chain required

export interface TaskPlan {
  /** "agentic" = multi-step execution via the AgentOrchestrator. */
  kind: "agentic" | "simple";
  taskType: TaskType;
  /** Ordered capability chain the goal requires (semantic, not keyword). */
  chain: CapabilityType[];
  /** Human-readable explanation of WHY this classification was made. */
  reasoning: string;
  /** Goal summary used in prompts/status. */
  goal: string;
}

export interface TaskSignals {
  text: string;
  /** Image attachments or image paths detected in the text. */
  hasImages: boolean;
  /** Attachment names/mime hints. */
  attachments?: Array<{ name?: string; mimeType?: string }>;
  /** Current model profile (to note vision-native vs augmented in reasoning). */
  modelProfile?: ModelCapabilityProfile;
}

// ---------------------------------------------------------------------------
// Multi-signal rule set
// ---------------------------------------------------------------------------

const CREATE_VERB = /\b(create|generate|build|make|recreate|replicate|clone|design|develop|produce|write|scaffold)\b/i;
const ARTIFACT_NOUN = /\b(website|web\s?page|webpage|page|html|landing\s?page|site|ui|interface|dashboard|component|app|application)\b/i;
const FILE_NOUN = /\b(file|html|css|javascript|js|typescript|ts|json|yaml|yml|config|markdown|md|xml|sql|py|python)\b/i;
const SAVE_INTENT = /\b(save|write|store|persist|download|export|output|put|place|create)\b.{0,40}\b(file|path|folder|directory|disk|html)\b/i;
const PATH_GIVEN = /[A-Za-z]:[\\\/]|\/[\w.-]+\/|\.\/[\w.-]+/i;
const IMAGE_HINT = /\b(image|picture|photo|screenshot|reference|refrence|attached|upload)\b/i;
const RESEARCH = /\b(search|google|look\s?up|latest|news|recent|current|research|find out|what('?s| is) happening|today)\b/i;
const REPO = /\b(clone|git\s+clone|repository|repo|github\.com|gitlab\.com)\b/i;
const EXPLAIN = /\b(explain|describe|analyze|analyse|review|understand|architecture|walk\s?through|summarize)\b/i;
const FIX = /\b(fix|repair|debug|solve|resolve|failing|broken|error|bug)\b/i;
const TEST_WORD = /\b(test|tests|spec|suite|ci|build|lint)\b/i;
const MODIFY = /\b(add|modify|update|refactor|change|edit|implement|improve|rename|remove|delete)\b/i;
const CODE_TARGET = /\b(function|class|component|feature|file|code|method|api|endpoint|test|bug)\b/i;
const SCAFFOLD = /\b(new|create|scaffold|bootstrap|init|initialize|setup|set up)\b.{0,30}\b(project|app|application|package|module|library|service|api|website)\b/i;

// ---------------------------------------------------------------------------
// TaskPlanner
// ---------------------------------------------------------------------------

export class TaskPlanner {
  /**
   * Classify the user's goal into an execution plan.
   * Conservative: only goals that clearly need multi-step tool execution
   * become agentic — everything else stays simple chat.
   */
  classify(signals: TaskSignals): TaskPlan {
    const { text, hasImages } = signals;
    const goal = summarize(text);

    // ---- 1. Recreate / generate an artifact FROM an image ----------------
    if (hasImages && CREATE_VERB.test(text) && (ARTIFACT_NOUN.test(text) || FILE_NOUN.test(text) || IMAGE_HINT.test(text))) {
      return {
        kind: "agentic",
        taskType: "recreate-from-image",
        chain: [Cap.Vision, Cap.Filesystem],
        goal,
        reasoning: `Image input + creation verb + artifact target detected. Chain: vision analysis → layout/content extraction → code generation → filesystem write → artifact verification. Never native: the artifact must be produced as a file, not chat text.`,
      };
    }

    // ---- 2. Repository clone + analysis ----------------------------------
    if ((REPO.test(text) && (EXPLAIN.test(text) || CREATE_VERB.test(text))) || /github\.com\/[\w.-]+\/[\w.-]+/i.test(text)) {
      return {
        kind: "agentic",
        taskType: "repo-analysis",
        chain: [Cap.Git, Cap.Filesystem, Cap.Terminal],
        goal,
        reasoning: `Repository reference + analysis intent. Chain: git clone → filesystem traversal → code analysis → explanation. Never native: requires live repo content via tools.`,
      };
    }

    // ---- 3. Web research --------------------------------------------------
    if (RESEARCH.test(text) && !hasImages) {
      return {
        kind: "agentic",
        taskType: "web-research",
        chain: [Cap.WebSearch, Cap.Browser],
        goal,
        reasoning: `Research/freshness intent detected. Chain: web search → page fetch → content extraction → summarization. Never native: model knowledge may be stale — live tools required.`,
      };
    }

    // ---- 4. Fix failing tests / bugs --------------------------------------
    if (FIX.test(text) && (TEST_WORD.test(text) || CODE_TARGET.test(text))) {
      return {
        kind: "agentic",
        taskType: "fix-tests",
        chain: [Cap.Terminal, Cap.Filesystem],
        goal,
        reasoning: `Fix/debug intent on code or tests. Chain: run tests/terminal → inspect files → edit → re-run to verify. Never native: requires execution + file edits.`,
      };
    }

    // ---- 5. Project scaffolding -------------------------------------------
    if (SCAFFOLD.test(text) || (CREATE_VERB.test(text) && /\b(project|app|application|package|service)\b/i.test(text))) {
      return {
        kind: "agentic",
        taskType: "scaffold",
        chain: [Cap.Filesystem, Cap.Terminal],
        goal,
        reasoning: `Project/app creation intent. Chain: create file structure → write files → verify (install/build). Never native: artifacts must exist on disk.`,
      };
    }

    // ---- 6. Code modification ---------------------------------------------
    if (MODIFY.test(text) && CODE_TARGET.test(text)) {
      return {
        kind: "agentic",
        taskType: "code-modification",
        chain: [Cap.Filesystem, Cap.Terminal],
        goal,
        reasoning: `Modification verb + code target. Chain: read target files → apply edits → verify. Never native: requires reading and writing real files.`,
      };
    }

    // ---- 7. Explicit artifact save ----------------------------------------
    if ((SAVE_INTENT.test(text) || PATH_GIVEN.test(text)) && (CREATE_VERB.test(text) || ARTIFACT_NOUN.test(text) || FILE_NOUN.test(text))) {
      return {
        kind: "agentic",
        taskType: "artifact-save",
        chain: [Cap.Filesystem],
        goal,
        reasoning: `Save/write intent with a file target. Chain: generate content → filesystem write → verify bytes. Never native: the deliverable is a file.`,
      };
    }

    // ---- 8. Image present but no clear creation goal ----------------------
    if (hasImages) {
      return {
        kind: "simple",
        taskType: "simple",
        chain: [Cap.Vision],
        goal,
        reasoning: `Image present but no creation/multi-step goal — vision answers directly (native or augmented).`,
      };
    }

    // ---- Default: simple chat ---------------------------------------------
    return {
      kind: "simple",
      taskType: "simple",
      chain: [],
      goal,
      reasoning: `No multi-step tool goal detected — single model response suffices.`,
    };
  }
}

function summarize(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 100 ? flat.slice(0, 97) + "..." : flat;
}
