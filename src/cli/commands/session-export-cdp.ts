import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { AssetLoader } from "../../compat/asset-loader.js";
import { CompatibilityGuard } from "../../compat/guard.js";
import { getBuildProfile, isSupportedBuildId, type BuildId } from "../../builds.js";
import { captureBrowserState } from "../../browser/cdp.js";
import { loadEnvironmentFile, type AppConfig } from "../../config.js";
import { AppError } from "../../errors.js";
import { createSessionExport } from "../../session/browser-export.js";
import { extractHarAuthContext } from "../../session/har-auth.js";
import { detectHarBuildId } from "../../session/har-build.js";
import { SealedSessionStore } from "../../session/sealed-store.js";
import type { CliIo } from "../io.js";

interface ExportCdpArgs {
  readonly harPath: string;
  readonly outputPath: string;
  readonly cdpUrl: string;
  readonly targetUrl: string;
}

export interface SessionExportCdpResult {
  readonly buildId: BuildId;
  readonly assetCount: number;
  readonly targetOrigin: string;
}

export interface SessionExportCdpDependencies {
  readonly execute?: (args: ExportCdpArgs) => Promise<SessionExportCdpResult>;
  readonly config?: AppConfig;
  readonly readFile?: (path: string) => Promise<Uint8Array>;
  readonly capture?: typeof captureBrowserState;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
}

function usage(io: CliIo): number {
  io.stderr(
    "Usage: snap session export-cdp --har <har-file> --output <session-file> " +
    "[--cdp-url <url>] [--target-url <url>]",
  );
  return 2;
}

function parse(argv: readonly string[], io: CliIo): ExportCdpArgs | undefined {
  let values: ReturnType<typeof parseArgs>["values"];
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        har: { type: "string" },
        output: { type: "string" },
        "cdp-url": { type: "string" },
        "target-url": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    usage(io);
    return undefined;
  }
  const harPath = values.har;
  const outputPath = values.output;
  if (typeof harPath !== "string" || harPath.trim() === "" ||
      typeof outputPath !== "string" || outputPath.trim() === "") {
    usage(io);
    return undefined;
  }
  const cdpUrl = typeof values["cdp-url"] === "string" && values["cdp-url"].trim() !== ""
    ? values["cdp-url"]
    : "http://127.0.0.1:9222";
  const targetUrl = typeof values["target-url"] === "string" && values["target-url"].trim() !== ""
    ? values["target-url"]
    : "https://web.snapchat.com/";
  try {
    new URL(cdpUrl);
    new URL(targetUrl);
  } catch {
    throw new AppError("INVALID_CONFIG", "CDP and target URLs must be valid URLs");
  }
  return { harPath, outputPath, cdpUrl, targetUrl };
}

async function readBytes(path: string, dependencies: SessionExportCdpDependencies): Promise<Uint8Array> {
  if (dependencies.readFile !== undefined) return dependencies.readFile(path);
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    throw new AppError("INVALID_SESSION_EXPORT", "Unable to read the HAR export");
  }
}

async function executeDefault(
  args: ExportCdpArgs,
  dependencies: SessionExportCdpDependencies,
): Promise<SessionExportCdpResult> {
  const env = dependencies.env ?? process.env;
  if (dependencies.config === undefined) {
    loadEnvironmentFile();
  }
  const selectedConfig = dependencies.config;
  if (selectedConfig?.accountAlias !== undefined && resolve(args.outputPath) !== resolve(selectedConfig.sessionFile)) {
    throw new AppError("INVALID_CONFIG", "Profile session output path does not match the selected account");
  }
  const configuredBuild = selectedConfig?.buildId ?? env.SNAP_BUILD_ID;
  const assetDir = selectedConfig?.assetDir ?? env.SNAP_ASSET_DIR;
  if (!isSupportedBuildId(configuredBuild)) {
    throw new AppError("INVALID_CONFIG", "SNAP_BUILD_ID is required and unsupported");
  }
  if (assetDir === undefined || assetDir.trim() === "") {
    throw new AppError("INVALID_CONFIG", "SNAP_ASSET_DIR is required");
  }
  let har: unknown;
  try {
    har = JSON.parse(new TextDecoder().decode(await readBytes(args.harPath, dependencies)));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("INVALID_SESSION_EXPORT", "Unable to read a valid HAR export");
  }
  const harBuild = detectHarBuildId(har);
  if (harBuild === undefined) {
    throw new AppError("INVALID_SESSION_EXPORT", "HAR build is unsupported");
  }
  if (harBuild !== configuredBuild) {
    throw new AppError("UNSUPPORTED_BUILD", "HAR build does not match SNAP_BUILD_ID", {
      buildId: harBuild,
    });
  }
  const capture = dependencies.capture ?? captureBrowserState;
  const browser = await capture({ cdpUrl: args.cdpUrl, targetUrl: args.targetUrl });
  const profile = getBuildProfile(configuredBuild);
  const session = createSessionExport({
    buildId: configuredBuild,
    auth: extractHarAuthContext(har),
    assets: profile.assets,
    browser,
  });
  if (selectedConfig !== undefined) {
    if (session.accountId !== selectedConfig.accountId) {
      throw new AppError("INVALID_CONFIG", "Configured account does not match the exported session");
    }
    if (session.buildId !== selectedConfig.buildId) {
      throw new AppError("UNSUPPORTED_BUILD", "Configured build does not match the exported session", {
        buildId: session.buildId,
      });
    }
  }
  const report = await new CompatibilityGuard(
    new AssetLoader(assetDir),
    undefined,
    profile,
  ).verify(session);
  await new SealedSessionStore(args.outputPath).write(session);
  return {
    buildId: report.buildId,
    assetCount: report.assets.length,
    targetOrigin: browser.pageUrl === undefined ? new URL(args.targetUrl).origin : new URL(browser.pageUrl).origin,
  };
}

export async function runSessionExportCdp(
  argv: readonly string[],
  io: CliIo,
  dependencies: SessionExportCdpDependencies = {},
): Promise<number> {
  const args = parse(argv, io);
  if (args === undefined) return 2;
  const result = dependencies.execute === undefined
    ? await executeDefault(args, dependencies)
    : await dependencies.execute(args);
  const output = dependencies.config?.output ?? dependencies.env?.SNAP_OUTPUT ?? process.env.SNAP_OUTPUT ?? "human";
  if (output === "json") {
    io.stdout(JSON.stringify({ type: "session.exported", ...result }));
  } else {
    io.stdout(`Session exported: build ${result.buildId}, ${result.assetCount} assets verified`);
  }
  return 0;
}
