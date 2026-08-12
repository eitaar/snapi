import { dirname, join } from "node:path";
import { readBraveCookieHeader } from "./auth/brave-cookies.js";
import { applyCookieOverrides } from "./auth/cookie-overrides.js";
import { finalizeWebAttestation } from "./auth/web-attestation.js";
import { refreshBraveDbsc, resolveOptionalBraveProfileDir } from "./auth/dbsc.js";
import { AssetLoader } from "./compat/asset-loader.js";
import { CompatibilityGuard } from "./compat/guard.js";
import type { AppConfig } from "./config.js";
import { AppError } from "./errors.js";
import { GatewayClient } from "./gateway/client.js";
import type { GatewayEvent, GatewayStatus } from "./gateway/events.js";
import { FriendsClient } from "./friends/client.js";
import type { FriendSnapshot } from "./friends/types.js";
import { MessagingClient, type SendResult, type SendTextInput } from "./messaging/client.js";
import { MediaClient, type SendPhotoSnapInput } from "./media/client.js";
import { ContentRuntimeClient } from "./runtime/worker-client.js";
import { AccountLock, type AccountLockHandle } from "./session/account-lock.js";
import { loadSession } from "./session/loader.js";
import { parseSessionExport } from "./session/schema.js";
import { AtomicJsonStore } from "./session/state-store.js";
import type { SessionExport } from "./session/types.js";
import { AuthProvider } from "./transport/auth-provider.js";
import { GrpcWebClient } from "./transport/grpc-client.js";
import { refreshSnapchatSso, type SsoRefreshDependencies } from "./transport/sso-auth-refresh.js";
import type { CryptoStateExport } from "./runtime/content-types.js";
import type { SnapMessageEvent } from "./messaging/client.js";

interface MessagingLike {
  sendText(input: SendTextInput): Promise<SendResult>;
  messages(signal?: AbortSignal): AsyncIterableIterator<import("./messaging/client.js").ChatMessageEvent>;
  snaps?(signal?: AbortSignal): AsyncIterableIterator<SnapMessageEvent>;
}

interface MediaLike {
  sendPhotoSnap(input: SendPhotoSnapInput): Promise<SendResult>;
}

interface GatewayLike {
  connect(): Promise<void>;
  events(): AsyncIterableIterator<GatewayEvent>;
  status(): GatewayStatus;
  close(): Promise<void>;
}

interface RuntimeLike {
  shutdown(): Promise<void>;
}

interface FriendsLike {
  list(): Promise<FriendSnapshot>;
}

export interface SnapchatClientComponents {
  readonly messaging: MessagingLike;
  readonly media: MediaLike;
  readonly friends: FriendsLike;
  readonly gateway: GatewayLike;
  readonly runtime: RuntimeLike;
  readonly lock: AccountLockHandle;
}

export interface SnapchatClientDependencies {
  readonly compose?: (config: AppConfig) => Promise<SnapchatClientComponents>;
}

export interface CliRenewalOptions {
  readonly profileDir?: string;
  readonly allowLegacyBraveCookies: boolean;
  readonly allowDbsc: boolean;
  readonly allowWebAttestation: boolean;
}

function assertConfiguredSession(config: AppConfig, session: SessionExport): void {
  if (session.accountId !== config.accountId) {
    throw new AppError("INVALID_CONFIG", "Configured account does not match the session export");
  }
  if (session.buildId !== config.buildId) {
    throw new AppError("UNSUPPORTED_BUILD", "Configured build does not match the session export");
  }
}

function mergeCryptoState(session: SessionExport, state: CryptoStateExport): SessionExport {
  return {
    ...session,
    localStorage: state.localStorage,
    sessionStorage: state.sessionStorage,
    indexedDb: state.indexedDb,
    ...(session.messaging === undefined
      ? {}
      : {
          messaging: {
            ...session.messaging,
            ...(state.rootWrappingKey === undefined
              ? {}
              : { rootWrappingKey: state.rootWrappingKey }),
          },
        }),
  };
}

function resolveCliRenewalOptions(session: SessionExport): CliRenewalOptions {
  const profileDir = resolveOptionalBraveProfileDir();
  return {
    ...(profileDir === undefined ? {} : { profileDir }),
    allowLegacyBraveCookies: session.auth.ssoCookieHeader === undefined && profileDir !== undefined,
    allowDbsc: profileDir !== undefined,
    allowWebAttestation: true,
  };
}

function createCliRenewalDependencies(
  config: AppConfig,
  session: SessionExport,
): SsoRefreshDependencies {
  const options = resolveCliRenewalOptions(session);
  const dependencies: SsoRefreshDependencies = {};
  if (options.allowLegacyBraveCookies && options.profileDir !== undefined) {
    dependencies.cookieSource = () => readBraveCookieHeader(options.profileDir);
  }
  if (options.allowDbsc) {
    dependencies.dbsc = (cookieHeader) => refreshBraveDbsc(
      cookieHeader,
      options.profileDir === undefined ? {} : { profileDir: options.profileDir },
    );
  }
  if (options.allowWebAttestation) {
    dependencies.attestation = (value) => finalizeWebAttestation(value.accountId, { assetDir: config.assetDir });
  }
  return dependencies;
}

