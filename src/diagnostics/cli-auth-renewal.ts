import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyCookieOverrides } from "../auth/cookie-overrides.js";
import { classifyRenewalFailure, type RenewalObservation } from "../auth/renewal.js";
import { readBraveCookieHeader } from "../auth/brave-cookies.js";
import { refreshBraveDbsc, resolveOptionalBraveProfileDir } from "../auth/dbsc.js";
import { finalizeWebAttestation } from "../auth/web-attestation.js";
import { loadConfig, loadEnvironmentFile, type AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import { parseJsonWithBytes } from "../session/binary-json.js";
import { loadSession } from "../session/loader.js";
import type { SessionExport } from "../session/types.js";
import {
  runReadOnlyAuthProbe,
  type ReadOnlyAuthProbeInput,
} from "./read-only-auth-probe.js";
import { refreshSnapchatSso } from "../transport/sso-auth-refresh.js";

const PROBE_FILENAME = "edge-delta-probe.json";

export interface CliAuthRenewalProbeFixture {
  readonly binding: {
    readonly accountId: string;
    readonly buildId: "8dd50222";
    readonly sessionExportedAt: string;
  };
  readonly request: ReadOnlyAuthProbeInput["request"];
}

export interface CliAuthRenewalReport {
  readonly mode: "cli-only";
  readonly result: "renewed" | "browser-context-required" | "profile-unavailable" | "rejected";
  readonly statuses: readonly number[];
  readonly capabilities: readonly RenewalObservation[];
}

export interface CliAuthRenewalDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly config?: AppConfig;
  readonly session?: SessionExport;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly readProbeFixture?: (path: string) => Promise<unknown>;
  readonly cookieSource?: () => Promise<string>;
  readonly dbsc?: (cookieHeader: string) => Promise<{ readonly cookieHeader: string }>;
  readonly attestation?: (session: SessionExport) => Promise<string>;
}

function invalid(message: string): AppError {
  return new AppError("INVALID_CONFIG", message);
}

function objectAt(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(message);
  return value as Record<string, unknown>;
}

function stringAt(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") throw invalid(message);
  return value;
}

function parseProbeRequest(value: unknown): ReadOnlyAuthProbeInput["request"] {
  const request = objectAt(value, "CLI auth-renewal probe request is invalid");
  const headersValue = objectAt(request.headers, "CLI auth-renewal probe headers are invalid");
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(headersValue)) {
    headers[name] = stringAt(headerValue, "CLI auth-renewal probe header value is invalid");
  }
  return {
    url: stringAt(request.url, "CLI auth-renewal probe URL is required"),
    method: stringAt(request.method, "CLI auth-renewal probe method is required"),
    headers,
    bodyBase64: stringAt(request.bodyBase64, "CLI auth-renewal probe bodyBase64 is required"),
  };
}

function parseProbeFixture(value: unknown): CliAuthRenewalProbeFixture {
  const fixture = objectAt(value, "CLI auth-renewal probe fixture is invalid");
  const binding = objectAt(fixture.binding, "CLI auth-renewal probe binding is required");
  const buildId = stringAt(binding.buildId, "CLI auth-renewal probe build binding is required");
  if (buildId !== "8dd50222") {
    throw invalid("CLI auth-renewal probe build binding is unsupported");
  }
  return {
    binding: {
      accountId: stringAt(binding.accountId, "CLI auth-renewal probe account binding is required"),
      buildId,
      sessionExportedAt: stringAt(
        binding.sessionExportedAt,
        "CLI auth-renewal probe session binding is required",
      ),
    },
    request: parseProbeRequest(fixture.request),
  };
}

async function loadProbeFixture(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw invalid("Unable to read CLI auth-renewal probe request");
  }
  try {
    return parseJsonWithBytes(text);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid("CLI auth-renewal probe request is not valid JSON");
  }
}

function assertProbeBinding(
  config: AppConfig,
  session: SessionExport,
  fixture: CliAuthRenewalProbeFixture,
): void {
  if (
    fixture.binding.accountId !== config.accountId ||
    fixture.binding.accountId !== session.accountId
  ) {
    throw invalid("CLI auth-renewal probe account binding does not match the configured session");
  }
  if (
    fixture.binding.buildId !== config.buildId ||
    fixture.binding.buildId !== session.buildId
  ) {
    throw invalid("CLI auth-renewal probe build binding does not match the configured session");
  }
  if (fixture.binding.sessionExportedAt !== session.exportedAt) {
    throw invalid("CLI auth-renewal probe session binding does not match the configured session");
  }
}

function assertConfiguredSession(config: AppConfig, session: SessionExport): void {
  if (session.accountId !== config.accountId) {
    throw new AppError("INVALID_CONFIG", "Configured account does not match the session export");
  }
  if (session.buildId !== config.buildId) {
    throw new AppError("UNSUPPORTED_BUILD", "Configured build does not match the session export");
  }
}

function numberList(...values: readonly (number | undefined)[]): readonly number[] {
  return values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function safeObservations(error: AppError): readonly RenewalObservation[] {
  const { observations } = error.details;
  if (!Array.isArray(observations)) return [{ capability: "manual-session", status: "rejected" }];
  const safe = observations.filter((value): value is RenewalObservation => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const candidate = value as Partial<RenewalObservation>;
    return typeof candidate.capability === "string" && typeof candidate.status === "string";
  });
  return safe.length > 0 ? safe : [{ capability: "manual-session", status: "rejected" }];
}

