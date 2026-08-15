import { dirname, join, resolve } from "node:path";
import { AccountProfileStore, assertAccountAlias } from "./accounts/profile-store.js";
import type { AccountProfileRecord } from "./accounts/types.js";
import { isSupportedBuildId, type BuildId } from "./builds.js";
import { AppError } from "./errors.js";
import { loadSession } from "./session/loader.js";

export interface AppConfig {
  readonly sessionFile: string;
  readonly assetDir: string;
  readonly lockDir: string;
  readonly accountId: string;
  readonly buildId: BuildId;
  readonly output: "human" | "json";
  readonly accountAlias?: string;
  readonly cookieHeader?: string;
  readonly ssoCookieHeader?: string;
}

export interface ResolveAppConfigOptions {
  readonly accountAlias?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export interface ResolveAppConfigDependencies {
  readonly accountsDir?: string;
  readonly readProfile?: (alias: string) => Promise<AccountProfileRecord>;
  readonly loadSession?: typeof loadSession;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new AppError("INVALID_CONFIG", `Missing required configuration: ${name}`, { name });
  }
  return value;
}

function optionalCookieHeader(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  if (value === undefined || value === "") return undefined;
  if (/[\r\n]/.test(value)) {
    throw new AppError("INVALID_CONFIG", `${name} must not contain line breaks`, { name });
  }
  return value;
}

function resolveOutput(env: NodeJS.ProcessEnv): "human" | "json" {
  const output = env.SNAP_OUTPUT ?? "human";
  if (output !== "human" && output !== "json") {
    throw new AppError("INVALID_CONFIG", "SNAP_OUTPUT must be human or json", { output });
  }
  return output;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const buildId = required(env, "SNAP_BUILD_ID");
  if (!isSupportedBuildId(buildId)) {
    throw new AppError("INVALID_CONFIG", "SNAP_BUILD_ID is not supported", { buildId });
  }
  const output = resolveOutput(env);
  const cookieHeader = optionalCookieHeader(env, "SNAP_COOKIE_HEADER");
  const ssoCookieHeader = optionalCookieHeader(env, "SNAP_SSO_COOKIE_HEADER");
  const sessionFile = resolve(required(env, "SNAP_SESSION_FILE"));
  return {
    sessionFile,
    assetDir: resolve(required(env, "SNAP_ASSET_DIR")),
    lockDir: join(dirname(sessionFile), "locks"),
    accountId: required(env, "SNAP_ACCOUNT_ID"),
    buildId,
    output,
    ...(cookieHeader === undefined ? {} : { cookieHeader }),
    ...(ssoCookieHeader === undefined ? {} : { ssoCookieHeader }),
  };
}

export async function resolveAppConfig(
  options: ResolveAppConfigOptions = {},
  dependencies: ResolveAppConfigDependencies = {},
): Promise<AppConfig> {
  const env = options.env ?? process.env;
  if (options.accountAlias === undefined) {
    return loadConfig(env);
  }

  const accountAlias = assertAccountAlias(options.accountAlias);
  const accountsRoot = resolve(
    dependencies.accountsDir
      ?? env.SNAAPI_ACCOUNTS_DIR
      ?? join(options.cwd ?? process.cwd(), "private", "accounts"),
  );
  const readProfile = dependencies.readProfile
    ?? (async (alias: string) => new AccountProfileStore(accountsRoot).read(alias));
  const loadProfileSession = dependencies.loadSession ?? loadSession;
  const profile = await readProfile(accountAlias);
  const session = await loadProfileSession(profile.sessionFile);

  if (!isSupportedBuildId(session.buildId)) {
    throw new AppError("UNSUPPORTED_BUILD", "Configured build does not match a supported profile session", {
      accountAlias,
      buildId: session.buildId,
    });
  }

  const output = resolveOutput(env);
  const cookieHeader = optionalCookieHeader(env, "SNAP_COOKIE_HEADER");
  const ssoCookieHeader = optionalCookieHeader(env, "SNAP_SSO_COOKIE_HEADER");
  return {
    sessionFile: profile.sessionFile,
    assetDir: profile.assetDir,
    lockDir: join(accountsRoot, ".locks"),
    accountAlias,
    accountId: session.accountId,
    buildId: session.buildId,
    output,
    ...(cookieHeader === undefined ? {} : { cookieHeader }),
    ...(ssoCookieHeader === undefined ? {} : { ssoCookieHeader }),
  };
}

export function loadEnvironmentFile(path?: string): void {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new AppError("INVALID_CONFIG", "Unable to load environment file", {
        path: path ?? ".env",
      });
    }
  }
}
