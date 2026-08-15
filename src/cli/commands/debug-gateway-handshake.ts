import { loadConfig, loadEnvironmentFile, type AppConfig } from "../../config.js";
import { AppError } from "../../errors.js";
import { loadSession } from "../../session/loader.js";
import { probeGatewayHandshake } from "../../gateway/handshake.js";
import type { CliIo } from "../io.js";

export async function runDebugGatewayHandshake(
  argv: readonly string[],
  io: CliIo,
  dependencies: {
    readonly config?: AppConfig;
    readonly loadSession?: typeof loadSession;
    readonly probe?: typeof probeGatewayHandshake;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Promise<number> {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--json")) {
    throw new AppError("INVALID_CONFIG", "Usage: snap debug gateway-handshake [--json]");
  }
  const env = dependencies.env ?? (() => {
    loadEnvironmentFile();
    return process.env;
  })();
  if (env.SNAP_LIVE_TESTS !== "1") {
    throw new AppError("INVALID_CONFIG", "Set SNAP_LIVE_TESTS=1 to run the read-only Gateway handshake probe");
  }
  const config = dependencies.config ?? loadConfig(env);
  const session = await (dependencies.loadSession ?? loadSession)(config.sessionFile);
  if (session.accountId !== config.accountId) {
    throw new AppError("INVALID_CONFIG", "Gateway handshake session account does not match configuration");
  }
  if (session.buildId !== config.buildId) {
    throw new AppError("UNSUPPORTED_BUILD", "Gateway handshake session build does not match configuration");
  }
  const observation = await (dependencies.probe ?? probeGatewayHandshake)(session.auth.gatewayToken);
  io.stdout(JSON.stringify({ type: "debug.gateway-handshake", ...observation }));
  return 0;
}
