/**
 * Capability Augmentation System — barrel export.
 *
 * This module is the public API of the augmentation subsystem.
 * Import from here; never reach into internal files directly.
 */

// Core router.
export { CapabilityAugmentationRouter } from "./CapabilityAugmentationRouter.js";

// Registry.
export { AugmentationModuleRegistry } from "./AugmentationModuleRegistry.js";

// Input analysis.
export { InputAnalyzer } from "./InputAnalyzer.js";

// Policy.
export { AugmentationPolicy } from "./AugmentationPolicy.js";
export type { PreferenceStore } from "./AugmentationPolicy.js";

// Response validation.
export { ResponseValidator } from "./ResponseValidator.js";

// Health tracking.
export { ModelHealthTracker } from "./ModelHealthTracker.js";
export type { HealthState, ModelHealthSnapshot } from "./ModelHealthTracker.js";

// Built-in augmentation modules.
export { VisionAugment } from "./modules/VisionAugment.js";
export { HttpAugment } from "./modules/HttpAugment.js";
export { FilesystemAugment } from "./modules/FilesystemAugment.js";
export { WebSearchAugment } from "./modules/WebSearchAugment.js";
export { GitAugment } from "./modules/GitAugment.js";

// Types.
export type {
  StructuredContextBlock,
  RequestAnalysis,
  ParsedAttachment,
  DetectedUrl,
  DetectedFilePath,
  DetectedRepository,
  SearchIntent,
  CommandIntent,
  AugmentationModule,
  AugmentationContext,
  AugmentationProvider,
  EffectiveCapabilityCard,
  AugmentationRecord,
  AugmentationResult,
  AugmentationInput,
  IAugmentationPolicy,
  ValidationResult,
  DetectedFabrication,
} from "./types.js";
