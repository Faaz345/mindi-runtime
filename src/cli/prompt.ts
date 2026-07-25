/**
 * Interactive prompt utilities — zero external dependencies.
 *
 * Uses Node.js readline to read from stdin.
 * Supports: text input, password input (hidden), select (arrow keys),
 * confirm (y/n), and multi-select.
 *
 * All prompts have a non-interactive fallback: if stdin is not a TTY
 * or --non-interactive is set, they return the default value.
 */

import readline from "node:readline";
import process from "node:process";
import { colors, icons } from "./format.js";

let nonInteractive = false;

/** Set non-interactive mode (for CI / scripting). */
export function setNonInteractive(value: boolean): void {
  nonInteractive = value;
}

/** Check if we can prompt interactively. */
export function canPrompt(): boolean {
  return !nonInteractive && process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** Create a readline interface. */
function createRl(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
}

/** Prompt for text input. */
export async function promptText(
  message: string,
  options: { default?: string; placeholder?: string; required?: boolean; validate?: (v: string) => string | null } = {},
): Promise<string> {
  if (!canPrompt()) {
    return options.default ?? "";
  }

  return new Promise<string>((resolve) => {
    const rl = createRl();
    const hint = options.default ? colors.dim(` (default: ${options.default})`) : "";
    rl.question(`${colors.cyan("?")} ${message}${hint}: `, (answer) => {
      rl.close();
      const val = answer.trim() || options.default || "";
      if (options.required && !val) {
        process.stdout.write(`${icons.warn} This field is required.\n`);
        // Re-prompt
        resolve(promptText(message, options));
        return;
      }
      if (options.validate && val) {
        const err = options.validate(val);
        if (err) {
          process.stdout.write(`${icons.warn} ${err}\n`);
          resolve(promptText(message, options));
          return;
        }
      }
      resolve(val);
    });
  });
}

/** Prompt for password (hidden input). */
export async function promptPassword(
  message: string,
  options: { required?: boolean; validate?: (v: string) => string | null } = {},
): Promise<string> {
  if (!canPrompt()) {
    return "";
  }

  return new Promise<string>((resolve) => {
    const rl = createRl();
    process.stdout.write(`${colors.cyan("?")} ${message}: `);

    // Hide input
    const stdin = process.stdin;
    const wasRaw = stdin.isTTY ?? false;
    let input = "";

    const onData = (char: Buffer) => {
      const c = char.toString();
      if (c === "\r" || c === "\n") {
        process.stdout.write("\n");
        stdin.removeListener("data", onData);
        if (wasRaw) stdin.setRawMode(false);
        rl.close();
        if (options.required && !input) {
          process.stdout.write(`${icons.warn} This field is required.\n`);
          resolve(promptPassword(message, options));
          return;
        }
        if (options.validate && input) {
          const err = options.validate(input);
          if (err) {
            process.stdout.write(`${icons.warn} ${err}\n`);
            resolve(promptPassword(message, options));
            return;
          }
        }
        resolve(input);
      } else if (c === "\u0003") {
        // Ctrl+C
        process.exit(1);
      } else if (c === "\u007f" || c === "\b") {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (c >= " ") {
        input += c;
        process.stdout.write("*");
      }
    };

    if (wasRaw) stdin.setRawMode(true);
    stdin.on("data", onData);
  });
}

/** Prompt for yes/no confirmation. */
export async function promptConfirm(
  message: string,
  defaultValue = false,
): Promise<boolean> {
  if (!canPrompt()) {
    return defaultValue;
  }

  return new Promise<boolean>((resolve) => {
    const rl = createRl();
    const hint = defaultValue ? colors.dim(" (Y/n)") : colors.dim(" (y/N)");
    rl.question(`${colors.cyan("?")} ${message}${hint}: `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === "y" || a === "yes") resolve(true);
      else if (a === "n" || a === "no") resolve(false);
      else resolve(defaultValue);
    });
  });
}

