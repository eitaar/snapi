import { stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { AccountProfileStore } from "../../accounts/profile-store.js";
import { AppError } from "../../errors.js";
import { isSupportedBuildId, type BuildId } from "../../builds.js";
import { loadSession } from "../../session/loader.js";
import type { CliIo } from "../io.js";

export interface AccountShowResult {
  readonly alias: string;
  readonly status: "ready" | "missing-session" | "invalid";
  readonly buildId?: BuildId;
  readonly sessionFile: string;
  readonly assetDir: string;
}

export interface AccountShowDependencies {
  readonly accountsDir?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly output?: "human" | "json";
  readonly show?: (alias: string) => Promise<AccountShowResult>;
  readonly store?: Pick<AccountProfileStore, "read">;
  readonly loadSession?: typeof loadSession;
}

function usage(io: CliIo): number {
  io.stderr("Usage: snaapi account show <alias> [--json]");
  return 2;
}

function resolveOutput(json: boolean, fallback: "human" | "json" = "human"): "human" | "json" {
  return json ? "json" : fallback;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function showDefault(alias: string, dependencies: AccountShowDependencies): Promise<AccountShowResult> {
  const cwd = dependencies.cwd ?? process.cwd();
  const accountsDir = dependencies.accountsDir
    ?? dependencies.env?.SNAAPI_ACCOUNTS_DIR
    ?? `${cwd}/private/accounts`;
  const store = dependencies.store ?? new AccountProfileStore(accountsDir);
  const profileStore = store instanceof AccountProfileStore ? store : undefined;
  if (profileStore !== undefined) {
    try {
      await stat(profileStore.pathFor(alias));
    } catch (error) {
      if (isMissingFile(error)) {
        throw new AppError("INVALID_CONFIG", "Account profile does not exist", { alias });
      }
      throw error;
    }
  }
  const profile = await store.read(alias);
  try {
    await stat(profile.sessionFile);
  } catch (error) {
    if (isMissingFile(error)) {
      return {
        alias,
        status: "missing-session",
        sessionFile: profile.sessionFile,
        assetDir: profile.assetDir,
      };
    }
    return {
      alias,
      status: "invalid",
      sessionFile: profile.sessionFile,
      assetDir: profile.assetDir,
    };
  }

  try {
    const session = await (dependencies.loadSession ?? loadSession)(profile.sessionFile);
    if (!isSupportedBuildId(session.buildId)) {
      return {
        alias,
        status: "invalid",
        sessionFile: profile.sessionFile,
        assetDir: profile.assetDir,
      };
    }
    return {
      alias,
      buildId: session.buildId,
      status: "ready",
      sessionFile: profile.sessionFile,
      assetDir: profile.assetDir,
    };
  } catch {
    return {
      alias,
      status: "invalid",
      sessionFile: profile.sessionFile,
      assetDir: profile.assetDir,
    };
  }
}

export async function runAccountShow(
  argv: readonly string[],
  io: CliIo,
  dependencies: AccountShowDependencies = {},
): Promise<number> {
  let json = false;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: { json: { type: "boolean", default: false } },
    });
    json = parsed.values.json;
    positionals = parsed.positionals;
  } catch {
    return usage(io);
  }

  const alias = positionals[0]?.trim();
  if (positionals.length !== 1 || alias === undefined || alias === "") {
    return usage(io);
  }

  const output = resolveOutput(json, dependencies.output);
  const account = await (dependencies.show ?? ((selectedAlias) => showDefault(selectedAlias, dependencies)))(alias);
  if (output === "json") {
    io.stdout(JSON.stringify({ type: "accounts.show", account }));
  } else {
    io.stdout(`Account: ${account.alias}`);
    io.stdout(`Status: ${account.status}`);
    io.stdout(`Build: ${account.buildId ?? "unknown"}`);
    io.stdout(`Session: ${account.sessionFile}`);
    io.stdout(`Assets: ${account.assetDir}`);
  }
  return 0;
}
