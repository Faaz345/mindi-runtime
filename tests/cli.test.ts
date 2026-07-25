/**
 * CLI Tests — arg parser, format utilities, and command behavior.
 *
 * Tests the CLI infrastructure (parsing, formatting) rather than
 * running full commands (which require API keys).
 */

import { describe, it, expect } from "vitest";
import { parseArgs, getString, getBool, getNumber } from "../src/cli/args.js";
import { formatMs, formatBytes } from "../src/cli/format.js";

describe("CLI: parseArgs", () => {
  it("parses a simple command with positional args", () => {
    const args = parseArgs(["node", "cli/index.js", "run", "hello", "world"]);
    expect(args.command).toBe("run");
    expect(args.positional).toEqual(["hello", "world"]);
  });

  it("parses --flag=value", () => {
    const args = parseArgs(["node", "cli/index.js", "run", "--model=gpt-4o", "hello"]);
    expect(args.command).toBe("run");
    expect(args.flags.model).toBe("gpt-4o");
    expect(args.positional).toEqual(["hello"]);
  });

  it("parses --flag value", () => {
    const args = parseArgs(["node", "cli/index.js", "run", "--model", "gpt-4o", "hello"]);
    expect(args.flags.model).toBe("gpt-4o");
  });

  it("parses boolean flags", () => {
    const args = parseArgs(["node", "cli/index.js", "run", "--json", "hello"]);
    expect(args.flags.json).toBe(true);
  });

  it("parses short flags", () => {
    const args = parseArgs(["node", "cli/index.js", "logs", "-f"]);
    expect(args.flags.f).toBe(true);
  });

  it("handles no command", () => {
    const args = parseArgs(["node", "cli/index.js"]);
    expect(args.command).toBe("");
    expect(args.positional).toEqual([]);
  });

  it("handles node.exe on Windows", () => {
    const args = parseArgs(["C:\\Program Files\\nodejs\\node.exe", "dist/cli/index.js", "version"]);
    expect(args.command).toBe("version");
  });

  it("handles quoted strings as positional args", () => {
    const args = parseArgs(["node", "cli/index.js", "run", "hello world", "second"]);
    expect(args.command).toBe("run");
    expect(args.positional).toEqual(["hello world", "second"]);
  });
});

describe("CLI: getString/getBool/getNumber", () => {
  it("getString returns flag value", () => {
    const args = parseArgs(["node", "cli", "run", "--model", "gpt-4o", "hi"]);
    expect(getString(args, "model")).toBe("gpt-4o");
  });

  it("getString returns fallback when missing", () => {
    const args = parseArgs(["node", "cli", "run", "hi"]);
    expect(getString(args, "model", "default")).toBe("default");
  });

  it("getBool returns true for boolean flags", () => {
    const args = parseArgs(["node", "cli", "run", "--json", "hi"]);
    expect(getBool(args, "json")).toBe(true);
  });

  it("getBool returns false when missing", () => {
    const args = parseArgs(["node", "cli", "run", "hi"]);
    expect(getBool(args, "json")).toBe(false);
  });

  it("getNumber returns numeric value", () => {
    const args = parseArgs(["node", "cli", "logs", "--limit", "100"]);
    expect(getNumber(args, "limit")).toBe(100);
  });

  it("getNumber returns fallback when missing", () => {
    const args = parseArgs(["node", "cli", "logs"]);
    expect(getNumber(args, "limit", 50)).toBe(50);
  });
});

describe("CLI: formatMs", () => {
  it("formats sub-millisecond", () => {
    expect(formatMs(0)).toBe("<1ms");
  });

  it("formats milliseconds", () => {
    expect(formatMs(50)).toBe("50ms");
    expect(formatMs(999)).toBe("999ms");
  });

  it("formats seconds", () => {
    expect(formatMs(1000)).toBe("1.00s");
    expect(formatMs(2500)).toBe("2.50s");
  });
});

describe("CLI: formatBytes", () => {
  it("formats bytes", () => {
    expect(formatBytes(100)).toBe("100B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(1024)).toBe("1.0KB");
    expect(formatBytes(5120)).toBe("5.0KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0MB");
  });
});
