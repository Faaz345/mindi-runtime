#!/usr/bin/env node
/**
 * MINDI Runtime CLI
 *
 * The primary interface to the runtime during development.
 * Every command communicates only with the Runtime public API.
 *
 * Usage:
 *   mindi <command> [options]
 *
 * Commands:
 *   init         Create .env configuration file
 *   doctor       Health-check all providers + show diagnostics
 *   providers    List registered providers + capabilities
 *   capabilities List all capability types + executors
 *   models       List all models across providers
 *   run          Execute a request, stream output, show augmentation
 *   inspect      Show session history + runtime state
 *   graph        Visualize the execution graph for a request
 *   logs         Show runtime event history / live event stream
 *   config       Show/validate resolved config
 *   version      Show version information
 */

import { parseArgs, getString, getBool, getNumber } from "./args.js";
import { bootRuntime, loadEnvFile } from "./runtime-loader.js";
import { error, colors } from "./format.js";
import { initCommand } from "./commands/init.js";
import { setupCommand } from "./commands/setup.js";
import { doctorCommand } from "./commands/doctor.js";
import { providersCommand } from "./commands/providers.js";
import { capabilitiesCommand } from "./commands/capabilities.js";
import { modelsCommand } from "./commands/models.js";
import { runCommand } from "./commands/run.js";
import { inspectCommand } from "./commands/inspect.js";
import { graphCommand } from "./commands/graph.js";
import { logsCommand } from "./commands/logs.js";
import { configCommand } from "./commands/config.js";
import { versionCommand } from "./commands/version.js";

const HELP_TEXT = `
${colors.bold("MINDI Runtime CLI")}

${colors.cyan("Usage:")}
  mindi <command> [options]

${colors.cyan("Commands:")}
  setup       First-run onboarding wizard (interactive)
  init        Create .env configuration file (legacy)
  doctor      Health-check all providers + show diagnostics
  providers    List registered providers + capabilities
  capabilities List all capability types + executors
  models       List all models across providers with declarations
  run          Execute a request, stream output, show augmentation
  inspect      Show session history + runtime state
  graph        Visualize the execution graph for a request
  logs         Show runtime event history / live event stream
  config       Show/validate resolved config
  version      Show version information

${colors.cyan("Options:")}
  --help, -h     Show this help message
  --json         Output as JSON (run command)
  --follow, -f   Follow live events (logs command)
  --filter       Filter events by type (logs command)
  --limit        Max events to show (logs command)
  --provider     Filter by provider (models command)
  --model        Override model id (run/graph commands)
  --session      Session id to use (run/inspect/graph commands)
  --events       Show event history (inspect command)
  --metrics      Show metrics (inspect command)
  --force        Force overwrite (init command)
  --verbose      Show runtime logs

${colors.cyan("Examples:")}
  mindi init
  mindi doctor
  mindi run "list files in my directory"
  mindi run "describe this image" --model gpt-4o
  mindi graph "browse to https://example.com and take a screenshot"
  mindi logs --follow --filter capability
  mindi inspect --session <id> --events --metrics
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  // Handle no command
  if (!args.command) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  // Handle help
  if (args.command === "help" || getBool(args, "help") || getBool(args, "h")) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  // Verbose mode
  if (getBool(args, "verbose")) {
    process.env.MINDI_CLI_VERBOSE = "1";
  }

  // Commands that don't need a runtime instance
  switch (args.command) {
    case "version":
      versionCommand();
      return;

    case "init":
      initCommand({ force: getBool(args, "force") });
      return;

    case "setup":
      await setupCommand({
        nonInteractive: getBool(args, "non-interactive") || getBool(args, "ni"),
        provider: getString(args, "provider"),
        model: getString(args, "model"),
        openaiKey: getString(args, "openai-key") || undefined,
        geminiKey: getString(args, "gemini-key") || undefined,
        baseUrl: getString(args, "base-url") || undefined,
      });
      return;

    case "help":
      process.stdout.write(HELP_TEXT);
      return;
  }

  // Commands that DO need a runtime instance.
  // Load .env before booting.
  loadEnvFile();

  let rt;
  try {
    rt = bootRuntime();
  } catch (err) {
    error(`Failed to boot runtime: ${err instanceof Error ? err.message : String(err)}`);
    error("Run `mindigenous` to configure the runtime interactively.");
    process.exit(1);
  }

  switch (args.command) {
    case "doctor":
      await doctorCommand(rt);
      break;

    case "providers":
      providersCommand(rt);
      break;

    case "capabilities":
    case "caps":
      capabilitiesCommand(rt);
      break;

    case "models":
      await modelsCommand(rt, {
        provider: getString(args, "provider"),
      });
      break;

    case "run": {
      const text = args.positional.join(" ") || getString(args, "text");
      if (!text) {
        error("Usage: mindi run \"<your prompt>\"");
        error("Example: mindi run \"list the files in my directory\"");
        process.exit(1);
      }
      await runCommand(rt, {
        text,
        provider: getString(args, "provider"),
        model: getString(args, "model"),
        sessionId: getString(args, "session"),
        json: getBool(args, "json"),
      });
      break;
    }

    case "inspect": {
      await inspectCommand(rt, {
        sessionId: getString(args, "session"),
        events: getBool(args, "events"),
        metrics: getBool(args, "metrics"),
      });
      break;
    }

    case "graph": {
      const text = args.positional.join(" ") || getString(args, "text");
      if (!text) {
        error("Usage: mindi graph \"<your prompt>\"");
        error("Example: mindi graph \"browse to https://example.com and take a screenshot\"");
        process.exit(1);
      }
      await graphCommand(rt, {
        text,
        provider: getString(args, "provider"),
        model: getString(args, "model"),
        sessionId: getString(args, "session"),
      });
      break;
    }

    case "logs": {
      await logsCommand(rt, {
        follow: getBool(args, "follow") || getBool(args, "f"),
        filter: getString(args, "filter") || undefined,
        limit: getNumber(args, "limit", 50),
      });
      break;
    }

    case "config":
      configCommand(rt);
      break;

    default:
      error(`Unknown command: ${args.command}`);
      process.stdout.write(HELP_TEXT);
      process.exit(1);
  }
}

main().catch((err) => {
  error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
