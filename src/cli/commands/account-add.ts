import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { AccountProfileStore } from "../../accounts/profile-store.js";
import { getBuildProfile, isSupportedBuildId, type BuildId } from "../../builds.js";
import { AssetLoader } from "../../compat/asset-loader.js";
import { CompatibilityGuard } from "../../compat/guard.js";
import { AppError } from "../../errors.js";
import { loadSession } from "../../session/loader.js";
import type { SessionExport } from "../../session/types.js";
import type { CliIo } from "../io.js";

export interface AccountAddResult {
  readonly alias: string;
  readonly buildId: BuildId;
  readonly status: "ready";
}

export interface AccountAddDependencies {
  readonly accountsDir?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly output?: "human" | "json";
  readonly add?: (
    alias: string,
    paths: { readonly sessionFile: string; readonly assetDir: string },
  ) => Promise<AccountAddResult>;
  readonly store?: Pick<AccountProfileStore, "add">;
  readonly loadSession?: typeof loadSession;
  readonly verifyCompatibility?: (session: SessionExport, assetDir: string) => Promise<{ readonly buildId: BuildId }>;
}

function usage(io: CliIo): number {
  io.stderr("Usage: snaapi account add <alias> --session <path> --asset-dir <path>");
  return 2;
}

function resolveOutput(json: boolean, fallback: "human" | "json" = "human"): "human" | "json" {
  return json ? "json" : fallback;
}

async function verifyCompatibility(session: SessionExport, assetDir: string): Promise<{ readonly buildId: BuildId }> {
  const report = await new CompatibilityGuard(
    new AssetLoader(assetDir),
    undefined,
    getBuildProfile(session.buildId),
  ).verify(session);
  return { buildId: report.buildId };
}

async function addDefault(
  alias: string,
  paths: { readonly sessionFile: string; readonly assetDir: string },
  dependencies: AccountAddDependencies,
): Promise<AccountAddResult> {
  const cwd = dependencies.cwd ?? process.cwd();
  const sessionFile = resolve(cwd, paths.sessionFile);
  const assetDir = resolve(cwd, paths.assetDir);
  const accountsDir = dependencies.accountsDir
    ?? dependencies.env?.SNAAPI_ACCOUNTS_DIR
    ?? resolve(cwd, "private", "accounts");
  const store = dependencies.store ?? new AccountProfileStore(accountsDir);
  const session = await (dependencies.loadSession ?? loadSession)(sessionFile);
  if (!isSupportedBuildId(session.buildId)) {
    throw new AppError("UNSUPPORTED_BUILD", "Unsupported Snapchat Web build", {
      buildId: session.buildId,
    });
  }
  const report = await (dependencies.verifyCompatibility ?? verifyCompatibility)(session, assetDir);
  await store.add(alias, { sessionFile, assetDir });
  return { alias, buildId: report.buildId, status: "ready" };
}

export async function runAccountAdd(
  argv: readonly string[],
  io: CliIo,
  dependencies: AccountAddDependencies = {},
): Promise<number> {
  let values: { readonly session?: string; readonly "asset-dir"?: string; readonly json: boolean };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        session: { type: "string" },
        "asset-dir": { type: "string" },
        json: { type: "boolean", default: false },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch {
    return usage(io);
  }

  const alias = positionals[0]?.trim();
  const sessionFile = values.session?.trim();
  const assetDir = values["asset-dir"]?.trim();
  if (
    positionals.length !== 1 ||
    alias === undefined ||
    alias === "" ||
    sessionFile === undefined ||
    sessionFile === "" ||
    assetDir === undefined ||
    assetDir === ""
  ) {
    return usage(io);
  }

  const result = await (dependencies.add ?? ((selectedAlias, selectedPaths) =>
    addDefault(selectedAlias, selectedPaths, dependencies)))(alias, {
      sessionFile,
      assetDir,
    });
  const output = resolveOutput(values.json, dependencies.output);
  if (output === "json") {
    io.stdout(JSON.stringify({ type: "accounts.add", account: result }));
  } else {
    io.stdout(`Account added: ${result.alias} (${result.buildId}, ${result.status})`);
  }
  return 0;
}
