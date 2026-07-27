import { describe, it, expect } from "vitest";
import { isVisionRefusal } from "../src/agent/visionRefusal.js";

describe("isVisionRefusal", () => {
  it("detects the exact refusal observed from nemotron-nano-vl", () => {
    const reply =
      "Certainly, I can provide detailed information about the image you have uploaded. " +
      "However, I need the image file to proceed with the analysis. Despite having access " +
      "to various tools, I am unable to retrieve the image from the file path " +
      "\"C:\\Users\\faazr\\Downloads\\ChatGPT Image Jul 27, 2026.png\".";
    expect(isVisionRefusal(reply)).toBe(true);
  });

  it("detects common refusal phrasings", () => {
    const positives = [
      "I'm sorry, I cannot see the image you mentioned.",
      "I can't view images. Please describe it instead.",
      "I am unable to access the image file at that path.",
      "No image was attached to your message.",
      "I don't see any image in our conversation.",
      "The image was not provided, so I cannot analyze it.",
      "I'm a text-based AI and cannot process images.",
      "Please upload the image so I can analyze it.",
      "I need the image file to proceed.",
      "The image cannot be retrieved from the file path given.",
      "As a text-only model, I cannot interpret pictures.",
      "I do not have the ability to view images.",
    ];
    for (const p of positives) {
      expect(isVisionRefusal(p), `expected refusal: ${p}`).toBe(true);
    }
  });

  it("does not flag real analyses", () => {
    const negatives = [
      "The image shows a landing page with a dark hero section and a signup form.",
      "In this screenshot I can see a terminal window running tests; 3 of them fail.",
      "The diagram contains three boxes connected by arrows.",
      "It's a photo of a cat sitting on a keyboard.",
      "Certainly! The image contains the following text: 'Hello World'.",
      "",
      "   ",
    ];
    for (const n of negatives) {
      expect(isVisionRefusal(n), `expected NOT refusal: ${n}`).toBe(false);
    }
  });
});
