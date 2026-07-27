import { describe, expect, it } from "vitest";
import { detectMindiRenderMode, stateForStage } from "../src/terminal/components/MindiCore.js";

describe("MINDI runtime companion", () => {
  it("maps runtime activity to deterministic companion states", () => {
    expect(stateForStage("planning")).toBe("planning");
    expect(stateForStage("capability", "Vision processing")).toBe("vision");
    expect(stateForStage("capability", "Writing files")).toBe("writing");
    expect(stateForStage("generating")).toBe("generating");
  });

  it("selects terminal rendering fallbacks without randomness", () => {
    expect(detectMindiRenderMode({ KITTY_WINDOW_ID: "1" })).toBe("kitty");
    expect(detectMindiRenderMode({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm");
    expect(detectMindiRenderMode({ TERM: "dumb" })).toBe("ascii");
  });
});
