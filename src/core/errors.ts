/**
 * MINDI Runtime — Typed error hierarchy.
 *
 * Every failure mode the runtime can produce is a typed error so that
 * clients, tests, and observability can branch on `error.code` instead
 * of brittle string matching.
 *
 * Convention: the third argument to any error subclass is a flat object.
 * A `cause` field (if present) is extracted for error chaining; every
 * other field becomes structured `meta` for logging / serialization.
 */

export type ErrorCode =
  | "E_CONFIG"
  | "E_PROVIDER_UNAVAILABLE"
  | "E_PROVIDER_AUTH"
  | "E_PROVIDER_RATE_LIMIT"
  | "E_PROVIDER_TIMEOUT"
  | "E_PROVIDER_ERROR"
  | "E_CAPABILITY_NOT_FOUND"
  | "E_CAPABILITY_FAILED"
  | "E_TOOL_SANDBOX_VIOLATION"
  | "E_TOOL_TIMEOUT"
  | "E_TOOL_FAILED"
  | "E_INTENT_UNANALYZABLE"
  | "E_SESSION_NOT_FOUND"
  | "E_SESSION_EXPIRED"
  | "E_REQUEST_CANCELLED"
  | "E_REQUEST_TIMEOUT"
  | "E_NO_PRIMARY_MODEL"
  | "E_MEMORY"
  | "E_INTERNAL";

/** Constructor options for any error. Flat: cause is extracted, rest -> meta. */
export type ErrorInit = { cause?: unknown } & Record<string, unknown>;

export class MindiError extends Error {
  readonly code: ErrorCode;
  readonly cause?: unknown;
  readonly meta?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, init?: ErrorInit) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    if (init) {
      const { cause, ...rest } = init;
      if (cause !== undefined) this.cause = cause;
      const meta: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined) meta[k] = v;
      }
      if (Object.keys(meta).length > 0) this.meta = meta;
    }
    Object.setPrototypeOf(this, new.target.prototype);
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.meta ? { meta: this.meta } : {}),
      ...(this.cause instanceof Error ? { cause: this.cause.message } : {}),
    };
  }
}

export class ConfigError extends MindiError {
  constructor(message: string, init?: ErrorInit) {
    super("E_CONFIG", message, init);
  }
}

export class ProviderError extends MindiError {
  constructor(
    code:
      | "E_PROVIDER_UNAVAILABLE"
      | "E_PROVIDER_AUTH"
      | "E_PROVIDER_RATE_LIMIT"
      | "E_PROVIDER_TIMEOUT"
      | "E_PROVIDER_ERROR",
    message: string,
    init?: ErrorInit,
  ) {
    super(code, message, init);
  }
}

export class CapabilityError extends MindiError {
  constructor(
    code: "E_CAPABILITY_NOT_FOUND" | "E_CAPABILITY_FAILED",
    message: string,
    init?: ErrorInit,
  ) {
    super(code, message, init);
  }
}

export class ToolError extends MindiError {
  constructor(
    code: "E_TOOL_SANDBOX_VIOLATION" | "E_TOOL_TIMEOUT" | "E_TOOL_FAILED",
    message: string,
    init?: ErrorInit,
  ) {
    super(code, message, init);
  }
}

export class SessionError extends MindiError {
  constructor(
    code: "E_SESSION_NOT_FOUND" | "E_SESSION_EXPIRED",
    message: string,
    init?: ErrorInit,
  ) {
    super(code, message, init);
  }
}

export class RequestError extends MindiError {
  constructor(
    code: "E_REQUEST_CANCELLED" | "E_REQUEST_TIMEOUT",
    message: string,
    init?: ErrorInit,
  ) {
    super(code, message, init);
  }
}

/** True if x is a MindiError. Useful in catch blocks. */
export function isMindiError(x: unknown): x is MindiError {
  return x instanceof MindiError;
}

/** Coerce any thrown value into a MindiError. */
export function toMindiError(x: unknown, fallbackCode: ErrorCode = "E_INTERNAL"): MindiError {
  if (x instanceof MindiError) return x;
  if (x instanceof Error) return new MindiError(fallbackCode, x.message, { cause: x });
  return new MindiError(fallbackCode, typeof x === "string" ? x : "Unknown error", { cause: x });
}
