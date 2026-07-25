# MINDI Runtime — Architecture

> One Runtime. Any Model. Unified Capabilities.

---

## Overview

MINDI Runtime is a provider-agnostic augmentation runtime for Large Language Models. Its sole purpose is to extend any LLM with capabilities it does not natively possess while keeping the user's selected model as the primary reasoning engine throughout the entire request lifecycle.

The runtime **never** silently replaces or switches the user's model. Instead, for every request, it:

1. Analyzes the user's intent
2. Determines the required capabilities
3. Inspects the selected model's declared capabilities
4. Identifies any missing capabilities
5. Selects the most appropriate execution engine (another AI provider or a deterministic tool)
6. Executes only the missing capability
7. Normalizes the result into structured context
8. Feeds that context back to the original model so it continues reasoning naturally

---

## Design Principles

- The user's selected model **always** remains the primary reasoning engine.
- The runtime **never** silently switches models.
- Capabilities are independent modules with a common interface.
- Providers are interchangeable, isolated, and independently testable.
- Tools are deterministic and sandboxed.
- Everything communicates through structured events.
- Clients remain thin — no business logic.
- Adding a provider = `register()`. Adding a capability = implement + `register()`. Adding a tool = implement + `register()`. **No core architecture changes.**

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT (thin)                         │
│  Desktop | CLI | Web | VS Code | JetBrains | SDK | API      │
└────────────────────────┬────────────────────────────────────┘
                         │  request(sessionId, text)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                      MINDI RUNTIME                          │
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐    │
│  │   Runtime    │  │   Session    │  │     Memory      │    │
│  │   (API)      │  │  Manager     │  │     Layer       │    │
│  └──────┬──────┘  └──────────────┘  └─────────────────┘    │
│         │                                                   │
│  ┌──────▼──────┐  ┌──────────────┐  ┌─────────────────┐    │
│  │   Intent    │→ │   Planner    │→ │    Router       │    │
│  │  Analyzer    │  │ (diff & plan)│  │ (pick executor) │    │
│  └─────────────┘  └──────────────┘  └────────┬────────┘    │
│                                                │             │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────▼─────────┐   │
│  │   Event     │  │   Logger     │  │   Capability       │   │
│  │    Bus      │  │ (structured) │  │   Registry         │   │
│  └─────────────┘  └──────────────┘  └─────────┬─────────┘   │
│                                                │             │
│  ┌─────────────────────────┐  ┌────────────────▼──────────┐ │
│  │   Tool Runtime          │  │   Provider Manager        │ │
│  │   (deterministic)        │  │   (model-backed)          │ │
│  │   ┌─ Filesystem         │  │   ┌─ OpenAI-compatible    │ │
│  │   ├─ Terminal           │  │   ├─ Gemini              │ │
│  │   └─ (extensible)       │  │   └─ (extensible)         │ │
│  └─────────────────────────┘  └───────────────────────────┘ │
│                                                             │
│  ┌──────────────┐  ┌──────────────────────────────────┐     │
│  │  Streaming   │  │  Context Builder                 │     │
│  │  Engine      │  │  (normalize results → messages)  │     │
│  └──────────────┘  └──────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

---

## Request Lifecycle

Every request flows through the same pipeline:

```
1. Client calls runtime.request({ sessionId, text })
2. Runtime resolves the session → primary provider + model
3. Runtime recalls session history from Memory Layer
4. IntentAnalyzer inspects input → IntentDescriptor
   (which capabilities does this request need?)
5. CapabilityPlanner diffs required vs model's declared caps
   → CapabilityPlan { satisfied, missing, unavailable }
6. For each missing capability:
   CapabilityRouter picks the best executor
   → tool (if deterministic & available) > provider
   → executes → CapabilityResult
7. ContextBuilder normalizes results into ChatMessages
   (role: "capability") + optional system preamble
8. Runtime appends context to history
9. Primary provider streams the response
   → StreamingEngine yields StreamEvents to client
10. Runtime persists user message + context + assistant reply to Memory
```

Throughout, every step emits `RuntimeEvent`s on the EventBus for observability.

---

## Subsystems

### Runtime API (`src/runtime/Runtime.ts`)

The top-level orchestrator. Wires every subsystem together and exposes the public request API. Clients only interact with the runtime through `runtime.request()` and `runtime.requestOnce()`.

### Session Manager (`src/session/SessionManager.ts`)

Owns conversation lifecycles. A Session is the unit of conversational continuity — it remembers the chosen primary model, conversation history, and metadata. The runtime is stateless across sessions; all continuity lives here.

### Intent Analyzer (`src/intent/IntentAnalyzer.ts`)

