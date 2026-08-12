import { AppError } from "../errors.js";
import { redact } from "../logging/redact.js";
import type { OfficialRemote } from "./official-worker-client.js";

function safeDetails(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const redacted = redact(value);
  return redacted !== null && typeof redacted === "object" && !Array.isArray(redacted)
    ? redacted as Readonly<Record<string, unknown>>
    : {};
}

export function sanitizeMessagingInitializationError(error: unknown): AppError {
  if (error instanceof AppError) {
    const message = error.message === "Official messaging Worker call failed"
      ? error.message
      : "Official messaging initialization failed";
    return new AppError(error.code, message, safeDetails(error.details));
  }
  return new AppError(
    "CRYPTO_RUNTIME_FAILED",
    "Official messaging initialization failed",
    { errorName: error instanceof Error ? error.name : "UnknownError" },
  );
}

export class MessagingInitializationState {
  private manager: OfficialRemote | undefined;
  private failure: AppError | undefined;

  reset(): void {
    this.manager = undefined;
    this.failure = undefined;
  }

  retain(error: unknown): void {
    this.manager = undefined;
    this.failure = sanitizeMessagingInitializationError(error);
  }

  setManager(manager: OfficialRemote): void {
    this.manager = manager;
    this.failure = undefined;
  }

  require(): OfficialRemote {
    if (this.manager !== undefined) return this.manager;
    if (this.failure !== undefined) throw this.failure;
    throw new AppError(
      "SESSION_REEXPORT_REQUIRED",
      "Session export is missing login-time messaging key initialization state",
    );
  }
}
