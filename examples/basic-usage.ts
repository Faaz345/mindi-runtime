/**
 * MINDI Runtime — Basic Usage Example
 *
 * Demonstrates the core value proposition: a user picks a model that LACKS
 * filesystem capability, and MINDI Runtime transparently augments it.
 *
 * Run: npx tsx examples/basic-usage.ts
 *
 * This example uses mock providers/tools (no API keys needed) so it runs
 * anywhere. See examples/with-real-providers.ts for the real API version.
 */

import { Runtime, CapabilityTypes as CapabilityType } from "../src/index.js";
import type {
  CapabilityResult,
  ChatChunk,
  ChatRequest,
  ExecutionContext,
  ProviderHealth,
  ProviderModel,
} from "../src/index.js";
import { BaseProvider } from "../src/providers/BaseProvider.js";

// ---------------------------------------------------------------------------
// 1. A mock provider that ONLY supports chat (no filesystem, no vision, etc.)
//    This simulates the user's chosen reasoning engine.
// ---------------------------------------------------------------------------

class SimpleChatProvider extends BaseProvider {
  readonly id = "simple-chat";
  readonly label = "Simple Chat (mock)";
  protected readonly providerCapabilities = new Set<CapabilityType>([CapabilityType.Chat]);
  protected modelCapabilities() {
    return [CapabilityType.Chat];
  }

  async listModels(): Promise<ProviderModel[]> {
    return [{ id: "simple-1", label: "Simple Model v1", capabilities: [CapabilityType.Chat] }];
  }

  async *chat(request: ChatRequest, _ctx: ExecutionContext): AsyncIterable<ChatChunk> {
    const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
    const caps = request.messages.filter((m) => m.role === "capability");
    const userText = typeof lastUser?.content === "string" ? lastUser.content : "(multimodal)";

    // Simulate a model that acknowledges the user's input + injected context.
    yield { delta: `I received your request: "${userText.slice(0, 50)}".\n` };
    if (caps.length > 0) {
      yield { delta: `MINDI Runtime augmented me with ${caps.length} capability result(s):\n` };
      for (const cap of caps) {
        const text = typeof cap.content === "string" ? cap.content.slice(0, 80) : "";
        yield { delta: `  - ${text}...\n` };
      }
      yield { delta: `Based on this context, here's my answer.\n` };
    } else {
      yield { delta: `No augmentation was needed for this request.\n` };
    }
    yield { delta: `[stream complete]` };
    yield { done: true, finishReason: "stop", usage: { totalTokens: 42 } };
  }

  async health(): Promise<ProviderHealth> {
    return { providerId: this.id, ok: true };
  }
}

// ---------------------------------------------------------------------------
// 2. A mock filesystem tool (deterministic, returns a canned listing)
// ---------------------------------------------------------------------------

class MockFilesystemTool {
  readonly id = "tool.fs.mock";
  readonly capability = CapabilityType.Filesystem;
  readonly label = "Mock Filesystem";
  readonly deterministic = true as const;

  async execute(): Promise<CapabilityResult> {
    return {
      type: CapabilityType.Filesystem,
      source: this.id,
      ok: true,
      payload: {
        kind: "files",
        entries: [
          { path: "/project/package.json", type: "file" },
          { path: "/project/src", type: "dir" },
          { path: "/project/README.md", type: "file" },
          { path: "/project/tests", type: "dir" },
        ],
      },
      durationMs: 2,
    };
  }
  canHandle(): boolean {
    return true;
  }
}

// ---------------------------------------------------------------------------
// 3. Run the example
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== MINDI Runtime — Basic Usage Example ===\n");

  // Boot the runtime. No real API keys — we'll register mock providers.
  const runtime = new Runtime({ providers: {} });

  // Register the user's chosen model (only supports chat).
  runtime.registerProvider(new SimpleChatProvider());

  // Register a filesystem tool (deterministic).
  runtime.registerTool(new MockFilesystemTool() as never);

  // Optional: observe every runtime event for debugging.
  runtime.onAny((e) => {
    if (e.type === "capability:dispatch") {
      console.log(`  [event] dispatching ${e.capabilityType} to ${e.capabilityId} (${e.executor})`);
    } else if (e.type === "capability:success") {
      console.log(`  [event] capability ${e.capabilityId} succeeded in ${e.durationMs}ms`);
    } else if (e.type === "planner:plan") {
      console.log(`  [event] plan: satisfied=[${e.plan.satisfied}] missing=[${e.plan.missing.map((m) => m.type)}] unavailable=[${e.plan.unavailable.map((u) => u.type)}]`);
    }
  });

  // Create a session — the user picks their trusted model.
  const session = runtime.createSession({
    providerId: "simple-chat",
    modelId: "simple-1",
    systemPrompt: "You are a helpful assistant. Use provided context when available.",
  });
  console.log(`Session created: ${session.id}`);
  console.log(`Primary model: ${session.providerId}/${session.modelId}\n`);

  // --- Request 1: needs filesystem (the chat model doesn't have it) ---
  console.log("--- Request 1: 'list the files in my project' ---\n");
  const res1 = await runtime.requestOnce({
    sessionId: session.id,
    text: "Can you list the files in my project directory?",
  });

  console.log(`Intent: ${res1.intent?.summary}`);
  console.log(`Required capabilities: [${res1.intent?.capabilities.join(", ")}]`);
  console.log(`Augmented with: ${res1.capabilities.length} capability execution(s)`);
  for (const cap of res1.capabilities) {
    console.log(`  - ${cap.type} via ${cap.source} (${cap.ok ? "OK" : "FAILED"}, ${cap.durationMs}ms)`);
  }
  console.log(`\nModel response:\n${res1.text}\n`);

  // --- Request 2: no augmentation needed ---
  console.log("--- Request 2: 'explain what a closure is' ---\n");
  const res2 = await runtime.requestOnce({
    sessionId: session.id,
    text: "Explain what a closure is in JavaScript.",
  });
  console.log(`Augmented with: ${res2.capabilities.length} capability execution(s)`);
  console.log(`\nModel response:\n${res2.text}\n`);

  // --- Show the full conversation history ---
  console.log("--- Conversation History ---\n");
  const history = await runtime.sessions.recall(session.id);
  for (const msg of history) {
    const content = typeof msg.content === "string" ? msg.content : "(multimodal)";
    console.log(`[${msg.role}] ${content.slice(0, 100)}${content.length > 100 ? "..." : ""}`);
  }

  console.log("\n=== Example complete ===");
}

main().catch((err) => {
  console.error("Example failed:", err);
  process.exit(1);
});
