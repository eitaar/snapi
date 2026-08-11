import { readFile } from "node:fs/promises";
import { loadConfig, loadEnvironmentFile } from "../../config.js";
import { AppError } from "../../errors.js";
import { enrichSessionWithHarAuth } from "../../session/har-auth.js";
import { loadSession } from "../../session/loader.js";
import { parseSessionExport } from "../../session/schema.js";
import { AtomicJsonStore } from "../../session/state-store.js";
import type { CliIo } from "../io.js";

export interface SessionRefreshHarResult {
  readonly buildId: "8dd50222";
  readonly refreshedAt: string;
}

export interface SessionRefreshHarDependencies {
  readonly execute?: (harPath: string) => Promise<SessionRefreshHarResult>;
  readonly output?: "human" | "json";
}

async function executeDefault(harPath: string): Promise<{
  readonly result: SessionRefreshHarResult;
  readonly output: "human" | "json";
}> {
  loadEnvironmentFile();
  const config = loadConfig();
  const session = await loadSession(config.sessionFile);
  if (session.accountId !== config.accountId) {
    throw new AppError("INVALID_CONFIG", "Configured account does not match the session export");
  }
  let har: unknown;
  try {
    har = JSON.parse(await readFile(harPath, "utf8"));
  } catch {
    throw new AppError("INVALID_SESSION_EXPORT", "Unable to read a valid HAR export");
  }
  const refreshed = enrichSessionWithHarAuth(session, har);
  await new AtomicJsonStore(config.sessionFile, parseSessionExport).write(refreshed);
  return {
    output: config.output,
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
    ? await executeDefault(harPath)
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