Inspects the user's request and determines which capabilities it appears to require. Pure heuristic/regex-based (no LLM call — avoids spending tokens to decide whether to spend tokens). Subclasses can swap in an LLM-backed analyzer without touching the pipeline.

### Capability Planner (`src/planner/CapabilityPlanner.ts`)

Takes an IntentDescriptor + the selected model's declared capabilities and produces a CapabilityPlan:
- **satisfied**: capabilities the model already has — skip
- **missing**: capabilities that must be augmented
- **unavailable**: required but no executor registered (graceful degrade)

The planner does **not** pick the executor — it only decides what to augment.

### Capability Registry (`src/registry/CapabilityRegistry.ts`)

Central directory of every capability implementation. Both tools and providers register here through the same `ICapability` interface. The Router queries by capability type; entries are sorted by priority (tools = 1000, providers = 100).

### Capability Router (`src/router/CapabilityRouter.ts`)

For each planned capability, picks the best executor and runs it. Selection policy:
1. If the planner prefers a tool AND a tool is registered → use the tool (deterministic > generative)
2. Otherwise pick the highest-priority executor
3. Validate `canHandle()` before executing
4. Emit `capability:dispatch` / `capability:success` / `capability:error` events

Failures are returned as structured `CapabilityResult` (not thrown) so the primary model can adapt gracefully.

### Provider Manager (`src/providers/ProviderManager.ts`)

Owns every provider instance. When a provider registers, each of its declared capabilities is also registered as an `ICapability` adapter in the shared CapabilityRegistry. This means the Router sees tools and providers uniformly.

### Tool Runtime (`src/tools/ToolRuntime.ts`)

Owns the lifecycle of all deterministic tools. Tools are preferred over LLM providers whenever they can satisfy a capability more accurately. Every tool extends `BaseTool` which provides sandbox enforcement, timeout, and error normalization.

### Sandbox (`src/tools/sandbox/Sandbox.ts`)

Enforces security policy on all tool executions:
- Filesystem operations restricted to allowed roots
- Shell commands restricted to an allowlist
- Network egress gated by a flag (default: off)
- Hard timeout per execution
- Max output bytes per execution

Tools **must** route all filesystem, network, and shell access through the Sandbox. The runtime rejects bypass attempts.

### Context Builder (`src/context/ContextBuilder.ts`)

The boundary between the augmentation subsystem and the reasoning engine. Takes capability results and normalizes them into `ChatMessages` (role: `"capability"`) that the primary model can reason over. After the builder produces messages, they are appended to conversation history — the primary model never knows how the context arrived.

### Memory Layer (`src/memory/MemoryLayer.ts`)

Pluggable persistence for conversation history. Default is in-process (RAM). Swap in SQLite, Postgres, Redis, etc. by implementing `MemoryStore`. Applies sliding-window truncation to keep history bounded.

### Event Bus (`src/events/EventBus.ts`)

Typed in-process pub/sub. Every internal communication flows through events, keeping subsystems decoupled. Logging, metrics, and tracing all subscribe independently. A failing handler never breaks the emitter.

### Streaming Engine (`src/streaming/StreamingEngine.ts`)

Uniform streaming surface for clients. Converts provider-specific `ChatChunk` streams into normalized `StreamEvent`s:
- `intent` — intent analysis completed
- `plan` — capability plan completed
- `capability` — a capability result was injected
- `delta` — incremental model output
- `done` — stream complete (with usage stats)
- `error` — stream failed

---

## Capability System

Capabilities are the central abstraction. The system is designed around **capabilities, not models**.

### Supported Capability Types

| Capability | Nature | Example Executors |
|---|---|---|
| Vision | generative | OpenAI (gpt-4o), Gemini |
| OCR | either | Tesseract tool, provider vision |
| Web Search | either | Search API tool, provider |
| Browser | either | Playwright tool |
| Filesystem | deterministic | FilesystemTool |
| Git | deterministic | GitTool (terminal) |
| Terminal | deterministic | TerminalTool |
| Image Generation | generative | OpenAI (DALL-E), provider |
| Audio | either | Whisper tool, provider |
| Embeddings | either | OpenAI, Gemini, local model |
| Database | deterministic | SQL tool |
| Chat | generative | All providers |

### Adding a New Capability

1. Add a member to `CapabilityType` in `src/core/types.ts`
2. (Optional) Add payload variants to `CapabilityPayload`
3. Implement executors (tools and/or provider adapters)
4. Register them with the runtime

No core architecture change required.

### Adding a New Provider

1. Implement `IProvider` (or extend `BaseProvider`)
2. Call `runtime.registerProvider(new MyProvider(...))`

The provider's declared capabilities are automatically registered in the CapabilityRegistry. The Router, Planner, and ContextBuilder need no changes.

