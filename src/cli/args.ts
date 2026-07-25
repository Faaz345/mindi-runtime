/**
 * Minimal argument parser — no external dependencies.
 *
 * Supports:
 *   mindi <command> [options] [positional]
 *   --flag, --key=value, --key value
 *   -f (short), -f value
 *   "quoted strings"
 */

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let i = 0;

  // Skip "node", "node.exe", and the script path.
  while (i < argv.length) {
    const a = argv[i]!;
    const base = a.split(/[\\/]/).pop() ?? a;
    if (base === "node" || base === "node.exe" || base.startsWith("node-")) {
      i++;
      continue;
    }
    if (a.endsWith(".ts") || a.endsWith(".js") || a.endsWith("index.js") || a.includes("cli") || a.includes("mindi")) {
      i++;
      continue;
    }
    break;
  }

  // First non-flag is the command
  let command = "";
  if (i < argv.length && !argv[i]!.startsWith("-")) {
    command = argv[i]!;
    i++;
  }

  for (; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) {
        const key = arg.slice(2, eq);
        const val = arg.slice(eq + 1);
        flags[key] = val;
      } else {
        const key = arg.slice(2);
        // If next arg starts with -- or -, treat this as a boolean flag.
        // Otherwise, if the next arg looks like a value (not a command word),
        // consume it as the flag's value.
        // Heuristic: if the flag name is "json", "follow", "f", "help", "h",
        // "verbose", "events", "metrics", "force", treat as boolean.
        const BOOL_FLAGS = new Set(["json", "follow", "f", "help", "h", "verbose", "events", "metrics", "force"]);
        if (BOOL_FLAGS.has(key)) {
          flags[key] = true;
        } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) {
          flags[key] = argv[i + 1]!;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      const key = arg.slice(1);
      if (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) {
        flags[key] = argv[i + 1]!;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

/** Get a string flag value. */
export function getString(args: ParsedArgs, key: string, fallback = ""): string {
  const v = args.flags[key];
  if (v === undefined || typeof v === "boolean") return fallback;
  return v;
}

/** Get a boolean flag value. */
export function getBool(args: ParsedArgs, key: string): boolean {
  return args.flags[key] === true || args.flags[key] === "true";
}

/** Get a numeric flag value. */
export function getNumber(args: ParsedArgs, key: string, fallback = 0): number {
  const v = args.flags[key];
  if (v === undefined || v === true) return fallback;
  return Number(v) || fallback;
}
