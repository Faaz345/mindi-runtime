import { describe, expect, it } from "vitest";
import { closesPanel } from "../src/terminal/panelKeyboard.js";

describe("panel keyboard ownership", () => {
  it("closes every panel with Tab or Escape", () => {
    expect(closesPanel("inspector", { tab: true }, "")).toBe(true);
    expect(closesPanel("inspector", { escape: true }, "")).toBe(true);
    expect(closesPanel("logs", { tab: true }, "")).toBe(true);
  });

  it("prevents panel keys from leaking into terminal input", () => {
    expect(closesPanel("graph", { ctrl: true }, "c")).toBe(true);
    expect(closesPanel("inspector", { return: true }, "")).toBe(false);
    expect(closesPanel("model-picker", { tab: true }, "")).toBe(false);
    expect(closesPanel("none", { tab: true }, "")).toBe(false);
  });
});
