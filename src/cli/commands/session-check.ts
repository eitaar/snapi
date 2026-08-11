import { dirname, join } from "node:path";
import { AssetLoader } from "../../compat/asset-loader.js";
import { CompatibilityGuard } from "../../compat/guard.js";
import { loadConfig, loadEnvironmentFile } from "../../config.js";
import { AppError } from "../../errors.js";
import { AccountLock } from "../../session/account-lock.js";
import { loadSession } from "../../session/loader.js";
import type { CliIo } from "../io.js";

export interface SessionCheckResult {
  readonly buildId: "8dd50222";
  readonly assetCount: number;
}

export interface SessionCheckDependencies {
  readonly inspect?: () => Promise<SessionCheckResult>;
  readonly output?: "human" | "json";
}

async function inspectDefault(): Promise<{ readonly result: SessionCheckResult; readonly output: "human" | "json" }> {
  loadEnvironmentFile();
  const config = loadConfig();
  const session = await loadSession(config.sessionFile);
  if (session.accountId !== config.accountId) {
    throw new AppError("INVALID_CONFIG", "Configured account does not match the session export");
  }
  const lock = await new AccountLock(join(dirname(config.sessionFile), "locks")).inspect(config.accountId);
  if (lock !== undefined) {
    throw new AppError("CRYPTO_STATE_CONFLICT", "Another process owns this account state", {
      pid: lock.pid,
      acquiredAt: lock.acquiredAt,
    });
  }
  const report = await new CompatibilityGuard(new AssetLoader(config.assetDir)).verify(session);
  return {
    output: config.output,
    result: { buildId: report.buildId, assetCount: report.assets.length },
  };
}

export async function runSessionCheck(
  io: CliIo,
  dependencies: SessionCheckDependencies = {},
): Promise<number> {
  const inspected = dependencies.inspect === undefined
    ? await inspectDefault()
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
