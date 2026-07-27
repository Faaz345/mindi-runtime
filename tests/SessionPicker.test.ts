import { describe, expect, it } from "vitest";
import { resumableSessions } from "../src/terminal/SessionPicker.js";
import type { SessionSummary } from "../src/workspace/types.js";

function session(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: "session",
    title: "Conversation",
    createdAt: 1,
    updatedAt: 1,
    openedAt: 1,
    providerId: "openai",
    modelId: "gpt-4o",
    messageCount: 2,
    archived: false,
    pinned: false,
    tags: [],
    ...overrides,
  };
}

describe("startup session choices", () => {
  it("shows non-empty conversations with the most recent first", () => {
    const choices = resumableSessions([
      session({ id: "older", updatedAt: 10 }),
      session({ id: "newer", updatedAt: 20, providerId: "gemini", modelId: "gemini-2" }),
    ]);

    expect(choices.map((choice) => choice.id)).toEqual(["newer", "older"]);
    expect(choices[0]).toMatchObject({ providerId: "gemini", modelId: "gemini-2" });
  });

  it("does not offer empty or archived sessions for resume", () => {
    expect(resumableSessions([
      session({ id: "empty", messageCount: 0 }),
      session({ id: "archived", archived: true }),
    ])).toEqual([]);
  });
});
