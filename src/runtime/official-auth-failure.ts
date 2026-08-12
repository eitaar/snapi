import type { ObservedOfficialRequest } from "./official-network.js";

export const OFFICIAL_SESSION_EXPIRED_ERROR_NAME = "OfficialSessionExpiredError";

const AUTH_STATUSES = new Set([7, 16, 401, 403]);

function statusValues(error: unknown): readonly unknown[] {
  if (error === null || typeof error !== "object") return [];
  const candidate = error as {
    readonly code?: unknown;
    readonly status?: unknown;
    readonly statusCode?: unknown;
    readonly grpcStatus?: unknown;
    readonly details?: unknown;
  };
  const details = candidate.details !== null && typeof candidate.details === "object"
    ? candidate.details as { readonly status?: unknown; readonly grpcStatus?: unknown }
    : undefined;
  return [
    candidate.code,
    candidate.status,
    candidate.statusCode,
    candidate.grpcStatus,
    details?.status,
    details?.grpcStatus,
  ];
}

function isAuthStatus(value: unknown): boolean {
  if (typeof value === "number") return AUTH_STATUSES.has(value);
  return typeof value === "string" && /^\d+$/.test(value) && AUTH_STATUSES.has(Number(value));
}

export function isOfficialAuthFailure(
  error: unknown,
  observed: readonly ObservedOfficialRequest[],
): boolean {
  return observed.some((request) =>
    request.responseStatus === 401 || request.responseStatus === 403
  ) || statusValues(error).some(isAuthStatus);
}

export function officialSessionExpiredError(): Error {
  const error = new Error("Official friend synchronization was unauthorized");
  error.name = OFFICIAL_SESSION_EXPIRED_ERROR_NAME;
  return error;
}
