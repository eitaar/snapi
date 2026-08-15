import { readFile } from "node:fs/promises";
import { loadConfig, loadEnvironmentFile, type AppConfig } from "../../config.js";
import type { BuildId } from "../../builds.js";
import { AppError } from "../../errors.js";
import { enrichSessionWithHarAuth } from "../../session/har-auth.js";
import { detectHarBuildId } from "../../session/har-build.js";
import { loadSession } from "../../session/loader.js";
import { SealedSessionStore } from "../../session/sealed-store.js";
import type { CliIo } from "../io.js";

export interface SessionRefreshHarResult {
  readonly buildId: BuildId;
  readonly refreshedAt: string;
}

export interface SessionRefreshHarDependencies {
  readonly execute?: (harPath: string) => Promise<SessionRefreshHarResult>;
  readonly config?: AppConfig;
  readonly output?: "human" | "json";
}

export function assertSessionRefreshBuild(configBuildId: BuildId, sessionBuildId: BuildId): void {
  if (sessionBuildId !== configBuildId) {
    throw new AppError("UNSUPPORTED_BUILD", "Configured build does not match the session export", {
      buildId: sessionBuildId,
    });
  }
}

async function executeDefault(harPath: string, config?: AppConfig): Promise<{
  readonly result: SessionRefreshHarResult;
  readonly output: "human" | "json";
}> {
  const selectedConfig = config ?? (() => {
    loadEnvironmentFile();
    return loadConfig();
  })();
  const session = await loadSession(selectedConfig.sessionFile);
  if (session.accountId !== selectedConfig.accountId) {
    throw new AppError("INVALID_CONFIG", "Configured account does not match the session export");
  }
  assertSessionRefreshBuild(selectedConfig.buildId, session.buildId);
  let har: unknown;
  try {
    har = JSON.parse(await readFile(harPath, "utf8"));
  } catch {
    throw new AppError("INVALID_SESSION_EXPORT", "Unable to read a valid HAR export");
  }
  const harBuildId = detectHarBuildId(har);
  if (harBuildId === undefined) {
    throw new AppError("INVALID_SESSION_EXPORT", "HAR build is unsupported");
  }
  if (harBuildId !== session.buildId) {
    throw new AppError("UNSUPPORTED_BUILD", "HAR build does not match the session export", {
      buildId: harBuildId,
    });
  }
  const refreshed = enrichSessionWithHarAuth(session, har);
  await new SealedSessionStore(selectedConfig.sessionFile).write(refreshed);
  return {
    output: selectedConfig.output,
    result: { buildId: refreshed.buildId, refreshedAt: refreshed.exportedAt },
  };
}

export async function runSessionRefreshHar(
  argv: readonly string[],
  io: CliIo,
  dependencies: SessionRefreshHarDependencies = {},
): Promise<number> {
  if (argv.length !== 1 || argv[0]?.trim() === "") {
    io.stderr("Usage: snap session refresh-har <har-file>");
    return 2;
  }
  const harPath = argv[0]!;
  const executed = dependencies.execute === undefined
    ? await executeDefault(harPath, dependencies.config)
    : {
        result: await dependencies.execute(harPath),
        output: dependencies.output ?? "human",
      };
  if (executed.output === "json") {
    io.stdout(JSON.stringify({ type: "session.refreshed", ...executed.result }));
  } else {
    io.stdout(`Session refreshed for build ${executed.result.buildId}`);
  }
  return 0;
}
