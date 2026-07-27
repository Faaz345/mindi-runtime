import { describe, expect, it } from "vitest";
import { messageFromChat } from "../src/terminal/types.js";

describe("terminal session restoration", () => {
  it("converts persisted text messages into visible terminal messages", () => {
    expect(messageFromChat({ role: "user", content: "Where are my chats?" })).toMatchObject({
      role: "user",
      content: "Where are my chats?",
    });
  });

  it("preserves text and attachment markers from multimodal messages", () => {
    expect(messageFromChat({
      role: "assistant",
      content: [
        { type: "text", text: "I analyzed it." },
        { type: "image_url", url: "data:image/png;base64,abc" },
      ],
    }).content).toBe("I analyzed it.[attachment]");
  });

  it("renders persisted tool messages safely as system messages", () => {
    expect(messageFromChat({ role: "tool", content: "write completed" })).toMatchObject({
      role: "system",
      content: "write completed",
    });
  });
});
