import { resolve } from "node:path";
import { AppError } from "./errors.js";

export interface AppConfig {
  readonly sessionFile: string;
  readonly assetDir: string;
  readonly accountId: string;
  readonly buildId: "8dd50222";
  readonly output: "human" | "json";
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new AppError("INVALID_CONFIG", `Missing required configuration: ${name}`, { name });
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const buildId = required(env, "SNAP_BUILD_ID");
  if (buildId !== "8dd50222") {
    throw new AppError("INVALID_CONFIG", "SNAP_BUILD_ID is not supported", { buildId });
  }
  const output = env.SNAP_OUTPUT ?? "human";
  if (output !== "human" && output !== "json") {
    throw new AppError("INVALID_CONFIG", "SNAP_OUTPUT must be human or json", { output });
  }
  return {
    sessionFile: resolve(required(env, "SNAP_SESSION_FILE")),
    assetDir: resolve(required(env, "SNAP_ASSET_DIR")),
    accountId: required(env, "SNAP_ACCOUNT_ID"),
    buildId,
    output,
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
