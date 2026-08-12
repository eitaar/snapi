export type ErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_SESSION_EXPORT"
  | "SESSION_EXPIRED"
  | "SESSION_REEXPORT_REQUIRED"
  | "AUTH_CONTEXT_UNAVAILABLE"
  | "UNSUPPORTED_BUILD"
  | "CRYPTO_RUNTIME_FAILED"
  | "CRYPTO_STATE_CONFLICT"
  | "WORKER_PROTOCOL_ERROR"
  | "NETWORK_FAILED"
  | "GRPC_FAILED"
  | "GATEWAY_DISCONNECTED"
  | "RATE_LIMITED"
  | "RECIPIENT_NOT_FOUND"
  | "INVALID_IMAGE"
  | "UPLOAD_FAILED"
  | "DELIVERY_UNCONFIRMED";

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function asAppError(
  error: unknown,
  code: ErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): AppError {
  return error instanceof AppError ? error : new AppError(code, message, details);
}
