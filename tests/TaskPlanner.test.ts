import { describe, it, expect } from "vitest";
import { TaskPlanner } from "../src/planner/TaskPlanner.js";
import { CapabilityType } from "../src/core/types.js";

const planner = new TaskPlanner();

describe("TaskPlanner — semantic goal classification", () => {
  it("recreate-from-image: image + create website → vision → filesystem", () => {
    const plan = planner.classify({
      text: '"C:\\img\\dash.png" use this image as reference and create a standalone html website with same aesthetics',
      hasImages: true,
    });
    expect(plan.kind).toBe("agentic");
    expect(plan.taskType).toBe("recreate-from-image");
    expect(plan.chain).toContain(CapabilityType.Vision);
    expect(plan.chain).toContain(CapabilityType.Filesystem);
    expect(plan.reasoning.length).toBeGreaterThan(20);
    expect(plan.reasoning).toContain("Chain:");
  });

  it("web-research: latest news → search → browser", () => {
    const plan = planner.classify({ text: "search the internet for the latest OpenAI news and summarize", hasImages: false });
    expect(plan.kind).toBe("agentic");
    expect(plan.taskType).toBe("web-research");
    expect(plan.chain).toContain(CapabilityType.WebSearch);
  });

  it("repo-analysis: clone + explain → git → filesystem → terminal", () => {
    const plan = planner.classify({ text: "clone https://github.com/user/repo and explain the architecture", hasImages: false });
    expect(plan.kind).toBe("agentic");
    expect(plan.taskType).toBe("repo-analysis");
    expect(plan.chain).toContain(CapabilityType.Git);
    expect(plan.chain).toContain(CapabilityType.Filesystem);
  });

  it("fix-tests: failing tests → terminal → filesystem", () => {
    const plan = planner.classify({ text: "the tests are failing, fix them", hasImages: false });
    expect(plan.kind).toBe("agentic");
    expect(plan.taskType).toBe("fix-tests");
    expect(plan.chain).toContain(CapabilityType.Terminal);
    expect(plan.chain).toContain(CapabilityType.Filesystem);
  });

  it("scaffold: create new project → filesystem → terminal", () => {
    const plan = planner.classify({ text: "create a new express api project for me", hasImages: false });
    expect(plan.kind).toBe("agentic");
    expect(plan.taskType).toBe("scaffold");
  });

  it("code-modification: refactor function → filesystem", () => {
    const plan = planner.classify({ text: "refactor the login function to use async/await", hasImages: false });
    expect(plan.kind).toBe("agentic");
    expect(plan.taskType).toBe("code-modification");
  });

  it("artifact-save: save as file → filesystem", () => {
    const plan = planner.classify({ text: "create a landing page and save it to C:\\Users\\me\\index.html", hasImages: false });
    expect(plan.kind).toBe("agentic");
    expect(plan.taskType).toBe("artifact-save");
    expect(plan.chain).toContain(CapabilityType.Filesystem);
  });

  it("simple chat: greetings and plain questions stay simple", () => {
    for (const text of ["Hi", "Hello, how are you?", "explain what a closure is", "what files are in this dir?"]) {
      const plan = planner.classify({ text, hasImages: false });
      expect(plan.kind).toBe("simple");
    }
  });

  it("image without a creation goal stays simple (direct vision)", () => {
    const plan = planner.classify({ text: "what is in this image? C:\\img\\cat.png", hasImages: true });
    expect(plan.kind).toBe("simple");
  });

  it("multi-step goals are NEVER classified as native/simple chat", () => {
    const goals = [
      { text: "build me a dashboard from this screenshot C:\\a.png", hasImages: true },
      { text: "search latest gemini release notes", hasImages: false },
      { text: "clone the repo and summarize it", hasImages: false },
      { text: "fix the broken build", hasImages: false },
      { text: "create an html page and save it", hasImages: false },
    ];
    for (const g of goals) {
      const plan = planner.classify(g);
      expect(plan.kind, `goal should be agentic: ${g.text}`).toBe("agentic");
      expect(plan.chain.length, `goal needs a tool chain: ${g.text}`).toBeGreaterThan(0);
      expect(plan.reasoning.length).toBeGreaterThan(0);
    }
  });
});
