import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AssetLoader } from "../../compat/asset-loader.js";
import { finalizeWebAttestation } from "../../auth/web-attestation.js";
import { CompatibilityGuard, SUPPORTED_ASSETS } from "../../compat/guard.js";
import { loadConfig, loadEnvironmentFile, type AppConfig } from "../../config.js";
import { AppError } from "../../errors.js";
import { loadSession } from "../../session/loader.js";
import { parseSessionExport } from "../../session/schema.js";
import { AtomicJsonStore } from "../../session/state-store.js";
import type { SessionExport } from "../../session/types.js";
import type { CliIo } from "../io.js";
import type { EncryptedContent } from "../../runtime/content-types.js";
import {
  formatFeasibilityMarkdown,
  formatFeasibilityReport,
  runFeasibilityGate,
  type FeasibilityCheckName,
  type FeasibilityReport,
} from "../../runtime/feasibility.js";
import { ContentRuntimeClient } from "../../runtime/worker-client.js";
import { refreshSnapchatSession } from "../../transport/sso-auth-refresh.js";
import {
  runCliAuthRenewalProbe,
  type CliAuthRenewalReport,
} from "../../diagnostics/cli-auth-renewal.js";

const REPORT_PATH = resolve("docs", "runtime-feasibility-report.md");

function requiredLiveValue(
  name: "SNAP_TEST_RECIPIENT_ID" | "SNAP_TEST_CONVERSATION_ID",
  env: NodeJS.ProcessEnv,
): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new AppError("INVALID_CONFIG", `Missing live-test configuration: ${name}`, { name });
  }
  return value;
}

async function writeReport(report: FeasibilityReport): Promise<void> {
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, formatFeasibilityMarkdown(report), { encoding: "utf8", mode: 0o600 });
}

function failureExitCode(report: FeasibilityReport): number {
  const code = report.checks.find(({ status }) => status === "failed")?.errorCode;
  if (code === undefined) return 0;
  if (code === "INVALID_CONFIG" || code === "INVALID_SESSION_EXPORT" || code === "UNSUPPORTED_BUILD") return 3;
  return 4;
}

function emit(io: CliIo, report: FeasibilityReport, output: "human" | "json"): void {
  const formatted = formatFeasibilityReport(report, output);
  for (const line of formatted.split("\n")) io.stdout(line);
}

async function invalidConfigurationReport(error: unknown): Promise<FeasibilityReport> {
  return runFeasibilityGate({
    buildId: "8dd50222",
    verifiedAssets: [],
    runCheck: async (name) => {
      if (name === "assets_verified") {
        throw error instanceof AppError
          ? error
          : new AppError("INVALID_CONFIG", "Runtime doctor configuration failed");
      }
    },
  });
}

interface DoctorRuntime {
  readonly initialize: (session: SessionExport) => Promise<unknown>;
  readonly encryptChat: (input: {
    recipientId: string;
    conversationId: string;
    clientMessageId: string;
    text: string;
  }) => Promise<EncryptedContent>;
  readonly exportState: () => Promise<unknown>;
  readonly shutdown: () => Promise<void>;
}

export interface LiveContext {
  readonly config: AppConfig;
  session: SessionExport;
  reportAssets: FeasibilityReport["verifiedAssets"];
  runtime?: DoctorRuntime;
  encrypted?: EncryptedContent;
}

export interface LiveCheckDependencies {
  readonly verifyAssets?: (
    config: AppConfig,
    session: SessionExport,
  ) => Promise<FeasibilityReport["verifiedAssets"]>;
  readonly createRuntime?: (assetDir: string) => DoctorRuntime;
  readonly refreshSession?: (session: SessionExport) => Promise<SessionExport>;
  readonly env?: NodeJS.ProcessEnv;
  readonly randomUuid?: () => string;
  readonly now?: () => number;
}