function trackedCapabilities(state: {
  usedLegacyCookie: boolean;
  usedDbsc: boolean;
  usedAttestation: boolean;
}): readonly RenewalObservation[] {
  const capabilities: RenewalObservation[] = [];
  if (state.usedLegacyCookie) capabilities.push({ capability: "legacy-brave-cookie", status: "used" });
  if (state.usedDbsc) capabilities.push({ capability: "dbsc-profile", status: "used" });
  if (state.usedAttestation) capabilities.push({ capability: "web-attestation", status: "used" });
  if (capabilities.length === 0) capabilities.push({ capability: "manual-session", status: "used" });
  return capabilities;
}

function reportFromFailure(error: unknown): CliAuthRenewalReport {
  const classified = classifyRenewalFailure(error);
  const capabilities = safeObservations(classified);
  const status = typeof classified.details.status === "number" ? classified.details.status : undefined;
  if (capabilities.some((value) => value.capability === "browser-context-required")) {
    return {
      mode: "cli-only",
      result: "browser-context-required",
      statuses: numberList(status),
      capabilities,
    };
  }
  if (capabilities.some((value) => value.capability === "dbsc-profile" && value.status === "unavailable")) {
    return {
      mode: "cli-only",
      result: "profile-unavailable",
      statuses: numberList(status),
      capabilities,
    };
  }
  return {
    mode: "cli-only",
    result: "rejected",
    statuses: numberList(status),
    capabilities,
  };
}

export async function runCliAuthRenewalProbe(
  dependencies: CliAuthRenewalDependencies = {},
): Promise<CliAuthRenewalReport> {
  const env = dependencies.env ?? (() => {
    loadEnvironmentFile();
    return process.env;
  })();
  const config = dependencies.config ?? loadConfig(env);
  const loadedSession = dependencies.session ?? await loadSession(config.sessionFile);
  assertConfiguredSession(config, loadedSession);
  const session = applyCookieOverrides(loadedSession, {
    ...(config.cookieHeader === undefined ? {} : { cookieHeader: config.cookieHeader }),
    ...((config.ssoCookieHeader ?? config.cookieHeader) === undefined
      ? {}
      : { ssoCookieHeader: config.ssoCookieHeader ?? config.cookieHeader }),
  });
  const probePath = join(dirname(config.sessionFile), PROBE_FILENAME);
  const fixture = parseProbeFixture(await (
    dependencies.readProbeFixture ?? loadProbeFixture
  )(probePath));
  assertProbeBinding(config, loadedSession, fixture);
  const request = fixture.request;
  const allowLiveLocalDependencies = dependencies.config === undefined
    && dependencies.session === undefined
    && dependencies.readProbeFixture === undefined;

  const profileDir = resolveOptionalBraveProfileDir(env);
  const usage = {
    usedLegacyCookie: false,
    usedDbsc: false,
    usedAttestation: false,
  };

  const cookieSource = dependencies.cookieSource ??
    (allowLiveLocalDependencies && session.auth.ssoCookieHeader === undefined && profileDir !== undefined
      ? async () => {
          usage.usedLegacyCookie = true;
          return readBraveCookieHeader(profileDir);
        }
      : undefined);
  const dbsc = dependencies.dbsc ??
    (!allowLiveLocalDependencies || profileDir === undefined
      ? undefined
      : async (cookieHeader: string) => {
          usage.usedDbsc = true;
          return refreshBraveDbsc(cookieHeader, {
            profileDir,
            ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
          });
        });
  const attestation = dependencies.attestation ??
    (allowLiveLocalDependencies
      ? async (value: SessionExport) => {
          usage.usedAttestation = true;
          return finalizeWebAttestation(value.accountId, { assetDir: config.assetDir });
        }
      : undefined);

  const trackedCookieSource = cookieSource === undefined
    ? undefined
    : async () => {
        usage.usedLegacyCookie = true;
        return cookieSource();
      };
  const trackedDbsc = dbsc === undefined
    ? undefined
    : async (cookieHeader: string) => {
        usage.usedDbsc = true;
        return dbsc(cookieHeader);
      };
  const trackedAttestation = attestation === undefined
    ? undefined
    : async (value: SessionExport) => {
        usage.usedAttestation = true;
        return attestation(value);
      };

  let refreshed: SessionExport;
  try {
    refreshed = await refreshSnapchatSso(session, {
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(trackedCookieSource === undefined ? {} : { cookieSource: trackedCookieSource }),
      ...(trackedDbsc === undefined ? {} : { dbsc: trackedDbsc }),
      ...(trackedAttestation === undefined ? {} : { attestation: trackedAttestation }),
    });
  } catch (error) {
    return reportFromFailure(error);
  }

  const verification = await runReadOnlyAuthProbe({
    authEpoch: "cli-auth-renewal",
    mode: "node-bearer",
    request,
    auth: {
      httpToken: refreshed.auth.httpToken,
      cookieHeader: refreshed.auth.cookieHeader,
    },
  }, {
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });

  if (verification.status !== undefined && verification.status >= 200 && verification.status < 300) {
    return {
      mode: "cli-only",
      result: "renewed",
      statuses: [verification.status],
      capabilities: trackedCapabilities(usage),
    };
  }
  if (verification.status === 303 || verification.status === 403) {
    return {
      mode: "cli-only",
      result: "browser-context-required",
      statuses: [verification.status],
      capabilities: [{ capability: "browser-context-required", status: "rejected", httpStatus: verification.status }],
    };
  }
  return {
    mode: "cli-only",
    result: "rejected",
    statuses: numberList(verification.status),
    capabilities: trackedCapabilities(usage),
  };
}
