import { describe, it, expect } from "vitest";
import { Logger } from "../src/logging/Logger.js";

class FakeSink {
  lines: Array<{ level: string; msg: string; meta: Record<string, unknown> }> = [];
  write(level: string, msg: string, meta: Record<string, unknown>) {
    this.lines.push({ level, msg, meta });
  }
}

describe("Logger", () => {
  it("respects log level threshold", () => {
    const sink = new FakeSink();
    const log = new Logger({ level: "info", sinks: [sink] });
    log.trace("t");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(sink.lines.map((l) => l.level)).toEqual(["info", "warn", "error"]);
  });

  it("child loggers inherit context", () => {
    const sink = new FakeSink();
    const log = new Logger({ level: "info", sinks: [sink], context: { component: "rt" } });
    const child = log.child({ requestId: "r1" });
    child.info("hello");
    expect(sink.lines[0]!.meta).toEqual({ component: "rt", requestId: "r1" });
    expect(sink.lines[0]!.msg).toBe("hello");
  });

  it("merges per-call metadata over context", () => {
    const sink = new FakeSink();
    const log = new Logger({ level: "info", sinks: [sink], context: { a: 1 } });
    log.info("hi", { b: 2 });
    expect(sink.lines[0]!.meta).toEqual({ a: 1, b: 2 });
  });

  it("sink failure does not throw", () => {
    const log = new Logger({
      level: "info",
      sinks: [
        {
          write() {
            throw new Error("sink broken");
          },
        },
      ],
    });
    expect(() => log.info("hi")).not.toThrow();
  });
});
