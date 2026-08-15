import { applyCookieOverrides } from "./auth/cookie-overrides.js";
import { finalizeWebAttestation } from "./auth/web-attestation.js";
import { AssetLoader } from "./compat/asset-loader.js";
import { CompatibilityGuard } from "./compat/guard.js";
import type { AppConfig } from "./config.js";
import { AppError } from "./errors.js";
import { GatewayClient } from "./gateway/client.js";
import type { GatewayEvent, GatewayStatus } from "./gateway/events.js";
import { FriendsClient } from "./friends/client.js";
import type { EasyFriendSnapshot, FriendSnapshot } from "./friends/types.js";
import { MessagingClient, type SendResult, type SendTextInput } from "./messaging/client.js";
import { MediaClient, type SendPhotoSnapInput } from "./media/client.js";
import { ContentRuntimeClient } from "./runtime/worker-client.js";
import { AccountLock, type AccountLockHandle } from "./session/account-lock.js";
import { SealedSessionStore } from "./session/sealed-store.js";
import type { SessionExport } from "./session/types.js";
import { AuthProvider } from "./transport/auth-provider.js";
import { GrpcWebClient } from "./transport/grpc-client.js";
import { refreshSnapchatSession } from "./transport/sso-auth-refresh.js";
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
  listEasy(): Promise<EasyFriendSnapshot>;
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

async function composeDefault(config: AppConfig): Promise<SnapchatClientComponents> {
  const sessionStore = new SealedSessionStore(config.sessionFile);
  const initialSession = await sessionStore.readOrMigrateLegacy();
  assertConfiguredSession(config, initialSession);
  const manualSsoCookieHeader = config.ssoCookieHeader ?? config.cookieHeader;
  const authSession = applyCookieOverrides(initialSession, {
    ...(config.cookieHeader === undefined ? {} : { cookieHeader: config.cookieHeader }),
    ...(manualSsoCookieHeader === undefined ? {} : { ssoCookieHeader: manualSsoCookieHeader }),
  });
  const lock = await new AccountLock(config.lockDir).acquire(config.accountId);
  let runtime: ContentRuntimeClient | undefined;
  try {
    await new CompatibilityGuard(new AssetLoader(config.assetDir)).verify(authSession);
    const auth = new AuthProvider(authSession, {
      refresh: (session) => refreshSnapchatSession(session, {
        attestation: (value) => finalizeWebAttestation(value.accountId, { assetDir: config.assetDir }),
      }),
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
    const initializedRuntime = new ContentRuntimeClient({
      assetDir: config.assetDir,
      allowNetwork: true,
      timeoutMs: 90_000,
    });
    runtime = initializedRuntime;
    await initializedRuntime.initialize(auth.sessionSnapshot());
    const grpc = new GrpcWebClient({ auth });
    const cryptoStateStore = {
      write: async (state: CryptoStateExport) => {
        const latest = await sessionStore.read();
        await sessionStore.write(mergeCryptoState(latest, state));
      },
    };
    const messaging = new MessagingClient({ runtime: initializedRuntime, grpc, stateStore: cryptoStateStore });
    const media = new MediaClient({ runtime: initializedRuntime, grpc, stateStore: cryptoStateStore });
    const friends = new FriendsClient({
      runtime: {
        syncFriends: async () => {
          try {
            return await initializedRuntime.syncFriends();
          } catch (error) {
            if (!(error instanceof AppError) || error.code !== "SESSION_EXPIRED") {
              throw error;
            }
            await auth.refreshOnce({ kind: "expired" });
            return initializedRuntime.syncFriends();
          }
        },
        syncFriendsForSending: async () => {
          try {
            return await initializedRuntime.syncFriendsForSending();
          } catch (error) {
            if (!(error instanceof AppError) || error.code !== "SESSION_EXPIRED") {
              throw error;
            }
            await auth.refreshOnce({ kind: "expired" });
            return initializedRuntime.syncFriendsForSending();
          }
        },
      },
    });
    const gateway = new GatewayClient({ auth });
    const stopAuthRefresh = auth.startAutoRefresh();
    const maintainedRuntime: RuntimeLike = {
      shutdown: async () => {
        stopAuthRefresh();
        await initializedRuntime.shutdown();
      },
    };
    return { messaging, media, friends, gateway, runtime: maintainedRuntime, lock };
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

  listEasyFriends(): Promise<EasyFriendSnapshot> {
    if (this.closed) return Promise.reject(new AppError("CRYPTO_RUNTIME_FAILED", "Snapchat client is closed"));
    return this.components.friends.listEasy();
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
