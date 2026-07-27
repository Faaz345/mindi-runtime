import { describe, it, expect } from "vitest";
import { mapHttpError } from "../src/providers/BaseProvider.js";

describe("mapHttpError — upstream message extraction", () => {
  it("extracts the real reason from an OpenRouter-style error envelope", () => {
    const body = JSON.stringify({
      error: { message: "Rate limit exceeded: free-models-per-day", code: 429 },
    });
    const err = mapHttpError(429, body, "custom", "http://localhost/v1/chat/completions");
    expect(err.code).toBe("E_PROVIDER_RATE_LIMIT");
    expect(err.message).toContain("Rate limit exceeded: free-models-per-day");
    expect(err.message).not.toContain('{"error"');
  });

  it("unwraps a doubly-nested proxy error (metadata.raw)", () => {
    const inner = JSON.stringify({ error: { message: "model is over capacity", code: 429 } });
    const body = JSON.stringify({
      error: { message: "Provider returned error", code: 429, metadata: { raw: inner } },
    });
    const err = mapHttpError(429, body, "custom", "http://localhost/v1");
    expect(err.message).toContain("model is over capacity");
  });

  it("falls back to generic message field", () => {
    const body = JSON.stringify({ message: "something broke" });
    const err = mapHttpError(500, body, "p", "http://x");
    expect(err.message).toContain("something broke");
  });

  it("falls back to truncated raw body for non-JSON", () => {
    const err = mapHttpError(502, "<html>Bad Gateway</html>", "p", "http://x");
    expect(err.message).toContain("Bad Gateway");
  });

  it("maps auth statuses to E_PROVIDER_AUTH", () => {
    expect(mapHttpError(401, "{}", "p", "http://x").code).toBe("E_PROVIDER_AUTH");
    expect(mapHttpError(403, "{}", "p", "http://x").code).toBe("E_PROVIDER_AUTH");
  });
});
