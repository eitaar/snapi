import { createLoginTransport } from "../../auth/login-client.js";
import { runLoginState, type LoginPrompt, type LoginSessionSeed, type LoginTransport } from "../../auth/login-state.js";
import { loadConfig, loadEnvironmentFile, type AppConfig } from "../../config.js";
import { AppError } from "../../errors.js";
import { SealedSessionStore } from "../../session/sealed-store.js";
import type { SessionExport } from "../../session/types.js";
import type { CliIo } from "../io.js";
import { createTerminalLoginPrompt } from "../terminal.js";

export interface SessionLoginDependencies {
  readonly config?: AppConfig;
  readonly prompt?: LoginPrompt;
  readonly transport?: LoginTransport;
  readonly createTransport?: () => Promise<LoginTransport>;
  readonly finalizeSession?: (seed: LoginSessionSeed, config: AppConfig) => Promise<SessionExport>;
  readonly persistSession?: (session: SessionExport, path: string) => Promise<void>;
  readonly output?: "human" | "json";
  readonly interactive?: boolean;
}

function assertFinalSession(config: AppConfig, session: SessionExport): void {
  if (session.accountId !== config.accountId) {
    throw new AppError("INVALID_CONFIG", "Authenticated account does not match SNAP_ACCOUNT_ID");
  }
  if (session.buildId !== config.buildId) {
    throw new AppError("UNSUPPORTED_BUILD", "Authenticated session uses an unsupported build");
  }
}

async function defaultFinalize(): Promise<SessionExport> {
  throw new AppError(
    "UNSUPPORTED_BUILD",
    "Login authentication succeeded, but no verified session-construction contract is installed",
  );
}

export async function runSessionLogin(
  argv: readonly string[],
  io: CliIo,
  dependencies: SessionLoginDependencies = {},
): Promise<number> {
  if (argv.length !== 0) {
    io.stderr("Usage: snap session login");
    return 2;
  }
  loadEnvironmentFile();
  const config = dependencies.config ?? loadConfig();
  const prompt = dependencies.prompt ?? createTerminalLoginPrompt();
  const transport = dependencies.transport
    ?? await (dependencies.createTransport ?? (async () => createLoginTransport()))();
  const authenticated = await runLoginState(prompt, transport, {
    interactive: dependencies.interactive ?? true,
  });
  const session = await (dependencies.finalizeSession ?? defaultFinalize)(authenticated.session, config);
  assertFinalSession(config, session);
  if (dependencies.persistSession !== undefined) {
    await dependencies.persistSession(session, config.sessionFile);
  } else {
    await new SealedSessionStore(config.sessionFile).write(session);
  }
  const output = dependencies.output ?? config.output;
  if (output === "json") {
    io.stdout(JSON.stringify({ type: "session.logged-in", buildId: session.buildId }));
  } else {
    io.stdout(`Session login complete for build ${session.buildId}`);
  }
  return 0;
}
