import { AppError, type ErrorCode } from "../errors.js";
import type { SsoRefreshDependencies } from "../transport/sso-auth-refresh.js";
import type { DbscRefreshResult } from "./dbsc.js";
import type { SessionExport } from "../session/types.js";

export type RenewalCapability =
  | "manual-session"
  | "legacy-brave-cookie"
  | "dbsc-profile"
  | "web-attestation"
  | "browser-context-required";

export interface RenewalObservation {
  readonly capability: RenewalCapability;
  readonly status: "available" | "used" | "rejected" | "unavailable";
  readonly httpStatus?: number;
}

export interface RenewalResult {
  readonly session: SessionExport;
  readonly observations: readonly RenewalObservation[];
}

export interface RenewalInputs {
  readonly session: SessionExport;
  readonly dbscRefresh?: (cookieHeader: string) => Promise<DbscRefreshResult>;
  readonly ssoDependencies?: SsoRefreshDependencies;
}

type RenewalFailureReason = "dbsc-profile-unavailable" | "invalid-token";

type SafeRedirectDetails = {
  reason?: RenewalFailureReason;
  locationOrigin?: string;
  locationPath?: string;
  locationQueryKeys?: readonly string[];
  locationHasCode?: boolean;
  locationHasError?: boolean;
  locationInvalid?: boolean;
  hasLocation?: boolean;
};

type SafeRenewalDetails = Readonly<{
  reason?: RenewalFailureReason;
  status?: number;
  locationOrigin?: string;
  locationPath?: string;
  locationQueryKeys?: readonly string[];
  locationHasCode?: boolean;
  locationHasError?: boolean;
  locationInvalid?: boolean;
  hasLocation?: boolean;
  observations: readonly RenewalObservation[];
}>;

function numericStatus(details: Readonly<Record<string, unknown>>): number | undefined {
  const value = details.status;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeRedirectDetails(details: Readonly<Record<string, unknown>>): SafeRedirectDetails {
  const safe: SafeRedirectDetails = {};
  if (details.reason === "dbsc-profile-unavailable" || details.reason === "invalid-token") {
    safe.reason = details.reason;
  }
  if (typeof details.locationOrigin === "string") safe.locationOrigin = details.locationOrigin;
  if (typeof details.locationPath === "string") safe.locationPath = details.locationPath;
  if (Array.isArray(details.locationQueryKeys) && details.locationQueryKeys.every((value) => typeof value === "string")) {
    safe.locationQueryKeys = details.locationQueryKeys;
  }
  if (typeof details.locationHasCode === "boolean") safe.locationHasCode = details.locationHasCode;
  if (typeof details.locationHasError === "boolean") safe.locationHasError = details.locationHasError;
  if (typeof details.locationInvalid === "boolean") safe.locationInvalid = details.locationInvalid;
  if (typeof details.hasLocation === "boolean") safe.hasLocation = details.hasLocation;
  return safe;
}

function renewalError(
  code: ErrorCode,
  message: string,
  observations: readonly RenewalObservation[],
  details: Readonly<Record<string, unknown>> = {},
): AppError {
  const status = numericStatus(details);
  const safeDetails: SafeRenewalDetails = {
    ...(status === undefined ? {} : { status }),
    ...safeRedirectDetails(details),
    observations,
  };
  return new AppError(code, message, safeDetails);
}

export function classifyRenewalFailure(error: unknown): AppError {
  if (!(error instanceof AppError)) {
    return renewalError(
      "SESSION_REEXPORT_REQUIRED",
      "CLI-only authentication renewal failed",
      [{ capability: "manual-session", status: "rejected" }],
    );
  }

  const status = numericStatus(error.details);
  if (status === 403 || status === 303 || (status !== undefined && status >= 300 && status < 400)) {
    return renewalError(
      "AUTH_CONTEXT_UNAVAILABLE",
      "CLI-only authentication renewal requires a browser-managed authentication context",
      [{ capability: "browser-context-required", status: "rejected", httpStatus: status }],
      error.details,
    );
  }

  if (error.code === "AUTH_CONTEXT_UNAVAILABLE" && error.details.reason === "dbsc-profile-unavailable") {
    return renewalError(
      "AUTH_CONTEXT_UNAVAILABLE",
      "CLI-only authentication renewal could not use the local DBSC profile",
      [{ capability: "dbsc-profile", status: "unavailable" }],
    );
  }

  if (error.code === "SESSION_REEXPORT_REQUIRED" && error.details.reason === "invalid-token") {
    return renewalError(
      "SESSION_REEXPORT_REQUIRED",
      "CLI-only authentication renewal rejected the returned session state",
      [{ capability: "manual-session", status: "rejected" }],
    );
  }

  if (error.code === "AUTH_CONTEXT_UNAVAILABLE") {
    return renewalError(
      "AUTH_CONTEXT_UNAVAILABLE",
      "CLI-only authentication renewal is unavailable in this local context",
      [{ capability: "manual-session", status: "unavailable" }],
      error.details,
    );
  }

  if (error.code === "SESSION_REEXPORT_REQUIRED") {
    return renewalError(
      "SESSION_REEXPORT_REQUIRED",
      "CLI-only authentication renewal failed",
      [{ capability: "manual-session", status: "rejected" }],
      error.details,
    );
  }

  return renewalError(
    "SESSION_REEXPORT_REQUIRED",
    "CLI-only authentication renewal failed",
    [{ capability: "manual-session", status: "rejected" }],
  );
}
