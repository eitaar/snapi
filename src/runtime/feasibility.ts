import { performance } from "node:perf_hooks";
import { AppError, type ErrorCode } from "../errors.js";

export const REQUIRED_CHECKS = [
  "assets_verified",
  "worker_started",
  "globals_installed",
  "storage_imported",
  "wasm_instantiated",
  "modules_resolved",
  "content_envelope_created",
  "state_exported",
  "managed_chat_sent",
  "managed_reply_decrypted",
] as const;

export type FeasibilityCheckName = (typeof REQUIRED_CHECKS)[number];

export interface FeasibilityAsset {
  readonly filename: string;
  readonly sha256: string;
  readonly size: number;
}

export interface FeasibilityCheck {
  readonly name: FeasibilityCheckName;
  readonly status: "passed" | "failed";
  readonly durationMs: number;
  readonly errorCode?: ErrorCode;
  readonly errorMessage?: string;
}

export interface FeasibilityReport {
  readonly buildId: "8dd50222";
  readonly startedAt: string;
  readonly verifiedAssets: readonly FeasibilityAsset[];
  readonly checks: readonly FeasibilityCheck[];
}

export interface FeasibilityGateConfig {
  readonly buildId: "8dd50222";
  readonly verifiedAssets: readonly FeasibilityAsset[];
  readonly runCheck: (name: FeasibilityCheckName) => Promise<void>;
  readonly now?: () => number;
  readonly startedAt?: string;
}

export async function runFeasibilityGate(config: FeasibilityGateConfig): Promise<FeasibilityReport> {
  const now = config.now ?? (() => performance.now());
  const checks: FeasibilityCheck[] = [];
  for (const name of REQUIRED_CHECKS) {
    const started = now();
    try {
      await config.runCheck(name);
      checks.push({ name, status: "passed", durationMs: Math.max(0, Math.round(now() - started)) });
    } catch (error) {
      const appError = error instanceof AppError
        ? error
        : new AppError("CRYPTO_RUNTIME_FAILED", "Feasibility check failed");
      checks.push({
        name,
        status: "failed",
        durationMs: Math.max(0, Math.round(now() - started)),
        errorCode: appError.code,
        errorMessage: appError.message,
      });
      break;
    }
  }
  return {
    buildId: config.buildId,
    startedAt: config.startedAt ?? new Date().toISOString(),
    verifiedAssets: config.verifiedAssets.map(({ filename, sha256, size }) => ({ filename, sha256, size })),
    checks,
  };
}

export function formatFeasibilityReport(
  report: FeasibilityReport,
  output: "human" | "json",
): string {
  if (output === "json") return JSON.stringify(report);
  const lines = [`Snapchat Web build ${report.buildId}`];
  for (const check of report.checks) {
    const suffix = check.status === "failed" && check.errorCode !== undefined
      ? ` (${check.errorCode}: ${check.errorMessage ?? "failed"})`
      : "";
    lines.push(`${check.status === "passed" ? "PASS" : "FAIL"} ${check.name} ${check.durationMs}ms${suffix}`);
  }
  return lines.join("\n");
}

export function formatFeasibilityMarkdown(report: FeasibilityReport): string {
  const assetRows = report.verifiedAssets.length === 0
    ? "| _none_ | _none_ | 0 |"
    : report.verifiedAssets.map(({ filename, sha256, size }) => `| ${filename} | ${sha256} | ${size} |`).join("\n");
  const checkRows = report.checks.map((check) =>
    `| ${check.name} | ${check.status} | ${check.durationMs} | ${check.errorCode ?? ""} | ${check.errorMessage ?? ""} |`
  ).join("\n");
  return `# Content Runtime Feasibility Report

- Build ID: \`${report.buildId}\`
- Started at: \`${report.startedAt}\`

## Verified assets

| Filename | SHA-256 | Size |
|---|---|---:|
${assetRows}

## Checks

| Check | Status | Duration ms | Error code | Safe error |
|---|---|---:|---|---|
${checkRows}
`;
}
