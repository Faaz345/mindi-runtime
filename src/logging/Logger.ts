import type { ILogger } from "../core/types.js";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export interface LoggerSink {
  write(level: LogLevel, msg: string, meta: Record<string, unknown>): void;
}

/** Default sink: writes JSON lines to stderr. */
export class ConsoleLoggerSink implements LoggerSink {
  constructor(private readonly stream: NodeJS.WritableStream = process.stderr) {}
  write(level: LogLevel, msg: string, meta: Record<string, unknown>): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...meta,
    });
    this.stream.write(line + "\n");
  }
}

/**
 * Structured logger with scoped child contexts.
 *
 * The logger is itself event-free (it does NOT depend on the EventBus) so
 * it can be safely used inside EventBus handlers without re-entrancy.
 */
export class Logger implements ILogger {
  private readonly level: number;
  private readonly sinks: LoggerSink[];
  private readonly context: Record<string, unknown>;

  constructor(opts?: {
    level?: LogLevel;
    sinks?: LoggerSink[];
    context?: Record<string, unknown>;
  }) {
    this.level = LEVEL_ORDER[opts?.level ?? "info"];
    this.sinks = opts?.sinks ?? [new ConsoleLoggerSink()];
    this.context = opts?.context ?? {};
  }

  trace(msg: string, meta: Record<string, unknown> = {}): void {
    if (this.level <= LEVEL_ORDER.trace) this.emit("trace", msg, meta);
  }
  debug(msg: string, meta: Record<string, unknown> = {}): void {
    if (this.level <= LEVEL_ORDER.debug) this.emit("debug", msg, meta);
  }
  info(msg: string, meta: Record<string, unknown> = {}): void {
    if (this.level <= LEVEL_ORDER.info) this.emit("info", msg, meta);
  }
  warn(msg: string, meta: Record<string, unknown> = {}): void {
    if (this.level <= LEVEL_ORDER.warn) this.emit("warn", msg, meta);
  }
  error(msg: string, meta: Record<string, unknown> = {}): void {
    if (this.level <= LEVEL_ORDER.error) this.emit("error", msg, meta);
  }

  child(meta: Record<string, unknown>): ILogger {
    return new Logger({
      level: LEVEL_ORDER_TRACESHOLD(this.level),
      sinks: this.sinks,
      context: { ...this.context, ...meta },
    });
  }

  private emit(level: LogLevel, msg: string, meta: Record<string, unknown>): void {
    const merged = { ...this.context, ...meta };
    for (const sink of this.sinks) {
      try {
        sink.write(level, msg, merged);
      } catch {
        // Sink failure must never propagate.
      }
    }
  }
}

function LEVEL_ORDER_TRACESHOLD(n: number): LogLevel {
  for (const [lvl, ord] of Object.entries(LEVEL_ORDER)) {
    if (ord === n) return lvl as LogLevel;
  }
  return "info";
}
