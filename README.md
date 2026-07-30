# MINDI Runtime

> One Runtime. Any Model. Unified Capabilities.

---

## Getting Started

**Already have Node.js 22+?** Two commands:

```bash
npm install -g mindigenous
mindi
```

That's it. `mindi` launches the agentic coding terminal — on first run it walks you through setup and auto-detects existing API keys (OpenAI, Gemini, Anthropic, Groq, OpenRouter, and more).

### Brand-new computer? (nothing installed — ONE command)

On **Windows**, open PowerShell and paste this single line. It checks for Node.js, installs it if missing, installs mindigenous, and sets up your PATH — all automatically:

```powershell
irm https://unpkg.com/mindigenous/install.ps1 | iex
```

When it finishes, open a **new** PowerShell window and type `mindi`.

Prefer to do it manually, or on another platform? If `npm` is "not recognized", the machine just needs Node.js first (npm comes with it). Copy-paste ONE line for your platform:

**Windows** — open PowerShell and run:

```powershell
winget install OpenJS.NodeJS.LTS
```

**macOS** — open Terminal and run:

```bash
brew install node
```

(no Homebrew? download the macOS installer from [nodejs.org](https://nodejs.org) instead)

**Ubuntu / Debian Linux**:

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt install -y nodejs
```

Then:

1. **Close and reopen the terminal** (so `npm` appears on PATH — this fixes "npm is not recognized").
2. Verify with `node --version` — must print **v22** or newer.
3. Run:

```bash
npm install -g mindigenous
mindi
```

The terminal guides you through everything else (API keys, model selection) on first launch.

To configure manually instead, set any one provider key:

```bash
# Linux / macOS
export OPENAI_API_KEY=sk-...

# Windows PowerShell
$env:OPENAI_API_KEY="sk-..."
```

`OPENAI_BASE_URL` also works for any OpenAI-compatible gateway (Groq, Together, Fireworks, LM Studio, ...).

### Advanced CLI

A lower-level CLI ships alongside the terminal for scripting and diagnostics:

```bash
mindi-cli doctor                          # health-check all providers
mindi-cli run "list files in this repo"   # one-shot prompt, streamed
mindi-cli models                          # list models across providers
mindi-cli graph "browse example.com"      # visualize the execution graph
mindi-cli logs --follow                   # live runtime event stream
```

---

## What is MINDI Runtime?

MINDI Runtime is a provider-agnostic augmentation runtime for Large Language Models.

Its purpose is simple:

**Allow any AI model to transparently use capabilities it does not natively possess while keeping that model as the primary reasoning engine.**

Instead of forcing users to constantly switch between models, MINDI Runtime detects missing capabilities, executes them through the best available provider or deterministic tool, and returns structured context back to the original model.

The selected model always remains the assistant.

The runtime simply makes it more capable.

---

## Why does MINDI Runtime exist?

Today's AI ecosystem is fragmented.

Some models have excellent reasoning.

Some have vision.

Some can search the web.

Some support tool calling.

Some generate images.

Some work entirely offline.

Users are forced to constantly switch between providers depending on the task.

MINDI Runtime removes that problem.

Instead of asking:

> "Which model should I use?"

Users simply choose the model they prefer.

The runtime handles everything else.

---

## The Core Idea

Imagine a person who cannot walk.

You don't replace the person.

You provide them with legs.

MINDI Runtime follows the same philosophy.

If a selected model lacks a capability, the runtime augments that model instead of replacing it.

Example:

```
Primary Model

↓

Missing Capability Detected

↓

Runtime Plans Execution

↓

Capability Executes

↓

Structured Context Returned

↓

Primary Model Continues Reasoning
```

The reasoning stays with the user's chosen model.

The runtime provides only the missing capability.

---

## Design Principles

MINDI Runtime is built around a few simple principles.

- The user's selected model always remains the primary reasoning engine.
- The runtime never silently switches models.
- Capabilities are independent modules.
- Providers are interchangeable.
- Tools perform deterministic execution.
- Everything communicates through structured events.
- Clients remain thin.
- Business logic belongs inside the runtime.

---

## Runtime Responsibilities

The runtime is responsible for:

- Request orchestration
- Intent analysis
- Capability planning
- Capability routing
- Provider execution
- Tool execution
- Context construction
- Session management
- Memory
- Streaming
- Observability

The runtime is **not** responsible for user interface rendering.

---

## Supported Clients

Every future MINDIGENOUS product will use the same runtime.

Examples include:

- Desktop
- CLI
- Web
- VS Code Extension
- JetBrains Extension
- SDK
- API

The runtime is shared.

Only the interface changes.

---

## Long-Term Goal

Build a modular execution platform that allows any AI model to intelligently use additional capabilities without changing the model the user selected.

Capabilities may include:

- Vision
- OCR
- Web Search
- Browser Automation
- Filesystem
- Git
- Terminal
- Image Generation
- Audio Processing
- Embeddings
- Databases
- Future capability modules

Every capability should be reusable, replaceable, and independent.

---

## Architecture

At a high level, every request follows the same lifecycle.

```
User

↓

Client

↓

Runtime

↓

Intent Analysis

↓

Capability Planning

↓

Capability Registry

↓

Capability Router

↓

Providers & Tools

↓

Context Builder

↓

Primary Model

↓

Streaming Response

↓

Client
```

---

## Guiding Principle

The runtime should never compete with the user's chosen model.

Its responsibility is to extend that model with the capabilities required to complete the task.

The user chooses **who** should reason.

MINDI Runtime decides **how** the required capabilities are executed.