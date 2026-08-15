#!/usr/bin/env node

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { SnapchatClient } from "../client.js";
import { loadEnvironmentFile, resolveAppConfig, type AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import { redact } from "../logging/redact.js";
import type { AccountAddDependencies } from "./commands/account-add.js";
import type { AccountListDependencies } from "./commands/account-list.js";
import type { AccountShowDependencies } from "./commands/account-show.js";
import type { ConfiguredChatSendClient } from "./commands/chat-send.js";
import type { ConfiguredGatewayStatusClient } from "./commands/gateway-status.js";
import type { ConfiguredChatWatchClient } from "./commands/chat-watch.js";
import type { ConfiguredSnapWatchClient } from "./commands/snap-watch.js";
import type { ConfiguredFriendsListClient } from "./commands/friends-list.js";
import type { DebugAuthBindingDependencies } from "./commands/debug-auth-binding.js";
import { createConfiguredGatewayStatusClient } from "./gateway-status-client.js";
import { parseGlobalCliOptions } from "./global-options.js";
import { createProcessIo, type CliIo } from "./io.js";

export type ConfiguredCliClient = ConfiguredChatSendClient & ConfiguredGatewayStatusClient &
  ConfiguredChatWatchClient & ConfiguredSnapWatchClient & ConfiguredFriendsListClient;

export interface CliDependencies {
  readonly runAccountAdd?: (
    argv: readonly string[],
    io: CliIo,
    dependencies?: AccountAddDependencies,
  ) => Promise<number>;
  readonly runAccountList?: (
    argv: readonly string[],
    io: CliIo,
    dependencies?: AccountListDependencies,
  ) => Promise<number>;
  readonly runAccountShow?: (
    argv: readonly string[],
    io: CliIo,
    dependencies?: AccountShowDependencies,
  ) => Promise<number>;
  readonly runRuntimeDoctor?: (io: CliIo) => Promise<number>;
  readonly runDebugAuthRenewal?: (io: CliIo) => Promise<number>;
  readonly runSessionCheck?: (io: CliIo) => Promise<number>;
  readonly resolveConfig?: (accountAlias?: string) => Promise<AppConfig>;
  readonly createClient?: (config: AppConfig) => Promise<ConfiguredCliClient>;
  readonly createGatewayStatusClient?: () => Promise<ConfiguredGatewayStatusClient>;
  readonly readFile?: (path: string) => Promise<Uint8Array>;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly debugAuthBinding?: DebugAuthBindingDependencies;
}

async function createConfiguredClient(config: AppConfig): Promise<ConfiguredCliClient> {
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
  inputArgv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies = {},
): Promise<number> {
  if (inputArgv.length === 1 && inputArgv[0] === "--version") {
    io.stdout(io.version);
    return 0;
  }
  const runAccountCommand = async (argv: readonly string[]): Promise<number> => {
    const accountEnv = dependencies.env ?? process.env;
    const commandDependencies = {
      ...(accountEnv.SNAAPI_ACCOUNTS_DIR === undefined ? {} : { accountsDir: accountEnv.SNAAPI_ACCOUNTS_DIR }),
      env: accountEnv,
      output: accountEnv.SNAP_OUTPUT === "json" ? "json" as const : "human" as const,
    };
    try {
      if (argv[1] === "add") {
        const runAccountAdd = dependencies.runAccountAdd ?? (await import("./commands/account-add.js")).runAccountAdd;
        return await runAccountAdd(argv.slice(2), io, commandDependencies);
      }
      if (argv[1] === "list") {
        const runAccountList = dependencies.runAccountList ??
          (await import("./commands/account-list.js")).runAccountList;
        return await runAccountList(argv.slice(2), io, commandDependencies);
      }
      if (argv[1] === "show") {
        const runAccountShow = dependencies.runAccountShow ??
          (await import("./commands/account-show.js")).runAccountShow;
        return await runAccountShow(argv.slice(2), io, commandDependencies);
      }
    } catch (error) {
      return emitError(io, error);
    }
    io.stderr("Usage: snaapi account <add|list|show>");
    return 2;
  };
  const accountArgv = inputArgv[0] === "account"
    ? inputArgv
    : inputArgv[0] === "--account" && inputArgv[2] === "account"
      ? inputArgv.slice(2)
      : undefined;
  if (accountArgv !== undefined) {
    return runAccountCommand(accountArgv);
  }
  let parsedGlobal;
  try {
    parsedGlobal = parseGlobalCliOptions(inputArgv, dependencies.env ?? process.env);
  } catch (error) {
    return emitError(io, error);
  }
  const argv = parsedGlobal.argv;
  let configPromise: Promise<AppConfig> | undefined;
  const config = (): Promise<AppConfig> => {
    if (configPromise === undefined) {
      if (dependencies.resolveConfig !== undefined) {
        configPromise = dependencies.resolveConfig(parsedGlobal.accountAlias);
      } else {
        if (dependencies.env === undefined) {
          loadEnvironmentFile();
        }
        configPromise = resolveAppConfig({
          ...(parsedGlobal.accountAlias === undefined ? {} : { accountAlias: parsedGlobal.accountAlias }),
          ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
        });
      }
    }
    return configPromise;
  };
  if (argv.length >= 1 && argv[0] === "account") {
    return runAccountCommand(argv);
  }
  if (argv.length >= 2 && argv[0] === "debug" && argv[1] === "auth-binding") {
    try {
      const runDebugAuthBinding = (await import("./commands/debug-auth-binding.js")).runDebugAuthBinding;
      return await runDebugAuthBinding(argv.slice(2), io, {
        ...(dependencies.debugAuthBinding ?? {}),
        ...(dependencies.readFile === undefined ? {} : { readFile: dependencies.readFile }),
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
      });
    } catch (error) {
      return emitError(io, error);
    }
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
      return await runChatSend(
        argv.slice(2),
        io,
        async () => (dependencies.createClient ?? createConfiguredClient)(await config()),
      );
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
        async () => (dependencies.createClient ?? createConfiguredClient)(await config()),
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
        async () => (dependencies.createClient ?? createConfiguredClient)(await config()),
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
        async () => (dependencies.createClient ?? createConfiguredClient)(await config()),
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
        async () => (dependencies.createClient ?? createConfiguredClient)(await config()),
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

  io.stderr("Usage: snaapi <account|session|chat|snap|friends|gateway|debug>");
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
