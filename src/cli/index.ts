#!/usr/bin/env node

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { SnapchatClient } from "../client.js";
import { loadConfig, loadEnvironmentFile } from "../config.js";
import { AppError } from "../errors.js";
import { redact } from "../logging/redact.js";
import type { ConfiguredChatSendClient } from "./commands/chat-send.js";
import type { ConfiguredGatewayStatusClient } from "./commands/gateway-status.js";
import type { ConfiguredChatWatchClient } from "./commands/chat-watch.js";
import type { ConfiguredSnapWatchClient } from "./commands/snap-watch.js";
import type { ConfiguredFriendsListClient } from "./commands/friends-list.js";
import { createConfiguredGatewayStatusClient } from "./gateway-status-client.js";
import { createProcessIo, type CliIo } from "./io.js";

export type ConfiguredCliClient = ConfiguredChatSendClient & ConfiguredGatewayStatusClient &
  ConfiguredChatWatchClient & ConfiguredSnapWatchClient & ConfiguredFriendsListClient;

export interface CliDependencies {
  readonly runRuntimeDoctor?: (io: CliIo) => Promise<number>;
  readonly runDebugAuthRenewal?: (io: CliIo) => Promise<number>;
  readonly runSessionCheck?: (io: CliIo) => Promise<number>;
  readonly createClient?: () => Promise<ConfiguredCliClient>;
  readonly createGatewayStatusClient?: () => Promise<ConfiguredGatewayStatusClient>;
  readonly readFile?: (path: string) => Promise<Uint8Array>;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

async function createConfiguredClient(): Promise<ConfiguredCliClient> {
  loadEnvironmentFile();
  const config = loadConfig();
  return { client: await SnapchatClient.create(config), output: config.output };
}

function exitCode(error: AppError): number {
  if (error.code === "DELIVERY_UNCONFIRMED") return 5;
  if (
    error.code === "INVALID_CONFIG" ||
    error.code === "INVALID_SESSION_EXPORT" ||
    error.code === "UNSUPPORTED_BUILD" ||
    error.code === "CRYPTO_STATE_CONFLICT"
  ) return 3;
  return 4;
}

function emitError(io: CliIo, error: unknown): number {
  if (!(error instanceof AppError)) {
    io.stderr("INTERNAL_ERROR: Command failed");
    return 4;
  }
  const details = redact(error.details);
  const suffix = details !== null && typeof details === "object" && Object.keys(details).length > 0
    ? ` ${JSON.stringify(details)}`
    : "";
  io.stderr(`${error.code}: ${error.message}${suffix}`);
  return exitCode(error);
}

export async function main(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies = {},
): Promise<number> {
  if (argv.length === 1 && argv[0] === "--version") {
    io.stdout(io.version);
    return 0;
  }
  if (argv.length === 3 && argv[0] === "debug" && argv[1] === "doctor" && argv[2] === "--runtime") {
    const runRuntimeDoctor = dependencies.runRuntimeDoctor ??
      (await import("./commands/debug-doctor.js")).runRuntimeDoctor;
    return runRuntimeDoctor(io);
  }
  if (argv.length === 3 && argv[0] === "debug" && argv[1] === "auth-renewal" && argv[2] === "--cli-only") {
    try {
      if (dependencies.runDebugAuthRenewal !== undefined) {
        return await dependencies.runDebugAuthRenewal(io);
      }
      const runDebugAuthRenewal = (await import("./commands/debug-doctor.js")).runDebugAuthRenewal;
      return await runDebugAuthRenewal(io, {
        ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
      });
    } catch (error) {
      return emitError(io, error);
    }
  }
  if (argv.length >= 2 && argv[0] === "debug" && argv[1] === "auth-gap") {
    try {
      const runDebugAuthGap = (await import("./commands/debug-auth-gap.js")).runDebugAuthGap;
      return await runDebugAuthGap(argv.slice(2), io, {
        ...(dependencies.readFile === undefined ? {} : { readFile: dependencies.readFile }),
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
      });
    } catch (error) {
      return emitError(io, error);
    }
  }
  if (argv.length >= 2 && argv[0] === "debug" && argv[1] === "gateway-handshake") {
    try {
      const runDebugGatewayHandshake = (await import("./commands/debug-gateway-handshake.js"))
        .runDebugGatewayHandshake;
      return await runDebugGatewayHandshake(argv.slice(2), io, {
        ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
      });
    } catch (error) {
      return emitError(io, error);
    }
  }
  if (argv.length === 2 && argv[0] === "session" && argv[1] === "check") {
    try {
      const runSessionCheck = dependencies.runSessionCheck ??
        (await import("./commands/session-check.js")).runSessionCheck;
      return await runSessionCheck(io);
    } catch (error) {
      return emitError(io, error);
    }
  }
  if (argv.length >= 2 && argv[0] === "session" && argv[1] === "import") {
    try {
      const runSessionImport = (await import("./commands/session-import.js")).runSessionImport;
      return await runSessionImport(argv.slice(2), io);
    } catch (error) {
      return emitError(io, error);
    }
  }
  if (argv.length >= 2 && argv[0] === "session" && argv[1] === "refresh-har") {
    try {
      const runSessionRefreshHar = (await import("./commands/session-refresh-har.js"))
        .runSessionRefreshHar;
      return await runSessionRefreshHar(argv.slice(2), io);
    } catch (error) {
      return emitError(io, error);
    }
  }
  if (argv.length >= 2 && argv[0] === "session" && argv[1] === "login") {
    try {
      const runSessionLogin = (await import("./commands/session-login.js")).runSessionLogin;
      return await runSessionLogin(argv.slice(2), io);
    } catch (error) {
      return emitError(io, error);
    }
  }
  if (argv.length >= 2 && argv[0] === "chat" && argv[1] === "send") {
    try {
      const runChatSend = (await import("./commands/chat-send.js")).runChatSend;
      return await runChatSend(argv.slice(2), io, dependencies.createClient ?? createConfiguredClient);
    } catch (error) {
      return emitError(io, error);
    }
  }
  if (argv.length >= 2 && argv[0] === "chat" && argv[1] === "watch") {
    try {
      const runChatWatch = (await import("./commands/chat-watch.js")).runChatWatch;
      return await runChatWatch(
        argv.slice(2),
        io,
        dependencies.createClient ?? createConfiguredClient,
        dependencies.signal,
      );
    } catch (error) {
      return emitError(io, error);
    }
  }
  if (argv.length >= 2 && argv[0] === "snap" && argv[1] === "send") {
    try {
      const runSnapSend = (await import("./commands/snap-send.js")).runSnapSend;
      return await runSnapSend(
        argv.slice(2),
        io,
        dependencies.createClient ?? createConfiguredClient,
        dependencies.readFile,
      );
    } catch (error) {
      return emitError(io, error);
    }
  }
  if (argv.length >= 2 && argv[0] === "snap" && argv[1] === "watch") {
    try {
      const runSnapWatch = (await import("./commands/snap-watch.js")).runSnapWatch;
      return await runSnapWatch(
        argv.slice(2),
        io,
        dependencies.createClient ?? createConfiguredClient,
        dependencies.signal,
      );
    } catch (error) {
      return emitError(io, error);
    }
  }
  if (argv.length >= 2 && argv[0] === "friends" && argv[1] === "list") {
    try {
      const runFriendsList = (await import("./commands/friends-list.js")).runFriendsList;
      return await runFriendsList(
        argv.slice(2),
        io,
        dependencies.createClient ?? createConfiguredClient,
      );
    } catch (error) {
      return emitError(io, error);
    }
  }
  if (argv.length === 2 && argv[0] === "gateway" && argv[1] === "status") {
    try {
      const runGatewayStatus = (await import("./commands/gateway-status.js")).runGatewayStatus;
      return await runGatewayStatus(
        io,
        dependencies.createGatewayStatusClient ?? createConfiguredGatewayStatusClient,
      );
    } catch (error) {
      return emitError(io, error);
    }
  }

  io.stderr("Usage: snap <session|chat|snap|friends|gateway|debug>");
  return 2;
}

function packageVersion(): string {
  const require = createRequire(import.meta.url);
  const packageJson = require("../../package.json") as { readonly version: string };
  return packageJson.version;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(entryPath).href === import.meta.url) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  try {
    process.exitCode = await main(process.argv.slice(2), createProcessIo(packageVersion()), {
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", abort);
  }
}
