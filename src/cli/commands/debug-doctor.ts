import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AssetLoader } from "../../compat/asset-loader.js";
import { CompatibilityGuard, SUPPORTED_ASSETS } from "../../compat/guard.js";
import { loadConfig, loadEnvironmentFile, type AppConfig } from "../../config.js";
import { AppError } from "../../errors.js";
import { loadSession } from "../../session/loader.js";
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

const REPORT_PATH = resolve("docs", "runtime-feasibility-report.md");

function requiredLiveValue(name: "SNAP_TEST_RECIPIENT_ID" | "SNAP_TEST_CONVERSATION_ID"): string {
  const value = process.env[name];
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

interface LiveContext {
  readonly config: AppConfig;
  readonly session: SessionExport;
  reportAssets: FeasibilityReport["verifiedAssets"];
  runtime?: ContentRuntimeClient;
  encrypted?: EncryptedContent;
}

async function runLiveCheck(context: LiveContext, name: FeasibilityCheckName): Promise<void> {
  switch (name) {
    case "assets_verified": {
      const report = await new CompatibilityGuard(new AssetLoader(context.config.assetDir)).verify(context.session);
      context.reportAssets = report.assets;
      return;
    }
    case "worker_started":
      context.runtime = new ContentRuntimeClient({ assetDir: context.config.assetDir });
      return;
    case "globals_installed":
      await context.runtime!.initialize(context.session);
      return;
    case "storage_imported":
    case "wasm_instantiated":
    case "modules_resolved":
      return;
    case "content_envelope_created":
      context.encrypted = await context.runtime!.encryptChat({
        recipientId: requiredLiveValue("SNAP_TEST_RECIPIENT_ID"),
        conversationId: requiredLiveValue("SNAP_TEST_CONVERSATION_ID"),
        clientMessageId: crypto.randomUUID(),
        text: `snap-runtime-gate-${Date.now()}`,
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

export async function runRuntimeDoctor(io: CliIo): Promise<number> {
  let context: LiveContext | undefined;
  let output: "human" | "json" = "human";
  let report: FeasibilityReport;
  try {
    loadEnvironmentFile();
    const config = loadConfig();
    output = config.output;
    const session = await loadSession(config.sessionFile);
    if (session.accountId !== config.accountId) {
      throw new AppError("INVALID_CONFIG", "Configured account does not match the session export");
    }
    if (process.env.SNAP_LIVE_TESTS !== "1") {
      throw new AppError("INVALID_CONFIG", "Set SNAP_LIVE_TESTS=1 to run the managed runtime gate");
    }
    context = { config, session, reportAssets: [] };
    report = await runFeasibilityGate({
      buildId: "8dd50222",
      verifiedAssets: SUPPORTED_ASSETS,
      runCheck: (name) => runLiveCheck(context!, name),
    });
  } catch (error) {
    report = await invalidConfigurationReport(error);
  } finally {
    await context?.runtime?.shutdown().catch(() => undefined);
  }
  await writeReport(report);
  emit(io, report, output);
  return failureExitCode(report);
}