async function composeDefault(config: AppConfig): Promise<SnapchatClientComponents> {
  const initialSession = await loadSession(config.sessionFile);
  assertConfiguredSession(config, initialSession);
  const manualSsoCookieHeader = config.ssoCookieHeader ?? config.cookieHeader;
  const authSession = applyCookieOverrides(initialSession, {
    ...(config.cookieHeader === undefined ? {} : { cookieHeader: config.cookieHeader }),
    ...(manualSsoCookieHeader === undefined ? {} : { ssoCookieHeader: manualSsoCookieHeader }),
  });
  const lock = await new AccountLock(join(dirname(config.sessionFile), "locks")).acquire(config.accountId);
  let runtime: ContentRuntimeClient | undefined;
  try {
    await new CompatibilityGuard(new AssetLoader(config.assetDir)).verify(authSession);
    const sessionStore = new AtomicJsonStore(config.sessionFile, parseSessionExport);
    const auth = new AuthProvider(authSession, {
      refresh: (session) => refreshSnapchatSso(session, createCliRenewalDependencies(config, session)),
      persist: async (refreshed) => {
        const latest = await sessionStore.read();
        const persisted = {
          ...latest,
          exportedAt: refreshed.exportedAt,
          auth: refreshed.auth,
        };
        await sessionStore.write(persisted);
        if (runtime !== undefined) {
          await runtime.updateAuth(persisted);
        }
      },
    });
    await auth.getRequestAuth();
    runtime = new ContentRuntimeClient({
      assetDir: config.assetDir,
      allowNetwork: true,
      timeoutMs: 90_000,
    });
    await runtime.initialize(auth.sessionSnapshot());
    const grpc = new GrpcWebClient({ auth });
    const cryptoStateStore = {
      write: async (state: CryptoStateExport) => {
        const latest = await sessionStore.read();
        await sessionStore.write(mergeCryptoState(latest, state));
      },
    };
    const messaging = new MessagingClient({ runtime, grpc, stateStore: cryptoStateStore });
    const media = new MediaClient({ runtime, grpc, stateStore: cryptoStateStore });
    const friends = new FriendsClient({
      runtime: {
        syncFriends: async () => {
          try {
            return await runtime.syncFriends();
          } catch (error) {
            if (!(error instanceof AppError) || error.code !== "SESSION_EXPIRED") {
              throw error;
            }
            await auth.refreshOnce({ kind: "expired" });
            return runtime.syncFriends();
          }
        },
      },
    });
    const gateway = new GatewayClient({ auth });
    return { messaging, media, friends, gateway, runtime, lock };
  } catch (error) {
    await runtime?.shutdown().catch(() => undefined);
    await lock.release().catch(() => undefined);
    throw error;
  }
}

export class SnapchatClient {
  private closed = false;

  private constructor(private readonly components: SnapchatClientComponents) {}

  static async create(
    config: AppConfig,
    dependencies: SnapchatClientDependencies = {},
  ): Promise<SnapchatClient> {
    const components = await (dependencies.compose ?? composeDefault)(config);
    return new SnapchatClient(components);
  }

  sendText(input: SendTextInput): Promise<SendResult> {
    if (this.closed) return Promise.reject(new AppError("CRYPTO_RUNTIME_FAILED", "Snapchat client is closed"));
    return this.components.messaging.sendText(input);
  }

  sendPhotoSnap(input: SendPhotoSnapInput): Promise<SendResult> {
    if (this.closed) return Promise.reject(new AppError("CRYPTO_RUNTIME_FAILED", "Snapchat client is closed"));
    return this.components.media.sendPhotoSnap(input);
  }

  listFriends(): Promise<FriendSnapshot> {
    if (this.closed) return Promise.reject(new AppError("CRYPTO_RUNTIME_FAILED", "Snapchat client is closed"));
    return this.components.friends.list();
  }

  async watchEvents(): Promise<AsyncIterableIterator<GatewayEvent>> {
    if (this.closed) throw new AppError("GATEWAY_DISCONNECTED", "Snapchat client is closed");
    await this.components.gateway.connect();
    return this.components.gateway.events();
  }

  watchMessages(signal?: AbortSignal): AsyncIterableIterator<import("./messaging/client.js").ChatMessageEvent> {
    if (this.closed) {
      const error = new AppError("GATEWAY_DISCONNECTED", "Snapchat client is closed");
      return (async function* () { throw error; })();
    }
    return this.components.messaging.messages(signal);
  }

  watchSnaps(signal?: AbortSignal): AsyncIterableIterator<SnapMessageEvent> {
    if (this.closed) {
      const error = new AppError("GATEWAY_DISCONNECTED", "Snapchat client is closed");
      return (async function* () { throw error; })();
    }
    if (this.components.messaging.snaps === undefined) {
      const error = new AppError("UNSUPPORTED_BUILD", "Incoming Snap media is not available");
      return (async function* () { throw error; })();
    }
    return this.components.messaging.snaps(signal);
  }

  status(): GatewayStatus {
    return this.components.gateway.status();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.components.gateway.close();
    } finally {
      try {
        await this.components.runtime.shutdown();
      } finally {
        await this.components.lock.release();
      }
    }
  }
}
