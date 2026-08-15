import { AssetLoader } from "../../compat/asset-loader.js";
import { CompatibilityGuard } from "../../compat/guard.js";
import { getBuildProfile, type BuildId } from "../../builds.js";
import { loadConfig, loadEnvironmentFile, type AppConfig } from "../../config.js";
import { AppError } from "../../errors.js";
import { AccountLock } from "../../session/account-lock.js";
import { loadSession } from "../../session/loader.js";
import type { CliIo } from "../io.js";

export interface SessionCheckResult {
  readonly buildId: BuildId;
  readonly assetCount: number;
}

export interface SessionCheckDependencies {
  readonly inspect?: () => Promise<SessionCheckResult>;
  readonly config?: AppConfig;
  readonly output?: "human" | "json";
}

export function assertSessionCheckBuild(configBuildId: BuildId, sessionBuildId: BuildId): void {
  if (sessionBuildId !== configBuildId) {
    throw new AppError("UNSUPPORTED_BUILD", "Configured build does not match the session export", {
      buildId: sessionBuildId,
    });
  }
}

async function inspectDefault(
  config?: AppConfig,
): Promise<{ readonly result: SessionCheckResult; readonly output: "human" | "json" }> {
  const selectedConfig = config ?? (() => {
    loadEnvironmentFile();
    return loadConfig();
  })();
  const session = await loadSession(selectedConfig.sessionFile);
  if (session.accountId !== selectedConfig.accountId) {
    throw new AppError("INVALID_CONFIG", "Configured account does not match the session export");
  }
  assertSessionCheckBuild(selectedConfig.buildId, session.buildId);
  const lock = await new AccountLock(selectedConfig.lockDir).inspect(selectedConfig.accountId);
  if (lock !== undefined) {
    throw new AppError("CRYPTO_STATE_CONFLICT", "Another process owns this account state", {
      pid: lock.pid,
      acquiredAt: lock.acquiredAt,
    });
  }
  const report = await new CompatibilityGuard(
    new AssetLoader(selectedConfig.assetDir),
    undefined,
    getBuildProfile(session.buildId),
  ).verify(session);
  return {
    output: selectedConfig.output,
    result: { buildId: report.buildId, assetCount: report.assets.length },
  };
}

export async function runSessionCheck(
  io: CliIo,
  dependencies: SessionCheckDependencies = {},
): Promise<number> {
  const inspected = dependencies.inspect === undefined
    ? await inspectDefault(dependencies.config)
    : {
        result: await dependencies.inspect(),
        output: dependencies.output ?? "human",
      };
  if (inspected.output === "json") {
    io.stdout(JSON.stringify({ type: "session.checked", ...inspected.result }));
  } else {
    io.stdout(`Session OK: build ${inspected.result.buildId}, ${inspected.result.assetCount} assets verified`);
  }
  return 0;
}
