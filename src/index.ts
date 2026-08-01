/**
 * MINDI Runtime
 *
 * Provider-agnostic augmentation runtime for Large Language Models.
 * One runtime. Any model. Unified capabilities.
 *
 * Public API surface. Everything else is an internal implementation detail.
 */

// Runtime — the entry point clients use.
export { Runtime } from "./runtime/Runtime.js";
export type { RuntimeRequestInput, RuntimeResponse } from "./runtime/Runtime.js";

// Core types
export type {
  CapabilityType,
  CapabilityNature,
  ICapability,
  CapabilityInput,
  CapabilityResult,
  CapabilityPayload,
  IProvider,
  ProviderModel,
  ProviderHealth,
  ITool,
  SandboxPolicy,
  ChatRole,
  ChatMessage,
  ChatContent,
  ChatRequest,
  ChatChunk,
  ExecutionContext,
  ILogger,
  IEventBus,
  RuntimeEvent,
  IntentDescriptor,
  IntentSignal,
  CapabilityPlan,
  PlannedCapability,
} from "./core/types.js";
export { CapabilityType as CapabilityTypes } from "./core/types.js";

// Errors
export {
  MindiError,
  ConfigError,
  ProviderError,
  CapabilityError,
  ToolError,
  SessionError,
  RequestError,
  WorkspaceError,
  isMindiError,
  toMindiError,
} from "./core/errors.js";
export type { ErrorCode } from "./core/errors.js";

// Config
export { resolveConfig, configFromEnv } from "./core/config.js";
export type { RuntimeConfig, SandboxConfig, ResolvedConfig, WorkspaceConfig, ResolvedWorkspaceConfig } from "./core/config.js";

// Streaming
export type { StreamEvent } from "./streaming/StreamingEngine.js";
export { collectStream, streamFromChatChunks } from "./streaming/StreamingEngine.js";

// Events
export { EventBus } from "./events/EventBus.js";

// Logging
export { Logger, ConsoleLoggerSink } from "./logging/Logger.js";
export type { LogLevel, LoggerSink } from "./logging/Logger.js";

// Registry
export { CapabilityRegistry } from "./registry/CapabilityRegistry.js";

// Tools
export { ToolRuntime } from "./tools/ToolRuntime.js";
export { BaseTool } from "./tools/sandbox/BaseTool.js";
export { Sandbox } from "./tools/sandbox/Sandbox.js";
export { FilesystemTool } from "./tools/builtin/FilesystemTool.js";
export { TerminalTool } from "./tools/builtin/TerminalTool.js";
export { GitTool } from "./tools/builtin/GitTool.js";
export { HttpTool } from "./tools/builtin/HttpTool.js";
export { SearchTool } from "./tools/builtin/SearchTool.js";
export type { SearchProvider, SearchResult, SearchOptions } from "./tools/builtin/SearchTool.js";
export { DuckDuckGoProvider, BraveSearchProvider, TavilySearchProvider } from "./tools/builtin/SearchTool.js";
export { PlaywrightTool } from "./tools/builtin/PlaywrightTool.js";
export { OcrTool } from "./tools/builtin/OcrTool.js";
export { ArchiveTool } from "./tools/builtin/ArchiveTool.js";
export { SqliteTool } from "./tools/builtin/SqliteTool.js";
export { ClipboardTool } from "./tools/builtin/ClipboardTool.js";
export { DiffPatchTool } from "./tools/builtin/DiffPatchTool.js";
export { MarkupTool } from "./tools/builtin/MarkupTool.js";

// Tool SDK
export { ToolBase } from "./tools/sdk/ToolBase.js";
export type { ToolMetadata, ToolPermission, ToolProgress, ToolStreamChunk, ToolRetryPolicy } from "./tools/sdk/ToolBase.js";
export { hasPermission, assertPermissions, DEFAULT_RETRY, NETWORK_RETRY } from "./tools/sdk/ToolBase.js";

// Capability Manifest
export { ManifestBuilder, createManifestFromPolicy, collectManifests, checkPermission, checkCommand, checkWorkspace, formatManifestTable } from "./tools/CapabilityManifest.js";
export type { ToolManifest, OperationPermission, RuntimeManifest, PermissionResult } from "./tools/CapabilityManifest.js";

// Capability Availability
export { CapabilityAvailabilityTracker, formatHealthTable } from "./tools/CapabilityAvailabilityTracker.js";
export type { CapabilityAvailability, AvailabilityState } from "./tools/CapabilityAvailabilityTracker.js";

// Network Policy
export { createNetworkPolicy, booleanToPolicy, checkNetworkAccess, formatNetworkPolicy } from "./tools/NetworkPolicy.js";
export type { NetworkPolicy, NetworkPolicyConfig, TrustedDomain } from "./tools/NetworkPolicy.js";

