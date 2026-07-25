import { describe, it, expect } from "vitest";
import { IntentAnalyzer } from "../src/intent/IntentAnalyzer.js";
import { CapabilityType } from "../src/core/types.js";

describe("IntentAnalyzer", () => {
  const a = new IntentAnalyzer();

  it("detects filesystem operations", () => {
    const i = a.analyze("Read the file package.json and summarize it");
    expect(i.requiredCapabilities).toContain(CapabilityType.Filesystem);
  });

  it("detects web search intent", () => {
    const i = a.analyze("What's the latest news on Mars exploration?");
    expect(i.requiredCapabilities).toContain(CapabilityType.WebSearch);
  });

  it("detects git operations", () => {
    const i = a.analyze("git status please");
    expect(i.requiredCapabilities).toContain(CapabilityType.Git);
  });

  it("detects terminal/shell intent", () => {
    const i = a.analyze("run command: npm install");
    expect(i.requiredCapabilities).toContain(CapabilityType.Terminal);
  });

  it("detects image generation intent", () => {
    const i = a.analyze("generate an image of a sunset over the ocean");
    expect(i.requiredCapabilities).toContain(CapabilityType.ImageGeneration);
  });

  it("detects vision intent from image extension", () => {
    const i = a.analyze("What's in this photo?", [{ name: "cat.png", mimeType: "image/png" }]);
    expect(i.requiredCapabilities).toContain(CapabilityType.Vision);
  });

  it("always includes Chat capability", () => {
    const i = a.analyze("hello");
    expect(i.requiredCapabilities).toContain(CapabilityType.Chat);
  });

  it("emits signals with reasons", () => {
    const i = a.analyze("search the web for news");
    expect(i.signals.length).toBeGreaterThan(0);
    expect(i.signals.every((s) => s.reason.length > 0)).toBe(true);
  });

  it("summarizes long input", () => {
    const long = "x".repeat(300);
    const i = a.analyze(long);
    expect(i.summary.length).toBeLessThanOrEqual(140);
  });
});
