/**
 * Terminal output utilities — colors, bold, dim, tables, progress.
 *
 * Zero external dependencies. Uses ANSI escape codes directly.
 * Respects NO_COLOR environment variable.
 */

const NO_COLOR = process.env.NO_COLOR !== undefined;

function wrap(code: string): (s: string) => string {
  if (NO_COLOR) return (s: string) => s;
  return (s: string) => `\x1b[${code}m${s}\x1b[0m`;
}

export const colors = {
  reset: wrap("0"),
  bold: wrap("1"),
  dim: wrap("2"),
  italic: wrap("3"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
  gray: wrap("90"),
  brightRed: wrap("91"),
  brightGreen: wrap("92"),
  brightYellow: wrap("93"),
  brightBlue: wrap("94"),
  brightCyan: wrap("96"),
};

export type ColorFn = (s: string) => string;

/** Status indicators. */
export const icons = {
  ok: colors.green("✓"),
  fail: colors.red("✗"),
  warn: colors.yellow("⚠"),
  info: colors.cyan("ℹ"),
  arrow: colors.dim("→"),
  bullet: colors.dim("•"),
  dash: colors.dim("—"),
  check: colors.green("✓"),
  cross: colors.red("✗"),
  dot: colors.gray("·"),
};

/** Print a header banner. */
export function header(title: string): void {
  const line = "─".repeat(Math.max(title.length + 4, 40));
  process.stdout.write(`\n${colors.cyan(line)}\n`);
  process.stdout.write(`  ${colors.bold(title)}\n`);
  process.stdout.write(`${colors.cyan(line)}\n\n`);
}

/** Print a section title. */
export function section(title: string): void {
  process.stdout.write(`\n${colors.bold(colors.cyan(title))}\n`);
  process.stdout.write(`${colors.dim("────────────────")}\n`);
}

/** Print an info line. */
export function info(msg: string): void {
  process.stdout.write(`${icons.info} ${msg}\n`);
}

/** Print a success line. */
export function success(msg: string): void {
  process.stdout.write(`${icons.ok} ${colors.green(msg)}\n`);
}

/** Print a warning line. */
export function warn(msg: string): void {
  process.stdout.write(`${icons.warn} ${colors.yellow(msg)}\n`);
}

/** Print an error line. */
export function error(msg: string): void {
  process.stderr.write(`${icons.fail} ${colors.red(msg)}\n`);
}

/** Print an error and exit. */
export function fatal(msg: string, code = 1): never {
  error(msg);
  process.exit(code);
}

/** Print a key-value pair. */
export function kv(key: string, value: string, indent = 0): void {
  const pad = " ".repeat(indent);
  process.stdout.write(`${pad}${colors.dim(key.padEnd(20))} ${value}\n`);
}

/** Print a dim description. */
export function dim(msg: string): void {
  process.stdout.write(`${colors.dim(msg)}\n`);
}

/** Format a table from rows. */
export function table(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => {
    const maxRow = Math.max(...rows.map((r) => (r[i] ?? "").length));
    return Math.max(h.length, maxRow);
  });

  // Header
  const headerLine = headers
    .map((h, i) => colors.bold(h.padEnd(widths[i]!)))
    .join("  ");
  process.stdout.write(`${headerLine}\n`);
  process.stdout.write(`${colors.dim(widths.map((w) => "─".repeat(w)).join("  "))}\n`);

  // Rows
  for (const row of rows) {
    const line = row
      .map((cell, i) => (cell ?? "").padEnd(widths[i]!))
      .join("  ");
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write("\n");
}

/** Print a label with a colored status badge. */
export function badge(label: string, ok: boolean): string {
  return ok
    ? colors.green(` ${label} `)
    : colors.red(` ${label} `);
}

/** Format milliseconds as a human-readable duration. */
export function formatMs(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Format bytes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** A simple spinner. */
export class Spinner {
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private idx = 0;
  private timer: NodeJS.Timeout | null = null;

  start(msg: string): void {
    this.stop();
    process.stdout.write(colors.cyan(this.frames[this.idx]!) + " " + msg);
    this.timer = setInterval(() => {
      this.idx = (this.idx + 1) % this.frames.length;
      process.stdout.write("\r");
      process.stdout.write(colors.cyan(this.frames[this.idx]!) + " " + msg);
    }, 80);
  }

  stop(finalMsg?: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      process.stdout.write("\r");
      process.stdout.write("\x1b[K"); // clear line
      if (finalMsg) process.stdout.write(finalMsg + "\n");
    }
  }
}

/** Print a tree node with indentation. */
export function treeNode(label: string, depth: number, isLast: boolean): void {
  const prefix = depth === 0 ? "" : " ".repeat((depth - 1) * 4) + (isLast ? "└─ " : "├─ ");
  process.stdout.write(`${prefix}${label}\n`);
}