/** Prompt to select from a list. Returns the selected index. */
export async function promptSelect(
  message: string,
  choices: Array<{ label: string; value: string; description?: string }>,
  options: { default?: string } = {},
): Promise<string> {
  if (!canPrompt()) {
    return options.default ?? choices[0]!.value;
  }

  return new Promise<string>((resolve) => {
    let selected = choices.findIndex((c) => c.value === options.default);
    if (selected < 0) selected = 0;

    const render = () => {
      // Move cursor up to redraw
      process.stdout.write(`\x1b[${choices.length + 1}A`);
      process.stdout.write(`${colors.cyan("?")} ${colors.bold(message)}\n`);
      for (let i = 0; i < choices.length; i++) {
        const c = choices[i]!;
        const marker = i === selected ? colors.cyan("❯") : " ";
        const label = i === selected ? colors.cyan(c.label) : c.label;
        const desc = c.description ? colors.dim(` — ${c.description}`) : "";
        process.stdout.write(`  ${marker} ${label}${desc}\n`);
      }
    };

    // Initial render
    process.stdout.write(`${colors.cyan("?")} ${colors.bold(message)}\n`);
    for (let i = 0; i < choices.length; i++) {
      const c = choices[i]!;
      const marker = i === selected ? colors.cyan("❯") : " ";
      const label = i === selected ? colors.cyan(c.label) : c.label;
      const desc = c.description ? colors.dim(` — ${c.description}`) : "";
      process.stdout.write(`  ${marker} ${label}${desc}\n`);
    }

    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();

    const onData = (data: Buffer) => {
      const key = data.toString();
      if (key === "\r" || key === "\n") {
        stdin.setRawMode(false);
        stdin.removeListener("data", onData);
        stdin.pause();
        process.stdout.write("\n");
        resolve(choices[selected]!.value);
      } else if (key === "\u001b[A" || key === "k") {
        // Up
        selected = (selected - 1 + choices.length) % choices.length;
        render();
      } else if (key === "\u001b[B" || key === "j") {
        // Down
        selected = (selected + 1) % choices.length;
        render();
      } else if (key === "\u0003") {
        // Ctrl+C
        process.exit(1);
      } else if (key >= "0" && key <= "9") {
        // Number selection
        const idx = parseInt(key, 10) - 1;
        if (idx >= 0 && idx < choices.length) {
          selected = idx;
          render();
        }
      }
    };

    stdin.on("data", onData);
  });
}

/** Prompt to select multiple items. Returns selected values. */
export async function promptMultiSelect(
  message: string,
  choices: Array<{ label: string; value: string; description?: string; checked?: boolean }>,
): Promise<string[]> {
  if (!canPrompt()) {
    return choices.filter((c) => c.checked).map((c) => c.value);
  }

  return new Promise<string[]>((resolve) => {
    let cursor = 0;
    const checked = choices.map((c) => c.checked ?? false);

    const render = () => {
      process.stdout.write(`\x1b[${choices.length + 1}A`);
      process.stdout.write(`${colors.cyan("?")} ${colors.bold(message)}\n`);
      for (let i = 0; i < choices.length; i++) {
        const c = choices[i]!;
        const marker = i === cursor ? colors.cyan("❯") : " ";
        const box = checked[i] ? colors.green("☑") : colors.dim("☐");
        const label = i === cursor ? colors.cyan(c.label) : c.label;
        const desc = c.description ? colors.dim(` — ${c.description}`) : "";
        process.stdout.write(`  ${marker} ${box} ${label}${desc}\n`);
      }
    };

    process.stdout.write(`${colors.cyan("?")} ${colors.bold(message)}\n`);
    for (let i = 0; i < choices.length; i++) {
      const c = choices[i]!;
      const marker = i === cursor ? colors.cyan("❯") : " ";
      const box = checked[i] ? colors.green("☑") : colors.dim("☐");
      const label = i === cursor ? colors.cyan(c.label) : c.label;
      const desc = c.description ? colors.dim(` — ${c.description}`) : "";
      process.stdout.write(`  ${marker} ${box} ${label}${desc}\n`);
    }

    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();

    const onData = (data: Buffer) => {
      const key = data.toString();
      if (key === "\r" || key === "\n") {
        stdin.setRawMode(false);
        stdin.removeListener("data", onData);
        stdin.pause();
        process.stdout.write("\n");
        resolve(choices.filter((_, i) => checked[i]).map((c) => c.value));
      } else if (key === "\u001b[A" || key === "k") {
        cursor = (cursor - 1 + choices.length) % choices.length;
        render();
      } else if (key === "\u001b[B" || key === "j") {
        cursor = (cursor + 1) % choices.length;
        render();
      } else if (key === " ") {
        // Toggle
        checked[cursor] = !checked[cursor];
        render();
      } else if (key === "\u0003") {
        process.exit(1);
      }
    };

    stdin.on("data", onData);
  });
}

/** Print a section banner during setup. */
export function banner(title: string): void {
  const line = "═".repeat(Math.max(title.length + 4, 50));
  process.stdout.write(`\n${colors.cyan(line)}\n`);
  process.stdout.write(`  ${colors.bold(colors.cyan(title))}\n`);
  process.stdout.write(`${colors.cyan(line)}\n\n`);
}

/** Print a step indicator. */
export function step(n: number, total: number, title: string): void {
  process.stdout.write(`\n${colors.bold(colors.cyan(`Step ${n}/${total}`))}: ${title}\n`);
  process.stdout.write(`${colors.dim("─".repeat(40))}\n`);
}