// Providers
export { ProviderManager } from "./providers/ProviderManager.js";
export type { UsageRecord } from "./providers/ProviderManager.js";
export { ProviderRouter } from "./providers/ProviderRouter.js";
export type { RouteContext, RouteDecision } from "./providers/ProviderRouter.js";
export { BaseProvider, mapHttpError } from "./providers/BaseProvider.js";
export { OpenAIProvider } from "./providers/openai/OpenAIProvider.js";
export type { OpenAIProviderOptions } from "./providers/openai/OpenAIProvider.js";
export { GeminiProvider } from "./providers/gemini/GeminiProvider.js";
export type { GeminiProviderOptions } from "./providers/gemini/GeminiProvider.js";
export { TokenRouterProvider } from "./providers/tokenrouter/TokenRouterProvider.js";
export type { TokenRouterProviderOptions } from "./providers/tokenrouter/TokenRouterProvider.js";
export { loadProvidersFromConfig } from "./providers/provider-loader.js";
export type { ProviderEntry, ProvidersConfig, ProviderRetryPolicy, AuthMethod } from "./providers/provider-config.js";
export { resolveProviderEntry, providersFromEnv, PROVIDER_DEFAULTS, DEFAULT_RETRY_POLICY, WIZARD_PROVIDER_LIST } from "./providers/provider-config.js";

// Pipeline stages
export { IntentAnalyzer } from "./intent/IntentAnalyzer.js";
export { CapabilityPlanner } from "./planner/CapabilityPlanner.js";
export { TaskPlanner } from "./planner/TaskPlanner.js";
export type { TaskPlan, TaskType, TaskSignals } from "./planner/TaskPlanner.js";
export { CapabilityRouter } from "./router/CapabilityRouter.js";
export { ContextBuilder, humanLabel } from "./context/ContextBuilder.js";

// Agent orchestration — the autonomous execution loop
export { AgentOrchestrator } from "./agent/AgentOrchestrator.js";
export type { AgentRunOptions, AgentRunResult } from "./agent/AgentOrchestrator.js";
export {
  AGENT_TOOLS,
  ToolCallStreamFilter,
  parseToolCalls,
  toolCallToCapability,
  buildAgentSystemPrompt,
  formatToolResultMessage,
} from "./agent/toolProtocol.js";
export type { AgentToolDef, ToolCall } from "./agent/toolProtocol.js";
export { extractCodeBlocks, pickTargetPath, writeArtifact } from "./agent/artifactRescue.js";
export type { RescuedArtifact, CodeBlock } from "./agent/artifactRescue.js";
export { VisionPolicy } from "./agent/VisionPolicy.js";
export type { VisionDecision, VisionPreference, VisionAction } from "./agent/VisionPolicy.js";

// Execution graph
export { GraphBuilder, topologicalWaves, graphToString } from "./planner/ExecutionGraph.js";
export { ExecutionPlanner } from "./planner/ExecutionPlanner.js";
export { GraphExecutor } from "./planner/GraphExecutor.js";
export type { NodeResult } from "./planner/GraphExecutor.js";
export type {
  ExecutionNode,
  ExecutionGraph,
  ExecutionState,
  RetryPolicy,
  GraphExecutionResult,
  ProviderCapabilityDeclaration,
} from "./core/types.js";

// Observability
export { MetricsCollector } from "./observability/MetricsCollector.js";
export type { MetricsSnapshot } from "./observability/MetricsCollector.js";

// Memory + sessions
export { MemoryLayer, InMemoryMemoryStore } from "./memory/MemoryLayer.js";
export type { MemoryStore } from "./memory/MemoryLayer.js";
export { SessionManager } from "./session/SessionManager.js";
export type { Session, SessionInit } from "./session/SessionManager.js";

// Capability system — model-centric capability detection + registry
export { ModelCapabilityRegistry } from "./capability/ModelCapabilityRegistry.js";
export { CapabilityCache } from "./capability/CapabilityCache.js";
export {
  buildProfile,
  profileFromDeclaration,
  profileToCapabilityTypes,
  profileKey,
  describeSource,
  normalizeOpenAIModelMetadata,
  normalizeGeminiModelMetadata,
} from "./capability/CapabilityDetector.js";
export type {
  ModelCapabilityProfile,
  RawModelMetadata,
  MetadataSource,
  RefreshReport,
} from "./capability/types.js";

// Workspace — persistent per-directory session system (.mindi/)
export { WorkspaceStore } from "./workspace/WorkspaceStore.js";
export { FileMemoryStore } from "./workspace/FileMemoryStore.js";
export { ProjectMemoryManager } from "./workspace/ProjectMemory.js";
export { ContextCompressor } from "./workspace/ContextCompressor.js";
export { SessionSearch } from "./workspace/SessionSearch.js";
export { WorkspaceSessionManager } from "./workspace/WorkspaceSessionManager.js";
export type { AvailabilityProbe, RestoreResult } from "./workspace/WorkspaceSessionManager.js";
export { SlashCommandRegistry } from "./workspace/SlashCommands.js";
export type { RuntimeCommandBridge } from "./workspace/SlashCommands.js";
export type {
  WorkspaceMeta,
  WorkspaceSettings,
  SessionSummary,
  SessionRecord,
  SessionSummary2,
  ExecutionEvent,
  SessionAttachment,
  SessionUsage,
  ProjectMemory,
  TechStackEntry,
  ArchitecturalDecision,
  ConventionEntry,
  ImportantFile,
  FrequentCommand,
  SummaryStore,
  SearchQuery,
  SessionSearchResult,
  SlashCommand,
  SlashCommandContext,
  SlashCommandResult,
} from "./workspace/types.js";
export { makeAvailabilityProbe, type WorkspaceSystem } from "./runtime/Runtime.js";

// Terminal input (reusable in terminal + desktop)
export { InputController } from "./terminal/input/InputController.js";
export type { InputState, InputEvent, InputAttachment } from "./terminal/input/InputController.js";

// Version
export const VERSION = "0.1.0";