### Adding a New Tool

1. Extend `BaseTool` (gets sandbox enforcement for free)
2. Call `runtime.registerTool(new MyTool(policy))`

---

## Providers

### OpenAI-Compatible (`src/providers/openai/OpenAIProvider.ts`)

One adapter supports any OpenAI-compatible API:
- OpenAI, OpenRouter, Groq, Together, Fireworks, vLLM, LM Studio
- Any future OpenAI-compatible server

Declared capabilities: Chat, Vision (model-dependent), Embeddings, Image Generation.

### Google Gemini (`src/providers/gemini/GeminiProvider.ts`)

Different wire format (contents/parts, `model` role instead of `assistant`, inlineData for images, `:streamGenerateContent` endpoint). Proves the runtime absorbs provider differences — the Router and ContextBuilder only see normalized `CapabilityResult`.

Declared capabilities: Chat, Vision (all Gemini 1.5+ models), Embeddings.

---

## Error Handling

Every failure mode is a typed `MindiError` with a code:

| Code | Meaning |
|---|---|
| `E_CONFIG` | Configuration error |
| `E_PROVIDER_UNAVAILABLE` | Provider unreachable (5xx, network) |
| `E_PROVIDER_AUTH` | Authentication failed (401/403) |
| `E_PROVIDER_RATE_LIMIT` | Rate limited (429) |
| `E_PROVIDER_TIMEOUT` | Request timed out |
| `E_CAPABILITY_NOT_FOUND` | No executor for capability |
| `E_TOOL_SANDBOX_VIOLATION` | Tool tried to escape sandbox |
| `E_TOOL_TIMEOUT` | Tool execution timed out |
| `E_SESSION_NOT_FOUND` | Session doesn't exist |
| `E_REQUEST_CANCELLED` | Caller aborted |

Capability execution failures are **not** thrown — they're returned as structured `CapabilityResult { ok: false, error: "..." }` so the primary model can adapt ("I couldn't reach the terminal, but I can suggest...").

---

## Observability

Every request emits structured events:

- `request:start` / `request:end`
- `session:created`
- `intent:analyzed`
- `planner:plan`
- `capability:dispatch` / `capability:success` / `capability:error`
- `context:assembled`
- `provider:stream` / `provider:chunk` / `provider:done`
- `memory:written`

Subscribe via `runtime.onAny()` or `runtime.on(type, handler)`. The EventBus keeps history (configurable) for debugging.

Structured JSON logging with correlation IDs (`requestId`, `sessionId`) flows to stderr by default. Swap sinks by implementing `LoggerSink`.

---

## Extensibility Summary

| Goal | Action | Core changes needed |
|---|---|---|
| New provider | `registerProvider()` | None |
| New capability | Add type + implement + register | None |
| New tool | Extend `BaseTool` + `registerTool()` | None |
| New memory backend | Implement `MemoryStore` | None |
| New log sink | Implement `LoggerSink` | None |
| New client | Call `runtime.request()` | None |

---

## File Structure

```
src/
├── core/
│   ├── types.ts          # Capability types, interfaces, events
│   ├── errors.ts         # Typed error hierarchy
│   └── config.ts         # Runtime configuration
├── events/
│   └── EventBus.ts       # Typed pub/sub
├── logging/
│   └── Logger.ts         # Structured logger
├── registry/
│   └── CapabilityRegistry.ts
├── tools/
│   ├── ToolRuntime.ts
│   ├── sandbox/
│   │   ├── Sandbox.ts
│   │   └── BaseTool.ts
│   └── builtin/
│       ├── FilesystemTool.ts
│       └── TerminalTool.ts
├── providers/
│   ├── BaseProvider.ts
│   ├── ProviderManager.ts
│   ├── openai/
│   │   └── OpenAIProvider.ts
│   └── gemini/
│       └── GeminiProvider.ts
├── intent/
│   └── IntentAnalyzer.ts
├── planner/
│   └── CapabilityPlanner.ts
├── router/
│   └── CapabilityRouter.ts
├── context/
│   └── ContextBuilder.ts
├── memory/
│   └── MemoryLayer.ts
├── session/
│   └── SessionManager.ts
├── streaming/
│   └── StreamingEngine.ts
├── runtime/
│   └── Runtime.ts         # Top-level orchestrator
└── index.ts               # Public API surface
```

---

## Testing

78 tests across 12 test files cover every subsystem:

```bash
npm test          # run all tests
npm run typecheck # TypeScript strict mode
npm run build     # compile to dist/
```

Tests use mock providers and tools (no API keys needed). The Runtime end-to-end test proves the core augmentation scenario: a chat-only model transparently gains filesystem capability.
