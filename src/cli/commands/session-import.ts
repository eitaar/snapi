import { parseArgs } from "node:util";
import { AssetLoader } from "../../compat/asset-loader.js";
import { CompatibilityGuard } from "../../compat/guard.js";
import { getBuildProfile, type BuildId } from "../../builds.js";
import { loadConfig, loadEnvironmentFile, type AppConfig } from "../../config.js";
import { AppError } from "../../errors.js";
import { AccountLock } from "../../session/account-lock.js";
import { loadSession } from "../../session/loader.js";
import { SealedSessionStore } from "../../session/sealed-store.js";
import type { CliIo } from "../io.js";

export interface SessionImportResult {
  readonly buildId: BuildId;
  readonly assetCount: number;
}

export interface SessionImportDependencies {
  readonly importSession?: (path: string) => Promise<SessionImportResult>;
  readonly config?: AppConfig;
  readonly output?: "human" | "json";
}

async function importDefault(path: string, config?: AppConfig): Promise<{
  readonly result: SessionImportResult;
  readonly output: "human" | "json";
}> {
  const selectedConfig = config ?? (() => {
    loadEnvironmentFile();
    return loadConfig();
  })();
  const session = await loadSession(path);
  if (session.accountId !== selectedConfig.accountId) {
    throw new AppError("INVALID_CONFIG", "Configured account does not match the imported session");
  }
  if (session.buildId !== selectedConfig.buildId) {
    throw new AppError("UNSUPPORTED_BUILD", "Configured build does not match the imported session");
  }

  const lock = await new AccountLock(selectedConfig.lockDir)
    .acquire(selectedConfig.accountId);
  try {
    const report = await new CompatibilityGuard(
      new AssetLoader(selectedConfig.assetDir),
      undefined,
      getBuildProfile(session.buildId),
    ).verify(session);
    await new SealedSessionStore(selectedConfig.sessionFile).write(session);
    return {
      output: selectedConfig.output,
      result: { buildId: report.buildId, assetCount: report.assets.length },
    };
  } finally {
    await lock.release();
  }
}

export async function runSessionImport(
  argv: readonly string[],
  io: CliIo,
  dependencies: SessionImportDependencies = {},
): Promise<number> {
  let positionals: string[];
  try {
    positionals = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {},
    }).positionals;
  } catch {
    io.stderr("Usage: snap session import <export-file>");
    return 2;
  }
  if (positionals.length !== 1 || positionals[0]?.trim() === "") {
    io.stderr("Usage: snap session import <export-file>");
    return 2;
  }

  const imported = dependencies.importSession === undefined
    ? await importDefault(positionals[0]!, dependencies.config)
    : {
        result: await dependencies.importSession(positionals[0]!),
        output: dependencies.output ?? "human",
      };
  if (imported.output === "json") {
    io.stdout(JSON.stringify({ type: "session.imported", ...imported.result }));
  } else {
    io.stdout(`Session imported: build ${imported.result.buildId}, ${imported.result.assetCount} assets verified`);
  }
  return 0;
}