export async function runLiveCheck(
  context: LiveContext,
  name: FeasibilityCheckName,
  dependencies: LiveCheckDependencies = {},
): Promise<void> {
  switch (name) {
    case "assets_verified": {
      context.reportAssets = dependencies.verifyAssets === undefined
        ? (await new CompatibilityGuard(new AssetLoader(context.config.assetDir)).verify(context.session)).assets
        : await dependencies.verifyAssets(context.config, context.session);
      return;
    }
    case "worker_started":
      context.runtime = dependencies.createRuntime?.(context.config.assetDir) ??
        new ContentRuntimeClient({ assetDir: context.config.assetDir, allowNetwork: true });
      return;
    case "globals_installed":
      if (dependencies.refreshSession !== undefined) {
        context.session = await dependencies.refreshSession(context.session);
      }
      await context.runtime!.initialize(context.session);
      return;
    case "storage_imported":
    case "wasm_instantiated":
    case "modules_resolved":
      return;
    case "content_envelope_created":
      context.encrypted = await context.runtime!.encryptChat({
        recipientId: requiredLiveValue("SNAP_TEST_RECIPIENT_ID", dependencies.env ?? process.env),
        conversationId: requiredLiveValue("SNAP_TEST_CONVERSATION_ID", dependencies.env ?? process.env),
        clientMessageId: (dependencies.randomUuid ?? randomUUID)(),
        text: `snap-runtime-gate-${(dependencies.now ?? Date.now)()}`,
      });
      return;
    case "state_exported":
      await context.runtime!.exportState();
      return;
    case "managed_chat_sent":
      throw new AppError(
        "UNSUPPORTED_BUILD",
        "Verified CreateContentMessage destination encoder is not available in the observed build adapter",
      );
    case "managed_reply_decrypted":
      return;
  }
}

export interface PreparedRuntimeDoctor {
  readonly output: "human" | "json";
  readonly verifiedAssets: FeasibilityReport["verifiedAssets"];
  readonly runCheck: (name: FeasibilityCheckName) => Promise<void>;
  readonly shutdown: () => Promise<void>;
}

export interface RuntimeDoctorDependencies {
  readonly prepare?: () => Promise<PreparedRuntimeDoctor>;
  readonly writeReport?: (report: FeasibilityReport) => Promise<void>;
}

export interface DebugAuthRenewalDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly runProbe?: () => Promise<CliAuthRenewalReport>;
}

async function prepareRuntimeDoctor(): Promise<PreparedRuntimeDoctor> {
  loadEnvironmentFile();
  const config = loadConfig();
  const session = await loadSession(config.sessionFile);
  if (session.accountId !== config.accountId) {
    throw new AppError("INVALID_CONFIG", "Configured account does not match the session export");
  }
  if (process.env.SNAP_LIVE_TESTS !== "1") {
    throw new AppError("INVALID_CONFIG", "Set SNAP_LIVE_TESTS=1 to run the managed runtime gate");
  }
  const context: LiveContext = { config, session, reportAssets: [] };
  const sessionStore = new AtomicJsonStore(config.sessionFile, parseSessionExport);
  const liveDependencies: LiveCheckDependencies = {
    refreshSession: async (current) => {
      const refreshed = await refreshSnapchatSession(current, {
        attestation: (value) => finalizeWebAttestation(value.accountId, { assetDir: config.assetDir }),
      });
      await sessionStore.write(refreshed);
      return refreshed;
    },
  };
  return {
    output: config.output,
    verifiedAssets: SUPPORTED_ASSETS,
    runCheck: (name) => runLiveCheck(context, name, liveDependencies),
    shutdown: async () => {
      await context.runtime?.shutdown().catch(() => undefined);
    },
  };
}

export async function runRuntimeDoctor(
  io: CliIo,
  dependencies: RuntimeDoctorDependencies = {},
): Promise<number> {
  let prepared: PreparedRuntimeDoctor | undefined;
  let report: FeasibilityReport;
  try {
    prepared = await (dependencies.prepare ?? prepareRuntimeDoctor)();
    report = await runFeasibilityGate({
      buildId: "8dd50222",
      verifiedAssets: prepared.verifiedAssets,
      runCheck: prepared.runCheck,
    });
  } catch (error) {
    report = await invalidConfigurationReport(error);
  } finally {
    await prepared?.shutdown();
  }
  await (dependencies.writeReport ?? writeReport)(report);
  const output = prepared?.output ?? "human";
  emit(io, report, output);
  return failureExitCode(report);
}

export async function runDebugAuthRenewal(
  io: CliIo,
  dependencies: DebugAuthRenewalDependencies = {},
): Promise<number> {
  const env = dependencies.env ?? (() => {
    loadEnvironmentFile();
    return process.env;
  })();
  if (env.SNAP_LIVE_TESTS !== "1") {
    throw new AppError("INVALID_CONFIG", "Set SNAP_LIVE_TESTS=1 to run the CLI-only auth renewal probe");
  }
  const report = await (dependencies.runProbe ?? (() => runCliAuthRenewalProbe({ env })))();
  io.stdout(JSON.stringify({ type: "debug.auth-renewal", ...report }));
  return 0;
}
